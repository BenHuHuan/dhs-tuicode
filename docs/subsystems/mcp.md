# MCP connections

English | [中文](mcp.zh.md)

The MCP client bridge connects configured external servers and exposes their tools through `ctx.tools`; its package [README](../../packages/mcp/mcp-client/README.md) owns configuration and tool bridging. This subsystem owns the optional, process-local `ctx.mcpConnections` directory that human-facing terminal clients read. The shipped TUI profile mounts the directory and renders it through `/mcp`.

## Redacted directory

Each live client reserves one server-name row and owns its updates and disposal. A snapshot contains only the configured namespace, transport family, lifecycle state, public tool names, and a reconnect attempt. It never retains or emits a server endpoint, process command, command arguments, environment values, request headers, or failure text. The directory does not own a transport, change a client configuration, reconnect a server, or retain durable session state.

```ts type-equiv
/** Transport family shown to a human operator. */
type McpConnectionTransport = 'stdio' | 'streamable-http'
```

```ts type-equiv
/** Lifecycle state of one configured MCP server. */
type McpConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed'
```

```ts type-equiv
/** Redacted, immutable view of one MCP server connection. */
interface McpConnectionSnapshot {
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
```

```ts type-equiv
/** A partial lifecycle update published by the owning mcp-client instance. */
interface McpConnectionUpdate {
  /** Replacement connection-supervisor state. */
  readonly state?: McpConnectionState
  /** Replacement public tool-name directory. */
  readonly toolNames?: readonly string[]
  /** Replacement reconnect attempt; explicit `undefined` clears it. */
  readonly reconnectAttempt?: number | undefined
}
```

```ts type-equiv
/** One mcp-client instance's write handle for its registered server row. */
interface McpConnectionRegistration {
  /** Publish a replacement for the supplied redacted fields. */
  update(update: McpConnectionUpdate): void
  /** Remove this instance's row. Idempotent after the first call. */
  dispose(): void
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpconnections--mcpconnectionregistry"></a>

### `ctx.mcpConnections` — `McpConnectionRegistry`

Redacted directory of MCP connections in the current Cordis app. Connection instances register one namespaced row and must dispose it with their own lifecycle; the directory itself owns neither transport nor tool disposal.

```ts cordis-catalog
/**
 * Read redacted server state in stable namespace order.
 * @returns detached snapshots safe for human-facing rendering.
 */
snapshot(): readonly McpConnectionSnapshot[]

/**
 * Reserve and publish one server row.
 * @param serverName - unique MCP namespace within this app.
 * @param transport - non-secret transport family to display.
 * @returns an instance-owned update and disposal handle.
 * @throws when another live MCP client already owns `serverName`.
 */
register(serverName: string, transport: McpConnectionTransport): McpConnectionRegistration
```

Source: [`packages/mcp/mcp-client/src/registry.ts:76`](../../packages/mcp/mcp-client/src/registry.ts)

<a id="mcp-connections-events"></a>

### `mcp-connections/*` events

<a id="mcp-connectionschange--emit"></a>

#### `mcp-connections/change` — emit

The redacted MCP connection directory changed.

```ts cordis-catalog
/**
 * The redacted MCP connection directory changed.
 * @mode emit
 */
'mcp-connections/change'(): void
```

Source: [`packages/mcp/mcp-client/src/registry.ts:67`](../../packages/mcp/mcp-client/src/registry.ts)
<!-- END GENERATED cordis-surface -->
