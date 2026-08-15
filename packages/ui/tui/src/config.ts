/**
 * Serializable configuration and defaults for the pi-tui terminal mode. Loader
 * schema validation normally fills defaults; {@link resolveTuiConfig} applies
 * the same defaults for direct callers that bypass the Loader.
 * @module @deepseek-ai/dsh-tui/config
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './chat/file-autocomplete.ts'

/** Visual style of the built-in palette. */
export type TuiPaletteStyle = 'deepseek' | 'claude' | 'adaptive'

/** Theme and prompt-template settings for the pi-tui terminal mode. */
export interface TuiThemeConfig {
  /** Apply the built-in ANSI color palette. */
  color?: boolean
  /**
   * Palette style. `deepseek` uses blue/violet roles on dark terminals,
   * `claude` keeps the terracotta reference palette, and `adaptive` follows
   * the terminal's ANSI colors.
   */
  palette?: TuiPaletteStyle
  /** Paint the startup banner with the 24-bit DeepSeek brand gradient. */
  truecolor?: boolean
  /** Left-aligned template on the row above the editor. */
  leftPrompt?: string
  /** Right-aligned template on the row above the editor. */
  rightPrompt?: string
  /** Template used as the editor's first-line prefix. */
  inputPrompt?: string
  /** Static placeholder shown in an empty editor while the agent is running. */
  inputPlaceholder?: string
}

/** Interaction and presentation settings for the pi-tui terminal mode. */
export interface TuiConfig {
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Prepend the latest assistant reply as stripped comment context in the external editor. */
  externalEditorContext?: boolean
  /**
   * Optional argv that writes one clipboard image as raw PNG bytes to stdout.
   * Exit code 3 means the clipboard has no image. The platform helper is used when absent.
   */
  clipboardImageCommand?: string[]
  /** Optional argv that receives copied assistant text as UTF-8 stdin. */
  clipboardTextCommand?: string[]
  /** Maximum tool-card body lines retained in its collapsed head/tail preview. */
  maxToolOutputLines?: number
  /** Maximum added and removed lines explored while deriving an exact line diff. */
  maxDiffEditLength?: number
  /** Maximum options visible at once in a user-question panel. */
  maxQuestionOptions?: number
  /** Maximum models visible at once in the model selector. */
  maxModelOptions?: number
  /** Maximum sessions visible at once in the resume selector. */
  maxResumeOptions?: number
  /** Maximum concurrent cold projection reads in one resume scan. */
  resumeScanConcurrency?: number
  /** Maximum prompt-history matches visible at once. */
  maxHistoryOptions?: number
  /** Maximum unique prompt-history matches retained for one search scope. */
  historyMaxEntries?: number
  /** Maximum prior sessions inspected by one prompt-history scan. */
  historyMaxSessions?: number
  /** Maximum simultaneous exact reads in one prompt-history scan. */
  historyScanConcurrency?: number
  /** User-question panel width in terminal columns, clamped to the terminal. */
  questionDialogWidth?: number
  /** User-question panel maximum height in terminal rows. */
  questionDialogMaxHeight?: number
  /** Model-selector width in terminal columns. */
  modelDialogWidth?: number
  /** Model-selector maximum height in terminal rows. */
  modelDialogMaxHeight?: number
  /** Transcript-details selector width in terminal columns. */
  detailsDialogWidth?: number
  /** Live-settings selector width in terminal columns. */
  settingsDialogWidth?: number
  /** UTF-8 bytes retained from one direct-shell command's combined output. */
  directShellOutputMaxBytes?: number
  /** Milliseconds between live direct-shell output reads. */
  directShellOutputRefreshMs?: number
  /** Maximum fuzzy file candidates displayed for one `@` query. */
  fileSearchMaxResults?: number
  /** Maximum paths retained in one `@` workspace index. */
  fileSearchMaxEntries?: number
  /** Directory basenames excluded from `@` traversal and completion. */
  fileSearchExcludedDirectories?: string[]
  /** Show the terminal's hardware cursor at the pi editor's IME marker. */
  showHardwareCursor?: boolean
  /** Color and prompt-template settings. */
  theme?: TuiThemeConfig
  /** Terminal window title while the UI is mounted; a logged session title prefixes it. */
  title?: string
}

/** User-owned TUI settings that take effect in an already-mounted channel. */
export interface TuiUserSettings {
  /** Render model reasoning blocks. */
  readonly showReasoning: boolean
  /** Prepend the latest assistant reply as stripped comment context in the external editor. */
  readonly externalEditorContext: boolean
}

