import { describe, expect, it } from 'vitest'
import type {
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
} from '@deepseek-ai/dsh-shell'
import {
  createUserShellResultMessage,
  parseUserShellInput,
  parseUserShellResultMessage,
  renderUserShellResult,
  USER_SHELL_PLUGIN,
  UserShellProcessController,
  userShellJobOutcome,
  type UserShellProcessResult,
} from '../src/chat/shell-mode.ts'

function result(overrides: Partial<UserShellProcessResult> = {}): UserShellProcessResult {
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    output: '',
    outputTruncated: false,
    ...overrides,
  }
}

class FakeShellProcess implements ShellProcess {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  sandbox?: NonNullable<ShellProcess['sandbox']>
  readonly done: Promise<void>
  private settle!: () => void
  private reads: ShellProcessRead[] = []

  constructor() {
    this.done = new Promise<void>((resolve) => { this.settle = resolve })
  }

  push(delta: string, facts: Omit<ShellProcessRead, 'delta'> = { lossy: false }): void {
    this.reads.push({ delta, ...facts })
  }

  readOutput(): ShellProcessRead {
    const reads = this.reads.splice(0)
    let stdoutSpillPath: string | undefined
    let stderrSpillPath: string | undefined
    for (const read of reads) {
      stdoutSpillPath = read.stdoutSpillPath ?? stdoutSpillPath
      stderrSpillPath = read.stderrSpillPath ?? stderrSpillPath
    }
    return {
      delta: reads.map(read => read.delta).join(''),
      lossy: reads.some(read => read.lossy),
      ...stdoutSpillPath === undefined ? {} : { stdoutSpillPath },
      ...stderrSpillPath === undefined ? {} : { stderrSpillPath },
    }
  }

  finish(exitCode = 0): void {
    this.status = 'completed'
    this.exitCode = exitCode
    this.settle()
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.status = 'killed'
    this.signal = 'SIGTERM'
    this.settle()
    return true
  }
}

describe('direct shell message contract', () => {
  it('recognizes only a leading bang and preserves a bare-bang usage state', () => {
    expect(parseUserShellInput('! npm test')).toBe('npm test')
    expect(parseUserShellInput('!   printf ok   ')).toBe('printf ok')
    expect(parseUserShellInput('!')).toBe('')
    expect(parseUserShellInput('   ! npm test')).toBeUndefined()
    expect(parseUserShellInput('explain !important')).toBeUndefined()
  })

  it('renders combined output, truncation recovery, sandbox, and exit facts', () => {
    expect(renderUserShellResult('pnpm test', '/workspace', result({
      exitCode: 3,
      output: 'one\ntwo\n[stderr]\nfailed\n',
      outputTruncated: true,
      stdoutSpillPath: '/spill/stdout.log',
      sandbox: { mode: 'workspace-write', denied: true },
    }))).toBe([
      '<user-shell-command>',
      '$ pnpm test',
      'cwd: /workspace',
      '',
      'output:',
      'one\ntwo\n[stderr]\nfailed\n[earlier output omitted; full output: stdout: /spill/stdout.log]',
      '',
      'status: sandbox denied (workspace-write); exit code 3',
      '</user-shell-command>',
    ].join('\n'))
  })

  it('uses a plugin notice so output is durable context, not recalled human input', () => {
    const message = createUserShellResultMessage(
      'node -e "console.log(1)"',
      '/workspace',
      result({ output: '1\n' }),
    )

    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: USER_SHELL_PLUGIN,
      form: 'notice',
      summary: '$ node -e "console.log(1)" · exit code 0',
    })
    expect(message.content).toEqual([{
      type: 'text',
      text: [
        '<user-shell-command>',
        '$ node -e "console.log(1)"',
        'cwd: /workspace',
        '',
        'output:',
        '1\n',
        '',
        'status: exit code 0',
        '</user-shell-command>',
      ].join('\n'),
    }])
    expect(Object.isFrozen(message)).toBe(true)
    expect(parseUserShellResultMessage(message)).toEqual({
      command: 'node -e "console.log(1)"',
      workdir: '/workspace',
    })
  })

  it('recovers multiline commands only from exact user-shell plugin frames', () => {
    const command = 'printf one\nprintf two'
    const message = createUserShellResultMessage(command, '/workspace/project', result())
    expect(parseUserShellResultMessage(message)).toEqual({ command, workdir: '/workspace/project' })

    expect(parseUserShellResultMessage({
      ...message,
      source: { kind: 'user' },
    })).toBeUndefined()
    expect(parseUserShellResultMessage({
      ...message,
      content: [{ type: 'text', text: '<user-shell-command>\n$ forged\n</user-shell-command>' }],
    })).toBeUndefined()
  })

  it('fans one consuming process cursor out to live, job, and final views', async () => {
    const process = new FakeShellProcess()
    const live: string[] = []
    process.push('early\n')
    const controller = new UserShellProcessController(process, {
      maxOutputBytes: 64,
      refreshMs: 60_000,
      onOutput: snapshot => void live.push(snapshot.output),
    })

    expect(live).toEqual(['early\n'])
    expect(controller.readJobOutput()).toBe('early\n')
    expect(controller.readJobOutput()).toBe('')

    process.push('late\n')
    process.finish(7)
    const settled = await controller.done

    expect(settled).toMatchObject({
      status: 'completed',
      exitCode: 7,
      output: 'early\nlate\n',
      outputTruncated: false,
    })
    expect(controller.readJobOutput()).toBe('late\n')
    expect(userShellJobOutcome(settled)).toEqual({ status: 'completed', detail: 'exit code: 7' })
  })

  it('retains lossy/spill recovery facts across the final drain', async () => {
    const process = new FakeShellProcess()
    const controller = new UserShellProcessController(process, {
      maxOutputBytes: 8,
      refreshMs: 60_000,
      onOutput: () => {},
    })
    process.push('0123456789', {
      lossy: true,
      stdoutSpillPath: '/spill/full.log',
    })
    process.finish()

    await expect(controller.done).resolves.toMatchObject({
      output: '23456789',
      outputTruncated: true,
      stdoutSpillPath: '/spill/full.log',
    })
  })

  it('bounds a multiline command summary while retaining exact command text', () => {
    const command = `printf one\n${'x'.repeat(180)}`
    const message = createUserShellResultMessage(command, '/workspace', result())
    const source = message.source

    expect(source.kind === 'plugin' && source.form === 'notice' && source.summary.length).toBe(120)
    expect(source.kind === 'plugin' && source.form === 'notice' && source.summary).not.toContain('\n')
    expect(message.content[0]?.type === 'text' && message.content[0].text).toContain(command)
  })
})
