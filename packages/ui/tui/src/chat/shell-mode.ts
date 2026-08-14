/**
 * Claude-Code-style direct shell input, live process-output retention, and
 * durable model-facing completion context.
 *
 * The TUI controller owns terminal attachment, keyboard routing, and the
 * foreground-to-job ownership transfer. This module owns the stable parsing,
 * bounded one-reader fan-out, and message contracts shared by those paths.
 *
 * @module @deepseek-ai/dsh-tui/chat/shell-mode
 */

import {
  boundContextSummary,
  createUserMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type {
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'

/** Plugin provenance used for durable direct-shell result messages. */
export const USER_SHELL_PLUGIN = 'user-shell'

/** Outer model-facing frame stripped by the TUI's injected-context card. */
export const USER_SHELL_FRAME = 'user-shell-command'

/** A settled direct-shell process after its combined output has been retained. */
export interface UserShellProcessResult {
  /** Process lifecycle after `ShellProcess.done` settles. */
  status: Exclude<ShellProcessStatus, 'running'>
  /** Exit code on ordinary completion, otherwise `null`. */
  exitCode: number | null
  /** Terminating signal when the process was signal-killed. */
  signal: NodeJS.Signals | null
  /** Bounded tail of combined stdout and marked stderr output. */
  output: string
  /** Whether either the process reader or this controller omitted output. */
  outputTruncated: boolean
  /** Full stdout spill file when the executor made one available. */
  stdoutSpillPath?: string
  /** Full stderr spill file when the executor made one available. */
  stderrSpillPath?: string
  /** Settled sandbox facts, when a confining executor handled the command. */
  sandbox?: ShellSandboxInfo
}

/** A point-in-time preview used by the attached terminal component. */
export interface UserShellOutputSnapshot {
  /** Bounded tail of combined output observed so far. */
  output: string
  /** Whether earlier output is absent from {@link output}. */
  outputTruncated: boolean
  /** Full stdout spill file when available. */
  stdoutSpillPath?: string
  /** Full stderr spill file when available. */
  stderrSpillPath?: string
}

/** Construction options for one consuming shell-process reader. */
export interface UserShellProcessControllerOptions {
  /** Maximum UTF-8 bytes retained for the full completion and each job read. */
  maxOutputBytes: number
  /** Milliseconds between incremental process reads. */
  refreshMs: number
  /** Called after a foreground-visible read changes the full preview. */
  onOutput(snapshot: UserShellOutputSnapshot): void
}

/** Command and working directory recovered from one durable direct-shell notice. */
export interface UserShellResultIdentity {
  /** Exact command originally executed, without the leading bang. */
  command: string
  /** Working directory recorded beside the command. */
  workdir: string
}

/**
 * Recognize a direct-shell submission.
 *
 * A bang must be the first character, matching slash-command routing. The
 * returned empty string represents a bare `!`, so the caller can show usage
 * instead of accidentally sending it as a model prompt.
 *
 * @param input - Editor text after pi-tui's line normalization.
 * @returns The trimmed command, or `undefined` when this is ordinary input.
 */
export function parseUserShellInput(input: string): string | undefined {
  return input.startsWith('!') ? input.slice(1).trim() : undefined
}

/**
 * Recover the stable identity fields from a TUI-produced direct-shell notice.
 *
 * History discovery accepts only the plugin provenance and exact frame emitted
 * by {@link createUserShellResultMessage}; ordinary user text that happens to
 * contain similar XML is never treated as executable-command history.
 *
 * @param message - Candidate durable user message from a session log.
 * @returns the exact command/workdir pair, or `undefined` for any other message.
 */
export function parseUserShellResultMessage(message: UserMessage): UserShellResultIdentity | undefined {
  const source = message.source
  if (source.kind !== 'plugin' || source.plugin !== USER_SHELL_PLUGIN || source.form !== 'notice') {
    return undefined
  }
  if (message.content.length !== 1 || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  const opening = `<${USER_SHELL_FRAME}>\n$ `
  const closing = `\n</${USER_SHELL_FRAME}>`
  if (!text.startsWith(opening) || !text.endsWith(closing)) return undefined
  const body = text.slice(opening.length, -closing.length)
  const outputMarker = '\n\noutput:\n'
  const outputIndex = body.indexOf(outputMarker)
  if (outputIndex < 0) return undefined
  const header = body.slice(0, outputIndex)
  const cwdMarker = '\ncwd: '
  const cwdIndex = header.lastIndexOf(cwdMarker)
  if (cwdIndex < 0) return undefined
  const command = header.slice(0, cwdIndex)
  const workdir = header.slice(cwdIndex + cwdMarker.length)
  if (command === '' || workdir === '' || /[\r\n]/u.test(workdir)) return undefined
  return { command, workdir }
}

/** Stable labels for available whole-stream spill files. */
function spillLocations(value: {
  stdoutSpillPath?: string
  stderrSpillPath?: string
}): string {
  const paths = [
    value.stdoutSpillPath === undefined ? undefined : `stdout: ${value.stdoutSpillPath}`,
    value.stderrSpillPath === undefined ? undefined : `stderr: ${value.stderrSpillPath}`,
  ].filter((path): path is string => path !== undefined)
  return paths.length === 0 ? '(unavailable)' : paths.join(', ')
}

/**
 * Append one loss-recovery line without changing raw retained output otherwise.
 * @param snapshot - retained output and available spill locations.
 * @returns output plus its recovery notice when truncation occurred.
 */
export function renderUserShellOutput(snapshot: UserShellOutputSnapshot): string {
  if (!snapshot.outputTruncated) return snapshot.output
  const notice = `[earlier output omitted; full output: ${spillLocations(snapshot)}]`
  if (snapshot.output === '') return notice
  return `${snapshot.output}${snapshot.output.endsWith('\n') ? '' : '\n'}${notice}`
}

/** Human/model-readable terminal status for a settled streaming process. */
function resultStatus(result: UserShellProcessResult): string {
  const facts: string[] = []
  if (result.sandbox?.runnerFailed === true) {
    facts.push(`sandbox runner failed (${result.sandbox.mode})`)
  } else if (result.sandbox?.denied === true) {
    facts.push(`sandbox denied (${result.sandbox.mode})`)
  }
  if (result.status === 'killed') {
    facts.push(result.signal === null ? 'killed before exit' : `killed by signal ${result.signal}`)
  } else {
    facts.push(`exit code ${String(result.exitCode)}`)
  }
  return facts.join('; ')
}

/**
 * Render one completed direct-shell command for model context and replay.
 *
 * The output is user-role context, not a forged tool result: there is no model
 * tool call id to correlate. The explicit frame tells the model what happened,
 * and also lets the terminal context card hide redundant outer markup.
 *
 * @param command - Exact command executed after the leading bang.
 * @param workdir - Effective working directory requested by the TUI.
 * @param result - Settled process and bounded combined output.
 * @returns Stable model-facing text retained in the session log.
 */
export function renderUserShellResult(
  command: string,
  workdir: string,
  result: UserShellProcessResult,
): string {
  const output = renderUserShellOutput(result)
  return [
    `<${USER_SHELL_FRAME}>`,
    `$ ${command}`,
    `cwd: ${workdir}`,
    '',
    'output:',
    output === '' ? '(no output)' : output,
    '',
    `status: ${resultStatus(result)}`,
    `</${USER_SHELL_FRAME}>`,
  ].join('\n')
}

/**
 * Create the durable user-role notice that wakes the model after a direct
 * shell command completes.
 *
 * `source.kind = plugin` keeps captured output out of human prompt recall,
 * while `form = notice` records a bounded collapsed-row account for every UI.
 *
 * @param command - Exact command executed after the leading bang.
 * @param workdir - Effective command working directory.
 * @param result - Settled process and retained output.
 * @returns Frozen, identified user-role message for follow-up or steering.
 */
export function createUserShellResultMessage(
  command: string,
  workdir: string,
  result: UserShellProcessResult,
): UserMessage {
  const oneLineCommand = command.replace(/\s+/gu, ' ').trim()
  return createUserMessage({
    content: [{ type: 'text', text: renderUserShellResult(command, workdir, result) }],
    source: {
      kind: 'plugin',
      plugin: USER_SHELL_PLUGIN,
      form: 'notice',
      summary: boundContextSummary(`$ ${oneLineCommand} · ${resultStatus(result)}`),
    },
  })
}

/**
 * Map a direct-shell completion onto the generic background-job outcome.
 * Nonzero command exits are completed results, matching the shell tools.
 *
 * @param result - Settled direct-shell process.
 * @returns Generic job status and detail.
 */
export function userShellJobOutcome(
  result: UserShellProcessResult,
): { status: 'completed' | 'killed'; detail: string } {
  if (result.status === 'killed') {
    return {
      status: 'killed',
      detail: result.signal === null ? 'killed before exit' : `signal: ${result.signal}`,
    }
  }
  return { status: 'completed', detail: `exit code: ${String(result.exitCode ?? 0)}` }
}

/** Read result plus retainer-owned omission state. */
function readSnapshot(
  retainer: TextRetainer,
  lossy: boolean,
  stdoutSpillPath: string | undefined,
  stderrSpillPath: string | undefined,
): UserShellOutputSnapshot {
  const retained = retainer.finish()
  return {
    output: retained.text,
    outputTruncated: lossy || retained.truncated,
    ...stdoutSpillPath === undefined ? {} : { stdoutSpillPath },
    ...stderrSpillPath === undefined ? {} : { stderrSpillPath },
  }
}

/**
 * One bounded fan-out over `ShellProcess.readOutput()`'s consuming cursor.
 *
 * The full retainer feeds the live terminal and final durable message. A
 * resettable second retainer feeds `job_output` after Ctrl+B. Therefore a job
 * read cannot steal bytes from the direct-shell completion, and neither path
 * accumulates an unbounded command log in the TUI process.
 */
export class UserShellProcessController {
  private readonly fullOutput: TextRetainer
  private pendingJobOutput: TextRetainer
  private fullLossy = false
  private pendingJobLossy = false
  private stdoutSpillPath: string | undefined
  private stderrSpillPath: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  /** Settled result after the final process read. */
  readonly done: Promise<UserShellProcessResult>

  /**
   * @param process - Live shell process with the single consuming output cursor.
   * @param options - Retention budget, refresh cadence, and live update hook.
   */
  constructor(
    private readonly process: ShellProcess,
    private readonly options: UserShellProcessControllerOptions,
  ) {
    this.fullOutput = this.newRetainer()
    this.pendingJobOutput = this.newRetainer()
    this.drain()
    this.timer = setInterval(() => { this.drain() }, options.refreshMs)
    this.done = process.done.then(() => {
      this.stopPolling()
      this.drain()
      if (process.status === 'running') {
        throw new Error('direct shell process done settled while its status remained running')
      }
      const output = this.snapshot()
      return {
        status: process.status,
        exitCode: process.exitCode,
        signal: process.signal,
        ...output,
        ...process.sandbox === undefined ? {} : { sandbox: process.sandbox },
      }
    })
  }

  /** Create one tail retainer with this execution's configured byte cap. */
  private newRetainer(): TextRetainer {
    return new TextRetainer({ kind: 'tail', maxBytes: this.options.maxOutputBytes })
  }

  /** Fold one process read into both independent retained views. */
  private push(read: ShellProcessRead): void {
    if (read.delta !== '') {
      this.fullOutput.push(read.delta)
      this.pendingJobOutput.push(read.delta)
    }
    this.fullLossy = this.fullLossy || read.lossy
    this.pendingJobLossy = this.pendingJobLossy || read.lossy
    this.stdoutSpillPath = read.stdoutSpillPath ?? this.stdoutSpillPath
    this.stderrSpillPath = read.stderrSpillPath ?? this.stderrSpillPath
  }

  /** Consume currently available process output and publish a live snapshot. */
  private drain(): void {
    const read = this.process.readOutput()
    if (read.delta === '' && !read.lossy
      && read.stdoutSpillPath === undefined && read.stderrSpillPath === undefined) return
    this.push(read)
    this.options.onOutput(this.snapshot())
  }

  /**
   * Stop periodic reads. The final read still runs when {@link done} settles.
   * Safe to call repeatedly during channel teardown.
   */
  stopPolling(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Read the current bounded full-output preview without consuming it.
   *
   * @returns The latest combined-output snapshot and spill metadata.
   */
  snapshot(): UserShellOutputSnapshot {
    return readSnapshot(
      this.fullOutput,
      this.fullLossy,
      this.stdoutSpillPath,
      this.stderrSpillPath,
    )
  }

  /**
   * Consume the independent job-output cursor accumulated since its prior read.
   * The shell-process cursor remains owned exclusively by this controller.
   *
   * @returns Raw output delta plus a recovery notice when bytes were omitted.
   */
  readJobOutput(): string {
    this.drain()
    const snapshot = readSnapshot(
      this.pendingJobOutput,
      this.pendingJobLossy,
      this.stdoutSpillPath,
      this.stderrSpillPath,
    )
    this.pendingJobOutput = this.newRetainer()
    this.pendingJobLossy = false
    return renderUserShellOutput(snapshot)
  }
}
