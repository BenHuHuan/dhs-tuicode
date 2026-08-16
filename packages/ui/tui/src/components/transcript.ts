/**
 * pi-tui transcript components: the startup banner, user/assistant messages,
 * per-step timing footer, streaming assistant buffer, tool cards, and the todo
 * panel. Each is a pure function of its inputs and the active palette.
 * @module @deepseek-ai/dsh-tui/components/transcript
 */

import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import { diffLines as compareLines } from 'diff'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type {
  TerminalCallView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { preview, renderUnknownXml } from './xml-tool-output.ts'
import { displayInlineText, displayText } from './text.ts'
import { gradientText, type ColorRole, type Palette } from './theme.ts'
import { formatToolElapsed, toolCardArgSummary, toolCardColor, toolCardTitle } from './tool-card.ts'
import { contentText, imageContentText, type ParsedArguments } from './content.ts'
import type { InlineImageFactory } from './inline-image.ts'
import {
  formatCompletionTime,
  formatTimingTotals,
  type StepPosition,
  type StepTimingTracker,
} from '../chat/timing.ts'

/** Concatenate the text of every block of one type, separated by blank lines. */
function textBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

/** Render a value as terminal-safe text: strings escaped, other values as pretty JSON. */
function pretty(value: unknown): string {
  if (typeof value === 'string') return displayText(value)
  // JSON.stringify is typed to return string but yields undefined for e.g. symbols.
  const serialized = JSON.stringify(value, null, 2) as string | undefined
  return displayText(serialized ?? String(value))
}

interface RenderedDiff {
  lines: string[]
  added: number
  removed: number
  approximate: boolean
}

/**
 * A side's content lines under the terminator rule the Web DiffBlock also
 * applies: empty text is zero lines, a trailing newline terminates the last
 * line, and an interior blank line survives.
 */
function diffContentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * A file diff whose unchanged context stays neutral and does not affect exact
 * change totals. Comparisons beyond the edit-distance budget fall back to
 * whole-side rendering so a model-authored pending edit cannot stall the TUI.
 */
function renderDiff(diff: FileDiff, maxDiffEditLength: number, palette: Palette): RenderedDiff {
  // The card title summarizes the operation but never names a diff file, so
  // each hunk always carries its own path header (no redundancy to suppress).
  const lines = [palette.bold(displayText(diff.path))]
  let added = 0
  let removed = 0
  if (diff.oldText === null) {
    const newLines = diffContentLines(displayText(diff.newText))
    added = newLines.length
    for (const line of newLines) lines.push(palette.success(`+ ${line}`))
    return { lines, added, removed, approximate: false }
  }
  const changes = compareLines(diff.oldText, diff.newText, { maxEditLength: maxDiffEditLength })
  if (changes === undefined) {
    const oldLines = diffContentLines(displayText(diff.oldText))
    const newLines = diffContentLines(displayText(diff.newText))
    lines.push(palette.dim(`[exact line diff omitted: >${maxDiffEditLength} changed lines]`))
    removed = oldLines.length
    added = newLines.length
    for (const line of oldLines) lines.push(palette.error(`- ${line}`))
    for (const line of newLines) lines.push(palette.success(`+ ${line}`))
    return { lines, added, removed, approximate: true }
  }
  for (const change of changes) {
    const changedLines = diffContentLines(displayText(change.value))
    if (change.added) {
      added += changedLines.length
      for (const line of changedLines) lines.push(palette.success(`+ ${line}`))
    } else if (change.removed) {
      removed += changedLines.length
      for (const line of changedLines) lines.push(palette.error(`- ${line}`))
    } else {
      for (const line of changedLines) lines.push(palette.dim(`  ${line}`))
    }
  }
  return { lines, added, removed, approximate: false }
}

/**
 * Claude-Code-shaped startup card using DeepSeek's blue/violet visual system.
 * Wide terminals receive a two-column welcome/tips layout; narrow terminals
 * collapse to a compact identity block without losing the current workspace.
 */
export class HeaderComponent implements Component {
  /** Columns of the banner currently revealed; `undefined` renders it whole. */
  private revealWidth: number | undefined

  constructor(
    private readonly agent: Agent,
    private readonly subtitle: () => string | undefined,
    private readonly palette: Palette,
    private readonly gradient: boolean,
    private readonly mascot?: Component,
  ) {}

  /**
   * Clip the banner to `width` columns (the sweep reveal); `undefined` restores it.
   * @param width - Revealed banner width in columns, or `undefined` for the whole banner.
   */
  setRevealWidth(width: number | undefined): void {
    this.revealWidth = width
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Ultra-wide terminals should not turn the welcome card into a wall. This
    // cap still leaves 64 columns for the 56-cell mascot plus its safe inset,
    // and a separate 63-column information pane.
    const cardWidth = Math.min(width, 132)
    const usable = Math.max(1, cardWidth - 2)
    const name = this.gradient
      ? this.palette.bold(gradientText('DEEPSEEK'))
      : this.palette.bold(this.palette.accent('DEEPSEEK'))
    const title = `${name} ${this.palette.bold('CODE')} ${this.palette.dim('v0.2.0')}`
    const model = displayText(this.agent.options.model ?? 'model unset')
    const cwd = displayText(this.agent.session.header.cwd ?? process.cwd())
    const detail = displayText(this.agent.session.id)
    const subtitle = this.subtitle()
    const pad = (value: string, target: number, suffix = ''): string => {
      const bounded = truncateToWidth(value, target, suffix)
      return bounded + ' '.repeat(Math.max(0, target - visibleWidth(bounded)))
    }
    let lines: string[]
    if (cardWidth < 76) {
      lines = [
        ` ${title}`,
        ` ${this.palette.bold('Welcome back!')}`,
        ` ${this.palette.dim(`${model} · max effort`)}`,
        ` ${this.palette.dim(cwd)}`,
        ` ${this.palette.dim(subtitle === undefined ? detail : displayText(subtitle))}`,
      ].map(line => truncateToWidth(line, usable, ''))
    } else {
      const innerWidth = cardWidth - 2
      const contentWidth = innerWidth - 5
      // Give the mascot nearly half of the card. Wide terminals have room for
      // the full-resolution brick art, so preserve its detail rather than
      // shrinking it to make the text column dominant.
      const leftWidth = Math.max(38, Math.floor(contentWidth * 0.50))
      const rightWidth = contentWidth - leftWidth
      const border = (value: string): string => this.palette.accent(value)
      const topPrefix = `${border('╭─')} ${title} `
      const top = topPrefix + border('─'.repeat(Math.max(0, cardWidth - visibleWidth(topPrefix) - 1))) + border('╮')
      // Only the information pane advertises clipped copy with an ellipsis.
      // Mascot rows use hard width bounds so no synthetic glyph changes its silhouette.
      const row = (left: string, right: string): string => `${border('│')} ${pad(left, leftWidth)} ${border('│')} ${pad(right, rightWidth, '…')} ${border('│')}`
      const subtitleText = subtitle === undefined ? 'Minimal mode · tools on demand' : displayText(subtitle)
      const center = (value: string, target: number): string => {
        const bounded = truncateToWidth(value, target, '')
        return `${' '.repeat(Math.max(0, Math.floor((target - visibleWidth(bounded)) / 2)))}${bounded}`
      }
      // Keep the complete silhouette inside a safe area. The mascot asset has
      // opaque pixels close to every canvas edge, so the extra blank rows and
      // eight-column inset prevent the hair loop, fins, and water curl from
      // visually colliding with (or appearing clipped by) the card border.
      const rawArt = this.mascot?.render(Math.max(1, leftWidth - 8)) ?? []
      const artWidth = Math.max(0, ...rawArt.map(line => visibleWidth(line)))
      const artIndent = Math.max(0, Math.floor((leftWidth - artWidth) / 2))
      const art = rawArt.length === 0
        ? []
        : ['', ...rawArt.map(line =>
          `${' '.repeat(artIndent)}${truncateToWidth(line, Math.max(1, leftWidth - artIndent), '')}`,
        ), '']
      // Only two identity lines stay below the mascot. Operational metadata
      // belongs to the right-hand console so the silhouette remains complete
      // without growing a long caption tail beneath it.
      const leftLines = [
        ...art,
        center(this.palette.bold('Welcome back!'), leftWidth),
        center(this.palette.dim(`${model} · max effort`), leftWidth),
      ]
      const rightLines = [
        `${this.palette.bold('WORKSPACE')}  ${this.palette.italic(this.palette.dim(cwd))}`,
        `${this.palette.bold('PROFILE')}    ${this.palette.italic(this.palette.dim(subtitleText))}`,
        '',
        this.palette.bold(this.palette.accent('Tips for getting started')),
        `${this.palette.code('/help')} shortcuts and commands`,
        `${this.palette.code('/mcp')} and ${this.palette.code('/agents')} manage extensions`,
        this.palette.dim('─'.repeat(rightWidth)),
        this.palette.bold(this.palette.brand("What's new")),
        'Complete brick mascot with protected edge detail',
        'Crash-safe copy selection and composable inline paste blocks',
        '/mode switches Minimal, Router Standard, and Router Spec profiles',
        '/skills shares available Codex skill catalogs',
        '/workdir switches projects without losing history',
        `${this.palette.code('/bypass')} toggles full access instantly`,
      ]
      const bodyHeight = Math.max(leftLines.length, rightLines.length)
      const rightTop = Math.max(0, Math.floor((bodyHeight - rightLines.length) / 2))
      lines = [
        top,
        ...Array.from({ length: bodyHeight }, (_, index) => row(
          leftLines[index] ?? '',
          rightLines[index - rightTop] ?? '',
        )),
        border(`╰${'─'.repeat(Math.max(0, cardWidth - 2))}╯`),
      ]
    }
    if (this.revealWidth === undefined) return lines
    const revealed = this.revealWidth
    return lines.map(line => truncateToWidth(line, revealed, ''))
  }
}

/**
 * One rounded Claude Code input-rail: `╭─…╮` above the editor or `╰─…╯`
 * below it, with no side rails. The paint role is mutable so the host can
 * switch normal, plan, and always-approve borders without rebuilding the tree.
 */
export class EditorFrameComponent implements Component {
  private paint: ColorRole

  constructor(private readonly top: boolean, paint: ColorRole) {
    this.paint = paint
  }

  /**
   * Replace the frame's color role; the next render picks it up.
   * @param paint - Palette role used for the editor rail.
   */
  setPaint(paint: ColorRole): void {
    this.paint = paint
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return ['']
    if (width === 1) return [this.paint(this.top ? '╭' : '╰')]
    const lead = this.top ? '╭' : '╰'
    return [this.paint(`${lead}${'─'.repeat(Math.max(0, width - 1))}`)]
  }
}

/** Short-lived, right-aligned operation feedback in the input chrome. */
export class StatusToastComponent implements Component {
  private message: string | undefined

  constructor(
    private readonly palette: Palette,
    private readonly paint?: (text: string) => string,
  ) {}

  /**
   * Replace or clear the transient status message.
   * @param message - Message to render, or undefined to hide the toast.
   */
  setMessage(message: string | undefined): void {
    this.message = message
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.message === undefined || width < 1) return []
    const message = truncateToWidth(this.message, width, '')
    const painted = this.paint?.(message) ?? this.palette.code(message)
    return [`${' '.repeat(Math.max(0, width - visibleWidth(message)))}${painted}`]
  }
}

