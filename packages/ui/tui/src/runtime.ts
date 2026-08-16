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
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiUserSettings } from './config.ts'

/**
 * User-facing prompt/tool routing profile. `suite` selects the built-in
 * Router Standard compatibility port; `suite-spec` selects Router Spec.
 * The preset ids are owned by `@deepseek-ai/dsh-tools/bootstrap`.
 */
export type ToolRoutingProfile = 'anchored' | 'suite' | 'suite-spec'

/** Session `agentPreset` marker selected by each routing profile. */
export const ROUTING_PROFILE_PRESETS = {
  suite: 'routing-suite',
  'suite-spec': 'routing-suite-spec',
} as const

/** Opaque durable identifier for one user-created TUI checkpoint. */
export type WorkspaceCheckpointId = Branded<'WorkspaceCheckpointId'>

/**
 * Brand a validated checkpoint identifier at the TUI host boundary.
 * @param value - Validated durable checkpoint text.
 * @returns Opaque checkpoint identity suitable for workspace-history calls.
 */
export const WorkspaceCheckpointId = (value: string): WorkspaceCheckpointId =>
  value as WorkspaceCheckpointId

/** One durable checkpoint's conversation cut and workspace capture availability. */
export interface WorkspaceCheckpoint {
  /** Stable checkpoint id usable in `/rewind <id>`. */
  readonly id: WorkspaceCheckpointId
  /** Session that owns this checkpoint. */
  readonly sessionId: SessionId
  /** Inclusive event sequence used when a rewind forks the conversation. */
  readonly sessionBoundary: number
  /** User-facing creation time in epoch milliseconds. */
  readonly createdAt: number
  /** Optional human label supplied through `/checkpoint [label]`. */
  readonly label?: string
  /** Whether this checkpoint also captured the current Git worktree. */
  readonly workspace: {
    readonly kind: 'git' | 'unavailable'
    /** Human-readable reason when a non-Git workspace has no file snapshot. */
    readonly reason?: string
    /** Tracked files represented by the Git patches, when available. */
    readonly trackedFiles?: number
    /** Nonignored untracked files copied into the checkpoint, when available. */
    readonly untrackedFiles?: number
  }
}

/** Exact readable Git change view rendered by `/diff`. */
export interface WorkspaceDiff {
  /** Short title displayed by the pager. */
  readonly title: string
  /** Sanitized-source diff lines; the TUI owns terminal escaping and colors. */
  readonly lines: readonly string[]
  /** Number of distinct changed paths represented by the view. */
  readonly changedFiles: number
}

/** Input for capturing one manual workspace/conversation checkpoint. */
export interface WorkspaceCheckpointRequest {
  /** Session working directory whose Git scope is captured. */
  readonly cwd: string
  /** Durable session identity that owns the checkpoint. */
  readonly sessionId: SessionId
  /** Stable inclusive session event boundary selected by the TUI. */
  readonly sessionBoundary: number
  /** Optional human label. */
  readonly label?: string
  /** Cancels filesystem and Git work before a checkpoint publishes. */
  readonly signal: AbortSignal
}

/** Input for listing checkpoints belonging to one active session. */
export interface WorkspaceCheckpointListRequest {
  /** Active session whose own checkpoints are listed. */
  readonly sessionId: SessionId
  /** Cancels the durable checkpoint scan. */
  readonly signal: AbortSignal
}

/** Input for inspecting current uncommitted Git changes. */
export interface WorkspaceDiffRequest {
  /** Session working directory whose Git scope is inspected. */
  readonly cwd: string
  /** Cancels the Git reads. */
  readonly signal: AbortSignal
}

/** Input for restoring one Git-backed checkpoint. */
export interface WorkspaceRestoreRequest {
  /** Selected durable checkpoint; the provider revalidates its ownership. */
  readonly checkpoint: WorkspaceCheckpoint
  /** Session workspace, required to match the checkpoint's captured scope. */
  readonly cwd: string
  /** Active session used to create an automatic pre-rewind safety checkpoint. */
  readonly sessionId: SessionId
  /** Stable active-session boundary saved into the pre-rewind checkpoint. */
  readonly sessionBoundary: number
  /** Cancels before any destructive operation begins. */
  readonly signal: AbortSignal
}

/** Outcome of one restored workspace checkpoint. */
export interface WorkspaceRestoreResult {
  /** Automatic safety checkpoint containing the pre-rewind workspace. */
  readonly backup: WorkspaceCheckpoint
}

/** Host-owned durable workspace history used by `/diff`, `/checkpoint`, and `/rewind`. */
export interface WorkspaceHistory {
  /** Capture the active session boundary and, when possible, its Git worktree. */
  createCheckpoint(request: WorkspaceCheckpointRequest): Promise<WorkspaceCheckpoint>
  /** List this active session's checkpoints newest first. */
  listCheckpoints(request: WorkspaceCheckpointListRequest): Promise<readonly WorkspaceCheckpoint[]>
  /** Read the current Git worktree diff without changing it. */
  diff(request: WorkspaceDiffRequest): Promise<WorkspaceDiff>
  /** Restore a selected Git-backed checkpoint after the TUI's confirmation. */
  restoreCheckpoint(request: WorkspaceRestoreRequest): Promise<WorkspaceRestoreResult>
}

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

/** Bounded, cancellable request to read plain text from the host clipboard. */
export interface ClipboardTextReadRequest {
  /** Cancels clipboard helpers and any child process they own. */
  readonly signal: AbortSignal
  /** Maximum UTF-8 bytes the reader may return. */
  readonly maxBytes: number
  /** Session working directory, available to custom host integrations. */
  readonly cwd: string
}

/** Cancellable request to write exact human-selected conversation or assistant text to one host file. */
export interface TextFileWriteRequest {
  /** User-entered path; relative paths resolve against `cwd`. */
  readonly path: string
  /** Exact readable conversation, visible response, or fenced-code text to write as UTF-8. */
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
  /** Read plain text from the desktop clipboard for a write-only secret field. */
  readClipboardText?: (request: ClipboardTextReadRequest) => Promise<string | undefined>
  /** Write exact text to the desktop clipboard after an explicit `/copy`. */
  writeClipboardText?: (request: ClipboardTextRequest) => Promise<void>
  /** Write exact text after an explicit `/copy` picker `w` action. */
  writeTextFile?: (request: TextFileWriteRequest) => Promise<TextFileWriteResult>
  /**
   * Durable local Git snapshot provider behind `/diff`, `/checkpoint`, and
   * `/rewind`. Its absence leaves ordinary chat usable and reports that the
   * workspace controls are unavailable.
   */
  workspaceHistory?: WorkspaceHistory
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
  /** One host-authored notice shown after this channel mounts, never persisted into model context. */
  initialNotice?: string
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
  swapFresh?: (
    selection: ModelSelection | undefined,
    cwd?: string,
    routingProfile?: ToolRoutingProfile,
  ) => Promise<void>
  /**
   * Replace this channel with a fresh child session seeded through one stable
   * inclusive event boundary of the current session. The old session remains
   * durable and resumable; callers use this for conversation rewind/branching.
   */
  swapFork?: (
    boundary: number,
    selection: ModelSelection | undefined,
    initialNotice?: string,
  ) => Promise<void>
  /**
   * Line the host wants printed once the terminal is released on exit, such as
   * the command that resumes this session. Absent prints nothing. The host owns
   * the wording; the TUI owns rendering and escapes terminal controls, so
   * embedded ANSI is shown literally rather than applied.
   */
  goodbyeMessage?: string
}