const showReasoningSchema = z.boolean().default(true)
const externalEditorContextSchema = z.boolean().default(false)
const clipboardImageCommandSchema = z.array(z.string())
const clipboardTextCommandSchema = z.array(z.string())
const maxToolOutputLinesSchema = z.number().step(1).min(1).default(6)
const maxDiffEditLengthSchema = z.number().step(1).min(1).default(1000)
const maxQuestionOptionsSchema = z.number().step(1).min(1).default(8)
const maxModelOptionsSchema = z.number().step(1).min(1).default(8)
const maxResumeOptionsSchema = z.number().step(1).min(1).default(8)
const resumeScanConcurrencySchema = z.number().step(1).min(1).default(4)
const maxHistoryOptionsSchema = z.number().step(1).min(1).default(8)
const historyMaxEntriesSchema = z.number().step(1).min(1).default(1_000)
const historyMaxSessionsSchema = z.number().step(1).min(1).default(128)
const historyScanConcurrencySchema = z.number().step(1).min(1).default(4)
const questionDialogWidthSchema = z.number().step(1).min(20).default(200)
const questionDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const modelDialogWidthSchema = z.number().step(1).min(20).default(76)
const modelDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const detailsDialogWidthSchema = z.number().step(1).min(20).default(72)
const settingsDialogWidthSchema = z.number().step(1).min(20).default(72)
const directShellOutputMaxBytesSchema = z.number().step(1).min(1).default(64_000)
const directShellOutputRefreshMsSchema = z.number().step(1).min(1).default(50)
const fileSearchMaxResultsSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS)
const fileSearchMaxEntriesSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES)
const fileSearchExcludedDirectoriesSchema = z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES])
const showHardwareCursorSchema = z.boolean().default(true)
const colorSchema = z.boolean().default(true)
// No default: an unset value auto-detects truecolor from COLORTERM in `apply`.
const truecolorSchema = z.boolean()
const paletteStyleSchema = z.union([z.const('adaptive'), z.const('claude'), z.const('deepseek')]).default('deepseek')
const DEFAULT_LEFT_PROMPT = '${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}'
const DEFAULT_RIGHT_PROMPT = '${mode}${queued}'
const DEFAULT_INPUT_PROMPT = '${symbol}${indicator}'
const DEFAULT_INPUT_PLACEHOLDER = 'press enter to steer and esc to cancel'
const TuiThemeConfigSchema: z<TuiThemeConfig> = z.object({
  color: colorSchema,
  palette: paletteStyleSchema,
  truecolor: truecolorSchema,
  leftPrompt: z.string().default(DEFAULT_LEFT_PROMPT),
  rightPrompt: z.string().default(DEFAULT_RIGHT_PROMPT),
  inputPrompt: z.string().default(DEFAULT_INPUT_PROMPT),
  inputPlaceholder: z.string().default(DEFAULT_INPUT_PLACEHOLDER),
})
const titleSchema = z.string().default('DeepSeek Harness')

/** Schemastery schema for the live `ui-tui` user-settings namespace. */
export const TuiUserSettingsSchema: z<TuiUserSettings> = z.object({
  showReasoning: z.boolean().default(true).description('Show model reasoning blocks in the transcript'),
  externalEditorContext: z.boolean().default(false).description('Show the latest assistant response as removable context in the external editor'),
})

const tuiConfigSchemaFields = {
  showReasoning: showReasoningSchema,
  externalEditorContext: externalEditorContextSchema,
  clipboardImageCommand: clipboardImageCommandSchema,
  clipboardTextCommand: clipboardTextCommandSchema,
  maxToolOutputLines: maxToolOutputLinesSchema,
  maxDiffEditLength: maxDiffEditLengthSchema,
  maxQuestionOptions: maxQuestionOptionsSchema,
  maxModelOptions: maxModelOptionsSchema,
  maxResumeOptions: maxResumeOptionsSchema,
  resumeScanConcurrency: resumeScanConcurrencySchema,
  maxHistoryOptions: maxHistoryOptionsSchema,
  historyMaxEntries: historyMaxEntriesSchema,
  historyMaxSessions: historyMaxSessionsSchema,
  historyScanConcurrency: historyScanConcurrencySchema,
  questionDialogWidth: questionDialogWidthSchema,
  questionDialogMaxHeight: questionDialogMaxHeightSchema,
  modelDialogWidth: modelDialogWidthSchema,
  modelDialogMaxHeight: modelDialogMaxHeightSchema,
  detailsDialogWidth: detailsDialogWidthSchema,
  settingsDialogWidth: settingsDialogWidthSchema,
  directShellOutputMaxBytes: directShellOutputMaxBytesSchema,
  directShellOutputRefreshMs: directShellOutputRefreshMsSchema,
  fileSearchMaxResults: fileSearchMaxResultsSchema,
  fileSearchMaxEntries: fileSearchMaxEntriesSchema,
  fileSearchExcludedDirectories: fileSearchExcludedDirectoriesSchema,
  showHardwareCursor: showHardwareCursorSchema,
  theme: TuiThemeConfigSchema,
  title: titleSchema,
}

