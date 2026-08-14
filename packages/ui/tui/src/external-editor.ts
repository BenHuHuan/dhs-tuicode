/**
 * External-editor process and document boundary for the interactive TUI.
 * The channel releases its terminal before calling this module; this module
 * owns only command selection, the private temporary file, and child waiting.
 * @module @deepseek-ai/dsh-tui/external-editor
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Key, matchesKey } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { visibleAssistantResponse } from './chat/assistant-responses.ts'
import type { ExternalEditorRequest } from './runtime.ts'

const CONTEXT_START = '# <deepseek-harness-external-editor-context>'
const CONTEXT_END = '# </deepseek-harness-external-editor-context>'
const WINDOWS_EDITOR_FILE_ENV = 'DSH_TUI_EXTERNAL_EDITOR_FILE'
const LEGACY_CTRL_X_CTRL_E = '\x18\x05'

/** Testable process settings; production callers use the process defaults. */
export interface ExternalEditorOptions {
  /** Override `$VISUAL`/`$EDITOR` command selection. */
  readonly editor?: string
  /** Environment inherited by the editor. */
  readonly environment?: NodeJS.ProcessEnv
  /** Override platform selection for command-resolution tests. */
  readonly platform?: NodeJS.Platform
  /** Parent directory for the private temporary directory. */
  readonly temporaryDirectory?: string
}

/** Normalize editor-produced line endings for pi-tui's multiline editor. */
function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
}

/**
 * Split a conventional POSIX `$VISUAL`/`$EDITOR` command without invoking a
 * shell. Quotes group arguments; a backslash escapes syntax characters while
 * ordinary Windows-style backslashes remain literal.
 * @param value Editor command and its optional arguments.
 * @returns Executable and argument entries for direct process spawning.
 */
export function parseEditorCommand(value: string): string[] {
  const argv: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | undefined
  const push = (): void => {
    if (!tokenStarted) return
    argv.push(token)
    token = ''
    tokenStarted = false
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string
    if (quote === "'") {
      if (character === "'") quote = undefined
      else token += character
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined
      } else if (character === '\\') {
        const next = value[index + 1]
        if (next === '"' || next === '\\') {
          token += next
          index += 1
        } else {
          token += character
        }
      } else {
        token += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }
    if (/\s/u.test(character)) {
      push()
      continue
    }
    if (character === '\\') {
      const next = value[index + 1]
      if (next !== undefined && (/\s/u.test(next) || next === "'" || next === '"' || next === '\\')) {
        token += next
        tokenStarted = true
        index += 1
      } else {
        token += character
        tokenStarted = true
      }
      continue
    }
    token += character
    tokenStarted = true
  }
  if (quote !== undefined) throw new Error('external editor command contains an unterminated quote')
  push()
  if (argv.length === 0) throw new Error('external editor command must not be empty')
  return argv
}

/**
 * Resolve the conventional editor command with a platform fallback.
 * @param environment Environment containing optional `VISUAL` and `EDITOR` values.
 * @param platform Platform that selects the fallback executable.
 * @returns Configured command or the platform default editor.
 */
export function selectExternalEditorCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = [environment.VISUAL, environment.EDITOR]
    .find(value => value !== undefined && value.trim() !== '')
  return configured?.trim() ?? (platform === 'win32' ? 'notepad.exe' : 'vi')
}

/**
 * Build the file shown to the editor, optionally with read-only reply context.
 * @param request Draft and optional previous assistant response.
 * @returns Initial external-editor document contents.
 */
export function externalEditorDocument(request: ExternalEditorRequest): string {
  const draft = normalizeLineEndings(request.draft)
  if (request.previousResponse === undefined || request.previousResponse === '') return draft
  const response = normalizeLineEndings(request.previousResponse)
  const comments = response.split('\n').map(line => line === '' ? '#' : `# ${line}`).join('\n')
  return [
    CONTEXT_START,
    '# Previous assistant response (context only; this block is removed on save):',
    comments,
    CONTEXT_END,
    '',
    draft,
  ].join('\n')
}

/**
 * Remove only the generated leading context block from an edited document.
 * @param document Document returned by the editor.
 * @param includedContext Whether the initial document included generated context.
 * @returns Draft text to restore in the TUI editor.
 */
export function externalEditorDraft(document: string, includedContext: boolean): string {
  const normalized = normalizeLineEndings(document)
  if (!includedContext || !normalized.startsWith(`${CONTEXT_START}\n`)) return normalized
  const endMarker = `\n${CONTEXT_END}`
  const markerIndex = normalized.indexOf(endMarker, CONTEXT_START.length)
  if (markerIndex < 0) return normalized
  let draftStart = markerIndex + endMarker.length
  if (normalized.startsWith('\n\n', draftStart)) draftStart += 2
  else if (normalized.startsWith('\n', draftStart)) draftStart += 1
  return normalized.slice(draftStart)
}

