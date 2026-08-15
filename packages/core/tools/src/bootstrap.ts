/**
 * Two-phase tool-catalog bootstrap for DeepSeek coding agents.
 *
 * The first model request receives the Minimal prompt and one platform shell
 * plus `read` and a small output budget. Once the session contains its first
 * durable tool call or assistant message, every later request receives the
 * complete catalog and normal budget. The phase is derived from the log so
 * resume and reload cannot reset it.
 * @module @deepseek-ai/dsh-tools/bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Minimal's complete system prompt, kept byte-stable for trajectory anchoring. */
export const MINIMAL_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/** Cordis plugin name. */
export const name = 'anchored-tool-bootstrap'

/** Register before instruction/skill injectors so bootstrap can strip them last. */
export const inject: string[] = []

const DEFAULT_BOOTSTRAP_MAX_TOKENS = 1024
const BOOTSTRAP_INJECTED_SOURCE_KINDS = new Set(['skill-catalog', 'agent-instructions'])
const PROMOTE_EVENTS = {
  'tool-call': new Set<string>(['tool/call']),
  'assistant-message': new Set<string>(['assistant/message']),
  either: new Set<string>(['tool/call', 'assistant/message']),
} as const

/** Two-phase bootstrap configuration. */
export interface Config {
  /** Candidate platform shells; exactly one must be visible in each assembly. */
  shellTools: string[]
  /** Tools retained alongside the platform shell during bootstrap. */
  commonTools: string[]
  /** Complete prompt used throughout both phases. */
  systemPrompt?: string
  /** Durable event that restores the full catalog (default: either). */
  promoteOn?: 'tool-call' | 'assistant-message' | 'either'
  /** First-request output cap used to preserve Minimal's trajectory. */
  bootstrapMaxTokens?: number
}

export const Config: z<Config> = z.object({
  shellTools: z.array(z.string()).required(),
  commonTools: z.array(z.string()).required(),
  systemPrompt: z.string().default(MINIMAL_SYSTEM_PROMPT),
  promoteOn: z.union(['tool-call', 'assistant-message', 'either']).default('either'),
  bootstrapMaxTokens: z.number().step(1).min(1).default(DEFAULT_BOOTSTRAP_MAX_TOKENS),
})

function distinct(values: readonly string[], field: string): string[] {
  if (values.length === 0 || values.some(value => value.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(values)]
}

/** Register the durable per-session bootstrap filter. */
export function apply(ctx: Context, config: Config): void {
  const shellTools = distinct(config.shellTools, 'shellTools')
  const commonTools = distinct(config.commonTools, 'commonTools')
  const systemPrompt = config.systemPrompt ?? MINIMAL_SYSTEM_PROMPT
  const promoteOn = config.promoteOn ?? 'either'
  const promoteEvents = PROMOTE_EVENTS[promoteOn]
  const bootstrapMaxTokens = config.bootstrapMaxTokens ?? DEFAULT_BOOTSTRAP_MAX_TOKENS
  if (systemPrompt.length === 0) throw new TypeError(`${name}: systemPrompt must be non-empty`)
  if (!Number.isSafeInteger(bootstrapMaxTokens) || bootstrapMaxTokens <= 0) {
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

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const anchored = {
      ...assembled,
      sections: [{ name: 'anchored:minimal', text: systemPrompt }],
      contexts: [],
    }
    if (isPromoted(context.agent)) return anchored

    const available = new Set(assembled.tools.map(tool => tool.name))
    const selectedShells = shellTools.filter(toolName => available.has(toolName))
    const missingCommon = commonTools.filter(toolName => !available.has(toolName))
    if (selectedShells.length !== 1 || missingCommon.length > 0) {
      warnOnce(
        `${name}: expected exactly one bootstrap shell and every common tool; `
        + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missingCommon)}; `
        + 'bootstrap disabled, full catalog exposed',
      )
      return anchored
    }
    const bootstrap = new Set([...selectedShells, ...commonTools])
    return {
      ...anchored,
      tools: assembled.tools.filter(tool => bootstrap.has(tool.name)),
    }
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (isPromoted(payload.agent)) {
      if (resolved.maxTokens !== bootstrapMaxTokens) return resolved
      const { maxTokens: _bootstrap, ...rest } = resolved
      return rest
    }
    return { ...resolved, maxTokens: bootstrapMaxTokens }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || isPromoted(payload.agent)) return decision
    return {
      ...decision,
      messages: decision.messages.filter(message => !BOOTSTRAP_INJECTED_SOURCE_KINDS.has(message.source.kind)),
    }
  })
}

export default apply
