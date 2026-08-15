/** Keyboard dialogs for workspace diff inspection and checkpoint rewind. */

import {
  Key,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui'
import type { WorkspaceCheckpoint, WorkspaceDiff } from '../runtime.ts'
import { renderDialog } from './dialogs.ts'
import { displayText } from './text.ts'
import { dialogSelectTheme, type Palette } from './theme.ts'

/** One explicit rewind target selected after its checkpoint. */
export type WorkspaceRewindAction = 'workspace' | 'conversation' | 'both'

/** Host capabilities determining which rewind actions are truthful. */
export interface WorkspaceRewindCapabilities {
  /** The selected checkpoint contains a Git worktree snapshot. */
  readonly workspace: boolean
  /** The active host can fork the current session at the captured boundary. */
  readonly conversation: boolean
}

function plural(value: number, word: string): string {
  return `${String(value)} ${word}${value === 1 ? '' : 's'}`
}

function checkpointLabel(checkpoint: WorkspaceCheckpoint): string {
  return checkpoint.label === undefined || checkpoint.label.trim() === ''
    ? `Checkpoint ${String(checkpoint.id).slice(-8)}`
    : displayText(checkpoint.label)
}

function checkpointDescription(checkpoint: WorkspaceCheckpoint): string {
  const time = new Date(checkpoint.createdAt).toLocaleString('en-CA', { hour12: false })
  const workspace = checkpoint.workspace.kind === 'git'
    ? `Git · ${plural(checkpoint.workspace.trackedFiles ?? 0, 'tracked file')} · ${plural(checkpoint.workspace.untrackedFiles ?? 0, 'untracked file')}`
    : 'Conversation only'
  return `${time} · event ${String(checkpoint.sessionBoundary)} · ${workspace}`
}

/** Scrollable pager for a non-mutating Git worktree diff. */
export class WorkspaceDiffDialog implements Component {
  private offset = 0
  private maxOffset = 0
  private bodyCapacity = 1

  /**
   * @param diff - Diff lines from the host-owned Git reader.
   * @param viewportRows - Live terminal height used to size the pager.
   * @param palette - Terminal semantic colors.
   * @param close - Dismisses the pager without changing the workspace.
   */
  constructor(
    private readonly diff: WorkspaceDiff,
    private readonly viewportRows: () => number,
    private readonly palette: Palette,
    private readonly close: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data.toLocaleLowerCase() === 'q') {
      this.close()
      return
    }
    if (matchesKey(data, Key.up)) this.scrollBy(-1)
    else if (matchesKey(data, Key.down)) this.scrollBy(1)
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.bodyCapacity)
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyCapacity)
    else if (matchesKey(data, Key.home)) this.scrollTo(0)
    else if (matchesKey(data, Key.end)) this.scrollTo(this.maxOffset)
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const lines = this.diff.lines.flatMap(line => wrapTextWithAnsi(this.colorLine(displayText(line)), innerWidth))
    this.bodyCapacity = Math.max(1, this.viewportRows() - 8)
    this.maxOffset = Math.max(0, lines.length - this.bodyCapacity)
    this.offset = Math.min(this.offset, this.maxOffset)
    const hasAbove = this.offset > 0
    const hasBelow = this.offset < this.maxOffset
    const position = lines.length === 0 ? 'empty' : `${String(this.offset + 1)}–${String(Math.min(lines.length, this.offset + this.bodyCapacity))} of ${String(lines.length)}`
    const body = [
      this.palette.dim(`${plural(this.diff.changedFiles, 'changed file')} · ${position}`),
      '',
      ...lines.slice(this.offset, this.offset + this.bodyCapacity),
      '',
      this.palette.dim(`${hasAbove ? '↑ ' : '  '}${hasBelow ? '↓ ' : '  '}↑/↓ scroll · PgUp/PgDn page · Home/End · q/Esc close`),
    ]
    return renderDialog(this.diff.title, body, width, this.palette)
  }

  private colorLine(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) return this.palette.success(line)
    if (line.startsWith('-') && !line.startsWith('---')) return this.palette.error(line)
    if (line.startsWith('@@')) return this.palette.accent(line)
    if (line.startsWith('diff --git') || line === 'Staged changes' || line === 'Unstaged changes' || line === 'Untracked files') {
      return this.palette.bold(this.palette.accent(line))
    }
    return line
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.offset + delta)
  }

  private scrollTo(offset: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset, offset))
  }
}

/** Selector for session-owned manual checkpoints. */
export class WorkspaceCheckpointPickerDialog implements Component {
  private readonly list: SelectList

