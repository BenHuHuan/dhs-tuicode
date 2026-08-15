/**
 * Model-facing fixed multi-agent orchestration over the workflow and subagent
 * seams. One pro planner compiles a concrete goal into independent top-level
 * tasks; parallel flash lanes execute every dependency-ready task in waves; a
 * pro synthesis merges their typed reports back into one bounded parent result.
 * @module @deepseek-ai/dsh-tool-allin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'
// Declaration merge only: makes ctx.systemPrompt visible for section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-allin'
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt']

/** Deployment policy for the fixed All in Luna-style workflow. */
export interface Config {
  /** Fresh structured-output provider used for every child (default `spawn`). */
  subagentProvider?: string
  /** Pro coordinator model for plan and synthesis (default `deepseek-v4-pro`). */
  orchestratorModel?: string
  /** Flash worker model for parallel task lanes (default `deepseek-v4-flash`). */
  workerModel?: string
  /** Default and deployment ceiling for one call's task count (default 8). */
  maxTasks?: number
  /** Default and deployment ceiling for one dependency wave's parallel lanes (default 8). */
  maxParallelWorkers?: number
  /** Maximum serialized characters in one planner result (default 16384). */
  maxPlanChars?: number
  /** Maximum serialized characters in one lane report (default 16384). */
  maxReportChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 50000). */
  maxResultChars?: number
}

/** Schemastery configuration for the allin tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  orchestratorModel: z.string().default('deepseek-v4-pro'),
  workerModel: z.string().default('deepseek-v4-flash'),
  maxTasks: z.number().step(1).min(1).max(64).default(8),
  maxParallelWorkers: z.number().step(1).min(1).max(64).default(8),
  maxPlanChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxReportChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(50_000),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly orchestratorModel: string
  readonly workerModel: string
  readonly maxTasks: number
  readonly maxParallelWorkers: number
  readonly maxPlanChars: number
  readonly maxReportChars: number
  readonly maxResultChars: number
}

interface TaskPlan {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly dependencies: string[]
}

interface AllinPlan {
  readonly title: string
  readonly tasks: TaskPlan[]
}

type TaskReportStatus = 'done' | 'blocked'

interface TaskReport {
  readonly status: TaskReportStatus
  readonly summary: string
  readonly artifacts: string[]
  readonly evidence: string[]
  readonly handoff: string
  readonly blocker: string
}

type SynthesisStatus = 'complete' | 'blocked' | 'partial'

interface Synthesis {
  readonly status: SynthesisStatus
  readonly summary: string
  readonly deliverables: string[]
  readonly remaining: string[]
  readonly blocker: string
}

type TaskOutcomeStatus = 'done' | 'blocked' | 'failed'

interface TaskOutcome {
  readonly id: string
  readonly title: string
  readonly status: TaskOutcomeStatus
  readonly report?: TaskReport
  readonly error?: string
}

type AllinRunStatus = 'complete' | 'blocked' | 'partial'

interface AllinRunResult {
  readonly status: AllinRunStatus
  readonly plan: AllinPlan
  readonly tasks: TaskOutcome[]
  readonly synthesis: Synthesis
}

interface AllinCallArgs {
  goal: string
  maxTasks?: number
}

const ALLIN_META = {
  name: 'allin-run',
  description: 'Compile one goal into top-level tasks, run ready lanes in parallel flash waves, and synthesize their reports.',
  phases: [
    { title: 'Plan', detail: 'The pro coordinator compiles the goal into top-level tasks.' },
    { title: 'Parallel task lanes', detail: 'Flash workers execute dependency-ready tasks in waves.' },
    { title: 'Synthesis', detail: 'The pro coordinator merges lane outcomes into one report.' },
  ],
}

/**
 * Fixed, deployment-owned orchestration. The model supplies only the goal and
 * an optional task cap; it cannot alter the loop, provider route, models,
 * schemas, dependency scheduler, or result validation.
 */
