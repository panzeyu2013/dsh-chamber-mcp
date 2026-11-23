/**
 * Official-instance lifecycle through the PRODUCTION manager, over the
 * deterministic fake seat: per-definition seats, definition remounts, epoch
 * publication, manual latch, cleanup guard, conflict pre-check, activation
 * retry and teardown.
 *
 * Replaces the retired supervisor-era suites (manager-lifecycle/-events plus the
 * server-* reconnect/backoff/disposal specs): reconnect/backoff itself is
 * upstream-owned now (S2), while the manager-side policy it must honour is
 * pinned here. The REAL connection path is pinned by
 * upstream-mount-gate.spec.ts.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client'
import { HostConfigError } from '../../src/host-config.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { RuntimeActionResult } from '../../src/shared/wire.js'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.js'
import {
  bootManager,
  stdioRow,
  waitFor,
  type BootedManager,
} from '../support/manager-kit.js'
import { captureOf, started, stopped, toolDef } from '../support/fixture-kit.js'
import { FakeSeat } from '../support/fake-seat.js'

const CONNECTED: McpConnectionStatus = { state: 'connected', toolCount: 0, connectedAt: 1_000 }

function docOf(servers: ServerDef[], disabled: Record<string, true> = {}): McpScopeDoc {
  return { servers, overrides: {}, disabled }
}

/** Reconcile and wait for the first mount of one server. */
async function mountOne(b: BootedManager, name = 'fix'): Promise<{ seat: FakeSeat; instance: ReturnType<FakeSeat['mount']> extends never ? never : NonNullable<FakeSeat['instance']> }> {
  b.manager.reconcile()
  const seat = await b.waitSeat(name)
  await waitFor(() => seat.instances.length === 1, 'the first mount of ' + name)
  return { seat, instance: seat.instance! }
}

/** Reconcile, mount and settle activation as connected. */
async function connectOne(b: BootedManager, name = 'fix', status: McpConnectionStatus = CONNECTED): Promise<FakeSeat> {
  const { seat, instance } = await mountOne(b, name)
  instance.resolveReady(status)
  await waitFor(() => b.manager.runtimeStatus(name).servers[0]?.phase === 'connected', name + ' connected')
  return seat
}

function phaseOf(b: BootedManager, name: string): string {
  return b.manager.runtimeStatus(name).servers[0]?.phase ?? 'missing'
}

