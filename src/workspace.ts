/**
 * Pure-ish workspace helper (host half): canonical-cwd → workspace id, with a
 * memoized resolver for the per-pass fan-out.
 *
 * The workspace membership rule (dsh-workspace): a session belongs to a
 * workspace iff its header `cwd` canonicalizes (fs.realpath) to the
 * workspace's canonical path. There is no `session.workspaceId` anywhere, so
 * this is the sanctioned mapping. `workspaceIdOf` keeps the realpath call
 * injectable for tests.
 *
 * A session's `cwd` is immutable, so the per-agent passes (capture publish,
 * settings reconcile, on-demand admission) must not pay one realpath syscall
 * per (agent, pass). {@link createWorkspaceResolver} memoizes the canonical cwd
 * by session id and the membership by the current registry snapshot; the
 * membership memo is dropped whenever the workspace registry list changes (a
 * removed/renamed workspace stops matching on the next pass), while the
 * canonical cwd (an I/O fact of the session) is kept.
 *
 * @module
 */

import { existsSync, realpathSync } from 'node:fs'

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

/** Memoized canonical-workspace resolver over immutable session cwds. */
export interface WorkspaceResolver {
  /**
   * Refresh the registry snapshot (call once per pass). The membership memo is
   * dropped when the list content/order changes OR when a registered workspace
   * root no longer exists on disk (R2I-7 fail-closed: a deleted workspace
   * directory must revoke on the next pass); an unchanged, existing list keeps
   * every memoized result. Costs one cheap existence check per registered
   * workspace per pass — never one per agent.
   */
  refresh(workspaces: readonly WorkspaceLike[]): void
  /**
   * Canonical workspace id of one session. The realpath result is memoized by
   * session id (a cwd is immutable), the membership by the last refreshed
   * registry snapshot.
   */
  workspaceOf(sessionId: string, cwd: string | undefined): string | undefined
  /**
   * Drop one session's memo (agent/disposed): a long-lived Host must not retain
   * an entry per session it has ever seen. Fail-closed semantics are unchanged:
   * the next resolution re-runs the realpath and membership decision.
   */
  forget(sessionId: string): void
}

/** Identity of one registry snapshot: ids and canonical paths, in order. */
function registrySignature(workspaces: readonly WorkspaceLike[]): string {
  let value = ''
  for (const workspace of workspaces) value += workspace.id + '\u0000' + workspace.path + '\u0001'
  return value
}

/**
 * Create a memoized resolver: one realpath syscall per NEW session (per
 * unreadable cwd per pass, like the unmemoized helper), one cheap existence
 * check per registered workspace per pass, and zero realpath syscalls on the
 * warm per-agent fan-out.
 *
 * @param realpath - canonicalizer (injected by tests; defaults to fs.realpathSync).
 * @param exists - workspace-root existence probe (injected by tests; defaults
 *   to fs.existsSync).
 * @returns the resolver consumed by the per-agent applier.
 */
export function createWorkspaceResolver(
  realpath: (path: string) => string = realpathSync,
  exists: (path: string) => boolean = existsSync,
): WorkspaceResolver {
  /** session id → canonical cwd (successful realpath only; cwd is immutable). */
  const canonicalBySession = new Map<string, string>()
  /** session id → workspace id of the CURRENT effective snapshot (undefined = no match). */
  const membership = new Map<string, string | undefined>()
  let workspaces: readonly WorkspaceLike[] = []
  /** Identity of the effective snapshot the membership map was computed against. */
  let effectiveSignature: string | undefined

  return {
    refresh(list) {
      // R2I-7 fail-closed guard: a workspace whose directory disappeared from
      // disk must stop owning sessions on the next pass, even though the
      // registry row (and therefore the raw list) is unchanged. This is one
      // cheap existence check per REGISTERED workspace per pass, never per
      // agent; the effective snapshot (registry row AND live directory) is what
      // owns sessions.
      const effective: WorkspaceLike[] = []
      for (const workspace of list) {
        if (exists(workspace.path)) effective.push(workspace)
      }
      const next = registrySignature(effective)
      if (next !== effectiveSignature) {
        effectiveSignature = next
        membership.clear()
      }
      workspaces = effective
    },
    workspaceOf(sessionId, cwd) {
      if (membership.has(sessionId)) return membership.get(sessionId)
      let canonical = canonicalBySession.get(sessionId)
      if (canonical === undefined) {
        canonical = canonicalCwd(cwd, realpath)
        // An absent/unreadable cwd is NOT memoized: the directory may appear
        // later, so the next pass retries the realpath exactly like the
        // unmemoized path did.
        if (canonical === undefined) return undefined
        canonicalBySession.set(sessionId, canonical)
      }
      let workspaceId: string | undefined
      for (const workspace of workspaces) {
        if (workspace.path === canonical) {
          workspaceId = workspace.id
          break
        }
      }
      membership.set(sessionId, workspaceId)
      return workspaceId
    },
    forget(sessionId) {
      canonicalBySession.delete(sessionId)
      membership.delete(sessionId)
    },
  }
}
