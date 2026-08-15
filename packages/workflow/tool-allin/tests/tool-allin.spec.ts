import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import * as toolAllin from '../src/index.ts'

const testToolSignal = new AbortController().signal

class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  settle!: (result: WorkflowResult) => void
  onStart: (() => void) | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    this.requests.push(request)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    this.onStart?.()
    return {
      id: WorkflowRunId(`allin-${this.requests.length}`),
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({
          value: null,
          stopReason: 'cancelled',
          ...reason === undefined ? {} : { error: reason },
          agentsStarted: 0,
        })
      },
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    }
  }
}

class StubProvider implements SubagentProvider {
  readonly name = 'fresh'
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(options?: { outputSchema?: boolean; inheritsParentContext?: boolean }) {
    this.capabilities = {
      outputSchema: options?.outputSchema ?? true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    this.inheritsParentContext = options?.inheritsParentContext ?? false
  }

  start(_request: SubagentStartRequest): Promise<SubagentRun> {
    return Promise.reject(new Error('StubProvider.start must not be reached behind StubEngine'))
  }
}

interface SetupOptions {
  config?: toolAllin.Config
  provider?: StubProvider | false
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const provider = options?.provider === false ? undefined : options?.provider ?? new StubProvider()
  if (provider !== undefined) ctx.subagents.registerProvider(provider)
  await ctx.plugin(StubEngine)
  const config: toolAllin.Config = { subagentProvider: 'fresh' }
  if (options?.config?.subagentProvider !== undefined) config.subagentProvider = options.config.subagentProvider
  if (options?.config?.orchestratorModel !== undefined) config.orchestratorModel = options.config.orchestratorModel
  if (options?.config?.workerModel !== undefined) config.workerModel = options.config.workerModel
  if (options?.config?.maxTasks !== undefined) config.maxTasks = options.config.maxTasks
  if (options?.config?.maxParallelWorkers !== undefined) config.maxParallelWorkers = options.config.maxParallelWorkers
  if (options?.config?.maxPlanChars !== undefined) config.maxPlanChars = options.config.maxPlanChars
  if (options?.config?.maxReportChars !== undefined) config.maxReportChars = options.config.maxReportChars
  if (options?.config?.maxResultChars !== undefined) config.maxResultChars = options.config.maxResultChars
  const fiber = await ctx.plugin(toolAllin, config)
  const parent = { id: SessionId('caller'), options: {} } as unknown as Agent
  return { ctx, engine: ctx.workflowEngine as StubEngine, parent, fiber }
}

function execute(
  ctx: Context,
  args: unknown,
  extra?: { agent?: Agent; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: extra?.signal ?? testToolSignal,
    callId: CallId('allin-call'),
    name: 'allin',
    arguments: args,
    ...extra?.agent === undefined ? {} : { agent: extra.agent },
  })
}

const PLAN = {
  title: 'Ship billing end to end',
  tasks: [
    { id: 'backend', title: 'Billing backend', prompt: 'Implement the billing backend.', dependencies: [] },
    { id: 'migration', title: 'Database migration', prompt: 'Implement the schema migration.', dependencies: ['backend'] },
  ],
}

const DONE_BACKEND = {
  status: 'done',
  summary: 'The billing backend is implemented.',
  artifacts: ['src/billing/backend.ts'],
  evidence: ['Focused backend tests pass.'],
  handoff: 'API contract: POST /billing/invoices.',
  blocker: '',
}

const DONE_MIGRATION = {
  status: 'done',
  summary: 'The schema migration is implemented and reversible.',
  artifacts: ['migrations/002-billing.sql'],
  evidence: ['Migration up/down cycle passes.'],
  handoff: 'Schema version 2 is the deployed baseline.',
  blocker: '',
}

const BLOCKED = {
  status: 'blocked',
  summary: 'The checkout UI is implemented behind the unavailable payment gateway.',
  artifacts: ['src/checkout/index.ts'],
  evidence: ['Unit tests pass with a fake gateway.'],
  handoff: '',
  blocker: 'Payment-gateway credentials require human authorization.',
}

