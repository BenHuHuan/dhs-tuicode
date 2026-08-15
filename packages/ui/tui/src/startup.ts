/**
 * The interactive app's command-line provider: it parses `--resume` and
 * `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the session identity can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The session to resume in place; absent starts a uniquely identified fresh session. */
  resumeSessionId?: string
  /** Start in full-access/never-ask mode after an explicit CLI opt-in. */
  dangerouslySkipPermissions?: boolean
}

/**
 * This app's command: the resume option and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Start the interactive terminal UI driving one agent session.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <sessionId>', 'resume the named session in place instead of starting fresh')
    .option('--dangerously-skip-permissions', 'start in full-access mode without approval prompts')
    .addHelpText('after', `
Examples:
  dsh --profile tui                 start a fresh interactive session
  dsh --profile tui --resume <id>   resume an existing session
  dsh --profile tui --dangerously-skip-permissions
`)
}

/**
 * Parse and provide the session identity as an ordinary Cordis service. The
 * command's action publishes the values; `--help` and parse errors publish
 * nothing, so the runner stays dormant and the process exits through the
 * standard cmdline path.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((options: { resume?: string; dangerouslySkipPermissions?: boolean }) => {
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(options.resume === undefined ? {} : { resumeSessionId: options.resume }),
      ...(options.dangerouslySkipPermissions === true ? { dangerouslySkipPermissions: true } : {}),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
