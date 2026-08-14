/** Shell-free host writer for explicit response-to-file actions. */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { TextFileWriteRequest, TextFileWriteResult } from './runtime.ts'

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Write exact UTF-8 text to a user-selected path.
 *
 * The first attempt uses exclusive creation. Existing content is represented
 * as data so the TUI can ask for human confirmation before retrying with
 * `overwrite: true`.
 * @param request - Selected text, user path, working directory, overwrite decision, and cancellation.
 * @returns The resolved path and whether it was written or already existed.
 */
export async function writeTextFile(
  request: TextFileWriteRequest,
): Promise<TextFileWriteResult> {
  const inputPath = request.path.trim()
  if (inputPath === '') throw new Error('file path must not be empty')
  request.signal.throwIfAborted()
  const target = resolve(request.cwd, inputPath)
  try {
    await writeFile(target, request.text, {
      encoding: 'utf8',
      flag: request.overwrite ? 'w' : 'wx',
      mode: 0o600,
      signal: request.signal,
    })
    return { kind: 'written', path: target }
  } catch (error: unknown) {
    if (!request.overwrite && isNodeError(error) && error.code === 'EEXIST') {
      return { kind: 'exists', path: target }
    }
    throw error
  }
}