/**
 * A user or steering prompt in the transcript, rendered as a Claude Code rail:
 * every body row carries an accent `❯` marker and the body stays in the
 * terminal's default text tone, so a drag-select copies only the prompt bytes
 * plus its marker. The marker replaces the former underlined `You` header.
 */
export class UserMessageComponent implements Component {
  private readonly markdown: Markdown

  constructor(text: string, private readonly palette: Palette, mdTheme: MarkdownTheme) {
    this.markdown = new Markdown(displayText(text), 0, 0, mdTheme, { color: value => palette.text(value) }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    })
  }

  invalidate(): void {
    this.markdown.invalidate()
  }

  render(width: number): string[] {
    // `❯` plus one separating space. Blank rows keep the bare marker so the
    // rail reads continuously through a multi-paragraph prompt.
    const rail = this.palette.bold(this.palette.accent('❯'))
    const bodyWidth = Math.max(0, width - visibleWidth(rail) - 1)
    return this.markdown.render(bodyWidth).map(line => line.trim() === '' ? rail : `${rail} ${line}`)
  }
}

/**
 * Children of a settled assistant message: optional reasoning block then the
 * response text in the terminal's default tone. Claude Code presents assistant
 * output without a role header; the reasoning block keeps a `✻` glyph so the
 * two channels remain distinguishable.
 */
