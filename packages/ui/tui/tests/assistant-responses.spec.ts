import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assistantCodeBlocks,
  visibleAssistantResponse,
  visibleAssistantResponses,
} from '../src/chat/assistant-responses.ts'

function assistant(
  seq: number,
  content: unknown[],
  surfaceOp: unknown = 'append',
): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    surfaceOp,
    data: { message: { content } },
  } as unknown as SessionEvent
}

describe('assistant response selection', () => {
  it('returns append-origin visible text newest-first without reasoning or replacements', () => {
    const events = [
      assistant(1, [{ type: 'text', text: 'older ' }, { type: 'text', text: 'answer' }]),
      assistant(2, [{ type: 'reasoning', text: 'private chain' }]),
      assistant(3, [{ type: 'text', text: 'replacement-only' }], { op: 'replace', start: 1, end: 2 }),
      assistant(4, [{ type: 'text', text: '   \n' }]),
      assistant(5, [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }]),
      assistant(6, [{ type: 'text', text: '\nnewest answer\n' }]),
      { type: 'user/message', seq: 7, time: 7, surfaceOp: 'append', data: {} } as unknown as SessionEvent,
    ]

    expect(visibleAssistantResponses(events)).toEqual([
      { eventSeq: 6, text: '\nnewest answer\n' },
      { eventSeq: 1, text: 'older answer' },
    ])
    expect(visibleAssistantResponse(events)?.text).toBe('\nnewest answer\n')
    expect(visibleAssistantResponse(events, 2)?.text).toBe('older answer')
    expect(visibleAssistantResponse(events, 0)).toBeUndefined()
    expect(visibleAssistantResponse(events, 3)).toBeUndefined()
  })

  it('extracts backtick, tilde, longer, CRLF, and unclosed fenced code bodies', () => {
    const text = [
      'prose',
      '```ts title=demo',
      'const answer = 42',
      '```',
      '~~~~ shell',
      'echo one',
      '~~~',
      'echo two',
      '~~~~',
      '```bad`info',
      'not a fence',
      '~~~python',
      'print("tail")',
    ].join('\r\n')

    expect(assistantCodeBlocks(text)).toEqual([
      { index: 1, language: 'ts', text: 'const answer = 42' },
      { index: 2, language: 'shell', text: 'echo one\r\n~~~\r\necho two' },
      { index: 3, language: 'python', text: 'print("tail")' },
    ])
  })

  it('keeps empty fences and ignores indented or invalid backtick openings', () => {
    expect(assistantCodeBlocks([
      '    ```ts',
      'not fenced',
      '```js`bad',
      'also not fenced',
      '```',
      '```',
    ].join('\n'))).toEqual([{ index: 1, text: '' }])
  })
})
