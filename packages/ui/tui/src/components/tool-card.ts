/**
 * Claude Code-style tool-card headers: a `Verb(argument)` title painted by tool
 * family, a status bullet, and a bounded elapsed time. These are pure
 * presentation functions of the parsed tool arguments and the active palette.
 * @module @deepseek-ai/dsh-tui/components/tool-card
 */

import type { ColorRole, Palette } from './theme.ts'

/** Tool family used only to select the title color. */
export type ToolColorFamily = 'file' | 'shell' | 'search' | 'edit' | 'network' | 'other'

/** Title metadata for one known tool. */
interface ToolCardMeta {
  readonly verb: string
  readonly family: ToolColorFamily
}

/** Known-tool title verbs and color families, mirroring Claude Code's tool taxonomy. */
const TOOL_META: Readonly<Record<string, ToolCardMeta>> = {
  read: { verb: 'Read', family: 'file' },
  read_image: { verb: 'View', family: 'file' },
  write: { verb: 'Write', family: 'file' },
  edit: { verb: 'Edit', family: 'file' },
  glob: { verb: 'Find', family: 'file' },
  ls: { verb: 'List', family: 'file' },
  repo_map: { verb: 'Map', family: 'file' },
  repo_graph: { verb: 'Graph', family: 'file' },
  inspect_project: { verb: 'Inspect', family: 'file' },
  file_info: { verb: 'Stat', family: 'file' },
  bash: { verb: 'Run', family: 'shell' },
  pwsh: { verb: 'Run', family: 'shell' },
  grep: { verb: 'Search', family: 'search' },
  search: { verb: 'Search', family: 'search' },
  ast_grep: { verb: 'Search', family: 'search' },
  semantic_search: { verb: 'Search', family: 'search' },
  related_tests: { verb: 'Search', family: 'search' },
  apply_patch: { verb: 'Patch', family: 'edit' },
  hash_edit: { verb: 'Patch', family: 'edit' },
  str_replace: { verb: 'Edit', family: 'edit' },
  str_replace_editor: { verb: 'Edit', family: 'edit' },
  web_fetch: { verb: 'Fetch', family: 'network' },
  web_search: { verb: 'Search', family: 'network' },
  todo_write: { verb: 'Todo', family: 'other' },
  ask_user_question: { verb: 'Ask', family: 'other' },
  task: { verb: 'Delegate', family: 'other' },
  delegate_task: { verb: 'Delegate', family: 'other' },
  delegate_batch: { verb: 'Batch', family: 'other' },
} as const

/** Display fallback for an unknown tool name. */
const UNKNOWN_META: ToolCardMeta = { verb: 'Tool', family: 'other' }

/**
 * Title metadata for a tool call.
 * @param name - Model-produced tool name.
 * @returns Known verb and color family, or the unknown-tool fallback.
 */
export function toolCardMeta(name: string): ToolCardMeta {
  return TOOL_META[name] ?? UNKNOWN_META
}

/** One human-visible string from a model argument, or `undefined`. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Basename of a path argument, accepting both separator styles. */
function pathBasename(value: unknown): string | undefined {
  const text = textOf(value)
  if (text === undefined) return undefined
  const base = text.replace(/^.*[/\\]/, '')
  return base === '' ? undefined : base
}

/** Clamp a model-produced summary to one card row. */
function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

/** Argument keys probed in order for tools without a dedicated summary. */
const GENERIC_ARG_KEYS = ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'question', 'objective', 'name'] as const

/**
 * One-line argument summary for a tool card title.
 * @param name - Model-produced tool name.
 * @param args - Parsed tool-call arguments; non-objects contribute no summary.
 * @returns The summary without a trailing space, or `undefined` when none exists.
 */
export function toolCardArgSummary(name: string, args: unknown): string | undefined {
  const object = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined
  if (object === undefined) return undefined
  const text = (key: string): string | undefined => textOf(object[key])
  switch (name) {
    case 'bash':
    case 'pwsh': {
      const command = text('command')
      /* v8 ignore next -- split always yields a first element. */
      const firstLine = command?.split('\n')[0] ?? undefined
      return firstLine === undefined || firstLine === '' ? undefined : clamp(firstLine, 55)
    }
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
    case 'apply_patch':
    case 'hash_edit':
    case 'str_replace':
    case 'str_replace_editor':
      return pathBasename(object.file_path ?? object.path)
    case 'glob':
    case 'grep':
    case 'ast_grep':
    case 'semantic_search':
    case 'related_tests':
    case 'web_search': {
      const query = text('pattern') ?? text('query')
      return query === undefined || query === '' ? undefined : clamp(query, 35)
    }
    case 'web_fetch': {
      const url = text('url')
      return url === undefined || url === '' ? undefined : clamp(url, 50)
    }
    case 'ask_user_question': {
      const question = text('question')
      return question === undefined || question === '' ? undefined : clamp(question, 50)
    }
    case 'task':
    case 'delegate_task': {
      const objective = text('objective') ?? text('task')
      return objective === undefined || objective === '' ? undefined : clamp(objective, 50)
    }
    case 'delegate_batch': {
      const tasks = object.tasks
      return Array.isArray(tasks) ? `${String(tasks.length)} tasks` : undefined
    }
    case 'todo_write': {
      const todos = object.todos
      return Array.isArray(todos) ? `${String(todos.length)} items` : undefined
    }
    default: {
      for (const key of GENERIC_ARG_KEYS) {
        const value = key === 'path' || key === 'file_path' ? pathBasename(object[key]) : text(key)
        if (value !== undefined && value !== '') return clamp(value, 50)
      }
      return undefined
    }
  }
}

/**
 * A tool card's title: `Verb(summary)` when a summary exists, otherwise the bare verb.
 * @param name - Model-produced tool name.
 * @param args - Parsed tool-call arguments.
 * @returns Display title before ANSI styling and inline control escaping.
 */
export function toolCardTitle(name: string, args: unknown): string {
  const { verb } = toolCardMeta(name)
  const summary = toolCardArgSummary(name, args)
  return summary === undefined || summary === '' ? verb : `${verb}(${summary})`
}

/**
 * The color role that paints a tool title.
 * @param name - Model-produced tool name.
 * @param palette - Active role palette.
 * @returns File/accent, shell/warning, search/success, edit/code, or dim for unknown tools.
 */
export function toolCardColor(name: string, palette: Palette): ColorRole {
  switch (toolCardMeta(name).family) {
    case 'file':
    case 'network':
      return palette.accent
    case 'shell':
      return palette.warning
    case 'search':
      return palette.success
    case 'edit':
      return palette.code
    default:
      return palette.dim
  }
}

/**
 * Format a bounded tool duration the way Claude Code does.
 * @param ms - Non-negative elapsed milliseconds.
 * @returns `<1s` milliseconds, `<60s` one-decimal seconds, otherwise `XmYYs`.
 */
export function formatToolElapsed(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 1000) return `${Math.round(clamped)}ms`
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.round((clamped % 60_000) / 1000)
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
}
