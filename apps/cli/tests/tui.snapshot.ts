import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scrubRequestHeaders, tokenizeSessionFixtureCwd } from '@deepseek-ai/dsh-acp-snapshot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentCore from '@deepseek-ai/dsh-agent-spine-demo'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import WorkerCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker-thread'
import CommandService from '@deepseek-ai/dsh-commands'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import PlanModeService from '@deepseek-ai/dsh-plan-mode'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import { packChunkRuns, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { createTuiChat, FILE_REFERENCE_PROMPT, TuiPromptService } from '@deepseek-ai/dsh-tui'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import UserInteractionService from '@deepseek-ai/dsh-user-questions'
import UserApprovalService from '@deepseek-ai/dsh-user-approval'
import WorkerWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { HeadlessTerminal } from '../../../packages/ui/tui/tests/headless-terminal.ts'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
// Keep pre-normalization layout widths identical across macOS and Linux.
const SNAPSHOT_TMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp'
const PROVIDERS = [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000 }] }]
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

type SnapshotMode = 'replay' | 'record' | 'refresh'
type Composition = 'native' | 'code' | 'advanced'
type ScenarioInteraction = 'skill-invocation-policy' | 'direct-shell' | 'mode-cycle'

const DIRECT_SHELL_SNAPSHOT_COMMAND = 'node -e "console.log([\'DIRECT\',\'SHELL\',\'STREAM\',\'START\'].join(\'_\')); setTimeout(() => console.log([\'DIRECT\',\'SHELL\',\'SNAPSHOT\'].join(\'_\')), 1000)"'

interface Scenario {
  name: string
  /** Replay fixture owned by an earlier scenario, for a derived presentation case. */
  fixture?: string
  composition: Composition
  expectedTools: string[]
  expectedEventCounts?: Record<string, number>
  childSessions?: number
  enterPlanMode?: boolean
  leavePlanModeAfterFirstTurn?: boolean
  recorded: boolean
  seedWorkspace?: boolean
  /** Add the launcher's model-visible DSH source checkout at this fixed path. */
  harnessSourceRoot?: string
  /** Replace the real `pwd` result with a portable fixed-length workspace path. */
  normalizePwdResult?: boolean
  /**
   * Load the opt-in `todo_write` tool for this scenario. The shipped TUI
   * config omits it, so only the todo-plan scenario (the enabled-path proof)
   * mounts it; the rest cover the default, todo-free composition.
   */
  enableTodo?: boolean
  /**
   * Mount the spill stack (local backend + policy) with this inline cap, as the
   * shipped configs do. The dispatch-spill scenario proves the durable
   * `tool/code-dispatch` copy of an oversized sub-result is bounded to a
   * preview + locator while the program value stays whole.
   */
  spillMaxInlineBytes?: number
  /** Run scenario-specific terminal input instead of replaying recorded user prompts. */
  interaction?: ScenarioInteraction
  /**
   * Mount a deterministic compaction backend plus `/compact`, then run the
   * human command with a held summary while a prompt and injected context
   * arrive. Proves queued input waits for the standalone bracket's durability
   * checkpoint instead of racing the replacement.
   */
  manualCompact?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    expectedEventCounts: { 'plan/mode': 2 },
    enterPlanMode: true,
    leavePlanModeAfterFirstTurn: true,
    recorded: true,
  },
  {
    name: 'queued-manual-compact',
    fixture: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    manualCompact: true,
  },
  {
    name: 'todo-plan',
    composition: 'native',
    expectedTools: ['todo_write'],
    expectedEventCounts: { 'todo/write': 1 },
    recorded: true,
    enableTodo: true,
  },
  {
    name: 'bash-terminal-card',
    composition: 'native',
    expectedTools: ['bash'],
    recorded: true,
  },
  {
    name: 'direct-shell-mode',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    interaction: 'direct-shell',
  },
  {
    name: 'permission-mode-cycle',
    fixture: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    interaction: 'mode-cycle',
  },
  {
    name: 'source-checkout-workdir',
    composition: 'native',
    expectedTools: ['bash'],
    recorded: true,
    harnessSourceRoot: '/opt/dsh-source',
    normalizePwdResult: true,
  },
  {
    name: 'parallel-file-reads',
    composition: 'native',
    expectedTools: ['read', 'read'],
    recorded: true,
    seedWorkspace: true,
  },
  {
    name: 'skill-invocation-policy',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    seedWorkspace: true,
    interaction: 'skill-invocation-policy',
  },
  {
    name: 'code-mode',
    composition: 'code',
    expectedTools: ['run_code'],
    expectedEventCounts: { 'tool/code-dispatch': 2 },
    recorded: true,
  },
  {
    name: 'code-mode-dispatch-spill',
    composition: 'code',
    expectedTools: ['run_code'],
    expectedEventCounts: { 'tool/code-dispatch-start': 1, 'tool/code-dispatch': 1 },
    recorded: true,
    spillMaxInlineBytes: 600,
  },
  {
    name: 'dynamic-workflow',
    composition: 'native',
    expectedTools: ['workflow'],
    childSessions: 1,
    recorded: true,
  },
  {
    name: 'cordis-dynamic-toolchain',
    composition: 'advanced',
    expectedTools: ['cordis_mount', 'run_code', 'subagent', 'workflow', 'cordis_unmount'],
    expectedEventCounts: { 'tool/code-dispatch': 1 },
    childSessions: 2,
    recorded: false,
  },
]

