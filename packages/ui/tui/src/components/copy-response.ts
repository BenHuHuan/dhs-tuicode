/**
 * Keyboard surfaces for copying or writing either a complete assistant reply
 * or one fenced code block from it.
 * @module @deepseek-ai/dsh-tui/components/copy-response
 */

import {
  Input,
  Key,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui'
import type { AssistantCodeBlock } from '../chat/assistant-responses.ts'
import { displayText } from './text.ts'
import { renderDialog } from './dialogs.ts'
import { dialogSelectTheme, type Palette } from './theme.ts'

/** Text target selected from the copy-response dialog. */
export interface CopyResponseSelection {
  /** Human-facing target label used by completion notices. */
  readonly label: string
  /** Exact text handed to the clipboard or file writer. */
  readonly text: string
}

/** Operation chosen for one response target. */
export interface CopyResponseAction {
  readonly kind: 'copy' | 'write'
  readonly selection: CopyResponseSelection
}

function characterCount(value: string): string {
  const count = Array.from(value).length
  return `${String(count)} character${count === 1 ? '' : 's'}`
}

function codeDescription(block: AssistantCodeBlock): string {
  const language = block.language === undefined ? 'plain text' : displayText(block.language)
  const preview = block.text.split(/\r?\n/u).find(line => line.trim() !== '')?.trim()
  return preview === undefined
    ? `${language} · empty`
    : `${language} · ${displayText(preview)}`
}

/** Complete-response/code-block selector opened only when copyable fences exist. */
export class CopyResponseDialog implements Component {
  private readonly selections: CopyResponseSelection[]
  private readonly list: SelectList
  private readonly writeSelection: (selection: CopyResponseSelection) => void

  constructor(
    responseText: string,
    codeBlocks: readonly AssistantCodeBlock[],
    private readonly ordinal: number,
    maxVisible: number,
    private readonly palette: Palette,
    done: (action: CopyResponseAction) => void,
    cancel: () => void,
  ) {
    this.writeSelection = (selection) => { done({ kind: 'write', selection }) }
    this.selections = [
      { label: `full response #${String(ordinal)}`, text: responseText },
      ...codeBlocks.map(block => ({
        label: `code block ${String(block.index)} from response #${String(ordinal)}`,
        text: block.text,
      })),
    ]
    const items: SelectItem[] = [
      {
        value: '0',
        label: 'Full response',
        description: characterCount(responseText),
      },
      ...codeBlocks.map((block, index): SelectItem => ({
        value: String(index + 1),
        label: `Code block ${String(block.index)}`,
        description: codeDescription(block),
      })),
    ]
    this.list = new SelectList(items, maxVisible, dialogSelectTheme(palette))
    this.list.onSelect = (item) => {
      const selection = this.selections[Number(item.value)]
      /* v8 ignore next -- item values are constructed from `selections`. */
      if (selection !== undefined) done({ kind: 'copy', selection })
    }
    this.list.onCancel = cancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (data.toLowerCase() === 'w') {
      const item = this.list.getSelectedItem()
      const selection = item === null ? undefined : this.selections[Number(item.value)]
      /* v8 ignore next -- the picker always contains the full-response item. */
      if (selection !== undefined) this.doneWrite(selection)
    } else if (matchesKey(data, Key.ctrl('c'))) this.list.handleInput(Key.escape)
    else this.list.handleInput(data)
    this.invalidate()
  }

  private doneWrite(selection: CopyResponseSelection): void {
    // `onSelect` owns Enter; retain a parallel callback so `w` always acts on
    // the exact highlighted row.
    this.writeSelection(selection)
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog(`Copy response #${String(this.ordinal)}`, [
      ...this.list.render(innerWidth),
      '',
      this.palette.dim('↑/↓ move · Enter copy · w write file · Esc cancel'),
    ], width, this.palette)
  }
}

/** One-line path prompt used after the picker selects its `w` action. */
export class CopyResponsePathDialog implements Component, Focusable {
  private readonly input = new Input()
  private error = ''
  focused = false

  constructor(
    private readonly selection: CopyResponseSelection,
    private readonly cwd: string,
    private readonly palette: Palette,
    done: (path: string) => void,
    cancel: () => void,
  ) {
    this.input.onSubmit = (value) => {
      const path = value.trim()
      if (path === '') {
        this.error = 'Enter a file path before writing.'
        this.invalidate()
        return
      }
      done(path)
    }
    this.input.onEscape = cancel
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    this.input.focused = this.focused
    if (matchesKey(data, Key.ctrl('c'))) this.input.handleInput(Key.escape)
    else this.input.handleInput(data)
    this.invalidate()
  }

  render(width: number): string[] {
    this.input.focused = this.focused
    const innerWidth = Math.max(1, width - 4)
    const body = [
      ...wrapTextWithAnsi(displayText(this.selection.label), innerWidth),
      ...wrapTextWithAnsi(this.palette.dim(`Relative paths use ${displayText(this.cwd)}`), innerWidth),
      '',
      ...this.input.render(innerWidth),
      ...this.error === '' ? [] : ['', this.palette.error(this.error)],
      '',
      this.palette.dim('Enter write · Esc cancel'),
    ]
    return renderDialog('Write response to file', body, width, this.palette)
  }
}

/** Destructive overwrite guard; only an explicit `y` accepts. */
export class CopyResponseOverwriteDialog implements Component {
  constructor(
    private readonly path: string,
    private readonly palette: Palette,
    private readonly confirm: () => void,
    private readonly cancel: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (data.toLowerCase() === 'y') this.confirm()
    else if (
      data.toLowerCase() === 'n'
      || matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl('c'))
    ) this.cancel()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog('Overwrite existing file?', [
      ...wrapTextWithAnsi(displayText(this.path), innerWidth),
      '',
      this.palette.warning('This replaces the file contents.'),
      this.palette.dim('y overwrite · n/Esc cancel'),
    ], width, this.palette)
  }
}
