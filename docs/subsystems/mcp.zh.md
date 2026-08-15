# MCP 连接

[English](mcp.md) | 中文

MCP 客户端桥接插件连接已配置的外部服务器，并通过 `ctx.tools` 暴露它们的工具；其包 [README](../../packages/mcp/mcp-client/README.md) 负责配置与工具桥接。本子系统负责供面向人的终端客户端读取的可选、进程内 `ctx.mcpConnections` 目录。随附的 TUI profile 会挂载该目录，并通过 `/mcp` 渲染它。

## 脱敏目录

每个存活 client 保留一行服务器名称记录，并拥有该记录的更新与释放。快照只包含配置的命名空间、传输类别、生命周期状态、公开工具名和重连次数。它绝不保留或发出服务器 endpoint、进程命令、命令参数、环境变量值、请求头或失败文本。该目录不拥有传输、不改变 client 配置、不重连服务器，也不保留持久会话状态。

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
