/**
 * Desktop text-clipboard writer for the TUI. Every platform candidate is an
 * exact argv invocation with UTF-8 text on stdin; no assistant text reaches a
 * command shell or command-line argument.
 * @module @deepseek-ai/dsh-tui/clipboard-text
 */

import { spawn } from 'node:child_process'
import type { ClipboardTextReadRequest, ClipboardTextRequest } from './runtime.ts'

const STDERR_LIMIT = 8_192

const WINDOWS_CLIPBOARD_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$text = [Console]::In.ReadToEnd()',
  '[System.Windows.Forms.Clipboard]::SetText($text)',
].join('; ')

const WINDOWS_CLIPBOARD_READ_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())',
].join('; ')

/** Process-resolution overrides used by tests and custom desktop integrations. */
export interface ClipboardTextWriterOptions {
  /** Exact argv override. It receives UTF-8 text on stdin. */
  readonly command?: readonly string[]
  /** Child environment; defaults to the current process environment. */
  readonly environment?: NodeJS.ProcessEnv
  /** Platform override for command-selection tests. */
  readonly platform?: NodeJS.Platform
}

/** One shell-free clipboard writer candidate. */
export interface ClipboardTextCommand {
  readonly argv: readonly string[]
}

/** One shell-free clipboard reader candidate. */
export interface ClipboardTextReaderCommand {
  readonly argv: readonly string[]
}

