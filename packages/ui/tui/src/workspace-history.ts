/**
 * Durable, host-owned Git workspace snapshots for the terminal checkpoint
 * controls. Checkpoints live below DSH_HOME rather than in the worktree, so
 * capturing or restoring them never creates project files of its own.
 * @module @deepseek-ai/dsh-tui/workspace-history
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import {
  WorkspaceCheckpointId,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointListRequest,
  type WorkspaceCheckpointRequest,
  type WorkspaceDiff,
  type WorkspaceDiffRequest,
  type WorkspaceHistory,
  type WorkspaceRestoreRequest,
  type WorkspaceRestoreResult,
} from './runtime.ts'

const STORAGE_VERSION = 1
const META_FILENAME = 'checkpoint.json'
const STAGED_PATCH_FILENAME = 'staged.patch'
const WORKTREE_PATCH_FILENAME = 'worktree.patch'
const UNTRACKED_FILENAME = 'untracked.json'
const CHECKPOINT_ID_PATTERN = /^checkpoint-[a-z0-9]+-[0-9a-f-]+$/u
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u

type PersistedWorkspace = PersistedGitWorkspace | PersistedUnavailableWorkspace

interface PersistedGitWorkspace {
  readonly kind: 'git'
  readonly root: string
  readonly scope: string
  readonly head: string
  readonly trackedFiles: number
  readonly untrackedFiles: number
}

interface PersistedUnavailableWorkspace {
  readonly kind: 'unavailable'
  readonly reason: string
}

interface PersistedCheckpoint {
  readonly version: number
  readonly id: string
  readonly sessionId: string
  readonly sessionBoundary: number
  readonly createdAt: number
  readonly label?: string
  readonly workspace: PersistedWorkspace
}

interface PersistedUntrackedEntry {
  readonly path: string
  readonly kind: 'file' | 'symlink'
  readonly mode: number
  readonly target?: string
}

interface PersistedUntrackedManifest {
  readonly version: number
  readonly entries: readonly PersistedUntrackedEntry[]
}

interface GitScope {
  readonly root: string
  readonly scope: string
  readonly pathspec: string
  readonly head: string
}

/** Optional local-history construction settings for a host or focused test. */
export interface LocalWorkspaceHistoryOptions {
  /** Explicit durable root for tests or a nondefault host; defaults to DSH_HOME. */
  readonly home?: string
  /** Clock used when allocating checkpoint ids and metadata. */
  readonly now?: () => number
}

const persistedGitWorkspaceSchema = z.object({
  kind: z.const('git').required(),
  root: z.string().required(),
  scope: z.string().required(),
  head: z.string().required(),
  trackedFiles: z.number().step(1).min(0).required(),
  untrackedFiles: z.number().step(1).min(0).required(),
}).required()

const persistedUnavailableWorkspaceSchema = z.object({
  kind: z.const('unavailable').required(),
  reason: z.string().required(),
}).required()

const persistedCheckpointSchema = z.object({
  version: z.number().step(1).min(STORAGE_VERSION).required(),
  id: z.string().required(),
  sessionId: z.string().required(),
  sessionBoundary: z.number().step(1).min(0).required(),
  createdAt: z.number().required(),
  label: z.string(),
  workspace: z.union([persistedGitWorkspaceSchema, persistedUnavailableWorkspaceSchema]).required(),
}).required()

const persistedUntrackedEntrySchema = z.object({
  path: z.string().required(),
  kind: z.union([z.const('file'), z.const('symlink')]).required(),
  mode: z.number().step(1).min(0).required(),
  target: z.string(),
}).required()

const persistedUntrackedManifestSchema = z.object({
  version: z.number().step(1).min(STORAGE_VERSION).required(),
  entries: z.array(persistedUntrackedEntrySchema).required(),
}).required()

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function gitFailure(args: readonly string[], error: unknown, stderr: string): Error {
  const detail = stderr.trim() || (error instanceof Error ? error.message : String(error))
  return new Error(`Git ${args[0] ?? 'command'} failed: ${detail}`)
}

