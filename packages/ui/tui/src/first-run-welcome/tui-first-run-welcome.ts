/**
 * Effect-owned first-run overlay for the shipped `dsh` TUI.
 *
 * The `ui-tui` plugin mounts this notice plugin on its own context when a
 * profile configures one; the plugin's `inject: ['tui']` fiber waits for the
 * channel-mounted overlay service, and the plugin owns the per-DSH_HOME
 * acknowledgement boundary. The component reaches the terminal only through
 * the mounted `ctx.tui` overlay service and never touches the session or
 * model context.
 * @module @deepseek-ai/dsh-tui/first-run-welcome
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import {
  disposeRootAndExit,
  type TuiComponent,
  type TuiFocusable,
  type TuiOverlayHost,
} from '../index.ts'
import {
  TUI_FIRST_RUN_WELCOME_NOTICE_COPY,
  TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE,
  TUI_FIRST_RUN_WELCOME_NOTICE_VERSION,
  type TuiFirstRunWelcomeNoticeCopy,
} from './tui-first-run-welcome-copy.ts'
import {
  TUI_FIRST_RUN_WELCOME_WHALE,
  type TuiFirstRunWelcomeArtTier,
} from './tui-first-run-welcome-art.ts'

// TODO: Move acknowledgement persistence behind @deepseek-ai/dsh-storage once
// its backend contract supports concurrent host processes. This same-value
// marker must not inherit JSON lost updates or SQLite busy failures.
const ACKNOWLEDGEMENT_DIRECTORY = 'notices'
const ACKNOWLEDGEMENT_BASENAME = 'tui-first-run-welcome'

/** Cordis plugin name. */
export const name = 'tui-first-run-welcome'
/** The notice can open only after the terminal-local overlay service mounts. */
export const inject = ['tui']

/** Harness-home roots that already presented the notice in this process. */
const shownRoots = new WeakSet<object>()

/** Profile-resolved configuration for the terminal-local notice. */
export interface Config {
  /** Absolute DeepSeek Harness home owning this acknowledgement. */
  readonly dshHome: string
  /** Render the bit-equivalent printable ASCII icon fallback. */
  readonly asciiArt?: boolean
}

/**
 * Detect an explicitly non-Unicode terminal locale for the static ASCII art fallback.
 * @param env - Process environment carrying locale and terminal declarations.
 * @returns `true` only when the environment explicitly declares an ASCII-only locale or dumb terminal.
 */
export function needsTuiFirstRunWelcomeAsciiArt(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG
  return env.TERM === 'dumb' || locale === 'C' || locale === 'POSIX'
}

/**
 * Resolve the immutable marker for one notice version.
 * @param dshHome - Resolved Harness home.
 * @param version - Copy version whose acknowledgement is queried.
 * @returns Absolute marker path beneath the Harness home.
 */
export function tuiFirstRunWelcomeAcknowledgementPath(dshHome: string, version: number): string {
  return join(
    dshHome,
    ACKNOWLEDGEMENT_DIRECTORY,
    `${ACKNOWLEDGEMENT_BASENAME}-v${String(version)}.ack`,
  )
}

/**
 * Test whether one notice version has been acknowledged.
 * @param dshHome - Resolved Harness home.
 * @param version - Copy version to inspect.
 * @returns `true` only for a regular marker file; a malformed marker fails loud.
 */
