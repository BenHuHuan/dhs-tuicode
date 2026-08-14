/** Full-viewport Ctrl+R prompt-history search dialog. */

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import type {
  PromptHistoryEntry,
  PromptHistoryLoadState,
  PromptHistoryScope,
} from '../chat/prompt-history.ts'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  displayText,
  sanitizePastedText,
} from './text.ts'
import type { Palette } from './theme.ts'

/** Live corpus view read by {@link HistorySearchDialog}. */
export interface HistorySearchSource {
  /** Return current entries for one scope and literal query. */
  readonly list: (scope: PromptHistoryScope, query: string) => PromptHistoryEntry[]
  /** Return the current cross-session loading state. */
  readonly state: () => PromptHistoryLoadState
  /** Render the latest discovery failure, when present. */
  readonly failure: () => string | undefined
}

/** How an accepted history item returns to the editor. */
export type HistorySearchAcceptance = 'insert' | 'submit'

/**
 * Search current-session, current-project, or all-project prompt history.
 * The source remains live while older sessions load; acceptance never waits.
 */
export class HistorySearchDialog implements Component, Focusable {
  private readonly search = new Input()
  private pasteBuffer: string | undefined
  private selectedIndex = 0
  private error = ''
  private scope: PromptHistoryScope = 'session'
  focused = false

  constructor(
    private readonly source: HistorySearchSource,
    private readonly maxVisible: number,
    private readonly currentWorkspace: string,
    private readonly workspaceLabel: (cwd: string | undefined) => string,
    private readonly viewportRows: () => number,
    private readonly palette: Palette,
    private readonly done: (entry: PromptHistoryEntry, acceptance: HistorySearchAcceptance) => void,
    private readonly cancel: () => void,
  ) {}

  invalidate(): void {
    this.search.invalidate()
  }

  private filtered(): PromptHistoryEntry[] {
    return this.source.list(this.scope, this.search.getValue())
  }

  private visibleEntryCount(): number {
    const entryBudget = Math.max(1, Math.floor((Math.max(1, this.viewportRows()) - 13) / 2))
    return Math.min(this.maxVisible, entryBudget)
  }

