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
import {
  RuntimeActionError,
  TOOL_LIST_MAX,
  capToolList,
  createManager,
  type ManagerHandle,
  type ManagerOptions,
} from '../../src/manager.js'
import { RECONNECT_DEFAULTS } from '../../src/server.js'
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

async function boot(
  options: Partial<Pick<ManagerOptions, 'reconnect'>> = {},
): Promise<{
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
      ...options,
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

  it('never supervises a globally disabled server and stops one when it is disabled', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      // Disabled in the document from the start: no process ever spawns.
      setDoc({ servers: [stdioServer('off')], overrides: {}, disabled: { off: true } })
      manager.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 220))
      expect(started(lines, 'off')).toBe(0)

      // Enabled: the same definition starts.
      setDoc({ servers: [stdioServer('off')], overrides: {}, disabled: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'off') === 1, 'enabled server started')
      await waitFor(
        () => lines.some((l) => l.message.includes('mcp-scope(off): synced 8 tools')),
        'initial sync log',
      )

      // Disabling it again stops the live supervisor without touching the doc.
      setDoc({ servers: [stdioServer('off')], overrides: {}, disabled: { off: true } })
      manager.reconcile()
      await waitFor(() => stopped(lines, 'off') === 1, 'disabled server stopped')
      const count = lines.length
      await new Promise((resolve) => setTimeout(resolve, 180))
      expect(started(lines, 'off')).toBe(1)
      expect(lines.length).toBe(count)
    } finally {
      await dispose()
    }
  })

  it('a credential update never restarts a globally disabled server', async () => {
    const { ctx, manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({
        servers: [stdioServer('off', { envKeys: ['OFF_TOKEN'] })],
        overrides: {},
        disabled: { off: true },
      })
      manager.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 180))
      ctx.emit('credentials/reference-updated', credentialRef('OFF_TOKEN'))
      await new Promise((resolve) => setTimeout(resolve, 220))
      expect(started(lines, 'off')).toBe(0)
      expect(lines.some((l) => l.message.includes('updated — reconnecting'))).toBe(false)
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

  it('a manual disconnect latches until connect() or a definition change', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 1, 'initial start')
      await waitFor(
        () => manager.runtimeStatus().servers[0]?.state === 'connected',
        'connected status',
      )

      await manager.disconnect('fix')
      await waitFor(() => stopped(lines, 'fix') === 1, 'manual stop')
      expect(manager.runtimeStatus().servers[0]).toMatchObject({ name: 'fix', state: 'stopped', toolCount: 0 })

      // A settings commit that does not touch the definition keeps it off.
      manager.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 160))
      expect(started(lines, 'fix')).toBe(1)
      expect(manager.runtimeStatus().servers[0]?.state).toBe('stopped')

      // connect() clears the latch and restarts.
      await manager.connect('fix')
      await waitFor(() => started(lines, 'fix') === 2, 'manual reconnect')

      // A definition change also clears the latch.
      await manager.disconnect('fix')
      await waitFor(() => stopped(lines, 'fix') === 2, 'second stop')
      setDoc({ servers: [stdioServer('fix', { cwd: '/tmp' })], overrides: {} })
      manager.reconcile()
      await waitFor(() => started(lines, 'fix') === 3, 'definition change clears the latch')
    } finally {
      await dispose()
    }
  })

  it('runtimeStatus maps disabled/unknown without starting anything and toolList validates the doc', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('off')], overrides: {}, disabled: { off: true } })
      manager.reconcile()
      const view = manager.runtimeStatus()
      expect(view.v).toBe(1)
      expect(typeof view.at).toBe('number')
      expect(view.servers).toEqual([
        {
          name: 'off',
          state: 'disabled',
          attempts: 0,
          maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
          toolCount: 0,
        },
      ])
      expect(started(lines, 'off')).toBe(0)

      // Enabled but never reconciled: honest 'unknown', not a fabricated state.
      setDoc({ servers: [stdioServer('later')], overrides: {} })
      expect(manager.runtimeStatus().servers[0]?.state).toBe('unknown')

      expect(manager.toolList('later')).toBeUndefined()
      let thrown: unknown
      try {
        manager.toolList('missing')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RuntimeActionError)
      expect((thrown as RuntimeActionError).code).toBe('not-found')
    } finally {
      await dispose()
    }
  })

  it('connect() restarts a budget-exhausted server and never leaks its error text', async () => {
    const { manager, lines, setDoc, dispose } = await boot({
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 1 },
    })
    try {
      setDoc({
        servers: [stdioServer('ghost', { command: '/nonexistent/definitely-missing', args: [] })],
        overrides: {},
      })
      manager.reconcile()
      await waitFor(() => manager.runtimeStatus().servers[0]?.state === 'failed', 'failed phase')
      const failed = manager.runtimeStatus().servers[0]!
      // The wire carries a fixed code + host-generated message only: the raw
      // spawn error (which could echo remote/credential text) never crosses.
      expect(failed.error).toBeDefined()
      expect(failed.error?.message).not.toContain('/nonexistent')
      expect(failed.error?.message).not.toMatch(/ENOENT|spawn/i)
      // A never-synced generation is not-connected, not an empty tool list.
      expect(manager.toolList('ghost')).toBeUndefined()

      const startedBefore = started(lines, 'ghost')
      await manager.connect('ghost')
      await waitFor(() => started(lines, 'ghost') > startedBefore, 'restart after connect')
      await waitFor(() => manager.runtimeStatus().servers[0]?.state === 'failed', 'failed again')
      expect(started(lines, 'ghost')).toBeGreaterThan(startedBefore)
    } finally {
      await dispose()
    }
  })

  it('capToolList bounds entries and reports the true total', () => {
    const many = Array.from({ length: TOOL_LIST_MAX + 5 }, (_, index) => ({
      publicName: `mcp__srv__t${index}`,
      rawName: 'r'.repeat(300),
      description: 'd'.repeat(700),
    }))
    const capped = capToolList(many)
    expect(capped.tools).toHaveLength(TOOL_LIST_MAX)
    expect(capped.truncated).toBe(true)
    expect(capped.total).toBe(TOOL_LIST_MAX + 5)
    expect(capped.tools[0]!.rawName).toHaveLength(200)
    expect(capped.tools[0]!.description).toHaveLength(500)
    const exact = capToolList(many.slice(0, TOOL_LIST_MAX))
    expect(exact.truncated).toBe(false)
    expect(exact.total).toBe(TOOL_LIST_MAX)
  })

  it('test() reports the live tool count without opening a second connection', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => manager.runtimeStatus().servers[0]?.state === 'connected', 'connected')
      const before = started(lines, 'fix')
      const result = await manager.test('fix')
      expect(result.ok).toBe(true)
      expect(result.toolCount).toBeGreaterThan(0)
      expect(started(lines, 'fix')).toBe(before)
      // A configured-but-not-running server is probed on a throwaway connection.
      await manager.disconnect('fix')
      await waitFor(() => stopped(lines, 'fix') === 1, 'stop before probe')
      const probed = await manager.test('fix')
      expect(probed.ok).toBe(true)
      expect(probed.toolCount).toBeGreaterThan(0)
    } finally {
      await dispose()
    }
  })
})