function assistantMessageChildren(
  content: readonly ContentBlock[],
  showReasoning: boolean,
  foldedContinuation: boolean,
  palette: Palette,
  mdTheme: MarkdownTheme,
  inlineImage?: InlineImageFactory,
): Component[] {
  const reasoning = displayText(textBlocks(content, 'reasoning').trim())
  const body = content.filter(block => block.type === 'text' || block.type === 'image')
  const showsReasoning = reasoning !== '' && showReasoning
  const hasBody = body.some(block => block.type === 'image' || block.text.trim() !== '')
  if (foldedContinuation && !showsReasoning && !hasBody) return []
  const children: Component[] = [new Spacer(1)]
  if (showsReasoning) {
    children.push(
      new Text(palette.italic(palette.dim('✻ Reasoning')), 0, 0),
      new Markdown(reasoning, 0, 0, mdTheme, { color: value => palette.dim(value), italic: true }),
    )
  }
  let pendingText = ''
  const flushText = (): void => {
    const text = displayText(pendingText.trim())
    pendingText = ''
    if (text) children.push(new Markdown(text, 0, 0, mdTheme, { color: value => palette.text(value) }))
  }
  for (const block of body) {
    if (block.type === 'text') {
      pendingText += block.text
      continue
    }
    flushText()
    children.push(inlineImage?.(block) ?? new Text(palette.dim(imageContentText(block)), 0, 0))
  }
  flushText()
  return children
}