const ALLIN_SCRIPT = String.raw`
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'prompt', 'dependencies'],
      },
    },
  },
  required: ['title', 'tasks'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'artifacts', 'evidence', 'handoff', 'blocker'],
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['complete', 'blocked', 'partial'] },
    summary: { type: 'string' },
    deliverables: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'deliverables', 'remaining', 'blocker'],
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function ensureRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Allin ' + label + ' is not a JSON object')
  }
  return value
}

function planTask(entry) {
  const task = ensureRecord(entry, 'task')
  if (!normalizedText(task.id) || !normalizedText(task.title) || !normalizedText(task.prompt)) {
    throw new Error('every Allin task needs a normalized id, title, and prompt')
  }
  if (!Array.isArray(task.dependencies) || !task.dependencies.every(normalizedText)) {
    throw new Error('every Allin task dependencies entry must be a normalized id string')
  }
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    dependencies: [...task.dependencies],
  }
}

function validatePlan(rawPlan) {
  const value = ensureRecord(rawPlan, 'plan')
  if (!normalizedText(value.title)) {
    throw new Error('Allin plan title must be a non-empty normalized string')
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > args.maxTasks) {
    throw new Error('Allin plan must contain between 1 and ' + args.maxTasks + ' tasks')
  }
  const tasks = value.tasks.map(planTask)
  const ids = new Set()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error('Allin task id ' + JSON.stringify(task.id) + ' appears more than once')
    ids.add(task.id)
  }
  for (const task of tasks) {
    if (task.dependencies.includes(task.id)) {
      throw new Error('Allin task ' + JSON.stringify(task.id) + ' depends on itself')
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error('Allin task ' + JSON.stringify(task.id) + ' depends on unknown task ' + JSON.stringify(dependency))
      }
    }
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(task) {
    if (visited.has(task.id)) return
    if (visiting.has(task.id)) throw new Error('Allin task dependencies contain a cycle at ' + JSON.stringify(task.id))
    visiting.add(task.id)
    for (const dependency of task.dependencies) {
      const target = tasks.find((candidate) => candidate.id === dependency)
      visit(target)
    }
    visiting.delete(task.id)
    visited.add(task.id)
  }
  for (const task of tasks) visit(task)
  if (!tasks.some((task) => task.dependencies.length === 0)) {
    throw new Error('Allin plan needs at least one dependency-free task')
  }
  const plan = { title: value.title, tasks }
  const serialized = JSON.stringify(plan)
  if (serialized.length > args.maxPlanChars) {
    throw new Error('Allin plan exceeds maxPlanChars (' + serialized.length + ' > ' + args.maxPlanChars + ')')
  }
  return plan
}

function validateReport(rawReport) {
  const value = ensureRecord(rawReport, 'task report')
  if (value.status !== 'done' && value.status !== 'blocked') {
    throw new Error('Allin task report status must be done or blocked')
  }
  if (!normalizedText(value.summary)) {
    throw new Error('Allin task report summary must be a non-empty normalized string')
  }
  if (!normalizedList(value.artifacts) || !normalizedList(value.evidence)) {
    throw new Error('Allin task report artifacts and evidence must contain only non-empty normalized strings')
  }
  if (typeof value.handoff !== 'string' || value.handoff !== value.handoff.trim()) {
    throw new Error('Allin task report handoff must be a normalized string')
  }
  if (typeof value.blocker !== 'string' || value.blocker !== value.blocker.trim()) {
    throw new Error('Allin task report blocker must be a normalized string')
  }
  if (value.status === 'done' && (value.evidence.length === 0 || value.handoff.length === 0 || value.blocker !== '')) {
    throw new Error('a done Allin task report needs evidence, a non-empty handoff, and an empty blocker')
  }
  if (value.status === 'blocked' && !normalizedText(value.blocker)) {
    throw new Error('a blocked Allin task report needs a concrete blocker')
  }
  const report = {
    status: value.status,
    summary: value.summary,
    artifacts: value.artifacts,
    evidence: value.evidence,
    handoff: value.handoff,
    blocker: value.blocker,
  }
  const serialized = JSON.stringify(report)
  if (serialized.length > args.maxReportChars) {
    throw new Error('Allin task report exceeds maxReportChars (' + serialized.length + ' > ' + args.maxReportChars + ')')
  }
  return report
}

function validateSynthesis(rawSynthesis) {
  const value = ensureRecord(rawSynthesis, 'synthesis')
  if (value.status !== 'complete' && value.status !== 'blocked' && value.status !== 'partial') {
    throw new Error('Allin synthesis status must be complete, blocked, or partial')
  }
  if (!normalizedText(value.summary)) {
    throw new Error('Allin synthesis summary must be a non-empty normalized string')
  }
  if (!normalizedList(value.deliverables) || !normalizedList(value.remaining)) {
    throw new Error('Allin synthesis deliverables and remaining must contain only non-empty normalized strings')
  }
  if (typeof value.blocker !== 'string' || value.blocker !== value.blocker.trim()) {
    throw new Error('Allin synthesis blocker must be a normalized string')
  }
  if (value.status === 'complete' && (value.remaining.length !== 0 || value.blocker !== '')) {
    throw new Error('a complete Allin synthesis needs no remaining work and an empty blocker')
  }
  if (value.status === 'blocked' && !normalizedText(value.blocker)) {
    throw new Error('a blocked Allin synthesis needs a concrete blocker')
  }
  if (value.status === 'partial' && (value.remaining.length === 0 || value.blocker !== '')) {
    throw new Error('a partial Allin synthesis needs remaining work and an empty blocker')
  }
  return {
    status: value.status,
    summary: value.summary,
    deliverables: value.deliverables,
    remaining: value.remaining,
    blocker: value.blocker,
  }
}

function reportLines(id, report, indent) {
  const pad = indent.repeat(2)
  const lines = [pad + 'summary: ' + report.summary]
  if (report.artifacts.length > 0) lines.push(pad + 'artifacts: ' + report.artifacts.join('; '))
  if (report.evidence.length > 0) lines.push(pad + 'evidence: ' + report.evidence.join('; '))
  if (report.handoff !== '') lines.push(pad + 'handoff: ' + report.handoff)
  if (report.blocker !== '') lines.push(pad + 'blocker: ' + report.blocker)
  return lines
}

phase('Plan')
const plannerPrompt = [
  'You are the pro coordinator of one Allin run. You receive no parent conversation. Do not call the allin tool: this run already is its orchestrator.',
  'Compile the concrete goal below into independent top-level tasks that can run in one shared workspace. Each task owns one work domain with a bounded goal, explicit dependencies, and a result boundary. Prefer the smallest task set that still separates unrelated work.',
  'Rules for the plan: 1 to ' + args.maxTasks + ' tasks; unique normalized ids; dependencies reference existing task ids; no self-dependencies and no cycles; at least one task must be dependency-free; a task prompt must contain everything a fresh flash worker needs to do the task and verify it.',
  'Goal:\n' + args.goal,
].join('\n\n')
const rawPlan = await agent(plannerPrompt, {
  label: 'Allin planner',
  phase: 'Plan',
  schema: PLAN_SCHEMA,
  model: args.orchestratorModel,
})
if (rawPlan === null) {
  return { status: 'plan-failed' }
}
const plan = validatePlan(rawPlan)

phase('Parallel task lanes')
const terminal = new Set()
const reports = new Map()
const failures = new Map()
let wave = 0
while (terminal.size < plan.tasks.length) {
  const pending = plan.tasks.filter((task) => !terminal.has(task.id))
  const ready = pending.filter((task) => task.dependencies.every((dependency) => terminal.has(dependency) && !failures.has(dependency)))
  if (ready.length === 0) {
    for (const task of pending) {
      failures.set(task.id, 'a dependency did not complete')
      terminal.add(task.id)
    }
    break
  }
  wave += 1
  const batch = ready.slice(0, args.maxParallelWorkers)
  log('Wave ' + wave + ': starting ' + batch.length + ' of ' + pending.length + ' pending task lane(s).')
  const outcomes = await parallel(batch.map((task) => async () => {
    const dependencies = task.dependencies.map((id) => {
      const report = reports.get(id)
      return 'Task ' + id + ': ' + report.summary + (report.handoff === '' ? '' : ' Handoff: ' + report.handoff)
    })
    const prompt = [
      'You are one fresh flash worker lane in an Allin run. You receive no parent conversation and no prior child session. Do not call the allin tool: this lane already is its worker.',
      'Shared goal:\n' + args.goal,
      'Your top-level task (' + task.id + '): ' + task.title + '\n' + task.prompt,
      'The shared workspace and its current working tree are the authority and long-term memory. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Dependency lanes completed before you; their reports are bounded handoffs, so confirm them against the workspace.',
      dependencies.length === 0 ? 'No dependency lanes; start from the current workspace state.' : 'Completed dependency lanes:\n' + dependencies.join('\n'),
      'Return one report with exact normalized strings. Use status done only with concrete evidence, at least one artifact path, a non-empty handoff for the next coordinator, and an empty blocker. Use status blocked only when this lane cannot make meaningful progress without human input or an external-state change; name that concrete blocker.',
    ].join('\n\n')
    const rawReport = await agent(prompt, {
      label: 'Allin task ' + task.id,
      phase: 'Parallel task lanes',
      schema: REPORT_SCHEMA,
      model: args.workerModel,
    })
    if (rawReport === null) {
      return { taskId: task.id, error: 'the flash lane ended without a structured report' }
    }
    try {
      return { taskId: task.id, report: validateReport(rawReport) }
    } catch (error) {
      return { taskId: task.id, error: String(error && error.message ? error.message : error) }
    }
  }))
  for (const outcome of outcomes) {
    if (outcome === null || typeof outcome !== 'object') {
      const task = plan.tasks.find((candidate) => candidate.id === outcome && typeof outcome === 'string')
      if (task !== undefined) failures.set(task.id, 'the lane produced no outcome')
      continue
    }
    const lane = outcome
    if (lane.report !== undefined) {
      reports.set(lane.taskId, lane.report)
    } else {
      failures.set(lane.taskId, typeof lane.error === 'string' && lane.error !== '' ? lane.error : 'the lane produced no structured report')
    }
    terminal.add(lane.taskId)
  }
}

const taskOutcomes = plan.tasks.map((task) => {
  if (reports.has(task.id)) {
    return { id: task.id, title: task.title, status: reports.get(task.id).status, report: reports.get(task.id) }
  }
  return { id: task.id, title: task.title, status: 'failed', error: failures.get(task.id) ?? 'the lane produced no structured report' }
})

const blockedCount = taskOutcomes.filter((task) => task.status === 'blocked').length
const failedCount = taskOutcomes.filter((task) => task.status === 'failed').length
const doneCount = taskOutcomes.filter((task) => task.status === 'done').length

phase('Synthesis')
const synthesisPrompt = [
  'You are the pro coordinator closing one Allin run. You receive no parent conversation.',
  'Shared goal:\n' + args.goal,
  'Plan title: ' + plan.title,
  'Task lane outcomes (' + doneCount + ' done, ' + blockedCount + ' blocked, ' + failedCount + ' failed):\n'
    + taskOutcomes.map((task) => {
      if (task.status === 'failed') return '- [' + task.id + '] ' + task.title + ' FAILED: ' + task.error
      const report = task.report
      return '- [' + task.id + '] ' + task.title + ' (' + task.status + '): ' + report.summary
        + (report.artifacts.length === 0 ? '' : ' Artifacts: ' + report.artifacts.join('; '))
        + (report.handoff === '' ? '' : ' Handoff: ' + report.handoff)
        + (report.blocker === '' ? '' : ' Blocker: ' + report.blocker)
    }).join('\n'),
  'Inspect the workspace to verify lane claims before synthesizing. Report status complete only when every lane is done and the shared goal is actually complete; blocked when at least one concrete blocker requires human input or an external-state change and no more in-scope work can progress; partial otherwise, with remaining as the exact next work items. Deliverables and remaining must be concrete file, artifact, or work items, never vague praise. blocker must be empty unless blocked.',
].join('\n\n')
const rawSynthesis = await agent(synthesisPrompt, {
  label: 'Allin synthesis',
  phase: 'Synthesis',
  schema: SYNTHESIS_SCHEMA,
  model: args.orchestratorModel,
})
if (rawSynthesis === null) {
  return { status: 'synthesis-failed', plan, tasks: taskOutcomes }
}
const synthesis = validateSynthesis(rawSynthesis)
let status
if (doneCount === plan.tasks.length && synthesis.status === 'complete') {
  status = 'complete'
} else if (synthesis.status === 'blocked' || blockedCount > 0) {
  status = 'blocked'
} else {
  status = 'partial'
}
return { status, plan, tasks: taskOutcomes, synthesis }
`

