import { describe, expect, it } from 'vitest'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateTuiInputEvent } from '../src/invariant.ts'

const session = { id: SessionId('history-invariant') } as Session

function event(text: unknown): SessionEvent {
  return {
    type: 'tui/input',
    seq: 0,
    time: 1,
    data: { text },
  } as unknown as SessionEvent
}

const fail = (message: string): never => { throw new Error(message) }

describe('TUI runtime invariant', () => {
  it('accepts normalized distinct history and preserves state over foreign events', () => {
    expect(validateTuiInputEvent(session, event('prompt'), undefined, fail)).toBe('prompt')
    expect(validateTuiInputEvent(session, {
      type: 'turn/start', seq: 1, time: 2, data: { turn: 1 },
    }, 'prompt', fail)).toBe('prompt')
  })

  it.each([undefined, 1, '', ' prompt', 'prompt '])('rejects malformed history text %j', (text) => {
    expect(() => validateTuiInputEvent(session, event(text), undefined, fail))
      .toThrow('must carry non-empty trimmed text')
  })

  it('rejects consecutive duplicate history entries', () => {
    expect(() => validateTuiInputEvent(session, event('prompt'), 'prompt', fail))
      .toThrow('repeats the preceding input')
  })
})
