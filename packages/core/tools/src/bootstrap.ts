/**
 * Two-phase tool-catalog bootstrap for DeepSeek coding agents.
 *
 * The first model request receives the Minimal prompt and the official
 * Minimal tool pair (`bash` + `str_replace_editor`). Once the session contains
 * its first durable tool call or assistant message, every later request
 * receives the complete catalog. The phase is derived from the log so resume
 * and reload cannot reset it.
 * @module @deepseek-ai/dsh-tools/bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Minimal's complete system prompt, kept byte-stable for trajectory anchoring. */
export const MINIMAL_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/** Durable session marker used by the built-in Router Standard compatibility port. */
export const ROUTING_SUITE_PRESET = 'routing-suite'

/** The only two user-facing tool-routing profiles. */
export type ToolRoutingProfile = 'anchored' | 'suite'

/** Router Standard's stable internal regions; mixed is intentionally excluded. */
export type RouterTaskMode = 'spec' | 'react' | 'weak'

// Compatibility port of dsh-router-standard@d4655d5. The original injector's
// hot-plugin lifecycle is deliberately not embedded: the Harness session
// header and prompt waterfalls already provide the required stable boundary.
const REACT_TASK = new RegExp([
  '开发', '创建', '写一个', '生成', '从零', '做一个', '游戏', '网页', '网站', '构建',
  '新项目', '搭建', '实现', '做出', '上线', '落地', '脚本', '工具', '应用',
  'build', 'create', 'develop', 'generate', 'implement', 'make a', 'new project',
].join('|'), 'giu')
const SPEC_TASK = new RegExp([
  '修复', '修一下', '调试', '重构', '维护', '排查', '报错', '出错', '崩溃', '优化',
  '审查', 'review', 'fix', 'debug', 'refactor', 'maintain', 'repair', 'broken', 'break',
  '为什么', '异常', '故障', '迁移', '升级', '兼容',
].join('|'), 'giu')
const RESEARCH_TASK = /\u641c\u7d22|\u67e5\u627e|\u8c03\u67e5|\u7814\u7a76|search|investigate|research|inspect/iu

const ROUTER_FIRST_TOOLS: Record<RouterTaskMode, readonly string[]> = {
  spec: ['bash', 'read', 'edit', 'glob', 'grep'],
  react: ['bash', 'read', 'write', 'edit'],
  weak: ['bash', 'read', 'write', 'edit'],
}

/**
 * Classify one task exactly like Router Standard, without its unstable mixed region.
 * @param text - First user task text to route.
 * @returns The stable Router task class used to select the initial tool surface.
 */
export function classifyRouterTask(text: string): RouterTaskMode {
  if (RESEARCH_TASK.test(text)) return 'spec'
  const react = text.match(REACT_TASK)?.length ?? 0
  const spec = text.match(SPEC_TASK)?.length ?? 0
  if (react > spec) return 'react'
  if (spec > react) return 'spec'
  return 'weak'
}

function textOfMessage(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function firstTaskText(agent: { session?: { events: readonly unknown[] } } | undefined): string {
  const events = agent?.session?.events ?? []
  for (const candidate of events) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const event = candidate as { type?: unknown; data?: unknown }
    if (event.type === 'tui/input' && typeof (event.data as { text?: unknown } | undefined)?.text === 'string') {
      return (event.data as { text: string }).text
    }
    if (event.type === 'user/message') {
      const data = event.data as Partial<UserMessage> | undefined
      if (data?.role === 'user' && Array.isArray(data.content)) return textOfMessage(data as UserMessage)
    }
  }
  return ''
}

/** Cordis plugin name. */
export const name = 'anchored-tool-bootstrap'

/** Register before instruction/skill injectors so bootstrap can strip them last. */
export const inject: string[] = []

const DEFAULT_SUPPRESSED_CONTEXT_SOURCES = ['agent-instructions', 'skill-catalog']
const PROMOTE_EVENTS = {
  'tool-call': new Set<string>(['tool/call']),
  'assistant-message': new Set<string>(['assistant/message']),
  either: new Set<string>(['tool/call', 'assistant/message']),
} as const

/** Two-phase bootstrap configuration. */
export interface Config {
  /** Exact tool names exposed on the first request. */
  bootstrapTools: string[]
  /** Complete prompt used throughout both phases. */
  systemPrompt?: string
  /** Durable event that restores the full catalog (default: either). */
  promoteOn?: 'tool-call' | 'assistant-message' | 'either'
  /** Optional first-request output cap; unset to retain the adapter default. */
  bootstrapMaxTokens?: number
  /** Auto-injected pre-step context sources hidden from the first request. */
  suppressedContextSources?: string[]
}

export const Config: z<Config> = z.object({
  bootstrapTools: z.array(z.string()).required(),
  systemPrompt: z.string().default(MINIMAL_SYSTEM_PROMPT),
  promoteOn: z.union(['tool-call', 'assistant-message', 'either']).default('either'),
  bootstrapMaxTokens: z.number().step(1).min(1),
  suppressedContextSources: z.array(z.string()).default(DEFAULT_SUPPRESSED_CONTEXT_SOURCES),
})

