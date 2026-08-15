/** Windows Git Bash executor used by the terminal surface instead of a PTY. */

import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config } from '@deepseek-ai/dsh-bash-local'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export const name = 'tui-gitbash-executor'

/**
 * Git for Windows cannot initialize its MSYS signal pipes under DSH's
 * restricted token. Keep the bash schema stable, but fail before spawning
 * unless the call explicitly selected full access. This lets the ordinary
 * bash tool expose its standard one-call escalation field.
 */
export class GitBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandboxPolicy']

  constructor(ctx: Context, config: Config) {
    super(ctx, { ...config, executable: config.executable ?? 'auto' })
  }

  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...super.resolve(request),
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
    }
  }

  private requireFullAccess(spec: ShellExecSpec): SandboxExecutionPolicy {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    if (policy.mode !== 'danger-full-access') {
      throw new Error(
        `Git Bash cannot start inside the Windows "${policy.mode}" restricted-token sandbox. `
        + 'Retry this command with sandbox_permissions: "danger-full-access" and a justification, '
        + 'or use /bypass on for this session.',
      )
    }
    return policy
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const policy = this.requireFullAccess(spec)
    const result = await super.run(spec)
    return { ...result, sandbox: { mode: policy.mode, denied: false } }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const policy = this.requireFullAccess(spec)
    const process = super.start(spec)
    process.sandbox = { mode: policy.mode, denied: false }
    return process
  }
}

export default GitBashExecutor
