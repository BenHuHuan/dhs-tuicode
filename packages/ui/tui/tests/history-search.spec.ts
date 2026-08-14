import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HistorySearchDialog } from '../src/components/history-search.ts'
import { createPalette } from '../src/components/theme.ts'
import type { PromptHistoryEntry, PromptHistoryScope } from '../src/chat/prompt-history.ts'

const sessionId = SessionId('history-session')
const entries: PromptHistoryEntry[] = [
  { text: 'newest deploy prompt', time: 300, sessionId, cwd: '/workspace' },
  { text: 'older multiline\nprompt', time: 200, sessionId, cwd: '/workspace' },
  { text: 'foreign prompt', time: 100, sessionId: SessionId('foreign'), cwd: '/elsewhere' },
]

function fixture(state: 'idle' | 'unavailable' | 'loading' | 'complete' | 'failed' = 'complete') {
  const done = vi.fn()
  const cancel = vi.fn()
  const scopes: PromptHistoryScope[] = []
  const dialog = new HistorySearchDialog(
    {
      list: (scope, query) => {
        scopes.push(scope)
        const scoped = scope === 'session' ? entries.slice(0, 2)
          : scope === 'project' ? entries.slice(0, 2)
            : entries
        return scoped.filter(entry => entry.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      },
      state: () => state,
      failure: () => state === 'failed' ? 'index offline' : undefined,
    },
    8,
    '/workspace',
    cwd => cwd ?? 'cwd unset',
    () => 28,
    createPalette(false),
    done,
    cancel,
  )
  dialog.focused = true
  return { dialog, done, cancel, scopes }
}

describe('HistorySearchDialog', () => {
  it('filters, highlights, navigates, and distinguishes Tab insertion from Enter execution', () => {
    const tab = fixture()
    tab.dialog.handleInput('prompt')
    let rendered = tab.dialog.render(80).join('\n')
    expect(rendered).toContain('History search (1 of 2)')
    expect(rendered).toContain('newest deploy prompt')
    expect(rendered).toContain('this session (2)')
    tab.dialog.handleInput('\x1b[B')
    tab.dialog.handleInput('\t')
    expect(tab.done).toHaveBeenCalledWith(entries[1], 'insert')

    const enter = fixture()
    enter.dialog.handleInput('deploy')
    enter.dialog.handleInput('\r')
    expect(enter.done).toHaveBeenCalledWith(entries[0], 'submit')
    rendered = enter.dialog.render(36).join('\n')
    expect(rendered).toContain('newest deploy prompt')
  })

  it('cycles session, project, and all scopes with Ctrl+S', () => {
    const { dialog, scopes } = fixture()
    dialog.render(80)
    dialog.handleInput('\x13')
    expect(dialog.render(80).join('\n')).toContain('this project /workspace (2)')
    dialog.handleInput('\x13')
    const all = dialog.render(80).join('\n')
    expect(all).toContain('all projects (3)')
    expect(all).toContain('/elsewhere')
    dialog.handleInput('\x13')
    expect(dialog.render(80).join('\n')).toContain('this session (2)')
    expect(scopes).toContain('session')
    expect(scopes).toContain('project')
    expect(scopes).toContain('all')
  })

  it('cancels with Escape, Ctrl+C, or Backspace on an empty query', () => {
    for (const key of ['\x1b', '\x03', '\x7f']) {
      const { dialog, cancel } = fixture()
      dialog.handleInput(key)
      expect(cancel).toHaveBeenCalledTimes(1)
    }
    const edited = fixture()
    edited.dialog.handleInput('x')
    edited.dialog.handleInput('\x7f')
    expect(edited.cancel).not.toHaveBeenCalled()
  })

  it('sanitizes bracketed paste and reports loading, unavailable, and failed corpus states', () => {
    const loading = fixture('loading')
    loading.dialog.handleInput('\x1b[200~deploy\x1b]0;owned\x07\x1b[201~')
    const rendered = loading.dialog.render(80).join('\n')
    expect(rendered).toContain('⌕ deploy')
    expect(rendered).not.toContain('owned')
    expect(rendered).toContain('Loading older history')

    const unavailable = fixture('unavailable')
    unavailable.dialog.handleInput('\x13')
    expect(unavailable.dialog.render(80).join('\n')).toContain('Cross-session history is unavailable')

    const failed = fixture('failed')
    failed.dialog.handleInput('\x13')
    expect(failed.dialog.render(80).join('\n')).toContain('Older history scan failed: index offline')
  })

  it('shows an error when accepting an empty result and supports viewport paging', () => {
    const { dialog, done } = fixture()
    dialog.handleInput('missing')
    dialog.handleInput('\r')
    expect(dialog.render(80).join('\n')).toContain('No prompt matches this search')
    expect(done).not.toHaveBeenCalled()
    dialog.handleInput('\x7f'.repeat(7))
    dialog.handleInput('\x1b[6~')
    dialog.handleInput('\x1b[5~')
    expect(dialog.render(80).join('\n')).toContain('History search')
  })
})
