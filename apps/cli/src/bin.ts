#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const rawArgs = process.argv.slice(2)
// `deepseek`/bare `dsh` behave like `code`: launch the interactive experience
// in the caller's current directory. TUI-owned startup flags also imply TUI,
// while explicit web/plugin/profile invocations keep their existing routing.
const defaultTui = rawArgs.length === 0
  || rawArgs[0] === '--resume'
  || rawArgs[0] === '--dangerously-skip-permissions'
const invocation = parseDshArgs(defaultTui ? ['tui', ...rawArgs] : rawArgs, readVersion())

switch (invocation.mode) {
  case 'profile': {
    // Match Claude Code's explicit bypass flag without making users pre-seed
    // DSH_PERMISSION_MODE. This must happen before Loader evaluates the profile
    // so Windows can select the unconfined Git Bash tool when it is available.
    if (invocation.profile === 'tui' && invocation.args.includes('--dangerously-skip-permissions')) {
      process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    }
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
