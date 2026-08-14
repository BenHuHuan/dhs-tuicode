import type { Context } from '@deepseek-ai/cordis'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const CONTROL_PROBE = '\u001b]2;MODEL_CONTROLLED\u0007\u001b[999CMODEL_CURSOR\u009b31mMODEL_C1'
const INITIAL_TEXT = `I need one decision before I continue. ${CONTROL_PROBE}`
const FINAL_TEXT = 'Decision received. Scripted TUI run complete.'
const DEFAULT_MODE_PROBE = 'Confirm the scripted run left plan mode.'
const DEFAULT_MODE_TEXT = 'Default mode confirmed.'
// The `skill` scenario types `/skill:scripted-skill`; the manual-invocation front
// door delivers the loaded skill as a user turn wrapped in `<skill name="…">`. The
// body marker below lives in the fixture skill, so echoing it back proves the whole
// block (name attribute plus body) reached the model, not just the command text.
const SKILL_BLOCK_OPEN = '<skill name="scripted-skill">'
const SKILL_BODY_MARKER = 'SCRIPTED SKILL BODY MARKER'
const SKILL_RECEIVED_TEXT = 'Scripted skill body received.'
const DIRECT_SHELL_FRAME = '<user-shell-command>'
const DIRECT_SHELL_MARKER = 'DIRECT_SHELL_E2E'
const DIRECT_SHELL_RECEIVED_TEXT = 'Direct shell output received.'
const TITLE_TEXT = 'scripted session title'
// The failing-shell scenario proves the terminal card reports a non-zero exit
// exactly once: the model-facing result carries the `[exit code: N]` marker, and
// the card turns it into its own `[exit N]` pill instead of showing both.
const SHELL_FAILURE_PROBE = 'Run the failing scripted command.'
const SHELL_FAILURE_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_FAILURE_COMMAND = process.platform === 'win32'
  ? 'Write-Output "SCRIPTED_SHELL_FAILED"; exit 3'
  : 'printf "SCRIPTED_SHELL_FAILED\\n"; exit 3'
const SHELL_FAILURE_TEXT = 'Scripted shell failure observed.'
const SHELL_FAILURE_CALL_ID = CallId('call-shell-failure')
const CHECKLIST_FIRST_PROBE = 'Create the first scripted task checklist.'
const CHECKLIST_UPDATED_PROBE = 'Update the scripted task checklist while it is hidden.'
const CHECKLIST_FIRST_ITEM = 'Keep the scripted checklist visible'
const CHECKLIST_UPDATED_ITEM = 'Restore the latest hidden checklist state'
const CHECKLIST_FIRST_TEXT = 'First scripted checklist written.'
const CHECKLIST_UPDATED_TEXT = 'Hidden scripted checklist updated.'
const CHECKLIST_FIRST_CALL_ID = CallId('call-checklist-first')
const CHECKLIST_UPDATED_CALL_ID = CallId('call-checklist-updated')
const EXTERNAL_EDITOR_PROBE = 'External editor PTY prompt.'
const EXTERNAL_EDITOR_TEXT = 'External editor prompt received.'
const RESPONSE_FILE_PROBE = 'Response file PTY prompt.'
const RESPONSE_FILE_BODY = 'export const responseFile = true'
const RESPONSE_FILE_TEXT = ['Write this module:', '```ts', RESPONSE_FILE_BODY, '```'].join('\n')
const CLIPBOARD_IMAGE_PROBE = 'Describe the clipboard image.'
const CLIPBOARD_IMAGE_TEXT = 'Clipboard image received.'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function checklistChunks(callId: CallId, content: string): StreamChunk[] {
  const args = JSON.stringify({ todos: [{ content, status: 'in_progress' }] })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'todo_write', argumentsDelta: args },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'todo_write', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Keyless adapter for the real-PTY TUI tests: the two-step conversation and the `/skill:` round-trip. */
class ScriptedTuiAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'tui-scripted-model', name: 'Scripted Base', inputModalities: ['text', 'image'] },
      { provider, id: 'tui-scripted-model-pro', name: 'Scripted Pro', inputModalities: ['text', 'image'] },
    ])
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'tui-scripted-model-pro' ? 'Scripted Pro' : 'Scripted Base',
      context: { contextWindow: 128_000 },
      inputModalities: ['text', 'image'],
      ...model !== 'tui-scripted-model-pro'
        ? {}
        : {
          reasoning: {
            efforts: [
              { id: ReasoningEffortId('off'), name: 'Off' },
              { id: ReasoningEffortId('high'), name: 'High' },
              { id: ReasoningEffortId('max'), name: 'Max' },
            ],
            defaultEffort: ReasoningEffortId('high'),
          },
        },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The session-title provider's auxiliary request carries no tool schemas,
    // unlike every agent turn; answer it with a fixed title so the PTY test can
    // assert the logged title reaches the terminal window title.
    if ((options.tools?.length ?? 0) === 0) {
      for (const chunk of textChunks(TITLE_TEXT)) yield chunk
      return
    }
    if (
      options.model !== 'tui-scripted-model-pro'
      || !options.system?.includes('tui-scripted-model-pro')
      || options.reasoningEffort !== ReasoningEffortId('max')
    ) {
      throw new Error([
        'the scripted TUI request did not apply the selected model and reasoning effort',
        `model=${options.model}`,
        `reasoningEffort=${String(options.reasoningEffort)}`,
        `systemHasSelectedModel=${String(options.system?.includes('tui-scripted-model-pro') ?? false)}`,
      ].join('; '))
    }
    const lastMessage = options.messages.at(-1)
    // The loop appends plugin-sourced context (the plan-mode notice, the
    // tool-skill catalog) AFTER the admitted prompt, so the scripted trigger
    // may sit one or more user messages back: scan the whole trailing run of
    // user-role messages since the last assistant message.
    const trailingUserTexts: string[] = []
    let trailingUserHasImage = false
    for (let index = options.messages.length - 1; index >= 0; index--) {
      const message = options.messages[index]
      if (message?.role !== 'user') break
      for (const block of message.content) {
        if (block.type === 'text') trailingUserTexts.push(block.text)
        if (block.type === 'image') trailingUserHasImage = true
      }
    }
    const lastText = trailingUserTexts.join('\n')
    if (lastText.includes(DIRECT_SHELL_FRAME)) {
      const ack = lastText.includes(DIRECT_SHELL_MARKER)
        ? DIRECT_SHELL_RECEIVED_TEXT
        : 'Direct shell context arrived without its output.'
      for (const chunk of textChunks(ack)) yield chunk
      return
    }
    if (lastText.includes(DEFAULT_MODE_PROBE)) {
      if (options.system?.includes('Stay in plan mode for this scripted TUI test.')) {
        throw new Error('the scripted TUI request retained plan guidance after /plan off')
      }
      for (const chunk of textChunks(DEFAULT_MODE_TEXT)) yield chunk
      return
    }
    if (lastText.includes(SKILL_BLOCK_OPEN)) {
      const ack = lastText.includes(SKILL_BODY_MARKER)
        ? SKILL_RECEIVED_TEXT
        : 'Scripted skill block arrived without its body.'
      for (const chunk of textChunks(ack)) yield chunk
      return
    }

    const blocks = lastMessage?.content ?? []
    if (blocks.some(block => block.type === 'tool-result')) {
      const answeredShell = blocks.some(block =>
        block.type === 'tool-result' && block.toolCallId === SHELL_FAILURE_CALL_ID)
      if (answeredShell) {
        for (const chunk of textChunks(SHELL_FAILURE_TEXT)) yield chunk
        return
      }
      const answeredFirstChecklist = blocks.some(block =>
        block.type === 'tool-result' && block.toolCallId === CHECKLIST_FIRST_CALL_ID)
      if (answeredFirstChecklist) {
        for (const chunk of textChunks(CHECKLIST_FIRST_TEXT)) yield chunk
        return
      }
      const answeredUpdatedChecklist = blocks.some(block =>
        block.type === 'tool-result' && block.toolCallId === CHECKLIST_UPDATED_CALL_ID)
      if (answeredUpdatedChecklist) {
        for (const chunk of textChunks(CHECKLIST_UPDATED_TEXT)) yield chunk
        return
      }
      const toolResultText = blocks.flatMap(block => block.type === 'tool-result'
        ? block.content.flatMap(content => content.type === 'text' ? [content.text] : [])
        : []).join('\n')
      if (toolResultText !== '{"answers":[{"id":"mode","selected":["Safe"],"custom":"Release notes"}]}') {
        throw new Error(`the scripted TUI request received an unexpected question answer: ${toolResultText}`)
      }
      for (const chunk of textChunks(FINAL_TEXT)) yield chunk
      return
    }
    if (lastText.includes(SHELL_FAILURE_PROBE)) {
      const shellArgs = JSON.stringify({ command: SHELL_FAILURE_COMMAND, description: 'Run the failing scripted command' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: SHELL_FAILURE_CALL_ID, name: SHELL_FAILURE_TOOL, argumentsDelta: shellArgs }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: SHELL_FAILURE_CALL_ID, name: SHELL_FAILURE_TOOL, arguments: shellArgs },
      }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (lastText.includes(CHECKLIST_FIRST_PROBE)) {
      for (const chunk of checklistChunks(CHECKLIST_FIRST_CALL_ID, CHECKLIST_FIRST_ITEM)) yield chunk
      return
    }
    if (lastText.includes(CHECKLIST_UPDATED_PROBE)) {
      for (const chunk of checklistChunks(CHECKLIST_UPDATED_CALL_ID, CHECKLIST_UPDATED_ITEM)) yield chunk
      return
    }
    if (lastText.includes(EXTERNAL_EDITOR_PROBE)) {
      for (const chunk of textChunks(EXTERNAL_EDITOR_TEXT)) yield chunk
      return
    }
    if (lastText.includes(RESPONSE_FILE_PROBE)) {
      for (const chunk of textChunks(RESPONSE_FILE_TEXT)) yield chunk
      return
    }
    if (lastText.includes(CLIPBOARD_IMAGE_PROBE)) {
      if (!trailingUserHasImage) throw new Error('the scripted clipboard prompt arrived without an image block')
      for (const chunk of textChunks(CLIPBOARD_IMAGE_TEXT)) yield chunk
      return
    }

    const args = JSON.stringify({
      questions: [{
        id: 'mode',
        header: 'Execution mode',
        question: 'How should the scripted run proceed?',
        multi_select: true,
        options: [
          { label: 'Safe', description: 'Use the guarded path.' },
          { label: 'Fast', description: 'Use the shorter path.' },
        ],
      }],
    })
    const callId = CallId('call-ask-mode')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of INITIAL_TEXT) yield { type: 'text-delta', index: 0, text: char }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: INITIAL_TEXT } }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: callId, name: 'ask_user_question', argumentsDelta: args }
    yield {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args },
    }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'tui-scripted-llm'
export const inject = ['llm']

/** Register the network-free adapter used by the PTY fixture. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['tui-scripted'], new ScriptedTuiAdapter())
}
