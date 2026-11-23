/**
 * Manager status projection matrix: upstream McpConnectionStatus -> the frozen
 * wire phases/codes (src/shared/wire.ts) plus the cleanup guard projection.
 *
 * The production manager runs over a deterministic fake seat, so every status
 * variant and every cleanup record is reproducible; the REAL connection path is
 * pinned separately by upstream-mount-gate.spec.ts.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { type ManagerHandle } from '../../src/manager.js'
import { TOOL_LIST_MAX, capToolList, classifyStatusError } from '../../src/status.js'
import type { RuntimeStatusView, ServerRuntimeView } from '../../src/shared/wire.js'
import { RECONNECT_DEFAULTS } from '../../src/shared/defaults.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { bootManager, stdioRow, waitFor, type BootedManager } from '../support/manager-kit.js'
import { captureOf, toolDef } from '../support/fixture-kit.js'
import type { FakeInstance, FakeSeat } from '../support/fake-seat.js'

function viewOf(manager: ManagerHandle, name: string): ServerRuntimeView {
  const view = manager.runtimeStatus(name).servers.find((entry) => entry.name === name)
  if (view === undefined) throw new Error('server ' + name + ' is not in the projection')
  return view
}

interface Booted {
  b: BootedManager
  seat: FakeSeat
  instance: FakeInstance
}

/** Boot the fake-seat manager, reconcile and wait for the first mount. */
async function bootSeat(options: {
  toolLoading?: 'eager' | 'on-demand'
  reconnect?: { maxAttempts?: number }
  captureTools?: ToolDefinition[]
  version?: number
  disposeResult?: { closeConfirmed: boolean; cleanupError?: string }
} = {}): Promise<Booted> {
  const b = await bootManager({
    doc: {
      servers: [
        stdioRow('fix', {
          ...(options.toolLoading === undefined ? {} : { toolLoading: options.toolLoading }),
          ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
        }),
      ],
      overrides: {},
    },
    seat: { ...(options.disposeResult === undefined ? {} : { disposeResult: options.disposeResult }) },
  })
  b.manager.reconcile()
  const seat = await b.waitSeat('fix')
  await waitFor(() => seat.instances.length === 1, 'the first mount')
  if (options.captureTools !== undefined) {
    seat.setCapture(captureOf(options.captureTools, { version: options.version ?? 1 }))
  }
  return { b, seat, instance: seat.instance! }
}

