import { describe, expect, it } from 'vitest'
import { copyableScreenText, sanitizePastedText } from '../src/components/text.ts'

describe('terminal screen copy sanitization', () => {
  it('removes the pi-tui cursor APC instead of exposing pi:c', () => {
    const cursorMarker = '\u001b_pi:c\u0007'
    expect(copyableScreenText(`before${cursorMarker}after`)).toBe('beforeafter')
    expect(sanitizePastedText(`before${cursorMarker}after`)).toBe('beforeafter')
  })

  it('keeps text geometry while treating pixel glyphs as blank cells', () => {
    const rendered = '\u001b[38;2;0;80;255m▀█▟\u001b[0m  label'
    expect(copyableScreenText(rendered)).toBe('     label')
  })

  it('removes OSC, CSI, DCS, and APC payloads from copied screen text', () => {
    const rendered = [
      '\u001b[31mred\u001b[0m',
      '\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007',
      '\u001bPprivate\u001b\\',
      '\u001b_hidden\u001b\\',
    ].join('')
    expect(copyableScreenText(rendered)).toBe('redlink')
  })
})
