import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { resolveExampleLaunch, type ExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const POSIX_PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, launch_args_json, launch_env_json, cwd, actions_json, expected_exit, timeout_seconds, columns, rows = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({"COLUMNS": columns, "LINES": rows})
# Deterministic banner: a developer shell's COLORTERM=truecolor would switch the
# banner to the per-letter gradient (one SGR per letter), breaking literal
# DEEPSEEK assertions. The gradient path has its own unit and snapshot coverage.
env.pop("COLORTERM", None)
actions = json.loads(actions_json)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(columns), 0, 0))

output = bytearray()
action_index = 0
deadline = time.monotonic() + float(timeout_seconds)
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
    while action_index < len(actions):
        marker = actions[action_index]["waitFor"].encode()
        if output.count(marker) < actions[action_index].get("occurrence", 1):
            break
        action = actions[action_index]
        if "signal" in action:
            os.kill(pid, getattr(signal, action["signal"]))
        elif "writeFile" in action:
            target = os.path.join(cwd, action["writeFile"]["path"])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(action["writeFile"]["content"])
            if "send" in action:
                os.write(fd, action["send"].encode())
        else:
            os.write(fd, action["send"].encode())
        action_index += 1
        if action.get("separateInput", False):
            break
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if action_index != len(actions):
    sys.stderr.write(f"completed {action_index}/{len(actions)} PTY actions before timeout\n")
    sys.exit(124)
actual_exit = os.waitstatus_to_exitcode(status)
if actual_exit != int(expected_exit):
    sys.stderr.write(f"expected exit {expected_exit}, got {actual_exit}\n")
    sys.exit(125)
