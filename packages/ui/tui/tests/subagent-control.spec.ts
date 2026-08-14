import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { BackgroundSubagentControl } from '../src/chat/subagent-control.ts'
import {
  stopRunningBackgroundSubagents,
  SubagentKillShortcut,
} from '../src/chat/subagent-control.ts'

describe('TUI background subagent control', () => {
  it('recognizes split and combined Ctrl+X Ctrl+K without swallowing unrelated followers', () => {
    const shortcut = new SubagentKillShortcut()
    expect(shortcut.handle('\x18')).toBe('consume')
    expect(shortcut.handle('a')).toBe('pass')
    expect(shortcut.handle('\x0b')).toBe('pass')
    expect(shortcut.handle('\x18\x0b')).toBe('invoke')
    expect(shortcut.handle('\x18')).toBe('consume')
    expect(shortcut.handle('\x0b')).toBe('invoke')
    expect(shortcut.handle('\x18')).toBe('consume')
    shortcut.reset()
    expect(shortcut.handle('\x0b')).toBe('pass')
  })

  it('stops exact-owner one-shot jobs and running direct continuations while containing siblings', async () => {
    const parentId = SessionId('parent')
    const agent = { id: parentId } as Agent
    const runningChild = { status: 'running' } as Agent
    const failedChild = { status: 'running' } as Agent
    const idleChild = { status: 'idle' } as Agent
    const children = new Map([
      [SessionId('continuable-running'), runningChild],
      [SessionId('continuable-failed'), failedChild],
      [SessionId('continuable-idle'), idleChild],
      [SessionId('continuable-inactive'), runningChild],
    ])
    const kill = vi.fn<NonNullable<BackgroundSubagentControl['jobs']>['kill']>((id) => {
      if (id === JobId('subagent-2')) return 'already-finished' as const
      if (id === JobId('subagent-3')) throw new Error('job cancel broke')
      return 'requested' as const
    })
    const interrupt = vi.fn<NonNullable<BackgroundSubagentControl['subagents']>['interrupt']>((id) => {
      if (id === SessionId('continuable-failed')) throw new Error('interrupt broke')
    })
    const result = await stopRunningBackgroundSubagents({
      agent,
      agents: { get: id => children.get(id) },
      jobs: {
        list: () => [
          { id: JobId('subagent-1'), kind: 'subagent', label: 'one', ownerSession: parentId, status: 'running' },
          { id: JobId('subagent-2'), kind: 'subagent', label: 'two', ownerSession: parentId, status: 'running' },
          { id: JobId('subagent-3'), kind: 'subagent', label: 'three', ownerSession: parentId, status: 'running' },
          { id: JobId('bash-1'), kind: 'bash', label: 'shell', ownerSession: parentId, status: 'running' },
          { id: JobId('subagent-4'), kind: 'subagent', label: 'foreign', ownerSession: SessionId('other'), status: 'running' },
          { id: JobId('subagent-5'), kind: 'subagent', label: 'done', ownerSession: parentId, status: 'completed' },
          { id: JobId('subagent-6'), kind: 'subagent', label: 'unowned', status: 'running' },
        ] as never,
        kill,
      },
      subagents: {
        listChildren: () => Promise.resolve([
          { kind: 'child', id: SessionId('continuable-running'), mode: 'continuable', label: 'live', activity: 'running', hasChildren: false },
          { kind: 'child', id: SessionId('continuable-failed'), mode: 'continuable', label: 'broken', activity: 'running', hasChildren: false },
          { kind: 'child', id: SessionId('continuable-idle'), mode: 'continuable', label: 'idle', activity: 'running', hasChildren: false },
          { kind: 'child', id: SessionId('continuable-inactive'), mode: 'continuable', label: 'cold', activity: 'inactive', hasChildren: false },
          { kind: 'child', id: SessionId('one-shot-child'), mode: 'one-shot', activity: 'running', hasChildren: false },
          { kind: 'diagnostic', id: SessionId('diagnostic'), error: 'missing descriptor' },
        ] as never),
        interrupt,
      },
    }, new AbortController().signal)

    expect(kill.mock.calls.map(call => call[0])).toEqual([
      JobId('subagent-1'),
      JobId('subagent-2'),
      JobId('subagent-3'),
    ])
    expect(kill.mock.calls.every(call => call[1] === agent)).toBe(true)
    expect(kill.mock.calls.every(call => call[2] === 'Stopped from the TUI with Ctrl+X Ctrl+K')).toBe(true)
    expect(interrupt.mock.calls.map(call => call[0])).toEqual([
      SessionId('continuable-running'),
      SessionId('continuable-failed'),
    ])
    expect(interrupt.mock.calls[0]?.[1]).toEqual({ kind: 'ancestor', agent })
    expect(result).toMatchObject({ requested: 2, alreadyFinished: 1 })
    expect(result.failures.map(failure => failure.target)).toEqual([
      JobId('subagent-3'),
      SessionId('continuable-failed'),
    ])
  })

  it('contains discovery failures and honors cancellation before stop side effects', async () => {
    const agent = { id: SessionId('parent') } as Agent
    const result = await stopRunningBackgroundSubagents({
      agent,
      agents: { get: () => undefined },
      jobs: {
        list: () => { throw new Error('jobs unavailable') },
        kill: vi.fn(),
      },
      subagents: {
        listChildren: () => Promise.reject(new Error('children unavailable')),
        interrupt: vi.fn(),
      },
    }, new AbortController().signal)
    expect(result.requested).toBe(0)
    expect(result.failures.map(failure => failure.target)).toEqual([
      'one-shot subagent discovery',
      'continuable subagent discovery',
    ])

    const controller = new AbortController()
    controller.abort(new Error('cancelled before stop'))
    const kill = vi.fn()
    await expect(stopRunningBackgroundSubagents({
      agent,
      agents: { get: () => undefined },
      jobs: {
        list: () => [{
          id: JobId('subagent-1'), kind: 'subagent', label: 'one', ownerSession: agent.id, status: 'running',
        }] as never,
        kill,
      },
    }, controller.signal)).rejects.toThrow('cancelled before stop')
    expect(kill).not.toHaveBeenCalled()
  })
})