describe('upstream status -> runtime phase', () => {
  it('maps every connection state, including both waiting phases', async () => {
    const { b, seat, instance } = await bootSeat()
    try {
      // Optimistic seed before activation settles: connecting, nothing synced.
      const seeded = viewOf(b.manager, 'fix')
      expect(seeded.phase).toBe('connecting')
      expect(seeded.toolCount).toBe(0)

      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 111 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      expect(viewOf(b.manager, 'fix').connectedAt).toBe(111)

      const cases: Array<[Parameters<FakeInstance['emit']>[0], string]> = [
        [{ state: 'waiting-credentials', lastError: 'credential TOKEN is not configured' }, 'waiting-credentials'],
        [{ state: 'waiting-authorization', reason: 'missing', lastError: 'no grant saved' }, 'waiting-authorization'],
        [{ state: 'connecting', attempt: 2 }, 'connecting'],
        [{ state: 'reconnecting', attempt: 1, maxAttempts: 4, nextRetryAtMs: 999, lastError: 'timed out' }, 'reconnecting'],
        [{ state: 'reconnecting', attempt: 2, maxAttempts: 4, nextRetryAtMs: 5, lastError: 'credential ref "TOKEN" resolved to an invalid value (CR/LF/NUL)' }, 'waiting-credentials'],
        [{ state: 'failed', reason: 'gave-up', lastError: 'timed out' }, 'failed'],
        [{ state: 'failed', reason: 'reconnect-disabled' }, 'failed'],
        [{ state: 'closed', result: { closeConfirmed: true } }, 'stopped'],
      ]
      for (const [status, phase] of cases) {
        instance.emit(status)
        await waitFor(() => viewOf(b.manager, 'fix').phase === phase, 'projection ' + phase)
      }
      // Failed variants keep their fixed identity, never upstream prose.
      instance.emit({ state: 'failed', reason: 'gave-up', lastError: 'secret-token-xyz' })
      await waitFor(() => viewOf(b.manager, 'fix').error?.code === 'gave-up', 'gave-up code')
      expect(JSON.stringify(b.manager.runtimeStatus('fix'))).not.toContain('secret-token-xyz')
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
      void seat
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('maps the five authorization reasons and never puts attempt prose on the wire', async () => {
    const { b, seat, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      const reasons = ['missing', 'expired', 'binding', 'rejected', 'scope'] as const
      for (const reason of reasons) {
        instance.emit({ state: 'waiting-authorization', reason, lastError: 'refresh failed for secret-token-abc' })
        await waitFor(
          () => viewOf(b.manager, 'fix').phase === 'waiting-authorization',
          'waiting-authorization ' + reason,
        )
        const view = viewOf(b.manager, 'fix')
        expect(view.authReason).toBe(reason)
        expect(view.toolCount).toBe(0)
        expect(JSON.stringify(view)).not.toContain('secret-token-abc')
      }
      void seat
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('derives attempts/maxAttempts/nextRetryAt from the resolved policy and status', async () => {
    const { b, instance } = await bootSeat({ reconnect: { maxAttempts: 3 } })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      instance.emit({ state: 'connecting', attempt: 2 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connecting', 'connecting projection')
      const connecting = viewOf(b.manager, 'fix')
      expect(connecting.attempts).toBe(2)
      // The manager's resolved policy comes from our own reconnect defaults
      // materialized by the adapter; assert against the frozen table.
      expect(connecting.maxAttempts).toBe(3)
      expect(connecting.nextRetryAt).toBeUndefined()

      instance.emit({ state: 'reconnecting', attempt: 1, maxAttempts: 7, nextRetryAtMs: 4242, lastError: 'boom' })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'reconnecting', 'reconnecting projection')
      const reconnecting = viewOf(b.manager, 'fix')
      expect(reconnecting.attempts).toBe(1)
      expect(reconnecting.maxAttempts).toBe(7)
      expect(reconnecting.nextRetryAt).toBe(4242)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('maps reconnecting failure text to fixed codes and never reflects it', async () => {
    const { b, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      const cases: Array<[string, string]> = [
        ['request timed out after 30s', 'timeout'],
        ['HTTP 401 unauthorized', 'forbidden'],
        ['spawn ENOENT /usr/bin/missing', 'spawn-failed'],
        ['unexpected token in JSON response', 'protocol'],
        ['socket hang up quietly', 'connection-failed'],
      ]
      for (const [lastError, code] of cases) {
        instance.emit({ state: 'reconnecting', attempt: 1, maxAttempts: 10, nextRetryAtMs: Date.now() + 1000, lastError })
        await waitFor(() => viewOf(b.manager, 'fix').error?.code === code, 'code ' + code)
        expect(JSON.stringify(b.manager.runtimeStatus('fix'))).not.toContain(lastError)
      }
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('degrades an unrecognized future status variant to failed{load}, never a healthy phase', async () => {
    const { b, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      ;(instance.status as unknown as { update(next: unknown): void }).update({ state: 'some-future-state' })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'failed', 'degraded projection')
      expect(viewOf(b.manager, 'fix').error?.code).toBe('load')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('projects a never-mounted server as unknown and a disabled one as disabled', async () => {
    const b = await bootManager({
      doc: { servers: [stdioRow('later'), stdioRow('off')], overrides: {}, disabled: { off: true } },
    })
    try {
      // Reading status never starts anything.
      const full = b.manager.runtimeStatus()
      expect(full.v).toBe(1)
      expect(typeof full.at).toBe('number')
      expect(full.servers.map((entry) => entry.phase)).toEqual(['unknown', 'disabled'])
      expect(full.servers.map((entry) => entry.maxAttempts)).toEqual([
        RECONNECT_DEFAULTS.maxAttempts,
        RECONNECT_DEFAULTS.maxAttempts,
      ])
      expect(b.seats.size).toBe(0)
    } finally {
      await b.dispose()
    }
  })

  it('keeps the ?server filter byte-identical to the full-view entry', async () => {
    const { b, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      const full: RuntimeStatusView = b.manager.runtimeStatus()
      expect(Object.keys(full)).toEqual(['v', 'at', 'servers'])
      const filtered = b.manager.runtimeStatus('fix')
      expect(Object.keys(filtered)).toEqual(['v', 'at', 'servers'])
      expect(JSON.stringify(filtered.servers)).toBe(JSON.stringify(full.servers))
      // Unknown names are a normal empty view, not an error.
      expect(b.manager.runtimeStatus('ghost')).toEqual({ v: 1, at: expect.any(Number), servers: [] })
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('reports failed{seam} on an eager canary mismatch and exempts on-demand servers', async () => {
    const { b, seat, instance } = await bootSeat({
      captureTools: [toolDef('mcp__fix__a'), toolDef('mcp__fix__b'), toolDef('mcp__fix__c')],
    })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 8, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'failed', 'seam degradation')
      expect(viewOf(b.manager, 'fix').error?.code).toBe('seam')
      expect(b.lines.some((line) => line.level === 'error' && line.message.includes('disagrees'))).toBe(true)
      void seat
    } finally {
      await b.dispose()
    }

    const onDemand = await bootSeat({
      toolLoading: 'on-demand',
      captureTools: [toolDef('mcp__fix__load_tools')],
    })
    try {
      onDemand.instance.resolveReady({ state: 'connected', toolCount: 8, connectedAt: 1 })
      await waitFor(() => viewOf(onDemand.b.manager, 'fix').phase === 'connected', 'on-demand connected')
      expect(viewOf(onDemand.b.manager, 'fix').error).toBeUndefined()
    } finally {
      await onDemand.b.dispose()
    }
  }, 30_000)

  it('reports the cleanup guard as failed{cleanup} when a probe close is unconfirmed', async () => {
    // A probe that cannot confirm transport closure feeds the cleanup guard:
    // the server is retained as a failed{cleanup} row and every action is a
    // fixed business refusal until the plugin/Host restarts (D6/ADR-1.7).
    const b = await bootManager({
      doc: { servers: [stdioRow('fix')], overrides: {} },
      seat: {
        probeResult: { ok: false, stage: 'connect', message: 'connection refused', durationMs: 1, closeConfirmed: false },
      },
    })
    try {
      const result = await b.manager.test('fix')
      expect(result).toMatchObject({ ok: false, stage: 'connect', code: 'cleanup' })
      await waitFor(() => viewOf(b.manager, 'fix').error?.code === 'cleanup', 'cleanup projection')
      expect(viewOf(b.manager, 'fix').phase).toBe('failed')
      // Retained guard row: still projected after the action, with the fixed code.
      await expect(b.manager.connect('fix')).rejects.toMatchObject({ code: 'cleanup' })
      await expect(b.manager.restart('fix')).rejects.toMatchObject({ code: 'cleanup' })
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('advances syncedAt on capture publish only', async () => {
    const { b, seat, instance } = await bootSeat({ captureTools: [toolDef('mcp__fix__a')] })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 1, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').syncedAt !== undefined, 'first capture publish')
      const first = viewOf(b.manager, 'fix').syncedAt
      // A pure status transition does not move the capture timestamp.
      instance.emit({ state: 'reconnecting', attempt: 1, maxAttempts: 10, nextRetryAtMs: Date.now() + 500, lastError: 'boom' })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'reconnecting', 'reconnecting projection')
      expect(viewOf(b.manager, 'fix').syncedAt).toBe(first)

      // A new capture generation does.
      await new Promise((resolve) => setTimeout(resolve, 5))
      seat.setCapture(captureOf([toolDef('mcp__fix__a'), toolDef('mcp__fix__b')], { version: 2 }))
      await waitFor(() => viewOf(b.manager, 'fix').syncedAt !== first, 'second capture publish')
      expect(viewOf(b.manager, 'fix').toolCount).toBe(2)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('bounds the wire tool list: cap entries, cap names/descriptions, true total', () => {
    const many = Array.from({ length: TOOL_LIST_MAX + 5 }, (_, index) => ({
      ...toolDef('mcp__srv__t' + index),
      description: 'd'.repeat(700),
    }))
    const defs = new Map(many.map((definition) => [definition.name, definition]))
    const capped = capToolList(defs)
    expect(capped.tools).toHaveLength(TOOL_LIST_MAX)
    expect(capped.truncated).toBe(true)
    expect(capped.total).toBe(TOOL_LIST_MAX + 5)
    expect(capped.mode).toBe('definitions')
    expect(capped.tools[0]!.publicName.length).toBeLessThanOrEqual(200)
    expect(capped.tools[0]!.description.length).toBe(500)
    const exact = capToolList(new Map(many.slice(0, TOOL_LIST_MAX).map((definition) => [definition.name, definition])))
    expect(exact.truncated).toBe(false)
    expect(exact.total).toBe(TOOL_LIST_MAX)
  })
})

describe('status error classification', () => {
  it('maps the credentials facade refusal to invalid-credential (actionable, not transient)', () => {
    expect(classifyStatusError('credential ref "TOKEN" resolved to an invalid value (CR/LF/NUL)')).toBe('invalid-credential')
    expect(classifyStatusError('request timed out after 30s')).toBe('timeout')
    expect(classifyStatusError('HTTP 401 unauthorized')).toBe('forbidden')
  })

  it('projects an unconfirmed manual teardown as failed{cleanup}, never stopped', async () => {
    const { b, instance } = await bootSeat({ disposeResult: { closeConfirmed: false, cleanupError: 'close hung' } })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      await b.manager.disconnect('fix')
      await waitFor(() => viewOf(b.manager, 'fix').error?.code === 'cleanup', 'cleanup projection')
      const view = viewOf(b.manager, 'fix')
      expect(view.phase).toBe('failed')
      expect(view.error?.code).toBe('cleanup')
    } finally {
      await b.dispose()
    }
  }, 30_000)
})
describe('tool-list modes and seam recovery', () => {
  it('reports the on-demand catalog mode with the offered count', async () => {
    const { b, instance } = await bootSeat({
      toolLoading: 'on-demand',
      captureTools: [toolDef('mcp__fix__load_tools')],
    })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 8, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'on-demand connected')
      expect(b.manager.toolList('fix')).toEqual({ mode: 'catalog', tools: [], truncated: false, total: 8 })
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('clears the seam degradation once the status agrees with the capture', async () => {
    const { b, seat, instance } = await bootSeat({
      captureTools: [toolDef('mcp__fix__a'), toolDef('mcp__fix__b'), toolDef('mcp__fix__c')],
    })
    try {
      instance.resolveReady({ state: 'connected', toolCount: 8, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').error?.code === 'seam', 'seam degradation')
      // A fresh capture generation that matches the instance count restores the
      // healthy projection (explicit recovery, one re-publish).
      seat.setCapture(captureOf([
        toolDef('mcp__fix__a'),
        toolDef('mcp__fix__b'),
        toolDef('mcp__fix__c'),
        toolDef('mcp__fix__d'),
        toolDef('mcp__fix__e'),
        toolDef('mcp__fix__f'),
        toolDef('mcp__fix__g'),
        toolDef('mcp__fix__h'),
      ], { version: 2 }))
      instance.emit({ state: 'connected', toolCount: 8, connectedAt: 2 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'seam recovery')
      expect(viewOf(b.manager, 'fix').error).toBeUndefined()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('contains a throwing capture read in the seam canary and the tool list', async () => {
    const { b, seat, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      ;(seat as unknown as { capture: () => never }).capture = () => {
        throw new Error('capture exploded')
      }
      instance.emit({ state: 'connected', toolCount: 0, connectedAt: 2 })
      await waitFor(
        () => b.lines.some((line) => line.level === 'warn' && line.message.includes('seam canary could not read the capture')),
        'contained canary capture failure',
      )
      const listed = b.manager.toolList('fix')
      expect(listed).toMatchObject({ mode: 'definitions', total: 0 })
      expect(b.lines.some((line) => line.level === 'warn' && line.message.includes('tool list could not read the capture'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('unclosed generation cleanup guard', () => {
  it('merges the handle closure into the cleanup guard on failed{unclosed-generation}', async () => {
    const { b, instance } = await bootSeat()
    try {
      instance.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      // Upstream reports an unclosed generation; its handle closure is
      // unconfirmed, so the manager retains the cleanup guard identity.
      instance.status.setClosure({ closeConfirmed: false, cleanupError: 'generation close hung' })
      instance.emit({ state: 'failed', reason: 'unclosed-generation' })
      await waitFor(() => viewOf(b.manager, 'fix').error?.code === 'cleanup', 'cleanup guard merged')
      expect(viewOf(b.manager, 'fix').phase).toBe('failed')
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('capture publication version-first skip (H5)', () => {
  it('does not consume a snapshot when a re-publish carries an unchanged capture version', async () => {
    // The production seat forwards its notification counter with every capture
    // change; the manager compares it with its published version BEFORE copying
    // the (up to 2000-entry) snapshot. The fakes omit the counter by default, so
    // this pin opts the shared fake into version forwarding (H5 had no direct
    // manager-level pin: every other test only reached the snapshot fallback).
    const b = await bootManager({
      doc: { servers: [stdioRow('fix')], overrides: {} },
      seat: { forwardCaptureVersion: true },
    })
    try {
      b.manager.reconcile()
      const seat = await b.waitSeat('fix')
      await waitFor(() => seat.instances.length === 1, 'the first mount')
      seat.instance!.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 1 })
      await waitFor(() => viewOf(b.manager, 'fix').phase === 'connected', 'connected projection')
      // The connect pass publishes the empty generation (version 0) through the
      // seam canary + attach; realign the counter before the interesting part.
      await waitFor(() => b.applier.versionsOf('fix').includes(0), 'the initial capture publish')
      const baseline = seat.captureCalls

      // A new generation with a forwarded version consumes exactly one snapshot.
      seat.setCapture(captureOf([toolDef('mcp__fix__a')], { version: 1 }))
      await waitFor(() => b.applier.versionsOf('fix').includes(1), 'the generation-1 publish')
      expect(seat.captureCalls).toBe(baseline + 1)

      // The SAME version again (status wake-up / duplicate notification) must be
      // skipped on the forwarded counter: no snapshot copy, no second publish.
      seat.setCapture(captureOf([toolDef('mcp__fix__a')], { version: 1 }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seat.captureCalls).toBe(baseline + 1)
      expect(b.applier.versionsOf('fix')).toEqual([0, 1])

      // A real generation change still publishes: the skip is version-driven.
      seat.setCapture(captureOf([toolDef('mcp__fix__b')], { version: 2 }))
      await waitFor(() => b.applier.versionsOf('fix').includes(2), 'the generation-2 publish')
      expect(seat.captureCalls).toBe(baseline + 2)
      expect(b.applier.versionsOf('fix')).toEqual([0, 1, 2])
    } finally {
      await b.dispose()
    }
  }, 30_000)
})
