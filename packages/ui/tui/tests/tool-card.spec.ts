import { describe, expect, it } from 'vitest'
import {
  formatToolElapsed,
  toolCardArgSummary,
  toolCardTitle,
} from '../src/components/tool-card.ts'
import { createPalette } from '../src/components/theme.ts'

const palette = createPalette(true, 'dark', 'claude', true)

describe('tool-card headers', () => {
  it('titles known tools with their Claude Code verb and main argument', () => {
    expect(toolCardTitle('bash', { command: 'npm test\n--watch' })).toBe('Run(npm test)')
    expect(toolCardTitle('read', { file_path: '/src/foo/bar.ts' })).toBe('Read(bar.ts)')
    expect(toolCardTitle('glob', { pattern: '**/*.ts' })).toBe('Find(**/*.ts)')
    expect(toolCardTitle('web_fetch', { url: 'https://example.com' })).toBe('Fetch(https://example.com)')
    expect(toolCardTitle('unknown_tool', { path: '/tmp/note.txt' })).toBe('Tool(note.txt)')
  })

  it('uses the generic argument keys for tools without a dedicated summary', () => {
    expect(toolCardArgSummary('mcp_read', { path: '/tmp/note.txt' })).toBe('note.txt')
    expect(toolCardArgSummary('inspect_query', { query: 'status' })).toBe('status')
    expect(toolCardArgSummary('weird', {})).toBeUndefined()
    expect(toolCardArgSummary('bash', 'not an object')).toBeUndefined()
  })

  it('maps tool families to the Claude palette semantic roles', () => {
    expect(palette.warning('Run(ls)')).toContain('\x1b[38;2;255;193;7m')
    expect(palette.success('Search(x)')).toContain('\x1b[38;2;78;186;101m')
    expect(palette.code('Edit(foo.ts)')).toContain('\x1b[38;2;175;135;255m')
    expect(palette.accent('Read(foo.ts)')).toContain('\x1b[38;2;215;119;87m')
  })

  it('formats elapsed times like Claude Code', () => {
    expect(formatToolElapsed(123)).toBe('123ms')
    expect(formatToolElapsed(1_500)).toBe('1.5s')
    expect(formatToolElapsed(61_500)).toBe('1m02s')
    expect(formatToolElapsed(-5)).toBe('0ms')
  })
})
