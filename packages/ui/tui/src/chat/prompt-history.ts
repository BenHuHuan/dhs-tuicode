/**
 * Durable prompt-history indexing for the interactive terminal channel.
 *
 * New TUI submissions use the log-only `tui/input` event as their exact
 * source. Sessions created before that event existed fall back to direct human
 * messages, recorded slash commands, and completed direct-shell notices.
 *
 * @module @deepseek-ai/dsh-tui/chat/prompt-history
 */

import type {} from '@deepseek-ai/dsh-commands'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { contentText } from '../components/content.ts'
import { parseUserShellResultMessage } from './shell-mode.ts'
import { workspaceKey } from './workspace.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Exact non-empty editor text accepted by the TUI. This log-only event
     * never enters model history; it preserves every accepted input form for
     * same-session and cross-session recall.
     * @param text Trimmed editor text, including any embedded newlines.
     */
    'tui/input': { text: string }
  }
}

/** Search scopes exposed by the prompt-history dialog. */
export type PromptHistoryScope = 'session' | 'project' | 'all'

/** State of lazy cross-session prompt discovery. */
export type PromptHistoryLoadState = 'idle' | 'unavailable' | 'loading' | 'complete' | 'failed'

/** One accepted prompt retained with enough origin data for scoped search. */
export interface PromptHistoryEntry {
  /** Exact editor text restored on acceptance. */
  readonly text: string
  /** Durable event time used for newest-first ordering. */
  readonly time: number
  /** Session that accepted the input. */
  readonly sessionId: SessionId
  /** Session working directory, absent only for a cwd-less legacy session. */
  readonly cwd?: string
}

/** Minimal optional session-query operations used by lazy history discovery. */
export type PromptHistoryQuery = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>

/** Construction inputs and deployment-owned history bounds. */
export interface PromptHistoryOptions {
  /** Current session identity. */
  readonly sessionId: SessionId
  /** Current session working directory. */
  readonly cwd: string
  /** Live append-only event snapshot for the current session. */
  readonly events: () => readonly SessionEvent[]
  /** Append one exact accepted input to the current session log. */
  readonly appendInput: (text: string) => void
  /** Optional query service, re-read when a lazy scan starts. */
  readonly sessionQuery: () => PromptHistoryQuery | undefined
  /** Maximum unique results returned for one search scope. */
  readonly maxEntries: number
  /** Maximum prior sessions inspected by one lazy scan. */
  readonly maxSessions: number
  /** Maximum simultaneous exact prior-session reads. */
  readonly readConcurrency: number
}

interface IndexedPromptHistoryEntry extends PromptHistoryEntry {
  readonly tieBreaker: string
}

/**
 * Lazy prompt-history corpus shared by every Ctrl+R dialog in one TUI.
 * Current-session inputs are synchronous; prior sessions fill progressively.
 */
export class PromptHistory {
  private readonly cwdKey: string
  private readonly bySession = new Map<SessionId, Map<string, IndexedPromptHistoryEntry>>()
  private readonly listeners = new Set<() => void>()
  private readonly scanAbort = new AbortController()
  private currentEventCount = -1
  private scanPromise: Promise<void> | undefined
  private notifyQueued = false
  private disposed = false
  private state: PromptHistoryLoadState = 'idle'
  private failure: unknown

  constructor(private readonly options: PromptHistoryOptions) {
    this.cwdKey = workspaceKey(options.cwd)
    positiveInteger(options.maxEntries, 'maxEntries')
    positiveInteger(options.maxSessions, 'maxSessions')
    positiveInteger(options.readConcurrency, 'readConcurrency')
    this.refreshCurrentSession()
  }

  /** Current lazy-discovery state. */
  get loadState(): PromptHistoryLoadState {
    return this.state
  }

  /** Last corpus-listing failure while {@link loadState} is `failed`. */
  get loadFailure(): unknown {
    return this.failure
  }

  /**
   * Append an accepted input unless it exactly repeats the preceding input.
   * @param text - Editor text after the TUI's normal trim validation.
   */
  record(text: string): void {
    if (this.disposed) return
    const normalized = text.trim()
    if (normalized === '') return
    const previous = this.options.events().findLast(event => event.type === 'tui/input')
    if (previous?.type === 'tui/input' && previous.data.text === normalized) return
    this.options.appendInput(normalized)
    this.refreshCurrentSession()
    this.scheduleChange()
  }

  /**
   * Return newest-first, duplicate-collapsed entries for one scope and query.
   * @param scope - Current session, normalized current project, or all projects.
   * @param query - Case-insensitive literal substring typed in the dialog.
   * @returns at most the configured number of matching entries.
   */
  list(scope: PromptHistoryScope, query: string): PromptHistoryEntry[] {
    this.refreshCurrentSession()
    const foldedQuery = query.toLocaleLowerCase()
    const candidates: IndexedPromptHistoryEntry[] = []
    for (const entries of this.bySession.values()) {
      for (const entry of entries.values()) {
        if (scope === 'session' && entry.sessionId !== this.options.sessionId) continue
        if (scope === 'project' && (entry.cwd === undefined || workspaceKey(entry.cwd) !== this.cwdKey)) continue
        if (foldedQuery !== '' && !entry.text.toLocaleLowerCase().includes(foldedQuery)) continue
        candidates.push(entry)
      }
    }
    candidates.sort((left, right) => compareRecency(right, left))
    const seen = new Set<string>()
    const result: PromptHistoryEntry[] = []
    for (const entry of candidates) {
      if (seen.has(entry.text)) continue
      seen.add(entry.text)
      result.push(entry)
      if (result.length >= this.options.maxEntries) break
    }
    return result
  }

