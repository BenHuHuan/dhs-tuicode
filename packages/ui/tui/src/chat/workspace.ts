/** Workspace identity normalization shared by TUI history indexes. */

import { resolve } from 'node:path'

/**
 * Normalize a working directory for same-workspace comparisons.
 * @param cwd - Working directory to canonicalize without filesystem access.
 * @returns absolute comparison key, case-folded on Windows.
 */
export function workspaceKey(cwd: string): string {
  const canonical = resolve(cwd)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}
