import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  type TuiOverlayHost,
  type TuiOverlayRequest,
  type TuiTheme,
} from '../src/index.ts'
import {
  acknowledgeTuiFirstRunWelcome,
  apply,
  hasTuiFirstRunWelcomeAcknowledgement,
  needsTuiFirstRunWelcomeAsciiArt,
  TuiFirstRunWelcomeComponent,
  tuiFirstRunWelcomeAcknowledgementPath,
  tuiFirstRunWelcomeArtTier,
} from '../src/first-run-welcome/tui-first-run-welcome.ts'
import * as firstRunWelcome from '../src/first-run-welcome/tui-first-run-welcome.ts'
import {
  TUI_FIRST_RUN_WELCOME_NOTICE_COPY,
  TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE,
  TUI_FIRST_RUN_WELCOME_NOTICE_VERSION,
} from '../src/first-run-welcome/tui-first-run-welcome-copy.ts'
import { TUI_FIRST_RUN_WELCOME_WHALE } from '../src/first-run-welcome/tui-first-run-welcome-art.ts'

const mockDisposeRootAndExit = vi.hoisted(() => vi.fn())
vi.mock('../src/index.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/index.ts')>(),
  disposeRootAndExit: mockDisposeRootAndExit,
}))

const identityTheme: TuiTheme = Object.freeze({
  text: (value: string) => value,
  brand: (value: string) => value,
  dim: (value: string) => value,
  accent: (value: string) => value,
  success: (value: string) => value,
  warning: (value: string) => value,
  error: (value: string) => value,
  bold: (value: string) => value,
})

function hostFixture(rows: number): {
  host: TuiOverlayHost
  closed: () => boolean
  invalidations: () => number
} {
  let closed = false
  let invalidations = 0
  const controller = new AbortController()
  return {
    host: Object.freeze({
      signal: controller.signal,
      viewport: Object.freeze({ columns: 160, rows }),
      theme: identityTheme,
      display: (value: string) => value,
      invalidate: () => { invalidations += 1 },
      close: () => { closed = true },
    }),
    closed: () => closed,
    invalidations: () => invalidations,
  }
}

const copy = TUI_FIRST_RUN_WELCOME_NOTICE_COPY[TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE]
const openingSentence = `${copy.paragraphs[0]!.split('。', 1)[0]}。`
const temporaryHomes: string[] = []

function artAnchor(tier: keyof typeof TUI_FIRST_RUN_WELCOME_WHALE): string {
  return TUI_FIRST_RUN_WELCOME_WHALE[tier].unicode[tier === 'full' ? 2 : 0]!.trim()
}

function withoutWhitespace(value: string): string {
  return value.replace(/\s/gu, '')
}

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  temporaryHomes.push(home)
  return home
}

/** A context whose provided `tui` service records overlay requests. */
function tuiServiceContext(): {
  ctx: Context
  requests: TuiOverlayRequest[]
} {
  const ctx = new Context()
  const requests: TuiOverlayRequest[] = []
  ctx.provide('tui', {
    openOverlay(value: TuiOverlayRequest) {
      requests.push(value)
      return {} as never
    },
  } as never)
  return { ctx, requests }
}

