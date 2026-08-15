import { createUserMessage, MessageId , createMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, {
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  Inbox,
} from '@deepseek-ai/dsh-agent'
import type {
  ContentBlock,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ContextBreakdownProjection,
  TokenMeasurement,
} from '@deepseek-ai/dsh-token-meter'
import CommandService from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, type Session, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createTuiChat, type Config, type TuiRuntime, type TuiUserSettings } from '../src/index.ts'
import { TestSessionQueryEngine } from './session-query.ts'
import TuiPromptService from '../src/prompt.ts'

interface FakeAgent extends Agent {
  status: AgentStatus
  sent: ContentBlock[][]
  sentMessages: UserMessage[]
  steered: ContentBlock[][]
  steeredIds: MessageId[]
  steeredOptions: UserMessage[]
  injected: ContentBlock[][]
  injectedOptions: UserMessage[]
  cancelled: AgentCancelCause[]
}

export interface TuiHarnessOptions {
  status?: AgentStatus
  config?: Config
  /** Leave the session event log empty instead of seeding one turn and step. */
  omitInitialLifecycle?: boolean
  /** Omit the harness's default `welcome`, exercising the banner sweep-reveal path. */
  omitWelcome?: boolean
  tools?: Record<string, ToolDefinition>
  configureContext?: (ctx: Context) => Promise<void>
  beforeMount?: (session: Session) => void
  cwd?: string | null
  formatCwd?: TuiRuntime['formatCwd']
  gitBranch?: TuiRuntime['gitBranch']
  /** Fake-agent creation options (`provider`/`model` seed the model selector's initial target). */
  agentOptions?: AgentOptions
  contextWindow?: number
  contextTokens?: number
  /** Exact token-meter snapshot returned to context/status surfaces. */
  contextMeasurement?: TokenMeasurement
  /** Optional three-part heuristic composition exposed by session projections. */
  contextBreakdown?: ContextBreakdownProjection
  now?: () => number
  catalog?: {
    providers: LlmProviderInfo[]
    models: LlmModelInfo[]
    listModels?: (provider: string) => Promise<LlmModelInfo[]>
    resolveModelInfo?: (
      provider: string,
      model: string,
    ) => Promise<Pick<LlmResolvedModelInfo, 'context' | 'reasoning' | 'inputModalities'>>
  }
  /** Provide a fake `sessionPersistence` service so resume surfaces can list sessions. */
  sessionPersistence?: {
    list(): Promise<SessionHeader[]>
    load?(id: ReturnType<typeof SessionId>): Promise<{ meta: SessionHeader; events: Session['events'] }>
    /** Per-session artifact location for mtime-based activity; defaults to none. */
    locate?(meta: SessionHeader): { kind: string; path: string } | undefined
  }
  /** Host in-place swap; absent exercises the cannot-swap degradation path. */
  swapResume?: TuiRuntime['swapResume']
  /** Host fresh-session swap; absent exercises the view-only `/clear` degradation path. */
  swapFresh?: TuiRuntime['swapFresh']
  /** Host child-session branch; absent exercises the conversation-rewind degradation path. */
  swapFork?: TuiRuntime['swapFork']
  /** Host external-editor boundary; absent exercises explicit degradation. */
  editText?: TuiRuntime['editText']
  /** Host clipboard-image boundary; absent exercises explicit degradation. */
  readClipboardImage?: TuiRuntime['readClipboardImage']
  /** Host clipboard-text boundary; absent exercises explicit `/copy` degradation. */
  writeClipboardText?: TuiRuntime['writeClipboardText']
  /** Host response-file boundary; absent exercises explicit picker `w` degradation. */
  writeTextFile?: TuiRuntime['writeTextFile']
  /** Durable workspace history provider behind `/diff`, `/checkpoint`, and `/rewind`. */
  workspaceHistory?: TuiRuntime['workspaceHistory']
  /** Optional durable image store used by clipboard admission tests. */
  attachments?: AttachmentStore
  /** Latest committed live TUI settings; absent falls back to plugin config. */
  readSettings?: () => TuiUserSettings
  /** Writable user-settings boundary; absent exercises explicit degradation. */
  updateSettings?: TuiRuntime['updateSettings']
  /** Model target supplied by a preceding fresh-session swap. */
  initialModelSelection?: TuiRuntime['initialModelSelection']
  /** Host-authored transient notice shown when this TUI channel starts. */
  initialNotice?: TuiRuntime['initialNotice']
  /** Host-supplied exit line; absent exercises the no-message path. */
  goodbyeMessage?: TuiRuntime['goodbyeMessage']
  /** Set false to exercise the optional session-query degradation path. */
  mountSessionQuery?: boolean
}