/**
 * A step's timing summary, rendered as a self-refreshing footer that stays at
 * the tail of the step's output. Kept separate from the assistant message so
 * the timing line trails any tool cards the step appends after its message.
 */
class StepTimingComponent extends Container {
  private completionTime: number | undefined

  constructor(
    private readonly position: StepPosition,
    private readonly events: () => readonly SessionEvent[],
    private readonly tracker: StepTimingTracker,
    private readonly now: () => number,
    private readonly palette: Palette,
  ) {
    super()
    this.rebuild()
  }

  complete(time: number): void {
    this.completionTime = time
    this.rebuild()
  }

  override invalidate(): void {
    this.rebuild()
    super.invalidate()
  }

  private rebuild(): void {
    this.clear()
    const totals = this.tracker.totalsAt(this.events(), this.position, this.completionTime ?? this.now())
    const timing = formatTimingTotals(totals, true)
    const header = this.completionTime === undefined
      ? timing
      : `${timing} · Completed ${formatCompletionTime(this.completionTime)}`
    this.addChild(new Text(this.palette.dim(header), 0, 0))
  }
}

interface StreamingBlock {
  type: string
  text: string
}

/** A live assistant step: streamed reasoning/text blocks until the message settles. */
export class StreamingAssistantComponent extends Container {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settledContent: readonly ContentBlock[] | undefined
  private foldedContinuation = false
  /**
   * The step's timing footer. The renderer keeps it at the tail of the chat so
   * it trails any tool cards the step appends after this assistant message; it
   * is not a child of this component.
   */
  readonly timing: StepTimingComponent

  constructor(
    /** The step's turn/step coordinates, used to group steps into their turn. */
    readonly position: StepPosition,
    events: () => readonly SessionEvent[],
    tracker: StepTimingTracker,
    now: () => number,
    private showReasoning: boolean,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private readonly inlineImage?: InlineImageFactory,
  ) {
    super()
    this.timing = new StepTimingComponent(position, events, tracker, now, palette)
    this.rebuild()
  }

  /**
   * Replace the streamed blocks with the step's settled content.
   * @param content - The settled assistant content blocks.
   */
  settle(content: readonly ContentBlock[]): void {
    this.settledContent = content
    this.rebuild()
  }

  /**
   * Whether this step's assistant message has settled.
   * @returns `true` once {@link settle} has run.
   */
  isSettled(): boolean {
    return this.settledContent !== undefined
  }

  /**
   * Pin the step's timing footer to its completion time.
   * @param time - Step completion time in epoch milliseconds.
   */
  complete(time: number): void {
    this.timing.complete(time)
  }

  override invalidate(): void {
    this.rebuild()
    this.timing.invalidate()
    super.invalidate()
  }

  /**
   * Fold one streamed chunk into the live block buffer and re-render.
   * @param chunk - The streamed assistant chunk.
   */
  update(chunk: StreamChunk): void {
    if (chunk.type === 'block-start') {
      this.blocks.set(chunk.index, { type: chunk.blockType, text: '' })
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      const block = this.blocks.get(chunk.index) ?? { type, text: '' }
      block.text += chunk.text
      this.blocks.set(chunk.index, block)
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
      this.blocks.set(chunk.index, { type: chunk.block.type, text: chunk.block.text })
    }
    this.rebuild()
    this.timing.invalidate()
  }

  /**
   * Toggle whether reasoning blocks render, then re-render.
   * @param show - Whether to show reasoning blocks.
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.rebuild()
  }

  /**
   * Mark this step as a folded continuation of its turn: no leading spacing,
   * and no output at all while the step has no visible body. Used while tool
   * cards are hidden so a turn reads as one assistant message.
   * @param folded - Whether to render as a continuation.
   */
  setFoldedContinuation(folded: boolean): void {
    if (this.foldedContinuation === folded) return
    this.foldedContinuation = folded
    this.rebuild()
  }

  /**
   * Whether the step currently renders visible reasoning or text.
   * @returns `true` when a full render would show a body.
   */
  hasVisibleBody(): boolean {
    const content = this.presentedContent()
    return content.some(block => block.type === 'image')
      || textBlocks(content, 'text').trim() !== ''
      || (this.showReasoning && textBlocks(content, 'reasoning').trim() !== '')
  }

  /** The settled content when available, otherwise the streamed blocks in model order. */
  private presentedContent(): readonly ContentBlock[] {
    return this.settledContent ?? [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap<ContentBlock>(([, block]) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'reasoning') return [{ type: 'reasoning', text: block.text }]
        return []
      })
  }

  private rebuild(): void {
    this.clear()
    const children = assistantMessageChildren(
      this.presentedContent(),
      this.showReasoning,
      this.foldedContinuation,
      this.palette,
      this.mdTheme,
      this.inlineImage,
    )
    for (const child of children) this.addChild(child)
  }
}

