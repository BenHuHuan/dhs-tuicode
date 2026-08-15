/** User-facing command coverage for the redacted MCP directory. */

import { describe, expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
} from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

async function command(
  harness: Awaited<ReturnType<typeof createTuiTestHarness<HeadlessTerminal, (code: number) => void>>>,
  text: string,
): Promise<string> {
  const frame = harness.terminal.frames
  harness.terminal.send(text)
  harness.terminal.send('\r')
  await harness.terminal.waitForFrame(frame)
  return await harness.terminal.snapshot({ includeScrollback: true })
}

async function dispose(
  harness: Awaited<ReturnType<typeof createTuiTestHarness<HeadlessTerminal, (code: number) => void>>>,
): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('/mcp', () => {
  it('explains when the optional MCP connection directory is absent', async () => {
    const terminal = new HeadlessTerminal()
    const harness = await createTuiTestHarness(terminal, vi.fn())
    await terminal.waitForFrame(0)

    const output = await command(harness, '/mcp')
    expect(output).toContain('MCP status is unavailable because this runtime has no MCP connection directory.')
    await dispose(harness)
  })

  it('lists bounded public tool names, shows one server, rejects misses, and delegates reload', async () => {
    const terminal = new HeadlessTerminal(120, 36)
    const refresh = vi.fn(async () => {})
    const toolNames = Array.from({ length: 21 }, (_value, index) => `mcp__filesystem__tool_${String(index + 1)}`)
    const harness = await createTuiTestHarness(terminal, vi.fn(), {
      configureContext: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRegistry)
        ctx.provide('mcpConnections', {
          snapshot: () => [
            {
              serverName: 'filesystem',
              transport: 'stdio',
              state: 'connected',
              toolNames,
            },
            {
              serverName: 'research',
              transport: 'streamable-http',
              state: 'reconnecting',
              reconnectAttempt: 2,
              toolNames: [],
            },
          ],
        } as never)
        ctx.provide('loader', {
          entries: () => [{ subtree: { refresh } }],
        } as never)
      },
    })
    await terminal.waitForFrame(0)

    const listed = await command(harness, '/mcp')
    expect(listed).toContain('MCP servers')
    expect(listed).toContain('filesystem')
    expect(listed).toContain('research')
    expect(listed).toContain('+1 more')

    const detail = await command(harness, '/mcp research')
    expect(detail).toContain('MCP server research')
    expect(detail).toContain('reconnecting (attempt 2)')
    expect(detail).toContain('Tools (0): (none)')

    const missing = await command(harness, '/mcp missing')
    expect(missing).toContain('Unknown MCP server: missing. Run /mcp to list configured servers.')

    await command(harness, '/mcp reload')
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    await dispose(harness)
  })

  it('renders an empty configured directory', async () => {
    const terminal = new HeadlessTerminal()
    const harness = await createTuiTestHarness(terminal, vi.fn(), {
      configureContext: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRegistry)
        ctx.provide('mcpConnections', { snapshot: () => [] } as never)
      },
    })
    await terminal.waitForFrame(0)

    const output = await command(harness, '/mcp')
    expect(output).toContain('No MCP servers are configured.')
    expect(output).toContain('/mcp reload.')
    await dispose(harness)
  })
})
