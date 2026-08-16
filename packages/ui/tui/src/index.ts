/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one configured agent, and provides
 * keyboard-driven user-interaction dialogs without owning agent lifecycle.
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Key,
  Spacer,
  Text,
  TUI,
  ProcessTerminal,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type SlashCommand,
  type TerminalColorScheme,
} from '@earendil-works/pi-tui'
import { Service, type Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
  type AgentStatus,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
// Declaration-merges the optional durable attachment store onto Context. Text
// chat remains usable without it; clipboard image intake then degrades visibly.
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandId, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Declaration-merges the optional background-job registry onto Context. The
// TUI remains usable without it; only Ctrl+B promotion and /tasks are absent.
import type {} from '@deepseek-ai/dsh-jobs'
import { CallId, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
// Declaration-merges the optional redacted MCP connection directory onto
// Context. The TUI remains usable without it; only `/mcp` is unavailable.
import type {} from '@deepseek-ai/dsh-mcp-client/registry'
import type { McpConnectionSnapshot } from '@deepseek-ai/dsh-mcp-client/registry'
// Declaration-merge the two optional mode services onto Context. A minimal
// embedding may omit either one; the mode controller degrades independently.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { ShellExecutor, ShellProcess } from '@deepseek-ai/dsh-shell'
// Type imports declaration-merge optional direct-shell services onto Context.
// The shipped TUI profile mounts all three; embedders without them retain a
// functional chat surface and receive an explicit `!`-mode availability notice.
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  isReplacementSurfaceEvent,
  SessionId,
  type SessionEvent,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import {
  parseSessionReferenceText,
} from '@deepseek-ai/dsh-session-reference'
import { foldSessionTitle, SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
// Type import also declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Declaration-merges the optional projection registry used by `/context`.
// The shipped profile mounts it; minimal embeddings retain aggregate pressure.
import type {} from '@deepseek-ai/dsh-session-projection'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
// Declaration-merges the optional continuable-subagent runtime. The shipped
// profile mounts it; minimal embeddings retain one-shot job control alone.
import type {
  SubagentDescendantListEntry,
  SubagentListEntry,
} from '@deepseek-ai/dsh-subagent'
// Type import declaration-merges the `userQuestions` service onto `Context`;
// the ask-user-question queue is registered by ./chat/questions.
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  TuiExtensionServiceImpl,
  TuiOverlayManager,
} from './extension/overlay-manager.ts'

import {
  parseTuiPromptTemplate,
  renderTuiPromptTemplate,
  type TuiPromptValueHandle,
} from './prompt.ts'
import type {
  TuiOverlayRequest,
  TuiOverlayOptions,
  TuiOverlaySession,
  TuiTheme,
} from './extension/types.ts'
import { copyableScreenText, displayInlineText, displayText } from './components/text.ts'
import {
  brandText,
  clipboardNoticeText,
  createPalette,
  modeAccentText,
  modeBadgeText,
  markdownTheme,
  renderPalette,
  selectTheme,
  type Palette,
  type ModeTone,
} from './components/theme.ts'
import { contentText, parseArguments } from './components/content.ts'
import { createInlineImageFactory } from './components/inline-image.ts'
import {
  cacheHitRate,
  formatTokens,
  recordEventUsage,
  sessionTokens,
} from './chat/tokens.ts'
import {
  fadeGlyph,
  formatQueuedStatus,
  formatStatusDuration,
  openStepPhase,
  openTurn,
  pulseLevel,
  runningPhaseGlyph,
  STATUS_ANIMATION_INTERVAL_MS,
  STATUS_FADE_MS,
  StepTimingTracker,
  TIMING_BUCKET_GLYPHS,
  type StepPosition,
} from './chat/timing.ts'
import {
  resolveTuiConfig,
  resolveTuiUserSettings,
  TuiUserSettingsSchema,
  type Config,
  type TuiUserSettings,
} from './config.ts'
import {
  ContextCardComponent,
  type ToolCardVisibility,
  EditorFrameComponent,
  HeaderComponent,
  StatusToastComponent,
  StreamingAssistantComponent,
  ToolCardComponent,
  TodoComponent,
  UserMessageComponent,
} from './components/transcript.ts'
import {
  compactTargetLabel,
  DetailsDialog,
  diagnosticMeter,
  formatDiagnosticCount,
  formatDiagnosticNumber,
  formatDiagnosticTime,
  initialTarget,
  StatusCardComponent,
  PromptContextComponent,
  SettingsDialog,
  ShortcutHelpDialog,
  targetLabel,
  type DetailsSelection,
  type StatusCardRow,
} from './components/dialogs.ts'
import {
  CopyResponseDialog,
  CopyResponseOverwriteDialog,
  CopyResponsePathDialog,
  type CopyResponseAction,
  type CopyResponseSelection,
} from './components/copy-response.ts'
import {
  ConversationExportDialog,
  type ConversationExportAction,
} from './components/export-conversation.ts'
import { CredentialLoginDialog } from './components/credential-login.ts'
import {
  WorkspaceCheckpointPickerDialog,
  WorkspaceDiffDialog,
  WorkspaceRewindActionDialog,
  WorkspaceRewindConfirmDialog,
  type WorkspaceRewindAction,
  type WorkspaceRewindCapabilities,
} from './components/workspace-history.ts'
import {
  HistorySearchDialog,
  type HistorySearchAcceptance,
} from './components/history-search.ts'
import {
  parseSkillCommand,
  renderSkillInvocation,
  SKILL_COMMAND_PREFIX,
} from './chat/skill-invocation.ts'
import {
  createUserShellResultMessage,
  parseUserShellInput,
  renderUserShellOutput,
  USER_SHELL_PLUGIN,
  UserShellProcessController,
  userShellJobOutcome,
  type UserShellOutputSnapshot,
} from './chat/shell-mode.ts'
import { ReferenceAutocompleteProvider } from './chat/autocomplete.ts'
import {
  BANNER_REVEAL_INTERVAL_MS,
  BANNER_REVEAL_STEPS,
  formatCwd,
  gitBranch,
  HintEditor,
  isCompactCheckpoint,
  sessionReferenceCard,
  transcriptToolCallIds,
} from './chat/helpers.ts'
import { createApprovalQueue } from './approval.ts'
import * as firstRunWelcome from './first-run-welcome/tui-first-run-welcome.ts'
import {
  createModelController,
  type ModelController,
} from './chat/model-command.ts'
import { createQuestionQueue } from './chat/questions.ts'
import { createResumeController } from './chat/resume.ts'
import { editTextInExternalEditor, ExternalEditorShortcut, latestAssistantResponse } from './external-editor.ts'
import type {
  TextFileWriteResult,
  TuiRuntime,
  ToolRoutingProfile,
  WorkspaceCheckpoint,
  WorkspaceDiff,
} from './runtime.ts'
import { ROUTING_PROFILE_PRESETS } from './runtime.ts'
import { WorkspaceFileSearch } from './chat/file-autocomplete.ts'
import { UserShellHistory } from './chat/shell-autocomplete.ts'
import { PromptHistory, type PromptHistoryEntry } from './chat/prompt-history.ts'
import { TuiModeController } from './chat/mode-cycle.ts'
import { ClipboardImageDraft } from './chat/clipboard-images.ts'
import {
  assistantCodeBlocks,
  visibleAssistantResponses,
} from './chat/assistant-responses.ts'
import {
  defaultConversationExportFilename,
  exportConversationText,
} from './chat/export.ts'
import { contextUsageGroups } from './chat/context-usage.ts'
import {
  stopRunningBackgroundSubagents,
  SubagentKillShortcut,
} from './chat/subagent-control.ts'
import { readImageFromClipboard } from './clipboard-image.ts'
import { readTextFromClipboard, writeTextToClipboard } from './clipboard-text.ts'
import { writeTextFile as writeResponseTextFile } from './text-file.ts'
import { LocalWorkspaceHistory } from './workspace-history.ts'

const IDLE_EXIT_CONFIRMATION_MS = 800
const CLEAR_CONVERSATION_CONFIRMATION_MS = 2_000
const SUBAGENT_KILL_CONFIRMATION_MS = 3_000
const CLIPBOARD_IMAGE_TIMEOUT_MS = 5_000
const CLIPBOARD_TEXT_TIMEOUT_MS = 5_000
const MAX_MCP_DISPLAY_TOOLS = 20
type SubagentChildEntry = Extract<SubagentListEntry, { kind: 'child' }>
type IdleExitKey = 'ctrl-c' | 'ctrl-d'

/**
 * Find the inclusive event boundary through which a session may be forked.
 * A checkpoint never branches an active turn because that would leave the
 * child with an unmatched request/tool lifecycle.
 * @param events - Complete current session log.
 * @returns The latest stable event sequence, or `undefined` before/inside a turn.
 */
function stableForkBoundary(events: readonly SessionEvent[]): number | undefined {
  const last = events.at(-1)
  if (last === undefined) return undefined
  const turnBoundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return turnBoundary?.type === 'turn/start' ? undefined : last.seq
}

interface EditorRuntimeState {
  lines: string[]
  cursorLine: number
  cursorCol: number
}

interface EditorUndoStack {
  push(state: EditorRuntimeState): void
  pop(): EditorRuntimeState | undefined
  clear(): void
}

interface EditorDraftInternals {
  state: EditorRuntimeState
  pastes: Map<number, string>
  pasteCounter: number
  undoStack: EditorUndoStack
}

interface StashedEditorDraft {
  text: string
  cursor: { line: number; col: number }
  pastes: Map<number, string>
  pasteCounter: number
  undoStack: EditorUndoStack
}

// pi-tui exposes text and cursor state but not the paste registry that expands
// large-paste markers on submission. This adapter is pinned to its Editor
// runtime fields so a restored marker can never become literal model input.
function editorDraftInternals(editor: HintEditor): EditorDraftInternals {
  return editor as unknown as EditorDraftInternals
}

function freshUndoStack(source: EditorUndoStack): EditorUndoStack {
  return Reflect.construct(source.constructor, []) as EditorUndoStack
}

function captureEditorDraft(editor: HintEditor): StashedEditorDraft {
  const internals = editorDraftInternals(editor)
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    pastes: new Map(internals.pastes),
    pasteCounter: internals.pasteCounter,
    undoStack: internals.undoStack,
  }
}

function clearEditorForStash(editor: HintEditor): void {
  const internals = editorDraftInternals(editor)
  internals.undoStack = freshUndoStack(internals.undoStack)
  editor.setText('')
  internals.undoStack.clear()
}

function restoreEditorDraft(editor: HintEditor, draft: StashedEditorDraft): void {
  const internals = editorDraftInternals(editor)
  internals.undoStack = freshUndoStack(internals.undoStack)
  editor.setText(draft.text)
  internals.pastes.clear()
  for (const [id, content] of draft.pastes) internals.pastes.set(id, content)
  internals.pasteCounter = draft.pasteCounter
  internals.state.cursorLine = draft.cursor.line
  internals.state.cursorCol = draft.cursor.col
  internals.undoStack = draft.undoStack
  editor.invalidate()
}

export { TuiPromptService } from './prompt.ts'
export { renderSkillInvocation } from './chat/skill-invocation.ts'
export { WorkspaceCheckpointId } from './runtime.ts'
export type {
  ClipboardImage,
  ClipboardImageRequest,
  ClipboardTextRequest,
  ExternalEditorRequest,
  TextFileWriteRequest,
  TextFileWriteResult,
  TuiRuntime,
  WorkspaceCheckpoint,
  WorkspaceCheckpointListRequest,
  WorkspaceCheckpointRequest,
  WorkspaceDiff,
  WorkspaceDiffRequest,
  WorkspaceHistory,
  WorkspaceRestoreRequest,
  WorkspaceRestoreResult,
} from './runtime.ts'
export { LocalWorkspaceHistory } from './workspace-history.ts'
export type { LocalWorkspaceHistoryOptions } from './workspace-history.ts'
export {
  resolveTuiConfig,
  resolveTuiUserSettings,
  TuiConfigSchema,
  TuiUserSettingsSchema,
  Config,
  type FirstRunWelcomeConfig,
  type ResolvedTuiConfig,
  type ResolvedTuiThemeConfig,
  type TuiConfig,
  type TuiThemeConfig,
  type TuiUserSettings,
} from './config.ts'
export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './chat/file-autocomplete.ts'

export type {
  TuiComponent,
  TuiFocusable,
  TuiOverlayAnchor,
  TuiOverlayCloseReason,
  TuiOverlayHost,
  TuiOverlayMargin,
  TuiOverlayOptions,
  TuiOverlayOutcome,
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiOverlayState,
  TuiTheme,
  TuiViewport,
} from './extension/types.ts'

/** First terminal Cordis state: FAILED, DISPOSED, and UNLOADING are unusable. */
const FIBER_FAILED = 3 as FiberState.FAILED

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Terminal-only interaction service, available only while a TUI is mounted. */
    tui: TuiExtensionService
  }
}

/**
 * Optional terminal-local interaction service provided by one mounted TUI.
 *
 * The concrete provider retains pi-tui, focus, and terminal lifecycle state.
 * Plugins receive only effect-owned overlay sessions.
 */
export abstract class TuiExtensionService extends Service {
  /** Exact agent driven by this terminal instance. */
  abstract readonly agent: Agent

  /**
   * Queue an interactive overlay owned by the calling plugin fiber.
   *
   * The TUI displays one overlay at a time in FIFO order. Disposing the caller
   * removes a queued overlay or closes an active one before plugin teardown
   * settles. This live presentation is neither logged nor replayed.
   *
   * @param request - component factory, layout constraints, and cancellation.
   * @returns the effect-owned overlay session.
   * @throws when the TUI has begun shutting down.
   */
  abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
}

export const name = 'ui-tui'
const TUI_SETTINGS_NAMESPACE = settingsNamespace(name)

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
export const inject = ['agents', 'sessions', 'commands', 'userQuestions', 'tools', 'llm', 'systemPrompt', 'tokenMeter', 'tuiPrompt']

/** Model guidance for path-only file references selected through the TUI. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

/**
 * Transcript row standing in for one compacted range. The conversation the
 * compaction replaced stays rendered above it: the marker reports where the
 * model stopped seeing that history, not that the history is gone.
 */
const COMPACTION_MARKER = '… earlier context was compacted …'

interface RunningStatus {
  turn: number | undefined
  timer: ReturnType<typeof setInterval>
  /** Render clock when the turn began; origin of the glyph fade-in. */
  startedAt: number
  /** The most recently rendered phase glyph, handed to the fade-out. */
  lastGlyph: string
}

/** A running glyph fading out after its turn ended, before the caret returns. */
interface FadingStatus {
  glyph: string
  /** Render clock when the turn ended; origin of the glyph fade-out. */
  endedAt: number
  timer: ReturnType<typeof setInterval>
}

/** One live direct-shell command attached to the terminal or transferred to jobs. */
interface UserShellOperation {
  command: string
  abort: AbortController
  process: ShellProcess
  output: UserShellProcessController
  spacer: Spacer
  view: Text
  mode: 'foreground' | 'background'
  cancelledByUser: boolean
  jobId?: string
}

/** Width/height adapter for a modal component rendered inside the base TUI flow. */
class InlineModalComponent extends Container {
  constructor(
    component: Component,
    private readonly width: number,
    private readonly maxHeight: number,
  ) {
    super()
    this.addChild(component)
  }

  override render(width: number): string[] {
    const lines = super.render(Math.max(1, Math.min(width, this.width)))
    return lines.slice(0, Math.max(1, this.maxHeight))
  }
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /**
   * Apply one committed live user-settings snapshot.
   * @param settings Authoritative settings from the provider.
   */
  updateSettings(settings: TuiUserSettings): void
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

/**
 * Start the interactive pi-tui channel for an already-created target agent.
 * @param ctx - agent, tools, session-event, and user-interaction context.
 * @param config - target agent, banner, and TUI presentation config.
 * @param runtime - terminal and process-exit boundary.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export function createTuiChat(
  ctx: Context,
  config: Config,
  runtime: TuiRuntime,
): TuiController {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`ui-tui: session "${sessionId}" is not running`)
  const resolved = resolveTuiConfig(config)
  let userSettings = runtime.readSettings?.() ?? resolveTuiUserSettings(config)
  const palette = createPalette(resolved.theme.color, 'dark', resolved.theme.palette, resolved.theme.truecolor)
  const mdTheme = markdownTheme(palette)
  const ui = new TUI(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const questionContainer = new Container()
  const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt))
  const renderInputPrompt = (): string => renderTuiPromptTemplate(inputTemplate, valueName => ctx.tuiPrompt.get(valueName))
  const initialInputPrompt = renderInputPrompt()
  const editor = new HintEditor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, {
    paddingX: 1,
    frame: 'none',
    prompt: {
      first: initialInputPrompt,
      continuation: ' '.repeat(visibleWidth(initialInputPrompt)),
    },
  })
  editor.hintPrefix = initialInputPrompt
  const todo = new TodoComponent(palette)
  let showTaskChecklist = true
  const compactionStatusLine = new Text('', 0, 0)
  const editorStatusLine = new Text('', 0, 0)
  const footerLine = new Text('', 0, 0)
  let showReasoning = userSettings.showReasoning
  // Ctrl+O cycles collapsed -> expanded -> hidden. Codex-style: hidden drops
  // tool cards entirely, collapsed previews, expanded shows full bodies.
  let toolsVisibility: ToolCardVisibility = 'collapsed'
  let streaming: StreamingAssistantComponent | undefined
  let completedStreaming: StreamingAssistantComponent | undefined
  // One shared accumulator serves every step's timing footer; per-footer
  // replay of the whole log is quadratic on a long resumed session.
  const stepTimingTracker = new StepTimingTracker()
  // Assistant step components in model order per turn, for hidden-mode folding:
  // with tool cards hidden, the first step with a visible body keeps its spacing
  // and later steps render as continuations (see applyTurnFolding).
  const assistantSteps = new Map<number, StreamingAssistantComponent[]>()
  let runningStatus: RunningStatus | undefined
  let fadingStatus: FadingStatus | undefined
  /**
   * Live standalone compaction observed by this process. Never derive this
   * state from history: a resumed log may contain a stale orphaned start.
   */
  let compacting: {
    startedAt: number
    timer: ReturnType<typeof setInterval>
  } | undefined
  // TUI steering submissions that the inbox has not yet claimed or discarded.
  // Correlation ids avoid guessing whether a running-state submission actually
  // joined steering or fell back to the queued-turn FIFO during turn close.
  const pendingSteering = new Set<MessageId>()
  let disposed = false
  let shuttingDown: Promise<void> | undefined
  // Optional: skills mount conditionally, so read the global service store
  // rather than declaring an injection that would make the TUI require them.
  const skills = ctx.get('skills')
  const cwd = agent.session.header.cwd ?? process.cwd()
  const fileSearch = new WorkspaceFileSearch(cwd, {
    maxResults: resolved.fileSearchMaxResults,
    maxEntries: resolved.fileSearchMaxEntries,
    excludedDirectories: resolved.fileSearchExcludedDirectories,
  })
  const optionalSessionQuery = (): SessionQueryEngine | undefined => {
    const implementation = ctx.reflect._getImpl('sessionQuery', false)
    if (implementation === undefined || implementation.fiber.state >= FIBER_FAILED) return undefined
    return ctx.get('sessionQuery', false)
  }
  const userShellHistory = new UserShellHistory({
    cwd,
    sessionId: agent.id,
    events: () => agent.session.events,
    sessionQuery: optionalSessionQuery,
  })
  const promptHistory = new PromptHistory({
    sessionId: agent.id,
    cwd,
    events: () => agent.session.events,
    appendInput: (text) => { agent.session.append('tui/input', { text }) },
    sessionQuery: optionalSessionQuery,
    maxEntries: resolved.historyMaxEntries,
    maxSessions: resolved.historyMaxSessions,
    readConcurrency: resolved.historyScanConcurrency,
  })
  const modeController = new TuiModeController(
    agent,
    ctx.get('permissionPresets'),
    ctx.get('planMode'),
  )
  const modeTone = (): ModeTone => {
    const mode = modeController.current()
    if (mode?.dangerous === true) return 'danger'
    if (mode?.kind === 'plan') return 'plan'
    if (mode?.id === 'permission:read-only') return 'inspect'
    if (mode?.id === 'permission:workspace-auto') return 'flow'
    if (mode?.id === 'permission:workspace-write') return 'build'
    return 'normal'
  }
  // Claude Code input rail: rounded top/bottom borders only. Plan mode paints
  // the rail warning, always-approve paints it error, and the prompt glyph dims
  // while the agent runs — the frame itself stays on the normal chrome tone.
  const editorFramePaint = (): Palette['accent'] => {
    const tone = modeTone()
    return text => modeAccentText(text, tone, resolved.theme.color)
  }
  const editorTopFrame = new EditorFrameComponent(true, palette.dim)
  const editorBottomFrame = new EditorFrameComponent(false, palette.dim)
  const skillAbort = new AbortController()
  // Slash completion is synchronous, while skill discovery is asynchronous.
  // Keep the last complete catalog here so both completion and /help expose
  // the same set of user-invocable skills.
  let skillCommands: SlashCommand[] = []
  let skillCommandScan = 0
  let skillCommandRetry: ReturnType<typeof setTimeout> | undefined
  let skillCommandRetryCount = 0
  const tokens = sessionTokens(agent.session)
  const toolCards = new Map<string, ToolCardComponent>()
  const allToolCards = new Set<ToolCardComponent>()
  const contextCards = new Set<ContextCardComponent>()
  const liveErrors = new Set<string>()
  const liveErrorTurns = new Set<number>()
  const commandControllers = new Set<AbortController>()
  const referenceControllers = new Set<AbortController>()
  const transferControllers = new Set<AbortController>()
  const clipboardImages = new ClipboardImageDraft()
  let foregroundShell: UserShellOperation | undefined
  let tuiServiceFiber: Fiber | undefined
  const target: ModelSelectionRef = {
    current: runtime.initialModelSelection ?? initialTarget(agent),
    assembled: undefined,
  }
  // `updatePromptValues` (defined below) closes over the model controller, but
  // the controller needs `appendNotice`/`overlayManager`, defined after that
  // closure. Declare here, assign once after those exist, and defer the first
  // `updatePromptValues()` call until after the assignment so no read precedes it.
  // oxlint-disable-next-line prefer-const -- single assignment is a forward-reference, not a const.
  let modelController!: ModelController
  const now = (): number => runtime.now?.() ?? Date.now()
  const agentStatus = (): AgentStatus => agent.status
  const isDisposed = (): boolean => disposed

