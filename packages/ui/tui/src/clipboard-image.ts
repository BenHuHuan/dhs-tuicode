/**
 * Desktop-clipboard image boundary for the TUI. Platform helpers emit raw PNG
 * bytes on stdout; callers retain them only in the unsent draft and commit
 * through the attachment store at message admission.
 * @module @deepseek-ai/dsh-tui/clipboard-image
 */

import { spawn } from 'node:child_process'
import type { ClipboardImage, ClipboardImageRequest } from './runtime.ts'

const STDERR_LIMIT = 8_192
const NO_IMAGE_EXIT = 3

const WINDOWS_CLIPBOARD_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$output = [Console]::OpenStandardOutput()',
  '$dataObject = [System.Windows.Forms.Clipboard]::GetDataObject()',
  `if ($null -eq $dataObject) { exit ${NO_IMAGE_EXIT} }`,
  // Chromium and Electron applications commonly publish lossless PNG bytes
  // without a CF_BITMAP entry. Clipboard.GetImage() cannot see that format.
  '$png = $dataObject.GetData("PNG", $false)',
  'if ($png -is [System.IO.Stream]) {',
  '  if ($png.CanSeek) { $png.Position = 0 }',
  '  $png.CopyTo($output)',
  '  exit 0',
  '}',
  'if ($png -is [byte[]]) {',
  '  $output.Write($png, 0, $png.Length)',
  '  exit 0',
  '}',
  // Screenshots and paint programs usually expose a System.Drawing image.
  '$image = [System.Windows.Forms.Clipboard]::GetImage()',
  // Explorer exposes copied image files as CF_HDROP rather than bitmap data.
  'if ($null -eq $image -and [System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
  '  foreach ($file in [System.Windows.Forms.Clipboard]::GetFileDropList()) {',
  '    try { $image = [System.Drawing.Image]::FromFile($file); break } catch { }',
  '  }',
  '}',
  `if ($null -eq $image) { exit ${NO_IMAGE_EXIT} }`,
  '$stream = [System.IO.MemoryStream]::new()',
  'try {',
  '  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  $bytes = $stream.ToArray()',
  '  $output.Write($bytes, 0, $bytes.Length)',
  '} finally {',
  '  $stream.Dispose()',
  '  $image.Dispose()',
  '}',
].join('; ')

/** Process-resolution overrides used by tests and custom desktop integrations. */
export interface ClipboardImageReaderOptions {
  /** Exact argv override. It must write raw PNG to stdout; exit 3 means no image. */
  readonly command?: readonly string[]
  /** Child environment; defaults to the current process environment. */
  readonly environment?: NodeJS.ProcessEnv
  /** Platform override for command-selection tests. */
  readonly platform?: NodeJS.Platform
}

/** One platform command and the exit statuses that mean "clipboard has no image". */
export interface ClipboardImageCommand {
  readonly argv: readonly string[]
  readonly noImageExitCodes: readonly number[]
}