  /**
   * @param checkpoints - Checkpoints ordered newest first.
   * @param maxVisible - Maximum visible rows before selector scrolling.
   * @param palette - Terminal semantic colors.
   * @param done - Receives the selected checkpoint.
   * @param cancel - Dismisses selection.
   */
  constructor(
    checkpoints: readonly WorkspaceCheckpoint[],
    maxVisible: number,
    private readonly palette: Palette,
    done: (checkpoint: WorkspaceCheckpoint) => void,
    cancel: () => void,
  ) {
    const items: SelectItem[] = checkpoints.map((checkpoint, index) => ({
      value: String(index),
      label: checkpointLabel(checkpoint),
      description: checkpointDescription(checkpoint),
    }))
    this.list = new SelectList(items, maxVisible, dialogSelectTheme(palette))
    this.list.onSelect = (item) => {
      const checkpoint = checkpoints[Number(item.value)]
      if (checkpoint !== undefined) done(checkpoint)
    }
    this.list.onCancel = cancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) this.list.handleInput(Key.escape)
    else this.list.handleInput(data)
    this.list.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog('Select checkpoint to rewind', [
      ...this.list.render(innerWidth),
      '',
      this.palette.warning('Rewind always asks for a second confirmation.'),
      this.palette.dim('↑/↓ move · Enter choose · Esc cancel'),
    ], width, this.palette)
  }
}

/** Choose whether one rewind restores code, conversation, or both. */
export class WorkspaceRewindActionDialog implements Component {
  private readonly list: SelectList

  /**
   * @param checkpoint - Selected durable checkpoint.
   * @param capabilities - Actions the current host can actually perform.
   * @param maxVisible - Maximum visible selector rows.
   * @param palette - Terminal semantic colors.
   * @param done - Receives the explicit selected action.
   * @param cancel - Dismisses without mutation.
   */
  constructor(
    checkpoint: WorkspaceCheckpoint,
    capabilities: WorkspaceRewindCapabilities,
    maxVisible: number,
    private readonly palette: Palette,
    done: (action: WorkspaceRewindAction) => void,
    cancel: () => void,
  ) {
    const items: SelectItem[] = [
      ...(capabilities.workspace ? [{
        value: 'workspace',
        label: 'Restore workspace files',
        description: 'Restore this Git checkpoint; first save the current workspace as a safety checkpoint',
      }] : []),
      ...(capabilities.conversation ? [{
        value: 'conversation',
        label: 'Branch conversation only',
        description: `Open a child session through event ${String(checkpoint.sessionBoundary)}; keep this session resumable`,
      }] : []),
      ...(capabilities.workspace && capabilities.conversation ? [{
        value: 'both',
        label: 'Restore files and branch conversation',
        description: 'Apply both actions after confirmation',
      }] : []),
    ]
    this.list = new SelectList(items, maxVisible, dialogSelectTheme(palette))
    this.list.onSelect = (item) => { done(item.value as WorkspaceRewindAction) }
    this.list.onCancel = cancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) this.list.handleInput(Key.escape)
    else this.list.handleInput(data)
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog('Choose rewind action', [
      ...this.list.render(innerWidth),
      '',
      this.palette.dim('↑/↓ move · Enter choose · Esc cancel'),
    ], width, this.palette)
  }
}

/** Final destructive action guard; only an explicit `y` proceeds. */
export class WorkspaceRewindConfirmDialog implements Component {
  /**
   * @param checkpoint - Checkpoint about to be restored.
   * @param action - Chosen workspace/conversation action.
   * @param palette - Terminal semantic colors.
   * @param confirm - Commits the already-selected action.
   * @param cancel - Rejects the operation.
   */
  constructor(
    private readonly checkpoint: WorkspaceCheckpoint,
    private readonly action: WorkspaceRewindAction,
    private readonly palette: Palette,
    private readonly confirm: () => void,
    private readonly cancel: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (data.toLocaleLowerCase() === 'y') this.confirm()
    else if (data.toLocaleLowerCase() === 'n' || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.cancel()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const workspace = this.action === 'workspace' || this.action === 'both'
    const conversation = this.action === 'conversation' || this.action === 'both'
    const body = [
      ...wrapTextWithAnsi(checkpointLabel(this.checkpoint), innerWidth),
      '',
      ...(workspace ? [this.palette.warning('Workspace files will be replaced with the selected Git snapshot.'), this.palette.dim('A pre-rewind safety checkpoint is created first.')] : []),
      ...(conversation ? [this.palette.warning('A child session will replace this terminal view.'), this.palette.dim('The current session remains resumable.')] : []),
      '',
      this.palette.dim('y confirm · n/Esc cancel'),
    ]
    return renderDialog('Confirm rewind?', body, width, this.palette)
  }
}