  // A configured subtitle renders as a banner line; when absent, the banner has
  // no subtitle. The banner itself sweeps in on start (see startBannerReveal).
  let sessionTitle = foldSessionTitle(agent.session.events)?.title
  const brandImageRef: ImageAttachmentRef = {
    attachmentId: AttachmentId('tui-brand-deepseek-whale-girl-brick-v2'),
    mediaType: 'image/png',
    bytes: 1_006_186,
    width: 1_312,
    height: 1_199,
    name: 'deepseek-whale-girl-brick-v2.png',
  }
  const brandImage = createInlineImageFactory(
    async () => ({
      ref: brandImageRef,
      data: await readFile(fileURLToPath(new URL('../assets/deepseek-whale-girl-brick-v2.png', import.meta.url))),
    }),
    () => { if (!disposed) ui.requestRender() },
    palette,
    {
      maxWidthCells: 56,
      maxHeightCells: 26,
      hideFallback: true,
      preferAnsiPixels: true,
      // HeaderComponent owns centering inside the left card column. Keeping
      // the raster origin at zero avoids applying a second center offset and
      // clipping the mascot against the middle divider.
      ansiAlignment: 'left',
    },
  )({ type: 'image', attachment: brandImageRef })
  const header = new HeaderComponent(
    agent,
    () => sessionTitle
      ?? config.welcome
      ?? (agent.session.header.agentPreset === ROUTING_PROFILE_PRESETS.suite
        ? 'Router Standard · RL-interface tools'
        : agent.session.header.agentPreset === ROUTING_PROFILE_PRESETS['suite-spec']
          ? 'Router Spec · deep-think-first tools'
          : undefined),
    palette,
    resolved.theme.color && resolved.theme.truecolor,
    brandImage,
  )
  const formattedCwd = displayText(runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd))
  const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd)
  const promptValues: TuiPromptValueHandle[] = [
    ctx.tuiPrompt.register('cwd', palette.bold(palette.accent(formattedCwd))),
    ctx.tuiPrompt.register('git/worktree', branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`)),
    ctx.tuiPrompt.register('token_meter/cache_hit_rate'),
    ctx.tuiPrompt.register('model'),
    ctx.tuiPrompt.register('context'),
    ctx.tuiPrompt.register('mode'),
    ctx.tuiPrompt.register('queued'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('>'))),
    ctx.tuiPrompt.register('indicator', palette.dim(' ')),
  ]
  const [cwdValue, gitValue, tokenValue, modelValue, contextValue, modeValue, queuedValue, symbolValue, indicatorValue] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || modeValue === undefined || queuedValue === undefined
    || symbolValue === undefined || indicatorValue === undefined) {
    throw new Error('TUI prompt built-ins failed to initialize')
  }
  let runningActivityGlyph = ''
  const updatePromptValues = (): void => {
    const renderTime = now()
    cwdValue.set(palette.bold(palette.accent(formattedCwd)))
    gitValue.set(branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`))
    const rate = cacheHitRate(tokens)
    const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`
    modelValue.set(`  ${palette.dim(displayText(target.current === undefined ? 'model unset' : compactTargetLabel(target.current)))}`)
    tokenValue.set(`  ${palette.dim(rate === undefined ? usage : `${usage}  cache ${rate}%`)}`)
    const contextWindow = modelController.contextWindow()
    contextValue.set(contextWindow === undefined ? undefined : `  ${palette.dim(
      `${Math.min(100, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow * 100))}% context`,
    )}`)
    const mode = modeController.current()
    if (mode === undefined) {
      modeValue.set(undefined)
    } else {
      const icon = mode.kind === 'plan' ? '◇'
        : mode.dangerous ? '⚡'
          : mode.id === 'permission:read-only' ? '◉'
            : mode.id === 'permission:workspace-auto' ? '▶'
              : '◆'
      const suffix = mode.pending ? ' (pending)' : ''
      const text = `${icon} ${displayInlineText(mode.label)}${suffix}`
      const tone = modeTone()
      const paint: Palette['accent'] = text => modeAccentText(text, tone, resolved.theme.color)
      modeValue.set(`  ${paint(text)}`)
    }
    const queued = runningStatus === undefined ? undefined : formatQueuedStatus(pendingSteering.size)
    queuedValue.set(queued === undefined ? undefined : palette.dim(queued))
    const promptGlyph = mode?.dangerous === true ? '⚡'
      : mode?.kind === 'plan' ? '◇'
        : mode?.id === 'permission:read-only' ? '◉'
          : mode?.id === 'permission:workspace-auto' ? '▶'
            : '◆'
    const tone = modeTone()
    const promptPaint: Palette['accent'] = text => modeAccentText(text, tone, resolved.theme.color)
    symbolValue.set(palette.bold(promptPaint(promptGlyph)))
    editorTopFrame.setPaint(editorFramePaint())
    editorBottomFrame.setPaint(editorFramePaint())
    compactionStatusLine.setText(compacting === undefined
      ? ''
      : palette.dim(`Context being compacted ${formatStatusDuration(renderTime - compacting.startedAt)}`))
    // `${indicator}` owns the caret column and its trailing gap before the
    // cursor. Idle it is one blank cell after the `❯` rail; while work runs the
    // active phase glyph occupies that cell — same width every frame — fading
    // in, throbbing, and fading out before the blank returns. Only the gray
    // brightness changes, so the cursor never shifts.
    const statusGlyph = runningPhaseGlyph(
      agent.session.events,
      runningStatus !== undefined,
      compacting !== undefined,
    )
    // Remember the live phase glyph so the fade-out shows it, not the ttft
    // fallback the derivation returns once the closing turn's step has ended.
    if (runningStatus !== undefined && statusGlyph !== undefined) runningStatus.lastGlyph = statusGlyph
    const activeSince = runningStatus?.startedAt ?? compacting?.startedAt
    const envelope = activeSince !== undefined && statusGlyph !== undefined
      ? { glyph: statusGlyph, level: Math.min(1, (renderTime - activeSince) / STATUS_FADE_MS) }
      : fadingStatus !== undefined
        ? { glyph: fadingStatus.glyph, level: Math.max(0, 1 - (renderTime - fadingStatus.endedAt) / STATUS_FADE_MS) }
        : undefined
    runningActivityGlyph = envelope === undefined
      ? ''
      : fadeGlyph(
        envelope.glyph,
        palette,
        resolved.theme.color,
        resolved.theme.color && resolved.theme.truecolor,
        envelope.level * pulseLevel(renderTime),
        envelope.level >= 0.5,
      )
    // Keep the editor itself visually quiet while a turn is running. The
    // animated activity glyph and steering hint live on the status row above
    // the editor (see updateEditorHint), rather than masquerading as input.
    indicatorValue.set(palette.dim('  '))
    const modeIdentity = mode?.dangerous === true
      ? { badge: 'UNLOCKED', detail: 'full access', tone: 'danger' as const }
      : mode?.kind === 'plan'
        ? { badge: 'BLUEPRINT', detail: 'plan only', tone: 'plan' as const }
        : mode?.id === 'permission:read-only'
          ? { badge: 'INSPECT', detail: 'read only', tone: 'inspect' as const }
          : mode?.id === 'permission:workspace-write'
            ? { badge: 'BUILD', detail: 'workspace tools', tone: 'build' as const }
            : mode?.id === 'permission:workspace-auto'
              ? { badge: 'FLOW', detail: 'workspace autonomous', tone: 'flow' as const }
              : { badge: 'CHAT', detail: 'standard', tone: 'normal' as const }
    footerLine.setText(
      `${modeBadgeText(`└─ ${modeIdentity.badge}`, modeIdentity.tone, resolved.theme.color)}${palette.dim(`  ${modeIdentity.detail} · ? help · 1 agent`)}`,
    )
    updateEditorHint()
  }
  const promptContext = new PromptContextComponent(
    parseTuiPromptTemplate(displayInlineText(resolved.theme.leftPrompt)),
    parseTuiPromptTemplate(displayInlineText(resolved.theme.rightPrompt)),
    valueName => ctx.tuiPrompt.get(valueName),
  )
  const statusToast = new StatusToastComponent(
    palette,
    text => clipboardNoticeText(text, resolved.theme.color),
  )
  let statusToastTimer: ReturnType<typeof setTimeout> | undefined
  // Keep the transcript as one measured prefix. The render seam below can
  // then viewport this prefix while leaving the prompt, overlays, and footer
  // pinned to the bottom of the terminal.
  const transcript = new Container()
  let transcriptLineCount = 0
  const originalTranscriptRender = transcript.render.bind(transcript)
  transcript.render = (width: number): string[] => {
    const lines = originalTranscriptRender(width)
    transcriptLineCount = lines.length
    return lines
  }
  transcript.addChild(header)
  transcript.addChild(chat)
  ui.addChild(transcript)
  ui.addChild(new Spacer(1))
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(compactionStatusLine)
  ui.addChild(promptContext)
  ui.addChild(questionContainer)
  ui.addChild(statusToast)
  ui.addChild(editorStatusLine)
  ui.addChild(editorTopFrame)
  ui.addChild(editor)
  ui.addChild(editorBottomFrame)
  ui.addChild(footerLine)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  const requestRender = (): void => {
    if (disposed) return
    updatePromptValues()
    const inputPrompt = renderInputPrompt()
    editor.setPrompt({ first: inputPrompt, continuation: ' '.repeat(visibleWidth(inputPrompt)) })
    editor.hintPrefix = inputPrompt
    promptContext.invalidate()
    ui.requestRender()
  }
  const showCopyToast = (text: string): void => {
    if (statusToastTimer !== undefined) clearTimeout(statusToastTimer)
    const count = Array.from(text).length
    statusToast.setMessage(` copied ${String(count)} char${count === 1 ? '' : 's'} to clipboard `)
    requestRender()
    statusToastTimer = setTimeout(() => {
      statusToastTimer = undefined
      statusToast.setMessage(undefined)
      requestRender()
    }, 4_000)
  }
  const attachmentStore = ctx.get('attachments')
  const inlineImage = attachmentStore === undefined
    ? undefined
    : createInlineImageFactory(ref => attachmentStore.readImage(ref), requestRender, palette)

  const toggleTaskChecklist = (): void => {
    showTaskChecklist = !showTaskChecklist
    todoContainer.clear()
    if (showTaskChecklist) todoContainer.addChild(todo)
    requestRender()
  }

  let stashedEditorDraft: StashedEditorDraft | undefined
  let freshSwapInFlight = false
  let externalEditorInFlight = false
  let transferOperation: 'reading' | 'admitting' | 'copying' | 'writing' | undefined
  let transferSubject = 'assistant response'
  let workspaceOperation: 'diff' | 'checkpoint' | 'rewind' | undefined
  const externalEditorShortcut = new ExternalEditorShortcut()
  const subagentKillShortcut = new SubagentKillShortcut()
  let subagentKillInFlight = false
  let subagentKillAbort: AbortController | undefined
  let subagentKillConfirmation: {
    readonly armedAt: number
    readonly timer: ReturnType<typeof setTimeout>
  } | undefined
  let idleExitConfirmation: {
    readonly key: IdleExitKey
    readonly armedAt: number
    readonly timer: ReturnType<typeof setTimeout>
  } | undefined
  let clearConversationConfirmation: {
    readonly armedAt: number
    readonly timer: ReturnType<typeof setTimeout>
  } | undefined
  const idleExitHint = (key: IdleExitKey): string => palette.dim(
    `Press ${key === 'ctrl-c' ? 'Ctrl+C' : 'Ctrl+D'} again to exit`,
  )
  const updateEditorHint = (): void => {
    const runningHint = agent.status === 'running'
      ? `${runningActivityGlyph || palette.dim('✣')} ${palette.dim(displayInlineText(resolved.theme.inputPlaceholder))}`
      : fadingStatus === undefined ? '' : runningActivityGlyph
    editorStatusLine.setText(externalEditorInFlight
      ? palette.dim('Editing in external editor…')
      : transferOperation === 'reading'
        ? palette.dim('Reading clipboard image…')
        : transferOperation === 'admitting'
          ? palette.dim('Saving clipboard image…')
          : transferOperation === 'copying'
            ? palette.dim(`Copying ${transferSubject}…`)
            : transferOperation === 'writing'
              ? palette.dim(`Writing ${transferSubject}…`)
              : workspaceOperation === 'diff'
                ? palette.dim('Reading workspace diff…')
                : workspaceOperation === 'checkpoint'
                  ? palette.dim('Creating workspace checkpoint…')
                  : workspaceOperation === 'rewind'
                    ? palette.dim('Restoring workspace checkpoint…')
                    : freshSwapInFlight
                      ? palette.dim('Starting a new conversation…')
                      : subagentKillInFlight
                        ? palette.dim('Stopping background subagents…')
                        : subagentKillConfirmation !== undefined
                          ? palette.dim('Press Ctrl+X Ctrl+K again within 3s to stop all running background subagents')
                          : clearConversationConfirmation === undefined
                            ? runningHint
                            : palette.dim('Press Ctrl+L again to run /clear'))
    editor.hint = idleExitConfirmation !== undefined
      ? idleExitHint(idleExitConfirmation.key)
      : stashedEditorDraft === undefined
        ? undefined
        : palette.dim('Prompt stashed · Ctrl+S to restore')
  }
  const clearIdleExitConfirmation = (render = true): void => {
    if (idleExitConfirmation === undefined) return
    clearTimeout(idleExitConfirmation.timer)
    idleExitConfirmation = undefined
    updateEditorHint()
    if (render) requestRender()
  }
  /** Arm an empty-prompt exit key, returning true only for its timely second press. */
  const confirmIdleExit = (key: IdleExitKey): boolean => {
    if (
      idleExitConfirmation?.key === key
      && now() - idleExitConfirmation.armedAt <= IDLE_EXIT_CONFIRMATION_MS
    ) {
      clearIdleExitConfirmation(false)
      return true
    }
    clearIdleExitConfirmation(false)
    const confirmation = {
      key,
      armedAt: now(),
      timer: setTimeout(() => {
        /* v8 ignore next -- a replaced confirmation clears this timer; retain the identity guard for host timer races. */
        if (idleExitConfirmation !== confirmation) return
        idleExitConfirmation = undefined
        updateEditorHint()
        requestRender()
      }, IDLE_EXIT_CONFIRMATION_MS),
    }
    idleExitConfirmation = confirmation
    updateEditorHint()
    requestRender()
    return false
  }
  const clearConversationConfirmationState = (render = true): void => {
    if (clearConversationConfirmation === undefined) return
    clearTimeout(clearConversationConfirmation.timer)
    clearConversationConfirmation = undefined
    updateEditorHint()
    if (render) requestRender()
  }
  const clearSubagentKillConfirmation = (render = true): void => {
    if (subagentKillConfirmation === undefined) return
    clearTimeout(subagentKillConfirmation.timer)
    subagentKillConfirmation = undefined
    updateEditorHint()
    if (render) requestRender()
  }
  /** Arm full redraw's `/clear` follow-up, returning true only for a timely second Ctrl+L. */
  const confirmClearConversation = (): boolean => {
    if (
      clearConversationConfirmation !== undefined
      && now() - clearConversationConfirmation.armedAt <= CLEAR_CONVERSATION_CONFIRMATION_MS
    ) {
      clearConversationConfirmationState(false)
      return true
    }
    clearConversationConfirmationState(false)
    const confirmation = {
      armedAt: now(),
      timer: setTimeout(() => {
        /* v8 ignore next -- a newer confirmation clears this timer; retain the identity guard for host timer races. */
        if (clearConversationConfirmation !== confirmation) return
        clearConversationConfirmation = undefined
        updateEditorHint()
        requestRender()
      }, CLEAR_CONVERSATION_CONFIRMATION_MS),
    }
    clearConversationConfirmation = confirmation
    updateEditorHint()
    return false
  }
  const disposePromptHistoryChanges = promptHistory.subscribe(requestRender)
  // A prompt value that changes on its own schedule (e.g. a plugin-owned
  // `${custom}` fragment) redraws through the registry's coalesced notification;
  // built-ins are already covered by the state-change callers of requestRender.
  const disposePromptChanges = ctx.tuiPrompt.subscribe(requestRender)

  const appendNotice = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
    const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.dim
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(color(displayText(message)), 0, 0))
    requestRender()
  }

  /** Arm the documented two-chord guard, returning true only on timely confirmation. */
  const confirmSubagentKill = (): boolean => {
    if (ctx.get('jobs') === undefined && ctx.get('subagents') === undefined) {
      appendNotice('Background subagent control is unavailable because this runtime has no jobs or subagent service.', 'warning')
      return false
    }
    if (
      subagentKillConfirmation !== undefined
      && now() - subagentKillConfirmation.armedAt <= SUBAGENT_KILL_CONFIRMATION_MS
    ) {
      clearSubagentKillConfirmation(false)
      return true
    }
    clearSubagentKillConfirmation(false)
    const confirmation = {
      armedAt: now(),
      timer: setTimeout(() => {
        /* v8 ignore next -- a newer confirmation clears this timer; retain the identity guard for host timer races. */
        if (subagentKillConfirmation !== confirmation) return
        subagentKillConfirmation = undefined
        updateEditorHint()
        requestRender()
      }, SUBAGENT_KILL_CONFIRMATION_MS),
    }
    subagentKillConfirmation = confirmation
    updateEditorHint()
    requestRender()
    return false
  }

  /** Discover and stop both directly owned background-subagent lifecycles. */
  const stopBackgroundSubagents = (): void => {
    if (subagentKillInFlight) {
      appendNotice('A background subagent stop request is already running.', 'warning')
      return
    }
    // Optional services must stay behind Cordis' safe lookup. Reading
    // `ctx.jobs` / `ctx.subagents` would require declaring them as hard
    // injections even after `ctx.get()` has established their availability.
    const jobs = ctx.get('jobs')
    const subagents = ctx.get('subagents')
    const controller = new AbortController()
    subagentKillAbort = controller
    subagentKillInFlight = true
    updateEditorHint()
    requestRender()
    void stopRunningBackgroundSubagents({
      agent,
      agents: ctx.agents,
      ...jobs === undefined ? {} : { jobs },
      ...subagents === undefined ? {} : { subagents },
    }, controller.signal).then((result) => {
      if (disposed || controller.signal.aborted) return
      if (result.requested > 0) {
        appendNotice(`Stopping ${String(result.requested)} background subagent${result.requested === 1 ? '' : 's'}…`)
      } else if (result.alreadyFinished > 0 && result.failures.length === 0) {
        appendNotice('Background subagents finished before cancellation reached them.', 'warning')
      } else if (result.failures.length === 0) {
        appendNotice('No running background subagents.', 'warning')
      }
      if (result.failures.length > 0) {
        appendNotice(`Background subagent stop failed for ${result.failures.map(failure =>
          `${failure.target}: ${errorChain(failure.error)}`).join('; ')}`, 'error')
      }
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        appendNotice(`Background subagent stop failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      if (subagentKillAbort === controller) subagentKillAbort = undefined
      subagentKillInFlight = false
      if (!disposed) {
        updateEditorHint()
        requestRender()
      }
    })
  }

  /** Remove an attached direct-shell row without disturbing later transcript rows. */
  const removeUserShellView = (operation: UserShellOperation): void => {
    for (const child of [operation.spacer, operation.view]) {
      const index = chat.children.indexOf(child)
      if (index >= 0) chat.children.splice(index, 1)
    }
  }

  /** Paint the latest bounded output from a foreground direct-shell process. */
  const renderUserShellView = (
    operation: UserShellOperation,
    snapshot: UserShellOutputSnapshot,
  ): void => {
    const output = renderUserShellOutput(snapshot)
    operation.view.setText([
      palette.bold(palette.accent(`Shell · running $ ${displayInlineText(operation.command)}`)),
      output === '' ? palette.dim('(waiting for output)') : displayText(output),
      palette.dim('Ctrl+C cancel · Ctrl+B run in background'),
    ].join('\n'))
    requestRender()
  }

  /** Tear down the foreground attachment during TUI or agent disposal. */
  const disposeForegroundShell = (reason: string): void => {
    const operation = foregroundShell
    if (operation === undefined) return
    foregroundShell = undefined
    editor.disableSubmit = false
    operation.output.stopPolling()
    if (!operation.abort.signal.aborted) operation.abort.abort(new Error(reason))
    operation.process.kill()
  }

  const extensionTheme: TuiTheme = Object.freeze({
    text: (value: string) => palette.text(value),
    brand: (value: string) => resolved.theme.color
      ? resolved.theme.truecolor ? brandText(value) : palette.brand(value)
      : value,
    dim: (value: string) => palette.dim(value),
    accent: (value: string) => palette.accent(value),
    success: (value: string) => palette.success(value),
    warning: (value: string) => palette.warning(value),
    error: (value: string) => palette.error(value),
    bold: (value: string) => palette.bold(value),
  })
  const overlayManager = new TuiOverlayManager({
    viewport: () => Object.freeze({
      columns: runtime.terminal.columns,
      rows: runtime.terminal.rows,
    }),
    theme: () => extensionTheme,
    display: displayText,
    show: (component, options, placement) => {
      if (placement === 'overlay') {
        return ui.showOverlay(component, options === undefined
          ? undefined
          : {
            ...options,
            ...typeof options.margin === 'object'
              ? { margin: { ...options.margin } }
              : {},
          })
      }
      const modal = new InlineModalComponent(
        component,
        resolved.questionDialogWidth,
        resolved.questionDialogMaxHeight,
      )
      questionContainer.clear()
      questionContainer.addChild(modal)
      ui.setFocus(component)
      return {
        hide(): void {
          questionContainer.clear()
          ui.setFocus(editor)
        },
      }
    },
    invalidate: requestRender,
    reportError: (error) => {
      const message = errorChain(error)
      ctx.logger.warn(`ui-tui: overlay failed: ${message}`)
      /* v8 ignore next -- shutdown removes overlays before the terminal stops */
      if (disposed) return
      appendNotice(`TUI overlay failed: ${message}`, 'error')
    },
  })

  let historyOverlay: TuiOverlaySession | undefined
  const showHistorySearch = (): void => {
    void historyOverlay?.close()
    promptHistory.ensureLoaded()
    const session = overlayManager.open({
      create: host => new HistorySearchDialog(
        {
          list: (scope, query) => promptHistory.list(scope, query),
          state: () => promptHistory.loadState,
          failure: () => promptHistory.loadFailure === undefined
            ? undefined
            : errorChain(promptHistory.loadFailure),
        },
        resolved.maxHistoryOptions,
        runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd),
        cwdValue => runtime.formatCwd?.(cwdValue) ?? formatCwd(cwdValue),
        () => host.viewport.rows,
        palette,
        (entry: PromptHistoryEntry, acceptance: HistorySearchAcceptance) => {
          void session.close().then(() => {
            if (disposed) return
            editor.setText(entry.text)
            requestRender()
            if (acceptance === 'submit') editor.handleInput('\r')
          })
        },
        () => { void session.close() },
      ),
      options: {
        width: '100%',
        maxHeight: '100%',
        anchor: 'top-left',
        margin: 0,
      },
    })
    historyOverlay = session
    void session.closed.then(() => {
      if (historyOverlay === session) historyOverlay = undefined
    })
    requestRender()
  }

  let shortcutHelpOverlay: TuiOverlaySession | undefined
  const showShortcutHelp = (): void => {
    void shortcutHelpOverlay?.close()
    const session = overlayManager.open({
      create: () => new ShortcutHelpDialog([
        'Enter send · Shift/Alt+Enter newline · Up/Down prompt history',
        'Ctrl+V / Alt+V paste an image from the clipboard',
        'Shift+Tab / Alt+M cycle permission modes · Alt+P choose model · Alt+T toggle thinking',
        'Esc cancel active turn · Ctrl+G / Ctrl+X Ctrl+E external editor',
        'Ctrl+X Ctrl+K twice within 3s stop all running background subagents',
        'Ctrl+T toggle task checklist',
        'Ctrl+S stash/restore prompt · Ctrl+O cycle cards',
        'Ctrl+R search history · Ctrl+L redraw; press twice to /clear',
        'Ctrl+B background foreground shell · Ctrl+C cancel/clear; press twice on empty input to exit',
        'Ctrl+D delete forward while editing; press twice on empty input to exit',
        'Type ? in an empty prompt to toggle this panel',
      ], palette, () => { void session.close() }),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
        anchor: 'center',
        margin: 1,
      },
    })
    shortcutHelpOverlay = session
    void session.closed.then(() => {
      if (shortcutHelpOverlay === session) shortcutHelpOverlay = undefined
    })
    requestRender()
  }

  const disposeTargetListeners = installModelSelection(agent.ctx, target)

  modelController = createModelController({
    ctx,
    resolved,
    palette,
    overlayManager,
    target,
    appendNotice,
    requestRender,
    isDisposed,
  })
  updatePromptValues()

  const renderStatus = (): void => {
    streaming?.invalidate()
    requestRender()
  }

  /** Stop the turn-phase running and fade-out timers and drop both states. */
  const clearTurnStatus = (): void => {
    if (runningStatus !== undefined) {
      clearInterval(runningStatus.timer)
      runningStatus = undefined
    }
    if (fadingStatus !== undefined) {
      clearInterval(fadingStatus.timer)
      fadingStatus = undefined
    }
    runtime.terminal.setProgress(compacting !== undefined)
  }

  /** Hard clear: drop every indicator, including a live compaction bracket. */
  const clearStatus = (): void => {
    if (compacting !== undefined) {
      clearInterval(compacting.timer)
      compacting = undefined
    }
    clearTurnStatus()
  }

  /**
   * Hand the last active glyph to a fade-out that re-renders until it settles
   * on the `>` caret, then stops its own timer. A hard clear (teardown) skips
   * this via {@link clearStatus}.
   */
  const beginFadeOut = (glyph: string): void => {
    clearTurnStatus()
    const fading: FadingStatus = {
      glyph,
      endedAt: now(),
      timer: setInterval(() => {
        if (now() - fading.endedAt >= STATUS_FADE_MS) clearTurnStatus()
        renderStatus()
      }, STATUS_ANIMATION_INTERVAL_MS),
    }
    fadingStatus = fading
  }

  const setStatus = (status: AgentStatus): void => {
    const priorTurn = runningStatus?.turn
    const fadeOutGlyph = status !== 'running' ? runningStatus?.lastGlyph : undefined
    if (status === 'running') {
      clearIdleExitConfirmation(false)
      clearConversationConfirmationState(false)
      clearTurnStatus()
    }
    else if (fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    else clearTurnStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    updateEditorHint()
    if (status === 'running') {
      const turn = priorTurn ?? openTurn(agent.session.events)
      const running: RunningStatus = {
        turn,
        startedAt: now(),
        // Seed with the current phase (ttft before the first step opens) so the
        // fade-out always has a glyph, even for a turn that ends before a render.
        lastGlyph: TIMING_BUCKET_GLYPHS[openStepPhase(agent.session.events) ?? 'ttft'],
        // Refresh every tick so the fading prompt phase glyph animates even
        // before the first token, when no streaming component exists yet.
        timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
      }
      runningStatus = running
      runtime.terminal.setProgress(true)
    }
    requestRender()
  }

  const refreshStatus = (): void => {
    renderStatus()
  }

  const parsedTool = (event: Extract<SessionEvent, { type: 'tool/call' }>): ToolCardComponent => {
    const parsed = parseArguments(event.data.arguments)
    const card = new ToolCardComponent(
      event.data.name,
      parsed,
      ctx.tools.get(event.data.name, agent),
      resolved.maxToolOutputLines,
      resolved.maxDiffEditLength,
      palette,
      mdTheme,
      event.time,
    )
    card.setVisibility(toolsVisibility)
    toolCards.set(event.data.callId, card)
    allToolCards.add(card)
    return card
  }

  /**
   * Re-derive hidden-mode folding for one turn: the first step with a visible
   * body keeps its leading spacing, every other step renders as a continuation
   * (empty ones render nothing). Any other visibility restores per-step spacing.
   */
  const applyTurnFolding = (turn: number): void => {
    const steps = assistantSteps.get(turn)
    if (steps === undefined) return
    let headerSeen = false
    for (const step of steps) {
      if (toolsVisibility !== 'hidden') {
        step.setFoldedContinuation(false)
      } else if (!headerSeen && step.hasVisibleBody()) {
        headerSeen = true
        step.setFoldedContinuation(false)
      } else {
        step.setFoldedContinuation(true)
      }
    }
  }

  const registerAssistantStep = (component: StreamingAssistantComponent): void => {
    const steps = assistantSteps.get(component.position.turn) ?? []
    steps.push(component)
    assistantSteps.set(component.position.turn, steps)
    applyTurnFolding(component.position.turn)
  }

  const removeStreaming = (current: StreamingAssistantComponent | undefined): void => {
    if (current === undefined) return
    for (const child of [current, current.timing]) {
      const index = chat.children.indexOf(child)
      /* v8 ignore next -- streaming components and their timing footers are retained only while attached to the chat. */
      if (index >= 0) chat.children.splice(index, 1)
    }
    const steps = assistantSteps.get(current.position.turn)
    /* v8 ignore next -- every attached streaming component is registered in the fold map. */
    if (steps === undefined) return
    const index = steps.indexOf(current)
    /* v8 ignore next -- registration precedes attachment, so the component is present until this removal. */
    if (index < 0) return
    steps.splice(index, 1)
    // A retracted step may have owned the turn's hidden-mode header.
    applyTurnFolding(current.position.turn)
  }

  /**
   * Move the running step's timing footer to the tail of the chat so it trails
   * the tool cards the step just appended. A completed footer (its step ended,
   * so `streaming` is cleared) stays pinned where it is.
   */
  const trailStreamingTiming = (): void => {
    /* v8 ignore next -- every replayed tool event follows its step/start, so an open step always owns an attached footer here. */
    if (streaming === undefined) return
    const footer = streaming.timing
    const index = chat.children.indexOf(footer)
    /* v8 ignore next -- the open step's footer is attached to the chat whenever a tool event of that step renders. */
    if (index < 0) return
    chat.children.splice(index, 1)
    chat.addChild(footer)
  }

  const clearStreaming = (): void => {
    removeStreaming(streaming)
    streaming = undefined
  }

  const retractFailedStreaming = (): void => {
    removeStreaming(streaming ?? completedStreaming)
    streaming = undefined
    completedStreaming = undefined
  }

  const startAssistantStep = (position: StepPosition): void => {
    streaming = new StreamingAssistantComponent(
      position,
      () => agent.session.events,
      stepTimingTracker,
      now,
      showReasoning,
      palette,
      mdTheme,
      inlineImage,
    )
    registerAssistantStep(streaming)
    chat.addChild(streaming)
    chat.addChild(streaming.timing)
  }

  const renderEvent = (
    event: SessionEvent,
    options: {
      renderChunks: boolean
    },
  ): void => {
    switch (event.type) {
      case 'user/message': {
        // Injected context (plugin/goal source) renders as a dim context card,
        // not a human bubble; only a direct human prompt is a user message. The
        // boolean avoids narrowing `source`, so the label keeps its full union.
        const source = event.data.source
        if (source.kind !== 'user') {
          const references = sessionReferenceCard(event.data.source)
          if (references !== undefined) {
            chat.addChild(new Spacer(1))
            chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 0, 0))
            break
          }
          const text = contentText(event.data.content).trim()
          /* v8 ignore next -- context events with empty content are rejected by their owning producers. */
          if (text) {
            // The tui type view lacks plugin-augmented source kinds (e.g. goal),
            // so read the display label without narrowing on `kind`. The session
            // log is a durable/replay boundary: a corrupt or foreign injected
            // source may not match the typed shape, so fall back to `context`.
            const labelled = source as { kind?: unknown; plugin?: unknown }
            const label = typeof labelled.plugin === 'string' ? labelled.plugin
              : typeof labelled.kind === 'string' ? labelled.kind
                : 'context'
            const card = new ContextCardComponent(label, text, resolved.maxToolOutputLines, palette)
            card.setExpanded(toolsVisibility === 'expanded')
            contextCards.add(card)
            chat.addChild(new Spacer(1))
            chat.addChild(card)
          }
          break
        }
        const images = event.data.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
        const text = displayText(contentText(event.data.content.filter(block => block.type !== 'image')).trim())
        if (text || images.length > 0) {
          chat.addChild(new Spacer(1))
          if (text) chat.addChild(new UserMessageComponent(text, palette, mdTheme))
          for (const image of images) {
            chat.addChild(inlineImage?.(image) ?? new Text(palette.dim(contentText([image])), 0, 0))
          }
        }
        break
      }
      case 'step/start':
        // The loop opens the step before it appends the accepted user/context
        // messages. Defer the visual assistant row until the first assistant
        // chunk/message (or an otherwise empty step/end), so transcript order
        // remains User -> Assistant while timing still derives from the log.
        completedStreaming = undefined
        break
      case 'assistant/chunk':
        if (streaming === undefined) startAssistantStep(event.data)
        if (options.renderChunks && streaming !== undefined) {
          streaming.update(event.data.chunk)
          // The first streamed text/reasoning may make this step the turn's
          // hidden-mode header owner (or a continuation with a visible body).
          applyTurnFolding(streaming.position.turn)
        }
        break
      case 'assistant/message':
        completedStreaming = undefined
        // A settled component stays attached but never absorbs a later message
        // of the same step; both the live and replay paths start a new one.
        if (streaming === undefined || streaming.isSettled() || !chat.children.includes(streaming)) startAssistantStep(event.data)
        if (streaming !== undefined) {
          streaming.settle(event.data.message.content)
          applyTurnFolding(streaming.position.turn)
        }
        break
      case 'llm/retry': {
        retractFailedStreaming()
        const retryLimit = event.data.mode === 'always' ? '∞' : String(event.data.maxRetries)
        appendNotice(
          `Retrying model request (${event.data.retry}/${retryLimit}) in ${event.data.delayMs}ms: ${event.data.failure.message}`,
          'warning',
        )
        break
      }
      // No external Spacer for tool cards: the card renders its own leading
      // gap, so the hidden state removes the row and the gap together.
      case 'tool/call':
        chat.addChild(parsedTool(event))
        trailStreamingTiming()
        break
      case 'tool/result': {
        const callId = event.data.message.source.callId
        let card = toolCards.get(callId)
        if (card === undefined) {
          card = new ToolCardComponent(
            'tool',
            { value: {}, valid: true },
            undefined,
            resolved.maxToolOutputLines,
            resolved.maxDiffEditLength,
            palette,
            mdTheme,
            event.time,
          )
          card.setVisibility(toolsVisibility)
          chat.addChild(card)
          allToolCards.add(card)
        }
        card.updateResult(event.data, event.time)
        toolCards.delete(callId)
        trailStreamingTiming()
        break
      }
      case 'todo/write':
        todo.update(event.data.todos)
        break
      case 'turn/start':
        // Plan strip is turn-scoped: keep it after turn/end for reading, clear on the next turn.
        todo.update([])
        break
      case 'session/title':
        sessionTitle = event.data.title
        header.invalidate()
        updateTerminalTitle()
        break
      case 'step/end':
        if (streaming === undefined) startAssistantStep(event.data)
        streaming?.complete(event.time)
        completedStreaming = streaming
        streaming = undefined
        break
      // Every turn/end kind presents why the agent stopped: `completed` is
      // presented by the settled assistant message and its Completed timing
      // header; every other kind appends an explicit notice.
      case 'turn/end': {
        clearStreaming()
        const reason = event.data.reason
        switch (reason.kind) {
          case 'completed':
            break
          case 'error': {
            // The loop emits agent/error per failing step; this notice is the
            // turn-level fallback when no such pair was rendered.
            if (liveErrorTurns.delete(event.data.turn)) break
            appendNotice(reason.error.message, 'error')
            break
          }
          case 'aborted':
            appendNotice('Turn cancelled.', 'warning')
            break
          case 'blocked':
            appendNotice('Turn stopped: the agent is blocked.', 'warning')
            break
          case 'max-tokens':
            appendNotice('The model reached its output-token limit.', 'warning')
            break
          case 'interrupted':
            appendNotice('The previous process ended during this turn.', 'warning')
            break
          default:
            // TurnEndReasonMap is merge-extensible: a plugin-added outcome
            // still names why the agent stopped rather than ending silently.
            appendNotice(`Turn ended: ${(reason as { kind: string }).kind}.`, 'warning')
            break
        }
        break
      }
      default:
        break
    }
  }

  const renderCompactionMarker = (): void => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.dim(COMPACTION_MARKER), 0, 0))
  }

  /**
   * Replay the human transcript from the append-only log. The model-visible
   * surface shadows compacted ranges, so it is not the source here: every
   * append-origin message stays rendered, and a replacement contributes at most
   * the compaction marker at its own log position.
   *
   * The `tool/call` pairing check has no live counterpart, because only replay
   * can meet an orphan: `tool/call` carries no `surfaceOp` of its own, so it
   * inherits transcript membership from the `assistant/message` that advertised
   * it, which the live listener has necessarily just rendered. A loaded log is a
   * replay boundary, so the pairing is re-derived here instead of assumed.
   */
  const rebuildTranscript = (populateHistory: boolean): void => {
    chat.clear()
    toolCards.clear()
    allToolCards.clear()
    contextCards.clear()
    assistantSteps.clear()
    streaming = undefined
    todo.update([])
    const transcriptCalls = transcriptToolCallIds(agent.session)
    for (const event of agent.session.events) {
      if (isReplacementSurfaceEvent(event)) {
        if (isCompactCheckpoint(event)) renderCompactionMarker()
        continue
      }
      if (event.type === 'tool/call' && !transcriptCalls.has(event.data.callId)) continue
      renderEvent(event, { renderChunks: false })
    }
    if (populateHistory) {
      for (const entry of promptHistory.list('session', '').reverse()) editor.addToHistory(entry.text)
    }
    requestRender()
  }

  /** Release pi-tui while a foreground editor owns the inherited terminal. */
  const editExternally = async (draft: string): Promise<string> => {
    const editText = runtime.editText
    if (editText === undefined) throw new Error('this host does not provide an external editor')
    if (externalEditorInFlight) throw new Error('an external editor is already open')
    if (freshSwapInFlight) throw new Error('a fresh conversation is starting')
    if (foregroundShell !== undefined) {
      throw new Error('background or cancel the foreground shell command first')
    }
    clearIdleExitConfirmation(false)
    clearConversationConfirmationState(false)
    const restoreSubmitDisabled = editor.disableSubmit
    externalEditorInFlight = true
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    let terminalStopped = false
    try {
      await runtime.terminal.drainInput(100, 20)
      if (disposed) throw new Error('the TUI was disposed before the external editor opened')
      ui.stop()
      terminalStopped = true
      const previousResponse = userSettings.externalEditorContext
        ? latestAssistantResponse(agent.session.events)
        : undefined
      return await editText({
        draft,
        ...previousResponse === undefined ? {} : { previousResponse },
      })
    } finally {
      try {
        if (terminalStopped && !disposed) {
          ui.start()
          ui.invalidate()
          ui.requestRender(true)
        }
      } finally {
        externalEditorInFlight = false
        editor.disableSubmit = restoreSubmitDisabled
        updateEditorHint()
        if (!disposed) requestRender()
      }
    }
  }

  const questions = createQuestionQueue({
    ctx,
    resolved,
    palette,
    overlayManager,
    requestRender,
    isDisposed,
    ui,
    editExternally,
    questionMaxHeight: () => {
      const width = runtime.terminal.columns
      const editorRows = editor.render(width).length
      return Math.max(1, Math.min(
        resolved.questionDialogMaxHeight,
        runtime.terminal.rows - editorRows,
      ))
    },
  })

  const approvals = createApprovalQueue({
    ctx,
    agent,
    resolved,
    palette,
    overlayManager,
    requestRender,
    isDisposed,
    approvalMaxHeight: () => {
      const width = runtime.terminal.columns
      const editorRows = editor.render(width).length
      return Math.max(1, Math.min(
        resolved.questionDialogMaxHeight,
        runtime.terminal.rows - editorRows,
      ))
    },
  })

  const resume = createResumeController({
    ctx,
    agent,
    runtime,
    resolved,
    palette,
    overlayManager,
    // Optional and independently mounted. Cordis transiently leaves this sibling
    // non-ACTIVE during command callbacks, so the non-strict read is intentional;
    // terminal fiber states still exclude failed, closing, and closed providers.
    sessionQuery: optionalSessionQuery,
    ui,
    editor,
    appendNotice,
    requestRender,
    isDisposed,
    agentStatus,
  })

  const shutdown = (exitProcess: boolean): Promise<void> => {
    shuttingDown ??= (async () => {
      disposed = true
      clearIdleExitConfirmation(false)
      clearConversationConfirmationState(false)
      clearSubagentKillConfirmation(false)
      externalEditorShortcut.reset()
      subagentKillShortcut.reset()
      subagentKillAbort?.abort(new Error('TUI disposed'))
      subagentKillAbort = undefined
      overlayManager.beginShutdown()
      modelController.resetContextResolution()
      clearStatus()
      for (const controller of commandControllers) controller.abort(new Error('TUI disposed'))
      commandControllers.clear()
      for (const controller of referenceControllers) controller.abort(new Error('TUI disposed'))
      referenceControllers.clear()
      for (const controller of transferControllers) controller.abort(new Error('TUI disposed'))
      transferControllers.clear()
      clipboardImages.clear()
      disposeForegroundShell('TUI disposed')
      await tuiServiceFiber?.dispose()
      tuiServiceFiber = undefined
      questions.rejectAll()
      approvals.rejectAll()
      await overlayManager.dispose()
      modelController.clearOverlay()
      questions.unregister()
      approvals.unregister()
      await runtime.terminal.drainInput(100, 20)
      ui.stop()
      if (exitProcess) {
        if (runtime.goodbyeMessage !== undefined) {
          runtime.terminal.write(`${palette.dim(displayText(runtime.goodbyeMessage))}\n`)
        }
        runtime.exit(0)
      }
    })()
    return shuttingDown
  }

  const requestExit = (): void => {
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      appendNotice('Cancelling the active turn before exit…', 'warning')
      void agent.whenIdle().then(() => shutdown(true))
      return
    }
    void shutdown(true)
  }

  const hasActiveConversationWork = (): boolean =>
    foregroundShell !== undefined || agent.status !== 'idle' || workspaceOperation !== undefined

  /** Persist one explicit user title without duplicating its raw input in command lifecycle events. */
  const renameSession = (rawInput: string, usage: string): CommandResult => {
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) {
      return {
        kind: 'error',
        text: 'Session renaming is unavailable because this runtime has no session-title service.',
      }
    }
    try {
      const accepted = titles.rename(agent.session, rawInput)
      return {
        kind: 'success',
        text: `Session renamed: ${accepted.title}.`,
        sourceEventSeq: accepted.eventSeq,
      }
    } catch (error: unknown) {
      if (error instanceof SessionTitleInvalidError) {
        return { kind: 'error', text: `${error.message}. Usage: ${usage}` }
      }
      return { kind: 'error', text: `Session rename failed: ${errorChain(error)}` }
    }
  }

  /** Rename explicitly, or regenerate a title from eligible conversation history when bare. */
  const runRename = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    if (rawInput.trim() !== '') return renameSession(rawInput, '/rename <name>')
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) {
      return {
        kind: 'error',
        text: 'Session renaming is unavailable because this runtime has no session-title service.',
      }
    }
    try {
      const accepted = await titles.refresh(agent.session, signal)
      if (accepted === undefined) {
        return {
          kind: 'error',
          text: 'Cannot generate a session name before the conversation has a human message. Usage: /rename <name>',
        }
      }
      return {
        kind: 'success',
        text: `Session renamed: ${accepted.title}.`,
        sourceEventSeq: accepted.eventSeq,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: `Session rename failed: ${errorChain(error)}` }
    }
  }

  /** Flush the current log and atomically replace this channel with a fresh session. */
  const startFreshConversation = (
    nextCwd?: string,
    routingProfile?: ToolRoutingProfile,
  ): void => {
    clearIdleExitConfirmation(false)
    clearConversationConfirmationState(false)
    if (freshSwapInFlight) return
    if (hasActiveConversationWork()) {
      appendNotice('Finish or cancel active work before starting a new conversation.', 'warning')
      return
    }
    const swapFresh = runtime.swapFresh
    if (swapFresh === undefined) {
      chat.clear()
      appendNotice('Conversation view cleared, but this host cannot start a fresh session.', 'warning')
      return
    }
    const selection: ModelSelection | undefined = target.current === undefined
      ? undefined
      : { ...target.current }
    freshSwapInFlight = true
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    void (async () => {
      await ctx.sessions.flush(agent.session)
      if (isDisposed()) return
      if (hasActiveConversationWork()) {
        throw new Error('active work began before the conversation could be cleared')
      }
      await runtime.terminal.drainInput(100, 20)
      if (isDisposed()) return
      await swapFresh(selection, nextCwd, routingProfile)
    })().catch((error: unknown) => {
      if (!isDisposed()) appendNotice(`Clear failed: ${errorChain(error)}`, 'error')
    }).finally(() => {
      if (isDisposed()) return
      freshSwapInFlight = false
      editor.disableSubmit = false
      updateEditorHint()
      requestRender()
    })
  }

  /** Start fresh, optionally assigning the previous session one explicit durable title. */
  const runClear = (rawInput: string): CommandResult => {
    if (rawInput.trim() !== '') {
      if (freshSwapInFlight) {
        return { kind: 'error', text: 'A fresh conversation is already starting.' }
      }
      if (hasActiveConversationWork()) {
        return { kind: 'error', text: 'Finish or cancel active work before starting a new conversation.' }
      }
      const renamed = renameSession(rawInput, '/clear [name]')
      if (renamed.kind === 'error') return renamed
      startFreshConversation()
      return renamed
    }
    startFreshConversation()
    return { kind: 'success' }
  }

  /** Switch workspace by atomically remounting a fresh session at a validated directory. */
  const runWorkdir = async (rawInput: string): Promise<CommandResult> => {
    const requested = rawInput.trim()
    if (requested === '') return { kind: 'success', text: `Current workspace: ${displayText(cwd)}` }
    if (freshSwapInFlight) return { kind: 'error', text: 'A workspace transition is already starting.' }
    if (hasActiveConversationWork()) {
      return { kind: 'error', text: 'Finish or cancel active work before switching workspace.' }
    }
    const nextCwd = resolvePath(cwd, requested)
    try {
      if (!(await stat(nextCwd)).isDirectory()) {
        return { kind: 'error', text: `Not a directory: ${displayText(nextCwd)}` }
      }
    } catch {
      return { kind: 'error', text: `Workspace does not exist: ${displayText(nextCwd)}` }
    }
    startFreshConversation(nextCwd)
    return { kind: 'success', text: `Switching workspace to ${displayText(nextCwd)}.` }
  }

  /** Switch the model-facing tool router at a clean first-request boundary. */
  const runMode = (rawInput: string): CommandResult => {
    const requested = rawInput.trim().toLowerCase()
    const profileName: Record<ToolRoutingProfile, string> = {
      anchored: 'Minimal',
      suite: 'Router Standard',
      'suite-spec': 'Router Spec',
    }
    const preset = agent.session.header.agentPreset
    const current: ToolRoutingProfile = preset === ROUTING_PROFILE_PRESETS.suite
      ? 'suite'
      : preset === ROUTING_PROFILE_PRESETS['suite-spec']
        ? 'suite-spec'
        : 'anchored'
    if (requested === '') {
      return {
        kind: 'success',
        text: `Tool routing mode: ${profileName[current]}. Usage: /mode <minimal|router|spec>`,
      }
    }
    const aliases: Record<string, ToolRoutingProfile> = {
      anchored: 'anchored',
      minimal: 'anchored',
      anchor: 'anchored',
      suite: 'suite',
      routing: 'suite',
      router: 'suite',
      'router-standard': 'suite',
      standard: 'suite',
      'suite-spec': 'suite-spec',
      spec: 'suite-spec',
      'router-spec': 'suite-spec',
      deep: 'suite-spec',
    }
    const profile = aliases[requested]
    if (profile === undefined) {
      return { kind: 'error', text: 'Usage: /mode <minimal|router|spec>' }
    }
    if (profile === current) {
      return { kind: 'success', text: `Already using ${profileName[profile]} mode.` }
    }
    if (freshSwapInFlight) return { kind: 'error', text: 'A mode transition is already starting.' }
    if (hasActiveConversationWork()) {
      return { kind: 'error', text: 'Finish or cancel active work before switching tool routing mode.' }
    }
    startFreshConversation(undefined, profile)
    return {
      kind: 'success',
      text: `Switching to ${profileName[profile]} mode in a fresh session.`,
    }
  }

  /** Open the picker when bare, or hand one exact id/title to the shared resume preflight. */
  const runResume = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    const reference = rawInput.trim()
    if (reference === '') {
      resume.showResume()
      return { kind: 'success' }
    }
    try {
      await resume.resume(reference, signal)
      return { kind: 'success' }
    } catch (error: unknown) {
      return { kind: 'error', text: `Resume failed: ${errorChain(error)}` }
    }
  }

  let transferOverlay: TuiOverlaySession | undefined

  /** Resolve one value through the serialized clipboard/file transfer overlay family. */
  const chooseTransferOverlay = <Value>(
    create: (done: (value: Value) => void, cancel: () => void) => Component,
    signal: AbortSignal,
  ): Promise<Value | undefined> => {
    void transferOverlay?.close()
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: Value | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
        void session.close()
      }
      const session = overlayManager.open({
        create: () => create((value) => { finish(value) }, () => { finish(undefined) }),
        options: {
          width: resolved.modelDialogWidth,
          maxHeight: resolved.modelDialogMaxHeight,
          anchor: 'center',
          margin: 1,
        },
        signal,
      })
      transferOverlay = session
      void session.closed.then(() => {
        if (transferOverlay === session) transferOverlay = undefined
        finish(undefined)
      })
      requestRender()
    })
  }

  /** Resolve one response/code target and whether to copy or write it. */
  const chooseCopySelection = (
    responseText: string,
    codeBlocks: ReturnType<typeof assistantCodeBlocks>,
    ordinal: number,
    signal: AbortSignal,
  ): Promise<CopyResponseAction | undefined> => chooseTransferOverlay(
    (done, cancel) => new CopyResponseDialog(
      responseText,
      codeBlocks,
      ordinal,
      resolved.maxModelOptions,
      palette,
      done,
      cancel,
    ),
    signal,
  )

  /** Prompt for the destination of a response-picker write action. */
  const chooseCopyFilePath = (
    selection: CopyResponseSelection,
    signal: AbortSignal,
  ): Promise<string | undefined> => chooseTransferOverlay(
    (done, cancel) => new CopyResponsePathDialog(selection, cwd, palette, done, cancel),
    signal,
  )

  /** Require an explicit destructive confirmation for an existing target. */
  const confirmCopyFileOverwrite = (
    path: string,
    signal: AbortSignal,
  ): Promise<boolean | undefined> => chooseTransferOverlay(
    (done, cancel) => new CopyResponseOverwriteDialog(
      path,
      palette,
      () => { done(true) },
      cancel,
    ),
    signal,
  )

  /** Choose whether a complete conversation goes to the clipboard or its default file. */
  const chooseConversationExport = (
    filename: string,
    signal: AbortSignal,
  ): Promise<ConversationExportAction | undefined> => chooseTransferOverlay(
    (done, cancel) => new ConversationExportDialog(
      filename,
      resolved.maxModelOptions,
      palette,
      {
        copy: runtime.writeClipboardText !== undefined,
        write: runtime.writeTextFile !== undefined,
      },
      done,
      cancel,
    ),
    signal,
  )

  /** Copy one already-selected target while retaining cancellable host ownership. */
  const copySelection = async (
    selection: CopyResponseSelection,
    signal: AbortSignal,
    subject = 'assistant response',
  ): Promise<void> => {
    const writeClipboardText = runtime.writeClipboardText
    if (writeClipboardText === undefined) {
      throw new Error('this runtime has no clipboard text writer')
    }
    if (transferOperation !== undefined) throw new Error('another clipboard or file operation is already running')
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort(signal.reason instanceof Error ? signal.reason : new Error('clipboard copy was cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`clipboard copy timed out after ${String(CLIPBOARD_TEXT_TIMEOUT_MS)}ms`))
    }, CLIPBOARD_TEXT_TIMEOUT_MS)
    const restoreSubmitDisabled = editor.disableSubmit
    transferControllers.add(controller)
    transferOperation = 'copying'
    transferSubject = subject
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    try {
      await writeClipboardText({ text: selection.text, signal: controller.signal, cwd })
      showCopyToast(selection.text)
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      transferControllers.delete(controller)
      if (!disposed) {
        transferOperation = undefined
        transferSubject = 'assistant response'
        editor.disableSubmit = restoreSubmitDisabled
        updateEditorHint()
        requestRender()
      }
    }
  }

  /** Attempt one guarded selected-text file write through the host boundary. */
  const writeSelectionToFile = async (
    selection: CopyResponseSelection,
    path: string,
    overwrite: boolean,
    signal: AbortSignal,
    subject = 'assistant response',
  ): Promise<TextFileWriteResult> => {
    const writeTextFile = runtime.writeTextFile
    if (writeTextFile === undefined) throw new Error('this runtime has no response file writer')
    if (transferOperation !== undefined) throw new Error('another clipboard or file operation is already running')
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort(signal.reason instanceof Error ? signal.reason : new Error('file write was cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const restoreSubmitDisabled = editor.disableSubmit
    transferControllers.add(controller)
    transferOperation = 'writing'
    transferSubject = subject
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    try {
      return await writeTextFile({
        path,
        text: selection.text,
        overwrite,
        signal: controller.signal,
        cwd,
      })
    } finally {
      signal.removeEventListener('abort', abort)
      transferControllers.delete(controller)
      if (!disposed) {
        transferOperation = undefined
        transferSubject = 'assistant response'
        editor.disableSubmit = restoreSubmitDisabled
        updateEditorHint()
        requestRender()
      }
    }
  }

  /** Write a human-selected text target, only replacing an existing file after confirmation. */
  const writeSelectionWithConfirmation = async (
    selection: CopyResponseSelection,
    path: string,
    signal: AbortSignal,
    subject = 'assistant response',
  ): Promise<TextFileWriteResult | undefined> => {
    let result = await writeSelectionToFile(selection, path, false, signal, subject)
    if (result.kind !== 'exists') return result
    const overwrite = await confirmCopyFileOverwrite(result.path, signal)
    if (overwrite !== true) return undefined
    result = await writeSelectionToFile(selection, result.path, true, signal, subject)
    if (result.kind === 'exists') throw new Error('the response file writer did not honor overwrite confirmation')
    return result
  }

  /** Copy the latest or Nth latest persistent, transcript-visible assistant reply. */
  const runCopy = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    const argument = rawInput.trim()
    if (argument !== '' && !/^[1-9]\d*$/u.test(argument)) {
      return { kind: 'error', text: 'Usage: /copy [N] (N must be a positive integer)' }
    }
    const ordinal = argument === '' ? 1 : Number(argument)
    if (!Number.isSafeInteger(ordinal)) {
      return { kind: 'error', text: 'Usage: /copy [N] (N must be a positive safe integer)' }
    }
    const responses = visibleAssistantResponses(agent.session.events)
    const response = responses[ordinal - 1]
    if (response === undefined) {
      if (responses.length === 0) {
        return { kind: 'error', text: 'No visible assistant response is available to copy.' }
      }
      return {
        kind: 'error',
        text: `Assistant response #${String(ordinal)} is unavailable; this session has ${String(responses.length)} visible response${responses.length === 1 ? '' : 's'}.`,
      }
    }
    const codeBlocks = assistantCodeBlocks(response.text).filter(block => block.text.trim() !== '')
    const action: CopyResponseAction | undefined = codeBlocks.length === 0
      ? {
        kind: 'copy',
        selection: { label: `full response #${String(ordinal)}`, text: response.text },
      }
      : await chooseCopySelection(response.text, codeBlocks, ordinal, signal)
    if (action === undefined) return { kind: 'success' }
    if (action.kind === 'copy') {
      if (runtime.writeClipboardText === undefined) {
        return {
          kind: 'error',
          text: 'Clipboard copy is unavailable because this runtime has no clipboard text writer.',
        }
      }
      try {
        await copySelection(action.selection, signal)
        return { kind: 'success' }
      } catch (error: unknown) {
        return { kind: 'error', text: `Clipboard copy failed: ${errorChain(error)}` }
      }
    }
    if (runtime.writeTextFile === undefined) {
      return {
        kind: 'error',
        text: 'File write is unavailable because this runtime has no response file writer.',
      }
    }
    const path = await chooseCopyFilePath(action.selection, signal)
    if (path === undefined) return { kind: 'success' }
    try {
      const result = await writeSelectionWithConfirmation(action.selection, path, signal)
      if (result === undefined) return { kind: 'success' }
      return { kind: 'success', text: `Wrote ${action.selection.label} to ${result.path}.` }
    } catch (error: unknown) {
      return { kind: 'error', text: `File write failed: ${errorChain(error)}` }
    }
  }

  /** Export the current durable conversation without adding its contents to model context. */
  const runExport = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    const selection: CopyResponseSelection = {
      label: 'conversation',
      text: exportConversationText(agent.session, sessionTitle),
    }
    const enteredPath = rawInput.trim()
    const path = enteredPath.length >= 2
      && ((enteredPath.startsWith('"') && enteredPath.endsWith('"'))
        || (enteredPath.startsWith("'") && enteredPath.endsWith("'")))
      ? enteredPath.slice(1, -1)
      : enteredPath
    if (path !== '') {
      if (runtime.writeTextFile === undefined) {
        return { kind: 'error', text: 'File export is unavailable because this runtime has no text file writer.' }
      }
      try {
        const result = await writeSelectionWithConfirmation(selection, path, signal, 'conversation')
        return result === undefined
          ? { kind: 'success' }
          : { kind: 'success', text: `Exported conversation to ${result.path}.` }
      } catch (error: unknown) {
        return { kind: 'error', text: `Export failed: ${errorChain(error)}` }
      }
    }
    if (runtime.writeClipboardText === undefined && runtime.writeTextFile === undefined) {
      return {
        kind: 'error',
        text: 'Conversation export is unavailable because this runtime has no clipboard or text file writer.',
      }
    }
    const filename = defaultConversationExportFilename(agent.session.id)
    const action = await chooseConversationExport(filename, signal)
    if (action === undefined) return { kind: 'success' }
    if (action === 'copy') {
      try {
        await copySelection(selection, signal, 'conversation')
        return { kind: 'success' }
      } catch (error: unknown) {
        return { kind: 'error', text: `Conversation export failed: ${errorChain(error)}` }
      }
    }
    try {
      const result = await writeSelectionWithConfirmation(selection, filename, signal, 'conversation')
      return result === undefined
        ? { kind: 'success' }
        : { kind: 'success', text: `Exported conversation to ${result.path}.` }
    } catch (error: unknown) {
      return { kind: 'error', text: `Export failed: ${errorChain(error)}` }
    }
  }

  let workspaceOverlay: TuiOverlaySession | undefined

  /** Open one workspace-control dialog while retaining command cancellation ownership. */
  const chooseWorkspaceOverlay = <Value>(
    create: (
      done: (value: Value) => void,
      cancel: () => void,
      viewportRows: () => number,
    ) => Component,
    signal: AbortSignal,
    options: TuiOverlayOptions = {
      width: resolved.modelDialogWidth,
      maxHeight: resolved.modelDialogMaxHeight,
      anchor: 'center',
      margin: 1,
    },
  ): Promise<Value | undefined> => {
    void workspaceOverlay?.close()
    return new Promise((resolve) => {
      let settled = false
      // oxlint-disable-next-line prefer-const -- assigned after the close callback is created so it can capture the session.
      let session!: TuiOverlaySession
      const finish = (value: Value | undefined): void => {
        if (!settled) {
          settled = true
          resolve(value)
          void session.close()
        }
      }
      session = overlayManager.open({
        create: host => create(
          (value) => { finish(value) },
          () => { finish(undefined) },
          () => host.viewport.rows,
        ),
        options,
        signal,
      })
      workspaceOverlay = session
      void session.closed.then(() => {
        if (workspaceOverlay === session) workspaceOverlay = undefined
        finish(undefined)
      })
      requestRender()
    })
  }

  /** Run one workspace command while preventing a competing turn or shell from racing its snapshot. */
  const withWorkspaceOperation = async <Value>(
    operation: NonNullable<typeof workspaceOperation>,
    signal: AbortSignal,
    work: () => Promise<Value>,
  ): Promise<Value> => {
    if (workspaceOperation !== undefined) throw new Error('another workspace operation is already running')
    if (agent.status !== 'idle' || foregroundShell !== undefined || freshSwapInFlight) {
      throw new Error('workspace controls require the active turn and foreground shell to be idle')
    }
    signal.throwIfAborted()
    const restoreSubmitDisabled = editor.disableSubmit
    workspaceOperation = operation
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    try {
      return await work()
    } finally {
      if (!disposed) {
        workspaceOperation = undefined
        editor.disableSubmit = restoreSubmitDisabled
        updateEditorHint()
        requestRender()
      }
    }
  }

  /** Return the newest fully closed event before this command's own pending lifecycle pair. */
  const currentWorkspaceBoundary = (commandId: CommandId): number => {
    const commandIndex = agent.session.events.findIndex(event =>
      event.type === 'command/run' && event.data.commandId === commandId)
    const boundary = stableForkBoundary(commandIndex < 0 ? agent.session.events : agent.session.events.slice(0, commandIndex))
    if (boundary === undefined) {
      throw new Error('Checkpoint requires at least one completed session event and cannot run during an active turn.')
    }
    return boundary
  }

  /** Check that a checkpoint's saved event boundary still occurs before a completed turn. */
  const checkpointCanForkConversation = (checkpoint: WorkspaceCheckpoint): boolean => {
    const index = agent.session.events.findIndex(event => event.seq === checkpoint.sessionBoundary)
    if (index < 0) return false
    const lastTurnBoundary = agent.session.events.slice(0, index + 1)
      .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    return lastTurnBoundary?.type !== 'turn/start'
  }

  /** Open a full-screen read-only diff pager without exposing its contents to model context. */
  const showWorkspaceDiff = (diff: WorkspaceDiff, signal: AbortSignal): Promise<void> =>
    chooseWorkspaceOverlay<void>(
      (done, _cancel, viewportRows) => new WorkspaceDiffDialog(
        diff,
        viewportRows,
        palette,
        () => { done(undefined) },
      ),
      signal,
      {
        width: '100%',
        maxHeight: '100%',
        anchor: 'top-left',
        margin: 0,
      },
    ).then(() => {})

  /** Select a session-owned checkpoint by picker, or return undefined when the user cancels. */
  const chooseWorkspaceCheckpoint = (
    checkpoints: readonly WorkspaceCheckpoint[],
    signal: AbortSignal,
  ): Promise<WorkspaceCheckpoint | undefined> => chooseWorkspaceOverlay(
    (done, cancel) => new WorkspaceCheckpointPickerDialog(
      checkpoints,
      resolved.maxModelOptions,
      palette,
      done,
      cancel,
    ),
    signal,
  )

  /** Select one safe rewind scope for the checkpoint. */
  const chooseWorkspaceRewindAction = (
    checkpoint: WorkspaceCheckpoint,
    capabilities: WorkspaceRewindCapabilities,
    signal: AbortSignal,
  ): Promise<WorkspaceRewindAction | undefined> => chooseWorkspaceOverlay(
    (done, cancel) => new WorkspaceRewindActionDialog(
      checkpoint,
      capabilities,
      resolved.maxModelOptions,
      palette,
      done,
      cancel,
    ),
    signal,
  )

  /** Ask the final irreversible-action guard; no file changes occur before it resolves true. */
  const confirmWorkspaceRewind = (
    checkpoint: WorkspaceCheckpoint,
    action: WorkspaceRewindAction,
    signal: AbortSignal,
  ): Promise<boolean> => chooseWorkspaceOverlay<boolean>(
    (done, cancel) => new WorkspaceRewindConfirmDialog(
      checkpoint,
      action,
      palette,
      () => { done(true) },
      cancel,
    ),
    signal,
  ).then(value => value === true)

  /** Render the current Git worktree diff without changing session or workspace state. */
  const runDiff = async (signal: AbortSignal): Promise<CommandResult> => {
    const history = runtime.workspaceHistory
    if (history === undefined) {
      return { kind: 'error', text: 'Workspace diff is unavailable because this runtime has no workspace history provider.' }
    }
    try {
      await withWorkspaceOperation('diff', signal, async () => {
        const diff = await history.diff({ cwd, signal })
        signal.throwIfAborted()
        await showWorkspaceDiff(diff, signal)
      })
      return { kind: 'success' }
    } catch (error: unknown) {
      return { kind: 'error', text: `Workspace diff failed: ${errorChain(error)}` }
    }
  }

  /** Capture one explicit checkpoint at the current completed conversation boundary. */
  const runCheckpoint = async (
    rawInput: string,
    commandId: CommandId,
    signal: AbortSignal,
  ): Promise<CommandResult> => {
    const history = runtime.workspaceHistory
    if (history === undefined) {
      return { kind: 'error', text: 'Workspace checkpoints are unavailable because this runtime has no workspace history provider.' }
    }
    const label = rawInput.trim()
    try {
      const checkpoint = await withWorkspaceOperation('checkpoint', signal, async () => {
        const boundary = currentWorkspaceBoundary(commandId)
        return await history.createCheckpoint({
          cwd,
          sessionId: agent.session.id,
          sessionBoundary: boundary,
          ...label === '' ? {} : { label },
          signal,
        })
      })
      const workspace = checkpoint.workspace.kind === 'git'
        ? `Git snapshot: ${String(checkpoint.workspace.trackedFiles ?? 0)} tracked and ${String(checkpoint.workspace.untrackedFiles ?? 0)} untracked file(s).`
        : `Conversation-only checkpoint: ${checkpoint.workspace.reason ?? 'Git workspace unavailable.'}`
      return { kind: 'success', text: `Created checkpoint ${String(checkpoint.id)}. ${workspace}` }
    } catch (error: unknown) {
      return { kind: 'error', text: `Checkpoint failed: ${errorChain(error)}` }
    }
  }

  /** Select and confirm a code and/or conversation rewind, preserving a pre-rewind safety point. */
  const runRewind = async (
    rawInput: string,
    commandId: CommandId,
    signal: AbortSignal,
  ): Promise<CommandResult> => {
    const history = runtime.workspaceHistory
    if (history === undefined) {
      return { kind: 'error', text: 'Rewind is unavailable because this runtime has no workspace history provider.' }
    }
    const reference = rawInput.trim()
    let restoredBackup: WorkspaceCheckpoint | undefined
    try {
      const result = await withWorkspaceOperation('rewind', signal, async (): Promise<CommandResult> => {
        const checkpoints = await history.listCheckpoints({ sessionId: agent.session.id, signal })
        if (checkpoints.length === 0) {
          return { kind: 'error', text: 'No checkpoints exist for this session. Run /checkpoint first.' }
        }
        const checkpoint = reference === ''
          ? await chooseWorkspaceCheckpoint(checkpoints, signal)
          : checkpoints.find(candidate => String(candidate.id) === reference)
        if (checkpoint === undefined) {
          return reference === ''
            ? { kind: 'success' }
            : { kind: 'error', text: `No checkpoint with id "${displayText(reference)}" belongs to this session.` }
        }
        const capabilities: WorkspaceRewindCapabilities = {
          workspace: checkpoint.workspace.kind === 'git',
          conversation: runtime.swapFork !== undefined && checkpointCanForkConversation(checkpoint),
        }
        if (!capabilities.workspace && !capabilities.conversation) {
          return {
            kind: 'error',
            text: 'This checkpoint cannot be rewound: it has no Git snapshot and no stable conversation branch boundary.',
          }
        }
        const action = await chooseWorkspaceRewindAction(checkpoint, capabilities, signal)
        if (action === undefined) return { kind: 'success' }
        if (!await confirmWorkspaceRewind(checkpoint, action, signal)) return { kind: 'success' }
        if (agent.status !== 'idle' || foregroundShell !== undefined || freshSwapInFlight) {
          return { kind: 'error', text: 'Rewind requires the active turn and foreground shell to remain idle.' }
        }
        const restoreWorkspace = action === 'workspace' || action === 'both'
        const forkConversation = action === 'conversation' || action === 'both'
        if (restoreWorkspace) {
          const result = await history.restoreCheckpoint({
            checkpoint,
            cwd,
            sessionId: agent.session.id,
            sessionBoundary: currentWorkspaceBoundary(commandId),
            signal,
          })
          restoredBackup = result.backup
        }
        if (!forkConversation) {
          return {
            kind: 'success',
            text: `Workspace restored from checkpoint ${String(checkpoint.id)}. Safety checkpoint ${String(restoredBackup?.id)} was created.`,
          }
        }
        const swapFork = runtime.swapFork
        if (swapFork === undefined || !checkpointCanForkConversation(checkpoint)) {
          const suffix = restoredBackup === undefined
            ? ''
            : ` Workspace restoration succeeded; return to safety checkpoint ${String(restoredBackup.id)} if needed.`
          return { kind: 'error', text: `Conversation rewind is no longer available at this checkpoint.${suffix}` }
        }
        await ctx.sessions.flush(agent.session)
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- asynchronous flush/cancellation can change session state.
        if (agent.status !== 'idle' || foregroundShell !== undefined || !checkpointCanForkConversation(checkpoint)) {
          const suffix = restoredBackup === undefined
            ? ''
            : ` Workspace restoration succeeded; return to safety checkpoint ${String(restoredBackup.id)} if needed.`
          return { kind: 'error', text: `Conversation rewind could not start because session state changed.${suffix}` }
        }
        await runtime.terminal.drainInput(100, 20)
        signal.throwIfAborted()
        const selection: ModelSelection | undefined = target.current === undefined ? undefined : { ...target.current }
        const workspaceNotice = restoredBackup === undefined
          ? `Opened a child session at checkpoint ${String(checkpoint.id)}. The original session remains resumable.`
          : `Workspace restored from checkpoint ${String(checkpoint.id)}; safety checkpoint ${String(restoredBackup.id)} was created. Opened a child session; the original remains resumable.`
        await swapFork(checkpoint.sessionBoundary, selection, workspaceNotice)
        return { kind: 'success' }
      })
      return result
    } catch (error: unknown) {
      const suffix = restoredBackup === undefined
        ? ''
        : ` Workspace restoration succeeded; return to safety checkpoint ${String(restoredBackup.id)} if needed.`
      return { kind: 'error', text: `Rewind failed: ${errorChain(error)}${suffix}` }
    }
  }

  /** Swap the palette and all derived themes for the given terminal color scheme. */
  const applyColorScheme = (scheme: TerminalColorScheme): void => {
    if (scheme === currentScheme) return
    currentScheme = scheme
    Object.assign(palette, createPalette(resolved.theme.color, scheme, resolved.theme.palette, resolved.theme.truecolor))
    Object.assign(mdTheme, markdownTheme(palette))
    // `requestRender` below re-derives the editor rails from the new palette.
    rebuildTranscript(false)
    setStatus(agent.status)
    requestRender()
  }
  let currentScheme: TerminalColorScheme = 'dark'

  // Apply any color scheme the terminal reports. Registering before the query
  // below means even a synchronous reply reaches `applyColorScheme`; in practice
  // the startup query's reply is the only report, since dsh-tui leaves
  // unsolicited color-scheme notifications disabled.
  const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme)

  // Ask the terminal for its color scheme via device-status report; the reply,
  // if any, arrives through the listener above. Most terminals do not respond,
  // so we keep the dark Claude palette. Swallow a query-write failure for the
  // same reason.
  ui.queryTerminalColorScheme({ timeoutMs: 2000 }).catch(() => {})

  const setToolsVisibility = (next: ToolCardVisibility): void => {
    toolsVisibility = next
    for (const card of allToolCards) card.setVisibility(toolsVisibility)
    // Context cards carry injected instructions rather than tool traffic, so
    // they never hide: the hidden phase reads as their collapsed preview.
    for (const card of contextCards) card.setExpanded(toolsVisibility === 'expanded')
    // Hidden mode folds each turn's steps into one assistant block; other
    // modes restore per-step spacing.
    for (const turn of assistantSteps.keys()) applyTurnFolding(turn)
    appendNotice(toolsVisibility === 'hidden' ? 'Tool cards hidden.' : `Tool and context cards ${toolsVisibility}.`)
  }

  const toggleTools = (): void => {
    // The cycle order puts the two common reading modes adjacent: preview ->
    // full detail -> conversation-only, then back to the preview default.
    setToolsVisibility(toolsVisibility === 'collapsed' ? 'expanded'
      : toolsVisibility === 'expanded' ? 'hidden' : 'collapsed')
  }

  const setReasoning = (show: boolean, announce = true): void => {
    showReasoning = show
    const activeStreaming = streaming
    rebuildTranscript(false)
    /* v8 ignore next -- the non-streaming command path is covered; this branch preserves an active stream across rebuild. */
    if (activeStreaming !== undefined) {
      streaming = activeStreaming
      streaming.setShowReasoning(showReasoning)
      registerAssistantStep(activeStreaming)
      chat.addChild(activeStreaming)
      chat.addChild(activeStreaming.timing)
    }
    if (announce) appendNotice(`Reasoning blocks ${showReasoning ? 'shown' : 'hidden'}.`)
    else requestRender()
  }

  /** Apply one committed live-settings snapshot to this mounted channel. */
  const applyUserSettings = (next: TuiUserSettings): void => {
    userSettings = next
    if (next.showReasoning !== showReasoning) setReasoning(next.showReasoning, false)
    else requestRender()
  }

  // The selector and the argument grammar mutate the same closure state the
  // Ctrl+O cycle drives for tool cards, so every entry converges.
  let detailsOverlay: TuiOverlaySession | undefined
  const showDetailsSelector = (): void => {
    void detailsOverlay?.close()
    const session = overlayManager.open({
      create: () => new DetailsDialog(
        toolsVisibility,
        showReasoning,
        palette,
        // Each Tab applies immediately; one dimension changes per call.
        (selection: DetailsSelection) => {
          if (selection.showReasoning !== showReasoning) setReasoning(selection.showReasoning)
          if (selection.visibility !== toolsVisibility) setToolsVisibility(selection.visibility)
        },
        () => { void session.close() },
      ),
      options: { width: resolved.detailsDialogWidth, anchor: 'center', margin: 1 },
    })
    detailsOverlay = session
    void session.closed.then(() => {
      if (detailsOverlay === session) detailsOverlay = undefined
    })
    requestRender()
  }

  // `/details` names the same transcript-detail state the Ctrl+O cycle mutates
  // and remains the explicit reasoning-block display control.
  const runDetails = (rawInput: string): CommandResult => {
    const tokens = rawInput.split(/\s+/u).filter(token => token !== '')
    if (tokens.length === 0) {
      showDetailsSelector()
      return { kind: 'success' }
    }
    let visibility: ToolCardVisibility | undefined
    let reasoning: boolean | undefined
    for (let token = tokens.shift(); token !== undefined; token = tokens.shift()) {
      if (token === 'collapsed' || token === 'expanded' || token === 'hidden') {
        visibility = token
      } else if (token === 'reasoning') {
        const value = tokens[0]
        if (value === 'on' || value === 'off') {
          tokens.shift()
          reasoning = value === 'on'
        } else {
          reasoning = !showReasoning
        }
      } else {
        return { kind: 'error', text: `Unknown /details argument "${token}". Usage: /details [collapsed|expanded|hidden] [reasoning [on|off]]` }
      }
    }
    // Reasoning first: its transcript rebuild would drop the visibility notice.
    if (reasoning !== undefined) setReasoning(reasoning)
    if (visibility !== undefined) setToolsVisibility(visibility)
    return { kind: 'success' }
  }

  let settingsOverlay: TuiOverlaySession | undefined
  const showSettingsSelector = (): void => {
    void settingsOverlay?.close()
    const current = runtime.readSettings?.() ?? userSettings
    applyUserSettings(current)
    const session = overlayManager.open({
      create: () => new SettingsDialog(
        current,
        palette,
        (patch) => {
          if (runtime.updateSettings === undefined) {
            return Promise.reject(new Error('this runtime has no writable user-settings service'))
          }
          return runtime.updateSettings(patch)
        },
        applyUserSettings,
        () => { void session.close() },
        () => { requestRender() },
      ),
      options: { width: resolved.settingsDialogWidth, anchor: 'center', margin: 1 },
    })
    settingsOverlay = session
    void session.closed.then(() => {
      if (settingsOverlay === session) settingsOverlay = undefined
    })
    requestRender()
  }

  let loginOverlay: TuiOverlaySession | undefined
  /** Open a write-only DeepSeek token prompt; the secret never enters prompt or command history. */
  const showLogin = async (): Promise<CommandResult> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      return { kind: 'error', text: 'Credential storage is unavailable in this runtime.' }
    }
    const ref = credentialRef('DEEPSEEK_API_KEY')
    const info = await credentials.describe(ref)
    if (!info.writable) {
      return {
        kind: 'error',
        text: 'DEEPSEEK_API_KEY comes from the launching environment. Close DSH, remove that temporary environment variable, restart DSH, then run /login to save it permanently.',
      }
    }
    void loginOverlay?.close()
    const readClipboardText = runtime.readClipboardText
    const session = overlayManager.open({
      create: host => new CredentialLoginDialog(
        info.configured,
        info.source,
        palette,
        async (value) => {
          await credentials.set(ref, value)
          host.close()
          appendNotice('DeepSeek API token saved permanently for future sessions.')
        },
        () => { host.close() },
        () => { host.invalidate() },
        readClipboardText === undefined
          ? undefined
          : async () => await readClipboardText({
            signal: host.signal,
            maxBytes: 16_384,
            cwd,
          }),
      ),
      options: { width: 72, anchor: 'center', margin: 1 },
    })
    loginOverlay = session
    void session.closed.then(() => {
      if (loginOverlay === session) loginOverlay = undefined
    })
    requestRender()
    return { kind: 'success' }
  }

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    const skillLines = skillCommands.map(command =>
      `/${command.name} [instructions] — ${command.description}`,
    )
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Keyboard shortcuts')), 0, 0))
    chat.addChild(new Text([
      'Enter send • Shift/Alt+Enter newline • Up/Down prompt history • Ctrl+V/Alt+V paste clipboard image',
      'Shift+Tab/Alt+M cycle modes • Alt+P choose model • Alt+T toggle thinking',
      'Esc cancel turn • Ctrl+G / Ctrl+X Ctrl+E external editor • Ctrl+T toggle task checklist',
      'Ctrl+X Ctrl+K twice within 3s stop all running background subagents',
      'Ctrl+S stash/restore prompt',
      'Mouse wheel scroll transcript · double right-click paste the last DSH selection · Ctrl+End jump to latest',
      'Ctrl+O cycle cards (collapse/expand/hide) • Ctrl+R search history • Ctrl+L redraw; press twice to /clear',
      'Ctrl+B background foreground shell • Ctrl+C cancel/clear; press twice on empty input to exit',
      'Ctrl+D delete forward while editing; press twice on empty input to exit • ? on empty input opens shortcut help',
      '',
      '! <command> • stream a shell command directly, then send its result to the model',
      ...commandLines,
      '/skill:<name> [instructions] — load a skill into the conversation',
      ...skillLines,
    ].map(line => palette.dim(line)).join('\n'), 0, 0))
    requestRender()
  }

  const showSkills = (): CommandResult => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Available skills')), 0, 0))
    chat.addChild(new Text(skillCommands.length === 0
      ? palette.dim('No user-invocable skills discovered yet. Skill roots may still be loading.')
      : skillCommands.map((command) => {
        const hint = command.argumentHint ?? ''
        const description = command.description ?? 'Load this skill into the conversation'
        return `${palette.accent(`/${command.name}`)} ${palette.dim(hint)}\n  ${palette.dim(description)}`
      }).join('\n'), 0, 0))
    requestRender()
    return { kind: 'success' }
  }

  /** Render the current agent-owned background-job lifecycle as transcript rows. */
  const showTasks = (): void => {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      appendNotice('Background tasks are unavailable because this runtime has no jobs registry.', 'warning')
      return
    }
    const snapshots = jobs.list(agent)
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Background tasks')), 0, 0))
    chat.addChild(new Text(snapshots.length === 0
      ? palette.dim('No background tasks.')
      : snapshots.map((snapshot) => {
        const detail = snapshot.detail === undefined ? '' : ` · ${snapshot.detail}`
        return displayText(`${snapshot.id} · ${snapshot.status} · ${snapshot.label}${detail}`)
      }).join('\n'), 0, 0))
    requestRender()
  }

  /** Render the redacted MCP connection directory without exposing config secrets. */
  const showMcp = (rawInput: string): CommandResult => {
    const directory = ctx.get('mcpConnections')
    if (directory === undefined) {
      return { kind: 'error', text: 'MCP status is unavailable because this runtime has no MCP connection directory.' }
    }
    const argument = rawInput.trim()
    if (argument === 'reload') {
      runReload()
      return { kind: 'success' }
    }
    const snapshots = directory.snapshot()
    const selected = argument === ''
      ? undefined
      : snapshots.find(snapshot => snapshot.serverName === argument)
    if (argument !== '' && selected === undefined) {
      return { kind: 'error', text: `Unknown MCP server: ${displayInlineText(argument)}. Run /mcp to list configured servers.` }
    }
    chat.addChild(new Spacer(1))
    if (selected !== undefined) {
      renderMcpDetail(selected)
    } else {
      chat.addChild(new Text(palette.bold(palette.accent('MCP servers')), 0, 0))
      chat.addChild(new Text(snapshots.length === 0
        ? palette.dim('No MCP servers are configured. Add an mcp-client row to cordis.yml, then run /mcp reload.')
        : snapshots.map(renderMcpSummary).join('\n'), 0, 0))
    }
    requestRender()
    return { kind: 'success' }
  }

  const renderMcpSummary = (snapshot: McpConnectionSnapshot): string => {
    const tools = renderMcpTools(snapshot.toolNames)
    const reconnect = snapshot.reconnectAttempt === undefined ? '' : ` Â· attempt ${String(snapshot.reconnectAttempt)}`
    return displayText([
      displayInlineText(snapshot.serverName),
      snapshot.state,
      snapshot.transport,
      `${String(snapshot.toolNames.length)} tool${snapshot.toolNames.length === 1 ? '' : 's'}${reconnect}`,
      tools,
    ].join(' Â· '))
  }

  const renderMcpDetail = (snapshot: McpConnectionSnapshot): void => {
    const reconnect = snapshot.reconnectAttempt === undefined
      ? snapshot.state
      : `${snapshot.state} (attempt ${String(snapshot.reconnectAttempt)})`
    chat.addChild(new Text(
      palette.bold(palette.accent(`MCP server ${displayInlineText(snapshot.serverName)}`)),
      0,
      0,
    ))
    chat.addChild(new Text(displayText([
      `State: ${reconnect}`,
      `Transport: ${snapshot.transport}`,
      `Tools (${String(snapshot.toolNames.length)}): ${renderMcpTools(snapshot.toolNames)}`,
    ].join('\n')), 0, 0))
  }

  const renderMcpTools = (toolNames: readonly string[]): string => {
    if (toolNames.length === 0) return '(none)'
    const visible = toolNames.slice(0, MAX_MCP_DISPLAY_TOOLS).map(displayInlineText)
    const hidden = toolNames.length - visible.length
    return hidden === 0 ? visible.join(', ') : `${visible.join(', ')}, +${String(hidden)} more`
  }

  /** Split one `/agents` invocation into its verb and unmodified trailing argument. */
  const splitAgentsInput = (rawInput: string): { readonly verb: string; readonly rest: string } => {
    const input = rawInput.trim()
    const separator = input.search(/\s/u)
    if (separator === -1) return { verb: input, rest: '' }
    return { verb: input.slice(0, separator), rest: input.slice(separator).trim() }
  }

  /** Narrow one durable listing entry to a controllable child rather than a diagnostic row. */
  const isSubagentChild = (entry: SubagentListEntry): entry is SubagentChildEntry => entry.kind === 'child'

  /** Render the durable subagent tree without loading child transcripts or prompts. */
  const renderAgentTreeEntry = (entry: SubagentDescendantListEntry): string => {
    const indent = '  '.repeat(Math.max(0, entry.depth - 1))
    const id = displayInlineText(entry.id)
    if (entry.kind === 'diagnostic') return `${indent}${id} Â· unavailable (${entry.reason})`
    const residency = entry.activity === 'running' ? 'live' : 'stored'
    const label = displayInlineText(entry.label ?? '(unlabeled)')
    return `${indent}${id} Â· ${entry.mode} Â· ${residency} Â· ${label}${entry.hasChildren ? ' Â· children' : ''}`
  }

  /** Render the terminal-only durable subagent directory and its direct-control hint. */
  const renderAgentDirectory = (entries: readonly SubagentDescendantListEntry[]): void => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Subagents')), 0, 0))
    chat.addChild(new Text(entries.length === 0
      ? palette.dim('No durable subagents. Start one with /agents start <task>.')
      : entries.map(renderAgentTreeEntry).join('\n'), 0, 0))
    if (entries.length > 0) {
      chat.addChild(new Text(
        palette.dim('Direct continuable children: /agents send <id> <message> Â· /agents stop <id>'),
        0,
        0,
      ))
    }
  }

  /** Find one direct child by durable id without giving a human command descendant authority. */
  const findDirectSubagent = async (
    id: string,
    signal: AbortSignal,
  ): Promise<SubagentChildEntry | undefined> => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return undefined
    return (await subagents.listChildren(agent.session.id, signal))
      .filter(isSubagentChild)
      .find(entry => entry.id === SessionId(id))
  }

  /** Manage durable continuable subagents through a direct-human terminal control plane. */
  const showAgents = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) {
      return { kind: 'error', text: 'Subagents are unavailable because this runtime has no subagent service.' }
    }
    const { verb, rest } = splitAgentsInput(rawInput)
    if (verb === '') {
      const entries = await subagents.listDescendants(agent.session.id, signal)
      renderAgentDirectory(entries)
      requestRender()
      return { kind: 'success' }
    }
    if (verb === 'start') {
      if (rest === '') return { kind: 'error', text: 'Usage: /agents start <task>' }
      const provider = subagents.getProvider('spawn')
      if (provider?.prepareContinuable === undefined) {
        return {
          kind: 'error',
          text: 'Continuable subagents are unavailable because this runtime has no continuable "spawn" provider.',
        }
      }
      const selection = target.current
      const started = await subagents.startContinuable({
        provider: 'spawn',
        label: rest,
        request: {
          parent: agent,
          prompt: [{ type: 'text', text: rest }],
          ...selection === undefined
            ? {}
            : { agentOptions: { provider: selection.provider, model: selection.model } },
        },
        signal,
      })
      const childId = displayInlineText(started.childId)
      return {
        kind: 'success',
        text: `Started subagent ${childId}. Use /agents send ${childId} <message> to continue it.`,
      }
    }
    if (verb === 'send') {
      const { verb: childId, rest: message } = splitAgentsInput(rest)
      if (childId === '' || message === '') return { kind: 'error', text: 'Usage: /agents send <id> <message>' }
      const child = await findDirectSubagent(childId, signal)
      if (child === undefined) {
        return { kind: 'error', text: `No direct subagent named ${displayInlineText(childId)}.` }
      }
      if (child.mode !== 'continuable') {
        return { kind: 'error', text: `Subagent ${displayInlineText(child.id)} is a one-shot task; inspect it with /tasks.` }
      }
      await subagents.followup(
        agent,
        child.id,
        [{ type: 'text', text: message }],
        { source: { kind: 'user' }, signal },
      )
      return { kind: 'success', text: `Sent a follow-up to subagent ${displayInlineText(child.id)}.` }
    }
    if (verb === 'stop') {
      const { verb: childId, rest: extra } = splitAgentsInput(rest)
      if (childId === '' || extra !== '') return { kind: 'error', text: 'Usage: /agents stop <id>' }
      const child = await findDirectSubagent(childId, signal)
      if (child === undefined) {
        return { kind: 'error', text: `No direct subagent named ${displayInlineText(childId)}.` }
      }
      if (child.mode !== 'continuable') {
        return { kind: 'error', text: `Subagent ${displayInlineText(child.id)} is a one-shot task; inspect it with /tasks.` }
      }
      if (child.activity !== 'running') {
        return {
          kind: 'error',
          text: `Subagent ${displayInlineText(child.id)} is not live. Use /agents send ${displayInlineText(child.id)} <message> to resume it.`,
        }
      }
      subagents.interrupt(child.id, { kind: 'user', parentSessionId: agent.session.id })
      return {
        kind: 'success',
        text: `Stop requested for subagent ${displayInlineText(child.id)}; it may keep running until it observes cancellation.`,
      }
    }
    return {
      kind: 'error',
      text: 'Usage: /agents [start <task>|send <id> <message>|stop <id>]',
    }
  }

  const showPalette = (): void => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(
      renderPalette(palette, currentScheme, resolved.theme.color, resolved.theme.palette, resolved.theme.truecolor).join('\n'), 0, 0,
    ))
    requestRender()
  }

  const showContext = (raw: string): CommandResult => {
    const argument = raw.trim()
    if (argument !== '' && argument !== 'all') {
      return { kind: 'error', text: 'Usage: /context [all]' }
    }
    const measurement = ctx.tokenMeter.measure(agent.session)
    const breakdown = ctx.get('sessionProjections')
      ?.snapshot(agent.session).values.contextBreakdown
    const capacity = modelController.contextWindow()
    chat.addChild(new Spacer(1))
    chat.addChild(new StatusCardComponent(contextUsageGroups({
      measurement,
      ...capacity === undefined ? {} : { capacity },
      ...breakdown === undefined ? {} : { breakdown },
      events: agent.session.events,
      expanded: argument === 'all',
    }, palette), palette, 'Context usage'))
    requestRender()
    return { kind: 'success' }
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || '(empty)'
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || '(none)'
    const events = agent.session.events
    const latestActivity = agent.session.events.at(-1)?.time ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens))
    let context = `${formatDiagnosticNumber(usedContext)} used · capacity unknown`
    const contextWindow = modelController.contextWindow()
    if (contextWindow !== undefined) {
      const contextPercent = Math.round(usedContext / contextWindow * 100)
      context = `${diagnosticMeter(contextPercent, palette)} ${String(contextPercent)}% used (${formatDiagnosticNumber(usedContext)} / ${formatDiagnosticNumber(contextWindow)})`
    }
    const rate = cacheHitRate(tokens)
    const turns = events.filter(event => event.type === 'turn/start').length
    const steps = events.filter(event => event.type === 'step/start').length
    const toolCalls = events.filter(event => event.type === 'tool/call').length
    const model = target.current === undefined ? 'unset' : displayText(targetLabel(target.current))
    const effort = target.current === undefined
      ? 'unset'
      : target.current.reasoningEffort === undefined
        ? 'default'
        : displayText(target.current.reasoningEffort)
    const mode = modeController.current()
    const modeStatus = mode === undefined
      ? 'unavailable'
      : `${displayText(mode.label)}${mode.pending ? ' (pending)' : ''}`
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        ['Session', displayText(agent.session.id)],
        ['Title', displayText(sessionTitle ?? 'untitled')],
        ['Directory', displayText(cwd)],
        ['Model', `${model} ${palette.dim(`(effort ${effort}; reasoning blocks ${showReasoning ? 'shown' : 'hidden'})`)}`],
        ['Mode', modeStatus],
      ],
      [
        ['Agent', [
          agent.status,
          formatDiagnosticCount(events.length, 'event'),
          formatDiagnosticCount(turns, 'turn'),
          formatDiagnosticCount(steps, 'step'),
          formatDiagnosticCount(toolCalls, 'tool call'),
        ].join(' · ')],
      ],
      [
        ['Tokens', `${formatDiagnosticNumber(tokens.input)} input + ${formatDiagnosticNumber(tokens.output)} output`],
        ['KV cache', rate === undefined
          ? `n/a (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`
          : `${diagnosticMeter(rate, palette)} ${String(rate)}% hit (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`],
        ['Context', context],
      ],
      [
        ['Created', formatDiagnosticTime(agent.session.header.createdAt)],
        ['Active', formatDiagnosticTime(latestActivity)],
      ],
    ]
    const card = new StatusCardComponent(groups, palette)
    chat.addChild(new Spacer(1))
    chat.addChild(card)
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('System prompt')), 0, 0))
    chat.addChild(new Text(systemPrompt, 0, 0))
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Registered tools')), 0, 0))
    chat.addChild(new Text(registeredTools, 0, 0))
    requestRender()
  }

  // Skill listing is async while `createTuiChat` is synchronous, so the TUI
  // retains the last complete invocation-neutral catalog for synchronous
  // editor completion, filters it for user invocation, and refreshes it after
  // registry invalidation.
  const refreshCommandAutocomplete = (): void => {
    const base = new CombinedAutocompleteProvider(
      [
        ...ctx.commands.list(agent).map(command => ({
          name: command.name,
          description: command.description,
          ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
        })),
        ...skillCommands,
      ],
      agent.session.header.cwd ?? process.cwd(),
    )
    const sessionReferences = ctx.get('sessionReferenceResolver')
    editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(
      base,
      fileSearch,
      sessionReferences,
      agent,
      userShellHistory,
    ))
  }
  const refreshVisibleSlashAutocomplete = (): void => {
    const cursor = editor.getCursor()
    const textBeforeCursor = editor.getLines().slice(cursor.line, cursor.line + 1).join('').slice(0, cursor.col)
    if (cursor.line === 0 && textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')) {
      // pi-tui's provider setter closes an existing menu but does not query
      // the replacement for the current draft. Tab in a slash-name context
      // only requests suggestions, so it refreshes without editing the text.
      editor.handleInput('\t')
    }
  }
  const disposeCommandChanges = ctx.on('commands/change', refreshCommandAutocomplete)
  refreshCommandAutocomplete()

  const refreshSkillCommands = (service: SkillRegistry, resetRetry = true): void => {
    if (skillCommandRetry !== undefined) {
      clearTimeout(skillCommandRetry)
      skillCommandRetry = undefined
    }
    if (resetRetry) skillCommandRetryCount = 0
    const scan = ++skillCommandScan
    service.snapshot({ cwd, signal: skillAbort.signal, scope: agent }).then(
      (snapshot) => {
        if (disposed || scan !== skillCommandScan) return
        if (!snapshot.complete) {
          // Providers may still be warming their workspace catalog. An
          // incomplete observation is deliberately not cached and does not
          // necessarily emit another skills/change event, so retry it here.
          if (skillCommandRetryCount >= 8) return
          const delay = Math.min(2_000, 100 * 2 ** skillCommandRetryCount)
          skillCommandRetryCount += 1
          skillCommandRetry = setTimeout(() => {
            skillCommandRetry = undefined
            if (!disposed) refreshSkillCommands(service, false)
          }, delay)
          return
        }
        skillCommandRetryCount = 0
        const invocable = snapshot.skills.filter(skill => skill.invocation.userInvocable)
        // The argument-hint slot shows in the menu but is never inserted on
        // selection, so it carries the skill's scope instead of an
        // instructions placeholder. `SkillSource` is open-ended; every
        // non-project source (user, custom, bundled, runtime, …) collapses
        // to `(user)`.
        skillCommands = invocable.map(skill => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          argumentHint: skill.source.startsWith('project-') ? '(project)' : '(user)',
        }))
        refreshCommandAutocomplete()
        refreshVisibleSlashAutocomplete()
        requestRender()
      },
      () => {
        // Discovery failed or was aborted on dispose; keep the base slash
        // commands so autocomplete still works without skill entries.
      },
    )
  }
  const disposeSkillChanges = skills === undefined
    ? () => {}
    : ctx.on('skills/change', () => { refreshSkillCommands(skills) })
  if (skills !== undefined) refreshSkillCommands(skills)

  // The agent scope is minted by agent-loop and intentionally inherits only
  // that core plugin's dependencies. A child command producer declares its own
  // UI-service dependency while retaining the parent agent scope and lifetime.
  const commandFiber = agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'help',
      description: 'Show keyboard shortcuts and commands',
      handler: () => { showHelp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'skills',
      description: 'List available user-invocable skills',
      handler: () => showSkills(),
    })
    commandCtx.commands.register({
      name: 'model',
      description: 'Show or switch this session\'s model',
      input: { hint: '[[provider/]model]' },
      handler: ({ rawInput }) => {
        modelController.queueModelCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'effort',
      description: 'Show or set this session\'s reasoning effort',
      input: { hint: '[level|auto]' },
      handler: ({ rawInput }) => {
        modelController.queueEffortCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'clear',
      description: 'Start fresh, optionally naming the previous conversation',
      input: { hint: '[name]' },
      recordInput: false,
      handler: ({ rawInput }) => runClear(rawInput),
    })
    commandCtx.commands.register({
      name: 'workdir',
      description: 'Show or switch workspace in a fresh session',
      input: { hint: '[path]' },
      recordInput: false,
      handler: async ({ rawInput }) => await runWorkdir(rawInput),
    })
    commandCtx.commands.register({
      name: 'mode',
      description: 'Show or switch Minimal / Router tool routing',
      input: { hint: '[minimal|router|spec]' },
      recordInput: false,
      handler: ({ rawInput }) => runMode(rawInput),
    })
    commandCtx.commands.register({
      name: 'cd',
      description: 'Alias for /workdir',
      input: { hint: '[path]' },
      recordInput: false,
      handler: async ({ rawInput }) => await runWorkdir(rawInput),
    })
    for (const alias of ['new', 'reset'] as const) {
      commandCtx.commands.register({
        name: alias,
        description: 'Alias for /clear: start fresh and optionally name the previous conversation',
        input: { hint: '[name]' },
        recordInput: false,
        handler: ({ rawInput }) => runClear(rawInput),
      })
    }
    commandCtx.commands.register({
      name: 'rename',
      description: 'Rename this session, or regenerate its name from conversation history',
      input: { hint: '[name]' },
      recordInput: false,
      handler: ({ rawInput, signal }) => runRename(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'config',
      description: 'Edit live TUI settings',
      handler: () => { showSettingsSelector(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'login',
      description: 'Securely save or replace the DeepSeek API token',
      recordInput: false,
      handler: async () => await showLogin(),
    })
    commandCtx.commands.register({
      name: 'copy',
      description: 'Copy the latest or Nth latest assistant response',
      input: { hint: '[N]' },
      handler: ({ rawInput, signal }) => runCopy(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'export',
      description: 'Export the current conversation as plain text',
      input: { hint: '[filename]' },
      handler: ({ rawInput, signal }) => runExport(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'diff',
      description: 'View uncommitted workspace changes',
      handler: ({ signal }) => runDiff(signal),
    })
    commandCtx.commands.register({
      name: 'checkpoint',
      description: 'Create a reversible workspace and conversation checkpoint',
      input: { hint: '[label]' },
      handler: ({ rawInput, commandId, signal }) => runCheckpoint(rawInput, commandId, signal),
    })
    commandCtx.commands.register({
      name: 'rewind',
      description: 'Restore a checkpointed workspace and/or branch the conversation',
      input: { hint: '[checkpoint-id]' },
      handler: ({ rawInput, commandId, signal }) => runRewind(rawInput, commandId, signal),
    })
    commandCtx.commands.register({
      name: 'context',
      description: 'Visualize current context pressure and composition',
      input: { hint: '[all]' },
      handler: ({ rawInput }) => showContext(rawInput),
    })
    commandCtx.commands.register({
      name: 'details',
      description: 'Select tool-card visibility and reasoning display',
      input: { hint: '[collapsed|expanded|hidden] [reasoning [on|off]]' },
      handler: ({ rawInput }) => runDetails(rawInput),
    })
    commandCtx.commands.register({
      name: 'palette',
      description: 'Show every color and attribute role this terminal renders',
      handler: () => { showPalette(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'reload',
      description: 'EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)',
      handler: () => { runReload(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'resume',
      description: 'Resume by exact id/title, or open the session picker',
      input: { hint: '[session]' },
      handler: ({ rawInput, signal }) => runResume(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'continue',
      description: 'Alias for /resume: resume by exact id/title or open the picker',
      input: { hint: '[session]' },
      handler: ({ rawInput, signal }) => runResume(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'status',
      description: 'Show session diagnostics, system prompt, and registered tools',
      handler: async ({ signal }) => { await showStatus(signal); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'tasks',
      description: 'Show background shell and delegated-task lifecycle',
      handler: () => { showTasks(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'mcp',
      description: 'Show MCP server connection status and public tools',
      input: { hint: '[server|reload]' },
      handler: ({ rawInput }) => showMcp(rawInput),
    })
    commandCtx.commands.register({
      name: 'agents',
      description: 'List and manage durable continuable subagents',
      input: { hint: '[start <task>|send <id> <message>|stop <id>]' },
      handler: async ({ rawInput, signal }) => await showAgents(rawInput, signal),
    })
    const exitHandler = (): CommandResult => {
      requestExit()
      return { kind: 'success' }
    }
    commandCtx.commands.register({
      name: 'exit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
    commandCtx.commands.register({
      name: 'quit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
  })
  const fileReferencePromptFiber = agent.ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ui:tui-file-reference',
      order: 99,
      // Tool visibility can change dynamically or by agent scope. Empty
      // sections are omitted by renderPrompt, so guidance never names a tool
      // that this agent cannot call.
      text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
    })
  })

  const runCommand = (text: string): void => {
    const controller = new AbortController()
    commandControllers.add(controller)
    void ctx.commands.execute(agent, text, controller.signal).then(
      (execution) => {
        if (disposed) return
        if (execution === undefined) {
          appendNotice(`Unknown command: ${text}`, 'warning')
        } else if (execution.result.text !== undefined && execution.result.text !== '') {
          appendNotice(execution.result.text, execution.result.kind === 'error' ? 'error' : 'info')
        }
      },
      (error: unknown) => {
        if (!disposed) {
          appendNotice(`Command failed: ${errorChain(error)}`, 'error')
        }
      },
    ).finally(() => { commandControllers.delete(controller) })
  }

  /** Route one already-identified user-role message through the live agent state. */
  const dispatchUserMessage = (message: UserMessage, attachedContext?: UserMessage): void => {
    if (disposed) {
      appendNotice(`Agent "${agent.id}" is disposed.`, 'error')
      return
    }
    if (agent.status === 'running') {
      // Steering is never subject to prompt admission; an attached snapshot
      // drains beside it at the same step boundary through the outbox.
      if (attachedContext !== undefined) {
        agent.inject(attachedContext)
      }
      agent.steer(message)
      pendingSteering.add(message.id)
      refreshStatus()
      return
    }
    if (attachedContext === undefined) {
      agent.followup(message)
      return
    }
    // Idle: the snapshot rides the prompt's admission transaction so a
    // blocking hook discards both together.
    let cleanedUp = false
    const acceptedId = message.id
    const discarded = new Set<MessageId>()
    const cleanup = (): void => {
      // Every completion path detaches both listeners. Keep this
      // idempotent so later cleanup paths cannot double-release them.
      /* v8 ignore next -- unreachable idempotence guard, see above */
      if (cleanedUp) return
      cleanedUp = true
      detachSubmit()
      detachDiscard()
    }
    // Prepended so this wrapper is outermost: it observes the exact accepted
    // message identity whether a downstream hook allows or blocks, then detaches.
    const detachSubmit = ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
      if (subject !== agent || !messages.some(submitted => submitted.id === message.id)) return next()
      cleanup()
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // The attached snapshot enters the step beside the accepted message.
      return { kind: 'enter', messages: [...decision.messages, attachedContext] }
    }, { prepend: true })
    // Installed before followup(): an enqueue listener can synchronously
    // cancel and discard before followup() returns its id.
    const detachDiscard = ctx.on('agent/inbox/discarded', ({ agent: subject, message: item }) => {
      if (subject !== agent) return
      discarded.add(item.id)
      if (discarded.has(acceptedId)) cleanup()
    })
    // followup() accepts any typed input and contains listener failures;
    // this guards a future synchronous throw so the wrapper cannot leak.
    /* v8 ignore start -- future-proofing guard, see above */
    try {
      agent.followup(message)
      if (discarded.has(acceptedId)) cleanup()
    } catch (error: unknown) {
      cleanup()
      throw error
    }
    /* v8 ignore stop */
  }

  /** Create and route one ordinary human submission. */
  const dispatchMessage = (content: ContentBlock[], attachedContext?: UserMessage): void => {
    dispatchUserMessage(createUserMessage({ content, source: { kind: 'user' } }), attachedContext)
  }

  /** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
  const deliver = (payload: string): void => {
    dispatchMessage([{ type: 'text', text: payload }])
  }

  /**
   * Execute one explicit `!` command through the deployment's shell seam.
   *
   * This is user-authorized execution, so it does not impersonate a model tool
   * call or enter the tool-approval pipeline. A confining executor still gets
   * the session's standing sandbox policy, and the shared managed environment
   * registry receives a public execution input with the real calling agent.
   */
  const startUserShell = (command: string, shell: ShellExecutor): void => {
    const controller = new AbortController()
    let processHandle: ShellProcess | undefined
    let operation: UserShellOperation | undefined
    try {
      const callId = CallId(`user-shell:${randomUUID()}`)
      const execution = {
        callId,
        name: USER_SHELL_PLUGIN,
        arguments: { command },
        agent,
        signal: controller.signal,
      }
      const dshEnv = ctx.get('shellEnv')?.collect(execution)
      const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      processHandle = shell.start(shell.resolve({
        command,
        workdir: cwd,
        signal: controller.signal,
        ...dshEnv === undefined ? {} : { dshEnv },
        ...sandboxPolicy === undefined ? {} : { sandboxPolicy },
      }))
      const spacer = new Spacer(1)
      const view = new Text('', 0, 0)
      const output = new UserShellProcessController(processHandle, {
        maxOutputBytes: resolved.directShellOutputMaxBytes,
        refreshMs: resolved.directShellOutputRefreshMs,
        onOutput: (snapshot) => {
          if (operation?.mode === 'foreground' && !disposed) renderUserShellView(operation, snapshot)
        },
      })
      operation = {
        command,
        abort: controller,
        process: processHandle,
        output,
        spacer,
        view,
        mode: 'foreground',
        cancelledByUser: false,
      }
      foregroundShell = operation
      editor.disableSubmit = true
      chat.addChild(spacer)
      chat.addChild(view)
      renderUserShellView(operation, output.snapshot())
    } catch (error: unknown) {
      if (!controller.signal.aborted) controller.abort(new Error('Direct shell startup failed'))
      processHandle?.kill()
      appendNotice(`Shell command failed: ${errorChain(error)}`, 'error')
      return
    }

    const running = operation
    void running.output.done.then((result) => {
      if (disposed) return
      if (foregroundShell === running) {
        removeUserShellView(running)
        foregroundShell = undefined
        editor.disableSubmit = false
      }
      if (running.cancelledByUser) {
        appendNotice(`Shell command cancelled: $ ${displayInlineText(command)}`, 'warning')
        return
      }
      // The result is plugin-sourced durable context rather than a synthetic
      // tool result: no model-issued call id exists. Routing at completion lets
      // a command submitted during a turn join the nearest later step.
      dispatchUserMessage(createUserShellResultMessage(command, cwd, result))
    }, (error: unknown) => {
      if (disposed) return
      if (foregroundShell === running) {
        removeUserShellView(running)
        foregroundShell = undefined
        editor.disableSubmit = false
      }
      if (running.cancelledByUser) {
        appendNotice(`Shell command cancelled: $ ${displayInlineText(command)}`, 'warning')
      } else {
        appendNotice(`Shell command failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      requestRender()
    })
  }

  /** Transfer the attached process to the shared jobs registry after its preflight succeeds. */
  const backgroundUserShell = (): void => {
    const operation = foregroundShell
    if (operation === undefined) return
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      appendNotice('Cannot background this shell command because this runtime has no jobs registry.', 'warning')
      return
    }
    try {
      const jobId = jobs.start({
        kind: 'bash',
        label: operation.command,
        outputLimitBytes: resolved.directShellOutputMaxBytes,
        completionDelivery: 'producer',
        owner: agent,
        run: () => ({
          cancel: (reason?: string) => {
            if (!operation.abort.signal.aborted) {
              operation.abort.abort(new Error(reason ?? 'Background shell command cancelled'))
            }
            operation.process.kill()
          },
          done: operation.output.done.then(
            userShellJobOutcome,
            (error: unknown) => ({ status: 'failed' as const, detail: errorChain(error) }),
          ),
          readOutput: () => operation.output.readJobOutput(),
        }),
      })
      operation.mode = 'background'
      operation.jobId = String(jobId)
      foregroundShell = undefined
      editor.disableSubmit = false
      removeUserShellView(operation)
      appendNotice(`Shell moved to background as ${jobId}: $ ${displayInlineText(operation.command)}`)
    } catch (error: unknown) {
      appendNotice(`Could not background shell command: ${errorChain(error)}`, 'warning')
    }
  }

  /** Load a manually invoked skill and deliver its rendered body as a user turn, reporting lookup outcomes as notices. */
  const invokeSkill = (name: string, instructions: string): void => {
    if (skills === undefined) {
      appendNotice('Skills are not available in this session.', 'warning')
      return
    }
    const lookup = { cwd, signal: skillAbort.signal }
    const reportFailure = (error: unknown): void => {
      if (disposed) return
      appendNotice(`Skill "${name}" failed to load: ${errorChain(error)}`, 'error')
    }
    skills.list(lookup).then(
      (summaries) => {
        if (disposed) return
        const summary = summaries.find(skill => skill.name === name)
        if (summary === undefined) {
          appendNotice(`Unknown skill: ${name}`, 'warning')
          return
        }
        if (!summary.invocation.userInvocable) {
          appendNotice(`Skill "${name}" is not available for user invocation.`, 'warning')
          return
        }
        skills.get(name, lookup).then(
          (skill) => {
            if (disposed) return
            if (skill === undefined) {
              appendNotice(`Unknown skill: ${name}`, 'warning')
              return
            }
            if (!skill.invocation.userInvocable) {
              appendNotice(`Skill "${name}" is not available for user invocation.`, 'warning')
              return
            }
            deliver(renderSkillInvocation(skill, instructions))
          },
          reportFailure,
        )
      },
      reportFailure,
    )
  }

  // EXPERIMENTAL, dev-only: manually re-read every file-backed loader config
  // tree and apply the diff to the running app — the same path the HMR
  // watcher's config-change branch drives, minus the watcher. Useful when the
  // watcher misses an edit (replace-by-rename saves) or HMR is not mounted.
  // Module-source hot reload stays watcher-owned; this refreshes configs only.
  let reloadInFlight = false
  const runReload = (): void => {
    // Idle-only: a reload can dispose and re-mount entries mid-flight; doing
    // that under an active turn could tear tools or the adapter out from
    // under in-flight calls. Idleness is advisory (a send can race in after
    // the check), but it removes the common footgun.
    if (agent.status !== 'idle') {
      appendNotice(`/reload requires an idle agent (status: ${agent.status}).`, 'warning')
      return
    }
    // Re-entrancy guard: concurrent refreshes over a genuinely changed file
    // would race unmutexed tree updates (create/remove interleaving); one
    // reload at a time keeps the update pass single-writer.
    if (reloadInFlight) {
      appendNotice('A config reload is already running.', 'warning')
      return
    }

    // Optional-service lookup: the TUI must not depend on the Loader (tests
    // and embedders run without one), so `loader` stays out of `inject` and
    // is read through the non-throwing `ctx.get` accessor — a bare `ctx.loader`
    // proxy read would throw `cannot get property without inject` in a fiber.
    const loader = ctx.get('loader') as { entries(): Iterable<{ subtree?: { refresh?(): Promise<void> } }> } | undefined
    if (loader === undefined) {
      appendNotice('/reload needs the cordis Loader; this runtime has none.', 'warning')
      return
    }
    const refreshes: Promise<void>[] = []
    for (const entry of loader.entries()) {
      if (entry.subtree?.refresh !== undefined) refreshes.push(entry.subtree.refresh())
    }
    reloadInFlight = true
    appendNotice(`Reloading ${refreshes.length} config tree(s)… (experimental)`)
    // refresh() never rejects (it warns and keeps the running tree), so the
    // join can only fulfill; the catch arm guards a future contract change.
    void Promise.all(refreshes).then(() => {
      appendNotice('Config reload complete. Unchanged files were skipped; invalid files keep the running tree (see logs).')
    }).catch((error: unknown) => {
      appendNotice(`Config reload failed: ${errorChain(error)}`, 'error')
    }).finally(() => {
      reloadInFlight = false
    })
  }

  const rememberInput = (text: string): void => {
    editor.addToHistory(text)
    promptHistory.record(text)
  }

  /** Read one desktop image into the draft without persisting its bytes. */
  const pasteClipboardImage = (): void => {
    if (transferOperation !== undefined) return
    const readClipboardImage = runtime.readClipboardImage
    if (readClipboardImage === undefined) {
      appendNotice('Clipboard image input is unavailable because this runtime has no clipboard reader.', 'warning')
      return
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      appendNotice('Clipboard image input is unavailable because no attachment store is mounted.', 'warning')
      return
    }
    clipboardImages.pruneUnreferenced([
      editor.getText(),
      ...(stashedEditorDraft === undefined ? [] : [stashedEditorDraft.text]),
    ])
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`clipboard image read timed out after ${String(CLIPBOARD_IMAGE_TIMEOUT_MS)}ms`))
    }, CLIPBOARD_IMAGE_TIMEOUT_MS)
    const restoreSubmitDisabled = editor.disableSubmit
    transferControllers.add(controller)
    transferOperation = 'reading'
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    void readClipboardImage({
      signal: controller.signal,
      maxBytes: Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes),
      cwd,
    }).then((image) => {
      if (disposed || controller.signal.aborted) return
      if (image === undefined) {
        appendNotice('No image found in the clipboard.', 'warning')
        return
      }
      const refusal = clipboardImages.intakeError(editor.getText(), image, attachments.imageLimits)
      if (refusal !== undefined) {
        appendNotice(refusal, 'warning')
        return
      }
      editor.insertTextAtCursor(clipboardImages.add(image))
      requestRender()
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        appendNotice(`Clipboard image failed: ${errorChain(error)}`, 'error')
      } else if (!disposed && controller.signal.reason instanceof Error
        && controller.signal.reason.message.startsWith('clipboard image read timed out')) {
        appendNotice(`Clipboard image failed: ${controller.signal.reason.message}`, 'error')
      }
    }).finally(() => {
      clearTimeout(timeout)
      transferControllers.delete(controller)
      if (disposed) return
      transferOperation = undefined
      editor.disableSubmit = restoreSubmitDisabled
      updateEditorHint()
      requestRender()
    })
  }

  /** Resolve references, validate/save images, and dispatch one frozen draft. */
  const submitClipboardPrompt = (
    value: string,
    historyText: string,
    parsed: ReturnType<typeof parseSessionReferenceText>,
  ): void => {
    const restoreDraft = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      restoreDraft()
      appendNotice('Cannot send clipboard images because no attachment store is mounted.', 'error')
      return
    }
    const selection = target.current
    const llm = ctx.get('llm')
    if (selection === undefined || llm === undefined) {
      restoreDraft()
      appendNotice('Cannot send clipboard images because the current model route is unresolved.', 'error')
      return
    }
    const sessionReferences = parsed.references.length === 0 ? undefined : ctx.get('sessionReferenceResolver')
    if (parsed.references.length > 0 && sessionReferences === undefined) {
      restoreDraft()
      appendNotice('Session reference capability unavailable.', 'error')
      return
    }
    const controller = new AbortController()
    const restoreSubmitDisabled = editor.disableSubmit
    transferControllers.add(controller)
    transferOperation = 'admitting'
    editor.disableSubmit = true
    updateEditorHint()
    requestRender()
    void (async () => {
      const modelInfo = await llm.resolveModelInfo(selection.provider, selection.model, controller.signal)
      if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
        throw new Error(`Model "${selection.model}" does not support image input.`)
      }
      const prepared = sessionReferences === undefined
        ? { content: [{ type: 'text' as const, text: parsed.text }] }
        : await sessionReferences.prepare(
          agent,
          [{ type: 'text', text: parsed.text }],
          parsed.references,
          controller.signal,
        )
      const content = await clipboardImages.materialize(prepared.content, attachments)
      if (disposed || controller.signal.aborted) return
      rememberInput(historyText)
      if (editor.getText() === value) editor.setText('')
      dispatchMessage(content, prepared.additionalContext)
    })().catch((error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreDraft()
        appendNotice(`Clipboard image send failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      transferControllers.delete(controller)
      if (disposed) return
      transferOperation = undefined
      editor.disableSubmit = restoreSubmitDisabled
      updateEditorHint()
      requestRender()
    })
  }

  editor.onSubmit = (value: string) => {
    const text = value.trim()
    if (text === '') return
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    const userShellCommand = parseUserShellInput(value)
    const hasClipboardImages = clipboardImages.hasImages(value)
    if (hasClipboardImages && (
      userShellCommand !== undefined
      || text.startsWith(SKILL_COMMAND_PREFIX)
      || value.startsWith('/')
    )) {
      restoreSubmittedInput()
      appendNotice('Clipboard images can accompany ordinary prompts, not shell, skill, or slash commands.', 'warning')
      return
    }
    if (userShellCommand !== undefined) {
      if (userShellCommand === '') {
        restoreSubmittedInput()
        appendNotice('Usage: ! <command>', 'warning')
        return
      }
      if (foregroundShell !== undefined) {
        restoreSubmittedInput()
        appendNotice('A foreground shell command is already running; use Ctrl+B to background it, Ctrl+C to cancel it, or wait for it to finish.', 'warning')
        return
      }
      const shell = ctx.get('shell')
      if (shell === undefined) {
        restoreSubmittedInput()
        appendNotice('Shell mode is unavailable because this runtime has no shell executor.', 'warning')
        return
      }
      rememberInput(text)
      userShellHistory.record(userShellCommand, now())
      editor.setText('')
      startUserShell(userShellCommand, shell)
      return
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      rememberInput(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice('Usage: /skill:<name> [instructions]', 'warning')
      else invokeSkill(skillName, instructions)
      return
    }
    if (value.startsWith('/')) {
      rememberInput(text)
      editor.setText('')
      runCommand(value)
      return
    }
    let parsed: ReturnType<typeof parseSessionReferenceText>
    try {
      parsed = parseSessionReferenceText(text)
    } catch (error: unknown) {
      restoreSubmittedInput()
      appendNotice(`Invalid session reference: ${errorChain(error)}`, 'error')
      return
    }
    if (hasClipboardImages) {
      submitClipboardPrompt(value, text, parsed)
      return
    }
    if (parsed.references.length === 0) {
      rememberInput(text)
      editor.setText('')
      dispatchMessage([{ type: 'text', text: parsed.text }])
      return
    }
    const sessionReferences = ctx.get('sessionReferenceResolver')
    if (sessionReferences === undefined) {
      restoreSubmittedInput()
      appendNotice('Session reference capability unavailable.', 'error')
      return
    }
    const controller = new AbortController()
    referenceControllers.add(controller)
    editor.disableSubmit = true
    void sessionReferences.prepare(
      agent,
      [{ type: 'text', text: parsed.text }],
      parsed.references,
      controller.signal,
    ).then((prepared) => {
      if (disposed) return
      rememberInput(text)
      if (editor.getText() === value) editor.setText('')
      // The snapshot travels with the prompt so a blocking admission hook
      // discards them together — see dispatchMessage's attached-context path.
      dispatchMessage(prepared.content, prepared.additionalContext)
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreSubmittedInput()
        appendNotice(`Session reference failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      referenceControllers.delete(controller)
      editor.disableSubmit = false
      requestRender()
    })
  }

  type SelectionPoint = { readonly row: number; readonly column: number }
  let selectionAnchor: SelectionPoint | undefined
  let selectionFocus: SelectionPoint | undefined
  let selectionDragging = false
  let selectionRenderLines: string[] = []
  let mouseSelectionActive = false
  let copiedMouseSelection: string | undefined
  let previousRightClickAt = Number.NEGATIVE_INFINITY
  let transcriptScrollOffset = 0
  let transcriptScrollMaximum = 0
  let previousTranscriptLineCount = 0
  const originalUiRender = ui.render.bind(ui)
  const orderedSelection = (): readonly [SelectionPoint, SelectionPoint] | undefined => {
    if (selectionAnchor === undefined || selectionFocus === undefined) return undefined
    return selectionAnchor.row < selectionFocus.row
      || (selectionAnchor.row === selectionFocus.row && selectionAnchor.column <= selectionFocus.column)
      ? [selectionAnchor, selectionFocus]
      : [selectionFocus, selectionAnchor]
  }
  const selectionRangeForRow = (
    row: number,
    lineWidth: number,
  ): { readonly start: number; readonly length: number } | undefined => {
    const ordered = orderedSelection()
    if (ordered === undefined) return undefined
    const [start, end] = ordered
    if (row < start.row || row > end.row) return undefined
    const from = row === start.row ? Math.min(start.column, lineWidth) : 0
    const through = row === end.row ? Math.min(end.column + 1, lineWidth) : lineWidth
    return through <= from ? undefined : { start: from, length: through - from }
  }
  const jumpToBottomLine = (width: number): string => {
    const label = ' Jump to bottom (Ctrl+End) ↓ '
    const left = Math.max(0, Math.floor((width - visibleWidth(label)) / 2))
    return `${' '.repeat(left)}\x1b[1;97;48;2;55;55;55m${label}\x1b[22;39;49m`
  }
  const viewportTranscript = (rendered: string[], width: number): string[] => {
    const transcriptLines = rendered.slice(0, transcriptLineCount)
    const fixedLines = rendered.slice(transcriptLineCount)
    const growth = transcriptLines.length - previousTranscriptLineCount
    if (transcriptScrollOffset > 0 && growth > 0) transcriptScrollOffset += growth
    previousTranscriptLineCount = transcriptLines.length

    const availableRows = Math.max(0, runtime.terminal.rows - fixedLines.length)
    const showJump = transcriptScrollOffset > 0
    const transcriptRows = Math.max(0, availableRows - (showJump ? 1 : 0))
    transcriptScrollMaximum = Math.max(0, transcriptLines.length - transcriptRows)
    transcriptScrollOffset = Math.min(transcriptScrollOffset, transcriptScrollMaximum)
    const end = Math.max(0, transcriptLines.length - transcriptScrollOffset)
    const start = Math.max(0, end - transcriptRows)
    const visibleTranscript = transcriptLines.slice(start, end)
    return [
      ...visibleTranscript,
      ...(transcriptScrollOffset > 0 ? [jumpToBottomLine(width)] : []),
      ...fixedLines,
    ]
  }
  // The renderer keeps an unstyled viewport snapshot for selection/copy, then
  // paints the active range itself. This produces a stable DSH-blue selection
  // instead of inheriting Windows Terminal's profile-dependent white band.
  ui.render = (width: number): string[] => {
    // A plugin card, paste badge, selection reset, or resized prompt must never
    // be able to take down the whole terminal. pi-tui deliberately fails loud
    // on over-wide custom output, so enforce its width contract at our single
    // composition boundary after every application-owned transform.
    const rendered = viewportTranscript(originalUiRender(width), width).map(line =>
      visibleWidth(line) <= width ? line : truncateToWidth(line, width, ''))
    selectionRenderLines = rendered.map(line => copyableScreenText(line.replaceAll(CURSOR_MARKER, '')))
    if (orderedSelection() === undefined) return rendered
    return rendered.map((line, row) => {
      // The marker must reach pi-tui unchanged so it can locate the hardware
      // cursor. Never rebuild its editor row from a plain-text copy snapshot.
      if (line.includes(CURSOR_MARKER)) return line
      const lineWidth = visibleWidth(line)
      const range = selectionRangeForRow(row, lineWidth)
      if (range === undefined) return line
      const prefix = sliceByColumn(line, 0, range.start)
      const selected = sliceByColumn(line, range.start, range.length)
      const suffix = sliceByColumn(line, range.start + range.length, Math.max(0, lineWidth - range.start - range.length))
      // Strip nested SGR/image controls inside the highlighted span. Otherwise
      // their resets punch holes through the blue selection and can make the
      // selected screen disagree with the exact clipboard payload.
      const selectedCells = copyableScreenText(selected)
      const painted = `${prefix}\x1b[1;97;48;2;38;79;120m${selectedCells}\x1b[22;39;49m${suffix}`
      return visibleWidth(painted) <= width ? painted : truncateToWidth(painted, width, '')
    })
  }
  const selectionText = (): string => {
    const ordered = orderedSelection()
    if (ordered === undefined) return ''
    const [start, end] = ordered
    const rows = selectionRenderLines.slice(start.row, end.row + 1).map((line, offset) => {
      const row = start.row + offset
      const lineWidth = visibleWidth(line)
      const from = row === start.row ? Math.min(start.column, lineWidth) : 0
      const through = row === end.row ? Math.min(end.column + 1, lineWidth) : lineWidth
      return sliceByColumn(line, from, Math.max(0, through - from)).trimEnd()
    })
    // A mouse release one row below a visually single-line selection must not
    // paste a phantom newline and expand the editor. Interior image rows remain
    // real blank lines; only empty rows beyond the last textual cell are shed.
    while (rows.at(-1) === '') rows.pop()
    return rows.join('\n')
  }
  const mousePoint = (column: number, screenRow: number): SelectionPoint => {
    return {
      row: Math.min(Math.max(0, screenRow - 1), Math.max(0, selectionRenderLines.length - 1)),
      column: Math.max(0, column - 1),
    }
  }
  const copyMouseSelection = (): void => {
    const text = selectionText()
    if (text === '') return
    copiedMouseSelection = text
    // Claude Code's fullscreen selection writes OSC 52 directly to the
    // attached terminal. Doing the same avoids spawning PowerShell for every
    // drag and works through compatible SSH/tmux clipboard forwarding.
    runtime.terminal.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
    showCopyToast(text)
  }
  const handleMouseSelection = (data: string): boolean => {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(data)
    if (match === null) return false
    const button = Number(match[1])
    const column = Number(match[2])
    const row = Number(match[3])
    const final = match[4]
    const baseButton = button & 3
    const motion = (button & 32) !== 0
    const wheel = (button & 64) !== 0
    if (wheel) {
      const direction = baseButton === 0 ? 1 : -1
      transcriptScrollOffset = Math.min(
        transcriptScrollMaximum,
        Math.max(0, transcriptScrollOffset + direction * 3),
      )
      selectionAnchor = undefined
      selectionFocus = undefined
      selectionDragging = false
      ui.requestRender(true)
      return true
    }
    if (final === 'M' && baseButton === 0 && !motion) {
      copiedMouseSelection = undefined
      previousRightClickAt = Number.NEGATIVE_INFINITY
      selectionAnchor = mousePoint(column, row)
      selectionFocus = selectionAnchor
      selectionDragging = true
      ui.requestRender(true)
      return true
    }
    if (final === 'M' && baseButton === 2 && !motion) {
      const clickedAt = now()
      const doubleClick = clickedAt - previousRightClickAt <= 500
      previousRightClickAt = doubleClick ? Number.NEGATIVE_INFINITY : clickedAt
      if (doubleClick && copiedMouseSelection !== undefined) {
        editor.insertPastedText(copiedMouseSelection)
        selectionAnchor = undefined
        selectionFocus = undefined
        selectionDragging = false
        requestRender()
      }
      return true
    }
    if (final === 'M' && baseButton === 0 && motion && selectionDragging) {
      selectionFocus = mousePoint(column, row)
      ui.requestRender()
      return true
    }
    if (final === 'm' && baseButton === 0 && selectionDragging) {
      selectionFocus = mousePoint(column, row)
      selectionDragging = false
      ui.requestRender(true)
      copyMouseSelection()
      return true
    }
    return true
  }

  /** Best-effort feedback when the terminal forwards its native copy chord. */
  const announceNativeClipboardCopy = (): void => {
    const readClipboardText = runtime.readClipboardText
    if (readClipboardText === undefined) return
    const controller = new AbortController()
    transferControllers.add(controller)
    const timeout = setTimeout(() => { controller.abort(new Error('native clipboard read timed out')) }, 2_000)
    // Let Windows Terminal finish its copy action before reading the clipboard.
    setTimeout(() => {
      void readClipboardText({ signal: controller.signal, maxBytes: 2_000_000, cwd }).then((text) => {
        if (!disposed && !controller.signal.aborted && text !== undefined && text !== '') showCopyToast(text)
      }, () => {}).finally(() => {
        clearTimeout(timeout)
        transferControllers.delete(controller)
      })
    }, 80)
  }

  const removeInputListener = ui.addInputListener((data) => {
    if (handleMouseSelection(data)) return { consume: true }
    if (selectionAnchor !== undefined) {
      selectionAnchor = undefined
      selectionFocus = undefined
      selectionDragging = false
      ui.requestRender(true)
    }
    if (matchesKey(data, Key.ctrl('end'))) {
      transcriptScrollOffset = 0
      ui.requestRender(true)
      return { consume: true }
    }
    const idleExitKey: IdleExitKey | undefined = matchesKey(data, Key.ctrl('c'))
      ? 'ctrl-c'
      : matchesKey(data, Key.ctrl('d')) ? 'ctrl-d' : undefined
    const clearConversationKey = matchesKey(data, Key.ctrl('l'))
    if (idleExitConfirmation !== undefined && idleExitKey !== idleExitConfirmation.key) {
      clearIdleExitConfirmation()
    }
    if (clearConversationConfirmation !== undefined && !clearConversationKey) {
      clearConversationConfirmationState()
    }
    if (externalEditorInFlight) return { consume: true }
    if (overlayManager.hasActiveOverlay()) return undefined
    if (freshSwapInFlight) return { consume: true }
    if (transferOperation !== undefined) return { consume: true }
    if (matchesKey(data, Key.ctrlShift('c'))) {
      announceNativeClipboardCopy()
      return undefined
    }
    if (matchesKey(data, Key.ctrl('v')) || matchesKey(data, Key.alt('v'))) {
      pasteClipboardImage()
      return { consume: true }
    }
    const externalEditorAction = externalEditorShortcut.handle(data)
    const subagentKillAction = subagentKillShortcut.handle(data)
    if (subagentKillAction === 'invoke') {
      externalEditorShortcut.reset()
      if (confirmSubagentKill()) stopBackgroundSubagents()
      return { consume: true }
    }
    if (externalEditorAction === 'invoke') {
      subagentKillShortcut.reset()
      clearSubagentKillConfirmation(false)
      void editExternally(editor.getExpandedText()).then((edited) => {
        if (disposed) return
        editor.setText(edited)
        requestRender()
      }, (error: unknown) => {
        if (!disposed) appendNotice(`External editor failed: ${errorChain(error)}`, 'error')
      })
      return { consume: true }
    }
    if (externalEditorAction === 'consume' || subagentKillAction === 'consume') return { consume: true }
    clearSubagentKillConfirmation()
    if (data === '?' && editor.getText() === '') {
      showShortcutHelp()
      return { consume: true }
    }
    if (matchesKey(data, Key.alt('p'))) {
      modelController.openSelector()
      return { consume: true }
    }
    if (matchesKey(data, Key.alt('t'))) {
      modelController.toggleThinking()
      return { consume: true }
    }
    if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.alt('m'))) {
      try {
        const result = modeController.cycle()
        if (result.view === undefined) {
          appendNotice('Mode switching is unavailable because this runtime has no permission or plan service.', 'warning')
        } else {
          // Mode is ambient UI state, not conversation content. The prompt
          // rail, glyph, and footer provide feedback without transcript spam.
          updatePromptValues()
          requestRender()
        }
      } catch (error: unknown) {
        appendNotice(`Mode switch failed: ${errorChain(error)}`, 'error')
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      toggleTools()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('r'))) {
      showHistorySearch()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('t'))) {
      toggleTaskChecklist()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('s'))) {
      if (editor.getText() === '') {
        if (stashedEditorDraft !== undefined) {
          const draft = stashedEditorDraft
          stashedEditorDraft = undefined
          restoreEditorDraft(editor, draft)
          updateEditorHint()
          requestRender()
        }
      } else {
        stashedEditorDraft = captureEditorDraft(editor)
        clearEditorForStash(editor)
        updateEditorHint()
        requestRender()
      }
      return { consume: true }
    }
    if (clearConversationKey) {
      if (foregroundShell !== undefined || agent.status !== 'idle') {
        clearConversationConfirmationState(false)
      } else if (confirmClearConversation()) {
        startFreshConversation()
        return { consume: true }
      }
      ui.invalidate()
      ui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('b')) && foregroundShell !== undefined) {
      backgroundUserShell()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (foregroundShell !== undefined) {
        if (!foregroundShell.abort.signal.aborted) {
          foregroundShell.cancelledByUser = true
          foregroundShell.abort.abort(new Error('User cancelled direct shell command'))
          foregroundShell.process.kill()
          appendNotice('Cancelling the foreground shell command…', 'warning')
        }
      } else if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
      } else if (editor.getText() !== '') {
        clearIdleExitConfirmation(false)
        editor.setText('')
        clipboardImages.pruneUnreferenced(
          stashedEditorDraft === undefined ? [] : [stashedEditorDraft.text],
        )
      } else if (confirmIdleExit('ctrl-c')) {
        requestExit()
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (foregroundShell !== undefined) appendNotice('Background or cancel the foreground shell command before exiting.', 'warning')
      else if (agent.status === 'running') appendNotice('Cancel the active turn before exiting.', 'warning')
      else if (editor.getText() !== '') {
        clearIdleExitConfirmation(false)
        return undefined
      }
      else if (confirmIdleExit('ctrl-d')) requestExit()
      return { consume: true }
    }
    // A trailing Windows separator can leave pi-tui's generic path completion
    // armed even though /workdir owns the whole argument. Submit these commands
    // directly so ` /workdir D:\ ` needs exactly one Enter press.
    if (
      matchesKey(data, Key.enter)
      && !editor.disableSubmit
      && /^\/(?:workdir|cd)(?:\s.*)?$/u.test(editor.getText())
    ) {
      editor.onSubmit?.(editor.getText())
      return { consume: true }
    }
    return undefined
  })

  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'tool/result') fileSearch.invalidate()
    recordEventUsage(tokens, event)
    if (event.type === 'turn/start' && runningStatus !== undefined) runningStatus.turn = event.data.turn
    // Track live standalone compaction state.
    if (event.type === 'compaction/start' && event.data.turn === null) {
      if (compacting === undefined) {
        const startedAt = now()
        compacting = {
          startedAt,
          timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
        }
        runtime.terminal.setProgress(true)
      }
      requestRender()
      return
    }
    if (event.type === 'compaction/end' && event.data.turn === null && compacting !== undefined) {
      const fadeOutGlyph = runningPhaseGlyph(agent.session.events, false, true)
      clearInterval(compacting.timer)
      compacting = undefined
      if (event.data.error !== undefined) {
        appendNotice(`Compaction failed: ${event.data.error}`, 'warning')
      }
      // A concurrently running turn owns the indicator. Keep its timer and
      // progress bit instead of letting the compaction fade clear that state.
      if (runningStatus === undefined && fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
      requestRender()
      return
    }
    // A replacement mutates only the model surface, so the rendered transcript
    // keeps what it already showed; a landed summary checkpoint adds its marker.
    if (isReplacementSurfaceEvent(event)) {
      if (isCompactCheckpoint(event)) renderCompactionMarker()
      requestRender()
      return
    }
    renderEvent(event, { renderChunks: true })
    requestRender()
  })
  const settlePendingSteering = (id: MessageId): void => {
    if (pendingSteering.delete(id)) refreshStatus()
  }
  const disposeDequeued = ctx.on('agent/inbox/claimed', ({ agent: subject, message: item }) => {
    if (subject === agent) settlePendingSteering(item.id)
  })
  const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ agent: subject, message: item }) => {
    if (subject !== agent) return
    if (pendingSteering.delete(item.id)) refreshStatus()
  })
  const disposeStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    // Leaving 'running' ends the turn's status line; clear any badge so the
    // next running turn starts from zero (and a cancellation, which discards
    // the queue without logging drains, cannot strand a stale count).
    if (status !== 'running') pendingSteering.clear()
    setStatus(status)
  })
  const disposeError = ctx.on('agent/error', ({ agent: subject, turn, step, error }) => {
    if (subject !== agent) return
    liveErrors.add(`${turn}:${step}`)
    liveErrorTurns.add(turn)
    // Full cause chain: wrapper messages like `fetch failed` carry the
    // actionable transport detail on `cause`.
    appendNotice(errorChain(error), 'error')
  })
  const disposeAgent = ctx.on('agent/disposed', ({ agent: subject }) => {
    if (subject !== agent) return
    // The agent left the registry (e.g. an agent-loop-only reload) while the
    // TUI stays mounted. Retained agents accept deliveries after detachment, so
    // without this a later send would drive a zombie agent/session; mark
    // disposed so dispatchMessage reports it instead.
    // The hard clear also retires live compaction. A later compact/end is
    // intentionally presentation-silent: this disposal notice owns the
    // terminal outcome, and no animation may survive agent detachment.
    clearStatus()
    disposeForegroundShell('Agent disposed')
    userShellHistory.dispose()
    promptHistory.dispose()
    appendNotice(`Agent "${agent.id}" was disposed.`, 'warning')
    disposed = true
  })

  const detachListeners = (): void => {
    if (mouseSelectionActive) {
      runtime.terminal.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l')
      mouseSelectionActive = false
    }
    skillAbort.abort()
    if (skillCommandRetry !== undefined) clearTimeout(skillCommandRetry)
    fileSearch.dispose()
    userShellHistory.dispose()
    promptHistory.dispose()
    disposePromptHistoryChanges()
    removeInputListener()
    disposeCommandChanges()
    disposeSkillChanges()
    disposePromptChanges()
    for (const value of promptValues) value.dispose()
    stopBannerReveal()
    if (statusToastTimer !== undefined) clearTimeout(statusToastTimer)
    disposeSessionEvents()
    disposeDequeued()
    disposeDiscarded()
    disposeStatus()
    disposeError()
    disposeAgent()
    disposeSchemeListener()
    disposeTargetListeners()
    modelController.detach()
  }

  // Sweep reveal of the whole banner: the header wipes in left-to-right over
  // ~BANNER_REVEAL_STEPS frames (started after `ui.start()` succeeds).
  // Configured subtitles skip it so deployments (and snapshot fixtures) stay
  // frame-deterministic.
  let revealTimer: ReturnType<typeof setInterval> | undefined
  const stopBannerReveal = (): void => {
    if (revealTimer === undefined) return
    clearInterval(revealTimer)
    revealTimer = undefined
    header.setRevealWidth(undefined)
  }
  const startBannerReveal = (): void => {
    if (config.welcome !== undefined) return
    const total = Math.max(1, runtime.terminal.columns)
    const step = Math.max(1, Math.ceil(total / BANNER_REVEAL_STEPS))
    let shown = 0
    header.setRevealWidth(0)
    revealTimer = setInterval(() => {
      shown += step
      if (shown >= total) {
        stopBannerReveal()
      } else {
        header.setRevealWidth(shown)
      }
      requestRender()
    }, BANNER_REVEAL_INTERVAL_MS)
  }

  rebuildTranscript(true)
  const restoredGoal = foldGoal(agent.session.events).goal
  /* v8 ignore next -- goal replay coverage lives with the goal seam; the TUI only formats its startup notice. */
  if (restoredGoal !== undefined && restoredGoal.phase !== 'complete') {
    appendNotice(
      `Goal restored (${restoredGoal.phase}) with automatic continuation disarmed. `
      + 'Human confirmation is required; send “继续” or run /goal resume.',
      'warning',
    )
  }
  setStatus(agent.status)
  try {
    ui.start()
    if (runtime.writeClipboardText !== undefined) {
      // SGR button-event tracking gives DSH its own deterministic selection
      // layer. Shift+drag remains the terminal-native escape hatch in Windows
      // Terminal, matching other full-screen coding TUIs.
      runtime.terminal.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
      mouseSelectionActive = true
    }
  } catch (error: unknown) {
    disposed = true
    detachListeners()
    void Promise.all([
      commandFiber.dispose(),
      fileReferencePromptFiber.dispose(),
    ]).catch(
      /* v8 ignore next 2 -- command registration cleanup is non-throwing; this guards a future disposer regression */
      (cleanupError: unknown) => {
        ctx.logger.warn(`ui-tui: scoped cleanup after startup failure failed: ${errorChain(cleanupError)}`)
      },
    )
    clearStatus()
    questions.unregister()
    ui.stop()
    throw error
  }
  tuiServiceFiber = ctx.inject([], (serviceCtx) => {
    new TuiExtensionServiceImpl(serviceCtx, agent, overlayManager)
  })
  if (runtime.initialNotice !== undefined) appendNotice(runtime.initialNotice)
  startBannerReveal()

  // A launcher-seeded first turn (`dsh migrate`/`dsh upgrade`):
  // invoke the named skill exactly as a typed `/skill:<name>` would, once the
  // chat is live and the agent is idle. The launcher sets this only for a fresh
  // session, so there is no prior turn to collide with; invokeSkill reports an
  // unknown skill as a notice.
  if (config.initialSkill !== undefined) invokeSkill(config.initialSkill, '')

  return {
    updateSettings(settings: TuiUserSettings): void {
      if (!disposed) applyUserSettings(settings)
    },
    async dispose(): Promise<void> {
      detachListeners()
      await shutdown(false)
      await Promise.all([
        commandFiber.dispose(),
        fileReferencePromptFiber.dispose(),
      ])
    },
  }
}

/** Lifecycle handle for one mounted TUI channel, torn down on swap or exit. */
export interface TuiMountHandle {
  /**
   * Forward one committed live-settings snapshot to the mounted channel.
   * @param settings Authoritative settings from the provider.
   */
  updateSettings(settings: TuiUserSettings): void
  /** Stop the channel, release the terminal, and settle pending dialogs. */
  dispose(): Promise<void>
}

/**
 * Open the pi-tui channel once its configured agent exists.
 *
 * @param ctx - Context supplying the agent registry, tools, and event stream.
 * @param config - Target agent and presentation configuration.
 * @param runtime - Terminal and process-exit boundary.
 * @returns a handle whose `dispose` tears the channel down; the same channel
 *   is also torn down when the owning fiber unloads (root disposal), so the
 *   handle's disposer is safe to call once per swap and again on exit.
 */
export function mountTui(ctx: Context, config: Config, runtime: TuiRuntime): TuiMountHandle {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const matchesConfiguredIdentity = (agent: Agent): boolean =>
    agent.id === sessionId && ctx.agents.roots().includes(agent)
  let settled = false
  let mountDisposer: (() => Promise<void>) | undefined
  let mountedController: TuiController | undefined

  const stopWaiting = (): void => {
    disposeCreated()
    disposeFailure()
  }
  const start = (agent: Agent): void => {
    if (settled || !matchesConfiguredIdentity(agent)) return
    settled = true
    stopWaiting()
    mountDisposer = ctx.effect(() => {
      const controller = createTuiChat(ctx, config, runtime)
      mountedController = controller
      return async () => {
        await controller.dispose()
        if (mountedController === controller) mountedController = undefined
      }
    }, 'ui-tui')
  }
  const fail = (failedSessionId: SessionId, error: unknown): void => {
    if (settled || failedSessionId !== sessionId) return
    settled = true
    stopWaiting()
    runtime.terminal.write(displayText(`ui-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`))
    runtime.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', ({ agent }) => { start(agent) })
  const disposeFailure = ctx.on('agent-loop/config-start-failed', ({ sessionId, error }) => { fail(sessionId, error) })
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)

  return {
    updateSettings(settings: TuiUserSettings): void {
      mountedController?.updateSettings(settings)
    },
    async dispose(): Promise<void> {
      if (!settled) {
        stopWaiting()
        return
      }
      await mountDisposer?.()
    },
  }
}

const ROOT_DISPOSE_TIMEOUT_MS = 5_000

/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * @param ctx - The TUI plugin context whose root owns sibling resources.
 * @param code - Process status to report.
 * @param exit - Exit boundary, replaceable by tests.
 */
export function disposeRootAndExit(
  ctx: Context,
  code: number,
  exit: (status: number) => void = (status) => { process.exit(status) },
): void {
  let exited = false
  const exitOnce = (): void => {
    if (exited) return
    exited = true
    exit(code)
  }
  const timeout = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS)
  void ctx.root.fiber.dispose().then(
    () => { clearTimeout(timeout); exitOnce() },
    () => { clearTimeout(timeout); exitOnce() },
  )
}

/** Cordis entry point using the process terminal; explicit TUI composition requires a TTY pair. */
/* v8 ignore start -- production process wiring; fake-terminal tests cover mountTui/createTuiChat,
   and apps/cli PTY smokes cover the real entry */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('ui-tui: both stdin and stdout must be TTYs; use --profile headless for pipes')
  }
  // The terminal app owns its surface context just as the Web app owns its
  // browser context. Register before the runner creates the interactive agent,
  // so its first request can locate the Harness implementation independently
  // of the session workspace.
  addHarnessSourceSection(ctx, SOURCE_ROOT)
  // Truecolor is a terminal capability, so detect it here at the process
  // boundary from COLORTERM; an explicit theme value still wins.
  const truecolor = config.theme?.truecolor ?? ['truecolor', '24bit'].includes(process.env.COLORTERM ?? '')
  let currentMount: TuiMountHandle | undefined
  const workspaceHistory = new LocalWorkspaceHistory()
  const entrySettings = resolveTuiUserSettings(config)
  let settingsSource = (): TuiUserSettings => entrySettings
  installSettingsSection(ctx, TUI_SETTINGS_NAMESPACE, TuiUserSettingsSchema, entrySettings, {
    setSource: (current) => { settingsSource = current },
    onChange: () => { currentMount?.updateSettings(settingsSource()) },
  })
  let mountGeneration = 0
  // The runner owns the interactive agent lifecycle; mount (or, on an in-place
  // resume, remount) the channel for the settled agent. A swap tears down the
  // previous channel before the replacement mounts; a newer ready supersedes
  // a stale in-flight mount.
  ctx.on('tui-agent/ready', ({ sessionId, selection, initialNotice }) => {
    const generation = ++mountGeneration
    void (async () => {
      await currentMount?.dispose()
      if (generation !== mountGeneration) return
      currentMount = mountTui(ctx, Object.assign(
        {},
        config,
        { sessionId: String(sessionId), theme: Object.assign({}, config.theme, { truecolor }) },
      ), {
        terminal: new ProcessTerminal(),
        exit: (code) => { disposeRootAndExit(ctx, code) },
        editText: editTextInExternalEditor,
        readClipboardImage: request => readImageFromClipboard(request, {
          ...config.clipboardImageCommand === undefined || config.clipboardImageCommand.length === 0
            ? {}
            : { command: config.clipboardImageCommand },
        }),
        readClipboardText: readTextFromClipboard,
        writeClipboardText: request => writeTextToClipboard(request, {
          ...config.clipboardTextCommand === undefined || config.clipboardTextCommand.length === 0
            ? {}
            : { command: config.clipboardTextCommand },
        }),
        writeTextFile: writeResponseTextFile,
        workspaceHistory,
        readSettings: () => settingsSource(),
        updateSettings: async (patch) => {
          const settings = ctx.get('settings')
          if (settings === undefined) throw new Error('user-settings service is not mounted')
          await settings.update(TUI_SETTINGS_NAMESPACE, patch)
          return settingsSource()
        },
        ...selection === undefined ? {} : { initialModelSelection: selection },
        ...initialNotice === undefined ? {} : { initialNotice },
        // The session's own resume command, printed once the terminal is
        // released on exit — the Claude Code "--continue" analog.
        goodbyeMessage: `Resume this session with: dsh tui --resume ${String(sessionId)}`,
        // In-place resume: the runner swaps the agent (rejecting without
        // touching the current session), then this ready handler remounts.
        swapResume: (resumeSessionId) => {
          const tuiAgent = ctx.get('tuiAgent')
          if (tuiAgent === undefined) {
            return Promise.reject(new Error('tui-runner service is not mounted'))
          }
          return tuiAgent.swap(resumeSessionId)
        },
        // `/clear` and timely double Ctrl+L keep the old log resumable while
        // creating a fresh identity and remounting this terminal in place.
        swapFresh: (freshSelection, freshCwd, routingProfile) => {
          const tuiAgent = ctx.get('tuiAgent')
          if (tuiAgent === undefined) {
            return Promise.reject(new Error('tui-runner service is not mounted'))
          }
          return tuiAgent.fresh(freshSelection, freshCwd, routingProfile)
        },
        // `/rewind` forks a child through a completed event boundary, leaving
        // the source session durable and resumable before this terminal remounts.
        swapFork: (boundary, forkSelection, notice) => {
          const tuiAgent = ctx.get('tuiAgent')
          if (tuiAgent === undefined) {
            return Promise.reject(new Error('tui-runner service is not mounted'))
          }
          return tuiAgent.fork(boundary, forkSelection, notice)
        },
      })
    })()
  })

  // The terminal-local first-run notice, when the profile configures one: its
  // `inject: ['tui']` fiber loads on the first channel mount (the extension
  // service mounts on this same context) and re-runs on a resume swap, while
  // the welcome module gates itself to one notice per Harness-home root.
  if (config.firstRunWelcome !== undefined) {
    ctx.plugin(firstRunWelcome, config.firstRunWelcome)
  }
}
/* v8 ignore stop */