function windowsClipboardCommand(program = 'powershell.exe'): ClipboardImageCommand {
  return {
    argv: [program, '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CLIPBOARD_SCRIPT],
    noImageExitCodes: [NO_IMAGE_EXIT],
  }
}

/**
 * Select shell-free clipboard readers in preference order.
 * @param options Command, environment, and platform overrides.
 * @returns Candidate argv entries. A custom command is always the sole candidate.
 */
export function selectClipboardImageCommands(
  options: ClipboardImageReaderOptions = {},
): ClipboardImageCommand[] {
  if (options.command !== undefined) {
    if (options.command.length === 0 || options.command[0]?.trim() === '') {
      throw new Error('clipboard image command must contain a non-empty executable')
    }
    return [{ argv: [...options.command], noImageExitCodes: [NO_IMAGE_EXIT] }]
  }
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  if (platform === 'win32') return [windowsClipboardCommand()]
  if (platform === 'linux' && (environment.WSL_DISTRO_NAME !== undefined || environment.WSL_INTEROP !== undefined)) {
    return [windowsClipboardCommand('powershell.exe')]
  }
  if (platform === 'darwin') {
    return [{ argv: ['pngpaste', '-'], noImageExitCodes: [1, NO_IMAGE_EXIT] }]
  }
  if (platform === 'linux') {
    return [
      { argv: ['wl-paste', '--no-newline', '--type', 'image/png'], noImageExitCodes: [1, NO_IMAGE_EXIT] },
      { argv: ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'], noImageExitCodes: [1, NO_IMAGE_EXIT] },
    ]
  }
  throw new Error(`clipboard image input is not supported on platform ${platform}`)
}

type CommandResult =
  | { readonly kind: 'image'; readonly data: Uint8Array }
  | { readonly kind: 'no-image' }

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('clipboard image read was cancelled')
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function childOutcome(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`
}

function readCommand(
  candidate: ClipboardImageCommand,
  request: ClipboardImageRequest,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const [program, ...args] = candidate.argv
  /* v8 ignore next -- command selection validates the first argv element. */
  if (program === undefined) return Promise.reject(new Error('clipboard image command is empty'))
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: request.cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const cleanup = (): void => {
      request.signal.removeEventListener('abort', onAbort)
    }
    const rejectOnce = (error: Error): void => {
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

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > request.maxBytes) {
        child.kill()
        rejectOnce(new Error(`clipboard image exceeds the configured ${String(request.maxBytes)}-byte limit`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || stderrBytes >= STDERR_LIMIT) return
      const retained = chunk.subarray(0, STDERR_LIMIT - stderrBytes)
      stderr.push(retained)
      stderrBytes += retained.byteLength
    })
    child.once('error', (error) => {
      rejectOnce(new Error(`clipboard image reader failed to start (${program}): ${error.message}`, { cause: error }))
    })
    child.once('close', (code, childSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (code === 0) {
        if (stdoutBytes === 0) {
          resolve({ kind: 'no-image' })
          return
        }
        resolve({ kind: 'image', data: Uint8Array.from(Buffer.concat(stdout, stdoutBytes)) })
        return
      }
      if (code !== null && candidate.noImageExitCodes.includes(code)) {
        resolve({ kind: 'no-image' })
        return
      }
      const detail = Buffer.concat(stderr, stderrBytes).toString('utf8').trim()
      reject(new Error(
        `clipboard image reader failed (${program}): ${childOutcome(code, childSignal)}${detail === '' ? '' : `: ${detail}`}`,
      ))
    })
  })
}

/**
 * Read one clipboard image through a shell-free platform helper.
 * @param request Cancellation, byte cap, and working directory.
 * @param options Optional custom argv and process overrides.
 * @returns PNG bytes, or `undefined` when a reachable helper reports no image.
 */
export async function readImageFromClipboard(
  request: ClipboardImageRequest,
  options: ClipboardImageReaderOptions = {},
): Promise<ClipboardImage | undefined> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw new Error('clipboard image maxBytes must be a positive safe integer')
  }
  if (request.signal.aborted) throw abortError(request.signal)
  const candidates = selectClipboardImageCommands(options)
  const environment = options.environment ?? process.env
  const failures: Error[] = []
  let sawNoImage = false
  for (const candidate of candidates) {
    try {
      const result = await readCommand(candidate, request, environment)
      if (result.kind === 'no-image') {
        sawNoImage = true
        continue
      }
      return { data: result.data, mediaType: 'image/png', name: 'clipboard.png' }
    } catch (error: unknown) {
      if (isAborted(request.signal)) throw abortError(request.signal)
      const failure = error instanceof Error ? error : new Error(String(error))
      if (options.command !== undefined) throw failure
      failures.push(failure)
    }
  }
  if (sawNoImage) return undefined
  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  throw new AggregateError(failures, 'no clipboard image reader could be started')
}
