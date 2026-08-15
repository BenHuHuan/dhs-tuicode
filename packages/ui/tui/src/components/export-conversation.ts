/** Keyboard selection for exporting a complete terminal conversation. */

import {
  Key,
  SelectList,
  matchesKey,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import { renderDialog } from './dialogs.ts'
import { dialogSelectTheme, type Palette } from './theme.ts'

/** Actions available from the conversation export dialog. */
export type ConversationExportAction = 'copy' | 'write'

/** Host capabilities that determine the export dialog's available actions. */
export interface ConversationExportCapabilities {
  /** The host can receive the complete transcript through its clipboard boundary. */
  readonly copy: boolean
  /** The host can receive the complete transcript through its file-write boundary. */
  readonly write: boolean
}

/** Choose a human-owned destination for a complete conversation export. */
export class ConversationExportDialog implements Component {
  private readonly list: SelectList

  /**
   * @param filename - Relative default used when the user chooses Save.
   * @param maxVisible - Maximum visible actions before the select list scrolls.
   * @param palette - Terminal semantic colors.
   * @param capabilities - Writable host destinations exposed to the user.
   * @param done - Receives one selected export action.
   * @param cancel - Closes the dialog without writing or copying.
   */
  constructor(
    private readonly filename: string,
    maxVisible: number,
    private readonly palette: Palette,
    capabilities: ConversationExportCapabilities,
    done: (action: ConversationExportAction) => void,
    cancel: () => void,
  ) {
    const items: SelectItem[] = [
      ...(capabilities.copy ? [{
        value: 'copy',
        label: 'Copy to clipboard',
        description: 'Copy the complete readable conversation',
      }] : []),
      ...(capabilities.write ? [{
        value: 'write',
        label: 'Save to file',
        description: filename,
      }] : []),
    ]
    this.list = new SelectList(items, maxVisible, dialogSelectTheme(palette))
    this.list.onSelect = (item) => { done(item.value as ConversationExportAction) }
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
    return renderDialog('Export conversation', [
      ...this.list.render(Math.max(1, width - 4)),
      '',
      this.palette.dim(`Save uses ${displayText(this.filename)}; /export <filename> chooses another path.`),
      this.palette.dim('↑/↓ move · Enter select · Esc cancel'),
    ], width, this.palette)
  }
}