function distinct(values: readonly string[], field: string): string[] {
  if (values.length === 0 || values.some(value => value.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(values)]
}

/** Register the durable per-session bootstrap filter. */
export function apply(ctx: Context, config: Config): void {
  const bootstrapTools = distinct(config.bootstrapTools, 'bootstrapTools')
  const suppressedContextSources = new Set(
    config.suppressedContextSources === undefined
      ? DEFAULT_SUPPRESSED_CONTEXT_SOURCES
      : config.suppressedContextSources,
  )
  const systemPrompt = config.systemPrompt ?? MINIMAL_SYSTEM_PROMPT
  const promoteOn = config.promoteOn ?? 'either'
  const promoteEvents = PROMOTE_EVENTS[promoteOn]
  const bootstrapMaxTokens = config.bootstrapMaxTokens
  if (systemPrompt.length === 0) throw new TypeError(`${name}: systemPrompt must be non-empty`)
  if (bootstrapMaxTokens !== undefined && (!Number.isSafeInteger(bootstrapMaxTokens) || bootstrapMaxTokens <= 0)) {
    throw new TypeError(`${name}: bootstrapMaxTokens must be a positive safe integer`)
  }

  const promoted = new WeakSet<object>()
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    ctx.logger.warn(message)
  }
  const isPromoted = (agent: { session?: { events: readonly { type: string }[] } } | undefined): boolean => {
    const session = agent?.session
    if (session === undefined) return true
    if (promoted.has(session)) return true
    const hit = session.events.some(event => promoteEvents.has(event.type))
    if (hit) promoted.add(session)
    return hit
  }

  const isRoutingSuite = (agent: { session?: { header?: { agentPreset?: string } } } | undefined): boolean =>
    agent?.session?.header?.agentPreset === ROUTING_SUITE_PRESET

  const suiteMode = (agent: { session?: { events: readonly unknown[] } } | undefined): RouterTaskMode =>
    classifyRouterTask(firstTaskText(agent))

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (isRoutingSuite(context.agent)) {
      const mode = suiteMode(context.agent)
      const planSection = assembled.sections.find(section => /plan/i.test(section.name))
      const routed = {
        ...assembled,
        // Match Router Standard's RL-shaped request: the complete system
        // prompt is the minimal sentence alone. Plan mode is the one explicit
        // boundary retained when its section is active.
        sections: [
          ...(planSection === undefined ? [] : [planSection]),
          { name: `router-suite:${mode}`, text: MINIMAL_SYSTEM_PROMPT },
        ],
        contexts: [],
      }
      // Router Standard promotes only after a real tool call. A text-only
      // assistant reply must not silently change the selected trajectory.
      const suitePromoted = context.agent?.session.events.some(event => event.type === 'tool/call') === true
      if (suitePromoted) {
        // The Windows TUI's `bash` tool is backed by Git for Windows. Keep
        // Router on one Bash dialect after promotion as well.
        return { ...routed, tools: routed.tools.filter(tool => tool.name !== 'pwsh') }
      }
      const wanted = new Set(ROUTER_FIRST_TOOLS[mode])
      const selected = routed.tools.filter(tool => wanted.has(tool.name))
      if (selected.length > 0) return { ...routed, tools: selected }
      warnOnce(`${name}: Router Suite core tools are unavailable; full catalog exposed`)
      return routed
    }
    const anchored = {
      ...assembled,
      sections: [{ name: 'anchored:minimal', text: systemPrompt }],
      contexts: [],
    }
    if (isPromoted(context.agent)) return anchored

    const available = new Set(assembled.tools.map(tool => tool.name))
    const missingTools = bootstrapTools.filter(toolName => !available.has(toolName))
    if (missingTools.length > 0) {
      warnOnce(
        `${name}: expected every Minimal bootstrap tool; missing=${JSON.stringify(missingTools)}; `
        + 'bootstrap disabled, full catalog exposed',
      )
      return anchored
    }
    const bootstrap = new Set(bootstrapTools)
    return {
      ...anchored,
      tools: assembled.tools.filter(tool => bootstrap.has(tool.name)),
    }
  })

  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (isPromoted(payload.agent)) {
        if (resolved.maxTokens !== bootstrapMaxTokens) return resolved
        const { maxTokens: _bootstrap, ...rest } = resolved
        return rest
      }
      return { ...resolved, maxTokens: bootstrapMaxTokens }
    }, { prepend: true })
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // Classify Router requests through the selected tools only. A synthetic
    // near-field user instruction overpowers the minimal system anchor on Pro.
    if (isRoutingSuite(payload.agent)) return decision
    if (isPromoted(payload.agent)) return decision
    const messages = decision.messages.filter(
      message => !suppressedContextSources.has(message.source.kind),
    )
    return messages.length === decision.messages.length ? decision : {
      ...decision,
      messages,
    }
  }, { prepend: true })
}

export default apply