/**
 * Return the latest committed assistant text for optional editor context.
 * @param events Committed session events in log order.
 * @returns Latest non-empty assistant text, if present.
 */
export function latestAssistantResponse(events: readonly SessionEvent[]): string | undefined {
  return visibleAssistantResponse(events)?.text
}

/** Wait for a foreground editor process and reject every non-success outcome. */
function waitForChild(
  child: ReturnType<typeof spawn>,
  command: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.once('error', (error) => {
      rejectOnce(new Error(`external editor failed to start (${command}): ${error.message}`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve()
        return
      }
      const outcome = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      reject(new Error(`external editor failed (${command}): ${outcome}`))
    })
  })
}

function windowsShellEditor(
  command: string,
  file: string,
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  const expression = `${command} "%${WINDOWS_EDITOR_FILE_ENV}%"`
  return spawn(expression, {
    env: { ...environment, [WINDOWS_EDITOR_FILE_ENV]: file },
    shell: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    stdio: 'inherit',
    windowsHide: false,
  })
}

function spawnFailureCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) return undefined
  return (error.cause as NodeJS.ErrnoException).code
}

async function waitForEditor(command: string, file: string, options: ExternalEditorOptions): Promise<void> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const [program, ...args] = parseEditorCommand(command)
  /* v8 ignore next -- parseEditorCommand guarantees a first argv entry. */
  if (program === undefined) throw new Error('external editor command must not be empty')
  if (platform === 'win32' && /\.(?:bat|cmd)$/iu.test(program)) {
    await waitForChild(windowsShellEditor(command, file, environment), command)
    return
  }
  try {
    await waitForChild(spawn(program, [...args, file], {
      env: environment,
      stdio: 'inherit',
      windowsHide: false,
    }), command)
  } catch (error: unknown) {
    const code = spawnFailureCode(error)
    if (platform !== 'win32' || (code !== 'EINVAL' && code !== 'ENOENT')) throw error
    await waitForChild(windowsShellEditor(command, file, environment), command)
  }
}

/**
 * Edit arbitrary TUI text in a foreground external editor. The caller must
 * release raw terminal ownership first and reacquire it after this resolves.
 * @param request Draft and optional previous assistant response.
 * @param options Process and temporary-file overrides.
 * @returns Draft contents saved by the editor after generated context removal.
 */
export async function editTextInExternalEditor(
  request: ExternalEditorRequest,
  options: ExternalEditorOptions = {},
): Promise<string> {
  const command = options.editor ?? selectExternalEditorCommand(
    options.environment ?? process.env,
    options.platform ?? process.platform,
  )
  // Validate configuration before creating a file, including on Windows where
  // cmd.exe executes the original command string to support `.cmd` editors.
  parseEditorCommand(command)
  const directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'dsh-tui-editor-'))
  const file = join(directory, 'prompt.md')
  let primaryFailure: unknown
  try {
    await writeFile(file, externalEditorDocument(request), { encoding: 'utf8', mode: 0o600 })
    await waitForEditor(command, file, options)
    const edited = await readFile(file, 'utf8')
    return externalEditorDraft(
      edited,
      request.previousResponse !== undefined && request.previousResponse !== '',
    )
  } catch (error: unknown) {
    primaryFailure = error
    throw error
  } finally {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (cleanupError: unknown) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, cleanupError],
          'external editor failed and its private temporary directory could not be removed',
        )
      }
      throw cleanupError
    }
  }
}

/** Action selected by the stateful external-editor shortcut recognizer. */
export type ExternalEditorShortcutResult = 'invoke' | 'consume' | 'pass'

/** Stateful recognizer shared by the main prompt and custom-response editor. */
export class ExternalEditorShortcut {
  private ctrlXArmed = false

  /**
   * Consume one raw terminal input chunk.
   * @param data Raw input received from the terminal.
   * @returns Whether to invoke, consume, or forward the input.
   */
  handle(data: string): ExternalEditorShortcutResult {
    if (matchesKey(data, Key.ctrl('g'))) {
      this.ctrlXArmed = false
      return 'invoke'
    }
    if (data === LEGACY_CTRL_X_CTRL_E) {
      this.ctrlXArmed = false
      return 'invoke'
    }
    if (this.ctrlXArmed) {
      this.ctrlXArmed = false
      if (matchesKey(data, Key.ctrl('e'))) return 'invoke'
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

  /** Clear any pending `Ctrl+X` chord. */
  reset(): void {
    this.ctrlXArmed = false
  }
}