const COMPLETE = {
  status: 'complete',
  summary: 'Billing backend, schema migration, checkout UI, and tests are complete.',
  deliverables: ['src/billing/backend.ts', 'migrations/002-billing.sql', 'src/checkout/index.ts', 'tests/billing.e2e.ts'],
  remaining: [],
  blocker: '',
}

function completeValue() {
  return {
    status: 'complete',
    plan: PLAN,
    tasks: [
      { id: 'backend', title: 'Billing backend', status: 'done', report: DONE_BACKEND },
      { id: 'migration', title: 'Database migration', status: 'done', report: DONE_MIGRATION },
    ],
    synthesis: COMPLETE,
  }
}

async function settleCompleted(
  engine: StubEngine,
  pending: Promise<ToolExecutionResult>,
  value: unknown,
  agentsStarted = 3,
): Promise<ToolExecutionResult> {
  await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThan(0) })
  engine.settle({ value, stopReason: 'completed', agentsStarted })
  return pending
}

describe('dsh-tool-allin', () => {
  it('starts the fixed pro/flash workflow through the configured fresh provider and renders completion', async () => {
    const { ctx, engine, parent } = await setup({
      config: { maxTasks: 9, maxParallelWorkers: 5, maxPlanChars: 9000, maxReportChars: 9000 },
    })
    const pending = execute(ctx, { goal: '  Ship billing end to end.  ', maxTasks: 4 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    expect(engine.requests[0]).toMatchObject({
      meta: { name: 'allin-run' },
      args: {
        goal: 'Ship billing end to end.',
        maxTasks: 4,
        maxParallelWorkers: 5,
        orchestratorModel: 'deepseek-v4-pro',
        workerModel: 'deepseek-v4-flash',
        maxPlanChars: 9000,
        maxReportChars: 9000,
      },
      subagentProvider: 'fresh',
      maxTotalAgents: 6,
      parent,
    })
    expect(engine.requests[0]!.script).toContain('Parallel task lanes')
    expect(engine.requests[0]!.script).toContain('status: \'synthesis-failed\'')
    const result = await settleCompleted(engine, pending, completeValue())
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected Allin success')
    expect(result.value).toEqual({
      runId: 'allin-1',
      agentsStarted: 3,
      result: {
        status: 'complete',
        plan: PLAN,
        tasks: [
          { id: 'backend', title: 'Billing backend', status: 'done', report: DONE_BACKEND },
          { id: 'migration', title: 'Database migration', status: 'done', report: DONE_MIGRATION },
        ],
        synthesis: COMPLETE,
      },
    })
    expect((result.content[0] as { text: string }).text)
      .toContain('Allin coordinator reported complete for "Ship billing end to end"')
    expect((result.content[0] as { text: string }).text).toContain('API contract: POST /billing/invoices.')
    expect(engine.disposed).toBe(1)
  })

  it('renders blocked and partial terminal outcomes as bounded successful results', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxTasks: 4 } })
    const blocked = execute(ctx, { goal: 'Integrate checkout.' }, { agent: parent })
    const blockedResult = await settleCompleted(engine, blocked, {
      status: 'blocked',
      plan: PLAN,
      tasks: [
        { id: 'backend', title: 'Billing backend', status: 'done', report: DONE_BACKEND },
        { id: 'migration', title: 'Database migration', status: 'blocked', report: BLOCKED },
      ],
      synthesis: {
        status: 'blocked',
        summary: 'Implementation is ready; the gateway cannot be enabled without human authorization.',
        deliverables: ['src/billing/backend.ts', 'src/checkout/index.ts'],
        remaining: ['Enable the payment gateway after authorization.'],
        blocker: 'Payment-gateway credentials require human authorization.',
      },
    }, 3)
    expect((blockedResult.content[0] as { text: string }).text)
      .toContain('Allin coordinator reported blocked for "Ship billing end to end"')

    const partial = execute(ctx, { goal: 'Ship billing.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const partialResult = await settleCompleted(engine, partial, {
      status: 'partial',
      plan: PLAN,
      tasks: [
        { id: 'backend', title: 'Billing backend', status: 'done', report: DONE_BACKEND },
        { id: 'migration', title: 'Database migration', status: 'failed', error: 'the flash lane ended without a structured report' },
      ],
      synthesis: {
        status: 'partial',
        summary: 'Backend delivered; the migration lane failed.',
        deliverables: ['src/billing/backend.ts'],
        remaining: ['Implement migrations/002-billing.sql.'],
        blocker: '',
      },
    }, 3)
    expect((partialResult.content[0] as { text: string }).text)
      .toContain('Allin coordinator reported partial for "Ship billing end to end"')
    expect((partialResult.content[0] as { text: string }).text).toContain('failed')
  })

  it('reports planner and synthesis child failures as errors and disposes the run', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxTasks: 4 } })
    const planPending = execute(ctx, { goal: 'Ship billing.' }, { agent: parent })
    const planResult = await settleCompleted(engine, planPending, { status: 'plan-failed' }, 1)
    expect(planResult.isError).toBe(true)
    if (!planResult.isError) throw new Error('expected plan failure error')
    expect((planResult.content[0] as { text: string }).text)
      .toContain('Allin planner child failed before producing a structured plan.')
    expect(engine.disposed).toBe(1)

    const synthesisPending = execute(ctx, { goal: 'Ship billing.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const synthesisResult = await settleCompleted(engine, synthesisPending, {
      status: 'synthesis-failed',
      plan: PLAN,
      tasks: [
        { id: 'backend', title: 'Billing backend', status: 'done', report: DONE_BACKEND },
        { id: 'migration', title: 'Database migration', status: 'done', report: DONE_MIGRATION },
      ],
    }, 4)
    expect(synthesisResult.isError).toBe(true)
    if (!synthesisResult.isError) throw new Error('expected synthesis failure error')
    expect((synthesisResult.content[0] as { text: string }).text)
      .toContain('Allin synthesis child failed after 2 task lanes settled')
    expect(engine.disposed).toBe(2)
  })

  it('bounds the successful parent result and labels coordinator-reported completion', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxResultChars: 200 } })
    const pending = execute(ctx, { goal: 'Ship billing.' }, { agent: parent })
    const result = await settleCompleted(engine, pending, completeValue())
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toContain('… [truncated]')
  })

  it('rejects an unavailable or non-fresh provider before starting the workflow', async () => {
    const missing = await setup({ provider: false })
    const missingResult = await execute(missing.ctx, { goal: 'Ship billing.' }, { agent: missing.parent })
    expect(missingResult.isError).toBe(true)
    if (!missingResult.isError) throw new Error('expected missing provider error')
    expect((missingResult.content[0] as { text: string }).text).toContain('is not registered')

    const inheriting = await setup({ provider: new StubProvider({ inheritsParentContext: true }) })
    const inheritingResult = await execute(inheriting.ctx, { goal: 'Ship billing.' }, { agent: inheriting.parent })
    expect(inheritingResult.isError).toBe(true)
    if (!inheritingResult.isError) throw new Error('expected inheriting provider error')
    expect((inheritingResult.content[0] as { text: string }).text).toContain('inherits parent context')
  })

  it('validates direct config application without Loader normalization', () => {
    const ctx = new Context()
    expect(() => { toolAllin.apply(ctx, { subagentProvider: '  ' }) }).toThrow(/subagentProvider/)
    expect(() => { toolAllin.apply(ctx, { maxTasks: 0 }) }).toThrow(/maxTasks/)
    expect(() => { toolAllin.apply(ctx, { maxTasks: 65 }) }).toThrow(/maxTasks/)
  })
})
