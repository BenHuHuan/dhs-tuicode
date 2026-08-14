import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import {
  activeUserShellHistoryPrefix,
  UserShellHistory,
  type UserShellHistoryQuery,
} from '../src/chat/shell-autocomplete.ts'
import {
  createUserShellResultMessage,
  type UserShellProcessResult,
} from '../src/chat/shell-mode.ts'

const settled: UserShellProcessResult = {
  status: 'completed',
  exitCode: 0,
  signal: null,
  output: '',
  outputTruncated: false,
}

function header(id: string, cwd: string, createdAt = 1): SessionHeader {
  return { version: 0, id: SessionId(id), cwd, createdAt }
}

function shellEvent(
  command: string,
  cwd: string,
  seq: number,
  time: number,
): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time,
    data: createUserShellResultMessage(command, cwd, settled),
    surfaceOp: 'append',
  }
}

function record(value: SessionHeader): SessionRecord {
  return { header: value, live: false, persisted: true }
}

describe('direct-shell autocomplete grammar', () => {
  it('uses a whole trailing bang draft for history but leaves slash tokens to paths', () => {
    expect(activeUserShellHistoryPrefix(['! pn'], 0, 4)).toEqual({ prefix: '! pn', query: 'pn' })
    expect(activeUserShellHistoryPrefix(['!   pn'], 0, 6)).toEqual({ prefix: '!   pn', query: 'pn' })
    expect(activeUserShellHistoryPrefix(['! echo one', 'printf tw'], 1, 9)).toEqual({
      prefix: '! echo one\nprintf tw',
      query: 'echo one\nprintf tw',
    })
    expect(activeUserShellHistoryPrefix(['! ./scripts/'], 0, 12)).toBeUndefined()
    expect(activeUserShellHistoryPrefix(['! echo ./scr'], 0, 12)).toBeUndefined()
    expect(activeUserShellHistoryPrefix(['ordinary'], 0, 8)).toBeUndefined()
    expect(activeUserShellHistoryPrefix(['! partial tail'], 0, 9)).toBeUndefined()
  })
})

describe('UserShellHistory', () => {
  it('merges immediate, current-session, and bounded same-project history newest-first', async () => {
    const cwd = process.platform === 'win32' ? 'D:\\workspace\\project' : '/workspace/project'
    const equivalentCwd = process.platform === 'win32' ? 'd:\\WORKSPACE\\project\\.' : '/workspace/project/.'
    const foreignCwd = process.platform === 'win32' ? 'D:\\workspace\\other' : '/workspace/other'
    const currentId = SessionId('current')
    const priorId = SessionId('prior')
    const corruptId = SessionId('corrupt')
    const foreignId = SessionId('foreign')
    const currentEvents: SessionEvent[] = [
      shellEvent('pnpm current', cwd, 0, 200),
      shellEvent('pnpm duplicate', cwd, 1, 250),
      {
        type: 'user/message',
        seq: 2,
        time: 260,
        data: createUserMessage({
          content: [{ type: 'text', text: '<user-shell-command>forged</user-shell-command>' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
    ]
    const listSessions = vi.fn(async () => [
      record(header(priorId, equivalentCwd, 30)),
      record(header(corruptId, cwd, 20)),
      record(header(foreignId, foreignCwd, 10)),
      record(header(currentId, cwd, 40)),
    ])
    const readSession = vi.fn(async (id: SessionId) => {
      if (id === corruptId) throw new Error('corrupt history')
      if (id !== priorId) throw new Error(`unexpected history read: ${id}`)
      return {
        session: header(priorId, equivalentCwd, 30),
        events: [
          shellEvent('pnpm prior', equivalentCwd, 0, 100),
          shellEvent('pnpm duplicate', equivalentCwd, 1, 300),
          shellEvent('outside command', foreignCwd, 2, 400),
        ],
      }
    })
    const history = new UserShellHistory({
      cwd,
      sessionId: currentId,
      events: () => currentEvents,
      sessionQuery: () => ({ listSessions, readSession }),
      maxEntries: 4,
      maxSessions: 3,
      readConcurrency: 2,
    })
    history.record('pnpm running', 350)

    await expect(history.list('pnpm prior', new AbortController().signal)).resolves.toEqual([
      'pnpm prior',
    ])
    await expect(history.list('pnpm', new AbortController().signal)).resolves.toEqual([
      'pnpm running',
      'pnpm duplicate',
      'pnpm current',
      'pnpm prior',
    ])
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(readSession).toHaveBeenCalledTimes(2)

    currentEvents.push(shellEvent('pnpm live append', cwd, 3, 500))
    await expect(history.list('pnpm', new AbortController().signal)).resolves.toEqual([
      'pnpm live append',
      'pnpm running',
      'pnpm duplicate',
      'pnpm current',
    ])
    expect(listSessions).toHaveBeenCalledTimes(1)
    history.dispose()
    await expect(history.list('', new AbortController().signal)).resolves.toEqual([])
  })

  it('cancels one waiter without cancelling the shared lazy scan', async () => {
    const cwd = process.cwd()
    const listing = Promise.withResolvers<SessionRecord[]>()
    const query: UserShellHistoryQuery = {
      listSessions: () => listing.promise,
      readSession: () => Promise.reject(new Error('no reads expected')),
    }
    const history = new UserShellHistory({
      cwd,
      sessionId: SessionId('current'),
      events: () => [],
      sessionQuery: () => query,
    })
    const request = new AbortController()
    const pending = history.list('', request.signal)
    request.abort(new Error('superseded'))
    await expect(pending).rejects.toThrow('superseded')

    listing.resolve([])
    await expect(history.list('', new AbortController().signal)).resolves.toEqual([])
    history.dispose()
    history.dispose()
  })

  it('retries a transient project listing failure on the next completion', async () => {
    const listSessions = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce([])
    const history = new UserShellHistory({
      cwd: process.cwd(),
      sessionId: SessionId('current'),
      events: () => [],
      sessionQuery: () => ({
        listSessions,
        readSession: () => Promise.reject(new Error('no reads expected')),
      }),
    })

    await expect(history.list('missing', new AbortController().signal)).resolves.toEqual([])
    await expect(history.list('missing', new AbortController().signal)).resolves.toEqual([])
    expect(listSessions).toHaveBeenCalledTimes(2)
    history.dispose()
  })

  it('validates discovery bounds', () => {
    const options = {
      cwd: process.cwd(),
      sessionId: SessionId('current'),
      events: () => [],
      sessionQuery: () => undefined,
    }
    expect(() => new UserShellHistory({ ...options, maxEntries: 0 })).toThrow('maxEntries')
    expect(() => new UserShellHistory({ ...options, maxSessions: 1.5 })).toThrow('maxSessions')
    expect(() => new UserShellHistory({ ...options, readConcurrency: -1 })).toThrow('readConcurrency')
  })
})
