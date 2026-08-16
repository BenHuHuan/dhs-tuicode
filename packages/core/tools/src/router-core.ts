/**
 * Router Suite core: reasoning-mode routing logic (zero dependencies).
 *
 * TypeScript port of dsh-router-standard@eff787e (v0.2.0), augmented with
 * the reproducible dsh-mode-boost@a9a666a (v0.1.0) routing refinements.
 *
 * BEHAVIORAL REALITY (measured, 21-point × n=2 on v4-pro): model behavior
 * along the react↔spec axis collapses into THREE stable regions, not a
 * continuum — spec [0, 0.15], a transition band [0.2, 0.45] (unstable mix,
 * avoid), and react [0.5, 1.0] (11 mode values behave identically). The
 * numeric interface therefore maps onto three behavior bands; "continuous"
 * tuning is an illusion at the model layer.
 *
 * FOURTH MODE — weak (internal routing): P8/P11 show a weak-persona domain
 * where the model routes itself from the task (discrimination up to +5.0).
 * The optimal weak persona is model-specific (P11, n=3):
 *   - pro:   spec sentence + few-shot routing instruction (w6, +5.00)
 *   - flash: neutral + explicit "classify then act" instruction (w7, +5.67)
 *   - spec-sentence weak personas ANTI-route on flash (planGreen > 0).
 *
 *   mode 0    → pure spec  — plan-first, collective, read-first tools
 *   mode 0.3  → mixed      — transition band (trap; only explicit opt-in)
 *   mode 1    → pure react — doer, produce-verify-fix, test-suppressed
 *   mode W    → weak       — internal routing (model decides per task)
 *
 * `mode` is stored as a number in [0, 1] or the string 'weak'; band mapping
 * quantizes to the four modes.
 * @module @deepseek-ai/dsh-tools/router-core
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

/** A mode value on the measured axis: a number in [0, 1] or internal routing. */
export type RouterMode = number | 'weak'

/** The three measured behavior bands plus the weak internal-routing mode. */
export type RouterBand = 'spec' | 'transition' | 'weak' | 'react'

/** The minimum a session must expose for resume-safe routing. */
export interface RouterSession {
  readonly events: readonly { type: string; data?: unknown }[]
}

/** The minimum a prompt section needs for persona replacement. */
export interface RouterSection {
  name: string
  text: string
  order?: number
}

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** Weak (internal-routing) personas — model-specific optimum (P11/P24).
 *  pro:   spec sentence + classify instruction (w6c, +4.67, P24) — the
 *         few-shot variants and the recall/converge anchors HURT Pro
 *         (P24: suite-full 83% < naked 87.5% vs +guide 100%)
 *  flash: neutral + classify + recall/converge/anti-runaway anchors
 *         (w7, +5.67, P11; anchors lift single-task completion to 100%, P23)
 */
const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

/** Complexity heuristic: long or architecturally-worded tasks are COMPLEX.
 *  Simple tasks get fast-convergence guidance; complex tasks get deep
 *  exploration guidance (depth-adaptive, v19). */
const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isComplexTask(text: string): boolean {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

const CHAT_RE = /^(你好|您好|hello|hi|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|早上好|下午好|晚上好|嗯|好|ok|okay|yes|no|嗯嗯|好的)[!.。！？?~～]*$/i

/** Greetings and short non-task messages should not receive router pressure. */
export function isChatTask(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || CHAT_RE.test(trimmed)) return true
  if (trimmed.length > 24) return false
  return !trimmed.match(REACT_RE) && !trimmed.match(SPEC_RE)
}

/** First two rounds retain the stable baseline; later rounds reclassify. */
export const GUIDE_BASE =
  '\n\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first.'
export const GUIDE_BOOST =
  '\n\nRouter: this is a NEW task, different from the previous ones. Classify it fresh (build or fix) and adopt the matching style — build: direct production; fix: inspect-first. Do not follow the previous task\'s style.'
export const GUIDE_COMMIT = ' Think deeply first, then commit and act.'
export const GUIDE_DEEP = ' Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete.'
export const GUIDE_CLOSURE = ' End each reasoning block with a decision or an information need.'

/** Exact near-field guidance selected by round, complexity, and model family. */
export function guideFor(round: number, text: string, modelId?: string): string {
  const base = round >= 3 ? GUIDE_BOOST : GUIDE_BASE
  if (!isComplexTask(text)) return base + GUIDE_COMMIT
  const deep = base + GUIDE_DEEP
  return isFlashModel(modelId) ? deep : deep + GUIDE_CLOSURE
}

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Quantize a mode to one of the four measured behavior bands. */
export function bandOf(mode: RouterMode): RouterBand {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec' // measured stable spec region (0..0.15)
  if (m < 0.5) return 'transition' // measured unstable band — avoid
  return 'react' // measured stable react region (0.5..1 behave alike)
}