const DESCRIPTION = 'Compile one large concrete goal into independent top-level tasks, run every dependency-ready task in parallel flash lanes, and return a pro-coordinator synthesis. '
  + 'Use only for an explicit allinluna-style multi-agent request or one big goal that spans independent work areas, not routine single-turn work. '
  + 'Plan and synthesis use the pro model; task lanes use flash and run several lanes at once. The call waits for the whole run.'

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const orchestratorModel = config.orchestratorModel ?? 'deepseek-v4-pro'
  const workerModel = config.workerModel ?? 'deepseek-v4-flash'
  const maxTasks = config.maxTasks ?? 8
  const maxParallelWorkers = config.maxParallelWorkers ?? 8
  const maxPlanChars = config.maxPlanChars ?? 16_384
  const maxReportChars = config.maxReportChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 50_000
  for (const [field, value] of [
    ['subagentProvider', subagentProvider],
    ['orchestratorModel', orchestratorModel],
    ['workerModel', workerModel],
  ] as const) {
    if (value.length === 0 || value !== value.trim()) {
      throw new TypeError(`${field} must be a non-empty normalized string`)
    }
  }
  for (const [field, value, ceiling] of [
    ['maxTasks', maxTasks, 64],
    ['maxParallelWorkers', maxParallelWorkers, 64],
    ['maxPlanChars', maxPlanChars, Number.MAX_SAFE_INTEGER],
    ['maxReportChars', maxReportChars, Number.MAX_SAFE_INTEGER],
    ['maxResultChars', maxResultChars, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new TypeError(`${field} must be a positive safe integer no greater than ${ceiling}`)
    }
  }
  return {
    subagentProvider,
    orchestratorModel,
    workerModel,
    maxTasks,
    maxParallelWorkers,
    maxPlanChars,
    maxReportChars,
    maxResultChars,
  }
}

