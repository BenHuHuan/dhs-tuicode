/**
 * Project-scoped direct-shell history and editor completion grammar.
 *
 * The durable `user-shell` notices are the persistence source of truth. A
 * just-submitted command is recorded immediately as well, so cancelled and
 * still-running commands remain available during the current TUI lifetime.
 *
 * @module @deepseek-ai/dsh-tui/chat/shell-autocomplete
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { parseUserShellResultMessage } from './shell-mode.ts'
import { workspaceKey } from './workspace.ts'

/** Maximum unique commands retained for one TUI history view. */
export const DEFAULT_USER_SHELL_HISTORY_MAX_ENTRIES = 100
/** Maximum prior same-project sessions inspected on first history completion. */
export const DEFAULT_USER_SHELL_HISTORY_MAX_SESSIONS = 32
/** Maximum simultaneous exact session reads during lazy history discovery. */
export const DEFAULT_USER_SHELL_HISTORY_READ_CONCURRENCY = 4

/** Minimal optional session-query surface used by history discovery. */
export type UserShellHistoryQuery = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>

/** Construction seams and fixed safety bounds for one project history. */
export interface UserShellHistoryOptions {
  /** Effective working directory of the attached agent. */
  cwd: string
  /** Current session, excluded from the cross-session scan. */
  sessionId: SessionId
  /** Live append-only event snapshot for the current session. */
  events(): readonly SessionEvent[]
  /** Optional query service, re-read lazily because plugins can mount later. */
  sessionQuery(): UserShellHistoryQuery | undefined
  /** Unique command retention bound. */
  maxEntries?: number
  /** Same-project session scan bound. */
  maxSessions?: number
  /** Concurrent exact-read bound. */
  readConcurrency?: number
}

/** A whole-editor shell-history draft ending at the current cursor. */
export interface ActiveUserShellHistoryPrefix {
  /** Complete editor prefix replaced by an accepted history item. */
  prefix: string
  /** Command text after `!` used for exact prefix matching. */
  query: string
}

interface HistoryEntry {
  command: string
  time: number
  tieBreaker: string
}

/**
 * Recognize a direct-shell draft eligible for explicit history completion.
 * A token containing `/` belongs to path completion instead. Completion is
 * whole-draft only, avoiding surprising replacement when the cursor is in the
 * middle of a command.
 * @param lines - Current logical editor lines.
 * @param cursorLine - Logical line containing the cursor.
 * @param cursorCol - Cursor column within that line.
 * @returns the replaceable shell draft and command query, or `undefined` outside history completion.
 */
export function activeUserShellHistoryPrefix(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): ActiveUserShellHistoryPrefix | undefined {
  const currentLine = lines[cursorLine]
  if (currentLine === undefined || cursorLine !== lines.length - 1 || cursorCol !== currentLine.length) {
    return undefined
  }
  const prefix = [...lines.slice(0, cursorLine), currentLine.slice(0, cursorCol)].join('\n')
  if (!prefix.startsWith('!')) return undefined
  const activeToken = currentLine.slice(0, cursorCol).split(/\s/gu).at(-1) ?? ''
  if (activeToken.includes('/')) return undefined
  return {
    prefix,
    query: prefix.slice(1).replace(/^\s+/u, ''),
  }
}

/**
 * Lazy, bounded command history spanning the current project sessions.
 * Reads are advisory: corrupt/unavailable prior sessions are skipped, while a
 * caller abort only cancels that autocomplete wait and leaves the shared scan
 * available for the next keystroke.
 */
export class UserShellHistory {
  private readonly cwdKey: string
  private readonly maxEntries: number
  private readonly maxSessions: number
  private readonly readConcurrency: number
  private readonly entries = new Map<string, HistoryEntry>()
  private readonly scanAbort = new AbortController()
  private currentEventCount = 0
  private localSequence = 0
  private scanPromise: Promise<void> | undefined
  private scanComplete = false
  private disposed = false

