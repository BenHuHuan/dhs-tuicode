/**
 * Host and process boundary the interactive TUI runs against: the in-place
 * resume swap and the {@link TuiRuntime} the shipped CLI supplies (terminal,
 * process exit, clock, and optional prompt/git overrides). These are plain
 * interfaces so tests can drive the channel with a fake terminal.
 * @module @deepseek-ai/dsh-tui/runtime
 */

import type { Terminal } from '@earendil-works/pi-tui'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiUserSettings } from './config.ts'

/** Text and optional read-only reply context handed to a foreground editor. */
export interface ExternalEditorRequest {
  /** Current prompt or custom-response draft. */
  readonly draft: string
  /** Latest committed assistant reply when `externalEditorContext` is enabled. */
  readonly previousResponse?: string
}

/** Bounded, cancellable request to read one raster image from the host clipboard. */
export interface ClipboardImageRequest {
  /** Cancels clipboard helpers and any child process they own. */
  readonly signal: AbortSignal
  /** Maximum encoded bytes the reader may return. */
  readonly maxBytes: number
  /** Session working directory, available to custom host integrations. */
  readonly cwd: string
}

/** Temporary client-owned clipboard bytes; never written directly to a session log. */
export interface ClipboardImage {
  /** Encoded PNG/JPEG/WebP/GIF bytes. */
  readonly data: Uint8Array
  /** Caller-declared type, verified later by the authoritative attachment store. */
  readonly mediaType: ImageMediaType
  /** Optional display basename. Local paths must not be supplied. */
  readonly name?: string
}

/** Cancellable request to write exact assistant text to the host clipboard. */
export interface ClipboardTextRequest {
  /** Exact visible response or fenced-code text to copy. */
  readonly text: string
  /** Cancels the clipboard helper and any child process it owns. */
  readonly signal: AbortSignal
  /** Session working directory, available to custom host integrations. */
  readonly cwd: string
}

/** Cancellable request to write exact assistant text to one host file. */
export interface TextFileWriteRequest {
  /** User-entered path; relative paths resolve against `cwd`. */
  readonly path: string
  /** Exact visible response or fenced-code text to write as UTF-8. */
  readonly text: string
  /** Whether explicit overwrite confirmation has already been granted. */
  readonly overwrite: boolean
  /** Cancels the filesystem operation. */
  readonly signal: AbortSignal
  /** Session working directory used to resolve relative paths. */
  readonly cwd: string
}

/** Result of one guarded text-file write attempt. */
export type TextFileWriteResult =
  | { readonly kind: 'written'; readonly path: string }
  | { readonly kind: 'exists'; readonly path: string }

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
  /**
   * Override the prompt's logical working-directory label without changing the session directory used by tools.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped label; the TUI makes terminal controls visible.
   */
  formatCwd?: (cwd: string | undefined) => string
  /**
   * Override the Git branch shown in the prompt context line; production resolves it once at mount.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped branch name, or `undefined` outside a Git worktree.
   */
  gitBranch?: (cwd: string) => string | undefined
  /** Monotonic-enough wall clock for elapsed status rendering. Defaults to `Date.now`. */
  now?(): number
  /**
   * Open a foreground text editor and resolve with its saved contents. The TUI
   * releases raw terminal ownership before this call and restores it afterward.
   */
  editText?: (request: ExternalEditorRequest) => Promise<string>
  /**
   * Read one image from the desktop clipboard. The TUI keeps these bytes only
   * in the unsent draft and commits them through `ctx.attachments` on send.
   */
  readClipboardImage?: (request: ClipboardImageRequest) => Promise<ClipboardImage | undefined>
  /** Write exact text to the desktop clipboard after an explicit `/copy`. */
  writeClipboardText?: (request: ClipboardTextRequest) => Promise<void>
  /** Write exact text after an explicit `/copy` picker `w` action. */
  writeTextFile?: (request: TextFileWriteRequest) => Promise<TextFileWriteResult>
  /**
   * Read the latest committed user-owned TUI settings. When absent, the
   * channel uses its deployment configuration.
   * @returns Current live settings.
   */
  readSettings?(): TuiUserSettings
  /**
   * Persist a partial user-settings update and return its committed result.
   * Absence keeps `/config` readable but makes writes fail explicitly.
   * @param patch Fields the user changed.
   * @returns Authoritative settings after persistence and validation.
   */
  updateSettings?: (patch: Partial<TuiUserSettings>) => Promise<TuiUserSettings>
  /** Model target carried across a host-created fresh-session swap. */
  initialModelSelection?: ModelSelection
  /**
   * Replace this channel with an in-place resumed session: the host disposes
   * the current agent, resumes `sessionId`, and mounts a fresh channel for it
   * (the `tui-agent/ready` event re-fires). Resolves once the replacement
   * transition is committed; rejects without touching the current session
   * when the resume cannot happen, leaving this channel usable.
   */
  swapResume?: (sessionId: SessionId) => Promise<void>
  /**
   * Replace this channel with a fresh session while preserving the selected
   * model target. The host commits atomically: rejection leaves the current
   * agent and channel usable, while success remounts through `tui-agent/ready`.
   */
  swapFresh?: (selection: ModelSelection | undefined) => Promise<void>
  /**
   * Line the host wants printed once the terminal is released on exit, such as
   * the command that resumes this session. Absent prints nothing. The host owns
   * the wording; the TUI owns rendering and escapes terminal controls, so
   * embedded ANSI is shown literally rather than applied.
   */
  goodbyeMessage?: string
}
