import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { renderPrompt, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Bootstrap, {
  classifyRouterTask,
  MINIMAL_SYSTEM_PROMPT,
  ROUTING_SUITE_PRESET,
} from '../src/bootstrap.ts'

type Listener = (
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

function register(): Listener {
  let listener: Listener | undefined
  const ctx = {
    on(event: string, callback: Listener) {
      if (event === 'system-prompt/assemble') listener = callback
      return () => {}
    },
    logger: { warn() {} },
  } as unknown as Context
  Bootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
  if (listener === undefined) throw new Error('bootstrap listener was not registered')
  return listener
}

const tools = ['bash', 'grep', 'pwsh', 'read', 'str_replace_editor', 'write'].map(name => ({
  name,
  description: name,
  parameters: { type: 'object' },
}))

async function assemble(
  listener: Listener,
  events: Array<{ type: string; data?: unknown }>,
  options?: { routingSuite?: boolean; model?: string },
): Promise<PromptAssembly> {
  const assembly: PromptAssembly = {
    sections: [{ name: 'standard', text: 'standard prompt' }],
    contexts: [{ name: 'runtime', text: 'runtime context' }],
    tools,
    variables: {},
  }
  return await listener(
    assembly,
    {
      agent: {
        options: { model: options?.model ?? 'deepseek-v4-pro' },
        session: {
          header: options?.routingSuite ? { agentPreset: ROUTING_SUITE_PRESET } : {},
          events,
        },
      },
    } as never,
    () => Promise.resolve(assembly),
  )
}

describe('anchored tool bootstrap', () => {
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
    const ctx = {
      on(event: string) {
        events.push(event)
        return () => {}
      },
      logger: { warn() {} },
    } as unknown as Context
    Bootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
    expect(events).not.toContain('agent/request')
  })

  it('ports Router Standard classification without exposing the mixed trap', () => {
    expect(classifyRouterTask('创建一个新的网页工具')).toBe('react')
    expect(classifyRouterTask('修复崩溃并兼容 Windows')).toBe('spec')
    expect(classifyRouterTask('tell me what this repository does')).toBe('weak')
    expect(classifyRouterTask('\u641c\u7d22\u4e00\u4e0b\u76ee\u524d DeepSeek Harness \u7684\u4fe1\u606f')).toBe('spec')
    expect(classifyRouterTask('investigate the current implementation')).toBe('spec')
  })

  it('locks Routing Suite to its first task and promotes only after a tool call', async () => {
    const input = { type: 'tui/input', data: { text: '创建一个新项目' } }
    const first = await assemble(register(), [input], { routingSuite: true })
    expect(first.sections[0]?.name).toBe('router-suite:react')
    expect(first.sections[0]?.text).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(renderPrompt(first)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(first.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(first.contexts).toEqual([])

    const textOnly = await assemble(register(), [input, { type: 'assistant/message' }], { routingSuite: true })
    expect(textOnly.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])

    const promoted = await assemble(register(), [input, { type: 'tool/call' }], { routingSuite: true })
    expect(promoted.tools.map(tool => tool.name)).toEqual(['bash', 'grep', 'read', 'str_replace_editor', 'write'])
  })

  it('keeps every Router task class on the minimal spec persona', async () => {
    for (const text of ['创建一个新项目', '修复 Windows 崩溃', 'explain this repository']) {
      const result = await assemble(register(), [{ type: 'tui/input', data: { text } }], { routingSuite: true })
      expect(result.sections[0]?.text).toBe(MINIMAL_SYSTEM_PROMPT)
    }
  })
})
