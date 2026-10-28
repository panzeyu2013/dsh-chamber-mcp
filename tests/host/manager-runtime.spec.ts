// @vitest-environment node
/** Manager runtimeStatus/toolList/connect/test and pure cap helpers. */
import { describe, expect, it } from 'vitest'
import {
  RuntimeActionError,
  TOOL_LIST_MAX,
  capToolList,
} from '../../src/manager.ts'
import { RECONNECT_DEFAULTS } from '../../src/server.ts'
import { boot, started, stopped, stdioServer, waitFor } from '../support/manager-fixture.ts'

describe('bridge manager runtime surface', () => {
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

  it('projects runtimeStatus onto one serverName without changing the full view', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix'), stdioServer('off')], overrides: {}, disabled: { off: true } })
      manager.reconcile()
      await waitFor(
        () => manager.runtimeStatus().servers.some((server) => server.name === 'fix' && server.state === 'connected'),
        'fix connected',
      )

      const full = manager.runtimeStatus()
      expect(Object.keys(full)).toEqual(['v', 'at', 'servers'])
      expect(full.v).toBe(1)
      expect(typeof full.at).toBe('number')
      expect(full.servers.map((server) => server.name)).toEqual(['fix', 'off'])
      // Calling with an explicit undefined is the unchanged no-argument path.
      expect(manager.runtimeStatus(undefined).servers).toEqual(full.servers)

      // Same envelope shape, filtered to exactly one entry, byte-identical to
      // its full-view counterpart (no field added or dropped by the filter).
      const fixOnly = manager.runtimeStatus('fix')
      expect(Object.keys(fixOnly)).toEqual(['v', 'at', 'servers'])
      expect(fixOnly.servers).toHaveLength(1)
      expect(JSON.stringify(fixOnly.servers)).toBe(JSON.stringify([full.servers[0]]))
      expect(fixOnly.servers[0]?.state).toBe('connected')

      const offOnly = manager.runtimeStatus('off')
      expect(JSON.stringify(offOnly.servers)).toBe(JSON.stringify([full.servers[1]]))
      expect(offOnly.servers[0]).toEqual({
        name: 'off',
        state: 'disabled',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
        toolCount: 0,
      })

      // Unknown / never-tracked name: a normal view with an empty list, and no
      // process is started by reading it.
      expect(manager.runtimeStatus('ghost')).toEqual({ v: 1, at: expect.any(Number), servers: [] })
      expect(started(lines, 'ghost')).toBe(0)

      // A tracked handle the document no longer names stays visible in both
      // views (transient orphan) and filters exactly like a document server.
      setDoc({ servers: [], overrides: {} })
      const orphan = manager.runtimeStatus()
      expect(orphan.servers.map((server) => server.name)).toEqual(['fix'])
      expect(JSON.stringify(manager.runtimeStatus('fix').servers)).toBe(JSON.stringify(orphan.servers))
      expect(manager.runtimeStatus('off').servers).toEqual([])
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

  it('test() uses the live generation instead of probing the current definition', async () => {
    const { manager, lines, setDoc, dispose } = await boot()
    try {
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
      manager.reconcile()
      await waitFor(() => manager.runtimeStatus().servers[0]?.state === 'connected', 'connected')
      const before = started(lines, 'fix')
      // Without reconcile, the DOC now names a definition that cannot spawn.
      // A probe against that definition would fail; the live-generation fast
      // path must return the connected handle's tool count instead.
      setDoc({ servers: [stdioServer('fix', { command: '/nonexistent/mcp-scope-test' })], overrides: {} })
      const result = await manager.test('fix')
      expect(result.ok).toBe(true)
      expect(result.toolCount).toBeGreaterThan(0)
      expect(started(lines, 'fix')).toBe(before)

      // Restore the doc, stop the server, and prove the throwaway probe path
      // still works when no live generation exists.
      setDoc({ servers: [stdioServer('fix')], overrides: {} })
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