/** Resolve one model-selected task cap against the deployment ceiling. */
function resolveMaxTasks(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Allin maxTasks must be a positive safe integer')
  }
  if (value > ceiling) {
    throw new TypeError(`Allin maxTasks ${value} exceeds the deployment ceiling ${ceiling}`)
  }
  return value
}

/** Require the configured route to mean a genuinely fresh structured child. */
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(name)
  if (provider === undefined) {
    throw new Error(`Allin subagent provider "${name}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`Allin subagent provider "${name}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`Allin subagent provider "${name}" inherits parent context; Allin requires a fresh provider`)
  }
  return provider
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

function sameKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}

/** Defensively decode the fixed script's plan across a provider boundary. */
function readPlan(value: unknown, maxTasks: number, maxPlanChars: number): AllinPlan {
  if (!isRecord(value) || !sameKeys(value, 'tasks,title') || !normalizedText(value['title'])) {
    throw new Error('Allin workflow returned a malformed plan')
  }
  const rawTasks = value['tasks']
  if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > maxTasks) {
    throw new Error('Allin workflow returned a malformed task list')
  }
  const tasks: TaskPlan[] = rawTasks.map((entry: unknown) => {
    if (!isRecord(entry)
      || !sameKeys(entry, 'dependencies,id,prompt,title')
      || !normalizedText(entry['id'])
      || !normalizedText(entry['title'])
      || !normalizedText(entry['prompt'])
      || !Array.isArray(entry['dependencies'])
      || !entry['dependencies'].every(normalizedText)) {
      throw new Error('Allin workflow returned a malformed task entry')
    }
    return {
      id: entry['id'],
      title: entry['title'],
      prompt: entry['prompt'],
      dependencies: entry['dependencies'],
    }
  })
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error('Allin workflow returned duplicate task ids')
    ids.add(task.id)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error('Allin workflow returned a dependency cycle')
    visiting.add(id)
    const task = byId.get(id)
    if (task === undefined) throw new Error('Allin workflow returned an unknown task dependency')
    for (const dependency of task.dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
  if (!tasks.some(task => task.dependencies.length === 0)) {
    throw new Error('Allin workflow returned a plan without a dependency-free task')
  }
  const plan: AllinPlan = { title: value['title'], tasks }
  if (JSON.stringify(plan).length > maxPlanChars) {
    throw new Error('Allin workflow returned an oversized plan')
  }
  return plan
}