export async function hasTuiFirstRunWelcomeAcknowledgement(
  dshHome: string,
  version: number = TUI_FIRST_RUN_WELCOME_NOTICE_VERSION,
): Promise<boolean> {
  const path = tuiFirstRunWelcomeAcknowledgementPath(dshHome, version)
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`TUI welcome acknowledgement is not a file: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Persist one version acknowledgement by syncing a random same-directory file
 * before atomically replacing the immutable marker. Concurrent launches publish
 * the same fact, so same-value last-writer-wins replacement loses no state.
 * @param dshHome - Resolved Harness home.
 * @param version - Copy version being acknowledged.
 */
export async function acknowledgeTuiFirstRunWelcome(
  dshHome: string,
  version: number = TUI_FIRST_RUN_WELCOME_NOTICE_VERSION,
): Promise<void> {
  const path = tuiFirstRunWelcomeAcknowledgementPath(dshHome, version)
  const directory = dirname(path)
  const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await syncDirectory(dirname(directory))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.sync()
    const created = handle
    handle = undefined
    await created.close()
    try {
      await rename(temp, path)
    } catch (error) {
      // Windows refuses the replace (EPERM) while a concurrent launcher holds
      // the destination open mid-commit. The marker is immutable and
      // same-valued, so an already-committed destination loses no state.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EPERM') throw error
      if (await hasTuiFirstRunWelcomeAcknowledgement(dshHome, version)) {
        await rm(temp, { force: true }).catch(() => {})
        return
      }
      throw error
    }
  } catch (error) {
    /* v8 ignore start -- fault-injected UI coverage proves failed acknowledgements stay uncommitted and retryable */
    try {
      await handle?.close()
    } finally {
      await rm(temp, { force: true })
    }
    throw error
    /* v8 ignore stop */
  }
  try {
    await syncDirectory(directory)
  /* v8 ignore next -- rename is the commit point; directory-fsync fault injection is platform-specific */
  } catch {
    // Swallow post-rename directory fsync failure: the marker is already committed,
    // and crash loss can only make the notice reappear on the safe side.
  }
}

/** Sync one POSIX directory after publishing a child entry. */
/* v8 ignore start -- Windows rejects directory opens; POSIX unit coverage owns this path. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

/** Render one visible-width-padded line inside the notice frame. */
function framed(content: string, innerWidth: number, host: TuiOverlayHost): string {
  const clipped = truncateToWidth(content, innerWidth, '')
  return `${host.theme.dim('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${host.theme.dim('│')}`
}

/** Center one line by terminal column width. */
function centered(content: string, width: number): string {
  const clipped = truncateToWidth(content, width, '')
  const remaining = Math.max(0, width - visibleWidth(clipped))
  return `${' '.repeat(Math.floor(remaining / 2))}${clipped}`
}

/**
 * Select the art tier for the actual overlay width and viewport height.
 * @param innerWidth - Columns inside the frame.
 * @param viewportRows - Current terminal rows.
 * @returns full, compact, minimal, or no art when prose must take priority.
 */
export function tuiFirstRunWelcomeArtTier(
  innerWidth: number,
  viewportRows: number,
): TuiFirstRunWelcomeArtTier | undefined {
  const compositionCapacity = Math.max(1, Math.max(7, Math.floor(viewportRows * 0.9)) - 5)
  if (innerWidth >= 96 && TUI_FIRST_RUN_WELCOME_WHALE.full.unicode.length <= compositionCapacity) return 'full'
  if (innerWidth >= 80 && TUI_FIRST_RUN_WELCOME_WHALE.compact.unicode.length + 4 <= compositionCapacity) return 'compact'
  if (innerWidth >= 64 && TUI_FIRST_RUN_WELCOME_WHALE.minimal.unicode.length + 4 <= compositionCapacity) return 'minimal'
  return undefined
}

/** Wrap the centrally owned prose while promoting its opening quotation. */
function proseLines(
  copy: TuiFirstRunWelcomeNoticeCopy,
  width: number,
  host: TuiOverlayHost,
): string[] {
  const lines: string[] = []
  for (const [index, paragraph] of copy.paragraphs.entries()) {
    if (index > 0) lines.push('')
    const quoteEnd = paragraph.startsWith('“') ? paragraph.indexOf('”') : -1
    if (quoteEnd > 0) {
      const quote = paragraph.slice(0, quoteEnd + 1)
      const remainder = paragraph.slice(quoteEnd + 1).trimStart()
      lines.push(...wrapTextWithAnsi(host.theme.bold(host.theme.text(host.display(quote))), width))
      lines.push('')
      if (remainder !== '') lines.push(...wrapTextWithAnsi(host.theme.text(host.display(remainder)), width))
    } else {
      lines.push(...wrapTextWithAnsi(host.theme.text(host.display(paragraph)), width))
    }
  }
  return lines
}

/** Render centered static brand art without putting ANSI into its owner file. */
function artLines(
  tier: TuiFirstRunWelcomeArtTier,
  width: number,
  host: TuiOverlayHost,
  asciiArt: boolean,
): string[] {
  const art = TUI_FIRST_RUN_WELCOME_WHALE[tier][asciiArt ? 'ascii' : 'unicode']
  return art.map(line => centered(host.theme.brand(line), width))
}

/** Responsive, scrollable notice whose only completion input is Enter. */
export class TuiFirstRunWelcomeComponent implements TuiComponent, TuiFocusable {
  focused = false
  private scrollOffset = 0
  private bodyCapacity = 1
  private maxScrollOffset = 0
  private saving = false
  private saveFailed = false

  constructor(
    private readonly host: TuiOverlayHost,
    private readonly copy: TuiFirstRunWelcomeNoticeCopy,
    private readonly acknowledge: () => Promise<void>,
    private readonly exit: () => void,
    private readonly asciiArt = false,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const frameWidth = Math.max(6, width)
    const innerWidth = Math.max(1, frameWidth - 4)
    const viewportRows = this.host.viewport.rows
    const tier = tuiFirstRunWelcomeArtTier(innerWidth, viewportRows)
    const availableRows = Math.max(7, Math.floor(viewportRows * 0.9))
    const title = this.host.theme.bold(this.host.theme.brand(this.copy.title))
    let fixedHeader: string[] = []
    let fullContentHeader: string[] = []
    let body: string[]
    let fullArt: string[] | undefined
    const fullArtWidth = 44

    if (tier === 'full') {
      fullArt = artLines(tier, fullArtWidth, this.host, this.asciiArt)
      const contentWidth = Math.max(1, innerWidth - fullArtWidth - 3)
      fullContentHeader = [centered(title, contentWidth), '']
      body = proseLines(this.copy, contentWidth, this.host)
    } else {
      const art = tier === undefined ? [] : artLines(tier, innerWidth, this.host, this.asciiArt)
      fixedHeader = [...art, ...art.length === 0 ? [] : [''], centered(title, innerWidth), '']
      body = proseLines(this.copy, innerWidth, this.host)
    }

    const compositionCapacity = Math.max(1, availableRows - 5)
    const bodyLimit = Math.max(1, compositionCapacity - fixedHeader.length - fullContentHeader.length)
    this.bodyCapacity = Math.min(body.length, bodyLimit)
    const maxOffset = Math.max(0, body.length - this.bodyCapacity)
    this.maxScrollOffset = maxOffset
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + this.bodyCapacity)

    const top = this.host.theme.dim(`╭${'─'.repeat(Math.max(0, frameWidth - 2))}╮`)
    const separator = this.host.theme.dim(`├${'─'.repeat(Math.max(0, frameWidth - 2))}┤`)
    const bottom = this.host.theme.dim(`╰${'─'.repeat(Math.max(0, frameWidth - 2))}╯`)
    const action = this.host.theme.bold(this.host.theme.accent(`Enter  ${this.copy.continueLabel}`))
    const hasAbove = this.scrollOffset > 0
    const hasBelow = this.scrollOffset < maxOffset
    const scroll = hasAbove || hasBelow
      ? `${hasAbove ? '↑' : ' '} ${this.copy.scrollHint} ${hasBelow ? '↓' : ' '}`
      : ''
    const status = this.saveFailed
      ? this.host.theme.error(this.copy.saveError)
      : this.saving
        ? this.host.theme.dim(this.copy.saving)
        : this.host.theme.dim(scroll)

    const fullContent = [...fullContentHeader, ...visibleBody]
    const composition = fullArt === undefined
      ? [...fixedHeader, ...visibleBody]
      : Array.from({ length: Math.max(fullArt.length, fullContent.length) }, (_, index) => {
        const art = fullArt[index] ?? ''
        const line = fullContent[index] ?? ''
        const left = `${art}${' '.repeat(Math.max(0, fullArtWidth - visibleWidth(art)))}`
        return `${left}   ${line}`
      })

    return [
      top,
      ...composition.map(line => framed(line, innerWidth, this.host)),
      separator,
      framed(centered(action, innerWidth), innerWidth, this.host),
      framed(centered(status, innerWidth), innerWidth, this.host),
      bottom,
    ]
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.exit()
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (!this.saving) void this.commit()
      return
    }
    if (this.saving || matchesKey(data, Key.escape)) return
    if (matchesKey(data, Key.up)) this.scrollBy(-1)
    else if (matchesKey(data, Key.down)) this.scrollBy(1)
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.bodyCapacity)
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyCapacity)
    else if (matchesKey(data, Key.home)) this.scrollTo(0)
    else if (matchesKey(data, Key.end)) this.scrollTo(this.maxScrollOffset)
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollOffset + delta)
  }

  private scrollTo(offset: number): void {
    this.scrollOffset = Math.min(this.maxScrollOffset, Math.max(0, offset))
    this.host.invalidate()
  }

  private async commit(): Promise<void> {
    this.saving = true
    this.saveFailed = false
    this.host.invalidate()
    try {
      await this.acknowledge()
      this.host.close()
    } catch {
      this.saving = false
      this.saveFailed = true
      this.host.invalidate()
    }
  }
}

