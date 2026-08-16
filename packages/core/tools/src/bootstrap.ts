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
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from './schema.ts'
import {
  applyPersona, bandFor, bandOf, classifyTask, coreFor, extractText, isComplexTask,
  parseMode, personaFor, testinessFor, clamp01,
  type RouterMode,
} from './router-core.ts'

/** Minimal's complete system prompt, kept byte-stable for trajectory anchoring. */
export const MINIMAL_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/**
 * Durable session marker used by the built-in Router Standard compatibility
 * port: the v0.2.0 RL-interface restoration preset (think-act loops).
 */
export const ROUTING_SUITE_PRESET = 'routing-suite'

/**
 * Durable session marker used by the built-in Router Spec compatibility
 * port: the v0.2.0 deep-think-first preset (the long first-turn reasoning
 * chain is a feature, not a defect).
 */
export const ROUTING_SUITE_SPEC_PRESET = 'routing-suite-spec'

/** Router Standard's stable internal regions; mixed is intentionally excluded. */
export type RouterTaskMode = 'spec' | 'react' | 'weak'

/** The v0.2.0 routing modes the two Router presets select. */
export type RouterSuiteMode = 'standard' | 'spec'

/** User-facing tool-routing profiles (kept for the existing export surface). */
export type ToolRoutingProfile = 'anchored' | 'suite' | 'suite-spec'

/**
 * Compatibility port of dsh-router-standard@eff787e (v0.2.0). The original
 * injector's hot-plugin lifecycle is deliberately not embedded: the Harness
 * session header and prompt waterfalls already provide the required stable
 * boundary.
 */

// ── v0.2.0 standard mode ────────────────────────────────────────────────────
// RL 接口还原：first request carries ONLY the RL training sentence +
// shell/str_replace_editor; identity/web/tool-guidance sections are removed
// (minimal's complete:true semantics). The model works in think-act feedback
// loops (measured: 25 steps / 24 tool calls / 19KB artifact).

/** The standard mode's complete first-request persona (the RL training sentence). */
const RL_PERSONA = MINIMAL_SYSTEM_PROMPT

/**
 * spec 路由模式的首轮工具面（旧行为；weak 也走 default 面）。
 * Kept separate from `coreFor` exactly like the original: `coreFor` describes
 * the tuning axis, while spec mode routes its first turn through this legacy
 * surface.
 */
function legacyCore(mode: RouterMode): readonly string[] {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    default: return ['read', 'write', 'edit']
  }
}

// ── near-field routing guidance for weak mode (P14/P16/P17/P19/P20) ─────────
// Every REAL user message in a weak-mode session gets ONE fixed guidance
// message appended right after it (near field, cache-neutral). Depth-adaptive:
// SIMPLE tasks get the fast-convergence guide; COMPLEX tasks get the deep-
// exploration guide (depth-first, information-driven stop signal).
const GUIDE_WEAK =
  '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
const GUIDE_DEEP =
  '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

/**
 * Classify one task exactly like Router Standard, without its unstable mixed region.
 * @param text - First user task text to route.
 * @returns The stable Router task class used to select the initial tool surface.
 */
export function classifyRouterTask(text: string): RouterTaskMode {
  const mode = classifyTask(text)
  if (mode === 'weak') return 'weak'
  return mode === 0 ? 'spec' : 'react'
}

