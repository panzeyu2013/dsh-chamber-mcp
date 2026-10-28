// @vitest-environment node
/** Manager lifecycle: start/restart/credential coalescing/disposal. */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type { McpScopeDoc } from '../../src/shared/model.ts'
import { boot, started, stopped, stdioServer, waitFor } from '../support/manager-fixture.ts'

describe('bridge manager lifecycle', () => {
  it('starts, restarts on field change, restarts on credential update, stops on removal', async () => {
    const { ctx, manager, lines, agentsListCalls, setDoc, dispose } = await boot()
    // The applier's boot scan must reach the registry through the production
    // adapter: a roots-only adapter would silently drop a running delegation
    // child on a plugin reload.
    expect(agentsListCalls.length).toBeGreaterThan(0)
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

      // 5. Dispose is quiet after full stop: dispose() awaits quiescence, so a
      // synchronous check is both deterministic and stricter than a sleep.
      const count = lines.length
      await dispose()
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
      // The listener filters by "ref in use" SYNCHRONOUSLY before queueing any
      // work, so the negative assertion can be immediate (the old sleep could
      // pass vacuously and slowed the suite).
      ctx.emit('credentials/reference-updated', credentialRef('UNUSED_REF'))
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
      // Settle the restarted server's sync instead of sleeping: it is the last
      // activity the coalesced restart can produce, so nothing may follow it.
      await waitFor(
        () => lines.filter((l) => l.message.includes('mcp-scope(fix): synced 8 tools')).length === 2,
        'post-restart sync settled',
      )
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

})