/** Schemastery schema for presentation settings embedded by app bundles. */
export const TuiConfigSchema: z<TuiConfig> = z.object(tuiConfigSchemaFields)

/** Serializable plugin configuration. */
export interface Config extends TuiConfig {
  /** Banner subtitle line. When absent, the banner has no subtitle and sweeps in on start. */
  welcome?: string
  /** Exact shared agent/session identity driven by this terminal. Defaults to `main`. */
  sessionId?: string
  /**
   * Skill name auto-invoked as this session's first user turn, exactly as if
   * the user typed `/skill:<name>`. Set only by a launcher for a fresh
   * skill-guided session (`dsh migrate`/`dsh upgrade`); absent
   * leaves the first turn to the user.
   */
  initialSkill?: string
  /**
   * Terminal-local first-run notice, opened on the first channel mount whose
   * Harness home lacks a stored acknowledgement. Absent skips onboarding.
   */
  firstRunWelcome?: FirstRunWelcomeConfig
}

/** Profile-provided settings for the terminal-local first-run notice. */
export interface FirstRunWelcomeConfig {
  /** Absolute DeepSeek Harness home owning this acknowledgement. */
  readonly dshHome: string
  /** Render the bit-equivalent printable ASCII icon fallback. */
  readonly asciiArt?: boolean
}

// Annotated, like every field schema in this file: an inline literal would
// expand the nested ObjectS type and overflow the outer schema's inference.
const firstRunWelcomeSchema: z<FirstRunWelcomeConfig> = z.union([
  z.object({
    dshHome: z.string().required(),
    asciiArt: z.boolean(),
  }).required(),
])

/** Schemastery schema for the full plugin configuration. */
export const Config: z<Config> = z.object({
  welcome: z.string(),
  sessionId: z.string().default('main'),
  initialSkill: z.string(),
  firstRunWelcome: firstRunWelcomeSchema,
  showReasoning: tuiConfigSchemaFields.showReasoning,
  externalEditorContext: tuiConfigSchemaFields.externalEditorContext,
  clipboardImageCommand: tuiConfigSchemaFields.clipboardImageCommand,
  clipboardTextCommand: tuiConfigSchemaFields.clipboardTextCommand,
  maxToolOutputLines: tuiConfigSchemaFields.maxToolOutputLines,
  maxDiffEditLength: tuiConfigSchemaFields.maxDiffEditLength,
  maxQuestionOptions: tuiConfigSchemaFields.maxQuestionOptions,
  maxModelOptions: tuiConfigSchemaFields.maxModelOptions,
  maxResumeOptions: tuiConfigSchemaFields.maxResumeOptions,
  resumeScanConcurrency: tuiConfigSchemaFields.resumeScanConcurrency,
  maxHistoryOptions: tuiConfigSchemaFields.maxHistoryOptions,
  historyMaxEntries: tuiConfigSchemaFields.historyMaxEntries,
  historyMaxSessions: tuiConfigSchemaFields.historyMaxSessions,
  historyScanConcurrency: tuiConfigSchemaFields.historyScanConcurrency,
  questionDialogWidth: tuiConfigSchemaFields.questionDialogWidth,
  questionDialogMaxHeight: tuiConfigSchemaFields.questionDialogMaxHeight,
  modelDialogWidth: tuiConfigSchemaFields.modelDialogWidth,
  modelDialogMaxHeight: tuiConfigSchemaFields.modelDialogMaxHeight,
  detailsDialogWidth: tuiConfigSchemaFields.detailsDialogWidth,
  settingsDialogWidth: tuiConfigSchemaFields.settingsDialogWidth,
  directShellOutputMaxBytes: tuiConfigSchemaFields.directShellOutputMaxBytes,
  directShellOutputRefreshMs: tuiConfigSchemaFields.directShellOutputRefreshMs,
  fileSearchMaxResults: tuiConfigSchemaFields.fileSearchMaxResults,
  fileSearchMaxEntries: tuiConfigSchemaFields.fileSearchMaxEntries,
  fileSearchExcludedDirectories: tuiConfigSchemaFields.fileSearchExcludedDirectories,
  showHardwareCursor: tuiConfigSchemaFields.showHardwareCursor,
  theme: tuiConfigSchemaFields.theme,
  title: tuiConfigSchemaFields.title,
})

