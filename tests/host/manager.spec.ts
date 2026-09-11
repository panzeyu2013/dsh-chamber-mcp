/**
 * Bridge-manager integration tests (src/manager.ts): reconcile diffing over a
 * live document source, real fixture stdio servers, per-server supervisors,
 * change-driven restart, and credential-reference-driven restart — asserting
 * the stable `mcp-scope(` structured log lines.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createManager, type ManagerHandle } from '../../src/manager.js'
import type { CredentialResolver } from '../../src/transport.js'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.js'
import type {} from '@deepseek-ai/dsh-credentials'

const fixtureServer = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', 'mcp-fixture-server.mjs')

interface LoggedLine { level: 'info' | 'warn' | 'error'; message: string }

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function stdioServer(serverName: string, extra: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {}): ServerDef {
  return {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: '',
    envKeys: [],
    ...extra,
  }
}

async function boot(): Promise<{
  ctx: Context
  manager: ManagerHandle
  lines: LoggedLine[]
  setDoc(next: McpScopeDoc): void
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  let doc: McpScopeDoc = { servers: [], overrides: {} }
  const lines: LoggedLine[] = []
  const logger = {
    info: (message: string) => void lines.push({ level: 'info', message }),
    warn: (message: string) => void lines.push({ level: 'warn', message }),
    error: (message: string) => void lines.push({ level: 'error', message }),
  }
  const credentials = {
    resolve: (async () => undefined) as CredentialResolver,
  }
  const disposeAgents = ctx.provide('agents', { roots: () => [], get: () => undefined })
  const disposeRegistry = ctx.provide('workspaceRegistry', { list: () => [] })
  let manager: ManagerHandle | undefined
  const managerHost = function managerHost(c: Context) {
    manager = createManager({
      ctx: c,
      logger,
      getDoc: () => doc,
      credentials,
    })
  }
  managerHost.inject = ['agents', 'workspaceRegistry']
  await ctx.plugin(managerHost)
  void disposeAgents
  void disposeRegistry
  return {
    ctx,
    manager: manager!,
    lines,
    setDoc: (next) => {
      doc = next
    },
    async dispose() {
      await manager!.dispose()
    },
  }
}

const started = (lines: LoggedLine[], name: string): number =>
  lines.filter((l) => l.message === `mcp-scope(${name}): server started (stdio)`).length
const stopped = (lines: LoggedLine[], name: string): number =>
  lines.filter((l) => l.message === `mcp-scope(${name}): server stopped`).length

describe('bridge manager lifecycle', () => {
  it('starts, restarts on field change, restarts on credential update, stops on removal', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      // 1. Add a server: reconcile starts the supervisor and its sync commits.
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      await waitFor(
        () => lines.some((l) => l.level === 'info' && l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )

      // 2. envKeys changes (field change) → dispose + restart; the new server
      // resolves the missing ref and warns (omission), then syncs again.
      setDoc({ servers: [stdioServer('fix', { envKeys: ['FIX_TOKEN'] })], overrides: {} })
      manager.reconcile()
      await waitFor(() => stopped(lines, 'fix') === 1, 'first stop log')
      await waitFor(() => started(lines, 'fix') === 2, 'second start log')
      await waitFor(
        () => lines.some((l) => l.message.includes('credential ref "FIX_TOKEN" is not configured — omitting env key')),
        'missing-ref omission warning',
      )
      await waitFor(
        () => lines.filter((l) => l.message.includes('mcp-scope(fix): synced 8 tools')).length === 2,
        'second sync log',
      )

      // 3. Credential event for a ref in use → that server reconnects.
      ctx.emit('credentials/reference-updated', credentialRef('FIX_TOKEN'))
      await waitFor(
        () => lines.some((l) => l.level === 'info' && l.message.includes('credential ref "FIX_TOKEN" updated — reconnecting')),
        'credential reconnect log',
      )
      await waitFor(() => stopped(lines, 'fix') >= 2, 'credential restart stop')
      await waitFor(() => started(lines, 'fix') === 3, 'credential restart start')

      // 4. Removing the server from the doc stops it.
      setDoc({ servers: [], overrides: {} })
      manager.reconcile()
      await waitFor(() => stopped(lines, 'fix') === 3, 'removal stop log')

      // 5. Dispose is quiet after full stop.
      const count = lines.length
      await dispose()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(lines.length).toBe(count)
    } finally {
      await dispose()
    }
  })

  it('runs several servers concurrently — one supervisor each — and removal touches only the removed one (MULTI-1)', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      const doc = (...names: string[]): McpScopeDoc => ({ servers: names.map((name) => stdioServer(name)), overrides: {} })

      // Three servers, three real child processes, tracked independently.
      setDoc(doc('alpha', 'beta', 'gamma'))
      manager.reconcile()
      await waitFor(
        () => started(lines, 'alpha') + started(lines, 'beta') + started(lines, 'gamma') === 3,
        'three servers started',
      )

      // A fourth joins while the other three are live (no teardown of them).
      setDoc(doc('alpha', 'beta', 'gamma', 'delta'))
      manager.reconcile()
      await waitFor(() => started(lines, 'delta') === 1, 'fourth server started')
      expect(started(lines, 'alpha') + started(lines, 'beta') + started(lines, 'gamma')).toBe(3)

      // Dropping one stops exactly that one; the survivors are not restarted.
      setDoc(doc('alpha', 'gamma', 'delta'))
      manager.reconcile()
      await waitFor(() => stopped(lines, 'beta') === 1, 'removed server stopped')
      expect(stopped(lines, 'alpha') + stopped(lines, 'gamma') + stopped(lines, 'delta')).toBe(0)
      expect(started(lines, 'alpha') + started(lines, 'gamma') + started(lines, 'delta')).toBe(3)
    } finally {
      await dispose()
    }
  })

  it('ignores credential events for refs no server uses', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} }) // no envKeys
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      // Settle the initial sync so no async commit log can race the snapshot.
      await waitFor(
        () => lines.some((l) => l.level === 'info' && l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )
      const before = lines.length
      ctx.emit('credentials/reference-updated', credentialRef('UNUSED_REF'))
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(lines.length).toBe(before)
    } finally {
      await dispose()
    }
  })

  it('coalesces same-tick credential restarts per serverName (IMPL-3)', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix', { envKeys: ['FIX_TOKEN'] })], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      await waitFor(
        () => lines.some((l) => l.level === 'info' && l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )
      const reconnecting = () => lines.filter((l) => l.level === 'info' && l.message.includes('credential ref "FIX_TOKEN" updated — reconnecting')).length

      // Two credential events for the same in-use ref in the same tick: the
      // second restart request must be absorbed — one stop, one start, one
      // "reconnecting" line.
      ctx.emit('credentials/reference-updated', credentialRef('FIX_TOKEN'))
      ctx.emit('credentials/reference-updated', credentialRef('FIX_TOKEN'))
      await waitFor(() => stopped(lines, 'fix') === 1 && started(lines, 'fix') === 2, 'coalesced restart')
      await waitFor(
        () => lines.filter((l) => l.message.includes('mcp-scope(fix): synced 8 tools')).length === 2,
        'post-restart sync',
      )
      expect(reconnecting()).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(stopped(lines, 'fix')).toBe(1)
      expect(started(lines, 'fix')).toBe(2)

      // The marker is cleared when the queued mutation runs, so a later,
      // genuinely new event still restarts.
      ctx.emit('credentials/reference-updated', credentialRef('FIX_TOKEN'))
      await waitFor(() => stopped(lines, 'fix') === 2 && started(lines, 'fix') === 3, 'later restart after marker cleared')
      await waitFor(
        () => lines.filter((l) => l.message.includes('mcp-scope(fix): synced 8 tools')).length === 3,
        'post-second-restart sync',
      )
      expect(reconnecting()).toBe(2)
    } finally {
      await dispose()
    }
  })

  it('dispose() stops live supervisors and their children (R2P-1)', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      await waitFor(
        () => lines.some((l) => l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )
      await dispose()
      // stopServer ran for the live handle: exactly one stop line and no
      // further supervisor activity afterwards (pre-fix, dispose deleted the
      // tracked entry first and never stopped anything).
      expect(stopped(lines, 'fix')).toBe(1)
      const before = lines.length
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(lines.length).toBe(before)
      expect(started(lines, 'fix')).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('workspace domain/changed events trigger a quiet applier refresh (no side effects on an unchanged doc)', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      await waitFor(
        () => lines.some((l) => l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )
      const before = lines.length
      // Workspace-registry writes emit domain/changed for domain "workspace":
      // the refresh must run without restarting servers or touching the doc.
      ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'put', value: {} })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(lines.length).toBe(before)
      expect(started(lines, 'fix')).toBe(1)
      // Non-workspace domains are ignored the same way.
      ctx.emit('domain/changed', { domain: 'other', table: 'x', key: 'k', operation: 'put', value: {} })
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(lines.length).toBe(before)
    } finally {
      await dispose()
    }
  })

  it('a queued credential restart of a concurrently removed server never resurrects it (R2I-1)', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix', { envKeys: ['FIX_TOKEN'] })], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'server started log')
      await waitFor(
        () => lines.some((l) => l.message.includes('mcp-scope(fix): synced 8 tools')),
        'initial sync log',
      )
      // Credential restart queued first…
      ctx.emit('credentials/reference-updated', credentialRef('FIX_TOKEN'))
      // …then the server leaves the document before the queued mutation runs.
      setDoc({ servers: [], overrides: {} })
      manager.reconcile()
      await waitFor(() => stopped(lines, 'fix') === 1, 'stop log')
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Stopped exactly once, never restarted, no further supervisor activity.
      expect(stopped(lines, 'fix')).toBe(1)
      expect(started(lines, 'fix')).toBe(1)
      expect(lines.filter((l) => l.message.includes('mcp-scope(fix): synced')).length).toBe(1)
    } finally {
      await dispose()
    }
  })
})
