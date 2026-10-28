import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot, ServerRuntimeView } from '../../src/client/runtime.js'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.js'
import { en } from '../../src/client/locales.js'
import {
  clockOf,
  enabledServerNames,
  isServerInUse,
  needsAttention,
  orphanedRefsOf,
  runtimeErrorKey,
  runtimeErrorText,
  runtimeOf,
  runtimeSnapshotsEqual,
  serversUsingRef,
  statusKeyOf,
  statusToneOf,
} from '../../src/client/view-model.js'

const view = (patch: Partial<ServerRuntimeView> = {}): ServerRuntimeView => ({
  name: 'alpha',
  state: 'connected',
  attempts: 1,
  maxAttempts: 5,
  toolCount: 2,
  ...patch,
})

const snapshot = (patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  phase: 'ready',
  servers: { alpha: view() },
  ...patch,
})

const stdio = (serverName: string, envKeys: string[]): ServerDef => ({
  serverName,
  transport: 'stdio',
  command: 'node',
  envKeys,
})

const http = (serverName: string, refs: string[]): ServerDef => ({
  serverName,
  transport: 'streamable-http',
  url: 'https://example.test/mcp',
  headers: refs.map((ref) => ({ name: 'X-' + ref, ref })),
})

const doc = (): McpScopeDoc => ({
  servers: [stdio('alpha', ['ALPHA_TOKEN', 'SHARED']), http('beta', ['BETA_TOKEN', 'SHARED'])],
  overrides: { 'ws-1': { alpha: true }, 'ws-2': { beta: true } },
  disabled: {},
})

describe('runtimeSnapshotsEqual', () => {
  it('ignores the sampling timestamp but compares every visible field', () => {
    expect(runtimeSnapshotsEqual(snapshot(), { ...snapshot(), at: 999 })).toBe(true)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ phase: 'error' }))).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ error: 'boom' }))).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ servers: {} }))).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot())).toBe(true)
    // The identity fast-path must not hide a later mutation.
    const same = snapshot()
    expect(runtimeSnapshotsEqual(same, same)).toBe(true)
  })

  it('compares every server field, not only the ones the row paints', () => {
    const mutations: Partial<ServerRuntimeView>[] = [
      { name: 'renamed' },
      { state: 'failed' },
      { attempts: 2 },
      { maxAttempts: 9 },
      { nextRetryAt: 1 },
      { connectedAt: 1 },
      { syncedAt: 1 },
      { toolCount: 3 },
      { error: { code: 'timeout', message: 'x' } },
    ]
    for (const mutation of mutations) {
      const left = snapshot()
      const right = snapshot({ servers: { alpha: view(mutation) } })
      expect(runtimeSnapshotsEqual(left, right), JSON.stringify(mutation)).toBe(false)
    }
  })

  it('detects a same-count server key swap and a message-only error change', () => {
    expect(
      runtimeSnapshotsEqual(snapshot(), snapshot({ servers: { beta: view({ name: 'beta' }) } })),
    ).toBe(false)
    expect(
      runtimeSnapshotsEqual(
        snapshot({ servers: { alpha: view({ error: { code: 'timeout', message: 'one' } }) } }),
        snapshot({ servers: { alpha: view({ error: { code: 'timeout', message: 'two' } }) } }),
      ),
    ).toBe(false)
  })
})

describe('runtime projections', () => {
  it('reads one server view through an OWN key only', () => {
    expect(runtimeOf(snapshot(), 'alpha')).toMatchObject({ name: 'alpha' })
    expect(runtimeOf(snapshot(), 'toString')).toBeUndefined()
    expect(runtimeOf(undefined, 'alpha')).toBeUndefined()
  })

  it('maps every runtime phase to its locale key and tone', () => {
    const expected: [Parameters<typeof statusKeyOf>[0], string, string][] = [
      ['connected', 'status.connected', 'ok'],
      ['connecting', 'status.connecting', 'warn'],
      ['reconnecting', 'status.reconnecting', 'warn'],
      ['failed', 'status.failed', 'error'],
      ['stopped', 'status.stopped', 'idle'],
      ['disabled', 'status.disabled', 'idle'],
      ['unknown', 'status.unknown', 'idle'],
    ]
    for (const [phase, key, tone] of expected) {
      expect(statusKeyOf(phase)).toBe(key)
      expect(statusToneOf(phase)).toBe(tone)
    }
  })

  it('maps every host error code and falls back to the host message', () => {
    const codes = [
      'connection-failed',
      'gave-up',
      'reconnect-disabled',
      'generation-stuck',
      'forbidden',
      'timeout',
      'spawn-failed',
      'protocol',
    ]
    for (const code of codes) {
      const key = runtimeErrorKey(code)
      expect(key, code).toBeDefined()
      expect(runtimeErrorText((name) => en[name], { code, message: 'host text' })).toBe(en[key!])
    }
    expect(runtimeErrorKey('future-code')).toBeUndefined()
    expect(runtimeErrorText((name) => en[name], { code: 'future-code', message: 'host text' })).toBe(
      'host text',
    )
  })

  it('finds every server that references a credential ref', () => {
    expect(serversUsingRef(doc(), 'SHARED')).toEqual(['alpha', 'beta'])
    expect(serversUsingRef(doc(), 'BETA_TOKEN')).toEqual(['beta'])
    expect(serversUsingRef(doc(), 'MISSING')).toEqual([])
  })

  it('reports only the refs a removed server would orphan', () => {
    expect(orphanedRefsOf(doc(), 'alpha')).toEqual(['ALPHA_TOKEN'])
    expect(orphanedRefsOf(doc(), 'beta')).toEqual(['BETA_TOKEN'])
    expect(orphanedRefsOf(doc(), 'missing')).toEqual([])
  })

  it('lists enabled servers per workspace and judges use', () => {
    expect(enabledServerNames(doc(), 'ws-1')).toEqual(['alpha'])
    expect(enabledServerNames(doc(), 'ws-2')).toEqual(['beta'])
    expect(enabledServerNames(doc(), 'unknown')).toEqual([])
    expect(isServerInUse(doc(), doc().servers[0]!, ['ws-1'])).toBe(true)
    expect(isServerInUse(doc(), doc().servers[1]!, ['ws-1'])).toBe(false)
    const off = { ...doc(), disabled: { alpha: true as const } }
    expect(isServerInUse(off, off.servers[0]!, ['ws-1'])).toBe(false)
  })

  it('needs attention only for a failed runtime', () => {
    expect(needsAttention('failed')).toBe(true)
    for (const phase of ['connected', 'connecting', 'reconnecting', 'stopped', 'disabled', 'unknown', undefined] as const) {
      expect(needsAttention(phase)).toBe(false)
    }
  })

  it('formats a sync timestamp and tolerates an absent one', () => {
    expect(clockOf(undefined)).toBeUndefined()
    const label = clockOf(1_700_000_000_000)
    expect(typeof label).toBe('string')
    expect(label!.length).toBeGreaterThan(0)
  })
})