`

/** One terminal input or workspace mutation performed after its marker renders. */
type TuiPtyAction =
  | {
    readonly waitFor: string
    readonly occurrence?: number
    readonly send: string
    /** Process no later marker until the PTY has advanced to another input/output turn. */
    readonly separateInput?: boolean
  }
  | { readonly waitFor: string; readonly occurrence?: number; readonly signal: 'SIGTERM' }
  | {
    readonly waitFor: string
    readonly occurrence?: number
    readonly writeFile: { readonly path: string; readonly content: string }
    readonly send?: string
  }

/** Inputs for a keyless real-Loader TUI process smoke. */
export interface TuiPtySmokeOptions {
  readonly label: string
  readonly tempDirPrefix: string
  readonly binScript: string
  /** Config argument; ignored when {@link configArgs} is set. */
  readonly configPath?: string
  /** Full argument vector for the bin (e.g. `[]` for a bin with a built-in default config). */
  readonly configArgs?: readonly string[]
  readonly tsconfigPath: string
  readonly actions?: readonly TuiPtyAction[]
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly expectedExitCode?: number
  readonly timeoutMs?: number
  /** Existing isolated workspace to reuse; when omitted the harness creates and removes one. */
  readonly cwd?: string
  /** Pseudo-terminal columns; defaults to 100. */
  readonly columns?: number
  /** Pseudo-terminal rows; defaults to 30. */
  readonly rows?: number
  /** Seed the isolated workspace (`cwd`, with `$DSH_HOME` at `.dsh` and the agents home at `.agents`) before launch. */
  readonly prepare?: (cwd: string) => Promise<void>
  /** Inspect the workspace after a passing run, before the temp dir is removed. */
  readonly inspect?: (cwd: string) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function runPosixPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: TuiPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  // The driver owns the PTY deadline (`timeoutMs`); the outer execa deadline
  // only backstops a wedged python3 process itself.
  const result = await execa('python3', [
    '-c',
    POSIX_PTY_DRIVER,
    launch.command,
    JSON.stringify(launch.args),
    JSON.stringify(launch.env),
    cwd,
    JSON.stringify(options.actions ?? []),
    String(options.expectedExitCode ?? 0),
    String(timeoutMs / 1_000),
    String(options.columns ?? 100),
    String(options.rows ?? 30),
  ], {
    stdin: 'ignore',
    timeout: timeoutMs + 5_000,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  if (result.timedOut) {
    throw new Error(`${options.label} PTY driver did not exit. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  if (result.failed) {
    throw new Error(`${options.label} PTY driver exited ${String(result.exitCode)}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result.stdout
}

async function runWindowsPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: TuiPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  const pty = await import('node-pty')
  return await new Promise((resolve, reject) => {
    const actions = options.actions ?? []
    const expectedExitCode = options.expectedExitCode ?? 0
    let output = ''
    let actionIndex = 0
    let timedOut = false
    const terminal = pty.spawn(launch.command, launch.args, {
      name: 'xterm-256color',
      cols: options.columns ?? 100,
      rows: options.rows ?? 30,
      cwd,
      env: definedEnv({
        ...process.env,
        ...launch.env,
        // Match the POSIX driver: no COLORTERM, so the banner never takes the
        // truecolor gradient path under a developer's shell.
        COLORTERM: undefined,
        COLUMNS: String(options.columns ?? 100),
        LINES: String(options.rows ?? 30),
      }),
    })
    const timer = setTimeout(() => {
      timedOut = true
      terminal.kill()
    }, timeoutMs)
    terminal.onData((chunk) => {
      output += chunk
      while (
        actionIndex < actions.length
        && output.split(actions[actionIndex]!.waitFor).length - 1 >= (actions[actionIndex]!.occurrence ?? 1)
      ) {
        const action = actions[actionIndex]!
        if ('signal' in action) {
          terminal.kill(action.signal)
        } else if ('writeFile' in action) {
          const target = join(cwd, action.writeFile.path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, action.writeFile.content)
          const input = action.send
          if (input !== undefined) terminal.write(input)
        } else {
          terminal.write(action.send)
        }
        actionIndex += 1
        if ('separateInput' in action && action.separateInput) break
      }
    })
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${options.label} PTY process did not exit before ${String(timeoutMs)}ms. output:\n${output}`))
      } else if (actionIndex !== actions.length) {
        reject(new Error(`${options.label} completed ${String(actionIndex)}/${String(actions.length)} PTY actions. output:\n${output}`))
      } else if (exitCode !== expectedExitCode) {
        reject(new Error(`${options.label} expected exit ${String(expectedExitCode)}, got ${String(exitCode)} (signal ${String(signal)}). output:\n${output}`))
      } else {
        resolve(output)
      }
    })
  })
}

/**
 * Boot an example in a real pseudo-terminal (ConPTY on Windows), drive
 * marker-gated input, and return captured bytes after the expected process exit.
 * @param options - launch paths, environment, actions, and expected exit code.
 * @returns complete pseudo-terminal output.
 */
export async function runTuiPtySmoke(options: TuiPtySmokeOptions): Promise<string> {
  const ownedCwd = options.cwd === undefined
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const timeoutMs = options.timeoutMs ?? 25_000
  try {
    await options.prepare?.(cwd)
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      // The profile launcher owns `--profile`/`--patch`; `configArgs` is the
      // raw-args escape (e.g. `['--resume', <id>]`) for other flags. Boot the
      // shipped TUI profile by default, layering `configPath` as a `--patch`
      // overlay when one is supplied.
      configArgs: options.configArgs !== undefined
        ? [...options.configArgs]
        /* v8 ignore next -- every caller passes configPath or configArgs; the fallback keeps the type total */
        : options.configPath !== undefined ? ['--profile', 'tui', '--patch', options.configPath] : ['--profile', 'tui'],
      tsconfigPath: options.tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
      },
    })
    const output = process.platform === 'win32'
      ? await runWindowsPtySmoke(launch, cwd, options, timeoutMs)
      : await runPosixPtySmoke(launch, cwd, options, timeoutMs)
    // Inspect the workspace before `finally` removes it (e.g. the session log).
    await options.inspect?.(cwd)
    return output
  } finally {
    if (ownedCwd) await rm(cwd, { recursive: true, force: true })
  }
}
