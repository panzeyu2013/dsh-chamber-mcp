/**
 * Pure-ish workspace helper (host half): canonical-cwd → workspace id.
 *
 * The workspace membership rule (dsh-workspace): a session belongs to a
 * workspace iff its header `cwd` canonicalizes (fs.realpath) to the
 * workspace's canonical path. There is no `session.workspaceId` anywhere, so
 * this is the sanctioned mapping. `workspaceIdOf` keeps the realpath call
 * injectable for tests.
 *
 * @module
 */

import { realpathSync } from 'node:fs'

/** A workspace registry entry the helper matches against. */
export interface WorkspaceLike {
  readonly id: string
  /** Canonical (realpath-normalized) workspace root. */
  readonly path: string
}

/** Canonicalize a session cwd, tolerating a missing/unreadable path. */
export function canonicalCwd(cwd: string | undefined, realpath: (path: string) => string = realpathSync): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  try {
    return realpath(cwd)
  } catch {
    return undefined
  }
}

/**
 * Resolve the workspace owning a session cwd by canonical-path equality.
 * Returns the first matching workspace id, or undefined when the cwd is
 * absent/unreadable or no registered workspace owns it. Deterministic over
 * `list()` order (durable registry order) — the caller may pass
 * `workspaceRegistry.list()`.
 */
export function workspaceIdOf(
  cwd: string | undefined,
  workspaces: readonly WorkspaceLike[],
  realpath: (path: string) => string = realpathSync,
): string | undefined {
  const canonical = canonicalCwd(cwd, realpath)
  if (canonical === undefined) return undefined
  for (const workspace of workspaces) {
    if (workspace.path === canonical) return workspace.id
  }
  return undefined
}
