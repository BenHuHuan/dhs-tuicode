/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tui`.
 * @module @deepseek-ai/dsh-tui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tui'

/** Cordis companion plugin name. */
export const name = 'tui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate normalized, consecutive-distinct TUI input history for one session.
 * @param session - Session whose complete log or newly appended event is read.
 * @param event - Candidate event in that session.
 * @param previous - Last accepted TUI input text before the candidate.
 * @param fail - Runtime invariant reporter.
 * @returns candidate text when it is a TUI input, otherwise the prior value.
 */
export function validateTuiInputEvent(
  session: Session,
  event: SessionEvent,
  previous: string | undefined,
  fail: InvariantFailure,
): string | undefined {
  if (event.type !== 'tui/input') return previous
  const text = (event.data as { text?: unknown }).text
  if (typeof text !== 'string' || text === '' || text !== text.trim()) {
    fail(`tui/input in session ${JSON.stringify(session.id)} must carry non-empty trimmed text`)
    return previous
  }
  if (text === previous) {
    fail(`tui/input in session ${JSON.stringify(session.id)} repeats the preceding input ${JSON.stringify(text)}`)
  }
  return text
}

/** Install validation over loaded logs and newly appended TUI history events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const previousBySession = new WeakMap<Session, string | undefined>()
  const seed = (session: Session): void => {
    let previous: string | undefined
    for (const event of session.events) previous = validateTuiInputEvent(session, event, previous, fail)
    previousBySession.set(session, previous)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const previous = validateTuiInputEvent(session, event, previousBySession.get(session), fail)
    previousBySession.set(session, previous)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
