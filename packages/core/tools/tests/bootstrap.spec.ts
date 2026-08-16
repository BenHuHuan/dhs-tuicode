import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderPrompt, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Bootstrap, {
  classifyRouterTask,
  inject,
  MINIMAL_SYSTEM_PROMPT,
  ROUTING_SUITE_PRESET,
  ROUTING_SUITE_SPEC_PRESET,
} from '../src/bootstrap.ts'
import { personaFor } from '../src/router-core.ts'

type Listener = (
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

interface PreStepMessage {
  source: { kind: string }
  content: Array<{ type?: string; text?: string }>
}

type PreStepListener = (
  payload: { agent?: unknown; messages: PreStepMessage[] },
  next: () => Promise<{ kind: string; messages: PreStepMessage[] }>,
) => Promise<{ kind: string; messages: PreStepMessage[] }>

function fakeCtx(onEvent?: (event: string, callback: unknown) => void): Context {
  return {
    on(event: string, callback: unknown) {
      onEvent?.(event, callback)
      return () => {}
    },
    logger: { warn() {} },
    tools: {
      register() {
        return () => {}
      },
    },
    effect() {
      return () => {}
    },
  } as unknown as Context
}

function register(): Listener {
  let listener: Listener | undefined
  const ctx = fakeCtx((event, callback) => {
    if (event === 'system-prompt/assemble') listener = callback as Listener
  })
  Bootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
  if (listener === undefined) throw new Error('bootstrap listener was not registered')
  return listener
}

function registerPreStep(): PreStepListener {
  let listener: PreStepListener | undefined
  const ctx = fakeCtx((event, callback) => {
    if (event === 'agent/pre-step') listener = callback as PreStepListener
  })
  Bootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
  if (listener === undefined) throw new Error('bootstrap pre-step listener was not registered')
  return listener
}

const tools = ['bash', 'grep', 'pwsh', 'read', 'str_replace_editor', 'write', 'dev_router_status'].map(name => ({
  name,
  description: name,
  parameters: { type: 'object' },
}))

async function assemble(
  listener: Listener,
  events: Array<{ type: string; data?: unknown }>,
  options?: { routingSuite?: boolean; routingSpec?: boolean; model?: string },
): Promise<PromptAssembly> {
  const assembly: PromptAssembly = {
    sections: [{ name: 'standard', text: 'standard prompt' }],
    contexts: [{ name: 'runtime', text: 'runtime context' }],
    tools,
    variables: {},
  }
  const agentPreset = options?.routingSpec === true
    ? ROUTING_SUITE_SPEC_PRESET
    : options?.routingSuite === true
      ? ROUTING_SUITE_PRESET
      : undefined
  return await listener(
    assembly,
    {
      agent: {
        options: { model: options?.model ?? 'deepseek-v4-pro' },
        session: {
          header: agentPreset === undefined ? {} : { agentPreset },
          events,
        },
      },
    } as never,
    () => Promise.resolve(assembly),
  )
}

describe('anchored tool bootstrap', () => {
  it('declares every Cordis service used during plugin activation', () => {
    expect(inject).toEqual(['tools', 'llm'])
    expect(Bootstrap.inject).toEqual(inject)
  })

  it('uses the Minimal prompt and two tools, then durably restores the full catalog', async () => {
    const listener = register()
    const first = await assemble(listener, [])
    expect(renderPrompt(first)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(first.contexts).toEqual([])
    expect(first.tools.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])

    const promoted = await assemble(listener, [{ type: 'tool/call' }])
    expect(renderPrompt(promoted)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(promoted.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'pwsh', 'read', 'str_replace_editor', 'write'])

    const textOnlyPromoted = await assemble(register(), [{ type: 'assistant/message' }])
    expect(textOnlyPromoted.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'pwsh', 'read', 'str_replace_editor', 'write'])
  })

  it('leaves the adapter output budget untouched unless a cap is explicitly configured', () => {
    const events: string[] = []
    const ctx = fakeCtx(event => events.push(event))
    Bootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
    expect(events).not.toContain('agent/request')
  })

  it('ports Router Standard classification without exposing the mixed trap', () => {
    expect(classifyRouterTask('创建一个新的网页工具')).toBe('react')
    expect(classifyRouterTask('修复崩溃并兼容 Windows')).toBe('spec')
    expect(classifyRouterTask('tell me what this repository does')).toBe('weak')
    // v0.2.0: ambiguous/unmatched text is the weak internal-routing band.
    expect(classifyRouterTask('\u641c\u7d22\u4e00\u4e0b\u76ee\u524d DeepSeek Harness \u7684\u4fe1\u606f')).toBe('weak')
    // Upstream REACT_RE matches the bare token `implement`, so `implementation` routes react.
    expect(classifyRouterTask('investigate the current implementation')).toBe('react')
  })

  it('keeps Router Standard on the RL-shape surface and promotes only after a tool call', async () => {
    const input = { type: 'tui/input', data: { text: '创建一个新项目' } }
    const first = await assemble(register(), [input], { routingSuite: true })
    expect(first.sections.map(section => section.name)).toEqual(['router-persona'])
    expect(first.sections[0]?.text).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(renderPrompt(first)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(first.tools.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])
    expect(first.contexts).toEqual([])

    const textOnly = await assemble(register(), [input, { type: 'assistant/message' }], { routingSuite: true })
    expect(textOnly.tools.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])

    const promoted = await assemble(register(), [input, { type: 'tool/call' }], { routingSuite: true })
    expect(promoted.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'read', 'str_replace_editor', 'write', 'dev_router_status'])
    expect(promoted.sections[0]?.text).toBe(MINIMAL_SYSTEM_PROMPT)
  })

  it('keeps every Router Standard task class on the RL-shape surface', async () => {
    for (const text of ['创建一个新项目', '修复 Windows 崩溃', 'explain this repository']) {
      const result = await assemble(register(), [{ type: 'tui/input', data: { text } }], { routingSuite: true })
      expect(result.sections[0]?.text).toBe(MINIMAL_SYSTEM_PROMPT)
      expect(result.tools.map(tool => tool.name)).toEqual(['bash', 'str_replace_editor'])
    }
  })

  it('routes Router Spec through the classified persona and legacy core tools', async () => {
    const reactInput = { type: 'tui/input', data: { text: '创建一个新项目' } }
    const react = await assemble(register(), [reactInput], { routingSpec: true })
    expect(react.sections.map(section => section.name)).toEqual(['standard', 'router-persona'])
    expect(react.sections.find(section => section.name === 'router-persona')?.text)
      .toBe(personaFor(1, 'deepseek-v4-pro'))
    expect(react.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(react.contexts).toEqual([])

    const spec = await assemble(register(), [{ type: 'tui/input', data: { text: '修复崩溃并兼容 Windows' } }], { routingSpec: true })
    expect(spec.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'read'])

    const weak = await assemble(register(), [{ type: 'tui/input', data: { text: 'tell me what this repository does' } }], { routingSpec: true })
    expect(weak.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(weak.sections.find(section => section.name === 'router-persona')?.text)
      .toBe(personaFor('weak', 'deepseek-v4-pro'))

    const promoted = await assemble(register(), [reactInput, { type: 'tool/call' }], { routingSpec: true })
    expect(promoted.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'read', 'str_replace_editor', 'write', 'dev_router_status'])
  })

  it('appends the v0.2.0 near-field guide only for weak-band Router sessions', async () => {
    const listener = registerPreStep()
    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'tell me what this repository does' }],
    })
    const weak = await listener(
      {
        agent: {
          session: {
            header: { agentPreset: ROUTING_SUITE_PRESET },
            events: [{ type: 'tui/input', data: { text: 'tell me what this repository does' } }],
          },
        },
        messages: [user],
      },
      () => Promise.resolve({ kind: 'accept', messages: [user] }),
    )
    expect(weak.messages).toHaveLength(2)
    const guide = weak.messages.at(1)
    expect(guide).toBeDefined()
    if (guide === undefined) throw new Error('weak guidance message missing')
    expect(guide.source.kind).toBe('plugin')
    expect(guide.content[0]?.text).toContain('Router: classify this task')

    const strongUser = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: '创建一个新项目' }],
    })
    const strong = await listener(
      {
        agent: {
          session: {
            header: { agentPreset: ROUTING_SUITE_PRESET },
            events: [{ type: 'tui/input', data: { text: '创建一个新项目' } }],
          },
        },
        messages: [strongUser],
      },
      () => Promise.resolve({ kind: 'accept', messages: [strongUser] }),
    )
    expect(strong.messages).toHaveLength(1)
  })
})
