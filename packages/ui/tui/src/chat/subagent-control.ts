/**
 * Human stop-all control for the two background-subagent lifecycles exposed by
 * a full Harness composition: one-shot jobs and continuable child Agents.
 * @module @deepseek-ai/dsh-tui/chat/subagent-control
 */

import { Key, matchesKey } from '@earendil-works/pi-tui'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

const LEGACY_CTRL_X_CTRL_K = '\x18\x0b'
const STOP_REASON = 'Stopped from the TUI with Ctrl+X Ctrl+K'

/** Action selected by the stateful stop-all-subagents chord recognizer. */
export type SubagentKillShortcutResult = 'invoke' | 'consume' | 'pass'

/** Recognize the readline-style `Ctrl+X Ctrl+K` chord across terminal chunks. */
export class SubagentKillShortcut {
  private ctrlXArmed = false

  /**
   * Consume one raw terminal input chunk.
   * @param data - Raw input received from the terminal.
   * @returns Whether to invoke, consume, or forward the input.
   */
  handle(data: string): SubagentKillShortcutResult {
    if (data === LEGACY_CTRL_X_CTRL_K) {
      this.ctrlXArmed = false
      return 'invoke'
    }
    if (this.ctrlXArmed) {
      this.ctrlXArmed = false
      if (matchesKey(data, Key.ctrl('k'))) return 'invoke'
      if (matchesKey(data, Key.ctrl('x'))) {
        this.ctrlXArmed = true
        return 'consume'
      }
      return 'pass'
    }
    if (matchesKey(data, Key.ctrl('x'))) {
      this.ctrlXArmed = true
      return 'consume'
    }
    return 'pass'
  }

  /** Clear a pending `Ctrl+X` prefix. */
  reset(): void {
    this.ctrlXArmed = false
  }
}

/** One contained cancellation failure; other targets are still attempted. */
export interface BackgroundSubagentStopFailure {
  readonly target: string
  readonly error: unknown
}

/** Aggregate result of one confirmed stop-all request. */
export interface BackgroundSubagentStopResult {
  /** Cancellation requests synchronously accepted by their owners. */
  readonly requested: number
  /** One-shot jobs that settled between discovery and cancellation. */
  readonly alreadyFinished: number
  /** Discovery or per-target failures, retained without short-circuiting. */
  readonly failures: readonly BackgroundSubagentStopFailure[]
}

/** Optional runtime services used by the stop-all operation. */
export interface BackgroundSubagentControl {
  readonly agent: Agent
  readonly agents: Pick<AgentRegistry, 'get'>
  readonly jobs?: Pick<JobRegistry, 'list' | 'kill'>
  readonly subagents?: Pick<SubagentRuntime, 'listChildren' | 'interrupt'>
}

/**
 * Stop every directly owned background subagent that is still doing work.
 *
 * One-shot children are agent-owned `kind: subagent` job records. Continuable
 * children are direct durable descendants whose live Agent is currently
 * running; resident-but-idle continuations are deliberately left available for
 * a later follow-up. Each target is independently contained so one broken
 * producer cannot shield its siblings from a human stop request.
 *
 * @param control - Exact parent authority and optional lifecycle services.
 * @param signal - Cancels discovery before cancellation side effects begin.
 * @returns Counts and contained failures from the confirmed operation.
 */
export async function stopRunningBackgroundSubagents(
  control: BackgroundSubagentControl,
  signal: AbortSignal,
): Promise<BackgroundSubagentStopResult> {
  const { agent, agents, jobs, subagents } = control
  const failures: BackgroundSubagentStopFailure[] = []
  let jobTargets: ReturnType<JobRegistry['list']> = []
  if (jobs !== undefined) {
    try {
      jobTargets = jobs.list(agent).filter(snapshot =>
        snapshot.kind === 'subagent'
        && snapshot.ownerSession === agent.id
        && snapshot.status === 'running')
    } catch (error: unknown) {
      failures.push({ target: 'one-shot subagent discovery', error })
    }
  }

  let continuableTargets: Awaited<ReturnType<SubagentRuntime['listChildren']>> = []
  if (subagents !== undefined) {
    try {
      continuableTargets = (await subagents.listChildren(agent.id, signal)).filter(entry =>
        entry.kind === 'child'
        && entry.mode === 'continuable'
        && entry.activity === 'running'
        && agents.get(entry.id)?.status === 'running')
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      failures.push({ target: 'continuable subagent discovery', error })
    }
  }
  signal.throwIfAborted()

  let requested = 0
  let alreadyFinished = 0
  for (const snapshot of jobTargets) {
    signal.throwIfAborted()
    try {
      const outcome = jobs?.kill(snapshot.id, agent, STOP_REASON)
      if (outcome === 'requested') requested += 1
      else if (outcome === 'already-finished') alreadyFinished += 1
    } catch (error: unknown) {
      failures.push({ target: snapshot.id, error })
    }
  }
  for (const entry of continuableTargets) {
    signal.throwIfAborted()
    /* v8 ignore next -- the filter above narrows every retained entry. */
    if (entry.kind !== 'child') continue
    // Recheck the live edge after asynchronous discovery: an already-settled
    // child is not a cancellation request and does not inflate the result.
    if (agents.get(entry.id)?.status !== 'running') continue
    try {
      subagents?.interrupt(entry.id, { kind: 'ancestor', agent })
      requested += 1
    } catch (error: unknown) {
      failures.push({ target: entry.id, error })
    }
  }
  return { requested, alreadyFinished, failures }
}