/** Defensively decode the fixed script's lane report across a provider boundary. */
function readTaskReport(value: unknown, maxReportChars: number): TaskReport {
  if (!isRecord(value)
    || !sameKeys(value, 'artifacts,blocker,evidence,handoff,status,summary')
    || (value['status'] !== 'done' && value['status'] !== 'blocked')
    || !normalizedText(value['summary'])
    || !normalizedList(value['artifacts'])
    || !normalizedList(value['evidence'])
    || typeof value['handoff'] !== 'string'
    || value['handoff'] !== value['handoff'].trim()
    || typeof value['blocker'] !== 'string'
    || value['blocker'] !== value['blocker'].trim()) {
    throw new Error('Allin workflow returned a malformed lane report')
  }
  const report: TaskReport = {
    status: value['status'],
    summary: value['summary'],
    artifacts: value['artifacts'],
    evidence: value['evidence'],
    handoff: value['handoff'],
    blocker: value['blocker'],
  }
  if (report.status === 'done'
    && (report.evidence.length === 0 || report.handoff.length === 0 || report.blocker !== '')) {
    throw new Error('Allin workflow returned an invalid done lane report')
  }
  if (report.status === 'blocked' && !normalizedText(report.blocker)) {
    throw new Error('Allin workflow returned an invalid blocked lane report')
  }
  if (JSON.stringify(report).length > maxReportChars) {
    throw new Error('Allin workflow returned an oversized lane report')
  }
  return report
}