/** Fully defaulted TUI theme settings. */
export interface ResolvedTuiThemeConfig {
  color: boolean
  palette: TuiPaletteStyle
  truecolor: boolean
  leftPrompt: string
  rightPrompt: string
  inputPrompt: string
  inputPlaceholder: string
}

/** Fully defaulted TUI presentation settings. */
export interface ResolvedTuiConfig {
  showReasoning: boolean
  externalEditorContext: boolean
  clipboardImageCommand: string[] | undefined
  clipboardTextCommand: string[] | undefined
  maxToolOutputLines: number
  maxDiffEditLength: number
  maxQuestionOptions: number
  maxModelOptions: number
  maxResumeOptions: number
  resumeScanConcurrency: number
  maxHistoryOptions: number
  historyMaxEntries: number
  historyMaxSessions: number
  historyScanConcurrency: number
  questionDialogWidth: number
  questionDialogMaxHeight: number
  modelDialogWidth: number
  modelDialogMaxHeight: number
  detailsDialogWidth: number
  settingsDialogWidth: number
  directShellOutputMaxBytes: number
  directShellOutputRefreshMs: number
  fileSearchMaxResults: number
  fileSearchMaxEntries: number
  fileSearchExcludedDirectories: string[]
  showHardwareCursor: boolean
  theme: ResolvedTuiThemeConfig
  title: string
}

/**
 * Resolve the user-editable live subset from deployment configuration.
 * @param config Deployment-provided terminal presentation settings.
 * @returns Complete composition base for the `ui-tui` settings namespace.
 */
export function resolveTuiUserSettings(config: TuiConfig | undefined): TuiUserSettings {
  return {
    showReasoning: config?.showReasoning ?? true,
    externalEditorContext: config?.externalEditorContext ?? false,
  }
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided terminal presentation settings.
 * @returns Complete settings consumed by the TUI renderer.
 */
export function resolveTuiConfig(config: TuiConfig | undefined): ResolvedTuiConfig {
  return {
    showReasoning: config?.showReasoning ?? true,
    externalEditorContext: config?.externalEditorContext ?? false,
    clipboardImageCommand: config?.clipboardImageCommand === undefined
      ? undefined
      : [...config.clipboardImageCommand],
    clipboardTextCommand: config?.clipboardTextCommand === undefined
      ? undefined
      : [...config.clipboardTextCommand],
    maxToolOutputLines: config?.maxToolOutputLines ?? 6,
    maxDiffEditLength: config?.maxDiffEditLength ?? 1000,
    maxQuestionOptions: config?.maxQuestionOptions ?? 8,
    maxModelOptions: config?.maxModelOptions ?? 8,
    maxResumeOptions: config?.maxResumeOptions ?? 8,
    resumeScanConcurrency: config?.resumeScanConcurrency ?? 4,
    maxHistoryOptions: config?.maxHistoryOptions ?? 8,
    historyMaxEntries: config?.historyMaxEntries ?? 1_000,
    historyMaxSessions: config?.historyMaxSessions ?? 128,
    historyScanConcurrency: config?.historyScanConcurrency ?? 4,
    questionDialogWidth: config?.questionDialogWidth ?? 200,
    questionDialogMaxHeight: config?.questionDialogMaxHeight ?? 20,
    modelDialogWidth: config?.modelDialogWidth ?? 76,
    modelDialogMaxHeight: config?.modelDialogMaxHeight ?? 20,
    detailsDialogWidth: config?.detailsDialogWidth ?? 72,
    settingsDialogWidth: config?.settingsDialogWidth ?? 72,
    directShellOutputMaxBytes: config?.directShellOutputMaxBytes ?? 64_000,
    directShellOutputRefreshMs: config?.directShellOutputRefreshMs ?? 50,
    fileSearchMaxResults: config?.fileSearchMaxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
    fileSearchMaxEntries: config?.fileSearchMaxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    fileSearchExcludedDirectories: [...(config?.fileSearchExcludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES)],
    showHardwareCursor: config?.showHardwareCursor ?? true,
    theme: {
      color: config?.theme?.color ?? true,
      palette: config?.theme?.palette ?? 'deepseek',
      truecolor: config?.theme?.truecolor ?? false,
      leftPrompt: config?.theme?.leftPrompt ?? DEFAULT_LEFT_PROMPT,
      rightPrompt: config?.theme?.rightPrompt ?? DEFAULT_RIGHT_PROMPT,
      inputPrompt: config?.theme?.inputPrompt ?? DEFAULT_INPUT_PROMPT,
      inputPlaceholder: config?.theme?.inputPlaceholder ?? DEFAULT_INPUT_PLACEHOLDER,
    },
    title: config?.title ?? 'DeepSeek Harness',
  }
}
