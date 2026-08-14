import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import {
  PromptHistory,
  type PromptHistoryOptions,
  type PromptHistoryQuery,
} from '../src/chat/prompt-history.ts'
import {
  createUserShellResultMessage,
  type UserShellProcessResult,
} from '../src/chat/shell-mode.ts'

const shellResult: UserShellProcessResult = {
  status: 'completed',
  exitCode: 0,
  signal: null,
  output: '',
  outputTruncated: false,
}

function header(id: string, cwd: string | undefined, createdAt = 1): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

function record(value: SessionHeader): SessionRecord {
  return { header: value, live: false, persisted: true }
}

function inputEvent(text: string, seq: number, time: number): SessionEvent<'tui/input'> {
  return { type: 'tui/input', seq, time, data: { text } }
}

function userEvent(text: string, seq: number, time: number): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

function commandEvent(name: string, args: string, seq: number, time: number): SessionEvent<'command/run'> {
  return {
    type: 'command/run',
    seq,
    time,
    data: {
      commandId: CommandId(`command-${seq}`),
      name,
      args,
      source: { kind: 'user' },
    },
  }
}

function shellEvent(command: string, cwd: string, seq: number, time: number): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time,
    data: createUserShellResultMessage(command, cwd, shellResult),
    surfaceOp: 'append',
  }
}

function options(
  events: SessionEvent[],
  overrides: Partial<PromptHistoryOptions> = {},
): PromptHistoryOptions {
  return {
    sessionId: SessionId('current'),
    cwd: process.cwd(),
    events: () => events,
    appendInput: (text) => {
      events.push(inputEvent(text, events.length, 1_000 + events.length))
    },
    sessionQuery: () => undefined,
    maxEntries: 100,
    maxSessions: 32,
    readConcurrency: 4,
    ...overrides,
  }
}