function checkpointDirectoryName(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function checkpointId(createdAt: number): ReturnType<typeof WorkspaceCheckpointId> {
  return WorkspaceCheckpointId(`checkpoint-${createdAt.toString(36)}-${randomUUID()}`)
}

function assertCheckpointId(value: string): void {
  if (!CHECKPOINT_ID_PATTERN.test(value)) throw new Error(`Invalid workspace checkpoint id "${value}".`)
}

function assertObjectId(value: string): void {
  if (!GIT_OBJECT_ID_PATTERN.test(value)) throw new Error('Workspace checkpoint contains an invalid Git revision.')
}

function isWithin(base: string, candidate: string): boolean {
  const path = relative(base, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function checkedRelativePath(root: string, raw: string): string {
  const normalized = raw.replaceAll('\\', '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`Workspace checkpoint contains an unsafe path "${raw}".`)
  }
  const absolute = resolve(root, ...normalized.split('/'))
  if (!isWithin(root, absolute) || absolute === root) {
    throw new Error(`Workspace checkpoint path escapes its worktree: "${raw}".`)
  }
  return normalized
}

function pathFor(root: string, relativePath: string): string {
  return resolve(root, ...relativePath.split('/'))
}

function trimTrailingEmptyLine(value: string): string[] {
  const lines = value.replace(/\r\n/gu, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function publicCheckpoint(checkpoint: PersistedCheckpoint): WorkspaceCheckpoint {
  return {
    id: WorkspaceCheckpointId(checkpoint.id),
    sessionId: checkpoint.sessionId as WorkspaceCheckpoint['sessionId'],
    sessionBoundary: checkpoint.sessionBoundary,
    createdAt: checkpoint.createdAt,
    ...checkpoint.label === undefined ? {} : { label: checkpoint.label },
    workspace: checkpoint.workspace.kind === 'git'
      ? {
        kind: 'git',
        trackedFiles: checkpoint.workspace.trackedFiles,
        untrackedFiles: checkpoint.workspace.untrackedFiles,
      }
      : { kind: 'unavailable', reason: checkpoint.workspace.reason },
  }
}

/**
 * Local DSH_HOME implementation of the host-owned workspace history API.
 * It captures staged and unstaged Git patches plus nonignored untracked files;
 * restore first saves the current state as a separately visible safety point.
 */
export class LocalWorkspaceHistory implements WorkspaceHistory {
  private readonly root: string
  private readonly now: () => number

  /**
   * @param options - Optional durable root and test clock.
   */
  constructor(options: LocalWorkspaceHistoryOptions = {}) {
    this.root = resolve(options.home ?? resolveDshHome())
    this.now = options.now ?? Date.now
  }

  /**
   * Capture a new checkpoint in a staging directory and atomically publish it
   * only after every patch and untracked file is durable in that directory.
   * @param request - Active session and workspace capture request.
   * @returns The newly published checkpoint descriptor.
   */
  async createCheckpoint(request: WorkspaceCheckpointRequest): Promise<WorkspaceCheckpoint> {
    request.signal.throwIfAborted()
    const createdAt = this.now()
    const id = checkpointId(createdAt)
    const sessionDirectory = this.sessionDirectory(String(request.sessionId))
    const staging = join(sessionDirectory, `.${String(id)}.staging`)
    const destination = join(sessionDirectory, String(id))
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
    await mkdir(staging, { mode: 0o700 })
    try {
      const workspace = await this.captureWorkspace(request.cwd, staging, request.signal)
      const checkpoint: PersistedCheckpoint = {
        version: STORAGE_VERSION,
        id: String(id),
        sessionId: String(request.sessionId),
        sessionBoundary: request.sessionBoundary,
        createdAt,
        ...request.label === undefined ? {} : { label: request.label },
        workspace,
      }
      await writeFile(join(staging, META_FILENAME), `${JSON.stringify(checkpoint)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        signal: request.signal,
      })
      request.signal.throwIfAborted()
      await rename(staging, destination)
      return publicCheckpoint(checkpoint)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Read this session's published checkpoint metadata, newest first.
   * @param request - Active session checkpoint-list request.
   * @returns Valid durable checkpoints owned by that exact session.
   */
  async listCheckpoints(request: WorkspaceCheckpointListRequest): Promise<readonly WorkspaceCheckpoint[]> {
    request.signal.throwIfAborted()
    const directory = this.sessionDirectory(String(request.sessionId))
    const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    if (entries === undefined) return []
    const checkpoints: WorkspaceCheckpoint[] = []
    for (const entry of entries) {
      request.signal.throwIfAborted()
      if (!entry.isDirectory() || !CHECKPOINT_ID_PATTERN.test(entry.name)) continue
      const checkpoint = await this.readCheckpoint(request.sessionId, WorkspaceCheckpointId(entry.name), request.signal)
      checkpoints.push(publicCheckpoint(checkpoint))
    }
    return checkpoints.sort((left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)))
  }

  /**
   * Read staged, unstaged, and nonignored-untracked changes beneath the active
   * session directory without changing the worktree.
   * @param request - Workspace diff request.
   * @returns One pager-ready readable diff.
   */
  async diff(request: WorkspaceDiffRequest): Promise<WorkspaceDiff> {
    const scope = await this.gitScope(request.cwd, request.signal)
    const [staged, unstaged, untracked, stagedNames, unstagedNames] = await Promise.all([
      this.git(scope.root, ['diff', '--cached', '--no-ext-diff', '--no-color', '--no-renames', 'HEAD', '--', scope.pathspec], request.signal),
      this.git(scope.root, ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--', scope.pathspec], request.signal),
      this.untrackedPaths(scope, request.signal),
      this.git(scope.root, ['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--', scope.pathspec], request.signal),
      this.git(scope.root, ['diff', '--name-only', '--no-renames', '--', scope.pathspec], request.signal),
    ])
    const changed = new Set([
      ...trimTrailingEmptyLine(stagedNames),
      ...trimTrailingEmptyLine(unstagedNames),
      ...untracked,
    ])
    const lines: string[] = []
    if (staged.trim() !== '') lines.push('Staged changes', '', ...trimTrailingEmptyLine(staged))
    if (staged.trim() !== '' && (unstaged.trim() !== '' || untracked.length > 0)) lines.push('')
    if (unstaged.trim() !== '') lines.push('Unstaged changes', '', ...trimTrailingEmptyLine(unstaged))
    if (unstaged.trim() !== '' && untracked.length > 0) lines.push('')
    if (untracked.length > 0) lines.push('Untracked files', '', ...untracked.map(path => `?? ${path}`))
    if (lines.length === 0) lines.push('No uncommitted changes in this workspace.')
    return {
      title: 'Workspace diff',
      lines,
      changedFiles: changed.size,
    }
  }

  /**
   * Create an automatic pre-rewind safety point, then return the selected Git
   * scope to the durable checkpoint state. A failed apply attempts that safety
   * point immediately before surfacing its failure.
   * @param request - Confirmed checkpoint restore request.
   * @returns The safety checkpoint created before worktree mutation.
   */
  async restoreCheckpoint(request: WorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> {
    request.signal.throwIfAborted()
    const checkpoint = await this.readCheckpoint(request.sessionId, request.checkpoint.id, request.signal)
    if (checkpoint.workspace.kind !== 'git') {
      throw new Error('This checkpoint has no Git workspace snapshot; only its conversation boundary can be restored.')
    }
    const scope = await this.gitScope(request.cwd, request.signal)
    this.assertMatchingScope(checkpoint.workspace, scope)
    const backup = await this.createCheckpoint({
      cwd: request.cwd,
      sessionId: request.sessionId,
      sessionBoundary: request.sessionBoundary,
      label: `Before rewind ${String(request.checkpoint.id)}`,
      signal: request.signal,
    })
    if (backup.workspace.kind !== 'git') {
      throw new Error(`Could not create a Git safety checkpoint before rewind: ${backup.workspace.reason ?? 'workspace unavailable'}`)
    }
    // Cancellation remains meaningful while preflighting and capturing the
    // safety point. Once that point is durable, a partially applied Git patch
    // is less safe than finishing the selected restore or restoring that
    // safety point, so mutation and recovery deliberately use a fresh signal.
    const mutationSignal = new AbortController().signal
    const mutationScope = await this.gitScope(request.cwd, mutationSignal)
    this.assertMatchingScope(checkpoint.workspace, mutationScope)
    try {
      await this.applyCheckpoint(checkpoint, mutationScope, mutationSignal)
      return { backup }
    } catch (error) {
      try {
        const backupRecord = await this.readCheckpoint(request.sessionId, backup.id, mutationSignal)
        if (backupRecord.workspace.kind === 'git') await this.applyCheckpoint(backupRecord, mutationScope, mutationSignal)
      } catch (recoveryError) {
        throw new Error(`Workspace rewind failed and safety restore also failed: ${this.errorText(error)}; ${this.errorText(recoveryError)}`)
      }
      throw new Error(`Workspace rewind failed; the pre-rewind safety checkpoint was restored: ${this.errorText(error)}`)
    }
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.root, 'workspace-checkpoints', `v${String(STORAGE_VERSION)}`, checkpointDirectoryName(sessionId))
  }

  private checkpointDirectory(sessionId: string, id: string): string {
    assertCheckpointId(id)
    return join(this.sessionDirectory(sessionId), id)
  }

  private async captureWorkspace(cwd: string, staging: string, signal: AbortSignal): Promise<PersistedWorkspace> {
    let scope: GitScope
    try {
      scope = await this.gitScope(cwd, signal)
    } catch (error) {
      signal.throwIfAborted()
      return { kind: 'unavailable', reason: this.errorText(error) }
    }
    const [stagedNames, unstagedNames, untracked] = await Promise.all([
      this.git(scope.root, ['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--', scope.pathspec], signal),
      this.git(scope.root, ['diff', '--name-only', '--no-renames', '--', scope.pathspec], signal),
      this.untrackedPaths(scope, signal),
    ])
    await Promise.all([
      this.gitToFile(
        scope.root,
        ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-color', '--no-renames', 'HEAD', '--', scope.pathspec],
        join(staging, STAGED_PATCH_FILENAME),
        signal,
      ),
      this.gitToFile(
        scope.root,
        ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', '--no-renames', '--', scope.pathspec],
        join(staging, WORKTREE_PATCH_FILENAME),
        signal,
      ),
    ])
    const manifest = await this.captureUntracked(scope, untracked, staging, signal)
    const tracked = new Set([...trimTrailingEmptyLine(stagedNames), ...trimTrailingEmptyLine(unstagedNames)])
    return {
      kind: 'git',
      root: scope.root,
      scope: scope.scope,
      head: scope.head,
      trackedFiles: tracked.size,
      untrackedFiles: manifest.entries.length,
    }
  }

  private async captureUntracked(
    scope: GitScope,
    paths: readonly string[],
    staging: string,
    signal: AbortSignal,
  ): Promise<PersistedUntrackedManifest> {
    const filesDirectory = join(staging, 'untracked')
    const entries: PersistedUntrackedEntry[] = []
    for (const rawPath of paths) {
      signal.throwIfAborted()
      const path = checkedRelativePath(scope.root, rawPath)
      const source = pathFor(scope.root, path)
      if (!isWithin(scope.scope, source)) throw new Error(`Git reported a path outside this workspace scope: "${path}".`)
      const details = await lstat(source)
      const target = pathFor(filesDirectory, path)
      if (details.isFile()) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(source, target)
        await chmod(target, details.mode & 0o777)
        entries.push({ path, kind: 'file', mode: details.mode & 0o777 })
      } else if (details.isSymbolicLink()) {
        entries.push({
          path,
          kind: 'symlink',
          mode: details.mode & 0o777,
          target: await readlink(source),
        })
      } else {
        throw new Error(`Cannot checkpoint nonregular untracked path "${path}".`)
      }
    }
    const manifest: PersistedUntrackedManifest = { version: STORAGE_VERSION, entries }
    await writeFile(join(staging, UNTRACKED_FILENAME), `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      signal,
    })
    return manifest
  }

  private async applyCheckpoint(checkpoint: PersistedCheckpoint, scope: GitScope, signal: AbortSignal): Promise<void> {
    if (checkpoint.workspace.kind !== 'git') throw new Error('Checkpoint has no Git worktree state.')
    this.assertMatchingScope(checkpoint.workspace, scope)
    const directory = this.checkpointDirectory(checkpoint.sessionId, checkpoint.id)
    const manifest = await this.readManifest(directory, scope.root, signal)
    const currentUntracked = await this.untrackedPaths(scope, signal)
    for (const rawPath of currentUntracked) {
      signal.throwIfAborted()
      const path = checkedRelativePath(scope.root, rawPath)
      const target = pathFor(scope.root, path)
      if (!isWithin(scope.scope, target)) throw new Error(`Git reported a path outside this workspace scope: "${path}".`)
      const details = await lstat(target)
      await rm(target, { recursive: details.isDirectory() && !details.isSymbolicLink(), force: true })
    }
    await this.git(scope.root, [
      'restore',
      `--source=${checkpoint.workspace.head}`,
      '--staged',
      '--worktree',
      '--',
      scope.pathspec,
    ], signal)
    const stagedPatch = join(directory, STAGED_PATCH_FILENAME)
    const worktreePatch = join(directory, WORKTREE_PATCH_FILENAME)
    await this.assertRegularCheckpointFile(stagedPatch)
    await this.assertRegularCheckpointFile(worktreePatch)
    // `git apply` rejects an empty patch. An empty artifact is the normal
    // representation for a checkpoint with changes only on the other side
    // of the index (or only untracked files), so skip it deliberately.
    if ((await lstat(stagedPatch)).size > 0) {
      await this.git(scope.root, ['apply', '--index', '--binary', stagedPatch], signal)
    }
    if ((await lstat(worktreePatch)).size > 0) {
      await this.git(scope.root, ['apply', '--binary', worktreePatch], signal)
    }
    await this.restoreUntracked(scope, directory, manifest, signal)
  }

  private async restoreUntracked(
    scope: GitScope,
    checkpointDirectory: string,
    manifest: PersistedUntrackedManifest,
    signal: AbortSignal,
  ): Promise<void> {
    const filesDirectory = join(checkpointDirectory, 'untracked')
    for (const entry of manifest.entries) {
      signal.throwIfAborted()
      const path = checkedRelativePath(scope.root, entry.path)
      const target = pathFor(scope.root, path)
      if (!isWithin(scope.scope, target)) throw new Error(`Checkpoint path lies outside this workspace scope: "${path}".`)
      await this.assertNoSymlinkAncestor(scope.scope, dirname(target))
      try {
        await lstat(target)
        throw new Error(`Cannot restore untracked path "${path}" because a file now occupies it.`)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (entry.kind === 'file') {
        const source = pathFor(filesDirectory, path)
        await this.assertRegularCheckpointFile(source)
        await copyFile(source, target)
        await chmod(target, entry.mode)
      } else {
        if (entry.target === undefined) throw new Error(`Checkpoint symlink "${path}" has no target.`)
        await symlink(entry.target, target)
      }
    }
  }

  private async assertNoSymlinkAncestor(base: string, candidate: string): Promise<void> {
    const relativePath = relative(base, candidate)
    if (relativePath === '' || relativePath === '.') return
    if (!isWithin(base, candidate)) throw new Error('Checkpoint target escapes the workspace.')
    let current = base
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment)
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Cannot restore through symlinked directory "${current}".`)
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return
        throw error
      }
    }
  }

  private async readCheckpoint(
    sessionId: WorkspaceCheckpoint['sessionId'],
    id: WorkspaceCheckpoint['id'],
    signal: AbortSignal,
  ): Promise<PersistedCheckpoint> {
    signal.throwIfAborted()
    const directory = this.checkpointDirectory(String(sessionId), String(id))
    const raw = await readFile(join(directory, META_FILENAME), { encoding: 'utf8', signal })
    let parsed: PersistedCheckpoint
    try {
      parsed = persistedCheckpointSchema(JSON.parse(raw)) as PersistedCheckpoint
    } catch (error) {
      throw new Error(`Workspace checkpoint "${String(id)}" is invalid: ${this.errorText(error)}`)
    }
    if (parsed.version !== STORAGE_VERSION) throw new Error(`Workspace checkpoint "${String(id)}" uses unsupported storage version ${String(parsed.version)}.`)
    assertCheckpointId(parsed.id)
    if (parsed.id !== String(id) || parsed.sessionId !== String(sessionId)) {
      throw new Error(`Workspace checkpoint "${String(id)}" does not belong to this session.`)
    }
    if (parsed.workspace.kind === 'git') {
      assertObjectId(parsed.workspace.head)
      if (!isAbsolute(parsed.workspace.root) || !isAbsolute(parsed.workspace.scope)) {
        throw new Error(`Workspace checkpoint "${String(id)}" has a nonabsolute Git scope.`)
      }
    }
    return parsed
  }

  private async readManifest(directory: string, root: string, signal: AbortSignal): Promise<PersistedUntrackedManifest> {
    const raw = await readFile(join(directory, UNTRACKED_FILENAME), { encoding: 'utf8', signal })
    let parsed: PersistedUntrackedManifest
    try {
      parsed = persistedUntrackedManifestSchema(JSON.parse(raw)) as PersistedUntrackedManifest
    } catch (error) {
      throw new Error(`Workspace checkpoint untracked-file manifest is invalid: ${this.errorText(error)}`)
    }
    if (parsed.version !== STORAGE_VERSION) throw new Error(`Workspace checkpoint untracked-file manifest uses unsupported version ${String(parsed.version)}.`)
    for (const entry of parsed.entries) {
      checkedRelativePath(root, entry.path)
      if (entry.kind === 'symlink' && entry.target === undefined) {
        throw new Error(`Checkpoint symlink "${entry.path}" has no target.`)
      }
    }
    return parsed
  }

  private async assertRegularCheckpointFile(path: string): Promise<void> {
    if (!(await lstat(path)).isFile()) throw new Error(`Checkpoint artifact is not a regular file: ${path}`)
  }

  private async gitScope(cwd: string, signal: AbortSignal): Promise<GitScope> {
    signal.throwIfAborted()
    const scope = await realpath(resolve(cwd))
    if (!(await lstat(scope)).isDirectory()) throw new Error(`Workspace path is not a directory: ${cwd}`)
    const root = await realpath(resolve((await this.git(scope, ['rev-parse', '--show-toplevel'], signal)).trim()))
    if (!isWithin(root, scope)) throw new Error(`Session directory ${scope} is outside Git worktree ${root}.`)
    const relation = relative(root, scope)
    const pathspec = relation === '' ? '.' : relation.split(sep).join('/')
    const head = (await this.git(root, ['rev-parse', 'HEAD'], signal)).trim()
    assertObjectId(head)
    return { root, scope, pathspec, head }
  }

  private assertMatchingScope(snapshot: PersistedGitWorkspace, current: GitScope): void {
    if (snapshot.root !== current.root || snapshot.scope !== current.scope) {
      throw new Error('Workspace checkpoint belongs to a different Git worktree or directory.')
    }
    if (snapshot.head !== current.head) {
      throw new Error('Git HEAD changed after this checkpoint; rewind refuses to cross commits.')
    }
  }

  private async untrackedPaths(scope: GitScope, signal: AbortSignal): Promise<string[]> {
    const raw = await this.git(scope.root, [
      '-c',
      'core.quotepath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      scope.pathspec,
    ], signal)
    return raw.split('\0').filter(path => path !== '')
  }

  private git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return new Promise((resolveResult, reject) => {
      execFile('git', args, {
        cwd,
        env: scrubbedParentEnv(),
        encoding: 'utf8',
        signal,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error !== null) reject(gitFailure(args, error, stderr))
        else resolveResult(stdout)
      })
    })
  }

  private gitToFile(cwd: string, args: readonly string[], path: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolveResult, reject) => {
      const output = createWriteStream(path, { mode: 0o600 })
      const child = spawn('git', args, {
        cwd,
        env: scrubbedParentEnv(),
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        callback()
      }
      const fail = (error: unknown): void => {
        output.destroy()
        settle(() => { reject(gitFailure(args, error, stderr)) })
      }
      output.on('error', fail)
      child.on('error', fail)
      if (child.stdout === null || child.stderr === null) {
        fail(new Error('Git child process did not expose the expected output streams.'))
        return
      }
      child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
      let childExited = false
      let outputFinished = false
      const succeedIfReady = (): void => {
        if (childExited && outputFinished) settle(resolveResult)
      }
      output.on('finish', () => {
        outputFinished = true
        succeedIfReady()
      })
      child.stdout.pipe(output)
      child.on('close', (code) => {
        if (code !== 0) {
          fail(new Error(`exit ${String(code)}`))
          return
        }
        childExited = true
        succeedIfReady()
      })
    })
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