/** Defensively decode the fixed script's synthesis. */
function readSynthesis(value: unknown): Synthesis {
  if (!isRecord(value)
    || !sameKeys(value, 'blocker,deliverables,remaining,status,summary')
    || (value['status'] !== 'complete' && value['status'] !== 'blocked' && value['status'] !== 'partial')
    || !normalizedText(value['summary'])
    || !normalizedList(value['deliverables'])
    || !normalizedList(value['remaining'])
    || typeof value['blocker'] !== 'string'
    || value['blocker'] !== value['blocker'].trim()) {
    throw new Error('Allin workflow returned a malformed synthesis')
  }
  const synthesis: Synthesis = {
    status: value['status'],
    summary: value['summary'],
    deliverables: value['deliverables'],
    remaining: value['remaining'],
    blocker: value['blocker'],
  }
  if (synthesis.status === 'complete' && (synthesis.remaining.length !== 0 || synthesis.blocker !== '')) {
    throw new Error('Allin workflow returned an invalid complete synthesis')
  }
  if (synthesis.status === 'blocked' && !normalizedText(synthesis.blocker)) {
    throw new Error('Allin workflow returned an invalid blocked synthesis')
  }
  if (synthesis.status === 'partial' && (synthesis.remaining.length === 0 || synthesis.blocker !== '')) {
    throw new Error('Allin workflow returned an invalid partial synthesis')
  }
  return synthesis
}

