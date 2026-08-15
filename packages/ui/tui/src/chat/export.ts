/** Readable plain-text exports for durable terminal conversations. */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { contentText } from '../components/content.ts'

/** The durable session fields a conversation export reads without mutating the session. */
export interface ExportableConversation {
  /** Stable session identity used in the header and default filename. */
  readonly id: SessionId
  /** Immutable session metadata. */
  readonly header: SessionHeader
  /** Append-only event history to render in chronological order. */
  readonly events: readonly SessionEvent[]
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_')
}

function eventTime(time: number): string {
  return new Date(time).toISOString()
}

function sourceLabel(source: { readonly kind: string }): string {
  if (source.kind === 'user') return 'User'
  const labelled = source as { readonly kind?: unknown; readonly plugin?: unknown }
  const label = typeof labelled.plugin === 'string'
    ? labelled.plugin
    : typeof labelled.kind === 'string'
      ? labelled.kind
      : 'context'
  return `Context · ${label}`
}

function toolResultLabel(
  event: Extract<SessionEvent, { type: 'tool/result' }>,
  calls: ReadonlyMap<string, string>,
): string {
  const name = calls.get(String(event.data.message.source.callId))
  return name === undefined ? 'Tool result' : `Tool result · ${name}`
}

function turnEndText(reason: { readonly kind: string }): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'error': {
      const failure = reason as { readonly error?: { readonly message?: unknown } }
      return typeof failure.error?.message === 'string'
        ? `Turn ended with an error: ${failure.error.message}`
        : 'Turn ended with an error.'
    }
    case 'aborted':
      return 'Turn cancelled.'
    case 'blocked':
      return 'Turn stopped: the agent is blocked.'
    case 'max-tokens':
      return 'The model reached its output-token limit.'
    case 'interrupted':
      return 'The previous process ended during this turn.'
    default:
      return `Turn ended: ${reason.kind}.`
  }
}

function appendSection(lines: string[], label: string, time: number, text: string): void {
  lines.push('', `=== ${label} · ${eventTime(time)} ===`, text === '' ? '(empty)' : text)
}

/**
 * Produce the collision-safe default filename for one Session export.
 * @param sessionId - Session represented by the exported text.
 * @returns A relative plain-text filename with no path separators.
 */
export function defaultConversationExportFilename(sessionId: SessionId): string {
  return `dsh-session-${safeFileStem(String(sessionId))}.txt`
}

/**
 * Render one full durable conversation as readable plain text.
 *
 * Raw stream chunks and request bookkeeping are omitted because settled
 * assistant messages, tool calls, and tool results carry the human-readable
 * transcript. Non-completed turns retain a concise terminal marker.
 * @param conversation - Session metadata and chronological event log to render.
 * @param title - Latest title visible in the TUI, when the title service is mounted.
 * @returns A UTF-8-ready plain-text transcript with a trailing newline.
 */
export function exportConversationText(
  conversation: ExportableConversation,
  title: string | undefined,
): string {
  const lines = [
    'DeepSeek Harness conversation',
    `Session: ${String(conversation.id)}`,
    ...title === undefined ? [] : [`Title: ${title}`],
    ...conversation.header.cwd === undefined ? [] : [`Directory: ${conversation.header.cwd}`],
    `Created: ${eventTime(conversation.header.createdAt)}`,
  ]
  const calls = new Map<string, string>()
  for (const event of conversation.events) {
    switch (event.type) {
      case 'user/message':
        appendSection(lines, sourceLabel(event.data.source), event.time, contentText(event.data.content))
        break
      case 'assistant/message':
        appendSection(lines, 'Assistant', event.time, contentText(event.data.message.content))
        break
      case 'tool/call':
        calls.set(String(event.data.callId), event.data.name)
        appendSection(lines, `Tool call · ${event.data.name}`, event.time, event.data.arguments)
        break
      case 'tool/result': {
        const error = event.data.error === undefined
          ? ''
          : `\n[${event.data.error.name}${event.data.error.code === '' ? '' : `: ${event.data.error.code}`}]`
        appendSection(lines, toolResultLabel(event, calls), event.time, `${contentText(event.data.message.content)}${error}`)
        break
      }
      case 'turn/end': {
        const text = turnEndText(event.data.reason)
        if (text !== undefined) appendSection(lines, 'System', event.time, text)
        break
      }
      default:
        break
    }
  }
  return `${lines.join('\n')}\n`
}
