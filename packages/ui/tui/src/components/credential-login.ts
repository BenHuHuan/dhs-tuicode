/** Secure, write-only credential prompt for the terminal front door. */

import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import { renderDialog } from './dialogs.ts'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  sanitizePastedText,
} from './text.ts'
import type { Palette } from './theme.ts'

const MAX_CREDENTIAL_LENGTH = 4096

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Masked API-token editor whose value is exposed only to its save callback. */
export class CredentialLoginDialog implements Component, Focusable {
  focused = false
  private value = ''
  private error = ''
  private saving = false
  private readingClipboard = false
  private pasteBuffer: string | undefined

  constructor(
    private readonly configured: boolean,
    private readonly source: string | undefined,
    private readonly palette: Palette,
    private readonly save: (value: string) => Promise<void>,
    private readonly cancel: () => void,
    private readonly redraw: () => void,
    private readonly readClipboard?: () => Promise<string | undefined>,
  ) {}

  invalidate(): void {}

  private append(value: string): void {
    const clean = sanitizePastedText(value).replaceAll('\r', '').replaceAll('\n', '').trim()
    if (clean === '') return
    this.value = `${this.value}${clean}`.slice(0, MAX_CREDENTIAL_LENGTH)
    this.error = ''
    this.redraw()
  }

  private consumePaste(data: string): boolean {
    if (this.pasteBuffer === undefined) {
      const start = data.indexOf(BRACKETED_PASTE_START)
      if (start === -1) return false
      if (start > 0) this.append(data.slice(0, start))
      this.pasteBuffer = data.slice(start + BRACKETED_PASTE_START.length)
    } else {
      this.pasteBuffer += data
    }
    const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END)
    if (end === -1) return true
    const pasted = this.pasteBuffer.slice(0, end)
    const remaining = this.pasteBuffer.slice(end + BRACKETED_PASTE_END.length)
    this.pasteBuffer = undefined
    this.append(pasted)
    if (remaining !== '') this.handleInput(remaining)
    return true
  }

  handleInput(data: string): void {
    if (this.saving || this.readingClipboard) return
    if (this.consumePaste(data)) return
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.value = Array.from(this.value).slice(0, -1).join('')
      this.error = ''
      this.redraw()
      return
    }
    if (matchesKey(data, Key.ctrl('v'))) {
      if (this.readClipboard === undefined) {
        this.error = 'Clipboard reading is unavailable; use the terminal paste shortcut instead.'
        this.redraw()
        return
      }
      this.readingClipboard = true
      this.error = ''
      this.redraw()
      void this.readClipboard().then((value) => {
        this.readingClipboard = false
        if (value === undefined || value === '') {
          this.error = 'The clipboard contains no text.'
          this.redraw()
          return
        }
        this.append(value)
      }, (error: unknown) => {
        this.readingClipboard = false
        this.error = messageOf(error)
        this.redraw()
      })
      return
    }
    if (matchesKey(data, Key.enter)) {
      const value = this.value.trim()
      if (value === '') {
        this.error = 'Enter an API token before saving.'
        this.redraw()
        return
      }
      this.saving = true
      this.error = ''
      this.redraw()
      void this.save(value).catch((error: unknown) => {
        this.saving = false
        this.error = messageOf(error)
        this.redraw()
      })
      return
    }
    this.append(data)
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const masked = '•'.repeat(Math.min(Array.from(this.value).length, Math.max(1, innerWidth - 2)))
    const current = this.configured
      ? `Current token: configured${this.source === undefined ? '' : ` (${this.source})`}`
      : 'Current token: not configured'
    return renderDialog('DeepSeek login', [
      this.palette.dim('The token is stored in $DSH_HOME/.credentials.yaml and reused after restart.'),
      this.palette.dim(current),
      '',
      truncateToWidth(`> ${masked}`, innerWidth, ''),
      ...this.error === '' ? [] : ['', this.palette.error(this.error)],
      '',
      this.palette.dim(this.saving ? 'Saving…'
        : this.readingClipboard ? 'Reading clipboard…'
          : 'Ctrl+V paste · Enter save · Esc cancel · input is hidden'),
    ], width, this.palette)
  }
}