/** Persona for a mode; weak picks the model-specific internal-routing text. */
export function personaFor(mode: RouterMode, modelId?: string): string {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

/** First-turn core tools (shell added dynamically by the plugin).
 *  v0.2.0: the weak (internal-routing) band gets the RL-shape surface —
 *  shell + str_replace_editor — per the interface-restoration measurement
 *  (100% action at 18–29K reasoning chars vs ~25% / 73–101K on the
 *  read/write/edit surface, official API, 2026-08-15). */
export function coreFor(mode: RouterMode): string[] {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep'] // read-first
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep'] // union
    case 'weak': return ['str_replace_editor'] // RL shape: shell + editor
    default: return ['read', 'write', 'edit'] // write-first
  }
}

/** Human-readable band name for a mode value. */
export function bandFor(mode: RouterMode): 'spec' | 'mixed' | 'weak' | 'react' {
  const b = bandOf(mode)
  return b === 'transition' ? 'mixed' : b
}

/** Test-suppression strength for a mode (informational). */
export function testinessFor(mode: RouterMode): 'suppressed' | 'normal' | 'light' {
  switch (bandOf(mode)) {
    case 'react': return 'suppressed'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

const REACT_RE = new RegExp([
  '开发', '创建', '写一个', '生成', '从零', '做一个', '游戏', '网页', '网站', '构建',
  '新项目', '搭建', '实现', '做出', '上线', '落地', '脚本', '工具', '应用',
  'build', 'create', 'develop', 'generate', 'implement', 'make a', 'new project',
].join('|'), 'gi')
const SPEC_RE = new RegExp([
  '修复', '修一下', '调试', '重构', '维护', '排查', '报错', '出错', '崩溃', '优化',
  '审查', 'review', 'fix', 'debug', 'refactor', 'maintain', 'repair', 'broken', 'break',
  '为什么', '异常', '故障', '迁移', '升级', '兼容',
].join('|'), 'gi')

function countHits(regex: RegExp, text: string): number {
  return [...text.matchAll(regex)].length
}

/**
 * Classify a task text into a mode. Clear keyword evidence picks a stable
 * band (1 react / 0 spec); AMBIGUOUS or unmatched text returns 'weak' —
 * the internal-routing mode, where the model decides per task (P11 optimum).
 */
export function classifyTask(text: string): RouterMode {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

/** Per-session mode derived from durable events (resume-safe). */
export function sessionMode(session: RouterSession): RouterMode {
  const events = session.events
  const userMsg = events.find(event => event.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

export function extractText(data: unknown): string {
  if (!data) return ''
  // 防御性解包：插件/工具生成的 user/message 偶有 `data.message` 嵌套形状
  // （如注入器 startIngest 的 seed），直接读 data.content 会得到空串 →
  // 构建/修复任务被误判 weak（router-standard issue #1）。
  const record = data as { message?: unknown; content?: unknown }
  const payload = record.message !== null && typeof record.message === 'object'
    ? record.message as { content?: unknown }
    : record
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((block) => {
    if (typeof block === 'string') return block
    const text = (block as { text?: unknown } | null | undefined)?.text
    return typeof text === 'string' ? text : ''
  }).join(' ')
}

export function clamp01(v: unknown): number {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

/**
 * Replace only the persona section of an assembled section list, keeping
 * everything else — the plan-mode section above all, which is toggled per
 * plan state and carries the plan-boundary instructions.
 */
export function applyPersona(sections: readonly RouterSection[] | undefined, personaText: string): RouterSection[] {
  const rest = (sections ?? []).filter(
    section => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

/** Parse a user/agent-supplied mode token: number 0-100, 0.0-1.0, or a band name. */
export function parseMode(token: unknown): RouterMode | 'auto' | null {
  if (token === undefined || token === null) return null
  const raw = typeof token === 'string' ? token : typeof token === 'number' ? String(token) : null
  if (raw === null) return null
  const t = raw.trim().toLowerCase()
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router') return 'weak'
  if (t === 'spec' || t === 'spec-lean') return 0
  if (t === 'balanced' || t === 'mixed') return 0.3 // transition-band center
  if (t === 'react' || t === 'react-lean') return 1
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}