  /** Start or retry lazy prior-session discovery without awaiting it. */
  ensureLoaded(): void {
    if (this.disposed || this.state === 'complete' || this.scanPromise !== undefined) return
    const query = this.options.sessionQuery()
    if (query === undefined) {
      this.state = 'unavailable'
      this.failure = undefined
      this.scheduleChange()
      return
    }
    this.state = 'loading'
    this.failure = undefined
    this.scheduleChange()
    this.scanPromise = this.scan(query, this.scanAbort.signal).then(
      () => {
        if (this.disposed) return
        this.state = 'complete'
        this.failure = undefined
      },
      (error: unknown) => {
        if (this.disposed || this.scanAbort.signal.aborted) return
        this.state = 'failed'
        this.failure = error
      },
    ).finally(() => {
      this.scanPromise = undefined
      this.scheduleChange()
    })
  }

  /**
   * Observe corpus or load-state changes.
   * @param listener - Synchronous invalidation callback.
   * @returns disposer that removes the callback.
   */
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Abort owned discovery, clear retained prompts, and silence listeners. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scanAbort.abort(new Error('prompt history disposed'))
    this.bySession.clear()
    this.listeners.clear()
  }

  private refreshCurrentSession(): void {
    if (this.disposed) return
    const events = this.options.events()
    if (events.length === this.currentEventCount) return
    this.currentEventCount = events.length
    this.indexSession(this.options.sessionId, this.options.cwd, events)
  }

  private indexSession(sessionId: SessionId, cwd: string | undefined, events: readonly SessionEvent[]): void {
    const entries = new Map<string, IndexedPromptHistoryEntry>()
    const firstExact = events.find(event => event.type === 'tui/input')?.seq
    for (const event of events) {
      let text: string | undefined
      if (event.type === 'tui/input') text = event.data.text
      else if (firstExact === undefined || event.seq < firstExact) text = legacyInput(event)
      if (text === undefined || text.trim() === '') continue
      const candidate: IndexedPromptHistoryEntry = {
        text,
        time: event.time,
        sessionId,
        ...(cwd === undefined ? {} : { cwd }),
        tieBreaker: `${sessionId}:${String(event.seq).padStart(12, '0')}`,
      }
      const prior = entries.get(text)
      if (prior === undefined || compareRecency(prior, candidate) < 0) entries.set(text, candidate)
    }
    const retained = [...entries.values()]
      .sort((left, right) => compareRecency(right, left))
      .slice(0, this.options.maxEntries)
    this.bySession.set(sessionId, new Map(retained.map(entry => [entry.text, entry])))
  }

  private async scan(query: PromptHistoryQuery, signal: AbortSignal): Promise<void> {
    const listed = await query.listSessions(signal)
    signal.throwIfAborted()
    const prior = listed.filter(record => record.header.id !== this.options.sessionId)
    const sameProject = prior.filter(record =>
      record.header.cwd !== undefined && workspaceKey(record.header.cwd) === this.cwdKey)
    // Reserve only half the bounded scan for same-project sessions. The
    // default scope gets local history immediately, while the all-projects
    // scope cannot be starved by a workspace with a long session history.
    const localCount = Math.min(sameProject.length, Math.ceil(this.options.maxSessions / 2))
    const candidates = sameProject.slice(0, localCount)
    const selected = new Set(candidates.map(record => record.header.id))
    for (const record of prior) {
      if (candidates.length >= this.options.maxSessions) break
      if (selected.has(record.header.id)) continue
      selected.add(record.header.id)
      candidates.push(record)
    }
    let cursor = 0
    const readNext = async (): Promise<void> => {
      while (cursor < candidates.length) {
        signal.throwIfAborted()
        const record = candidates[cursor]
        cursor += 1
        if (record === undefined) continue
        try {
          const snapshot = await query.readSession(record.header.id)
          signal.throwIfAborted()
          this.indexSession(snapshot.session.id, snapshot.session.cwd, snapshot.events)
          this.scheduleChange()
        } catch (_error: unknown) {
          signal.throwIfAborted()
          // One unavailable legacy session is advisory and does not stop the corpus scan.
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(this.options.readConcurrency, candidates.length) },
      () => readNext(),
    ))
  }

  private scheduleChange(): void {
    if (this.disposed || this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (this.disposed) return
      for (const listener of this.listeners) {
        try {
          listener()
        } catch (_listenerFailure: unknown) {
          // An invalidation observer cannot break history discovery or later observers.
        }
      }
    })
  }
}

function legacyInput(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind === 'user') {
      const text = contentText(event.data.content).trim()
      // Historical `/skill:` submissions were persisted only after expansion,
      // so their original command cannot be reconstructed without inventing
      // input. Exact `tui/input` events preserve new invocations verbatim.
      if (/^<skill name="[^"]+">\n[\s\S]*\n<\/skill>(?:\n\n[\s\S]*)?$/u.test(text)) return undefined
      return text
    }
    const shell = parseUserShellResultMessage(event.data)
    return shell === undefined ? undefined : `! ${shell.command}`
  }
  if (event.type === 'command/run') {
    return `/${event.data.name}${event.data.args ?? ''}`
  }
  return undefined
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`prompt history ${label} must be a positive safe integer`)
  }
}

function compareRecency(left: IndexedPromptHistoryEntry, right: IndexedPromptHistoryEntry): number {
  return left.time - right.time || left.tieBreaker.localeCompare(right.tieBreaker)
}
