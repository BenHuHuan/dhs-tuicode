import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentRegistry,
  CreateAgentOptions,
  ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { TuiAgentService } from '../src/runner.ts'

function agentHandle(
  id: string,
  cwd: string,
  options: AgentOptions,
  dispose: AgentHandle['dispose'] = vi.fn(() => Promise.resolve()),
  events: Agent['session']['events'] = [],
): AgentHandle {
  const sessionId = SessionId(id)
  return {
    agent: {
      id: sessionId,
      options,
      session: { id: sessionId, header: { id: sessionId, cwd }, events },
    } as unknown as Agent,
    dispose,
  }
}

describe('TuiAgentService fresh-session swaps', () => {
  it('creates a unique sibling in the same workspace and carries the selected target', async () => {
    const ctx = new Context()
    const initialDispose = vi.fn(() => Promise.resolve())
    const initial = agentHandle(
      'main',
      '/workspace',
      { provider: 'base', model: 'base-model', maxTokens: 42 },
      initialDispose,
    )
    const replacement = agentHandle('fresh', '/workspace', { provider: 'selected', model: 'selected-model', maxTokens: 42 })
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(replacement)
    const agents = { create } as unknown as AgentRegistry
    const ready = vi.fn()
    ctx.on('tui-agent/ready', ready)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents,
      agentOptions: { provider: 'base', model: 'base-model', maxTokens: 42 },
    })
    const initialRequest = create.mock.calls[0]?.[0]
    if (initialRequest === undefined) throw new Error('initial settle did not create an agent')
    expect(String(initialRequest.sessionId)).toMatch(/^session-[0-9a-f-]+$/u)
    expect(initialRequest.meta).toEqual({ cwd: process.cwd() })
    const selection: ModelSelection = {
      provider: 'selected',
      model: 'selected-model',
      reasoningEffort: ReasoningEffortId('max'),
    }

    await service.fresh(selection)

    const request = create.mock.calls[1]?.[0]
    if (request === undefined) throw new Error('fresh swap did not create a replacement agent')
    expect(String(request.sessionId)).toMatch(/^session-[0-9a-f-]+$/u)
    expect(request.meta).toEqual({ cwd: '/workspace' })
    expect(request.agentOptions).toEqual({
      provider: 'selected',
      model: 'selected-model',
      maxTokens: 42,
    })
    expect(initialDispose).toHaveBeenCalledOnce()
    expect(service.current).toBe(replacement.agent)
    expect(ready).toHaveBeenLastCalledWith({ sessionId: replacement.agent.id, selection })
    await ctx.fiber.dispose()
  })

  it('allocates a different durable identity for each unresumed startup', async () => {
    const firstCtx = new Context()
    const secondCtx = new Context()
    const requests: CreateAgentOptions[] = []
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>(async (options) => {
      requests.push(options)
      if (options.meta?.cwd === undefined || options.agentOptions === undefined) {
        throw new Error('fresh startup omitted its cwd or agent options')
      }
      return agentHandle(String(options.sessionId), options.meta.cwd, options.agentOptions)
    })

    await new TuiAgentService(firstCtx).settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })
    await new TuiAgentService(secondCtx).settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })

    expect(requests).toHaveLength(2)
    expect(String(requests[0]?.sessionId)).toMatch(/^session-[0-9a-f-]+$/u)
    expect(String(requests[1]?.sessionId)).toMatch(/^session-[0-9a-f-]+$/u)
    expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId)
    await firstCtx.fiber.dispose()
    await secondCtx.fiber.dispose()
  })

  it('marks a fresh Router mode session without changing the default Minimal session', async () => {
    const ctx = new Context()
    const initial = agentHandle('main', '/workspace', { provider: 'base', model: 'base-model' })
    const routed = agentHandle('routed', '/workspace', { provider: 'base', model: 'base-model' })
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(routed)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })

    await service.fresh(undefined, undefined, 'suite')

    expect(create.mock.calls[0]?.[0].meta).toEqual({ cwd: process.cwd() })
    expect(create.mock.calls[1]?.[0].meta).toEqual({
      cwd: '/workspace',
      agentPreset: 'routing-suite',
    })
    await ctx.fiber.dispose()
  })

  it('marks a fresh Router Spec mode session with its own preset marker', async () => {
    const ctx = new Context()
    const initial = agentHandle('main', '/workspace', { provider: 'base', model: 'base-model' })
    const routed = agentHandle('routed-spec', '/workspace', { provider: 'base', model: 'base-model' })
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(routed)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })

    await service.fresh(undefined, undefined, 'suite-spec')

    expect(create.mock.calls[0]?.[0].meta).toEqual({ cwd: process.cwd() })
    expect(create.mock.calls[1]?.[0].meta).toEqual({
      cwd: '/workspace',
      agentPreset: 'routing-suite-spec',
    })
    await ctx.fiber.dispose()
  })

  it('disposes a prepared replacement when the current agent cannot retire', async () => {
    const ctx = new Context()
    const retirementError = new Error('old agent stayed live')
    const initial = agentHandle(
      'main',
      '/workspace',
      { provider: 'base', model: 'base-model' },
      vi.fn(() => Promise.reject(retirementError)),
    )
    const replacementDispose = vi.fn(() => Promise.resolve())
    const replacement = agentHandle(
      'fresh',
      '/workspace',
      { provider: 'base', model: 'base-model' },
      replacementDispose,
    )
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(replacement)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })

    await expect(service.fresh(undefined)).rejects.toBe(retirementError)
    expect(replacementDispose).toHaveBeenCalledOnce()
    expect(service.current).toBe(initial.agent)
    await ctx.fiber.dispose()
  })

  it('forks a child through an exact completed event boundary and keeps the source resumable', async () => {
    const ctx = new Context()
    const sourceEvents = [
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'turn/end' },
      { seq: 3, type: 'command/run' },
    ] as unknown as Agent['session']['events']
    const sourceDispose = vi.fn(() => Promise.resolve())
    const source = agentHandle(
      'main',
      '/workspace',
      { provider: 'base', model: 'base-model', maxTokens: 42 },
      sourceDispose,
      sourceEvents,
    )
    const child = agentHandle('child', '/workspace', { provider: 'selected', model: 'selected-model', maxTokens: 42 })
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(child)
    const ready = vi.fn()
    ctx.on('tui-agent/ready', ready)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model', maxTokens: 42 },
    })
    const selection: ModelSelection = {
      provider: 'selected',
      model: 'selected-model',
      reasoningEffort: ReasoningEffortId('max'),
    }

    await service.fork(2, selection, 'Child ready.')

    const request = create.mock.calls[1]?.[0]
    if (request === undefined) throw new Error('fork did not create a child agent')
    expect(String(request.sessionId)).toMatch(/^session-[0-9a-f-]+$/u)
    expect(request.meta).toEqual({ cwd: '/workspace', parentSession: source.agent.session.id, seedLength: 3 })
    expect(request.seed).toEqual(sourceEvents.slice(0, 3))
    expect(request.agentOptions).toEqual({ provider: 'selected', model: 'selected-model', maxTokens: 42 })
    expect(sourceDispose).toHaveBeenCalledOnce()
    expect(service.current).toBe(child.agent)
    expect(ready).toHaveBeenLastCalledWith({
      sessionId: child.agent.id,
      selection,
      initialNotice: 'Child ready.',
    })
    await ctx.fiber.dispose()
  })

  it('refuses a fork boundary that would seed an active turn', async () => {
    const ctx = new Context()
    const sourceDispose = vi.fn(() => Promise.resolve())
    const source = agentHandle(
      'main',
      '/workspace',
      { provider: 'base', model: 'base-model' },
      sourceDispose,
      [
        { seq: 0, type: 'turn/start' },
        { seq: 1, type: 'user/message' },
      ] as unknown as Agent['session']['events'],
    )
    const create = vi.fn<(options: CreateAgentOptions) => Promise<AgentHandle>>().mockResolvedValueOnce(source)
    const service = new TuiAgentService(ctx)
    await service.settle(undefined, {
      agents: { create } as unknown as AgentRegistry,
      agentOptions: { provider: 'base', model: 'base-model' },
    })

    await expect(service.fork(1, undefined)).rejects.toThrow('ends inside an active turn')
    expect(create).toHaveBeenCalledTimes(1)
    expect(sourceDispose).not.toHaveBeenCalled()
    expect(service.current).toBe(source.agent)
    await ctx.fiber.dispose()
  })
})
