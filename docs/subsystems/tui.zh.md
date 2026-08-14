# 交互式 TUI

[English](tui.md) | 中文

TUI 子系统负责交互式终端入口。其包 [README](../../packages/ui/tui/README.md)记录用户可见的渲染、命令、配置、终端恢复和模型影响；本页仅负责组装该入口所用的 Cordis 服务与事件。

`ctx.tui` 在终端启动后接纳绑定生命周期的 overlay 请求。`ctx.tuiPrompt` 向渲染器提供可变的提示模板值。由 app 持有的 runner 通过 `ctx.tuiAgent` 发布当前交互式 agent，并在创建、恢复或已提交的会话切换后发出 `tui-agent/ready`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtui--tuiextensionservice-abstract-seam"></a>

### `ctx.tui` — `TuiExtensionService` (abstract seam)

Optional terminal-local interaction service provided by one mounted TUI.

The concrete provider retains pi-tui, focus, and terminal lifecycle state. Plugins receive only effect-owned overlay sessions.

```ts cordis-catalog
/**
 * Queue an interactive overlay owned by the calling plugin fiber.
 *
 * The TUI displays one overlay at a time in FIFO order. Disposing the caller
 * removes a queued overlay or closes an active one before plugin teardown
 * settles. This live presentation is neither logged nor replayed.
 *
 * @param request - component factory, layout constraints, and cancellation.
 * @returns the effect-owned overlay session.
 * @throws when the TUI has begun shutting down.
 */
abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
```

Source: [`packages/ui/tui/src/index.ts:356`](../../packages/ui/tui/src/index.ts)

<a id="ctxtuiagent--tuiagentservice"></a>

### `ctx.tuiAgent` — `TuiAgentService`

Live interactive agent owned by the runner. `current` is set once the Agent is created or resumed. The TUI composition subscribes to `tui-agent/ready` instead of polling this field — see the event doc above.

```ts cordis-catalog
/**
 * First settle: create (or resume) the interactive agent and publish it.
 * @param resumeSessionId - session to resume in place; undefined starts fresh.
 * @param settleContext - registry and route this service reuses on swaps.
 */
async settle(resumeSessionId: string | undefined, settleContext: SettleContext): Promise<void>

/**
 * Replace the live agent with an in-place resumed session. The previous
 * handle is disposed only after the resume commits, so a rejected resume
 * leaves the current session untouched; the TUI composition swaps its
 * channel on the `tui-agent/ready` event this fires.
 * @param resumeSessionId - persisted session to load as the live agent.
 */
async swap(resumeSessionId: SessionId): Promise<void>

/**
 * Replace the live agent with a newly-created conversation in the current
 * workspace. A unique identity keeps the previous persisted session
 * resumable, while the ready payload carries reasoning effort that is not an
 * AgentOptions field.
 * @param selection - model target selected by the current TUI.
 */
async fresh(selection: ModelSelection | undefined): Promise<void>
```

Types: [ModelSelection](core.md) · [SessionId](core.md)

Source: [`packages/ui/tui/src/runner.ts:78`](../../packages/ui/tui/src/runner.ts)

<a id="ctxtuiprompt--tuipromptservice"></a>

### `ctx.tuiPrompt` — `TuiPromptService`

Context-global mutable values interpolated by TUI theme prompt templates. A registration, mutation, or disposal schedules one coalesced notification to the renderer subscribed with TuiPromptService.subscribe, so a value that changes on its own schedule (not only in response to a UI event) still redraws. Notification is a direct in-service callback, not a Cordis event.

```ts cordis-catalog
/**
 * Register one globally unique template value under the calling Cordis effect.
 * @param name - Lowercase slash-separated template name.
 * @param initialValue - Initial trusted ANSI-capable fragment.
 * @returns A mutable handle whose disposal unregisters the name.
 */
register(name: string, initialValue?: string): TuiPromptValueHandle

/**
 * Read a registered fragment without evaluating plugin code.
 * @param name - Exact registered template name.
 * @returns The current fragment, or `undefined` when unknown or unavailable.
 */
get(name: string): string | undefined

/**
 * Observe registration and value changes. The listener runs after a coalesced
 * microtask following any burst of mutations; the renderer re-reads current
 * values on that callback. The subscription is owned by the calling Cordis
 * effect, so it is removed when the subscriber's fiber disposes; the returned
 * disposer removes it early. Listener failures are contained — a synchronous
 * throw or a rejected returned promise cannot starve the other observers.
 * @param listener - Invoked once per coalesced change burst. Delivery does
 *   not wait on a returned promise; its rejection is only observed and logged,
 *   never left unhandled, so an async listener cannot order later observers.
 * @returns A disposer that removes the subscription.
 */
subscribe(listener: () => unknown): TuiPromptUnsubscribe
```

Source: [`packages/ui/tui/src/prompt.ts:104`](../../packages/ui/tui/src/prompt.ts)

<a id="tui-agent-events"></a>

### `tui-agent/*` events

<a id="tui-agentready--emit"></a>

#### `tui-agent/ready` — emit

The runner settled on the agent the TUI renders. Fires after every create or resume; the TUI composition mounts (or, after a resume swap, remounts) on this signal, because cordis effects do not re-run on plain service property mutation.

```ts cordis-catalog
/**
 * The runner settled on the agent the TUI renders. Fires after every
 * create or resume; the TUI composition mounts (or, after a resume swap,
 * remounts) on this signal, because cordis effects do not re-run on plain
 * service property mutation.
 * @param payload.sessionId - identity of the settled agent's session.
 * @mode emit
 */
'tui-agent/ready'(payload: { sessionId: SessionId; selection?: ModelSelection }): void
```

Types: [ModelSelection](core.md) · [SessionId](core.md)

Source: [`packages/ui/tui/src/runner.ts:58`](../../packages/ui/tui/src/runner.ts)
<!-- END GENERATED cordis-surface -->
