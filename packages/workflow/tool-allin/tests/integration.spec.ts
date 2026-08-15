import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolAllin from '../src/index.ts'

const testToolSignal = new AbortController().signal

describe('dsh-tool-allin over the real spawn and worker-thread stack', () => {
  it('runs one pro planner, one flash lane, and one pro synthesis with distinct empty-seed children', async () => {
    const plan = {
      title: 'Add billing end to end',
      tasks: [
        { id: 'backend', title: 'Billing backend', prompt: 'Implement and verify the billing backend.', dependencies: [] },
      ],
    }
    const report = {
      status: 'done',
      summary: 'The billing backend is implemented and tested.',
      artifacts: ['src/billing/backend.ts'],
      evidence: ['Focused backend tests pass.'],
      handoff: 'API contract: POST /billing/invoices.',
      blocker: '',
    }
    const synthesis = {
      status: 'complete',
      summary: 'The billing backend is implemented, tested, and documented.',
      deliverables: ['src/billing/backend.ts', 'tests/billing.spec.ts'],
      remaining: [],
      blocker: '',
    }
    const adapter = new MockAdapter([
      toolCallResponse('plan', STRUCTURED_OUTPUT_TOOL, plan),
      toolCallResponse('lane', STRUCTURED_OUTPUT_TOOL, report),
      toolCallResponse('synthesis', STRUCTURED_OUTPUT_TOOL, synthesis),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, {})
    await ctx.plugin(toolAllin, { maxTasks: 1 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('allin-parent'),
      meta: { cwd: '/tmp/allin-shared-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent
    const phases: string[] = []
    const children: Agent[] = []
    ctx.on('workflow/phase', (_run, title) => { phases.push(title) })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      expect(agent).toBeDefined()
      children.push(agent!)
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('allin-integration'),
      name: 'allin',
      arguments: { goal: 'Add billing end to end.', maxTasks: 1 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected Allin integration success')
    expect((result.content[0] as { text: string }).text)
      .toContain('Allin coordinator reported complete for "Add billing end to end"')
    expect(phases).toEqual(['Plan', 'Parallel task lanes', 'Synthesis'])
    expect(children).toHaveLength(3)
    expect(new Set(children.map(child => child.id)).size).toBe(3)
    for (const child of children) {
      expect(child.session.header.cwd).toBe('/tmp/allin-shared-workspace')
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(child.session.header.seedLength).toBeUndefined()
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.map(request => request.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    const laneRequest = JSON.stringify(adapter.requests[1]!.messages)
    expect(laneRequest).toContain('Add billing end to end')
    expect(laneRequest).toContain('Billing backend')

    await parentHandle.dispose()
  })

  it('runs two independent flash lanes through one parallel wave', async () => {
    const plan = {
      title: 'Ship billing and checkout',
      tasks: [
        { id: 'backend', title: 'Billing backend', prompt: 'Implement and verify the billing backend.', dependencies: [] },
        { id: 'checkout', title: 'Checkout UI', prompt: 'Implement and verify the checkout UI.', dependencies: [] },
      ],
    }
    const synthesis = {
      status: 'complete',
      summary: 'Billing backend and checkout UI are implemented and tested.',
      deliverables: ['src/billing/backend.ts', 'src/checkout/index.ts'],
      remaining: [],
      blocker: '',
    }
    const laneReport = (kind: string) => ({
      status: 'done',
      summary: `The ${kind} is implemented and tested.`,
      artifacts: [`src/${kind}/index.ts`],
      evidence: [`Focused ${kind} tests pass.`],
      handoff: `${kind} contract is stable.`,
      blocker: '',
    })
    const adapter = new MockAdapter([
      toolCallResponse('plan', STRUCTURED_OUTPUT_TOOL, plan),
      options => JSON.stringify(options.messages).includes('Billing backend')
        ? toolCallResponse('backend', STRUCTURED_OUTPUT_TOOL, laneReport('billing-backend'))
        : toolCallResponse('checkout', STRUCTURED_OUTPUT_TOOL, laneReport('checkout-ui')),
      options => JSON.stringify(options.messages).includes('Billing backend')
        ? toolCallResponse('backend', STRUCTURED_OUTPUT_TOOL, laneReport('billing-backend'))
        : toolCallResponse('checkout', STRUCTURED_OUTPUT_TOOL, laneReport('checkout-ui')),
      toolCallResponse('synthesis', STRUCTURED_OUTPUT_TOOL, synthesis),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, {})
    await ctx.plugin(toolAllin, { maxTasks: 2, maxParallelWorkers: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('allin-parallel-parent'),
      meta: { cwd: '/tmp/allin-shared-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('allin-parallel-integration'),
      name: 'allin',
      arguments: { goal: 'Ship billing and checkout.', maxTasks: 2 },
      agent: parentHandle.agent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected parallel Allin integration success')
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests.filter(request => request.model === 'deepseek-v4-flash')).toHaveLength(2)
    const value = result.value as { result: { tasks: Array<{ id: string; status: string }> } }
    expect(value.result.tasks.map(task => task.id).sort()).toEqual(['backend', 'checkout'])
    expect(value.result.tasks.every(task => task.status === 'done')).toBe(true)

    await parentHandle.dispose()
  })
})