function snapshotModeFromEnv(value: string | undefined): SnapshotMode {
  if (value === undefined || value === '' || value === 'replay') return 'replay'
  if (value === 'record' || value === 'refresh') return value
  throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(value)}`)
}

const MODE = snapshotModeFromEnv(process.env.DSH_SNAPSHOT)
const observedScenarios = new Set<string>()
const workerState = Reflect.get(globalThis, '__vitest_worker__') as
  | { readonly config?: { readonly testNamePattern?: RegExp } }
  | undefined
// Worker argv omits the parent CLI's `-t`; the serialized runner config is the
// authoritative distinction between a focused replay and the full suite.
const TEST_NAME_FILTERED = workerState?.config?.testNamePattern !== undefined

/**
 * Deterministic keyless summary that pauses so the scenario can submit a real
 * prompt and inject context while manual compaction holds turn admission.
 */
class DeferredSnapshotCompactService extends BasicCompactionEngine {
  readonly summaryStarted = Promise.withResolvers<undefined>()
  readonly releaseSummary = Promise.withResolvers<undefined>()

  override async summarize(
    _input: SummarizationInput,
    _agent: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: [{ type: 'text'; text: string }]; provider: string; model: string }> {
    this.summaryStarted.resolve(undefined)
    await this.releaseSummary.promise
    signal?.throwIfAborted()
    return {
      summary: [{ type: 'text', text: 'Keyless manual compaction checkpoint.' }],
      provider: 'snapshot',
      model: 'snapshot-compactor',
    }
  }
}

/** Seed between-turn model-visible history without inventing a loop execution. */
function seedCompactableHistory(agent: Agent): void {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'Older snapshot context. '.repeat(60) }],
    source: { kind: 'plugin', plugin: 'snapshot-seed' },
  }))
}

function snapshotDisplayPath(displayPath: string, cwd: string, displayCwd: string): string {
  const rel = relative(cwd, displayPath)
  if (rel === '') return displayCwd
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return displayPath
  return `${displayCwd}/${rel.split(sep).join('/')}`
}

function scenarioDir(scenario: Scenario): string {
  return join(SNAPSHOTS_DIR, scenario.name)
}

/** Directory owning the replay fixture: the scenario's own, or the one it derives from. */
function fixtureDir(scenario: Scenario): string {
  return join(SNAPSHOTS_DIR, scenario.fixture ?? scenario.name)
}

function childFixturePaths(scenario: Scenario): string[] {
  return Array.from(
    { length: scenario.childSessions ?? 0 },
    (_, index) => join(fixtureDir(scenario), `session.${index + 1}.jsonl`),
  )
}

function userPrompts(rawLog: string): string[] {
  return parseSessionLog(rawLog).flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return text.length > 0 ? [text] : []
  })
}

function rawSessionLog(session: Session): string {
  return [
    JSON.stringify({ type: 'session', ...session.header }),
    ...packChunkRuns(session.events).map(record => JSON.stringify(record)),
    '',
  ].join('\n')
}

async function materializeFixtureCwd(fixtureFile: string, cwd: string, replayRoot: string): Promise<string> {
  const realized = join(replayRoot, basename(fixtureFile))
  // The token appears inside JSON string values. POSIX paths are already safe,
  // while a Windows path's backslashes must be escaped before the realized
  // JSONL is parsed (plain text replacement turns `C:\Users` into invalid `\U`).
  const jsonStringCwd = JSON.stringify(cwd).slice(1, -1)
  await writeFile(realized, (await readFile(fixtureFile, 'utf8')).split('{{cwd}}').join(jsonStringCwd))
  return realized
}

function normalizeTerminalSnapshot(snapshot: string, cwd: string, displayCwd: string): string {
  const serializedCwd = JSON.stringify(cwd).slice(1, -1)
  return snapshot
    .split(`/private${cwd}`).join('/workspace/project')
    .split(displayCwd).join('/workspace/project')
    // HeadlessTerminal serializes each rendered row with JSON.stringify, so
    // native Windows paths carry doubled backslashes by this stage.
    .split(serializedCwd).join('/workspace/project')
    .split(cwd).join('/workspace/project')
    .replace(UUID_RE, '{{uuid}}')
}

async function settleTerminal(terminal: HeadlessTerminal): Promise<void> {
  let stable = 0
  for (let attempt = 0; attempt < 20 && stable < 3; attempt++) {
    const before = terminal.frames
    await new Promise(resolve => setTimeout(resolve, 10))
    await terminal.flush()
    stable = terminal.frames === before ? stable + 1 : 0
  }
  if (stable < 3) throw new Error('TUI frames did not quiesce within 200ms')
}

/** Wait for model-independent terminal evidence without relying on the mocked wall clock. */
async function waitForTerminalText(
  terminal: HeadlessTerminal,
  marker: string,
): Promise<string> {
  let latest = ''
  for (let attempt = 0; attempt < 500; attempt++) {
    await terminal.flush()
    latest = await terminal.snapshot({ includeScrollback: true })
    if (latest.includes(marker)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`terminal did not render ${JSON.stringify(marker)}; latest=${latest}`)
}

/** Bound deterministic in-process coordination waits with actionable state. */
async function snapshotDeadline<T>(
  operation: Promise<T>,
  detail: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(detail())) }, 5_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function mountScenarioContext(
  scenario: Scenario,
  cwd: string,
  displayCwd: string,
  fixtureFile: string,
  childFiles: string[],
  replayRoot: string | undefined,
): Promise<Context> {
  class SnapshotLocalFileSystem extends LocalFileSystem {
    override async resolve(
      path: string,
      opts?: { cwd?: string; signal?: AbortSignal },
    ): Promise<Awaited<ReturnType<LocalFileSystem['resolve']>>> {
      const target = await super.resolve(path, opts)
      return { ...target, displayPath: snapshotDisplayPath(target.displayPath, cwd, displayCwd) }
    }
  }

  const ctx = new Context()
  await ctx.plugin(AgentCore, {
    agents: [],
    dshHome: join(cwd, '.dsh'),
    workspaceContext: false,
    tools: { mode: scenario.composition === 'code' ? 'code' : scenario.composition === 'advanced' ? 'both' : 'native' },
    skills: { filesystem: { agentsHome: join(cwd, '.agents') } },
  })
  if (scenario.harnessSourceRoot !== undefined) addHarnessSourceSection(ctx, scenario.harnessSourceRoot)
  await ctx.plugin(TokenMeterService)
  if (scenario.manualCompact === true) {
    await ctx.plugin(DeferredSnapshotCompactService, { auto: false })
  }
  await ctx.plugin(LocalSubprocessService)
  if (scenario.interaction === 'mode-cycle') {
    // Permission switching owns the behavior under snapshot. The executor is
    // an external boundary here, so a capability-only confined stub avoids
    // platform sandbox variance while the real PTY suite covers the shipped
    // sandbox composition.
    ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  } else if (process.platform === 'win32') {
    await ctx.plugin(PwshLocalExecutor, { cwd, timeoutMs: 30_000 })
  } else {
    await ctx.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  }
  await ctx.plugin(SnapshotLocalFileSystem, { cwd: '/' })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(TuiPromptService)
  // todo_write is opt-in: only the todo-plan scenario mounts it, matching the shipped
  // config that omits it. The other scenarios prove the default todo-free composition.
  if (scenario.enableTodo === true) await ctx.plugin(ToolTodo)
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent', enableRunInBackground: false })
  await ctx.plugin(WorkerWorkflowEngine, { provider: 'spawn' })
  await ctx.plugin(ToolWorkflow)
  await ctx.plugin(ToolRalph)
  await ctx.plugin(CommandService)
  if (scenario.interaction === 'mode-cycle') {
    await ctx.plugin(UserApprovalService, { policy: 'ask' })
    await ctx.plugin(PermissionPresetService, {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    })
  }
  if (scenario.manualCompact === true) await ctx.plugin(CommandCompact)
  if (scenario.enterPlanMode === true || scenario.interaction === 'mode-cycle') {
    await ctx.plugin(PlanModeService, { section: 'Snapshot plan mode instructions.' })
  }
  if (scenario.composition === 'code' || scenario.composition === 'advanced') {
    await ctx.plugin(WorkerCodeRuntime, {})
  }
  if (scenario.spillMaxInlineBytes !== undefined) {
    await ctx.plugin(LocalSpillStore, { root: join(cwd, '.spill') })
    await ctx.plugin(SpillPolicy, { maxInlineBytes: scenario.spillMaxInlineBytes })
  }
  if (scenario.composition === 'advanced') await ctx.plugin(ToolCordis)
  if (MODE === 'record' && scenario.recorded) {
    await ctx.plugin(LlmDeepSeek)
  } else {
    if (replayRoot === undefined) throw new Error('replay mode requires an isolated fixture directory')
    // Recorded model text may name the generated cwd. Realize the portable token
    // outside that cwd so tools see only the scenario workspace during replay.
    const replayFile = await materializeFixtureCwd(fixtureFile, cwd, replayRoot)
    const replayChildFiles = await Promise.all(childFiles.map(file => materializeFixtureCwd(file, cwd, replayRoot)))
    installLlmReplay(ctx, { file: replayFile, childFiles: replayChildFiles, providers: PROVIDERS })
  }
  return ctx
}

interface ScenarioResult {
  terminal: string
  parent: Session
  children: Session[]
  workflowEvents: string[]
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const snapshotTime = new Date(2026, 6, 21, 12, 0, 0).getTime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(snapshotTime)
  const fixtureFile = join(fixtureDir(scenario), 'session.jsonl')
  const childFiles = childFixturePaths(scenario)
  const prompts = userPrompts(await readFile(fixtureFile, 'utf8'))
  if (scenario.interaction === undefined) {
    expect(prompts.length, `${scenario.name} must carry at least one recorded user prompt`).toBeGreaterThan(0)
  }

  const cwd = await mkdtemp(join(SNAPSHOT_TMP_ROOT, `dsh-tui-snapshot-${scenario.name}-`))
  const displayCwd = `/tmp/${basename(cwd)}`
  let replayRoot: string | undefined
  let ctx: Context | undefined
  let controller: ReturnType<typeof createTuiChat> | undefined
  const terminal = new HeadlessTerminal(100, 36)
  try {
    if (!(MODE === 'record' && scenario.recorded)) {
      replayRoot = await mkdtemp(join(SNAPSHOT_TMP_ROOT, `dsh-tui-replay-${scenario.name}-`))
    }
    if (scenario.seedWorkspace === true) {
      const source = join(fixtureDir(scenario), 'workspace')
      await cp(source, cwd, { recursive: true })
    }
    ctx = await mountScenarioContext(scenario, cwd, displayCwd, fixtureFile, childFiles, replayRoot)
    if (scenario.normalizePwdResult === true) {
      ctx.on('tools/post-execute', async (exec, result, next) => {
        const args = exec.arguments as { command?: unknown }
        return exec.name === 'bash' && args.command === 'pwd' && !result.isError
          ? { kind: 'accept', content: [{ type: 'text', text: '/workspace/project\n' }] }
          : next()
      })
    }
    const disposedSessions: Session[] = []
    ctx.on('session/disposed', (session) => { disposedSessions.push(session) })
    const workflowEvents: string[] = []
    for (const name of ['workflow/start', 'workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
      ctx.on(name, () => { workflowEvents.push(name) })
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId('main-session'),
      meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const agent: Agent = handle.agent
    if (scenario.interaction === 'mode-cycle') {
      expect(ctx.get('permissionPresets')).toBeDefined()
      expect(ctx.get('planMode')).toBeDefined()
      expect(ctx.permissionPresets.current(agent.session.events)).toBe('workspace-write')
    }
    if (scenario.manualCompact === true) seedCompactableHistory(agent)
    controller = createTuiChat(ctx, {
      sessionId: 'main-session',
      theme: { color: true },
      showReasoning: true,
      title: 'DSH TUI snapshot',
      welcome: `Recorded replay: ${scenario.name}`,
      maxToolOutputLines: 8,
    }, {
      terminal,
      exit: () => {},
      formatCwd: () => displayCwd,
    })
    await settleTerminal(terminal)

    let interactionSnapshot: string | undefined
    if (scenario.interaction === 'skill-invocation-policy') {
      terminal.send('/skill')
      await settleTerminal(terminal)
      const discovery = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(discovery).toContain('user-only-skill')
      expect(discovery).not.toContain('model-only-skill')

      terminal.send('\x03')
      await settleTerminal(terminal)
      const skillContext = ctx
      const skillTurnEnded = new Promise<void>((resolve) => {
        const detach = skillContext.on('session/event', (session, event) => {
          if (session !== agent.session || event.type !== 'turn/end') return
          detach()
          resolve()
        })
      })
      terminal.send('/skill:user-only-skill')
      terminal.send('\r')
      await skillTurnEnded
      await agent.whenIdle()
      await settleTerminal(terminal)
      const loaded = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(loaded).toContain('USER-ONLY SKILL LOADED')

      terminal.send('/skill:model-only-skill')
      terminal.send('\r')
      await settleTerminal(terminal)
      const denied = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(denied).toContain('model-only-skill')
      expect(denied).toContain('not available for user invocation.')
      expect(denied).not.toContain('MODEL-ONLY BODY MUST NOT LOAD')
      interactionSnapshot = [
        '=== skill autocomplete ===',
        discovery,
        '',
        '=== loaded exact invocation ===',
        loaded,
        '',
        '=== denied exact invocation ===',
        denied,
      ].join('\n')
    }
    if (scenario.interaction === 'direct-shell') {
      const directShellContext = ctx
      const turnEnded = new Promise<void>((resolve) => {
        const detach = directShellContext.on('session/event', (session, event) => {
          if (session !== agent.session || event.type !== 'turn/end') return
          detach()
          resolve()
        })
      })
      terminal.send(`! ${DIRECT_SHELL_SNAPSHOT_COMMAND}`)
      terminal.send('\r')
      const live = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'DIRECT_SHELL_STREAM_START'),
        cwd,
        displayCwd,
      )

      terminal.send('\x02')
      const backgrounded = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'Shell moved to background as bash-1'),
        cwd,
        displayCwd,
      )

      terminal.send('/tasks')
      terminal.send('\r')
      const tasks = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'bash-1 · running'),
        cwd,
        displayCwd,
      )

      await snapshotDeadline(turnEnded, () =>
        `direct-shell result did not reach a model turn; status=${agent.status}; tail=${
          agent.session.events.slice(-8).map(event => event.type).join(',')
        }`)
      await agent.whenIdle()
      await settleTerminal(terminal)
      const completed = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )

      terminal.send('! node -e')
      terminal.send('\t')
      const historyCompletion = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'dsh ◍ ! node -e \\"console.log'),
        cwd,
        displayCwd,
      )
      terminal.send('\x03')

      await mkdir(join(cwd, 'scripts'), { recursive: true })
      await writeFile(join(cwd, 'scripts', 'run-history.ps1'), 'Write-Output snapshot\n')
      terminal.send('! ./scripts')
      terminal.send('/')
      const pathMenu = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'run-history.ps1'),
        cwd,
        displayCwd,
      )
      terminal.send('\t')
      await settleTerminal(terminal)
      const pathCompletion = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(historyCompletion).toContain('dsh ◍ ! node -e \\"console.log')
      expect(pathMenu).toContain('run-history.ps1')
      expect(pathCompletion).toContain('! ./scripts/run-history.ps1')
      terminal.send('\x03')

      terminal.send('\x12')
      terminal.send('node -e')
      const historySearch = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'History search (1 of 1)'),
        cwd,
        displayCwd,
      )
      expect(historySearch).toContain('this session (2)')
      expect(historySearch).toContain('Ctrl+S scope')
      expect(historySearch).toContain('node -e')
      terminal.send('\t')
      const historyInserted = normalizeTerminalSnapshot(
        await waitForTerminalText(terminal, 'dsh ◍ ! node -e \\"console.log'),
        cwd,
        displayCwd,
      )
      expect(historyInserted).toContain('dsh ◍ ! node -e \\"console.log')
      terminal.send('\x03')
      interactionSnapshot = [
        '=== live direct-shell output ===',
        live,
        '',
        '=== Ctrl+B background transfer ===',
        backgrounded,
        '',
        '=== /tasks lifecycle ===',
        tasks,
        '',
        '=== producer-delivered completion ===',
        completed,
        '',
        '=== project shell-history Tab completion ===',
        historyCompletion,
        '',
        '=== live shell-path menu ===',
        pathMenu,
        '',
        '=== accepted shell path ===',
        pathCompletion,
        '',
        '=== Ctrl+R prompt-history search ===',
        historySearch,
        '',
        '=== accepted prompt-history result ===',
        historyInserted,
      ].join('\n')
    }
    if (scenario.interaction === 'mode-cycle') {
      const snapshotMode = async (): Promise<string> => {
        await settleTerminal(terminal)
        return normalizeTerminalSnapshot(
          await terminal.snapshot({ includeScrollback: true }),
          cwd,
          displayCwd,
        )
      }
      const initial = await snapshotMode()

      terminal.send('\x1b[Z')
      const plan = await snapshotMode()
      expect(ctx.planMode.get(agent)).toEqual({ active: true })

      terminal.send('\x1b[Z')
      await snapshotMode()
      terminal.send('\x1b[Z')
      const safeWrap = await snapshotMode()
      expect(ctx.permissionPresets.current(agent.session.events)).toBe('workspace-write')
      expect(ctx.planMode.get(agent)).toEqual({ active: false })

      terminal.send('/permission danger-full-access')
      terminal.send('\r')
      const explicitlyEnabled = await snapshotMode()
      expect(ctx.permissionPresets.current(agent.session.events)).toBe('danger-full-access')

      for (let index = 0; index < 4; index += 1) {
        terminal.send('\x1b[Z')
        await settleTerminal(terminal)
      }
      const unlockedCycle = await snapshotMode()
      expect(ctx.permissionPresets.current(agent.session.events)).toBe('danger-full-access')
      expect(ctx.planMode.get(agent)).toEqual({ active: false })

      interactionSnapshot = [
        '=== initial permission mode ===',
        initial,
        '',
        '=== Shift+Tab enters Plan ===',
        plan,
        '',
        '=== safe cycle wraps without full access ===',
        safeWrap,
        '',
        '=== explicit full-access selection ===',
        explicitlyEnabled,
        '',
        '=== explicitly unlocked full-access cycle ===',
        unlockedCycle,
      ].join('\n')

      // Keep the replayed model fixture on its ordinary permission preset;
      // the snapshot above already owns the full-access presentation.
      terminal.send('/permission workspace-write')
      terminal.send('\r')
      await settleTerminal(terminal)
    }

    let remainingPrompts = prompts
    let queuedPrompt: string | undefined
    let manualOrder: string[] | undefined
    let manualCommandId: string | undefined
    if (scenario.manualCompact === true) {
      expect(prompts.length, 'queued manual compaction needs a second replayed prompt').toBeGreaterThanOrEqual(2)
      queuedPrompt = prompts.at(-1)
      remainingPrompts = prompts.slice(0, -1)
    }
    if (scenario.enterPlanMode === true) {
      const firstPrompt = prompts[0]!
      terminal.send(`/plan ${firstPrompt}`)
      terminal.send('\r')
      await agent.whenIdle()
      await settleTerminal(terminal)
      remainingPrompts = prompts.slice(1)
    }

    if (scenario.leavePlanModeAfterFirstTurn === true) {
      terminal.send('/plan off')
      terminal.send('\r')
      await settleTerminal(terminal)
    }

    for (const prompt of remainingPrompts) {
      const admitted = agent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'user').length
      terminal.send(prompt)
      terminal.send('\r')
      await terminal.flush()
      await expect.poll(() => agent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'user').length).toBe(admitted + 1)
      await agent.whenIdle()
      await settleTerminal(terminal)
    }

    if (scenario.manualCompact === true && queuedPrompt !== undefined) {
      terminal.send('/help')
      terminal.send('\r')
      await settleTerminal(terminal)
      expect(await terminal.snapshot({ includeScrollback: true }))
        .toContain('/compact — Compact older conversation history')

      const compact = ctx.compaction as DeferredSnapshotCompactService
      const inbox: string[] = []
      manualOrder = []
      ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
        if (subject === agent) inbox.push(`inserted:${message.id}`)
      })
      ctx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
        if (subject === agent) inbox.push(`claimed:${message.id}`)
      })
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'command/run' && event.data.name === 'compact') {
          manualCommandId = event.data.commandId
          manualOrder?.push('command/run')
        }
        if (event.type === 'command/done' && event.data.commandId === manualCommandId) {
          manualOrder?.push('command/done')
        }
        if (event.type.startsWith('compaction/')) manualOrder?.push(event.type)
        if (event.type === 'user/message'
          && event.data.source.kind === 'plugin'
          && event.data.source.plugin === 'compact') manualOrder?.push('checkpoint')
        if (event.type === 'turn/start') manualOrder?.push(`turn/start:${event.data.turn}`)
      })
      ctx.on('session/flush', (session) => {
        if (session === agent.session) manualOrder?.push('flush')
      })

      terminal.send('/compact')
      terminal.send('\r')
      await terminal.flush()
      await snapshotDeadline(compact.summaryStarted.promise, () =>
        `manual summary did not start; status=${agent.status}; tail=${
          agent.session.events.slice(-8).map(event => event.type).join(',')
        }`)
      clock.mockReturnValue(snapshotTime + 1_000)
      await settleTerminal(terminal)
      await expect.poll(() => terminal.snapshot()).toContain('dsh ⊙')
      await expect.poll(() => terminal.snapshot()).toContain('Context being compacted 1.0s')
      const liveCompaction = await terminal.snapshot()
      expect(liveCompaction.indexOf('Context being compacted 1.0s')).toBeLessThan(liveCompaction.indexOf('dsh ⊙'))
      clock.mockReturnValue(snapshotTime)

      // Real keystrokes: the prompt keeps its ordinary queue identity while
      // admission is reserved, and an injection appends immediately.
      terminal.send(queuedPrompt)
      terminal.send('\r')
      await terminal.flush()
      await expect.poll(() => inbox.length).toBe(1)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: 'Injected while compaction was running.' }],
        source: { kind: 'plugin', plugin: 'snapshot-injector' },
      }))
      expect(inbox[0]).toMatch(/^inserted:/u)
      expect(agent.status).toBe('idle')
      expect(agent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text === queuedPrompt))).toBe(false)

      const idle = agent.whenIdle()
      compact.releaseSummary.resolve(undefined)
      await snapshotDeadline(idle, () =>
        `manual compaction did not reach idle; status=${agent.status}; order=${manualOrder?.join(',') ?? ''}; tail=${
          agent.session.events.slice(-12).map(event => event.type).join(',')
        }`)
      await settleTerminal(terminal)
      expect(inbox).toEqual([inbox[0], `claimed:${inbox[0]?.slice('inserted:'.length) ?? ''}`])
    }

    const events: SessionEvent[] = [...agent.session.events]
    const firstHeader = events.find(event => event.type === 'request/header')
    expect(firstHeader?.type === 'request/header' && firstHeader.data.header.system)
      .toContain(FILE_REFERENCE_PROMPT)
    if (scenario.harnessSourceRoot !== undefined) {
      expect(firstHeader?.type === 'request/header' && firstHeader.data.header.system)
        .toContain(`The DeepSeek Harness implementation checkout is at ${scenario.harnessSourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`)
    }
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(scenario.expectedTools)
    for (const [type, count] of Object.entries(scenario.expectedEventCounts ?? {})) {
      expect(events.filter(event => event.type === type), `${scenario.name} must emit ${type}`).toHaveLength(count)
    }
    if (scenario.enterPlanMode === true) {
      expect(ctx.planMode.get(agent)).toEqual({
        active: scenario.leavePlanModeAfterFirstTurn !== true,
      })
      const planMode = events.find(event => event.type === 'plan/mode')
      if (planMode === undefined || firstHeader === undefined) {
        throw new Error('plan-mode command snapshot needs plan/mode before its first request/header')
      }
      expect(planMode.seq).toBeLessThan(firstHeader.seq)
      expect(firstHeader.data.header.system).toContain('Snapshot plan mode instructions.')
      const firstMessage = events.find(event => event.type === 'user/message')
      expect(firstMessage?.data.content).toEqual([{ type: 'text', text: prompts[0] }])
    }
    if (scenario.leavePlanModeAfterFirstTurn === true) {
      const planModes = events.filter(event => event.type === 'plan/mode')
      expect(planModes.map(event => event.data.active)).toEqual([true, false])
      const headers = events.filter(event => event.type === 'request/header')
      const exit = planModes[1]
      const afterExit = headers[1]
      if (exit === undefined || afterExit === undefined) {
        throw new Error('active plan exit snapshot needs a committed exit and changed request header')
      }
      expect(exit.seq).toBeLessThan(afterExit.seq)
      expect(afterExit.data.header.system).not.toContain('Snapshot plan mode instructions.')
      expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin').map(event => (event.data as { content: unknown }).content))
        .toContainEqual([{ type: 'text', text: 'The user switched this session back to the default mode.' }])
    }
    if (scenario.manualCompact === true) {
      const compactStart = events.find(event => event.type === 'compaction/start')
      const compactSummary = events.find(event => event.type === 'compaction/summary')
      const compactCheckpoint = events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact')
      const injectedEvent = events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin' && event.data.source.plugin === 'snapshot-injector')
      const compactEnd = events.find(event => event.type === 'compaction/end')
      expect(compactStart?.data.turn).toBeNull()
      expect(compactEnd?.data.turn).toBeNull()
      expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
      if (compactStart === undefined || compactSummary === undefined
        || compactCheckpoint === undefined || injectedEvent === undefined
        || compactEnd === undefined) {
        throw new Error('manual compaction snapshot is missing its durable marker, summary, checkpoint, or injection')
      }
      // The markers are time points, not an exclusive container: unrelated
      // idle injection is allowed between them while the selected span stays stable.
      expect(compactStart.seq).toBeLessThan(injectedEvent.seq)
      expect(injectedEvent.seq).toBeLessThan(compactSummary.seq)
      expect(compactSummary.seq).toBeLessThan(compactCheckpoint.seq)
      expect(compactCheckpoint.seq).toBeLessThan(compactEnd.seq)

      const manualTimeline = manualOrder ?? []
      const commandRunIndex = manualTimeline.indexOf('command/run')
      const compactStartIndex = manualTimeline.indexOf('compaction/start')
      const compactEndIndex = manualTimeline.indexOf('compaction/end')
      const firstFlushIndex = manualTimeline.indexOf('flush')
      const queuedTurnIndex = manualTimeline.lastIndexOf('turn/start')
      const commandDoneIndex = manualTimeline.indexOf('command/done')
      expect(manualTimeline.filter(item => item === 'command/run')).toHaveLength(1)
      expect(manualTimeline.filter(item => item === 'command/done')).toHaveLength(1)
      expect(compactStartIndex).toBeGreaterThan(commandRunIndex)
      expect(compactEndIndex).toBeGreaterThan(compactStartIndex)
      expect(firstFlushIndex).toBeGreaterThan(compactEndIndex)
      expect(queuedTurnIndex).toBeGreaterThan(firstFlushIndex)
      expect(commandDoneIndex).toBeGreaterThan(firstFlushIndex)

      const commandRun = events.find(event => event.type === 'command/run'
        && event.data.name === 'compact')
      const commandRunId = commandRun?.type === 'command/run'
        ? commandRun.data.commandId
        : undefined
      const commandDone = events.find(event => event.type === 'command/done'
        && event.data.commandId === commandRunId)
      expect(commandRun?.type === 'command/run' && commandRun.data).toEqual({
        commandId: commandRunId,
        name: 'compact',
        args: '',
        source: { kind: 'user' },
      })
      expect(commandDone?.type === 'command/done' && commandDone.data).toEqual({
        commandId: commandRunId,
        kind: 'success',
        text: 'Compacted 2 history items (~387 tokens).',
      })
      expect(commandRun !== undefined && commandRun.seq < compactStart.seq).toBe(true)
      expect(commandDone !== undefined && commandDone.seq > compactEnd.seq).toBe(true)
      expect(agent.session.surface.nodes).not.toContain(commandRun?.seq)
      expect(agent.session.surface.nodes).not.toContain(commandDone?.seq)

      // The command line itself never becomes a prompt.
      expect(events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text.trim() === '/compact'))).toBe(false)
      const derived = agent.session.deriveMessages().map(message => message.content
        .map(block => block.type === 'text' ? block.text : '')
        .join(''))
      const checkpoint = derived.findIndex(text => text.includes('Keyless manual compaction checkpoint.'))
      const injected = derived.findIndex(text => text.includes('Injected while compaction was running.'))
      const queued = derived.findIndex(text => text === queuedPrompt)
      expect(checkpoint).toBe(0)
      expect(injected).toBeGreaterThan(checkpoint)
      expect(queued).toBeGreaterThan(injected)
      expect(derived).not.toContain('/compact')
      expect(derived).not.toContain('Compacted 2 history items (~387 tokens).')
      expect(derived.filter(text => text.includes('Injected while compaction was running.'))).toHaveLength(1)
      expect(compactSummary.data.shadowedSeqs).not.toContain(injectedEvent.seq)
      const queuedTurn = events.findLast(event => event.type === 'turn/start')
      expect(queuedTurn !== undefined && compactEnd.seq < queuedTurn.seq).toBe(true)
    }
    if (scenario.interaction === 'direct-shell') {
      const direct = events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'user-shell')
      if (direct?.type !== 'user/message') {
        throw new Error(`direct-shell snapshot is missing its durable result context; events=${events.map(event =>
          event.type === 'user/message' ? `${event.type}:${event.data.source.kind}` : event.type).join(',')}; terminal=${interactionSnapshot ?? ''}`)
      }
      const text = direct.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      expect(text).toContain(`$ ${DIRECT_SHELL_SNAPSHOT_COMMAND}`)
      expect(text).toContain('DIRECT_SHELL_STREAM_START')
      expect(text).toContain('DIRECT_SHELL_SNAPSHOT')
      expect(text).toContain(`cwd: ${cwd}`)
      expect(text).toContain('status: exit code 0')
      expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(false)
      expect(events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'tool-jobs')).toHaveLength(0)
      expect(ctx.jobs.list(agent)).toEqual([
        expect.objectContaining({
          id: 'bash-1',
          kind: 'bash',
          label: DIRECT_SHELL_SNAPSHOT_COMMAND,
          status: 'completed',
          reported: true,
        }),
      ])
      for (const name of ['job_output', 'job_list', 'job_kill']) {
        expect(ctx.tools.get(name, agent), `direct-shell scenario must compose ${name}`).toBeDefined()
      }
    }
    if (scenario.interaction === 'mode-cycle') {
      expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active)).toEqual([
        true,
        false,
        true,
        false,
      ])
      expect(events.filter(event => event.type === 'permission/preset').map(event => event.data.preset)).toEqual([
        'workspace-write',
        'read-only',
        'workspace-write',
        'danger-full-access',
        'read-only',
        'workspace-write',
        'danger-full-access',
        'workspace-write',
      ])
    }
    if (scenario.spillMaxInlineBytes !== undefined) {
      // The REAL pipeline ran (tools execute on replay too): the durable
      // dispatch copy is bounded to a preview + locator under the run cwd,
      // while the outer result still carries the program's whole value.
      const dispatch = events.find(event => (event.type as string) === 'tool/code-dispatch')
      const content = (dispatch?.data as { content: { type: string; text?: string }[] }).content
      const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(scenario.spillMaxInlineBytes)
      expect(text).toContain('Full formatted result stored at:')
      expect(text).toContain('.spill')
    }
    expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.content[0].isError)).toBe(true)
    expect(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind !== 'error')).toBe(true)
    if (scenario.name === 'dynamic-workflow' || scenario.name === 'cordis-dynamic-toolchain') {
      expect(workflowEvents).toEqual([
        'workflow/start',
        'workflow/phase',
        'workflow/agent-start',
        'workflow/agent-end',
        'workflow/end',
      ])
    }

    expect(terminal.themeViolations(), `${scenario.name} must stay on the ANSI fallback`).toEqual([])
    const snapshot = interactionSnapshot ?? normalizeTerminalSnapshot(
      await terminal.snapshot({ includeScrollback: true }),
      cwd,
      displayCwd,
    )
    await handle.dispose()
    const children = disposedSessions
      .filter(session => session !== agent.session)
      .sort((a, b) => a.header.createdAt - b.header.createdAt)
    expect(children).toHaveLength(scenario.childSessions ?? 0)
    return { terminal: snapshot, parent: agent.session, children, workflowEvents }
  } finally {
    await controller?.dispose()
    await ctx?.fiber.dispose()
    await terminal.dispose()
    await rm(cwd, { recursive: true, force: true })
    if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
    clock.mockRestore()
  }
}

async function writeRecording(scenario: Scenario, result: ScenarioResult): Promise<void> {
  const dir = scenarioDir(scenario)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'session.jsonl'),
    scrubRequestHeaders(tokenizeSessionFixtureCwd(rawSessionLog(result.parent))),
  )
  expect(result.children).toHaveLength(scenario.childSessions ?? 0)
  for (const [index, child] of result.children.entries()) {
    await writeFile(
      join(dir, `session.${index + 1}.jsonl`),
      scrubRequestHeaders(tokenizeSessionFixtureCwd(rawSessionLog(child))),
    )
  }
}

describe('TUI recorded-session terminal snapshots', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      observedScenarios.add(scenario.name)
      const result = await runScenario(scenario)
      const terminalFile = join(scenarioDir(scenario), 'terminal.expected.txt')
      if (MODE === 'record' || MODE === 'refresh') {
        await mkdir(scenarioDir(scenario), { recursive: true })
        await writeFile(terminalFile, result.terminal)
      }
      if (MODE === 'record' && scenario.recorded) await writeRecording(scenario, result)
      await expect(result.terminal).toMatchFileSnapshot(terminalFile)
    }, 120_000)
  }
})

afterAll(async () => {
  const scenarioNames = SCENARIOS.map(scenario => scenario.name).sort()
  const observedNames = [...observedScenarios].sort()
  if (TEST_NAME_FILTERED) {
    expect(observedNames).not.toHaveLength(0)
    expect(scenarioNames).toEqual(expect.arrayContaining(observedNames))
  } else {
    expect(observedNames).toEqual(scenarioNames)
  }
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (scenario.fixture === undefined) continue
    const sourceIndex = SCENARIOS.findIndex(candidate => candidate.name === scenario.fixture)
    expect(sourceIndex, `${scenario.name} fixture source ${scenario.fixture} must exist`).toBeGreaterThanOrEqual(0)
    expect(sourceIndex, `${scenario.name} fixture source must precede it`).toBeLessThan(index)
    const source = SCENARIOS[sourceIndex]
    expect(source?.fixture, `${scenario.name} fixture source must own its replay files`).toBeUndefined()
    expect(source?.recorded, `${scenario.name} fixture source must be recordable`).toBe(true)
  }
  const directories = (await readdir(SNAPSHOTS_DIR, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  expect(directories).toEqual(SCENARIOS.map(scenario => scenario.name).sort())
  for (const scenario of SCENARIOS) {
    const expected = [
      ...scenario.fixture === undefined ? ['session.jsonl'] : [],
      'terminal.expected.txt',
      ...scenario.seedWorkspace === true && scenario.fixture === undefined ? ['workspace'] : [],
      ...Array.from({ length: scenario.childSessions ?? 0 }, (_, index) => `session.${index + 1}.jsonl`),
    ].sort()
    expect((await readdir(scenarioDir(scenario))).sort()).toEqual(expected)
    for (const fixture of ['session.jsonl', ...childFixturePaths(scenario).map(path => basename(path))]) {
      const content = await readFile(join(fixtureDir(scenario), fixture), 'utf8')
      expect(scrubRequestHeaders(content), `${scenario.name}/${fixture} carries request-header bulk`).toBe(content)
    }
  }
})