/**
 * A tool card's body split at the Markdown boundary. `prelude` rows are already
 * styled and render verbatim (a terminal `$` command, its cwd, a diff's hunks);
 * `lines` is the tool's own text. A generic card renders both as one Markdown
 * document under the dim body tone.
 */
interface CardBody {
  readonly prelude: readonly string[]
  readonly lines: readonly string[]
}

/**
 * Ctrl+O card-visibility cycle: `hidden` drops tool cards from the transcript,
 * `collapsed` previews the first body lines, `expanded` shows everything.
 */
export type ToolCardVisibility = 'hidden' | 'collapsed' | 'expanded'

/**
 * Transcript card with a width-keyed rendered-row cache. pi-tui re-renders
 * every component each frame and relies on per-component line caches (its own
 * `Text`/`Markdown` do this); a card that rebuilds rows inside `render(width)`
 * would re-wrap its output every frame
 * ([rendering contract](../../README.md)).
 * Subclasses render through {@link renderLines} and call {@link dropLines}
 * from every state mutator; with `invalidate()` (pi-tui's tree-wide cascade)
 * also dropping, a state change always re-renders.
 */
abstract class CachedCardComponent implements Component {
  private cached: { width: number; lines: string[] } | undefined

  /** Discard the cached rows so the next render recomputes them. */
  protected dropLines(): void {
    this.cached = undefined
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(width: number): string[] {
    if (this.cached?.width !== width) this.cached = { width, lines: this.renderLines(width) }
    return this.cached.lines
  }

  /**
   * Render the card's rows for `width` without caching.
   * @param width - Render width the rows are wrapped to.
   * @returns The card's rows.
   */
  protected abstract renderLines(width: number): string[]
}

/** A tool call and its result, rendered as a collapsible status card. */
export class ToolCardComponent extends CachedCardComponent {
  private result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue } | undefined
  private visibility: ToolCardVisibility = 'collapsed'
  private callView: ToolCallView
  private resultView: ToolResultView | undefined
  private diffBodyCache: { view: ToolCallView | ToolResultView; body: CardBody } | undefined
  private readonly startedAt: number
  private finishedAt: number | undefined

  constructor(
    private readonly name: string,
    private readonly parsed: ParsedArguments,
    private readonly definition: ToolDefinition | undefined,
    private readonly maxOutputLines: number,
    private readonly maxDiffEditLength: number,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    startedAt: number,
  ) {
    super()
    this.startedAt = startedAt
    this.callView = this.presentCall()
  }

  private presentCall(): ToolCallView {
    if (this.parsed.valid && this.definition?.presentCall) {
      try {
        const view = this.definition.presentCall(this.parsed.value)
        if (view !== undefined) return view
      } catch (error: unknown) {
        return { card: 'generic', title: displayText(this.name), rawInput: `Presenter failed: ${String(error)}` }
      }
    }
    return { card: 'generic', title: displayText(this.name), rawInput: this.parsed.value }
  }

  /**
   * Record the tool result and derive its result view.
   * @param event - The `tool/result` event payload.
   * @param time - Event timestamp, the tool's completion clock.
   */
  updateResult(event: Extract<SessionEvent, { type: 'tool/result' }>['data'], time: number): void {
    this.diffBodyCache = undefined
    this.finishedAt = time
    this.dropLines()
    const result = event.message.content[0]
    this.result = {
      content: [...result.content],
      isError: result.isError === true,
      ...event.meta !== undefined ? { meta: event.meta } : {},
    }
    if (this.parsed.valid && this.definition?.presentResult) {
      try {
        const view = this.definition.presentResult(this.parsed.value, this.result)
        if (view !== undefined) this.resultView = view
      } catch (error: unknown) {
        this.resultView = { card: 'generic', content: [{ type: 'text', text: `Presenter failed: ${String(error)}` }] }
      }
    }
  }

