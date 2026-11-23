/**
 * Manager + applier workspace-membership memo matrix (H4).
 *
 * The per-agent applier resolves a session's workspace by canonical cwd
 * (fs.realpath) on every capture publish, settings reconcile and on-demand
 * admission. A session cwd is immutable, so the resolver memoizes the canonical
 * path by session id and re-decides membership only when the workspace registry
 * list changes. These pins cover both halves:
 * - the resolver: syscall counts per pass and the removed/renamed-workspace
 *   invalidation (a stale membership must never outlive a registry change);
 * - the production applier: removing or renaming the owning workspace revokes
 *   the session's tools on the next reconcile, and re-registering the workspace
 *   restores them.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createWorkspaceResolver, workspaceIdOf } from '../../src/workspace.js'
import { mountAgentHarness, toolDef } from '../support/agent-kit.js'

/** One fake session cwd → canonical path mapping used by the counting realpath. */
const canonical = (path: string): string => '/canon' + path

describe('canonical workspace memo (src/workspace.ts)', () => {
  it('pays one realpath per NEW session and zero on the warm per-pass fan-out', () => {
    const calls: string[] = []
    const stats: string[] = []
    const resolver = createWorkspaceResolver(
      (path) => {
        calls.push(path)
        return canonical(path)
      },
      (path) => {
        stats.push(path)
        return true
      },
    )
    const workspaces = [{ id: 'ws-a', path: '/canon/a' }, { id: 'ws-b', path: '/canon/b' }]

    // First pass: 100 sessions, one realpath each (the unmemoized cost).
    resolver.refresh(workspaces)
    for (let index = 0; index < 50; index += 1) {
      expect(resolver.workspaceOf('session-a-' + index, '/a')).toBe('ws-a')
      expect(resolver.workspaceOf('session-b-' + index, '/b')).toBe('ws-b')
    }
    expect(calls).toHaveLength(100)

    // Warm pass (same registry list): 0 realpath syscalls.
    resolver.refresh(workspaces)
    for (let index = 0; index < 50; index += 1) {
      expect(resolver.workspaceOf('session-a-' + index, '/a')).toBe('ws-a')
      expect(resolver.workspaceOf('session-b-' + index, '/b')).toBe('ws-b')
    }
    expect(calls).toHaveLength(100)

    // Changed registry list: membership re-decided, canonical cwd still memoized
    // (a cwd is an immutable fact of the session) → 0 realpath syscalls.
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    for (let index = 0; index < 50; index += 1) {
      expect(resolver.workspaceOf('session-a-' + index, '/a')).toBe('ws-a')
      expect(resolver.workspaceOf('session-b-' + index, '/b')).toBeUndefined()
    }
    expect(calls).toHaveLength(100)
    // One existence probe per registered workspace per pass (2 + 2 + 1).
    expect(stats).toHaveLength(5)
  })

  it('replaces one realpath per (agent, pass) with one per new session', () => {
    // 50 sessions over 10 passes: the unmemoized helper pays a realpath syscall
    // per (agent, pass); the resolver pays it once per session and zero on the
    // warm passes (the pre/post H4 syscall budget).
    const sessions = Array.from({ length: 50 }, (_, index) => ({ id: 'session-' + index, cwd: '/a' }))
    const workspaces = [{ id: 'ws-a', path: '/canon/a' }]
    let before = 0
    for (let pass = 0; pass < 10; pass += 1) {
      for (const session of sessions) workspaceIdOf(session.cwd, workspaces, (path) => {
        before += 1
        return canonical(path)
      })
    }
    expect(before).toBe(500)
    let after = 0
    let stats = 0
    const resolver = createWorkspaceResolver(
      (path) => {
        after += 1
        return canonical(path)
      },
      () => {
        stats += 1
        return true
      },
    )
    for (let pass = 0; pass < 10; pass += 1) {
      resolver.refresh(workspaces)
      for (const session of sessions) resolver.workspaceOf(session.id, session.cwd)
    }
    // 50 realpath syscalls for 500 resolutions (one per NEW session), plus one
    // cheap existence check per pass (1 workspace), never one per agent.
    expect(after).toBe(50)
    expect(stats).toBe(10)
  })

  it('stops matching a removed or renamed workspace on the next pass', () => {
    const resolver = createWorkspaceResolver(canonical, () => true)
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')

    // Removed from the registry: the memo is invalidated and the session has no
    // workspace (its MCP tools must be withheld on the next applier pass).
    resolver.refresh([])
    expect(resolver.workspaceOf('session-a', '/a')).toBeUndefined()

    // Re-added: the same session matches again without a new realpath.
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')

    // Renamed (same id, new canonical root): the old cwd no longer matches.
    resolver.refresh([{ id: 'ws-a', path: '/canon/moved' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBeUndefined()
    expect(resolver.workspaceOf('session-b', '/moved')).toBe('ws-a')
  })

  it('drops the membership of a workspace whose directory vanished (R2I-7 fail-closed)', () => {
    let present = true
    const resolver = createWorkspaceResolver(canonical, () => present)
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')

    // The registry row (and the list signature) is unchanged but the directory
    // is gone: the next pass must fail closed instead of serving the memo.
    present = false
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBeUndefined()

    // Reappearing directory restores the match without a new realpath.
    present = true
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')
  })

  it("forgets one session's memo on agent/disposed without disturbing the others", () => {
    const calls: string[] = []
    const resolver = createWorkspaceResolver((path) => {
      calls.push(path)
      return canonical(path)
    }, () => true)
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')
    expect(resolver.workspaceOf('session-b', '/a')).toBe('ws-a')
    expect(calls).toHaveLength(2)

    // Both warm: no realpath.
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')
    expect(resolver.workspaceOf('session-b', '/a')).toBe('ws-a')
    expect(calls).toHaveLength(2)

    // Evict ONE session (the agent/disposed wiring): only it re-canonicalizes.
    resolver.forget('session-a')
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')
    expect(calls).toHaveLength(3)
    expect(resolver.workspaceOf('session-b', '/a')).toBe('ws-a')
    expect(calls).toHaveLength(3)

    // Fail-closed semantics are unchanged: after eviction an unreadable cwd is
    // no workspace (the memo cannot serve a stale match).
    let readable = false
    const retry = createWorkspaceResolver((path) => {
      if (!readable) throw new Error('gone')
      return canonical(path)
    }, () => true)
    retry.refresh([{ id: 'ws-a', path: '/canon/a' }])
    readable = true
    expect(retry.workspaceOf('session-a', '/a')).toBe('ws-a')
    readable = false
    expect(retry.workspaceOf('session-a', '/a')).toBe('ws-a')
    retry.forget('session-a')
    expect(retry.workspaceOf('session-a', '/a')).toBeUndefined()
  })

  it('does not memoize an unreadable cwd (it may become readable later)', () => {
    let readable = false
    const calls: string[] = []
    const resolver = createWorkspaceResolver((path) => {
      calls.push(path)
      if (!readable) throw new Error('gone')
      return canonical(path)
    }, () => true)
    resolver.refresh([{ id: 'ws-a', path: '/canon/a' }])
    expect(resolver.workspaceOf('session-a', '/a')).toBeUndefined()
    expect(calls).toHaveLength(1)
    // Retried on the next pass instead of caching "no workspace".
    expect(resolver.workspaceOf('session-a', '/a')).toBeUndefined()
    expect(calls).toHaveLength(2)
    readable = true
    expect(resolver.workspaceOf('session-a', '/a')).toBe('ws-a')
    expect(calls).toHaveLength(3)
  })
})

describe('applier workspace membership after a registry change (H4)', () => {
  const SERVER = 'files'
  const TOOL = 'mcp__files__read'

  it('revokes tools when the owning workspace is removed/renamed and restores them on re-add', async () => {
    const harness = await mountAgentHarness()
    try {
      const wsA = await harness.addWorkspace('a')
      const agentA = harness.spawnAgent('agent-a', wsA.path)
      harness.overrides = { [wsA.id]: { files: true } }
      harness.createAgent(agentA)
      harness.push(SERVER, 1, new Map<string, ToolDefinition>([[TOOL, toolDef(TOOL)]]))
      expect(harness.ctx.tools.get(TOOL, agentA)).toBeDefined()

      // Removed workspace: the canonical cwd no longer maps to a registered
      // workspace, so the next reconcile must revoke the tools (fail closed).
      harness.workspaces = []
      harness.applier.reconcile()
      expect(harness.ctx.tools.get(TOOL, agentA)).toBeUndefined()

      // Re-added (same id + canonical path): the memo invalidation re-matches it
      // and the retained generation is re-published.
      harness.workspaces = [{ id: wsA.id, path: wsA.path }]
      harness.applier.reconcile()
      expect(harness.ctx.tools.get(TOOL, agentA)).toBeDefined()

      // Renamed workspace (same id, different canonical root): the session's
      // immutable cwd no longer matches → revoked again.
      harness.workspaces = [{ id: wsA.id, path: harness.makeOutsideDir() }]
      harness.applier.reconcile()
      expect(harness.ctx.tools.get(TOOL, agentA)).toBeUndefined()
    } finally {
      harness.cleanup()
    }
  })

  it("evicts a disposed agent's workspace memo (a reused session id re-resolves)", async () => {
    const harness = await mountAgentHarness()
    try {
      const wsA = await harness.addWorkspace('a')
      const wsB = await harness.addWorkspace('b')
      // Only ws-b enables the server: a stale ws-a membership would withhold it.
      harness.overrides = { [wsB.id]: { [SERVER]: true } }
      const first = harness.spawnAgent('agent-reused', wsA.path)
      harness.createAgent(first)
      harness.push(SERVER, 1, new Map<string, ToolDefinition>([[TOOL, toolDef(TOOL)]]))
      expect(harness.ctx.tools.get(TOOL, first)).toBeUndefined()

      // agent/disposed must evict the session's resolver memo. A new agent that
      // RE-USES the session id with a cwd in another workspace can then resolve
      // the new workspace; with the memo retained it would keep the stale
      // canonical cwd (ws-a) and withhold the tool.
      harness.disposeAgent(first)
      const second = harness.spawnAgent('agent-reused', wsB.path)
      harness.createAgent(second)
      harness.push(SERVER, 2, new Map<string, ToolDefinition>([[TOOL, toolDef(TOOL)]]))
      expect(harness.ctx.tools.get(TOOL, second)).toBeDefined()
    } finally {
      harness.cleanup()
    }
  })
})
