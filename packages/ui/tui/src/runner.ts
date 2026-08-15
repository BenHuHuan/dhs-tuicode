/**
 * @deepseek-ai/dsh-tui/runner — owns the interactive agent lifecycle. The
 * bundle patch rides over dsh-base without Host, HTTP, or browser plugins;
 * this runner creates (or resumes) one Agent through the core registry,
 * seeds its model selection, and hands it to the TUI composition through the
 * {@link TUI_AGENT_SERVICE} service and the `tui-agent/ready` event.
 *
 * @module @deepseek-ai/dsh-tui/runner
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import {
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AgentRegistry,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents']

/** Plugin config: the session identity resolved from this app's injected provider service. */
export interface Config {
  /** The session to resume in place; absent starts a uniquely identified fresh session. */
  resumeSessionId?: string
  /** Explicit startup opt-in for the full-access/never-ask preset. */
  dangerouslySkipPermissions?: boolean
}

export const Config: z<Config> = z.object({
  resumeSessionId: z.string(),
  dangerouslySkipPermissions: z.boolean(),
})

/** Service provided by this plugin and consumed by the TUI composition. */
export const TUI_AGENT_SERVICE = 'tuiAgent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiAgent: TuiAgentService
  }
  interface Events {
    /**
     * The runner settled on the agent the TUI renders. Fires after every
     * create or resume; the TUI composition mounts (or, after a resume swap,
     * remounts) on this signal, because cordis effects do not re-run on plain
     * service property mutation.
     * @param payload.sessionId - identity of the settled agent's session.
     * @mode emit
     */
    'tui-agent/ready'(payload: { sessionId: SessionId; selection?: ModelSelection; initialNotice?: string }): void
  }
}

/** Registry and agent route captured at first settle, reused by later swaps. */
interface SettleContext {
  readonly agents: AgentRegistry
  readonly agentOptions: AgentOptions
}

/** Allocate a fresh durable identity without consulting or reusing persisted state. */
function freshSessionId(): SessionId {
  return SessionId(`session-${randomUUID()}`)
}

/**
 * Live interactive agent owned by the runner. `current` is set once the Agent
 * is created or resumed. The TUI composition subscribes to `tui-agent/ready`
 * instead of polling this field — see the event doc above.
 */
export class TuiAgentService extends Service {
  /** The agent the TUI currently renders; undefined until the runner settles. */
  current: Agent | undefined
  /** The live handle of the current agent; disposed when the next swap commits. */
  private handle: AgentHandle | undefined
  /** Registry and route captured at first settle, reused by later swaps. */
  private settleContext: SettleContext | undefined

  constructor(ctx: Context) {
    super(ctx, TUI_AGENT_SERVICE)
  }

  /**
   * First settle: create (or resume) the interactive agent and publish it.
   * @param resumeSessionId - session to resume in place; undefined starts fresh.
   * @param settleContext - registry and route this service reuses on swaps.
   */
  async settle(resumeSessionId: string | undefined, settleContext: SettleContext): Promise<void> {
    this.settleContext = settleContext
    const handle = resumeSessionId === undefined
      ? await settleContext.agents.create({
        sessionId: freshSessionId(),
        meta: { cwd: process.cwd() },
        agentOptions: settleContext.agentOptions,
      })
      : await settleContext.agents.resume({
        resumeSessionId: SessionId(resumeSessionId),
        agentOptions: settleContext.agentOptions,
      })
    this.commit(handle)
  }

  /**
   * Replace the live agent with an in-place resumed session. The previous
   * handle is disposed only after the resume commits, so a rejected resume
   * leaves the current session untouched; the TUI composition swaps its
   * channel on the `tui-agent/ready` event this fires.
   * @param resumeSessionId - persisted session to load as the live agent.
   */
  async swap(resumeSessionId: SessionId): Promise<void> {
    const settleContext = this.settleContext
    if (settleContext === undefined) {
      throw new Error('tui-runner: no settled agent to swap away from')
    }
    const handle = await settleContext.agents.resume({
      resumeSessionId,
      agentOptions: settleContext.agentOptions,
    })
    await this.replace(handle)
  }