  /**
   * Set the card's visibility state.
   * @param visibility - Hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    this.dropLines()
  }

  protected renderLines(width: number): string[] {
    // Hidden renders nothing — not even the leading gap — so the transcript
    // keeps only the conversation, the way Codex hides tool calls.
    if (this.visibility === 'hidden') return []
    const isError = this.result?.isError ?? false
    const rawBody = this.renderBody()
    const view = this.resultView ?? this.callView
    // A generic card's own content, a read card's `content` fallback (the
    // envelope-stripped file text — the TUI has no dedicated read rendering, so a
    // read renders exactly as before the read card existed), or a search/web
    // card's fallback to the raw result content (neither the `search` nor the
    // `web` view carries a `content` copy), all render as one dim Markdown block
    // below, so links/lists/headings keep the unified dim styling rather than
    // reading as bare text. A search card thus stays byte-identical to the
    // pre-search-card generic fallback. Terminal and diff cards own their body
    // styling, so they are excluded (mirrors renderBody's post-terminal/diff fallback).
    const markdownContent = view.card === 'generic' || view.card === 'read'
      ? view.content ?? this.result?.content
      : view.card === 'search'
        ? this.result?.content
        : view.card === 'web'
          // A web resultView is only assigned alongside this.result (the result
          // handler sets both) and the pending callView is never a web card, so
          // the optional-chain undefined side is unreachable here.
          /* v8 ignore next */
          ? this.result?.content
          : undefined
    const unknownXml = this.definition === undefined && markdownContent !== undefined
      ? renderUnknownXml(
        displayText(contentText(markdownContent)),
        this.maxOutputLines,
        this.visibility === 'expanded',
        displayText,
        text => this.palette.dim(text),
        text => this.palette.dim(text),
        /* v8 ignore next -- renderUnknownXml calls the collapsed summary only when hidden XML children exceed this card's limit. */
        count => this.palette.dim(`  … +${count} lines (Ctrl+O to expand)`),
      )
      : undefined
    // A generic card renders title and result as one Markdown document, so the
    // document's own block spacing is preserved, then dims every row — the whole
    // card body reads as one dim block under the family-colored title.
    const body = unknownXml ?? (markdownContent !== undefined && rawBody.lines.length > 0
      ? this.dimBody(rawBody, width)
      : [...rawBody.prelude, ...rawBody.lines])
    const visibleBody = unknownXml !== undefined || this.visibility === 'expanded'
      ? body
      : preview(body, this.maxOutputLines, count => this.palette.dim(`… +${count} lines (Ctrl+O to expand)`))
    // Claude Code card header: a status bullet plus a bold `Verb(argument)`
    // title painted by tool family, with the model-authored bash description
    // and a bounded elapsed time in dim. The title is escaped inline so a
    // multi-line command cannot break the single header row.
    const pending = this.result === undefined
    const bullet = pending ? '⠋' : isError ? '✗' : '›'
    const bulletPaint = pending ? this.palette.dim : isError ? this.palette.error : this.palette.success
    const titlePaint = toolCardColor(this.name, this.palette)
    const summary = this.parsed.valid ? toolCardArgSummary(this.name, this.parsed.value) : undefined
    const derivedTitle = toolCardTitle(this.name, this.parsed.valid ? this.parsed.value : undefined)
    // A terminal card without a derivable argument still keeps its command in
    // the header; the bare verb would otherwise erase the one piece of
    // information that card carries.
    const terminalTitle = view.card === 'terminal' ? this.terminalPending()?.title : undefined
    const title = summary === undefined && terminalTitle !== undefined && terminalTitle !== ''
      ? `Run(${terminalTitle})`
      : derivedTitle
    const desc = this.headerDescription()
    // Sub-second deltas are process-scheduling noise and would make live
    // snapshots unreplayable; report a duration once it carries signal.
    const elapsedMs = this.finishedAt === undefined ? undefined : this.finishedAt - this.startedAt
    const elapsed = elapsedMs === undefined || elapsedMs < 1_000
      ? ''
      : ` ${this.palette.dim(`(${formatToolElapsed(elapsedMs)})`)}`
    const header = `${bulletPaint(bullet)} ${this.palette.bold(titlePaint(displayInlineText(title)))}${desc === undefined ? '' : `${this.palette.dim(' · ')}${this.palette.dim(displayInlineText(desc))}`}${elapsed}`
    // The blank first row is the card's own paragraph gap (no external Spacer),
    // so the hidden state removes the gap together with the card.
    const lines: string[] = ['', truncateToWidth(header, Math.max(1, width - 2), '')]
    if (visibleBody.length > 0) {
      const bodyLines = new Text(visibleBody.join('\n'), 0, 0).render(Math.max(1, width - 3))
      lines.push(
        ...bodyLines.map((line, index) => index === 0
          ? `${this.palette.dim('⎿  ')}${line}`
          : `   ${line}`),
      )
    }
    return lines
  }

  /** The pending terminal call view, when this row is a terminal card. */
  private terminalPending(): TerminalCallView | undefined {
    return this.callView.card === 'terminal' ? this.callView : undefined
  }

  /**
   * The optional ` · <desc>` header segment: a bash (terminal) card's
   * model-authored description. Non-terminal tools contribute no header detail —
   * their presenter title moves into the body instead.
   */
  private headerDescription(): string | undefined {
    const description = this.terminalPending()?.description
    return description !== undefined && description !== '' ? description : undefined
  }

  /**
   * The presenter's title for a non-terminal card, shown as the first body line
   * (a read's `Read src/foo.ts`, a diff's `Edit files`) now that the header is
   * a `Verb(argument)` summary. The result-state title replaces the pending one.
   */
  private bodyTitle(): string {
    return this.resultView?.title ?? this.callView.title
  }

  private renderBody(): CardBody {
    const view = this.resultView ?? this.callView
    if (view.card === 'terminal') {
      // The `Run(command)` header already echoes the command, so the body keeps
      // only output and exit metadata, the way Claude Code's Bash card does.
      const lines: string[] = []
      if (this.resultView?.card === 'terminal') {
        if (this.resultView.output) lines.push(...this.dimOutput(this.resultView.output))
        if (this.resultView.exitCode !== undefined) lines.push(this.palette.dim(`[exit ${this.resultView.exitCode}]`))
        if (this.resultView.signal !== undefined) {
          lines.push(this.palette.error(`[signal ${displayText(this.resultView.signal)}]`))
        }
      } else if (this.result !== undefined) {
        lines.push(...this.dimOutput(contentText(this.result.content)))
      }
      return { prelude: [], lines: lines.filter(Boolean) }
    }
    if (view.card === 'diff') {
      if (this.diffBodyCache?.view === view) return this.diffBodyCache.body
      // The header no longer names the file, so each diff keeps its own path
      // header. A trailing footer summarizes the exact changed rows when the
      // bounded comparison succeeds (`+A -R · N file(s)`).
      const renderedDiffs = view.diffs.map(diff =>
        renderDiff(diff, this.maxDiffEditLength, this.palette),
      )
      const added = renderedDiffs.reduce((total, rendered) => total + rendered.added, 0)
      const removed = renderedDiffs.reduce((total, rendered) => total + rendered.removed, 0)
      const approximate = renderedDiffs.some(rendered => rendered.approximate)
      const hunks = renderedDiffs.flatMap((rendered, index) => {
        return [...index > 0 ? [''] : [], ...rendered.lines]
      })
      const files = new Set(view.diffs.map(diff => diff.path)).size
      const footer = this.palette.dim(
        `└ +${added} -${removed} · ${files} file${files === 1 ? '' : 's'}${approximate ? ' · approximate' : ''}`,
      )
      // A diff's own `+`/`-` colors carry its meaning, so it renders verbatim
      // rather than under the dim result-output color.
      const body = { prelude: [...hunks, footer], lines: [] }
      this.diffBodyCache = { view, body }
      return body
    }
    // A generic or read card carries its own envelope-stripped `content`; a
    // search or web card carries no `content` copy and falls back to the raw
    // result content here. (Mirrors the `markdownContent` selection in render();
    // a read card has no dedicated TUI rendering, so its `content` takes the same
    // body path, keeping read output as it was before the read card existed, and
    // a search card stays byte-identical to the pre-search-card fallback.)
    const content = (view.card === 'generic' || view.card === 'read' ? view.content : undefined) ?? this.result?.content
    const prelude: string[] = []
    const lines: string[] = []
    // The presenter title headlines the body now that the header is a
    // `Verb(argument)` summary (a terminal card keeps its output only).
    // Skip it when it only repeats the tool name (the fallback presenter for a
    // tool with no presentCall, or an unknown tool), which the header already shows.
    const bodyTitle = this.bodyTitle()
    if (bodyTitle !== displayText(this.name)) prelude.push(displayInlineText(bodyTitle))
    if (content !== undefined) lines.push(...displayText(contentText(content)).split('\n'))
    const rawInput = this.result === undefined && this.callView.card === 'generic'
      ? this.callView.rawInput
      : undefined
    if (rawInput !== undefined) lines.push(...pretty(rawInput).split('\n'))
    // Blank-line trimming spans the whole body, so the title counts as a row:
    // interior blanks (a result's own paragraph break) survive while the body's
    // leading and trailing ones are dropped.
    const total = prelude.length + lines.length
    return {
      prelude,
      lines: lines.filter((line, index) => {
        const row = prelude.length + index
        return line.length > 0 || (row > 0 && row < total - 1)
      }),
    }
  }

  /**
   * A tool's own output text as dim rows — the card's result-output color, which
   * separates what the tool produced from the card's own framing. A blank row
   * stays the empty string so the terminal branch's blank-row filter still reads
   * it as blank instead of as an ANSI-wrapped value.
   */
  private dimOutput(text: string): string[] {
    return displayText(text).split('\n').map(line => line === '' ? line : this.palette.dim(line))
  }

  /**
   * Render a generic card's prelude and result as one Markdown document under the
   * dim body tone. Rendering both together preserves the document's own block
   * spacing (Markdown's blank row before a heading); dimming every row keeps the
   * card body one uniform tone, so only the family-colored title carries color.
   */
  private dimBody(body: CardBody, width: number): string[] {
    const rows = new Markdown([...body.prelude, ...body.lines].join('\n'), 0, 0, this.mdTheme, {
      color: value => this.palette.text(value),
    }).render(width)
    // A whitespace-only row carries no output to dim; leaving it unwrapped keeps
    // Markdown's padding out of the styled ranges.
    return rows.map(row => row.trim() === '' ? row : this.palette.dim(row))
  }
}

