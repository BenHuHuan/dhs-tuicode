/**
 * Pure selection helpers for committed assistant replies shown by the TUI.
 * Replacement-origin surface events, reasoning, images, and tool calls are not
 * clipboard text: only append-origin text blocks participate.
 * @module @deepseek-ai/dsh-tui/chat/assistant-responses
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One persistent assistant reply, ordered newest-first by the selectors below. */
export interface VisibleAssistantResponse {
  /** Durable event sequence that owns this reply. */
  readonly eventSeq: number
  /** Exact concatenation of the reply's visible text blocks. */
  readonly text: string
}

/** One fenced Markdown code block extracted from an assistant reply. */
export interface AssistantCodeBlock {
  /** One-based position among every fence in the reply. */
  readonly index: number
  /** First info-string token, when the opening fence declares one. */
  readonly language?: string
  /** Fence-free code text, preserving content whitespace. */
  readonly text: string
}

/**
 * Return every non-empty, transcript-visible assistant reply, newest first.
 * @param events Committed session events in log order.
 * @returns Append-origin assistant text replies from newest to oldest.
 */
export function visibleAssistantResponses(
  events: readonly SessionEvent[],
): VisibleAssistantResponse[] {
  const responses: VisibleAssistantResponse[] = []
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex]
    if (event?.type !== 'assistant/message' || event.surfaceOp !== 'append') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim() === '') continue
    responses.push({ eventSeq: event.seq, text })
  }
  return responses
}

/**
 * Select the Nth latest visible assistant reply.
 * @param events Committed session events in log order.
 * @param ordinal One-based newest-first position.
 * @returns The selected reply, or `undefined` when the ordinal is absent/invalid.
 */
export function visibleAssistantResponse(
  events: readonly SessionEvent[],
  ordinal = 1,
): VisibleAssistantResponse | undefined {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return undefined
  return visibleAssistantResponses(events)[ordinal - 1]
}

interface SourceLine {
  readonly start: number
  readonly contentEnd: number
  readonly end: number
  readonly content: string
}

/** Split without normalizing line endings, retaining source offsets for exact slices. */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline + 1
    const rawContentEnd = newline < 0 ? text.length : newline
    const contentEnd = rawContentEnd > start && text.charCodeAt(rawContentEnd - 1) === 13
      ? rawContentEnd - 1
      : rawContentEnd
    lines.push({ start, contentEnd, end, content: text.slice(start, contentEnd) })
    start = end
  }
  return lines
}

function stripOneTrailingLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n') || value.endsWith('\r')) return value.slice(0, -1)
  return value
}

/**
 * Extract CommonMark-style backtick and tilde fenced code bodies in source order.
 * An unclosed final fence owns the remainder of the finalized reply. Empty
 * fences are returned so callers can decide whether they are useful targets.
 * @param text Assistant Markdown text.
 * @returns Fence-free code blocks in source order.
 */
export function assistantCodeBlocks(text: string): AssistantCodeBlock[] {
  const lines = sourceLines(text)
  const blocks: AssistantCodeBlock[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(lines[lineIndex]?.content ?? '')
    if (opening === null) continue
    const fence = opening[2] as string
    const info = (opening[3] as string).trim()
    if (fence[0] === '`' && info.includes('`')) continue
    const fenceCharacter = fence[0]
    const fenceLength = fence.length
    const bodyStart = (lines[lineIndex] as SourceLine).end
    let bodyEnd = text.length
    let closingIndex = lines.length
    for (let candidateIndex = lineIndex + 1; candidateIndex < lines.length; candidateIndex += 1) {
      const candidate = /^( {0,3})(`+|~+)[ \t]*$/u.exec(lines[candidateIndex]?.content ?? '')
      const candidateFence = candidate?.[2]
      if (
        candidateFence !== undefined
        && candidateFence[0] === fenceCharacter
        && candidateFence.length >= fenceLength
      ) {
        bodyEnd = (lines[candidateIndex] as SourceLine).start
        closingIndex = candidateIndex
        break
      }
    }
    const language = info.split(/[ \t]+/u)[0]
    blocks.push({
      index: blocks.length + 1,
      ...language === undefined || language === '' ? {} : { language },
      text: stripOneTrailingLineEnding(text.slice(bodyStart, bodyEnd)),
    })
    lineIndex = closingIndex
  }
  return blocks
}