/**
 * Open the first-run notice through the mounted TUI's FIFO overlay owner.
 *
 * The `ui-tui` plugin mounts this plugin on its channel context once the
 * profile configures `firstRunWelcome`; the inject fiber loads on the first
 * channel mount and re-runs when a resume swap remounts the channel service.
 * Gate once per Harness-home root (one process, one root): a re-run before
 * the acknowledgement lands must not stack a second notice.
 * @param ctx - Plugin context carrying the terminal-local TUI service.
 * @param config - Profile-resolved Harness home and art preference.
 */
export function apply(ctx: Context, config: Config): void {
  const root = ctx.root as object
  if (shownRoots.has(root)) return
  shownRoots.add(root)
  void hasTuiFirstRunWelcomeAcknowledgement(config.dshHome).then((acknowledged) => {
    if (acknowledged) return
    const copy = TUI_FIRST_RUN_WELCOME_NOTICE_COPY[TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE]
    const pending = new Set<Promise<void>>()
    const acknowledge = (): Promise<void> => {
      const task = acknowledgeTuiFirstRunWelcome(config.dshHome)
      pending.add(task)
      const settled = (): void => { pending.delete(task) }
      void task.then(settled, settled)
      return task
    }
    ctx.effect(() => async () => {
      await Promise.allSettled(pending)
    }, 'tui first-run welcome acknowledgement')
    ctx.tui.openOverlay({
      create: host => new TuiFirstRunWelcomeComponent(
        host,
        copy,
        acknowledge,
        () => { disposeRootAndExit(ctx, 0) },
        config.asciiArt ?? needsTuiFirstRunWelcomeAsciiArt(),
      ),
      options: {
        width: '100%',
        maxHeight: '90%',
        anchor: 'center',
        margin: 0,
      },
    })
  })
}
