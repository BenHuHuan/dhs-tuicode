import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { renderPrompt, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Bootstrap, { MINIMAL_SYSTEM_PROMPT } from '../src/bootstrap.ts'

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
  Bootstrap(ctx, { shellTools: ['bash', 'pwsh'], commonTools: ['read'] })
  if (listener === undefined) throw new Error('bootstrap listener was not registered')
  return listener
}

const tools = ['grep', 'pwsh', 'read', 'write'].map(name => ({
  name,
  description: name,
  parameters: { type: 'object' },
}))

async function assemble(listener: Listener, events: { type: string }[]): Promise<PromptAssembly> {
  const assembly: PromptAssembly = {
    sections: [{ name: 'standard', text: 'standard prompt' }],
    contexts: [{ name: 'runtime', text: 'runtime context' }],
    tools,
    variables: {},
  }
  return await listener(
    assembly,
    { agent: { session: { events } } } as never,
    () => Promise.resolve(assembly),
  )
}

describe('anchored tool bootstrap', () => {
  it('uses the Minimal prompt and two tools, then durably restores the full catalog', async () => {
    const listener = register()
    const first = await assemble(listener, [])
    expect(renderPrompt(first)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(first.contexts).toEqual([])
    expect(first.tools.map(tool => tool.name)).toEqual(['pwsh', 'read'])

    const promoted = await assemble(listener, [{ type: 'tool/call' }])
    expect(renderPrompt(promoted)).toBe(MINIMAL_SYSTEM_PROMPT)
    expect(promoted.tools.map(tool => tool.name)).toEqual(['grep', 'pwsh', 'read', 'write'])

    const textOnlyPromoted = await assemble(register(), [{ type: 'assistant/message' }])
    expect(textOnlyPromoted.tools.map(tool => tool.name)).toEqual(['grep', 'pwsh', 'read', 'write'])
  })
})
