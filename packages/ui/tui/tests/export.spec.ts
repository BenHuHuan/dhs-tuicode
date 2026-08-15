import { describe, expect, it } from 'vitest'
import {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  defaultConversationExportFilename,
  exportConversationText,
} from '../src/chat/export.ts'

const CREATED_AT = Date.UTC(2026, 7, 15, 9, 30, 0)
const FIRST_EVENT_AT = CREATED_AT + 1_000

const header: SessionHeader = {
  version: 0,
  id: SessionId('export-session'),
  cwd: '/workspace/project',
  createdAt: CREATED_AT,
}

describe('conversation export', () => {
  it('uses a relative safe default filename', () => {
    const filename = defaultConversationExportFilename(SessionId('parent/child\\unsafe name'))

    expect(filename).toBe('dsh-session-parent_child_unsafe_name.txt')
    expect(filename).not.toContain('/')
    expect(filename).not.toContain('\\')
  })

  it('renders durable messages, tool traffic, and incomplete turn markers in log order', () => {
    const callId = CallId('read-1')
    const events: SessionEvent[] = [
      {
        type: 'turn/start',
        seq: 1,
        time: FIRST_EVENT_AT,
        data: { turn: 1 },
      },
      {
        type: 'user/message',
        seq: 2,
        time: FIRST_EVENT_AT + 1_000,
        data: createUserMessage({
          content: [{ type: 'text', text: 'Read the project README.' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: 3,
        time: FIRST_EVENT_AT + 2_000,
        data: createUserMessage({
          content: [{ type: 'text', text: 'The README changed after the prompt.' }],
          source: { kind: 'plugin', plugin: 'workspace-watch' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'assistant/message',
        seq: 4,
        time: FIRST_EVENT_AT + 3_000,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will inspect it. ' },
              { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"README.md"}' },
            ],
            source: { kind: 'model', provider: 'mock', model: 'mock-1' },
          }),
        },
        surfaceOp: 'append',
      },
      {
        type: 'tool/call',
        seq: 5,
        time: FIRST_EVENT_AT + 4_000,
        data: {
          turn: 1,
          step: 1,
          callId,
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: 'tool/result',
        seq: 6,
        time: FIRST_EVENT_AT + 5_000,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: '# Project README' }],
            isError: true,
          }),
          error: { name: 'FileError', code: 'EACCES' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'request/header',
        seq: 7,
        time: FIRST_EVENT_AT + 6_000,
        data: {
          header: { config: { provider: 'mock', model: 'mock-1' } },
          reason: 'initial',
        },
      },
      {
        type: 'turn/end',
        seq: 8,
        time: FIRST_EVENT_AT + 7_000,
        data: { turn: 1, reason: { kind: 'blocked' } },
      },
    ]

    expect(exportConversationText({ id: header.id, header, events }, 'README review')).toBe([
      'DeepSeek Harness conversation',
      'Session: export-session',
      'Title: README review',
      'Directory: /workspace/project',
      'Created: 2026-08-15T09:30:00.000Z',
      '',
      '=== User · 2026-08-15T09:30:02.000Z ===',
      'Read the project README.',
      '',
      '=== Context · workspace-watch · 2026-08-15T09:30:03.000Z ===',
      'The README changed after the prompt.',
      '',
      '=== Assistant · 2026-08-15T09:30:04.000Z ===',
      'I will inspect it. read_file({"path":"README.md"})',
      '',
      '=== Tool call · read_file · 2026-08-15T09:30:05.000Z ===',
      '{"path":"README.md"}',
      '',
      '=== Tool result · read_file · 2026-08-15T09:30:06.000Z ===',
      '# Project README',
      '[FileError: EACCES]',
      '',
      '=== System · 2026-08-15T09:30:08.000Z ===',
      'Turn stopped: the agent is blocked.',
      '',
    ].join('\n'))
  })

  it('omits absent optional header fields and completed turn bookkeeping', () => {
    const bareHeader: SessionHeader = {
      version: 0,
      id: SessionId('bare'),
      createdAt: CREATED_AT,
    }
    const text = exportConversationText({
      id: bareHeader.id,
      header: bareHeader,
      events: [{
        type: 'turn/end',
        seq: 1,
        time: FIRST_EVENT_AT,
        data: { turn: 1, reason: { kind: 'completed' } },
      }],
    }, undefined)

    expect(text).toBe([
      'DeepSeek Harness conversation',
      'Session: bare',
      'Created: 2026-08-15T09:30:00.000Z',
      '',
    ].join('\n'))
  })
})
