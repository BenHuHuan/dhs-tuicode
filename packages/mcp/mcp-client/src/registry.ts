/**
 * Process-local, redacted MCP connection directory for terminal and other
 * human-facing surfaces. The directory deliberately exposes no command,
 * URL, environment, header, or error values because those configuration
 * fields can contain credentials.
 *
 * @module @deepseek-ai/dsh-mcp-client/registry
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** Transport family shown to a human operator. */
export type McpConnectionTransport = 'stdio' | 'streamable-http'

/** Lifecycle state of one configured MCP server. */
export type McpConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** Redacted, immutable view of one MCP server connection. */
export interface McpConnectionSnapshot {
  /** Configured server namespace, also used in model-facing tool names. */
  readonly serverName: string
  /** Whether the server runs as a child process or over HTTP. */
  readonly transport: McpConnectionTransport
  /** Current connection-supervisor state. */
  readonly state: McpConnectionState
  /** Public tool names currently owned by this server. */
  readonly toolNames: readonly string[]
  /** Current reconnect attempt while state is `reconnecting`, when applicable. */
  readonly reconnectAttempt?: number
}

/** A partial lifecycle update published by the owning mcp-client instance. */
export interface McpConnectionUpdate {
  /** Replacement connection-supervisor state. */
  readonly state?: McpConnectionState
  /** Replacement public tool-name directory. */
  readonly toolNames?: readonly string[]
  /** Replacement reconnect attempt; explicit `undefined` clears it. */
  readonly reconnectAttempt?: number | undefined
}

/** One mcp-client instance's write handle for its registered server row. */
export interface McpConnectionRegistration {
  /** Publish a replacement for the supplied redacted fields. */
  update(update: McpConnectionUpdate): void
  /** Remove this instance's row. Idempotent after the first call. */
  dispose(): void
}

interface MutableMcpConnection {
  readonly serverName: string
  readonly transport: McpConnectionTransport
  state: McpConnectionState
  toolNames: readonly string[]
  reconnectAttempt?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpConnections: McpConnectionRegistry
  }
  interface Events {
    /**
     * The redacted MCP connection directory changed.
     * @mode emit
     */
    'mcp-connections/change'(): void
  }
}

/**
 * Redacted directory of MCP connections in the current Cordis app. Connection
 * instances register one namespaced row and must dispose it with their own
 * lifecycle; the directory itself owns neither transport nor tool disposal.
 */
export class McpConnectionRegistry extends Service {
  private readonly connections = new Map<string, MutableMcpConnection>()

  constructor(ctx: Context) {
    super(ctx, 'mcpConnections')
  }

  /**
   * Read redacted server state in stable namespace order.
   * @returns detached snapshots safe for human-facing rendering.
   */
  snapshot(): readonly McpConnectionSnapshot[] {
    return Object.freeze([...this.connections.values()]
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
      .map(connection => Object.freeze({
        serverName: connection.serverName,
        transport: connection.transport,
        state: connection.state,
        toolNames: Object.freeze([...connection.toolNames]),
        ...connection.reconnectAttempt === undefined ? {} : { reconnectAttempt: connection.reconnectAttempt },
      })))
  }

  /**
   * Reserve and publish one server row.
   * @param serverName - unique MCP namespace within this app.
   * @param transport - non-secret transport family to display.
   * @returns an instance-owned update and disposal handle.
   * @throws when another live MCP client already owns `serverName`.
   */
  register(serverName: string, transport: McpConnectionTransport): McpConnectionRegistration {
    if (this.connections.has(serverName)) {
      throw new Error(`mcp connection directory already contains server "${serverName}"`)
    }
    const connection: MutableMcpConnection = {
      serverName,
      transport,
      state: 'connecting',
      toolNames: Object.freeze([]),
    }
    this.connections.set(serverName, connection)
    this.publish()
    let active = true
    return {
      update: (update) => {
        if (!active) return
        const nextState = update.state ?? connection.state
        const nextToolNames = update.toolNames === undefined
          ? connection.toolNames
          : Object.freeze([...update.toolNames])
        const nextReconnectAttempt = Object.hasOwn(update, 'reconnectAttempt')
          ? update.reconnectAttempt
          : connection.reconnectAttempt
        if (nextState === connection.state
          && sameNames(nextToolNames, connection.toolNames)
          && nextReconnectAttempt === connection.reconnectAttempt) return
        connection.state = nextState
        connection.toolNames = nextToolNames
        if (nextReconnectAttempt === undefined) delete connection.reconnectAttempt
        else connection.reconnectAttempt = nextReconnectAttempt
        this.publish()
      },
      dispose: () => {
        if (!active) return
        active = false
        if (this.connections.get(serverName) !== connection) return
        this.connections.delete(serverName)
        this.publish()
      },
    }
  }

  private publish(): void {
    this.ctx.emit('mcp-connections/change')
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

export default McpConnectionRegistry