afterEach(async () => {
  mockDisposeRootAndExit.mockClear()
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('TUI first-run welcome acknowledgement', () => {
  it('publishes one immutable per-version marker safely across concurrent acknowledgements', async () => {
    const home = await temporaryHome('dsh-tui-welcome-ack-')
    expect(await hasTuiFirstRunWelcomeAcknowledgement(home)).toBe(false)

    await Promise.all(Array.from({ length: 8 }, () => acknowledgeTuiFirstRunWelcome(home)))

    expect(await hasTuiFirstRunWelcomeAcknowledgement(home)).toBe(true)
    const info = await stat(tuiFirstRunWelcomeAcknowledgementPath(home, TUI_FIRST_RUN_WELCOME_NOTICE_VERSION))
    expect(info.isFile()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600)
  })

  it('treats a notice-version bump as a new one-time acknowledgement', async () => {
    const home = await temporaryHome('dsh-tui-welcome-version-')
    await acknowledgeTuiFirstRunWelcome(home)
    const nextVersion = TUI_FIRST_RUN_WELCOME_NOTICE_VERSION + 1

    expect(await hasTuiFirstRunWelcomeAcknowledgement(home, nextVersion)).toBe(false)
    await acknowledgeTuiFirstRunWelcome(home, nextVersion)
    expect(await hasTuiFirstRunWelcomeAcknowledgement(home, nextVersion)).toBe(true)
  })

  it('rejects a malformed marker instead of silently acknowledging it', async () => {
    const home = await temporaryHome('dsh-tui-welcome-malformed-')
    await mkdir(tuiFirstRunWelcomeAcknowledgementPath(home, TUI_FIRST_RUN_WELCOME_NOTICE_VERSION), {
      recursive: true,
    })
    await expect(hasTuiFirstRunWelcomeAcknowledgement(home)).rejects.toThrow('is not a file')
    await expect(acknowledgeTuiFirstRunWelcome(home)).rejects.toThrow()
  })

  it('detects only explicit ASCII-only terminal environments', () => {
    expect(needsTuiFirstRunWelcomeAsciiArt({ TERM: 'dumb' })).toBe(true)
    expect(needsTuiFirstRunWelcomeAsciiArt({ LC_ALL: 'C' })).toBe(true)
    expect(needsTuiFirstRunWelcomeAsciiArt({ LC_CTYPE: 'POSIX' })).toBe(true)
    expect(needsTuiFirstRunWelcomeAsciiArt({ LANG: 'C' })).toBe(true)
    expect(needsTuiFirstRunWelcomeAsciiArt({ LANG: 'en_US.UTF-8' })).toBe(false)
    expect(typeof needsTuiFirstRunWelcomeAsciiArt()).toBe('boolean')
  })
})

describe('TUI first-run welcome composition', () => {
  it('pins the supplied official icon and exact Chinese copy at their owner boundaries', async () => {
    const icon = (await readFile(new URL('../assets/deepseek-color.svg', import.meta.url), 'utf8')).trimEnd()
    expect(createHash('sha256').update(icon).digest('hex'))
      .toBe('deba5f98a5c1796e20fcac3149bcd7eb8a32f0bdd04d048819400b1f28bd1439')
    expect(createHash('sha256').update(copy.paragraphs.join('\n')).digest('hex'))
      .toBe('99f9a828b4f083b28de21bf5e03f939c00238531e765db78911957c44c6e98da')
    expect(TUI_FIRST_RUN_WELCOME_NOTICE_COPY.en).toBe(copy)
  })

  it.each([
    { columns: 60, inner: 50, rows: 30, tier: undefined },
    { columns: 80, inner: 68, rows: 30, tier: 'minimal' },
    { columns: 100, inner: 84, rows: 34, tier: 'compact' },
    { columns: 120, inner: 104, rows: 30, tier: 'full' },
    { columns: 160, inner: 140, rows: 30, tier: 'full' },
  ] as const)('renders the responsive composition at $columns columns without overdraw', ({ inner, rows, tier }) => {
    const fixture = hostFixture(rows)
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, async () => {}, () => {})
    const renderWidth = inner + 4
    const lines = component.render(renderWidth)

    expect(tuiFirstRunWelcomeArtTier(inner, rows)).toBe(tier)
    expect(lines.every(line => visibleWidth(line) <= renderWidth)).toBe(true)
    if (tier === undefined) {
      expect(lines.join('\n')).not.toMatch(/[▀▄█]/u)
    } else {
      expect(lines.join('\n')).toContain(artAnchor(tier))
    }
    const rendered = lines.join('\n')
    const optOut = copy.paragraphs.at(-1)!.match(/[A-Z_]+=1/u)![0]
    expect(rendered).not.toContain(copy.scrollHint)
    expect(rendered).toContain(copy.paragraphs.at(-1)!.match(/[A-Za-z]+ [A-Za-z]+/u)![0])
    expect(rendered).toContain(optOut)
    expect(lines.join('\n')).toContain(`Enter  ${copy.continueLabel}`)
    expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.9))
    expect(lines.length).toBeGreaterThan(5)
  })

  it.each([
    { inner: 68, rows: 14, tier: undefined },
    { inner: 68, rows: 17, tier: undefined },
    { inner: 68, rows: 18, tier: 'minimal' },
    { inner: 84, rows: 21, tier: 'minimal' },
    { inner: 84, rows: 22, tier: 'compact' },
  ] as const)('degrades art to preserve the action at $rows rows', ({ inner, rows, tier }) => {
    const fixture = hostFixture(rows)
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, async () => {}, () => {})
    const lines = component.render(inner + 4)
    expect(tuiFirstRunWelcomeArtTier(inner, rows)).toBe(tier)
    expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.9))
    expect(lines.join('\n')).toContain(`Enter  ${copy.continueLabel}`)
  })

  it('drops the whale at low height while keeping prose, scrolling, and Enter reachable', () => {
    const fixture = hostFixture(10)
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, async () => {}, () => {})
    const initial = component.render(54).join('\n')
    expect(tuiFirstRunWelcomeArtTier(50, 10)).toBeUndefined()
    expect(initial).toContain(openingSentence)
    expect(initial).toContain(`Enter  ${copy.continueLabel}`)

    component.handleInput('\x1b[F')
    const end = component.render(54).join('\n')
    expect(withoutWhitespace(end)).toContain(withoutWhitespace(copy.paragraphs.at(-1)!.slice(-7)))
    expect(end).toContain(`Enter  ${copy.continueLabel}`)

    for (const key of ['\x1b[A', '\x1b[B', '\x1b[5~', '\x1b[6~', '\x1b[H', 'x']) {
      component.handleInput(key)
    }
    component.invalidate()
  })

  it('renders a tiny viewport and a quotation-only paragraph without overdraw', () => {
    const fixture = hostFixture(5)
    const quoteOnly = { ...copy, paragraphs: ['“如切如磋，如琢如磨。”'] }
    const component = new TuiFirstRunWelcomeComponent(fixture.host, quoteOnly, async () => {}, () => {})
    const lines = component.render(2)
    expect(lines.every(line => visibleWidth(line) <= 6)).toBe(true)
  })

  it('keeps the side-by-side composition aligned when prose outgrows the full raster', () => {
    const fixture = hostFixture(40)
    const longCopy = { ...copy, paragraphs: [copy.paragraphs.join(' ').repeat(4)] }
    const component = new TuiFirstRunWelcomeComponent(fixture.host, longCopy, async () => {}, () => {})
    const lines = component.render(100)
    expect(lines.length).toBeGreaterThan(TUI_FIRST_RUN_WELCOME_WHALE.full.unicode.length)
    expect(lines.every(line => visibleWidth(line) <= 100)).toBe(true)
    component.handleInput('\x1b[F')
    expect(component.render(100).join('\n')).toContain(copy.title)
  })

  it('renders the bit-equivalent ASCII icon fallback for an explicitly non-Unicode terminal', () => {
    const fixture = hostFixture(30)
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, async () => {}, () => {}, true)
    const rendered = component.render(72).join('\n')
    expect(rendered).toContain(TUI_FIRST_RUN_WELCOME_WHALE.minimal.ascii[0]!.trim())
    expect(rendered).not.toMatch(/[▀▄█]/u)
  })

  it.each(['full', 'compact', 'minimal'] as const)('keeps the $tier ASCII raster bit-equivalent', (tier) => {
    const mapped = TUI_FIRST_RUN_WELCOME_WHALE[tier].unicode.map(line => Array.from(line).map((cell) => {
      if (cell === '▀') return "'"
      if (cell === '▄') return '_'
      if (cell === '█') return '#'
      return cell
    }).join(''))
    expect(mapped).toEqual(TUI_FIRST_RUN_WELCOME_WHALE[tier].ascii)
  })

  it('ignores Escape and acknowledges only Enter before closing', async () => {
    const fixture = hostFixture(30)
    const acknowledge = vi.fn(async () => {})
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, acknowledge, () => {})
    component.render(72)

    component.handleInput('\x1b')
    await Promise.resolve()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(fixture.closed()).toBe(false)

    component.handleInput('\r')
    await vi.waitFor(() => { expect(fixture.closed()).toBe(true) })
    expect(acknowledge).toHaveBeenCalledOnce()
  })

  it('keeps the notice eligible when Ctrl+C or Ctrl+D requests a normal exit', async () => {
    const fixture = hostFixture(30)
    const acknowledge = vi.fn(async () => {})
    const exit = vi.fn()
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, acknowledge, exit)
    component.handleInput('\x03')
    component.handleInput('\x04')
    expect(exit).toHaveBeenCalledTimes(2)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(fixture.closed()).toBe(false)
  })

  it('does not start a second acknowledgement while the first Enter is pending', async () => {
    const fixture = hostFixture(30)
    const pending = Promise.withResolvers<undefined>()
    const acknowledge = vi.fn(async () => pending.promise)
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, acknowledge, () => {})
    component.render(72)

    component.handleInput('\r')
    component.handleInput('\r')
    component.handleInput('\x1b[B')
    expect(component.render(72).join('\n')).toContain(copy.saving)
    expect(acknowledge).toHaveBeenCalledOnce()

    pending.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.closed()).toBe(true) })
  })

  it('keeps the overlay open after a persistence failure and lets Enter retry', async () => {
    const fixture = hostFixture(30)
    let attempts = 0
    const component = new TuiFirstRunWelcomeComponent(fixture.host, copy, async () => {
      attempts += 1
      if (attempts === 1) throw new Error('disk unavailable')
    }, () => {})
    component.render(72)

    component.handleInput('\r')
    await vi.waitFor(() => {
      expect(component.render(72).join('\n')).toContain(copy.saveError)
    })
    expect(fixture.closed()).toBe(false)

    component.handleInput('\r')
    await vi.waitFor(() => { expect(fixture.closed()).toBe(true) })
    expect(attempts).toBe(2)
    expect(fixture.invalidations()).toBeGreaterThanOrEqual(3)
  })
})

