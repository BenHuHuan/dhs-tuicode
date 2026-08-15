import { describe, expect, it } from 'vitest'
import { createPalette, paletteSpec } from '../src/components/theme.ts'

describe('TUI palette', () => {
  it('uses DeepSeek blue and violet as the default dark truecolor palette', () => {
    const colors = paletteSpec('dark', 'deepseek', true).colors
    expect(colors.brand.open).toBe('38;2;77;107;254')
    expect(colors.accent.open).toBe('38;2;139;92;246')
    expect(colors.code.open).toBe('38;2;56;189;248')
  })
  it('pins the Claude truecolor roles on dark terminals', () => {
    const colors = paletteSpec('dark', 'claude', true).colors
    expect(colors.accent.open).toBe('38;2;215;119;87')
    expect(colors.dim.open).toBe('38;2;118;118;118')
    expect(colors.success.open).toBe('38;2;78;186;101')
    expect(colors.warning.open).toBe('38;2;255;193;7')
    expect(colors.error.open).toBe('38;2;255;107;128')
    expect(colors.code.open).toBe('38;2;175;135;255')
  })

  it('darkens the Claude roles for light terminals', () => {
    const colors = paletteSpec('light', 'claude', true).colors
    expect(colors.accent.open).toBe('38;2;180;83;9')
    expect(colors.code.open).toBe('38;2;124;58;237')
  })

  it('degrades claude to bright ANSI approximations without truecolor', () => {
    const dark = paletteSpec('dark', 'claude', false).colors
    expect(dark.accent.open).toBe('33')
    expect(dark.code.open).toBe('95')
    expect(dark.error.open).toBe('91')
    const light = paletteSpec('light', 'claude', false).colors
    expect(light.code.open).toBe('34')
  })

  it('keeps the adaptive style on terminal-ANSI roles only', () => {
    const dark = paletteSpec('dark', 'adaptive', true).colors
    expect(dark.accent.open).toBe('95')
    expect(dark.code.open).toBe('36')
    const light = paletteSpec('light', 'adaptive', true).colors
    expect(light.code.open).toBe('34')
  })

  it('passes text through unchanged when color is disabled', () => {
    const palette = createPalette(false)
    expect(palette.accent('x')).toBe('x')
    expect(palette.bold(palette.dim('x'))).toBe('x')
  })
})