  private handleBracketedPaste(data: string): boolean {
    const start = data.indexOf(BRACKETED_PASTE_START)
    if (this.pasteBuffer === undefined && start < 0) return false
    if (this.pasteBuffer === undefined) {
      const prefix = data.slice(0, start)
      if (prefix !== '') this.handleInput(prefix)
      this.pasteBuffer = data.slice(start + BRACKETED_PASTE_START.length)
    } else {
      this.pasteBuffer += data
    }
    const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END)
    if (end < 0) return true
    const pasted = sanitizePastedText(this.pasteBuffer.slice(0, end))
    const remaining = this.pasteBuffer.slice(end + BRACKETED_PASTE_END.length)
    this.pasteBuffer = undefined
    const previous = this.search.getValue()
    this.search.handleInput(`${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}`)
    if (this.search.getValue() !== previous) this.resetSelection()
    if (remaining !== '') this.handleInput(remaining)
    this.invalidate()
    return true
  }

  handleInput(data: string): void {
    if (this.handleBracketedPaste(data)) return
    const filtered = this.filtered()
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.escape)) {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.backspace) && this.search.getValue() === '') {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = filtered.length === 0
        ? 0
        : (this.selectedIndex + filtered.length - 1) % filtered.length
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = filtered.length === 0 ? 0 : (this.selectedIndex + 1) % filtered.length
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleEntryCount())
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(
        Math.max(0, filtered.length - 1),
        this.selectedIndex + this.visibleEntryCount(),
      )
    } else if (matchesKey(data, Key.ctrl('s'))) {
      this.scope = nextScope(this.scope)
      this.resetSelection()
    } else if (matchesKey(data, Key.tab)) {
      this.accept(filtered, 'insert')
    } else if (matchesKey(data, Key.enter)) {
      this.accept(filtered, 'submit')
    } else {
      const previous = this.search.getValue()
      this.search.focused = this.focused
      this.search.handleInput(data)
      if (this.search.getValue() !== previous) this.resetSelection()
    }
    this.invalidate()
  }

  private accept(entries: readonly PromptHistoryEntry[], acceptance: HistorySearchAcceptance): void {
    const selected = entries[this.selectedIndex]
    if (selected === undefined) this.error = 'No prompt matches this search.'
    else this.done(selected, acceptance)
  }

  private resetSelection(): void {
    this.selectedIndex = 0
    this.error = ''
  }

  private renderScopeLine(): string {
    const counts = {
      session: this.source.list('session', '').length,
      project: this.source.list('project', '').length,
      all: this.source.list('all', '').length,
    }
    const active = this.scope === 'session'
      ? `this session (${counts.session})`
      : this.scope === 'project'
        ? `this project ${displayText(this.currentWorkspace)} (${counts.project})`
        : `all projects (${counts.all})`
    const next = nextScope(this.scope)
    const nextLabel = next === 'session' ? `this session (${counts.session})`
      : next === 'project' ? `this project (${counts.project})`
        : `all projects (${counts.all})`
    return `${this.palette.accent(active)}${this.palette.dim(`  ^S ${nextLabel}`)}`
  }

  render(width: number): string[] {
    this.search.focused = this.focused
    const height = Math.max(1, this.viewportRows())
    const horizontalPadding = width >= 12 ? 2 : 0
    const contentWidth = Math.max(1, width - horizontalPadding * 2)
    const indent = ' '.repeat(horizontalPadding)
    const filtered = this.filtered()
    if (this.selectedIndex >= filtered.length) this.selectedIndex = Math.max(0, filtered.length - 1)
    const selected = filtered[this.selectedIndex]
    const position = selected === undefined ? 0 : this.selectedIndex + 1
    const lines: string[] = [
      '',
      `${indent}${this.palette.bold(this.palette.accent(`History search (${position} of ${filtered.length})`))}`,
      '',
    ]
    const searchInnerWidth = Math.max(1, contentWidth - 4)
    lines.push(`${indent}${this.palette.dim(`╭${'─'.repeat(Math.max(0, contentWidth - 2))}╮`)}`)
    const searchContent = this.search.render(searchInnerWidth).join('').replace(/^> /u, '⌕ ')
    const clippedSearch = truncateToWidth(searchContent, searchInnerWidth, '')
    lines.push(
      `${indent}${this.palette.dim('│')} ${clippedSearch}${' '.repeat(Math.max(0, searchInnerWidth - visibleWidth(clippedSearch)))} ${this.palette.dim('│')}`,
      `${indent}${this.palette.dim(`╰${'─'.repeat(Math.max(0, contentWidth - 2))}╯`)}`,
      '',
      `${indent}${this.renderScopeLine()}`,
      '',
    )

    const visibleCount = this.visibleEntryCount()
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(visibleCount / 2),
      filtered.length - visibleCount,
    ))
    const end = Math.min(filtered.length, start + visibleCount)
    const push = (line: string): void => {
      lines.push(`${indent}${truncateToWidth(line, contentWidth, '…')}`)
    }
    const query = this.search.getValue()
    for (let index = start; index < end; index += 1) {
      const entry = filtered[index] as PromptHistoryEntry
      const active = index === this.selectedIndex
      const lead = `${active ? '❯' : ' '} ${highlightPrompt(entry.text, query, this.palette)}`
      push(active ? this.palette.bold(this.palette.accent(lead)) : lead)
      const origin = this.scope === 'all'
        ? ` · ${displayText(this.workspaceLabel(entry.cwd))}`
        : ''
      push(this.palette.dim(`  ${new Date(entry.time).toISOString()}${origin}`))
    }
    if (filtered.length === 0) push(this.palette.warning('No matching prompts.'))
    const state = this.source.state()
    if (state === 'loading') push(this.palette.dim('Loading older history…'))
    else if (state === 'unavailable' && this.scope !== 'session') {
      push(this.palette.warning('Cross-session history is unavailable in this runtime.'))
    } else if (state === 'failed' && this.scope !== 'session') {
      push(this.palette.warning(`Older history scan failed: ${displayText(this.source.failure() ?? 'unknown error')}`))
    }
    if (this.error !== '') {
      lines.push('')
      push(this.palette.error(displayText(this.error)))
    }

    const footer = `${indent}${this.palette.dim('Type to search  •  ↑/↓ navigate  •  Ctrl+S scope  •  Tab insert  •  Enter run  •  Esc cancel')}`
    while (lines.length < height - 2) lines.push('')
    lines.push(footer, '')
    return lines.slice(0, height)
  }
}

function nextScope(scope: PromptHistoryScope): PromptHistoryScope {
  return scope === 'session' ? 'project' : scope === 'project' ? 'all' : 'session'
}

function highlightPrompt(text: string, query: string, palette: Palette): string {
  const line = displayText(text.replace(/\s+/gu, ' '))
  if (query === '') return line
  const index = line.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0) return line
  return `${line.slice(0, index)}${palette.bold(palette.accent(line.slice(index, index + query.length)))}${line.slice(index + query.length)}`
}