  constructor(private readonly options: UserShellHistoryOptions) {
    this.cwdKey = workspaceKey(options.cwd)
    this.maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_USER_SHELL_HISTORY_MAX_ENTRIES,
      'maxEntries',
    )
    this.maxSessions = positiveInteger(
      options.maxSessions ?? DEFAULT_USER_SHELL_HISTORY_MAX_SESSIONS,
      'maxSessions',
    )
    this.readConcurrency = positiveInteger(
      options.readConcurrency ?? DEFAULT_USER_SHELL_HISTORY_READ_CONCURRENCY,
      'readConcurrency',
    )
    this.refreshCurrentSession()
  }

  /**
   * Make a submitted command immediately available, before process settlement.
   * @param command - Exact accepted command without the leading bang.
   * @param time - Recency timestamp; defaults to the current wall clock.
   */
  record(command: string, time = Date.now()): void {
    if (this.disposed || command === '') return
    this.localSequence += 1
    this.upsert({
      command,
      time,
      tieBreaker: `~local:${String(this.localSequence).padStart(12, '0')}`,
    })
    this.trim()
  }

  /**
   * Return newest-first unique commands that begin with the partial command.
   * @param query - Exact command prefix after the leading bang and whitespace.
   * @param signal - Cancels this caller's wait without cancelling shared discovery.
   * @returns bounded matching commands in newest-first order.
   */
  async list(query: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    this.refreshCurrentSession()
    const immediate = this.matchingCommands(query)
    const scan = this.ensureProjectScan()
    // Current-session and just-submitted commands must never wait behind an
    // optional corpus scan. Start discovery for later completions, but return
    // the already useful local result immediately.
    if (immediate.length > 0) return immediate
    if (scan !== undefined) await waitForPromise(scan, signal)
    signal.throwIfAborted()
    this.refreshCurrentSession()
    return this.matchingCommands(query)
  }

  /** Abort owned discovery and make future completion calls inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.scanAbort.abort(new Error('direct-shell history disposed'))
  }

  private refreshCurrentSession(): void {
    if (this.disposed) return
    const events = this.options.events()
    if (events.length < this.currentEventCount) this.currentEventCount = 0
    for (let index = this.currentEventCount; index < events.length; index += 1) {
      const event = events[index]
      if (event !== undefined) this.addEvent(event, this.options.sessionId)
    }
    this.currentEventCount = events.length
    this.trim()
  }

  private ensureProjectScan(): Promise<void> | undefined {
    if (this.disposed || this.scanComplete) return undefined
    if (this.scanPromise !== undefined) return this.scanPromise
    const query = this.options.sessionQuery()
    if (query === undefined) return undefined
    this.scanPromise = this.scanProject(query, this.scanAbort.signal)
      .then(() => { this.scanComplete = true }, () => {})
      .finally(() => {
        this.scanPromise = undefined
        this.trim()
      })
    return this.scanPromise
  }

  private async scanProject(query: UserShellHistoryQuery, signal: AbortSignal): Promise<void> {
    const records = await query.listSessions(signal)
    signal.throwIfAborted()
    const candidates = records.filter(record =>
      record.header.id !== this.options.sessionId
      && record.header.cwd !== undefined
      && workspaceKey(record.header.cwd) === this.cwdKey)
      .slice(0, this.maxSessions)
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
          if (snapshot.session.cwd === undefined || workspaceKey(snapshot.session.cwd) !== this.cwdKey) continue
          for (const event of snapshot.events) this.addEvent(event, snapshot.session.id)
          this.trim()
        } catch (_error: unknown) {
          signal.throwIfAborted()
          // History is advisory; one unreadable session must not block others.
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(this.readConcurrency, candidates.length) },
      () => readNext(),
    ))
  }

  private addEvent(event: SessionEvent, sessionId: SessionId): void {
    if (event.type !== 'user/message') return
    const identity = parseUserShellResultMessage(event.data)
    if (identity === undefined || workspaceKey(identity.workdir) !== this.cwdKey) return
    this.upsert({
      command: identity.command,
      time: event.time,
      tieBreaker: `${sessionId}:${String(event.seq).padStart(12, '0')}`,
    })
  }

  private upsert(candidate: HistoryEntry): void {
    const existing = this.entries.get(candidate.command)
    if (existing !== undefined && compareRecency(existing, candidate) >= 0) return
    this.entries.set(candidate.command, candidate)
  }

  private sortedEntries(): HistoryEntry[] {
    return [...this.entries.values()].sort((left, right) => compareRecency(right, left))
  }

  private matchingCommands(query: string): string[] {
    return this.sortedEntries()
      .filter(entry => entry.command.startsWith(query))
      .map(entry => entry.command)
  }

  private trim(): void {
    for (const entry of this.sortedEntries().slice(this.maxEntries)) this.entries.delete(entry.command)
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`direct-shell history ${label} must be a positive safe integer`)
  }
  return value
}

function compareRecency(left: HistoryEntry, right: HistoryEntry): number {
  return left.time - right.time || left.tieBreaker.localeCompare(right.tieBreaker)
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal.reason))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => { rejectPromise(abortReason(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(errorReason(error, 'direct-shell history scan failed'))
      },
    )
  })
}

function abortReason(reason: unknown): Error {
  return errorReason(reason, 'direct-shell history request aborted')
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason })
}