/**
 * Matches a lone reminder-frame tag on its own line, capturing the element name.
 * Producers emit the frame as whole lines (`workspace-context`, `dsh-tool-skill`),
 * so anchoring the whole line keeps a tag mentioned inside prose from matching.
 */
const REMINDER_FRAME_LINE = /^<(\/?)([a-zA-Z][\w:.-]*)>$/u

/**
 * Drop a producer's outer reminder frame, keeping the instruction body verbatim.
 * The card header already names the source, so the frame lines carry nothing.
 * Only a matched open/close pair on the first and last lines is removed, so a
 * body that merely starts with a tag-like line is left intact.
 * @param text - Complete model-facing context text.
 * @returns The body without its outer frame lines, trimmed of the blank lines they leave.
 */
function stripReminderFrame(text: string): string {
  // A frame needs an open line and a distinct close line, so anything shorter than
  // two lines is already frameless.
  const [first = '', ...rest] = text.split('\n')
  const last = rest.at(-1)
  if (last === undefined) return text
  const open = REMINDER_FRAME_LINE.exec(first.trim())
  const close = REMINDER_FRAME_LINE.exec(last.trim())
  if (open?.[1] !== '' || close?.[1] !== '/' || open[2] !== close[2]) return text
  return rest.slice(0, -1).join('\n').replace(/^\n+|\n+$/gu, '')
}