/** Defensively decode the fixed script's lane outcomes. */
function readTaskOutcomes(value: unknown, maxReportChars: number): TaskOutcome[] {
  if (!Array.isArray(value)) throw new Error('Allin workflow returned malformed lane outcomes')
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || !normalizedText(entry['id']) || !normalizedText(entry['title'])) {
      throw new Error('Allin workflow returned a malformed lane outcome')
    }
    const status = entry['status']
    if (status !== 'done' && status !== 'blocked' && status !== 'failed') {
      throw new Error('Allin workflow returned an unknown lane status')
    }
    if (status === 'failed') {
      if (!sameKeys(entry, 'error,id,status,title') || !normalizedText(entry['error'])) {
        throw new Error('Allin workflow returned a malformed failed lane outcome')
      }
      return { id: entry['id'], title: entry['title'], status, error: entry['error'] }
    }
    if (!sameKeys(entry, 'id,report,status,title') || !isRecord(entry['report'])) {
      throw new Error('Allin workflow returned a malformed lane outcome')
    }
    const report = readTaskReport(entry['report'], maxReportChars)
    if (report.status !== status) {
      throw new Error('Allin workflow returned a lane status that disagrees with its report')
    }
    return { id: entry['id'], title: entry['title'], status, report }
  })
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(
  value: unknown,
  maxTasks: number,
  maxPlanChars: number,
  maxReportChars: number,
): AllinRunResult {
  if (!isRecord(value) || !sameKeys(value, 'plan,status,synthesis,tasks')) {
    throw new Error('Allin workflow returned a malformed terminal result')
  }
  const status = value['status']
  if (status !== 'complete' && status !== 'blocked' && status !== 'partial') {
    throw new Error('Allin workflow returned an unknown terminal status')
  }
  const plan = readPlan(value['plan'], maxTasks, maxPlanChars)
  const tasks = readTaskOutcomes(value['tasks'], maxReportChars)
  const synthesis = readSynthesis(value['synthesis'])
  if (tasks.length !== plan.tasks.length) {
    throw new Error('Allin workflow returned lane outcomes that do not match its plan')
  }
  const taskIds = new Set(tasks.map(task => task.id))
  if (plan.tasks.some(task => !taskIds.has(task.id))) {
    throw new Error('Allin workflow returned lane outcomes that do not match its plan')
  }
  const done = tasks.filter(task => task.status === 'done').length
  const blocked = tasks.filter(task => task.status === 'blocked').length
  if (status === 'complete' && (done !== tasks.length || synthesis.status !== 'complete')) {
    throw new Error('Allin workflow returned an invalid complete result')
  }
  if (status === 'blocked' && blocked === 0 && synthesis.status !== 'blocked') {
    throw new Error('Allin workflow returned an invalid blocked result')
  }
  if (status === 'partial' && synthesis.status !== 'partial') {
    throw new Error('Allin workflow returned an invalid partial result')
  }
  return { status, plan, tasks, synthesis }
}