function textOfMessage(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

interface Sessionish {
  id: string
  events: readonly { type: string; data?: unknown }[]
}

function firstTaskText(agent: { session?: Sessionish } | undefined): string {
  const events = agent?.session?.events ?? []
  for (const event of events) {
    if (event.type === 'tui/input' && typeof (event.data as { text?: unknown } | undefined)?.text === 'string') {
      return (event.data as { text: string }).text
    }
    if (event.type === 'user/message') {
      // issue #1: defensive unpacking for the nested `data.message` shape.
      return extractText(event.data)
    }
  }
  return ''
}

/** Cordis plugin name. */
export const name = 'anchored-tool-bootstrap'

/** Host services used by the Router tuning tools and mode-isolated subagent. */
export const inject = ['tools', 'llm']

const DEFAULT_SUPPRESSED_CONTEXT_SOURCES = ['agent-instructions', 'skill-catalog']
const PROMOTE_EVENTS = {
  'tool-call': new Set<string>(['tool/call']),
  'assistant-message': new Set<string>(['assistant/message']),
  either: new Set<string>(['tool/call', 'assistant/message']),
} as const

/**
 * Router-owned tuning tools. They are registered once on the host plane and
 * kept out of every non-Router catalog by the bootstrap filter, so the
 * Minimal/headless surfaces never expose them.
 */
const ROUTER_DEV_TOOLS = new Set(['dev_router_status', 'dev_router_mode', 'dev_mode_subagent'])

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

  const suiteRouterMode = (agent: {
    session?: { header?: { agentPreset?: string } }
  } | undefined): RouterSuiteMode | undefined => {
    const preset = agent?.session?.header?.agentPreset
    if (preset === ROUTING_SUITE_PRESET) return 'standard'
    if (preset === ROUTING_SUITE_SPEC_PRESET) return 'spec'
    return undefined
  }
  const isRoutingSuite = (agent: {
    session?: { header?: { agentPreset?: string } }
  } | undefined): boolean => suiteRouterMode(agent) !== undefined

  // session id -> explicit mode (number 0..1 or 'weak'), set by dev_router_mode.
  const overrides = new Map<string, number | 'weak'>()

  const suiteTaskMode = (agent: { session?: Sessionish } | undefined): RouterMode => {
    const session = agent?.session
    if (session === undefined) return classifyTask('')
    return overrides.get(session.id) ?? classifyTask(firstTaskText(agent))
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const routerMode = suiteRouterMode(context.agent)
    if (routerMode !== undefined) {
      const session = context.agent?.session
      const events = session?.events ?? []
      const mode = suiteTaskMode(context.agent)
      const modelId = context.agent?.options.model
      const planSection = assembled.sections.find(section => /plan/i.test(section.name))

      // ── 模式分派（v0.2.0 原样移植）──────────────────────────────────────
      // standard（RL 接口还原）: 首轮 system = 只有 RL 训练句；身份/Web 定位/
      // 工具引导/规则 sections 全部移除；core = shell + str_replace_editor。
      // spec（深度思考优先）: 分类 persona + 保留全部 sections（首轮长思维链
      // 是特征）；core = legacyCore(mode) + shell。
      let sections
      let core: Set<string>
      if (routerMode === 'standard') {
        sections = planSection === undefined
          ? [{ name: 'router-persona', text: RL_PERSONA, order: 0 }]
          : [planSection, { name: 'router-persona', text: RL_PERSONA, order: 0 }]
        core = new Set(['str_replace_editor']) // RL shape: shell + editor
      } else {
        const persona = personaFor(mode, modelId)
        sections = applyPersona(assembled.sections, persona) // keep all other sections
        core = new Set(legacyCore(mode))
      }

      // Router Standard promotes only after a real tool call. A text-only
      // assistant reply must not silently change the selected trajectory.
      const suitePromoted = events.some(event => event.type === 'tool/call')
      if (suitePromoted) {
        // The Windows TUI's `bash` tool is backed by Git for Windows. Keep
        // Router on one Bash dialect after promotion as well.
        return { ...assembled, sections, contexts: [], tools: assembled.tools.filter(tool => tool.name !== 'pwsh') }
      }

      const available = new Set(assembled.tools.map(tool => tool.name))
      const shell = available.has('bash') ? 'bash' : available.has('pwsh') ? 'pwsh' : null
      if (shell === null) {
        throw new Error(`${name}: no platform shell in catalog`)
      }
      core.add(shell)

      const selected = assembled.tools.filter(tool => core.has(tool.name))
      if (selected.length > 0) return { ...assembled, sections, contexts: [], tools: selected }
      warnOnce(`${name}: Router Suite core tools are unavailable; full catalog exposed`)
      return { ...assembled, sections, contexts: [] }
    }

    const anchored = {
      ...assembled,
      sections: [{ name: 'anchored:minimal', text: systemPrompt }],
      contexts: [],
    }
    const withoutRouterDevTools = anchored.tools.filter(tool => !ROUTER_DEV_TOOLS.has(tool.name))
    if (isPromoted(context.agent)) return { ...anchored, tools: withoutRouterDevTools }

    const available = new Set(assembled.tools.map(tool => tool.name))
    const missingTools = bootstrapTools.filter(toolName => !available.has(toolName))
    if (missingTools.length > 0) {
      warnOnce(
        `${name}: expected every Minimal bootstrap tool; missing=${JSON.stringify(missingTools)}; `
        + 'bootstrap disabled, full catalog exposed',
      )
      return { ...anchored, tools: withoutRouterDevTools }
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
    if (isRoutingSuite(payload.agent)) {
      // Near-field weak guidance (v0.2.0): one fixed guidance message per REAL
      // user message when the routed band is weak. Strong bands need none.
      const task = payload.messages.find(message => message.source.kind === 'user')
      if (task !== undefined) {
        const text = textOfMessage(task)
        const session = payload.agent.session
        const sessionMode = session.events.length > 0
          ? overrides.get(session.id) ?? classifyTask(firstTaskText(payload.agent))
          : classifyTask(text)
        if (text.trim() !== '' && bandOf(sessionMode) === 'weak') {
          const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
          return {
            ...decision,
            messages: [...decision.messages, createUserMessage({
              source: { kind: 'plugin', plugin: 'router-suite', form: 'instructions' },
              content: [{ type: 'text', text: guide }],
            })],
          }
        }
      }
      // Classify Router requests through the selected tools only.
      return decision
    }
    if (isPromoted(payload.agent)) return decision
    const messages = decision.messages.filter(
      message => !suppressedContextSources.has(message.source.kind),
    )
    return messages.length === decision.messages.length ? decision : {
      ...decision,
      messages,
    }
  }, { prepend: true })

  // ── router visibility & tuning (agent self-optimization) ─────────────────
  // v0.2.0: `dev_router_status` reports which routing mode the session runs
  // under; `dev_router_mode` overrides the classified mode; `dev_mode_subagent`
  // runs one task in a different mode inside a fresh isolated context.
  function fmtMode(mode: RouterMode): string {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  function routeModeLabel(agent: { session?: { header?: { agentPreset?: string } } } | undefined): RouterSuiteMode | undefined {
    return suiteRouterMode(agent)
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: router-mode, mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(_args, exec) {
      return Promise.resolve((() => {
        const agent = exec.agent
        if (agent?.session === undefined) return 'no agent session'
        const mode = suiteTaskMode(agent)
        const modelId = agent.options.model
        const routerMode = routeModeLabel(agent) ?? 'none'
        return [
          `router-mode=${routerMode} (standard=RL接口还原 / spec=深度思考优先)`,
          `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
          `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
          `core=[${coreFor(mode).join(', ')}]`,
          `testiness=${testinessFor(mode)}`,
          `override=${overrides.has(agent.session.id) ? 'yes' : 'no'}`,
        ].join('\n')
      })())
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      return Promise.resolve((() => {
        const parsed = parseMode(args.mode)
        if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
        const agent = exec.agent
        if (agent?.session === undefined) return 'no agent session'
        if (parsed === 'auto') overrides.delete(agent.session.id)
        else overrides.set(agent.session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
        const current = suiteTaskMode(agent)
        return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
      })())
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const agent = exec.agent
      if (agent?.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = args.maxTokens ?? 1024
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [createUserMessage({
            source: { kind: 'plugin', plugin: 'router-suite', form: 'instructions' },
            content: [{ type: 'text', text: args.task }],
          })],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `subagent error: ${message}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })))
}

// Loader unwraps an ESM default export before Cordis inspects plugin metadata.
// Keep the compatibility default while carrying the metadata on the function
// itself; named exports alone are invisible after that unwrap.
export default Object.assign(apply, { inject, Config })