/**
 * Injected context (plugin/goal source, e.g. `workspace-context`), rendered as a
 * collapsible dim card that shares the tool-card `Ctrl+O` toggle. The header is
 * `Context · <label>`; the body is the message text as dim prose, one tone with
 * the header and the fold marker, folded to `maxOutputLines`, with a surrounding
 * reminder frame stripped because the source label already names the context.
 *
 * Injected context is prose, not markup, so this card does not parse it. The
 * `<system-reminder>` frame is a prompting convention no model is trained on
 * ([envelope rationale](../../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md)),
 * and instruction bodies legitimately contain a raw `&` or angle-bracket
 * placeholders (`packages/<group>/<pkg>/`, `-t <name>`) that are prose rather than
 * elements. Tree-rendering such a payload depended on whether it happened to be
 * well-formed XML, which made both the fold and the frame-line suppression
 * content-dependent.
 */
export class ContextCardComponent extends CachedCardComponent {
  private expanded = false

  constructor(
    private readonly label: string,
    private readonly text: string,
    private readonly maxOutputLines: number,
    private readonly palette: Palette,
  ) {
    super()
  }

  /**
   * Expand or collapse the card body.
   * @param expanded - Whether the full body is shown.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.dropLines()
  }

  protected renderLines(width: number): string[] {
    const header = this.palette.dim(`Context · ${displayText(this.label)}`)
    // Emptiness is decided on the stripped text: styling a blank body would yield
    // one escape-only row, which reads as a stray blank line under the header.
    const stripped = stripReminderFrame(this.text)
    if (stripped === '') return [header]
    const body = stripped.split('\n')
      .map(line => line === '' ? line : this.palette.dim(displayText(line)))
    const visibleBody = this.expanded
      ? body
      : preview(body, this.maxOutputLines, count => this.palette.dim(`… +${count} lines (Ctrl+O to expand)`))
    return [header, ...new Text(visibleBody.join('\n'), 0, 0).render(width)]
  }
}

/** The plan/todo panel rendered above the prompt. */
export class TodoComponent implements Component {
  private todos: readonly TodoItem[] = []

  constructor(private readonly palette: Palette) {}

  /**
   * Replace the rendered plan items.
   * @param todos - The current todo items.
   */
  update(todos: readonly TodoItem[]): void {
    this.todos = todos
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return []
    const lines: string[] = [this.palette.bold(this.palette.accent('Plan'))]
    for (const todo of this.todos) {
      const prefix = todo.status === 'completed'
        ? this.palette.success('✓')
        : todo.status === 'in_progress'
          ? this.palette.warning('●')
          : this.palette.dim('○')
      const content = displayText(todo.content)
      const text: string = todo.status === 'completed' ? this.palette.dim(content) : content
      lines.push(truncateToWidth(`  ${prefix} ${text}`, width, ''))
    }
    return ['', ...lines]
  }
}