/** A non-clean workflow finish is an error, never a partial Allin success. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `Allin workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `Allin workflow failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- WorkflowStopReason is closed; a future variant must fail loud here. */
    default:
      return `Allin workflow ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

/** Bound complete parent-facing text, including its envelope and truncation marker. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** Render the fixed terminal envelope without presenting self-report as certification. */
function renderRunResult(result: AllinRunResult, maxChars: number): string {
  const lanes = `${result.tasks.length} task lane${result.tasks.length === 1 ? '' : 's'}`
  const done = result.tasks.filter(task => task.status === 'done').length
  const blocked = result.tasks.filter(task => task.status === 'blocked').length
  const failed = result.tasks.filter(task => task.status === 'failed').length
  const lines = [
    `Allin coordinator reported ${result.status} for "${result.plan.title}" (${lanes}: ${done} done, ${blocked} blocked, ${failed} failed).`,
    '',
    'Task lanes:',
    ...result.tasks.map((task) => {
      if (task.status === 'failed') return `- [${task.status}] ${task.id} — ${task.title}\n  error: ${task.error ?? ''}`
      const report = task.report as TaskReport
      return [
        `- [${task.status}] ${task.id} — ${task.title}`,
        `  summary: ${report.summary}`,
        ...report.artifacts.length === 0 ? [] : [`  artifacts: ${report.artifacts.join('; ')}`],
        ...report.evidence.length === 0 ? [] : [`  evidence: ${report.evidence.join('; ')}`],
        ...report.handoff === '' ? [] : [`  handoff: ${report.handoff}`],
        ...report.blocker === '' ? [] : [`  blocker: ${report.blocker}`],
      ].join('\n')
    }),
    '',
    `Synthesis (${result.synthesis.status}): ${result.synthesis.summary}`,
    ...result.synthesis.deliverables.length === 0 ? [] : ['Deliverables:', ...result.synthesis.deliverables.map(item => `- ${item}`)],
    ...result.synthesis.remaining.length === 0 ? [] : ['Remaining:', ...result.synthesis.remaining.map(item => `- ${item}`)],
    ...result.synthesis.blocker === '' ? [] : [`Blocker: ${result.synthesis.blocker}`],
  ]
  return boundResult(lines.join('\n'), maxChars)
}

/** Render the planner failure as an ordinary tool error. */
function renderPlanFailure(maxChars: number): string {
  return boundResult('Allin planner child failed before producing a structured plan.', maxChars)
}

/** Render the synthesis failure as an ordinary tool error. */
function renderSynthesisFailure(maxChars: number, lanes: number): string {
  return boundResult(
    `Allin synthesis child failed after ${lanes} task lane${lanes === 1 ? '' : 's'} settled; the lanes ran, but the coordinator produced no merged report.`,
    maxChars,
  )
}

/** Canonical Allin result fields shared by schema inference and rendering. */
const ALLIN_OUTPUT_PROPERTIES = {
  runId: { type: 'string', required: true },
  agentsStarted: { type: 'integer', required: true },
  result: { type: 'json', required: true },
} as const

function presentCall(args: AllinCallArgs): ToolCallView {
  return { card: 'generic', title: 'allin', rawInput: args.goal }
}

function presentResult(args: AllinCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Register the fixed Allin tool and its explicit-ask usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:allin',
    order: 117,
    text: 'Use the allin tool ONLY when the direct human explicitly asks for allinluna-style multi-agent execution or hands you one large goal that decomposes into independent top-level work areas. The tool runs a deployment-fixed pro planner, parallel flash task lanes in dependency waves, and a pro synthesis; completion is coordinator-reported, not independent certification. Prefer plain subagents or the workflow tool for bounded fan-out, and same-session goal tools for ordinary long-running objectives.',
  })
  ctx.tools.register(defineTool({
    name: 'allin',
    description: DESCRIPTION,
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'The one concrete completion goal the pro planner compiles into top-level tasks.',
      },
      maxTasks: {
        type: 'number',
        description: 'Optional positive safe-integer task cap, bounded by the deployment ceiling.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: ALLIN_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRunResult(value.result as unknown as AllinRunResult, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('Allin tool requires a calling agent (exec.agent was undefined)')
      }
      const goal = args.goal.trim()
      if (goal.length === 0) throw new Error('Allin goal must be a non-empty string')
      const maxTasks = resolveMaxTasks(args.maxTasks, resolved.maxTasks)
      void requireFreshProvider(ctx, resolved.subagentProvider)

      const run: WorkflowRun = ctx.workflowEngine.start({
        script: ALLIN_SCRIPT,
        meta: ALLIN_META,
        args: {
          goal,
          maxTasks,
          maxParallelWorkers: resolved.maxParallelWorkers,
          orchestratorModel: resolved.orchestratorModel,
          workerModel: resolved.workerModel,
          maxPlanChars: resolved.maxPlanChars,
          maxReportChars: resolved.maxReportChars,
        },
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: maxTasks + 2,
        parent,
        signal: exec.signal,
      })
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) run.cancel('parent step aborted')

      try {
        const settled = await run.result
        const error = stopReasonError(settled)
        if (error !== undefined) throw new Error(error)
        const value = settled.value
        if (isRecord(value) && value['status'] === 'plan-failed') {
          throw new Error(renderPlanFailure(resolved.maxResultChars))
        }
        if (isRecord(value) && value['status'] === 'synthesis-failed') {
          const lanes = Array.isArray(value['tasks']) ? value['tasks'].length : 0
          throw new Error(renderSynthesisFailure(resolved.maxResultChars, lanes))
        }
        const result = readRunResult(value, maxTasks, resolved.maxPlanChars, resolved.maxReportChars)
        return {
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: result as unknown as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await run.dispose()
      }
    },
    presentCall,
    presentResult,
  }))
}