describe('official instance lifecycle through the production manager', () => {
  it('starts every configured server as its own seat, concurrently', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('alpha'), stdioRow('beta'), stdioRow('gamma')]) })
    try {
      b.manager.reconcile()
      await waitFor(() => b.seatHistory.length === 3, 'one seat per configured server')
      expect(new Set(b.seatHistory.map((seat) => seat.serverName)).size).toBe(3)
      for (const name of ['alpha', 'beta', 'gamma']) {
        expect(started(b.lines, name), name + ' start line').toBe(1)
        expect(b.manager.runtimeStatus(name).servers[0]?.phase).toBe('connecting')
      }
      // The seats are independent: settling one leaves the others connecting.
      const seat = b.seats.get('alpha')!
      seat.instances[0]!.resolveReady(CONNECTED)
      await waitFor(() => phaseOf(b, 'alpha') === 'connected', 'alpha connected')
      expect(phaseOf(b, 'beta')).toBe('connecting')
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('remounts once on a definition change, keeping the old generation published until the new one lands', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const first = await connectOne(b)
      first.setCapture(captureOf([toolDef('mcp__fix__add')], { version: 1 }))
      await waitFor(
        () => b.applier.syncs.some((sync) => sync.epoch === 1 && sync.capture.version === 1),
        'the first capture publication',
      )
      const firstInstance = first.instances[0]!
      const removalsBefore = b.applier.removals.length

      b.setDoc(docOf([stdioRow('fix', { startupTimeoutMs: 20_000 })]))
      b.manager.reconcile()
      await waitFor(() => b.seatHistory.length === 2, 'the remount seat')
      expect(b.seatHistory[0]).toBe(first)
      expect(firstInstance.disposed).toBe(true)
      // revokeFirst=false: the previous generation stays model-visible until the
      // new instance publishes its own.
      expect(b.applier.removals).toHaveLength(removalsBefore)
      expect(stopped(b.lines, 'fix')).toBe(1)
      expect(started(b.lines, 'fix')).toBe(2)

      const second = b.seatHistory[1]!
      second.setCapture(captureOf([toolDef('mcp__fix__add')], { version: 1 }))
      // The instance reports exactly the captured generation (eager canary).
      second.instances[0]!.resolveReady({ state: 'connected', toolCount: 1, connectedAt: 2_000 })
      await waitFor(
        () => b.applier.syncs.some((sync) => sync.epoch === 2 && sync.capture.version === 1),
        'the remounted generation under a new epoch',
      )
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'remounted server connected')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('restart() remounts the live definition and never overlaps two instances', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const connectSeat = await connectOne(b)
      const firstInstance = connectSeat.instances[0]!
      const restarting: Promise<RuntimeActionResult> = b.manager.restart('fix')
      // A same-definition restart keeps the per-definition seat alive and mounts
      // a fresh instance inside it.
      await waitFor(() => connectSeat.instances.length === 2, 'the restart instance')
      // Teardown precedes the next mount: no overlapping live instance.
      expect(firstInstance.disposed).toBe(true)
      expect(b.seatHistory).toHaveLength(1)
      connectSeat.instances[1]!.resolveReady(CONNECTED)
      await expect(restarting).resolves.toMatchObject({ name: 'fix' })
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'restarted server connected')
      expect(started(b.lines, 'fix')).toBe(2)
      expect(stopped(b.lines, 'fix')).toBe(1)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('a manual disconnect latches until connect() or a definition change', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const seat = await connectOne(b)
      const firstInstance = seat.instances[0]!

      await b.manager.disconnect('fix')
      await waitFor(() => phaseOf(b, 'fix') === 'stopped', 'manual stop projection')
      expect(firstInstance.disposed).toBe(true)
      expect(started(b.lines, 'fix')).toBe(1)

      // A settings commit that does not touch the definition keeps it off.
      b.manager.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(started(b.lines, 'fix')).toBe(1)
      expect(phaseOf(b, 'fix')).toBe('stopped')

      // connect() clears the latch and mounts a fresh instance on the SAME seat.
      const reconnect = b.manager.connect('fix')
      await waitFor(() => seat.instances.length === 2, 'the reconnect instance')
      seat.instances[1]!.resolveReady(CONNECTED)
      await reconnect
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'reconnected')

      // A definition change also clears the latch and replaces the seat.
      await b.manager.disconnect('fix')
      await waitFor(() => phaseOf(b, 'fix') === 'stopped', 'second stop')
      b.setDoc(docOf([stdioRow('fix', { cwd: '/tmp' })]))
      b.manager.reconcile()
      await waitFor(() => b.seatHistory.length === 2, 'definition change clears the latch')
      b.seatHistory[1]!.instances[0]!.resolveReady(CONNECTED)
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'definition-change reconnect')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('removal disposes the seat and revokes its published generation', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const seat = await connectOne(b)
      seat.setCapture(captureOf([toolDef('mcp__fix__add')], { version: 1 }))
      await waitFor(() => b.applier.syncs.length === 1, 'capture publication')

      b.setDoc(docOf([]))
      b.manager.reconcile()
      await waitFor(() => seat.disposeSeatCalls === 1, 'seat teardown on removal')
      await waitFor(() => b.applier.removals.includes('fix'), 'generation revocation')
      expect(seat.instances[0]!.disposed).toBe(true)
      expect(stopped(b.lines, 'fix')).toBe(1)
      // A removed, cleanly-stopped record leaves no orphan row.
      expect(b.manager.runtimeStatus().servers).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('honours the configured startup budget and keeps the manual probe capped', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix', { startupTimeoutMs: 1_234, toolCallTimeoutMs: 4_321 })]),
      seat: { probeResult: { ok: true, toolNames: ['add', 'greet'], truncated: false, durationMs: 1, closeConfirmed: true } },
    })
    try {
      const seat = await connectOne(b)
      // The mounted config carries OUR exposed fields, not SDK defaults.
      expect(seat.configs[0]!.startupTimeoutMs).toBe(1_234)
      expect(seat.configs[0]!.toolCallTimeoutMs).toBe(4_321)
      // A connected generation is tested read-only: no second connection.
      const live = await b.manager.test('fix')
      expect(live).toMatchObject({ ok: true, toolCount: 0 })
      expect(seat.probeCalls).toHaveLength(0)
      // When disconnected, the probe runs through the seat host with the wire cap.
      await b.manager.disconnect('fix')
      await waitFor(() => phaseOf(b, 'fix') === 'stopped', 'stopped before probe')
      const probed = await b.manager.test('fix')
      expect(probed).toMatchObject({ ok: true, toolCount: 2 })
      expect(seat.probeCalls[0]!.options?.timeoutMs).toBe(10_000)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('reports failed{load} on an activation rejection and retries the mount on connect()', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const { seat, instance } = await mountOne(b)
      instance.rejectReady(new Error('mcp-client(fix): initial connection or tool synchronization failed'))
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'failed projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('load')
      expect(seat.instances[0]!.disposed).toBe(true)
      const reconnect = b.manager.connect('fix')
      await waitFor(() => seat.instances.length === 2, 'the retry mount on the same seat')
      seat.instances[1]!.resolveReady(CONNECTED)
      await reconnect
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'retry connected')
      expect(seat.disposeSeatCalls).toBe(0)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('retries a failed seat activation through connect()', async () => {
    let attempts = 0
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      seatFactory: async (deps) => {
        attempts += 1
        if (attempts === 1) throw new Error('seat activation exploded')
        return new FakeSeat(deps.serverName, deps.epoch, {}, deps.onCaptureChanged)
      },
    })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'failed seat projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('load')
      expect(b.seatHistory).toHaveLength(0)
      // The rejected seat promise is dropped: the next action retries the factory.
      const reconnect = b.manager.connect('fix')
      await waitFor(() => b.seatHistory.length === 1, 'retried seat')
      b.seatHistory[0]!.instances[0]!.resolveReady(CONNECTED)
      await reconnect
      await waitFor(() => phaseOf(b, 'fix') === 'connected', 'retried seat connected')
      expect(attempts).toBe(2)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('refuses a serverName reserved by the official manager plane with failed{conflict}', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]), managedNames: () => ['fix'] })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'conflict projection')
      const seat = await b.waitSeat('fix')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('conflict')
      expect(seat.instances).toHaveLength(0)
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('official MCP manager'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('classifies a mount-race conflict from the official reservation', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      seat: { mountError: new Error('mcp-client(fix): server name "fix" is already in use by another mcp-client instance') },
    })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'race conflict projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('conflict')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('cleanup failure blocks remounting until restart and rejects actions with a fixed code', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      seat: { disposeResult: { closeConfirmed: false, cleanupError: 'close hung' } },
    })
    try {
      const seat = await connectOne(b)
      const restarting = b.manager.restart('fix')
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'cleanup guard projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('cleanup')
      await expect(restarting).resolves.toMatchObject({ name: 'fix' })
      // Guarded: no second mount happened, and every action is a fixed refusal.
      expect(seat.instances).toHaveLength(1)
      expect(b.seatHistory).toHaveLength(1)
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('cleanup is incomplete'))).toBe(true)
      await expect(b.manager.connect('fix')).rejects.toMatchObject({ code: 'cleanup' })
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('cleanup is incomplete'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('workspace domain/changed reconciles the applier only (no server mutation)', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      await connectOne(b)
      const reconciles = b.applier.reconciles
      const seats = b.seatHistory.length
      b.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'put', value: {} })
      await waitFor(() => b.applier.reconciles > reconciles, 'applier reconcile on the workspace event')
      expect(b.seatHistory).toHaveLength(seats)
      expect(started(b.lines, 'fix')).toBe(1)
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('never mounts a globally disabled server and unmounts one that becomes disabled', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('off')], { off: true }) })
    try {
      b.manager.reconcile()
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(b.seatHistory).toHaveLength(0)
      expect(phaseOf(b, 'off')).toBe('disabled')

      // Enabling mounts it; disabling again stops the live instance and revokes.
      b.setDoc(docOf([stdioRow('off')]))
      const seat = await connectOne(b, 'off')
      await b.manager.disconnect('off')
      await waitFor(() => phaseOf(b, 'off') === 'stopped', 'manual stop')
      b.setDoc(docOf([stdioRow('off')], { off: true }))
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'off') === 'disabled', 'disabled projection')
      expect(seat.instances[0]!.disposed).toBe(true)
      expect(started(b.lines, 'off')).toBe(1)
      expect(stopped(b.lines, 'off')).toBe(1)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('dispose quiesces every instance/seat, revokes and is idempotent', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('alpha'), stdioRow('beta')]) })
    try {
      b.manager.reconcile()
      await waitFor(() => b.seatHistory.length === 2, 'two seats')
      for (const seat of b.seatHistory) seat.instances[0]?.resolveReady(CONNECTED)
      await waitFor(() => phaseOf(b, 'alpha') === 'connected' && phaseOf(b, 'beta') === 'connected', 'both connected')

      await b.manager.dispose()
      for (const seat of b.seatHistory) {
        expect(seat.disposeSeatCalls).toBe(1)
        expect(seat.instances[0]!.disposed).toBe(true)
      }
      expect(b.applier.disposed).toBe(true)
      expect(b.applier.removals.sort()).toEqual(['alpha', 'beta'])
      const before = b.lines.length
      await b.manager.dispose()
      expect(b.lines.length).toBe(before)
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('manager failure branches and guards', () => {
  it('reports failed{config} when the adapter/host refuses the resolved configuration', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      seat: { validateError: new HostConfigError('invalid-config', 'servers.fix: refused') },
    })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'config failure projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('config')
      const probe = await b.manager.test('fix')
      expect(probe).toMatchObject({ ok: false, stage: 'connect', code: 'config' })
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('reports failed{load} when the seat mount throws', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]), seat: { mountError: new Error('mount refused') } })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'mount failure projection')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('load')
      // restart() on a failed generation retries the mount (the fake seat keeps
      // refusing, so the projection stays failed{load}).
      const seat = await b.waitSeat('fix')
      const restarting = b.manager.restart('fix')
      await expect(restarting).resolves.toMatchObject({ name: 'fix' })
      expect(seat.instances).toHaveLength(0)
      await waitFor(() => phaseOf(b, 'fix') === 'failed', 'restart failure stays projected')
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('load')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('maps probe throws to internal and probe failures to fixed codes', async () => {
    const thrower = await bootManager({ doc: docOf([stdioRow('a')]), seat: { probeError: new Error('probe exploded') } })
    try {
      expect(await thrower.manager.test('a')).toMatchObject({ ok: false, stage: 'connect', code: 'internal' })
    } finally {
      await thrower.dispose()
    }
    const failure = await bootManager({
      doc: docOf([stdioRow('b')]),
      seat: { probeResult: { ok: false, stage: 'list', message: 'request timed out', durationMs: 1, closeConfirmed: true } },
    })
    try {
      expect(await failure.manager.test('b')).toMatchObject({ ok: false, stage: 'list', code: 'timeout' })
    } finally {
      await failure.dispose()
    }
  }, 30_000)

  it('degrades a throwing official-manager reader to no pre-check and still mounts', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      managedNames: () => {
        throw new Error('official plane exploded')
      },
    })
    try {
      await connectOne(b)
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('official manager plane could not be read'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('connect() on a running generation is a no-op', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const seat = await connectOne(b)
      const result = await b.manager.connect('fix')
      expect(result).toMatchObject({ name: 'fix', phase: 'connected' })
      expect(seat.instances).toHaveLength(1)
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('retained cleanup guard rows', () => {
  it('retains a removed server as an orphan status row while its teardown is unconfirmed', async () => {
    const b = await bootManager({
      doc: docOf([stdioRow('fix')]),
      seat: { disposeResult: { closeConfirmed: false, cleanupError: 'close hung' } },
    })
    try {
      const seat = await connectOne(b)
      seat.setCapture(captureOf([toolDef('mcp__fix__add')], { version: 1 }))
      await waitFor(() => b.applier.syncs.length > 0, 'capture publication')
      b.setDoc(docOf([]))
      b.manager.reconcile()
      await waitFor(
        () => {
          const entry = b.manager.runtimeStatus('fix').servers[0]
          return entry?.configured === false && entry.error?.code === 'cleanup'
        },
        'the retained orphan guard row',
      )
      const orphan = b.manager.runtimeStatus('fix').servers[0]!
      expect(orphan.configured).toBe(false)
      expect(orphan.phase).toBe('failed')
      expect(orphan.error?.code).toBe('cleanup')
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('cleanup is incomplete'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('retired manager listeners', () => {
  it('a credential record event restarts nothing manager-side (the mounted instance owns reconnects)', async () => {
    const b = await bootManager({ doc: docOf([stdioRow('fix')]) })
    try {
      const seat = await connectOne(b)
      const before = b.lines.length
      // Upstream's instance subscribes to credentials/reference-updated itself;
      // the manager must not duplicate that listener (D3).
      b.ctx.emit('credentials/reference-updated', credentialRef('SOME_TOKEN'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(seat.instances).toHaveLength(1)
      expect(seat.disposeSeatCalls).toBe(0)
      expect(started(b.lines, 'fix')).toBe(1)
      expect(b.lines.length).toBe(before)
    } finally {
      await b.dispose()
    }
  }, 30_000)
})
