/** User-facing command coverage for durable continuable subagent control. */

import { describe, expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
} from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

type Harness = Awaited<ReturnType<typeof createTuiTestHarness<HeadlessTerminal, (code: number) => void>>>

async function command(harness: Harness, text: string): Promise<string> {
  const frame = harness.terminal.frames
  harness.terminal.send(text)
  harness.terminal.send('\r')
  await harness.terminal.waitForFrame(frame)
  return await harness.terminal.snapshot({ includeScrollback: true })
}

async function dispose(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('/agents', () => {
  it('explains when the optional subagent runtime is absent', async () => {
    const terminal = new HeadlessTerminal()
    const harness = await createTuiTestHarness(terminal, vi.fn())
    await terminal.waitForFrame(0)

    const output = await command(harness, '/agents')
    expect(output).toContain('Subagents are unavailable because this runtime has no subagent service.')
    await dispose(harness)
  })

  it('lists a durable tree and gives direct human start, send, and stop control', async () => {
    const terminal = new HeadlessTerminal(120, 40)
    const listDescendants = vi.fn(async () => [
      {
        kind: 'child',
        id: SessionId('worker-a'),
        parentId: SessionId('main-session'),
        depth: 1,
        activity: 'running',
        hasChildren: true,
        mode: 'continuable',
        label: 'Review auth boundaries',
      },
      {
        kind: 'diagnostic',
        id: SessionId('broken-child'),
        parentId: SessionId('worker-a'),
        depth: 2,
        reason: 'unavailable',
      },
      {
        kind: 'child',
        id: SessionId('grandchild'),
        parentId: SessionId('worker-a'),
        depth: 2,
        activity: 'inactive',
        hasChildren: false,
        mode: 'continuable',
        label: 'Check tests',
      },
    ])
    const listChildren = vi.fn(async () => [
      {
        kind: 'child',
        id: SessionId('worker-a'),
        activity: 'running',
        hasChildren: true,
        mode: 'continuable',
        label: 'Review auth boundaries',
      },
      {
        kind: 'child',
        id: SessionId('one-shot'),
        activity: 'running',
        hasChildren: false,
        mode: 'one-shot',
        label: 'Legacy task',
      },
      {
        kind: 'child',
        id: SessionId('stored-worker'),
        activity: 'inactive',
        hasChildren: false,
        mode: 'continuable',
        label: 'Stored task',
      },
    ])
    const startContinuable = vi.fn(async () => ({ childId: SessionId('new-worker'), messageId: 'message-1' }))
    const followup = vi.fn(async () => 'message-2')
    const interrupt = vi.fn()
    const harness = await createTuiTestHarness(terminal, vi.fn(), {
      configureContext: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRegistry)
        ctx.provide('subagents', {
          getProvider: (name: string) => name === 'spawn' ? { prepareContinuable: async () => ({}) } : undefined,
          listDescendants,
          listChildren,
          startContinuable,
          followup,
          interrupt,
        } as never)
      },
    })
    await terminal.waitForFrame(0)

    const listed = await command(harness, '/agents')
    expect(listed).toContain('Subagents')
    expect(listed).toContain('worker-a')
    expect(listed).toContain('continuable')
    expect(listed).toContain('unavailable')
    expect(listed).toContain('grandchild')
    expect(listed).toContain('Direct continuable children')

    const started = await command(harness, '/agents start inspect the test suite')
    expect(started).toContain('Started subagent new-worker.')
    expect(startContinuable).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn',
      label: 'inspect the test suite',
      request: {
        parent: harness.agent,
        prompt: [{ type: 'text', text: 'inspect the test suite' }],
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    }))

    const sent = await command(harness, '/agents send worker-a focus on error paths')
    expect(sent).toContain('Sent a follow-up to subagent worker-a.')
    expect(followup).toHaveBeenCalledWith(
      harness.agent,
      SessionId('worker-a'),
      [{ type: 'text', text: 'focus on error paths' }],
      expect.objectContaining({ source: { kind: 'user' } }),
    )

    const stopped = await command(harness, '/agents stop worker-a')
    expect(stopped).toContain('Stop requested for subagent worker-a')
    expect(interrupt).toHaveBeenCalledWith(
      SessionId('worker-a'),
      { kind: 'user', parentSessionId: SessionId('main-session') },
    )

    const oneShot = await command(harness, '/agents send one-shot continue')
    expect(oneShot).toContain('Subagent one-shot is a one-shot task; inspect it with /tasks.')

    const stored = await command(harness, '/agents stop stored-worker')
    expect(stored).toContain('Subagent stored-worker is not live.')

    const grandchild = await command(harness, '/agents send grandchild continue')
    expect(grandchild).toContain('No direct subagent named grandchild.')
    await dispose(harness)
  })

  it('reports start capability and command syntax failures before side effects', async () => {
    const terminal = new HeadlessTerminal()
    const startContinuable = vi.fn()
    const harness = await createTuiTestHarness(terminal, vi.fn(), {
      configureContext: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRegistry)
        ctx.provide('subagents', {
          getProvider: () => undefined,
          listDescendants: async () => [],
          listChildren: async () => [],
          startContinuable,
        } as never)
      },
    })
    await terminal.waitForFrame(0)

    expect(await command(harness, '/agents start')).toContain('Usage: /agents start <task>')
    const unavailable = await command(harness, '/agents start review')
    expect(unavailable).toContain('Continuable subagents are unavailable')
    expect(await command(harness, '/agents send')).toContain('Usage: /agents send <id> <message>')
    expect(await command(harness, '/agents stop child extra')).toContain('Usage: /agents stop <id>')
    expect(await command(harness, '/agents unknown')).toContain('Usage: /agents [start <task>|send <id> <message>|stop <id>]')
    expect(startContinuable).not.toHaveBeenCalled()
    await dispose(harness)
  })
})
