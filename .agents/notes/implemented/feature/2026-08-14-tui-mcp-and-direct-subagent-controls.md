# Agent Note: terminal MCP and direct subagent control planes

Status: implemented

English | [中文](2026-08-14-tui-mcp-and-direct-subagent-controls.zh.md)

## Problem

The terminal TUI can already compose MCP clients and durable continuable subagents, but a human has no focused terminal view of either lifecycle. Reading raw Loader configuration for MCP state risks exposing endpoints and credentials. Treating the complete subagent tree as a human control target would also bypass the direct-parent authority that durable continuation operations enforce.

## Decision

[`McpConnectionRegistry`](../../../../packages/mcp/mcp-client/src/registry.ts) is an optional, process-local projection mounted by the TUI profile before user-configured MCP clients. A live client registers only its configured server name, transport, lifecycle state, reconnect attempt, and public tool names. The registry never receives endpoint URLs, commands, environment values, request headers, or failure text. Client disposal removes its row after connection cleanup. The dedicated `registry` package export is built as a host artifact so a pure-Node Loader profile resolves it without a source TypeScript loader.

Source launches map the TUI and MCP registry package specifiers directly to their `src` entries, so a `tsx` Loader run cannot mix TUI source with compiled package copies.

`/mcp` reads that projection only. It lists servers, narrows to `/mcp <server>`, and delegates `/mcp reload` to the existing Loader refresh. The command does not edit configuration, reveal private connection data, or create model-visible messages.

`/agents` uses the existing durable inventory and continuation APIs described by [continuable subagent conversations](2026-07-28-continuable-subagent-conversations.md). Bare `/agents` renders the complete durable descendant tree without loading child prompts or transcripts. `/agents start <task>` creates a continuable child through the local `spawn` provider with the TUI's selected provider/model route. `/agents send <id> <message>` and `/agents stop <id>` resolve only direct children; sending uses a `user` message source and stopping uses direct human-parent authority. A stop reports an accepted cancellation request rather than an immediate completion. This complements, rather than broadens, the guarded session-wide shortcut in [TUI stop-all background subagents](2026-08-14-tui-stop-background-subagents.md).

## Verification

Registry and reconnect tests pin redaction, state transitions, stale disposal, and row removal. Mounted TUI command tests and terminal snapshots pin `/mcp` and `/agents` output, usage failures, direct-child checks, user-attributed follow-up, and stop authority. A real MCP fixture unload proves the row disappears with the client fiber. The built-lib keyless TUI PTY smoke starts the shipped profile and reaches both directories through the Loader.

## Alternatives considered

**Render raw MCP configuration.** Rejected because URL, command, environment, header, and failure data do not belong in a terminal directory and can contain credentials or deployment internals.

**Give `/agents` recursive control over every listed descendant.** Rejected because durable listing is visibility, not authority. A direct child remains responsible for its own descendants, and recursive human control could cross a live coordination boundary.

**Reuse `/tasks` as the only subagent UI.** Rejected because it represents jobs, while a continuable child can be durable and idle without a job record; it cannot start or resume a direct conversation.

**Implement agent teams with this command.** Rejected because shared task boards, peer messaging, leadership, and multi-session rendering introduce a different product and authority model. The direct-child operations remain a small terminal control plane.

## Consequences

The shipped terminal profile exposes safe, keyless-inspectable MCP and multi-agent basics without a desktop or web dependency. MCP configuration and per-server recovery remain Loader-owned. The subagent view is intentionally not an agent-team dashboard, and a direct human command cannot control a grandchild; users retain the existing model-facing delegation tools for deeper coordination.