export interface TuiHarness<TerminalType extends Terminal, Exit extends (code: number) => void> {
  ctx: Context
  session: Session
  agent: FakeAgent
  terminal: TerminalType
  exit: Exit
  controller: ReturnType<typeof createTuiChat>
}

/**
 * Compose the production TUI around an in-memory session and controllable agent.
 * @param terminal - Terminal boundary driven by the test.
 * @param exit - Process-exit observer.
 * @param options - Initial session, agent, tool, and TUI configuration.
 * @returns The mounted TUI and every boundary the test may drive or inspect.
 */
export async function createTuiTestHarness<TerminalType extends Terminal, Exit extends (code: number) => void>(
  terminal: TerminalType,
  exit: Exit,
  options: TuiHarnessOptions = {},
): Promise<TuiHarness<TerminalType, Exit>> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandService)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(TuiPromptService)
  if (options.attachments !== undefined) ctx.provide('attachments', options.attachments)
  const catalog = options.catalog ?? {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  }
  ctx.provide('tokenMeter', {
    measure(session: Session) {
      if (options.contextMeasurement !== undefined) return options.contextMeasurement
      const totalTokens = options.contextTokens ?? 0
      return {
        logRevision: session.events.length,
        baseline: totalTokens === 0
          ? { kind: 'none', tokens: 0 }
          : { kind: 'estimated', tokens: totalTokens },
        surfaceDeltaTokens: 0,
        totalTokens,
        surfaceTokens: 0,
        nodes: [],
      }
    },
  } as never)
  if (options.configureContext === undefined) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    for (const tool of Object.values(options.tools ?? {})) ctx.tools.register(tool)
  } else {
    await options.configureContext(ctx)
  }
  // A configureContext may mount the real LlmService; only fill the
  // advisory-catalog stub when none was provided.
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders() {
        return catalog.providers.map(provider => ({ ...provider }))
      },
      listModels(provider: string) {
        return catalog.listModels?.(provider)
          ?? Promise.resolve(catalog.models.filter(model => model.provider === provider).map(model => ({ ...model })))
      },
      async resolveModelInfo(provider: string, model: string) {
        const advertised = catalog.models.find(candidate =>
          candidate.provider === provider && candidate.id === model)
        const capabilities = await (catalog.resolveModelInfo?.(provider, model)
          ?? Promise.resolve({
            context: { contextWindow: options.contextWindow ?? 128_000 },
          }))
        return {
          provider,
          id: model,
          name: advertised?.name ?? model,
          ...advertised?.description === undefined ? {} : { description: advertised.description },
          ...capabilities,
        }
      },
    } as never)
  }
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (options.contextBreakdown !== undefined && ctx.get('sessionProjections') === undefined) {
    ctx.provide('sessionProjections', {
      snapshot(session: Session) {
        return {
          asOfSeq: session.events.length - 1,
          values: { contextBreakdown: options.contextBreakdown },
        }
      },
    } as never)
  }
  if (options.sessionPersistence !== undefined) {
    const persistence = options.sessionPersistence
    ctx.provide('sessionPersistence', {
      ...persistence,
      locate: (meta: SessionHeader) => persistence.locate?.(meta),
      create: () => Promise.resolve(),
      append: () => Promise.resolve(),
      load: persistence.load === undefined
        ? (id: ReturnType<typeof SessionId>) => Promise.reject(new Error(`session "${id}" not found`))
        : (id: ReturnType<typeof SessionId>) => persistence.load!(id),
      inspect: persistence.load === undefined
        ? (id: ReturnType<typeof SessionId>) => Promise.reject(new Error(`session "${id}" not found`))
        : (id: ReturnType<typeof SessionId>) => persistence.load!(id),
    } as never)
  }
  if (options.mountSessionQuery !== false && ctx.get('sessionQuery') === undefined) {
    await ctx.plugin(TestSessionQueryEngine)
  }
  const sessionId = SessionId('main-session')
  const session = ctx.sessions.create(
    sessionId,
    options.cwd === null ? undefined : { meta: { cwd: options.cwd ?? '/workspace' } },
  )
  if (options.omitInitialLifecycle !== true) {
    session.append('turn/start', {
      turn: 1,
    })
    session.append('step/start', { turn: 1, step: 1 })
  }
  options.beforeMount?.(session)
  const sent: ContentBlock[][] = []
  const sentMessages: UserMessage[] = []
  const steered: ContentBlock[][] = []
  const steeredIds: MessageId[] = []
  const steeredOptions: UserMessage[] = []
  const injected: ContentBlock[][] = []
  const injectedOptions: UserMessage[] = []
  const cancelled: AgentCancelCause[] = []
  const agent: FakeAgent = {
    id: sessionId,
    options: options.agentOptions ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    status: options.status ?? 'idle',
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx,
    sent,
    sentMessages,
    steered,
    steeredIds,
    steeredOptions,
    injected,
    injectedOptions,
    cancelled,
    send(input, _target, _wakeup) {
      sent.push(input.content)
      sentMessages.push(input)
    },
    followup(input) {
      sent.push(input.content)
      sentMessages.push(input)
    },
    steer(input) {
      steered.push(input.content)
      steeredOptions.push(input)
      steeredIds.push(input.id)
    },
    inject(input) {
      injected.push(input.content)
      injectedOptions.push(input)
    },
    cancel(cause) {
      cancelled.push(cause)
    },
    runMaintenance() {
      throw new Error('harness: runMaintenance is not supported')
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
  ctx.agents.register(agent)
  const controller = createTuiChat(ctx, Object.assign({
    ...options.omitWelcome === true ? {} : { welcome: 'Coding agent ready.' },
    sessionId,
    theme: { color: false },
  }, options.config), {
    terminal,
    exit,
    // Default to the real clock (runtime.now falls back to Date.now) so the
    // elapsed-status suites can drive time via timers or Date.now spies; a
    // test pins the clock only by passing `now` explicitly.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.formatCwd === undefined ? {} : { formatCwd: options.formatCwd }),
    ...(options.swapResume === undefined ? {} : { swapResume: options.swapResume }),
    ...(options.swapFresh === undefined ? {} : { swapFresh: options.swapFresh }),
    ...(options.swapFork === undefined ? {} : { swapFork: options.swapFork }),
    ...(options.editText === undefined ? {} : { editText: options.editText }),
    ...(options.readClipboardImage === undefined ? {} : { readClipboardImage: options.readClipboardImage }),
    ...(options.writeClipboardText === undefined ? {} : { writeClipboardText: options.writeClipboardText }),
    ...(options.writeTextFile === undefined ? {} : { writeTextFile: options.writeTextFile }),
    ...(options.workspaceHistory === undefined ? {} : { workspaceHistory: options.workspaceHistory }),
    ...(options.readSettings === undefined ? {} : { readSettings: options.readSettings }),
    ...(options.updateSettings === undefined ? {} : { updateSettings: options.updateSettings }),
    ...(options.initialModelSelection === undefined ? {} : { initialModelSelection: options.initialModelSelection }),
    ...(options.initialNotice === undefined ? {} : { initialNotice: options.initialNotice }),
    ...(options.goodbyeMessage === undefined ? {} : { goodbyeMessage: options.goodbyeMessage }),
    gitBranch: options.gitBranch ?? (() => 'tui-staging'),
  })
  return { ctx, session, agent, terminal, exit, controller }
}

/** Dispose the mounted TUI before its owning Cordis context. */
export async function disposeTuiTestHarness(
  setup: Pick<TuiHarness<Terminal, (code: number) => void>, 'controller' | 'ctx'>,
): Promise<void> {
  await setup.controller.dispose()
  await setup.ctx.fiber.dispose()
}

/** Append a production-shaped user message to the active session surface. */
export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the active session surface. */
export function appendAssistant(
  session: Session,
  content: ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  position: { turn: number; step: number } = { turn: 1, step: 1 },
): void {
  session.append('assistant/message', {
    ...position,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}
