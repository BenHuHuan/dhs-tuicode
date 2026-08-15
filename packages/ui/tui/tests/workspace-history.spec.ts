import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkspaceHistory } from '../src/workspace-history.ts'

const execFile = promisify(execFileCallback)
const roots: string[] = []

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true })
  return String(stdout)
}

async function createRepository(): Promise<{ root: string; home: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-tui-workspace-history-'))
  roots.push(sandbox)
  const root = join(sandbox, 'workspace')
  const home = join(sandbox, 'home')
  await mkdir(root)
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.email', 'tui-tests@example.invalid'])
  await git(root, ['config', 'user.name', 'TUI tests'])
  await git(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n', 'utf8')
  await writeFile(join(root, 'tracked.txt'), 'base\n', 'utf8')
  await git(root, ['add', '.gitignore', 'tracked.txt'])
  await git(root, ['commit', '--quiet', '-m', 'initial'])
  return { root, home }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalWorkspaceHistory', () => {
  it('round-trips staged, unstaged, and nonignored untracked state while preserving ignored files', async () => {
    const { root, home } = await createRepository()
    const history = new LocalWorkspaceHistory({ home, now: () => 1_700_000_000_000 })
    const signal = new AbortController().signal
    const sessionId = SessionId('workspace-history-main')

    await writeFile(join(root, 'tracked.txt'), 'staged\n', 'utf8')
    await git(root, ['add', 'tracked.txt'])
    await writeFile(join(root, 'tracked.txt'), 'staged\nworking\n', 'utf8')
    await writeFile(join(root, 'untracked.txt'), 'checkpoint copy\n', 'utf8')
    await writeFile(join(root, 'ignored.txt'), 'leave me alone\n', 'utf8')

    const checkpoint = await history.createCheckpoint({
      cwd: root,
      sessionId,
      sessionBoundary: 12,
      label: 'Before experiment',
      signal,
    })
    expect(checkpoint.workspace).toEqual({ kind: 'git', trackedFiles: 1, untrackedFiles: 1 })

    const diff = await history.diff({ cwd: root, signal })
    expect(diff.changedFiles).toBe(2)
    expect(diff.lines.join('\n')).toContain('Staged changes')
    expect(diff.lines.join('\n')).toContain('Unstaged changes')
    expect(diff.lines.join('\n')).toContain('?? untracked.txt')

    await writeFile(join(root, 'tracked.txt'), 'after checkpoint\n', 'utf8')
    await git(root, ['add', 'tracked.txt'])
    await writeFile(join(root, 'untracked.txt'), 'later copy\n', 'utf8')
    await writeFile(join(root, 'created-later.txt'), 'remove me\n', 'utf8')

    const restored = await history.restoreCheckpoint({
      checkpoint,
      cwd: root,
      sessionId,
      sessionBoundary: 24,
      signal,
    })
    expect(restored.backup.workspace.kind).toBe('git')
    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nworking\n')
    await expect(readFile(join(root, 'untracked.txt'), 'utf8')).resolves.toBe('checkpoint copy\n')
    await expect(access(join(root, 'created-later.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'ignored.txt'), 'utf8')).resolves.toBe('leave me alone\n')
    await expect(git(root, ['diff', '--cached', '--', 'tracked.txt'])).resolves.toContain('+staged')
    await expect(git(root, ['diff', '--', 'tracked.txt'])).resolves.toContain('+working')

    const checkpoints = await history.listCheckpoints({ sessionId, signal })
    expect(checkpoints.map(item => item.id)).toContain(checkpoint.id)
    expect(checkpoints.map(item => item.id)).toContain(restored.backup.id)
  })

  it('refuses to cross a Git commit when restoring a checkpoint', async () => {
    const { root, home } = await createRepository()
    const history = new LocalWorkspaceHistory({ home })
    const signal = new AbortController().signal
    const sessionId = SessionId('workspace-history-commit-guard')
    await writeFile(join(root, 'tracked.txt'), 'checkpoint state\n', 'utf8')
    const checkpoint = await history.createCheckpoint({ cwd: root, sessionId, sessionBoundary: 3, signal })

    await git(root, ['add', 'tracked.txt'])
    await git(root, ['commit', '--quiet', '-m', 'after checkpoint'])

    await expect(history.restoreCheckpoint({
      checkpoint,
      cwd: root,
      sessionId,
      sessionBoundary: 4,
      signal,
    })).rejects.toThrow('Git HEAD changed after this checkpoint')
  })

  it('keeps restore within a nested session directory even when Git sees a rename', async () => {
    const { root, home } = await createRepository()
    const scope = join(root, 'inside')
    const outside = join(root, 'outside')
    await mkdir(scope)
    await mkdir(outside)
    await writeFile(join(scope, 'nested.txt'), 'inside base\n', 'utf8')
    await writeFile(join(outside, 'untouched.txt'), 'outside base\n', 'utf8')
    await git(root, ['add', 'inside/nested.txt', 'outside/untouched.txt'])
    await git(root, ['commit', '--quiet', '-m', 'nested initial'])

    const history = new LocalWorkspaceHistory({ home })
    const signal = new AbortController().signal
    const sessionId = SessionId('workspace-history-nested-scope')
    await git(root, ['mv', 'inside/nested.txt', 'outside/moved.txt'])
    const checkpoint = await history.createCheckpoint({ cwd: scope, sessionId, sessionBoundary: 5, signal })
    const diff = await history.diff({ cwd: scope, signal })
    expect(diff.lines.join('\n')).toContain('inside/nested.txt')
    expect(diff.lines.join('\n')).not.toContain('outside/moved.txt')

    await writeFile(join(outside, 'moved.txt'), 'outside later\n', 'utf8')
    await history.restoreCheckpoint({ checkpoint, cwd: scope, sessionId, sessionBoundary: 6, signal })

    await expect(access(join(scope, 'nested.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(outside, 'moved.txt'), 'utf8')).resolves.toBe('outside later\n')
  })

  it('finishes a confirmed restore after its safety checkpoint has been captured', async () => {
    const { root, home } = await createRepository()
    const history = new LocalWorkspaceHistory({ home })
    const sessionId = SessionId('workspace-history-restore-commitment')
    const initialSignal = new AbortController().signal
    await writeFile(join(root, 'tracked.txt'), 'checkpoint state\n', 'utf8')
    const checkpoint = await history.createCheckpoint({
      cwd: root,
      sessionId,
      sessionBoundary: 7,
      signal: initialSignal,
    })
    await writeFile(join(root, 'tracked.txt'), 'later state\n', 'utf8')

    const controller = new AbortController()
    const originalCreateCheckpoint = history.createCheckpoint.bind(history)
    const createCheckpoint = vi.spyOn(history, 'createCheckpoint')
    createCheckpoint.mockImplementation(async (request) => {
      const result = await originalCreateCheckpoint(request)
      if (request.label?.startsWith('Before rewind ') === true) controller.abort()
      return result
    })

    await history.restoreCheckpoint({
      checkpoint,
      cwd: root,
      sessionId,
      sessionBoundary: 8,
      signal: controller.signal,
    })

    expect(controller.signal.aborted).toBe(true)
    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe('checkpoint state\n')
  })

  it('retains a conversation-only checkpoint outside a Git worktree', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-tui-workspace-history-no-git-'))
    roots.push(sandbox)
    const cwd = join(sandbox, 'plain-directory')
    const home = join(sandbox, 'home')
    await mkdir(cwd)
    const history = new LocalWorkspaceHistory({ home })
    const signal = new AbortController().signal
    const sessionId = SessionId('workspace-history-no-git')

    const checkpoint = await history.createCheckpoint({ cwd, sessionId, sessionBoundary: 7, signal })
    expect(checkpoint.workspace.kind).toBe('unavailable')
    await expect(history.listCheckpoints({ sessionId, signal })).resolves.toEqual([checkpoint])
    await expect(history.restoreCheckpoint({
      checkpoint,
      cwd,
      sessionId,
      sessionBoundary: 8,
      signal,
    })).rejects.toThrow('only its conversation boundary can be restored')
  })
})