describe('PromptHistory', () => {
  it('uses exact TUI inputs after preserving legacy prompt, command, and shell history', () => {
    const cwd = process.cwd()
    const events: SessionEvent[] = [
      userEvent('legacy prompt', 0, 100),
      userEvent('<skill name="legacy-skill">\nExpanded instructions.\n</skill>', 1, 105),
      commandEvent('status', ' --verbose', 2, 110),
      shellEvent('pnpm test', cwd, 3, 120),
      inputEvent('exact prompt', 4, 130),
      userEvent('exact prompt', 5, 140),
      commandEvent('help', '', 6, 150),
      inputEvent('exact prompt', 7, 160),
    ]
    const history = new PromptHistory(options(events))

    expect(history.list('session', '').map(entry => entry.text)).toEqual([
      'exact prompt',
      '! pnpm test',
      '/status --verbose',
      'legacy prompt',
    ])
    history.record('  next prompt  ')
    history.record('next prompt')
    expect(events.filter(event => event.type === 'tui/input').map(event => event.data.text)).toEqual([
      'exact prompt',
      'exact prompt',
      'next prompt',
    ])
    expect(history.list('session', 'PROMPT').map(entry => entry.text)).toEqual([
      'next prompt',
      'exact prompt',
      'legacy prompt',
    ])
    history.dispose()
    history.record('ignored after dispose')
    expect(history.list('all', '')).toEqual([])
  })

  it('fills current-project and all-project scopes progressively with bounded concurrency', async () => {
    const cwd = process.platform === 'win32' ? 'D:\\workspace\\project' : '/workspace/project'
    const sameCwd = process.platform === 'win32' ? 'd:\\WORKSPACE\\project\\.' : '/workspace/project/.'
    const foreignCwd = process.platform === 'win32' ? 'D:\\workspace\\other' : '/workspace/other'
    const currentEvents = [inputEvent('current prompt', 0, 500)] as SessionEvent[]
    const same = header('same', sameCwd, 30)
    const sameOlder = header('same-older', sameCwd, 10)
    const sameOldest = header('same-oldest', sameCwd, 5)
    const foreign = header('foreign', foreignCwd, 40)
    const unreadable = header('unreadable', foreignCwd, 20)
    let activeReads = 0
    let maximumReads = 0
    const releases = new Map<SessionId, ReturnType<typeof Promise.withResolvers<undefined>>>()
    const query: PromptHistoryQuery = {
      listSessions: async () => [
        record(foreign),
        record(same),
        record(unreadable),
        record(sameOlder),
        record(sameOldest),
      ],
      readSession: async (id) => {
        activeReads += 1
        maximumReads = Math.max(maximumReads, activeReads)
        const release = Promise.withResolvers<undefined>()
        releases.set(id, release)
        await release.promise
        activeReads -= 1
        if (id === unreadable.id) throw new Error('corrupt legacy session')
        const meta = [same, sameOlder, foreign].find(candidate => candidate.id === id)
        if (meta === undefined) throw new Error(`unexpected id ${id}`)
        return {
          session: meta,
          events: [inputEvent(`${id} prompt`, 0, meta.createdAt)],
        }
      },
    }
    const history = new PromptHistory(options(currentEvents, {
      cwd,
      sessionQuery: () => query,
      maxSessions: 4,
      readConcurrency: 2,
    }))
    const changes = vi.fn()
    const unsubscribe = history.subscribe(changes)

    history.ensureLoaded()
    expect(history.loadState).toBe('loading')
    expect(history.list('session', '').map(entry => entry.text)).toEqual(['current prompt'])
    await vi.waitFor(() => { expect(releases.size).toBe(2) })
    expect([...releases.keys()]).toEqual([same.id, sameOlder.id])
    releases.get(same.id)?.resolve(undefined)
    await vi.waitFor(() => {
      expect(history.list('project', '').map(entry => entry.text)).toContain('same prompt')
    })
    releases.get(sameOlder.id)?.resolve(undefined)
    await vi.waitFor(() => {
      expect(releases.has(foreign.id)).toBe(true)
      expect(releases.has(unreadable.id)).toBe(true)
    })
    releases.get(foreign.id)?.resolve(undefined)
    releases.get(unreadable.id)?.resolve(undefined)
    await vi.waitFor(() => { expect(history.loadState).toBe('complete') })

    expect(maximumReads).toBe(2)
    expect(history.list('project', '').map(entry => entry.text)).toEqual([
      'current prompt',
      'same prompt',
      'same-older prompt',
    ])
    expect(releases.has(sameOldest.id)).toBe(false)
    expect(history.list('all', '').map(entry => entry.text)).toEqual([
      'current prompt',
      'foreign prompt',
      'same prompt',
      'same-older prompt',
    ])
    expect(changes).toHaveBeenCalled()
    unsubscribe()
    history.dispose()
  })

  it('reports unavailable discovery and retries a transient listing failure', async () => {
    const events: SessionEvent[] = []
    const queryHolder: { current?: PromptHistoryQuery } = {}
    const listSessions = vi.fn()
      .mockRejectedValueOnce(new Error('index offline'))
      .mockResolvedValueOnce([])
    const history = new PromptHistory(options(events, {
      sessionQuery: () => queryHolder.current,
    }))

    history.ensureLoaded()
    expect(history.loadState).toBe('unavailable')
    queryHolder.current = {
      listSessions,
      readSession: () => Promise.reject(new Error('no reads expected')),
    }
    history.ensureLoaded()
    await vi.waitFor(() => { expect(history.loadState).toBe('failed') })
    expect(history.loadFailure).toEqual(new Error('index offline'))
    history.ensureLoaded()
    await vi.waitFor(() => { expect(history.loadState).toBe('complete') })
    expect(listSessions).toHaveBeenCalledTimes(2)
    history.dispose()
  })

  it('validates every discovery bound', () => {
    const events: SessionEvent[] = []
    expect(() => new PromptHistory(options(events, { maxEntries: 0 }))).toThrow('maxEntries')
    expect(() => new PromptHistory(options(events, { maxSessions: 1.5 }))).toThrow('maxSessions')
    expect(() => new PromptHistory(options(events, { readConcurrency: -1 }))).toThrow('readConcurrency')
  })
})