describe('TUI first-run welcome mounting', () => {
  it('opens once per root through the channel-mounted TUI extension and acknowledges into the Harness home', async () => {
    const home = await temporaryHome('dsh-tui-welcome-apply-')
    const { ctx, requests } = tuiServiceContext()
    ctx.plugin(firstRunWelcome, { dshHome: home, asciiArt: true })

    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const request = requests[0]!
    expect(request.options).toEqual({
      width: '100%',
      maxHeight: '90%',
      anchor: 'center',
      margin: 0,
    })

    const fixture = hostFixture(30)
    const component = request.create(fixture.host)
    expect(component).toBeInstanceOf(TuiFirstRunWelcomeComponent)
    const welcome = component as TuiFirstRunWelcomeComponent
    // The profile-resolved asciiArt preference reaches the rendered notice.
    expect(welcome.render(72).join('\n'))
      .toContain(TUI_FIRST_RUN_WELCOME_WHALE.minimal.ascii[0]!.trim())

    // Ctrl+C leaves through the root disposer instead of acknowledging.
    welcome.handleInput('\x03')
    expect(mockDisposeRootAndExit).toHaveBeenCalledWith(expect.anything(), 0)

    // Enter acknowledges into the configured Harness home and closes.
    welcome.handleInput('\r')
    await vi.waitFor(async () => { expect(await hasTuiFirstRunWelcomeAcknowledgement(home)).toBe(true) })
    expect(fixture.closed()).toBe(true)

    // A later load in the same root (a resume swap re-fires the inject
    // fiber) never stacks a second notice.
    apply(ctx, { dshHome: home })
    expect(requests).toHaveLength(1)

    await ctx.fiber.dispose()
  })

  it('keeps the notice closed for an already-acknowledged Harness home', async () => {
    const home = await temporaryHome('dsh-tui-welcome-acked-')
    await acknowledgeTuiFirstRunWelcome(home)
    const { ctx, requests } = tuiServiceContext()
    ctx.plugin(firstRunWelcome, { dshHome: home })

    // Give the asynchronous acknowledgement gate time to settle.
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    expect(requests).toHaveLength(0)

    await ctx.fiber.dispose()
  })
})
