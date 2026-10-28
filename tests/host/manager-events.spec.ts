// @vitest-environment node
/** Manager workspace-domain, disabled, credential and manual-stop behavior. */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { boot, started, stopped, stdioServer, waitFor } from '../support/manager-fixture.ts'

describe('bridge manager lifecycle events', () => {
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
})
