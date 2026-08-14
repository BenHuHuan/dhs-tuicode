import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'
import { packChunkRuns, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { logPath, toHeaderLine } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { runTuiPtySmoke, type TuiPtySmokeOptions } from './pty-harness.ts'
import { HeadlessTerminal } from '../../../packages/ui/tui/tests/headless-terminal.ts'
import {
  acknowledgeTuiFirstRunWelcome,
  hasTuiFirstRunWelcomeAcknowledgement,
} from '../../../packages/ui/tui/src/first-run-welcome/tui-first-run-welcome.ts'
import {
  TUI_FIRST_RUN_WELCOME_NOTICE_COPY,
  TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE,
} from '../../../packages/ui/tui/src/first-run-welcome/tui-first-run-welcome-copy.ts'
import { TUI_FIRST_RUN_WELCOME_WHALE } from '../../../packages/ui/tui/src/first-run-welcome/tui-first-run-welcome-art.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
// The pty harness boots the shipped `tui` profile by default (`--profile tui`),
// so the default surface needs no argument at all; these are the `--patch`
// overlays layered over that profile.
const scriptedConfigPath = fileURLToPath(new URL('./fixtures/tui-scripted.cordis.yml', import.meta.url))
// An overlay whose `llm-pi-ai` config fails validation before the runner can
// publish an agent and let the TUI acquire the terminal.
const invalidProviderConfigPath = fileURLToPath(new URL('./fixtures/tui-invalid-provider.cordis.yml', import.meta.url))
// A sibling that rejects only after the runner publishes its ready agent, so
// the TUI owns the terminal before the process-level fail-loud handler runs.
const lateFailureConfigPath = fileURLToPath(new URL('./fixtures/tui-late-failure.cordis.yml', import.meta.url))
const externalEditorFixturePath = fileURLToPath(new URL('./fixtures/tui-external-editor.mjs', import.meta.url))
const externalEditorCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(externalEditorFixturePath)}`
const clipboardImageFixturePath = fileURLToPath(new URL('./fixtures/tui-clipboard-image.mjs', import.meta.url))
const clipboardTextFixturePath = fileURLToPath(new URL('./fixtures/tui-clipboard-text.mjs', import.meta.url))
const clipboardImageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const firstRunSnapshots = fileURLToPath(new URL('./tui-first-run-snapshots/', import.meta.url))
const synchronizedFrameEnd = '\x1b[?2026l'
// Artifact mode gives the inner PTY driver 60 seconds and its execa owner a
// five-second backstop. Keep Vitest outside both deadlines so the harness can
// report its own marker, exit, and cleanup failure instead of being cut off.
const PTY_SMOKE_TEST_TIMEOUT_MS = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? 75_000
  : LOADER_SMOKE_TEST_TIMEOUT_MS

/**
 * Seed the isolated process workspace: ordinary files land in `cwd`, personal
 * files in the Harness home (`.dsh`), and skill bundles under the agents
 * home's `skills/` root — the same trees `$DSH_HOME` /
 * `$DSH_AGENTS_HOME` point the child at.
 */
function seedWorkspace(
  files: {
    workspace?: Record<string, string>
    personal?: Record<string, string>
    skills?: Record<string, string>
  },
): (cwd: string) => Promise<void> {
  return async (cwd) => {
    for (const [name, content] of Object.entries(files.workspace ?? {})) {
      const file = join(cwd, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    for (const [name, content] of Object.entries(files.personal ?? {})) {
      const file = join(cwd, '.dsh', name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    for (const [name, content] of Object.entries(files.skills ?? {})) {
      const file = join(cwd, '.agents', 'skills', name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
  }
}

/** Install one fixture package into the isolated profile's bare-specifier resolution root. */
async function seedProfileModule(
  cwd: string,
  moduleName: string,
  entryName: string,
  source: string,
): Promise<void> {
  const moduleDir = join(cwd, '.dsh', 'profiles', 'tui', 'node_modules', moduleName)
  await mkdir(moduleDir, { recursive: true })
  await writeFile(join(moduleDir, 'package.json'), JSON.stringify({
    name: moduleName,
    type: 'module',
    main: `./${entryName}`,
  }))
  await writeFile(join(moduleDir, entryName), source)
}

/** Seed one real plaintext JSONL session for the `/resume` selector and in-place swap smoke. */
async function seedResumeSession(cwd: string): Promise<void> {
  const sessionCwd = realpathSync.native(cwd)
  const id = SessionId('resume-target')
  const meta: SessionHeader = { version: 0, id, createdAt: 1_700_000_000_000, cwd: sessionCwd }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1_700_000_000_002, data: createUserMessage({
      content: [{ type: 'text', text: 'persisted prompt' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 1_700_000_000_003, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: 1_700_000_000_004, data: { header: { config: { provider: 'tui-scripted', model: 'tui-scripted-model' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 4, time: 1_700_000_000_005, data: {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'persisted answer' }],
        source: {
          kind: 'model',
          ...{ provider: 'tui-scripted', model: 'tui-scripted-model' },
        },
      }),
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: 5, time: 1_700_000_000_006, data: { turn: 1, step: 1 } },
    { type: 'session/title', seq: 6, time: 1_700_000_000_007, data: { title: 'Resume selector design', messageSeqs: [1], source: { kind: 'fallback' } } },
    { type: 'todo/write', seq: 7, time: 1_700_000_000_008, data: { todos: [{ content: 'Preserve restored state', status: 'in_progress' }] } },
    { type: 'turn/end', seq: 8, time: 1_700_000_000_009, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const file = logPath(join(cwd, '.sessions'), sessionCwd, id, 'none')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    JSON.stringify(toHeaderLine(meta)),
    ...packChunkRuns(events).map(record => JSON.stringify(record)),
    '',
  ].join('\n'))
}

/** Model-visible startup context from the first request in the workspace's persisted session log. */
interface LoggedRequestContext {
  /** The system prompt string the launcher sends. */
  system: string
}

async function readLoggedRequestContext(cwd: string): Promise<LoggedRequestContext> {
  const sessionsDir = join(cwd, '.sessions')
  const entries = await readdir(sessionsDir, { recursive: true })
  // A single keyless run writes one session log; the source section is global, so any log carries it.
  const logRelPath = entries.find(name => name.endsWith('.jsonl'))
  if (logRelPath === undefined) throw new Error(`no session log written under ${sessionsDir}`)
  const lines = (await readFile(join(sessionsDir, logRelPath), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line) as SessionEvent
    if (event.type === 'request/header') {
      return {
        system: event.data.header.system ?? '',
      }
    }
  }
  throw new Error(`session log ${logRelPath} has no request/header event`)
}

/**
 * Shared defaults: the keyless key and the dsh bin. The harness boots the
 * shipped `tui` profile (`--profile tui`) unless `configArgs` overrides the
 * whole vector; `configPath` layers a `--patch` overlay over that profile.
 */
function smoke(overrides: Partial<TuiPtySmokeOptions> & {
  label: string
  showFirstRunWelcome?: boolean
}): Promise<string> {
  const { showFirstRunWelcome = false, prepare, env, ...options } = overrides
  return runTuiPtySmoke({
    tempDirPrefix: 'dsh-tui-smoke-',
    binScript: dshBinScript,
    tsconfigPath,
    env: {
      DEEPSEEK_API_KEY: 'keyless-tui-no-call',
      DSH_TELEMETRY_DISABLED: '1',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ...env,
    },
    // Artifact CI builds and smokes concurrently on a contended runner.
    ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? { timeoutMs: 60_000 } : {}),
    ...options,
    prepare: async (cwd) => {
      if (!showFirstRunWelcome) await acknowledgeTuiFirstRunWelcome(join(cwd, '.dsh'))
      // The scripted fixture inserts the adapter by bare specifier, resolved
      // against the profile's baseUrl — so the smoke ships it in the profile's
      // own node_modules tree, where its `@deepseek-ai/dsh-llm` import resolves
      // through the shared closure fallback at $DSH_HOME/profiles/node_modules.
      const fixturePath = fileURLToPath(new URL('./fixtures/tui-scripted-llm.ts', import.meta.url))
      const fixtureSource = await readFile(fixturePath, 'utf8')
      const artifactMode = resolveExampleMode() === 'lib'
      const entryName = artifactMode ? 'index.js' : 'index.ts'
      await seedProfileModule(
        cwd,
        'scripted-llm',
        entryName,
        artifactMode
          ? (await transform(fixtureSource, {
            format: 'esm',
            loader: 'ts',
            sourcefile: fixturePath,
            target: 'node22',
          })).code
          : fixtureSource,
      )
      await seedProfileModule(
        cwd,
        'tui-late-failure',
        'index.js',
        await readFile(new URL('./fixtures/tui-late-failure.mjs', import.meta.url), 'utf8'),
      )
      await prepare?.(cwd)
    },
  })
}

const firstRunCopy = TUI_FIRST_RUN_WELCOME_NOTICE_COPY[TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE]
const firstRunOpeningSentence = `${firstRunCopy.paragraphs[0]!.split('。', 1)[0]}。`

function firstRunArtAnchor(tier: keyof typeof TUI_FIRST_RUN_WELCOME_WHALE): string {
  return TUI_FIRST_RUN_WELCOME_WHALE[tier].unicode[tier === 'full' ? 2 : 0]!.trim()
}

/** Keep only the overlay rows, excluding platform-specific scrollback and the underlying TUI. */
function overlaySnapshot(snapshot: string, columns: number, rows: number): string {
  const blocks: string[][] = []
  for (const line of snapshot.split('\n')) {
    if (/^\d+(?:-\d+)?~?\| /u.test(line)) blocks.push([line])
    else if (
      line.startsWith('  style ')
      && blocks.length > 0
      // ConPTY trims color attributes from blank cells around brand art,
      // while POSIX PTYs preserve them. The glyph layout and bold title carry
      // the stable semantics; omit only the platform-specific art span.
      && (!line.includes('fg=blue') || line.includes('bold'))
    ) blocks.at(-1)?.push(line)
  }
  const first = blocks.findIndex(block => block[0]?.includes('╭') === true)
  const last = blocks.findIndex((block, index) => index >= first && block[0]?.includes('╰') === true)
  if (first < 0 || last < first) throw new Error('first-run PTY snapshot has no complete overlay frame')
  const overlay = blocks.slice(first, last + 1).flatMap((block, index) => [
    block[0]!.replace(/^\d+(?:-\d+)?(~)?\|/u, `${String(index)}$1|`),
    ...block.slice(1),
  ])
  return [`overlay ${String(columns)}x${String(rows)} rows=${String(last - first + 1)}`, ...overlay, ''].join('\n')
}

/** Project the first synchronized PTY frame containing `marker` into an overlay-only snapshot. */
async function firstRunFrameSnapshot(
  output: string,
  marker: string,
  columns: number,
  rows: number,
): Promise<string> {
  const markerIndex = output.indexOf(marker)
  if (markerIndex < 0) throw new Error(`first-run PTY output has no marker ${JSON.stringify(marker)}`)
  const frameEnd = output.indexOf(synchronizedFrameEnd, markerIndex)
  if (frameEnd < 0) throw new Error(`first-run PTY output has no complete frame after ${JSON.stringify(marker)}`)
  const terminal = new HeadlessTerminal(columns, rows)
  try {
    terminal.write(output.slice(0, frameEnd + synchronizedFrameEnd.length))
    return overlaySnapshot(await terminal.snapshot(), columns, rows)
  } finally {
    await terminal.dispose()
  }
}

// The scripted conversation switches to the pro model first: the scripted
// adapter proves routing + prompt variables by rejecting tool-ful calls on any
// other route (see fixtures/tui-scripted-llm.ts).
const SELECT_PRO_MODEL = [
  { waitFor: 'scripted TUI ready.', send: '/model\r' },
  { waitFor: 'Select model', send: '\x1b[B\x1b[Z\r' },
] as const
const ANSWER_MULTI_WITH_CUSTOM = ' \tRelease notes\r'
const DIRECT_SHELL_COMMAND = 'node -e "console.log([\'DIRECT\',\'SHELL\',\'STREAM\',\'START\'].join(\'_\')); setTimeout(() => console.log([\'DIRECT\',\'SHELL\',\'E2E\'].join(\'_\')), 1500)"'

describe('dsh TUI keyless smoke (real Loader tree in a PTY)', () => {
  it.each([
    { columns: 60, tier: undefined },
    { columns: 80, tier: 'minimal' },
    { columns: 120, tier: 'full' },
    { columns: 160, tier: 'full' },
  ] as const)('renders and acknowledges the responsive first-run composition at $columns columns', async ({ columns, tier }) => {
    const output = await smoke({
      label: `dsh first-run welcome ${String(columns)} columns`,
      tempDirPrefix: `dsh-tui-welcome-${String(columns)}-`,
      configPath: scriptedConfigPath,
      showFirstRunWelcome: true,
      expectedExitCode: 0,
      columns,
      rows: 30,
      actions: [
        {
          waitFor: `Enter  ${firstRunCopy.continueLabel}`,
          send: '\r\x03\x03',
        },
      ],
      inspect: async (cwd) => {
        expect(await hasTuiFirstRunWelcomeAcknowledgement(join(cwd, '.dsh'))).toBe(true)
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const logs = entries.filter(name => name.endsWith('.jsonl'))
        for (const log of logs) {
          const stored = await readFile(join(cwd, '.sessions', log), 'utf8')
          expect(stored).not.toContain(firstRunCopy.paragraphs[0])
        }
      },
    })
    await expect(await firstRunFrameSnapshot(output, firstRunOpeningSentence, columns, 30))
      .toMatchFileSnapshot(join(firstRunSnapshots, `${String(columns)}-columns.expected.txt`))
    if (tier === undefined) {
      expect(output).not.toContain(TUI_FIRST_RUN_WELCOME_WHALE.minimal.unicode[0]!.trim())
    } else {
      expect(output).toContain(firstRunArtAnchor(tier))
    }
    expect(output).toContain(`Enter  ${firstRunCopy.continueLabel}`)
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('keeps prose and Enter reachable in a low-height real PTY after dropping the whale', async () => {
    const output = await smoke({
      label: 'dsh low-height first-run welcome',
      tempDirPrefix: 'dsh-tui-welcome-low-',
      configPath: scriptedConfigPath,
      showFirstRunWelcome: true,
      expectedExitCode: 0,
      columns: 60,
      rows: 12,
      actions: [
        { waitFor: firstRunOpeningSentence, send: '\x1b[F' },
        {
          waitFor: `Enter  ${firstRunCopy.continueLabel}`,
          occurrence: 2,
          send: '\r\x03\x03',
        },
      ],
    })
    await expect(await firstRunFrameSnapshot(output, firstRunOpeningSentence, 60, 12))
      .toMatchFileSnapshot(join(firstRunSnapshots, '60-columns-low-height.expected.txt'))
    expect(output).toContain(firstRunCopy.title)
    expect(output).toContain(firstRunOpeningSentence)
    expect(output).toContain('企业微信群')
    expect(output).toContain(`Enter  ${firstRunCopy.continueLabel}`)
    expect(output).not.toContain(TUI_FIRST_RUN_WELCOME_WHALE.minimal.unicode[0]!.trim())
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('shows once and skips the second launch under the same DSH_HOME', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-welcome-twice-'))
    try {
      const first = await smoke({
        label: 'dsh first welcome launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        showFirstRunWelcome: true,
        expectedExitCode: 0,
        actions: [
          { waitFor: `Enter  ${firstRunCopy.continueLabel}`, send: '\r\x03\x03' },
        ],
      })
      expect(first).toContain(firstRunCopy.title)

      const second = await smoke({
        label: 'dsh second welcome launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        showFirstRunWelcome: true,
        expectedExitCode: 0,
        actions: [{ waitFor: 'dsh', send: '\x03\x03' }],
      })
      expect(second).not.toContain(firstRunOpeningSentence)
      expect(second).not.toContain(`Enter  ${firstRunCopy.continueLabel}`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('creates a distinct durable session on each unresumed launch under the same DSH_HOME', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-fresh-launch-twice-'))
    try {
      const first = await smoke({
        label: 'dsh first durable fresh launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        actions: [
          { waitFor: 'scripted TUI ready.', send: '/status\r' },
          { waitFor: 'Session status', send: '/exit\r' },
        ],
      })
      expect(first).not.toContain('id collision')

      const second = await smoke({
        label: 'dsh second durable fresh launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        actions: [
          { waitFor: 'scripted TUI ready.', send: '/status\r' },
          { waitFor: 'Session status', send: '/exit\r' },
        ],
      })
      expect(second).not.toContain('id collision')

      const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
      const logs = entries.filter(name => name.endsWith('.jsonl'))
      expect(logs).toHaveLength(2)
      const ids = await Promise.all(logs.map(async (log) => {
        const firstLine = (await readFile(join(cwd, '.sessions', log), 'utf8')).split('\n')[0]
        return (JSON.parse(firstLine ?? '{}') as { id?: unknown }).id
      }))
      expect(ids.every(id => typeof id === 'string' && /^session-[0-9a-f-]+$/u.test(id))).toBe(true)
      expect(new Set(ids).size).toBe(2)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('keeps the notice eligible when the process exits before Enter', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-welcome-abort-'))
    try {
      await smoke({
        label: 'dsh aborted welcome launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        showFirstRunWelcome: true,
        expectedExitCode: -15,
        actions: [{ waitFor: firstRunOpeningSentence, signal: 'SIGTERM' }],
        inspect: async (workspace) => {
          expect(await hasTuiFirstRunWelcomeAcknowledgement(join(workspace, '.dsh'))).toBe(false)
        },
      })

      const next = await smoke({
        label: 'dsh welcome after aborted launch',
        tempDirPrefix: 'unused-',
        cwd,
        configPath: scriptedConfigPath,
        showFirstRunWelcome: true,
        expectedExitCode: 0,
        actions: [
          { waitFor: `Enter  ${firstRunCopy.continueLabel}`, send: '\r\x03\x03' },
        ],
      })
      expect(next).toContain(firstRunOpeningSentence)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('boots pi-tui, sweeps the borderless banner in, enters plan mode, and restores the terminal', async () => {
    // With no configured welcome the borderless banner sweeps in left-to-right.
    // The prompt marks a settled banner without coupling the smoke to the
    // launcher's fresh, random session identity.
    const output = await smoke({
      label: 'dsh boot',
      actions: [
        { waitFor: 'dsh', send: '/plan' },
        { waitFor: '[off|message] — Enter or leave plan mode', send: '\r' },
        { waitFor: 'Plan mode on. Use /plan off to leave.', send: '/exit\r' },
      ],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('HARNESS')
    expect(output).toMatch(/session-[0-9a-f-]+/u)
    expect(output).toContain('[off|message] — Enter or leave plan mode')
    expect(output).toContain('Plan mode on. Use /plan off to leave.')
    // Borderless: no box-drawing frame around the banner.
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('rejects an invalid sibling config before the TUI acquires the terminal', async () => {
    const output = await smoke({
      label: 'dsh invalid provider config',
      tempDirPrefix: 'dsh-tui-invalid-config-',
      configPath: invalidProviderConfigPath,
      expectedExitCode: 1,
    })
    expect(output).toContain('dsh: plugin tree failed to load:')
    expect(output).toContain('$.providers')
    // The runner waits for the whole Loader tree before publishing an agent,
    // so a schema failure cannot start ProcessTerminal or mutate this mode.
    expect(output).not.toContain('\u001B[?2004h')
    expect(output).not.toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  // A post-settlement sibling failure still has to dispose the mounted TUI.
  // Exiting without that release strands raw mode and bracketed paste on the
  // user's shell, and a pending terminal-query reply can land as literal text.
  it('restores the terminal when a sibling fails after the TUI starts', async () => {
    const output = await smoke({
      label: 'dsh late sibling failure',
      tempDirPrefix: 'dsh-tui-late-failure-',
      configPath: lateFailureConfigPath,
      expectedExitCode: 1,
    })
    expect(output).toContain('dsh: fatal load failure:')
    expect(output).toContain('scripted late TUI sibling failure')
    expect(output).toContain('\u001B[?2004h')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('switches models, streams a response, answers a user-question dialog, and exits cleanly', async () => {
    const output = await smoke({
      label: 'dsh conversation',
      tempDirPrefix: 'dsh-tui-conversation-',
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: '/plan exercise the TUI\r' },
        // The question text first appears in the streamed tool-call card. Wait
        // for the dialog's input legend so Enter cannot arrive before it owns
        // terminal input when pre-dispatch policy yields.
        {
          waitFor: 'Tab custom answer • ↑/↓ navigate • Space toggle • Enter submit • Esc interrupt',
          send: ANSWER_MULTI_WITH_CUSTOM,
        },
        { waitFor: 'Decision received. Scripted TUI run complete.', send: '' },
        // Session title: the first user message drives the first-message-llm
        // provider's tool-less title call; the scripted adapter answers it, the
        // accepted title lands in the log, and the TUI renders the terminal
        // window title as `<session title> — <configured title>` via OSC 0.
        // Gating /status on it keeps the assertion race-free; the diagnostics
        // card is then exercised through the same real Loader/PTY composition.
        { waitFor: 'scripted session title — DeepSeek Harness', send: '/plan off\r' },
        { waitFor: 'Plan mode off.', send: 'Confirm the scripted run left plan mode.\r' },
        { waitFor: 'Default mode confirmed.', send: '\x1bt' },
        { waitFor: 'Reasoning effort: Off.', send: '/effort max\r' },
        { waitFor: 'Reasoning effort: Max.', send: '/rename Claude parity review\r' },
        { waitFor: 'Session renamed: Claude parity review.', send: '\x18\x0b' },
        {
          waitFor: 'Press Ctrl+X Ctrl+K again within 3s to stop all running background subagents',
          send: '\x18\x0b',
        },
        { waitFor: 'No running background subagents.', send: '/context all\r' },
        { waitFor: 'Context usage', send: '/status\r' },
        { waitFor: 'Session status', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const log = entries.find(name => name.endsWith('.jsonl'))
        if (log === undefined) throw new Error('conversation PTY run wrote no session log')
        const stored = await readFile(join(cwd, '.sessions', log), 'utf8')
        expect(stored).toMatch(
          /"type":"session\/title".*"title":"Claude parity review".*"messageSeqs":\[\].*"source":\{"kind":"user"\}/u,
        )
      },
    })
    expect(output).toContain('I need one decision before I continue.')
    expect(output).toContain('Plan mode on. Use /plan off to leave.')
    expect(output).toContain('Plan mode off.')
    expect(output).toContain('Default mode confirmed.')
    expect(output).toContain('Reasoning effort: Off.')
    expect(output).toContain('Reasoning effort: Max.')
    expect(output).toContain('Session renamed: Claude parity review.')
    expect(output).toContain('Press Ctrl+X Ctrl+K again within 3s')
    expect(output).toContain('No running background subagents.')
    expect(output).toContain('Context usage')
    // The scripted fixture reports deliberately tiny provider usage compared
    // with the real assembled prompt. Token-meter therefore rejects that
    // unsafe anchor and exposes its conservative estimated provenance.
    expect(output).toContain('Estimated request pressure')
    expect(output).toContain('Tool schemas')
    expect(output).toContain('Conversation')
    expect(output).toContain('Surface items')
    expect(output).toContain('model-visible messages')
    expect(output).toContain(String.raw`\x1b]2;MODEL_CONTROLLED\x07`)
    expect(output).toContain(String.raw`\x1b[999CMODEL_CURSOR`)
    expect(output).toContain(String.raw`\x9b31mMODEL_C1`)
    expect(output).not.toContain('\u001B]2;MODEL_CONTROLLED\u0007')
    expect(output).not.toContain('\u001B[999CMODEL_CURSOR')
    expect(output).not.toContain('\u009B31mMODEL_C1')
    expect(output).toContain('Safe')
    expect(output).toContain('Release notes')
    expect(output).toContain('\u001B]0;scripted session title — DeepSeek Harness\u0007')
    expect(output).toContain('\u001B]0;Claude parity review — DeepSeek Harness\u0007')
    expect(output).toContain('Session status')
    expect(output).toContain('Title')
    expect(output).toContain('Claude parity review')
    expect(output).toContain('Model')
    expect(output).toContain('tui-scripted/tui-scripted-model-pro')
    expect(output).toContain('KV cache')
    expect(output).toContain('Context')
    expect(output).toContain('128,000')
    expect(output).toContain('System prompt')
    expect(output).toContain('You are an AI agent powered by DeepSeek Harness.')
    expect(output).toContain('Registered tools')
    expect(output).toContain('ask_user_question')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('pastes a clipboard image, commits only its durable reference, and reaches the model', async () => {
    const output = await smoke({
      label: 'dsh clipboard image',
      tempDirPrefix: 'dsh-tui-clipboard-image-',
      configPath: scriptedConfigPath,
      prepare: async (cwd) => {
        await writeFile(
          join(cwd, 'clipboard-image-fixture.mjs'),
          await readFile(clipboardImageFixturePath, 'utf8'),
        )
      },
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: '\x1bv' },
        { waitFor: '[Image #1]', send: ' Describe the clipboard image.\r' },
        { waitFor: 'Clipboard image received.', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const log = entries.find(name => name.endsWith('.jsonl'))
        if (log === undefined) throw new Error('clipboard-image PTY run wrote no session log')
        const stored = await readFile(join(cwd, '.sessions', log), 'utf8')
        expect(stored).toContain('"type":"image"')
        expect(stored).toContain('"attachmentId":"sha256:')
        expect(stored).toContain('"name":"clipboard.png"')
        expect(stored).not.toContain(clipboardImageBytes.toString('base64'))

        const digest = createHash('sha256').update(clipboardImageBytes).digest('hex')
        const object = join(cwd, '.dsh', 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
        expect(await readFile(object)).toEqual(clipboardImageBytes)
      },
    })
    expect(output).toContain('[Image #1]')
    expect(output).toContain('Clipboard image received.')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('copies the latest assistant response through the built shell-free clipboard boundary', async () => {
    const expected = 'External editor prompt received.'
    const output = await smoke({
      label: 'dsh clipboard text',
      tempDirPrefix: 'dsh-tui-clipboard-text-',
      configPath: scriptedConfigPath,
      prepare: async (cwd) => {
        await writeFile(
          join(cwd, 'clipboard-text-fixture.mjs'),
          await readFile(clipboardTextFixturePath, 'utf8'),
        )
      },
      actions: [
        ...SELECT_PRO_MODEL,
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: 'External editor PTY prompt.\r',
        },
        { waitFor: expected, send: '/copy\r' },
        { waitFor: 'Copied full response #1 to clipboard.', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        expect(await readFile(join(cwd, 'clipboard-text-output.txt'), 'utf8')).toBe(expected)
      },
    })
    expect(output).toContain('Copied full response #1 to clipboard.')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('writes a selected response code block through the built TUI file boundary', async () => {
    const expected = 'export const responseFile = true'
    const output = await smoke({
      label: 'dsh response file',
      tempDirPrefix: 'dsh-tui-response-file-',
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: 'Response file PTY prompt.\r',
        },
        { waitFor: expected, send: '/copy\r' },
        { waitFor: 'w write file', send: '\x1b[Bw' },
        { waitFor: 'Write response to file', send: 'response-file-output.ts\r' },
        { waitFor: 'Wrote code block 1 from response #1', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        expect(await readFile(join(cwd, 'response-file-output.ts'), 'utf8')).toBe(expected)
      },
    })
    expect(output).toContain('Wrote code block 1 from response #1')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('loads a local skill via /skill: and delivers its body to the model as a user turn', async () => {
    // The whole user-only invocation path in one keyless boot: `ctx.get('skills')`
    // resolves in the shipped tree, the client-side `/skill:` command parses,
    // and the local provider admits a model-disabled skill by the omitted
    // `user-invocable` default. The rendered `<skill name="…">` block reaches
    // the model — proven by the scripted adapter echoing the fixture's body
    // marker only when it arrives.
    const output = await smoke({
      label: 'dsh skill',
      tempDirPrefix: 'dsh-tui-skill-',
      configPath: scriptedConfigPath,
      prepare: seedWorkspace({
        skills: {
          'scripted-skill/SKILL.md': [
            '---',
            'name: scripted-skill',
            'description: Keyless PTY proof that the skill command loads a local skill into the conversation.',
            'disable-model-invocation: true',
            '---',
            '',
            'SCRIPTED SKILL BODY MARKER',
            '',
          ].join('\n'),
        },
      }),
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: '/skill:scripted-skill\r' },
        { waitFor: 'Scripted skill body received.', send: '/exit\r' },
      ],
    })
    expect(output).not.toContain('[instructions]')
    expect(output).toContain('Scripted skill body received.')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('cycles permission and plan modes from the shipped profile without unlocking full access', async () => {
    const output = await smoke({
      label: 'dsh permission and plan mode cycle',
      tempDirPrefix: 'dsh-tui-mode-cycle-',
      configPath: scriptedConfigPath,
      actions: [
        { waitFor: 'scripted TUI ready.', send: '\x1b[Z' },
        { waitFor: 'Mode: Plan.', send: '\x1bm' },
        { waitFor: 'Mode: Read Only.', send: '\x1b[Z' },
        { waitFor: 'Mode: Workspace Write.', send: '/status\r' },
        { waitFor: 'Session status', send: '/exit\r' },
      ],
      inspect: async (cwd) => {
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const log = entries.find(name => name.endsWith('.jsonl'))
        if (log === undefined) throw new Error('mode-cycle PTY run wrote no session log')
        const stored = await readFile(join(cwd, '.sessions', log), 'utf8')
        expect(stored).toContain('"type":"plan/mode"')
        expect(stored).toContain('"preset":"read-only"')
        expect(stored).toContain('"preset":"workspace-write"')
        expect(stored).not.toContain('"preset":"danger-full-access"')
      },
    })
    expect(output).toContain('Mode: Plan.')
    expect(output).toContain('Mode: Read Only.')
    expect(output).toContain('Mode: Workspace Write.')
    expect(output).toContain('Session status')
    expect(output).toContain('Workspace Write')
    expect(output).not.toContain('Mode: Full access.')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('supports Ctrl+L fresh sessions, contextual editor shortcuts, Alt+P, and confirmed idle exit in a real PTY', async () => {
    const output = await smoke({
      label: 'dsh contextual editor shortcuts',
      tempDirPrefix: 'dsh-tui-editor-shortcuts-',
      configPath: scriptedConfigPath,
      actions: [
        { waitFor: 'scripted TUI ready.', send: '?' },
        { waitFor: 'Keyboard shortcuts', send: '?/status\r' },
        { waitFor: 'Session status', send: '\x1bp' },
        { waitFor: 'Select model', send: '\x1b[B\x1b[Z\r' },
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: '/config\r',
        },
        { waitFor: 'TUI settings', send: '\x1b[B\r' },
        {
          waitFor: 'Saved external editor context.',
          send: '\x1b',
          separateInput: true,
        },
        {
          waitFor: 'Saved external editor context.',
          send: '\x0c',
        },
        { waitFor: 'Press Ctrl+L again to run /clear', send: '\x0c' },
        {
          // The welcome copy can be repainted more than once by the first
          // channel, so its raw-output occurrence count is not a mount
          // boundary. Bracketed-paste mode is enabled exactly once per TUI
          // start; its second enable proves the fresh channel owns input.
          waitFor: '\x1b[?2004h',
          occurrence: 2,
          send: 'Create the first scripted task checklist.\r',
        },
        { waitFor: 'Keep the scripted checklist visible', send: '\x14' },
        {
          waitFor: 'First scripted checklist written.',
          send: 'Update the scripted task checklist while it is hidden.\r',
        },
        { waitFor: 'Hidden scripted checklist updated.', send: '\x14' },
        { waitFor: 'Restore the latest hidden checklist state', send: 'external seed\x07' },
        { waitFor: 'DSH_EXTERNAL_EDITOR_STARTED', send: '' },
        {
          // The third bracketed-paste enable is the same ProcessTerminal
          // reacquiring raw mode after the foreground editor exits.
          waitFor: '\x1b[?2004h',
          occurrence: 3,
          send: '\r',
        },
        { waitFor: 'External editor prompt received.', send: 'stash\x1b[D\x13' },
        { waitFor: 'Prompt stashed · Ctrl+S to restore', send: '\x13Z' },
        // The cursor cell wraps the final `h` in SGR bytes, so `stasZ` is the
        // contiguous raw-PTY proof that restore put the cursor before it.
        { waitFor: 'stasZ', send: '\x03abcd\x1b[D\x04Z' },
        { waitFor: 'abcZ', send: '\x03\x04' },
        { waitFor: 'Press Ctrl+D again to exit', send: '\x04' },
      ],
      inspect: async (cwd) => {
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const logs = entries.filter(name => name.endsWith('.jsonl'))
        expect(logs).toHaveLength(2)
        const stored = await Promise.all(logs.map(log => readFile(join(cwd, '.sessions', log), 'utf8')))
        const ids = stored.map(log => /"id":"(session-[0-9a-f-]+)"/u.exec(log)?.[1])
        expect(ids.every(id => id !== undefined)).toBe(true)
        expect(new Set(ids).size).toBe(2)
        expect(stored.some(log => log.includes('External editor PTY prompt.'))).toBe(true)
        expect(stored.every(log => !log.includes('external seed'))).toBe(true)
        expect(stored.every(log => !log.includes('deepseek-harness-external-editor-context'))).toBe(true)
        const settings = await readFile(join(cwd, '.dsh', 'settings.yaml'), 'utf8')
        expect(settings).toContain('ui-tui:')
        expect(settings).toContain('externalEditorContext: true')
      },
      env: {
        VISUAL: externalEditorCommand,
        DSH_TUI_EDITOR_EXPECT: 'Hidden scripted checklist updated.',
      },
    })
    expect(output).toContain('Keyboard shortcuts')
    expect(output).toContain('Select model')
    expect(output).toContain('Press Ctrl+L again to run /clear')
    expect(output).toContain('Restore the latest hidden checklist state')
    expect(output).toContain('DSH_EXTERNAL_EDITOR_STARTED')
    expect(output).toContain('External editor prompt received.')
    expect(output).toContain('Prompt stashed · Ctrl+S to restore')
    expect(output).toContain('stasZ')
    expect(output).toContain('abcZ')
    expect(output).toContain('Press Ctrl+D again to exit')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('streams an explicit ! command, backgrounds it with Ctrl+B, and delivers one durable result', async () => {
    const output = await smoke({
      label: 'dsh direct shell',
      tempDirPrefix: 'dsh-tui-direct-shell-',
      configPath: scriptedConfigPath,
      prepare: seedWorkspace({
        workspace: {
          'scripts/path-e2e.ps1': 'Write-Output path-e2e\n',
        },
      }),
      actions: [
        ...SELECT_PRO_MODEL,
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: `! ${DIRECT_SHELL_COMMAND}\r`,
        },
        { waitFor: 'DIRECT_SHELL_STREAM_START', send: '\x02' },
        { waitFor: 'Shell moved to background as bash-1', send: '/tasks\r' },
        { waitFor: 'bash-1 · running', send: '' },
        { waitFor: 'Direct shell output received.', send: '\x0f' },
        { waitFor: 'DIRECT_SHELL_E2E', send: '! ./scripts/' },
        { waitFor: 'path-e2e.ps1', send: '\t' },
        { waitFor: '! ./scripts/path-e2e.ps1', send: '\x03\x12' },
        { waitFor: 'History search', send: 'node -e' },
        { waitFor: 'History search (1 of 1)', send: '\t' },
        { waitFor: '! node -e "console.log', send: '\x03/exit\r' },
      ],
      inspect: async (cwd) => {
        const entries = await readdir(join(cwd, '.sessions'), { recursive: true })
        const log = entries.find(name => name.endsWith('.jsonl'))
        if (log === undefined) throw new Error('direct-shell PTY run wrote no session log')
        const stored = await readFile(join(cwd, '.sessions', log), 'utf8')
        expect(stored).toContain('tui/input')
        expect(stored).toContain('DIRECT')
      },
    })
    expect(output).toContain('DIRECT_SHELL_STREAM_START')
    expect(output).toContain('Shell moved to background as bash-1')
    expect(output).toContain('Background tasks')
    expect(output).toContain('bash-1 · running')
    expect(output).toContain('DIRECT_SHELL_E2E')
    expect(output).toContain('Context · user-shell')
    expect(output).toContain('status: exit code 0')
    expect(output).toContain('Direct shell output received.')
    expect(output).toContain('path-e2e.ps1')
    expect(output).toContain('! ./scripts/path-e2e.ps1')
    expect(output).toContain('History search (1 of 1)')
    expect(output).toContain('Ctrl+S scope')
    expect(output).toContain('! node -e "console.log')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('adds a watched local skill to live /skill: autocomplete without restarting', async () => {
    const skill = [
      '---',
      'name: hot-added-skill',
      'description: HOT_ADDED_COMPLETION_MARKER',
      '---',
      '',
      'Hot-added body.',
      '',
    ].join('\n')
    const output = await smoke({
      label: 'tui-agent hot-added skill autocomplete',
      tempDirPrefix: 'tui-agent-hot-skill-',
      configPath: scriptedConfigPath,
      actions: [
        {
          waitFor: 'scripted TUI ready.',
          writeFile: {
            path: '.agents/skills/hot-added-skill/SKILL.md',
            content: skill,
          },
          send: '/skill:hot',
        },
        { waitFor: 'HOT_ADDED_COMPLETION_MARKER', send: '\x03/exit\r' },
      ],
    })
    expect(output).toContain('HOT_ADDED_COMPLETION_MARKER')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it.skipIf(process.env.DSH_EXAMPLE_MODE === 'lib')('fuzzy-completes an @file path without reading or submitting the file', async () => {
    const output = await smoke({
      label: 'dsh file autocomplete',
      tempDirPrefix: 'dsh-tui-file-autocomplete-',
      // Source-plane PTY coverage complements the deterministic package-level
      // autocomplete tests. Artifact CI omits this timing-sensitive terminal
      // rendering assertion; built boot is covered by the neighboring cases.
      prepare: seedWorkspace({
        workspace: {
          'src/terminal-special-case.ts': 'export const marker = true\n',
          'src/other.ts': 'export const other = true\n',
        },
      }),
      actions: [
        { waitFor: 'dsh', send: '@tsc' },
        { waitFor: 'File · terminal-special-case.t', send: '\t' },
        { waitFor: '@src/terminal-special-case.ts', send: '\x03/exit\r' },
      ],
    })
    expect(output).toContain('File · terminal-special-case.t')
    expect(output).toContain('@src/terminal-special-case.ts')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

})

describe('dsh CLI keyless smoke (apps/cli through the same PTY)', () => {
  it('shows the terminal-local notice over a resumed session without changing its log', async () => {
    let originalLineCount = 0
    const output = await smoke({
      label: 'dsh first-run notice on resume',
      tempDirPrefix: 'dsh-tui-welcome-resume-',
      binScript: dshBinScript,
      configArgs: ['--profile', 'tui', '--patch', scriptedConfigPath, '--resume', 'resume-target'],
      showFirstRunWelcome: true,
      expectedExitCode: 0,
      prepare: async (cwd) => {
        await seedResumeSession(cwd)
        const before = await readFile(logPath(
          join(cwd, '.sessions'),
          realpathSync.native(cwd),
          SessionId('resume-target'),
          'none',
        ), 'utf8')
        originalLineCount = before.split('\n').filter(Boolean).length
      },
      actions: [
        { waitFor: `Enter  ${firstRunCopy.continueLabel}`, send: '\r\x03\x03' },
      ],
      inspect: async (cwd) => {
        const after = await readFile(logPath(
          join(cwd, '.sessions'),
          realpathSync.native(cwd),
          SessionId('resume-target'),
          'none',
        ), 'utf8')
        expect(after).not.toContain(firstRunCopy.paragraphs[0])
        const appended = after.split('\n').filter(Boolean).slice(originalLineCount)
          .map(line => JSON.parse(line) as SessionEvent)
        expect(appended).not.toContainEqual(expect.objectContaining({ type: 'user/message' }))
        expect(appended).not.toContainEqual(expect.objectContaining({ type: 'turn/start' }))
      },
    })
    expect(output).toContain(firstRunOpeningSentence)
    expect(output).toContain('Resume selector design — DeepSeek Harness')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('swaps the TUI in place for /continue by exact title and restores the same session state', async () => {
    const output = await smoke({
      label: 'dsh in-place resume',
      tempDirPrefix: 'dsh-in-place-resume-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      prepare: seedResumeSession,
      actions: [
        { waitFor: 'scripted TUI ready.', send: '/continue Resume selector design\r' },
        { waitFor: 'Preserve restored state', send: '/exit\r' },
      ],
    })
    const released = output.indexOf('\u001B[?2004l')
    const restored = output.indexOf('Resume selector design — DeepSeek Harness')
    expect(released).toBeGreaterThanOrEqual(0)
    expect(restored).toBeGreaterThan(released)
    expect(output).toContain('Preserve restored state')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('boots the shipped default profile with no arguments and no personal overlay', async () => {
    const output = await smoke({
      label: 'dsh default boot',
      tempDirPrefix: 'dsh-default-boot-',
      binScript: dshBinScript,
      actions: [{ waitFor: 'dsh', send: '/exit\r' }],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toMatch(/session-[0-9a-f-]+/u)
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('applies the personal overlay: cordis.patch.yml patches a bundle-inserted row and the invoking directory\'s .env outranks the Harness-home .env', async () => {
    // The whole personal-config chain in one boot. cordis.patch.yml patches the
    // `tui` row — a row the TUI bundle inserted, not one the base declares —
    // proving the home patch list reaches a row an earlier bundle layer
    // inserted. Both `.env` layers define the same ordinary (non-bootstrap)
    // variable, so rendering the project value proves the documented
    // inherited > project > user precedence reaches a `!!js` expression.
    const output = await smoke({
      label: 'dsh personal overlay',
      tempDirPrefix: 'dsh-personal-overlay-',
      binScript: dshBinScript,
      prepare: seedWorkspace({
        workspace: { '.env': 'TUI_KEYLESS_E2E_WELCOME=PROJECT OVERLAY READY.\n' },
        personal: {
          '.env': 'TUI_KEYLESS_E2E_WELCOME=HOME ENV LEAKED.\n',
          'cordis.patch.yml': [
            '- id: tui',
            '  config:',
            '    welcome: !!js process.env.TUI_KEYLESS_E2E_WELCOME',
            '',
          ].join('\n'),
        },
      }),
      actions: [{ waitFor: 'PROJECT OVERLAY READY.', send: '/exit\r' }],
    })
    expect(output).toContain('PROJECT OVERLAY READY.')
    expect(output).not.toContain('HOME ENV LEAKED.')
    expect(output).toContain('\u001B[?2004l')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('fails loud instead of booting when the personal cordis.patch.yml is invalid', async () => {
    const output = await smoke({
      label: 'dsh invalid personal config',
      tempDirPrefix: 'dsh-invalid-personal-',
      binScript: dshBinScript,
      prepare: seedWorkspace({ personal: { 'cordis.patch.yml': 'id: not-a-list\n' } }),
      expectedExitCode: 1,
    })
    expect(output).toContain('must be a top-level YAML array of loader patch entries')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('routes the --resume flag into the runner resume intake, failing loud on a missing id', async () => {
    // The flag path end to end: the launcher strips --profile, apps/cli parses
    // `--resume missing-session` into the startup service, and the runner's
    // resume fails loud — proving the printed hint reaches the app's resume
    // intake with no config key and no environment variable.
    const output = await smoke({
      label: 'dsh resume flag failure',
      tempDirPrefix: 'dsh-resume-flag-',
      binScript: dshBinScript,
      configArgs: ['--profile', 'tui', '--resume', 'missing-session'],
      expectedExitCode: 1,
    })
    expect(output).toContain('dsh: session "missing-session" not found')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('prints the TUI-owned resume command on exit, naming the booted profile', async () => {
    // The exit line is built by the TUI from the settled session identity, so
    // it always names the exact resume command into the same profile.
    const output = await smoke({
      label: 'dsh goodbye message',
      tempDirPrefix: 'dsh-goodbye-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      actions: [{ waitFor: 'scripted TUI ready.', send: '/exit\r' }],
    })
    expect(output).toMatch(/Resume this session with: dsh tui --resume session-[0-9a-f-]+/u)
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('keeps resume working when the personal overlay replaces the whole agent-default-model config', async () => {
    // Loader patches replace a targeted `config` key wholesale, so a personal
    // overlay repointing the model route drops every key the shipped row
    // declared. The runner reads the route through currentSelection() over
    // whatever composition survives, while its unique session identity stays
    // launcher-owned — the printed resume command names it exactly.
    const output = await smoke({
      label: 'dsh overlay keeps resume',
      tempDirPrefix: 'dsh-overlay-resume-',
      binScript: dshBinScript,
      prepare: seedWorkspace({
        personal: {
          'cordis.patch.yml': [
            '- id: agent-default-model',
            '  config:',
            '    provider: deepseek-official',
            '    model: deepseek-v4-flash',
            '- id: tui',
            '  config:',
            '    welcome: OVERLAY REPLACED THE CONFIG.',
            '',
          ].join('\n'),
        },
      }),
      actions: [{ waitFor: 'OVERLAY REPLACED THE CONFIG.', send: '/exit\r' }],
    })
    expect(output).toMatch(/Resume this session with: dsh tui --resume session-[0-9a-f-]+/u)
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('reports a failing platform shell command exactly once, as the terminal card exit pill', async () => {
    // The platform's shipped shell (`bash` on POSIX, `pwsh` on Windows) returns
    // a model-facing result ending in `[exit code: 3]`, which the terminal card
    // consumes into its own `[exit 3]` pill. Rendering both would report the same
    // exit twice, so the marker must not survive into the card body.
    const output = await smoke({
      label: 'dsh bash exit pill',
      tempDirPrefix: 'dsh-bash-exit-pill-',
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: 'Run the failing scripted command.\r',
        },
        { waitFor: 'Scripted shell failure observed.', send: '/exit\r' },
      ],
    })
    // The command really ran: its stdout is in the card body.
    expect(output).toContain('SCRIPTED_SHELL_FAILED')
    expect(output).toContain('[exit 3]')
    expect(output).not.toContain('[exit code: 3]')
  }, PTY_SMOKE_TEST_TIMEOUT_MS)

  it('distinguishes its source path from the current workdir', async () => {
    // The launcher resolves the checkout root three hops up from apps/cli/{src,lib};
    // this test file sits an equal depth under the same root, so the same hop applies.
    // The source-path line explicitly distinguishes that checkout from the current workdir.
    const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url))
    let context: LoggedRequestContext = { system: '' }
    await smoke({
      label: 'dsh source-path prompt',
      tempDirPrefix: 'dsh-source-path-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: 'exercise the TUI\r' },
        { waitFor: 'How should the scripted run proceed?', send: ANSWER_MULTI_WITH_CUSTOM },
        { waitFor: 'Decision received. Scripted TUI run complete.', send: '/exit\r' },
      ],
      inspect: async (cwd) => { context = await readLoggedRequestContext(cwd) },
    })
    expect(context.system).toContain(`The DeepSeek Harness implementation checkout is at ${sourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`)
  }, PTY_SMOKE_TEST_TIMEOUT_MS)
})
