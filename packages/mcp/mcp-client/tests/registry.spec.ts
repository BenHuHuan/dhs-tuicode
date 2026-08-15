/** Tests for the redacted MCP connection directory. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import McpConnectionRegistry from '@deepseek-ai/dsh-mcp-client/src/registry.ts'

describe('McpConnectionRegistry', () => {
  it('publishes detached redacted snapshots and removes an instance-owned row on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(McpConnectionRegistry)
    const changes: number[] = []
    ctx.on('mcp-connections/change', () => { changes.push(1) })

    const registration = ctx.mcpConnections.register('filesystem', 'stdio')
    expect(ctx.mcpConnections.snapshot()).toEqual([{
      serverName: 'filesystem',
      transport: 'stdio',
      state: 'connecting',
      toolNames: [],
    }])

    const names = ['mcp__filesystem__read_file']
    registration.update({ state: 'connected', toolNames: names })
    names.push('mcp__filesystem__write_file')
    const snapshot = ctx.mcpConnections.snapshot()
    expect(snapshot).toEqual([{
      serverName: 'filesystem',
      transport: 'stdio',
      state: 'connected',
      toolNames: ['mcp__filesystem__read_file'],
    }])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0]!)).toBe(true)
    expect(Object.isFrozen(snapshot[0]!.toolNames)).toBe(true)

    registration.dispose()
    registration.dispose()
    expect(ctx.mcpConnections.snapshot()).toEqual([])
    expect(changes).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('keeps duplicate server namespaces and stale registrations from replacing a live row', async () => {
    const ctx = new Context()
    await ctx.plugin(McpConnectionRegistry)
    const first = ctx.mcpConnections.register('shared', 'streamable-http')
    expect(() => ctx.mcpConnections.register('shared', 'stdio')).toThrow(/already contains server/)

    first.update({ state: 'reconnecting', reconnectAttempt: 2 })
    expect(ctx.mcpConnections.snapshot()[0]).toEqual({
      serverName: 'shared',
      transport: 'streamable-http',
      state: 'reconnecting',
      toolNames: [],
      reconnectAttempt: 2,
    })
    first.dispose()
    first.update({ state: 'connected', toolNames: ['mcp__shared__late'] })
    expect(ctx.mcpConnections.snapshot()).toEqual([])
    await ctx.fiber.dispose()
  })
})
