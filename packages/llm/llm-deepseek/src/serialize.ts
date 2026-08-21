/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call turns, as required by
 * thinking-mode passback. With the durable attachment service supplied, user image blocks become
 * OpenAI-compatible `image_url` data URLs for the vision route; system and assistant images, and
 * images nested in tool results, are rejected because the API accepts them in user messages only.
 * Unknown declaration-merged block types retain the adapter's documented extension fallback.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  WireContentPart,
  WireMessage,
  WireRequest,
  WireTool,
  WireUserContent,
} from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
  temperature?: number | undefined
  topP?: number | undefined
}

/** Provider limit: largest inline image accepted through `image_url` (base64 or external URL). */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** Provider limit: largest image dimension accepted by the vision route. */
const MAX_IMAGE_DIMENSION = 8192

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject image content before a text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Reject images outside the one role the vision wire format accepts them in. */
function assertUserRoleImagesOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('DeepSeek accepts image content in user messages only.', 'UNSUPPORTED_CONTENT')
  }
}

/** Reject one image the provider cannot accept before base64 expansion. */
function assertImageWithinProviderLimits(ref: ImageAttachmentRef, bytes: number): void {
  if (bytes > MAX_IMAGE_BYTES || ref.bytes > MAX_IMAGE_BYTES) {
    throw new LlmError(
      `DeepSeek inline images must be at most ${MAX_IMAGE_BYTES} bytes.`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (ref.width > MAX_IMAGE_DIMENSION || ref.height > MAX_IMAGE_DIMENSION) {
    throw new LlmError(
      `DeepSeek image dimensions must be at most ${MAX_IMAGE_DIMENSION}px per side.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // Official passback rule (guides/thinking_mode.mdx): reasoning_content
    // must return on tool-call turns; it is ignored on plain turns, so we
    // drop it there to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/** Serialize one tool-result block; its content is text-only on the DeepSeek tool wire. */
function serializeToolResult(block: Extract<ContentBlock, { type: 'tool-result' }>): WireMessage {
  assertUserRoleImagesOnly(block.content)
  return {
    role: 'tool',
    tool_call_id: block.toolCallId,
    // Empty tool output still needs SOME content on the wire.
    content: flattenText(block.content) || '(no output)',
  }
}

/**
 * Convert the non-tool-result blocks of one user message. Text-only content
 * stays a plain string; the presence of any image switches the whole message
 * to the OpenAI-compatible content-part array.
 * @param blocks - user-visible blocks, tool results already removed.
 * @param attachments - durable byte resolver for image references.
 * @returns the wire user content.
 */
async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<WireUserContent> {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        assertImageWithinProviderLimits(block.attachment, block.attachment.bytes)
        const stored = await attachments.readImage(block.attachment)
        assertImageWithinProviderLimits(stored.ref, stored.data.byteLength)
        parts.push({
          type: 'image_url',
          image_url: {
            // Inline base64 data URL, the documented local-file path
            // (guides/vision § Sending Images).
            url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
          },
        })
        break
      }
      default:
        // Other merge-extensible blocks are not DeepSeek wire vocabulary.
        break
    }
  }
  if (parts.length === 0) return ''
  const text = parts.filter(part => part.type === 'text')
  if (text.length === parts.length) return text.map(part => part.text).join('')
  return parts
}

/** Text-only conversation serialization; image blocks are rejected before flattening can erase them. */
function textOnlyMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) wire.push(serializeToolResult(result))
  }
  return wire
}

/** Image-capable conversation serialization, resolving durable image bytes per request. */
async function messagesWithImages(
  messages: Message[],
  attachments: AttachmentStore,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertUserRoleImagesOnly(message.content)
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertUserRoleImagesOnly(message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const content = await userContent(
      message.content.filter(block => block.type !== 'tool-result'),
      attachments,
    )
    const hasUserContent = content.length > 0
    if (hasUserContent || toolResults.length === 0) {
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) wire.push(serializeToolResult(result))
  }
  return wire
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @param attachments - durable attachment service; without it image blocks are rejected text-only style.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[]
export function serializeMessages(messages: Message[], attachments: AttachmentStore): Promise<WireMessage[]>
export function serializeMessages(
  messages: Message[],
  attachments?: AttachmentStore,
): WireMessage[] | Promise<WireMessage[]> {
  return attachments === undefined
    ? textOnlyMessages(messages)
    : messagesWithImages(messages, attachments)
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @param attachments - durable attachment service for image-bearing requests.
 * @returns the chat-completions request body, settled once image bytes resolve.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults?: RequestDefaults,
): WireRequest
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults | undefined,
  attachments: AttachmentStore,
): Promise<WireRequest>
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  attachments?: AttachmentStore,
): WireRequest | Promise<WireRequest> {
  const build = (history: WireMessage[]): WireRequest => {
    const messages: WireMessage[] = []
    if (options.system !== undefined) {
      messages.push({ role: 'system', content: options.system })
    }
    messages.push(...history)

    const tools: WireTool[] | undefined = options.tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    // A short title budget must produce visible text; conversation and
    // compaction calls continue to inherit the adapter's thinking defaults.
    const resolvedThinking = resolveThinking(options, defaults)
    const temperature = options.temperature ?? defaults.temperature

    return {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
      ...resolvedThinking.reasoningEffort !== undefined
        ? { reasoning_effort: resolvedThinking.reasoningEffort }
        : {},
      ...tools !== undefined && tools.length > 0 ? { tools } : {},
      ...temperature === undefined ? {} : { temperature },
      ...defaults.topP === undefined ? {} : { top_p: defaults.topP },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.stop !== undefined ? { stop: options.stop } : {},
    }
  }

  if (attachments === undefined) {
    return build(serializeMessages(options.messages))
  }
  return serializeMessages(options.messages, attachments).then(build)
}