  /**
   * Replace the live agent with a newly-created conversation in the current
   * workspace. A unique identity keeps the previous persisted session
   * resumable, while the ready payload carries reasoning effort that is not an
   * AgentOptions field.
   * @param selection - model target selected by the current TUI.
   */
  async fresh(selection: ModelSelection | undefined, cwd?: string): Promise<void> {
    const settleContext = this.settleContext
    if (settleContext === undefined) {
      throw new Error('tui-runner: no settled agent to replace with a fresh session')
    }
    const current = this.current
    const baseOptions = current?.options ?? settleContext.agentOptions
    const agentOptions: AgentOptions = selection === undefined
      ? baseOptions
      : { ...baseOptions, provider: selection.provider, model: selection.model }
    const handle = await settleContext.agents.create({
      sessionId: freshSessionId(),
      meta: { cwd: cwd ?? current?.session.header.cwd ?? process.cwd() },
      agentOptions,
    })
    await this.replace(handle, selection)
  }

  /**
   * Replace the live channel with a child session seeded through one completed
   * source-log boundary. The source session stays durable and resumable; this
   * is a branch, never an in-place mutation of conversation history.
   * @param boundary - Inclusive source event sequence selected by `/rewind`.
   * @param selection - Model target preserved from the current TUI when set.
   * @param initialNotice - Terminal-local child-mount notice, never persisted into model context.
   */
  async fork(boundary: number, selection: ModelSelection | undefined, initialNotice?: string): Promise<void> {
    const settleContext = this.settleContext
    const current = this.current
    if (settleContext === undefined || current === undefined) {
      throw new Error('tui-runner: no settled agent to fork')
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new Error(`tui-runner: invalid fork boundary ${String(boundary)}`)
    }
    const boundaryIndex = current.session.events.findIndex(event => event.seq === boundary)
    if (boundaryIndex < 0) {
      throw new Error(`tui-runner: fork boundary ${String(boundary)} is not present in the current session`)
    }
    const seed = current.session.events.slice(0, boundaryIndex + 1)
    const lastTurnBoundary = seed.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (lastTurnBoundary?.type === 'turn/start') {
      throw new Error(`tui-runner: fork boundary ${String(boundary)} ends inside an active turn`)
    }
    const baseOptions = current.options ?? settleContext.agentOptions
    const agentOptions: AgentOptions = selection === undefined
      ? baseOptions
      : { ...baseOptions, provider: selection.provider, model: selection.model }
    const handle = await settleContext.agents.create({
      sessionId: freshSessionId(),
      meta: {
        cwd: current.session.header.cwd ?? process.cwd(),
        parentSession: current.session.id,
        seedLength: seed.length,
      },
      seed,
      agentOptions,
    })
    await this.replace(
      handle,
      selection,
      initialNotice ?? `Opened a child session at checkpoint event ${String(boundary)}. The original session remains resumable.`,
    )
  }

  /** Commit a prepared replacement, rolling it back if the old owner cannot retire. */
  private async replace(handle: AgentHandle, selection?: ModelSelection, initialNotice?: string): Promise<void> {
    try {
      await this.handle?.dispose()
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    this.commit(handle, selection, initialNotice)
  }

  private commit(handle: AgentHandle, selection?: ModelSelection, initialNotice?: string): void {
    this.handle = handle
    this.current = handle.agent
    this.ctx.emit('tui-agent/ready', {
      sessionId: handle.agent.session.id,
      ...selection === undefined ? {} : { selection },
      ...initialNotice === undefined ? {} : { initialNotice },
    })
  }
}

/** Report an unexpected agent settlement failure and request a failing exit. */
function fail(exit: AppExit, error: unknown): void {
  process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1, { forceAfterDispose: true })
}

/**
 * Mount the interactive agent driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated resume config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  // The full-screen renderer needs a real terminal pair; fail synchronously so
  // a pipe invocation never starts an agent. (The tui row re-checks on render.)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('tui-runner: both stdin and stdout must be TTYs; use --profile headless for pipes')
  }
  const service = new TuiAgentService(ctx)
  void (async () => {
    // Loader siblings mount concurrently. Await the complete application
    // before creating an Agent so its scoped tools and adapters are not
    // half-composed.
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    // Early process shutdown can dispose the tree while settlement is pending.
    if (agents === undefined || defaultModel === undefined) return
    const selection = defaultModel.currentSelection()
    const settleContext: SettleContext = {
      agents,
      agentOptions: { provider: selection.provider, model: selection.model },
    }
    await service.settle(config.resumeSessionId, settleContext)
    if (config.dangerouslySkipPermissions === true) {
      const permission = ctx.get('permissionPresets')
      if (permission === undefined || !permission.names.includes('danger-full-access')) {
        throw new Error('tui-runner: --dangerously-skip-permissions requires the danger-full-access permission preset')
      }
      const current = service.current
      if (current === undefined) throw new Error('tui-runner: bypass mode could not find the settled agent')
      permission.set(current.session, 'danger-full-access')
    }
  })().catch((error: unknown) => { fail(exit, error) })
}