function windowsClipboardCommand(program = 'powershell.exe'): ClipboardTextCommand {
  return {
    argv: [program, '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CLIPBOARD_SCRIPT],
  }
}

function windowsClipboardReaderCommand(program = 'powershell.exe'): ClipboardTextReaderCommand {
  return {
    argv: [program, '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CLIPBOARD_READ_SCRIPT],
  }
}

/** Select shell-free text clipboard readers in preference order. */
export function selectClipboardTextReaderCommands(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ClipboardTextReaderCommand[] {
  if (platform === 'win32') return [windowsClipboardReaderCommand()]
  if (platform === 'linux' && (environment.WSL_DISTRO_NAME !== undefined || environment.WSL_INTEROP !== undefined)) {
    return [windowsClipboardReaderCommand('powershell.exe')]
  }
  if (platform === 'darwin') return [{ argv: ['pbpaste'] }]
  if (platform === 'linux') {
    return [
      { argv: ['wl-paste', '--no-newline', '--type', 'text/plain;charset=utf-8'] },
      { argv: ['xclip', '-selection', 'clipboard', '-out'] },
    ]
  }
  throw new Error(`clipboard text input is not supported on platform ${platform}`)
}

/**
 * Select shell-free clipboard writers in preference order.
 * @param options Command, environment, and platform overrides.
 * @returns Candidate argv entries. A custom command is always the sole candidate.
 */
export function selectClipboardTextCommands(
  options: ClipboardTextWriterOptions = {},
): ClipboardTextCommand[] {
  if (options.command !== undefined) {
    if (options.command.length === 0 || options.command[0]?.trim() === '') {
      throw new Error('clipboard text command must contain a non-empty executable')
    }
    return [{ argv: [...options.command] }]
  }
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  if (platform === 'win32') return [windowsClipboardCommand()]
  if (platform === 'linux' && (environment.WSL_DISTRO_NAME !== undefined || environment.WSL_INTEROP !== undefined)) {
    return [windowsClipboardCommand('powershell.exe')]
  }
  if (platform === 'darwin') return [{ argv: ['pbcopy'] }]
  if (platform === 'linux') {
    return [
      { argv: ['wl-copy', '--type', 'text/plain;charset=utf-8'] },
      { argv: ['xclip', '-selection', 'clipboard', '-in'] },
    ]
  }
  throw new Error(`clipboard text output is not supported on platform ${platform}`)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('clipboard text write was cancelled')
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function childOutcome(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`
}

function writeCommand(
  candidate: ClipboardTextCommand,
  request: ClipboardTextRequest,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const [program, ...args] = candidate.argv
  /* v8 ignore next -- command selection validates the first argv element. */
  if (program === undefined) return Promise.reject(new Error('clipboard text command is empty'))
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: request.cwd,
      env: environment,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let settled = false

    const cleanup = (): void => {
      request.signal.removeEventListener('abort', onAbort)
    }
    function rejectOnce(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      child.kill()
      rejectOnce(abortError(request.signal))
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) {
      onAbort()
      return
    }

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || stderrBytes >= STDERR_LIMIT) return
      const retained = chunk.subarray(0, STDERR_LIMIT - stderrBytes)
      stderr.push(retained)
      stderrBytes += retained.byteLength
    })
    child.stdin.once('error', (error) => {
      rejectOnce(new Error(`clipboard text writer rejected input (${program}): ${error.message}`, { cause: error }))
    })
    child.once('error', (error) => {
      rejectOnce(new Error(`clipboard text writer failed to start (${program}): ${error.message}`, { cause: error }))
    })
    child.once('close', (code, childSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (code === 0) {
        resolve()
        return
      }
      const detail = Buffer.concat(stderr, stderrBytes).toString('utf8').trim()
      reject(new Error(
        `clipboard text writer failed (${program}): ${childOutcome(code, childSignal)}${detail === '' ? '' : `: ${detail}`}`,
      ))
    })
    child.stdin.end(request.text, 'utf8')
  })
}

/**
 * Write exact text to the desktop clipboard through a shell-free platform helper.
 * @param request Text, cancellation, and working directory.
 * @param options Optional custom argv and process overrides.
 */
export async function writeTextToClipboard(
  request: ClipboardTextRequest,
  options: ClipboardTextWriterOptions = {},
): Promise<void> {
  if (request.text === '') throw new Error('clipboard text must not be empty')
  if (request.signal.aborted) throw abortError(request.signal)
  const candidates = selectClipboardTextCommands(options)
  const environment = options.environment ?? process.env
  const failures: Error[] = []
  for (const candidate of candidates) {
    try {
      await writeCommand(candidate, request, environment)
      return
    } catch (error: unknown) {
      if (isAborted(request.signal)) throw abortError(request.signal)
      const failure = error instanceof Error ? error : new Error(String(error))
      if (options.command !== undefined) throw failure
      failures.push(failure)
    }
  }
  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  throw new AggregateError(failures, 'no clipboard text writer could be started')
}

function readTextCommand(
  candidate: ClipboardTextReaderCommand,
  request: ClipboardTextReadRequest,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const [program, ...args] = candidate.argv
  /* v8 ignore next -- command selection always supplies a program. */
  if (program === undefined) return Promise.reject(new Error('clipboard text reader is empty'))
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: request.cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    function cleanup(): void { request.signal.removeEventListener('abort', onAbort) }
    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
    const onAbort = (): void => {
      child.kill()
      rejectOnce(abortError(request.signal))
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) {
      onAbort()
      return
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.byteLength
      if (bytes > request.maxBytes) {
        child.kill()
        rejectOnce(new Error(`clipboard text exceeds the configured ${String(request.maxBytes)}-byte limit`))
        return
      }
      chunks.push(chunk)
    })
    child.once('error', (error) => { rejectOnce(new Error(`clipboard text reader failed to start (${program}): ${error.message}`, { cause: error })) })
    child.once('close', (code, childSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) {
        reject(new Error(`clipboard text reader failed (${program}): ${childOutcome(code, childSignal)}`))
        return
      }
      const value = Buffer.concat(chunks, bytes).toString('utf8')
      resolve(value === '' ? undefined : value)
    })
  })
}

/** Read bounded plain text from the desktop clipboard without a command shell. */
export async function readTextFromClipboard(request: ClipboardTextReadRequest): Promise<string | undefined> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw new Error('clipboard text maxBytes must be a positive safe integer')
  }
  if (request.signal.aborted) throw abortError(request.signal)
  const failures: Error[] = []
  for (const candidate of selectClipboardTextReaderCommands()) {
    try {
      return await readTextCommand(candidate, request, process.env)
    } catch (error: unknown) {
      if (isAborted(request.signal)) throw abortError(request.signal)
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  throw new AggregateError(failures, 'no clipboard text reader could be started')
}
