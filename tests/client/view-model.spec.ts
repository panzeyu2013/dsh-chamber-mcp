import { describe, expect, it } from 'vitest'
import type {
  RuntimeAuthorizationPhase,
  RuntimeAuthorizationReason,
  RuntimeAuthorizationView,
  RuntimeErrorCode,
  RuntimePhase,
  RuntimeSnapshot,
  ServerRuntimeView,
} from '../../src/client/runtime.js'
import type { RuntimeAuthorizationFailure } from '../../src/shared/wire.js'
import { credentialRefsOf, type McpScopeDoc, type ServerDef } from '../../src/shared/model.js'
import type { TextSeat } from '../../src/client/controller.js'
import {
  authorizationReasonKey,
  clockOf,
  detachedRuntimeViews,
  enabledServerNames,
  isAuthorizationActive,
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
  phase: 'connected',
  configured: true,
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

  it('compares every ServerRuntimeView field through a compile-enforced map', () => {
    // The mapped type is the point: a NEW field on the wire view fails to
    // compile until it appears here with a mutation, so a field can never be
    // silently ignored by the repaint comparator (which would swallow the
    // authorization URL / attempt phase / retained-row updates).
    const mutations: { [K in keyof ServerRuntimeView]: (current: ServerRuntimeView) => Partial<ServerRuntimeView> } = {
      name: () => ({ name: 'renamed' }),
      phase: () => ({ phase: 'failed' }),
      configured: () => ({ configured: false }),
      attempts: () => ({ attempts: 9 }),
      maxAttempts: () => ({ maxAttempts: 99 }),
      nextRetryAt: () => ({ nextRetryAt: 1 }),
      connectedAt: () => ({ connectedAt: 1 }),
      syncedAt: () => ({ syncedAt: 1 }),
      toolCount: () => ({ toolCount: 77 }),
      authReason: () => ({ authReason: 'expired' }),
      authorization: (current) => ({
        authorization: { id: (current.authorization?.id ?? 'id') + '-next', phase: 'waiting-browser' },
      }),
      error: () => ({ error: { code: 'timeout' } }),
    }
    for (const key of Object.keys(mutations) as (keyof ServerRuntimeView)[]) {
      const mutate = mutations[key] as (current: ServerRuntimeView) => Partial<ServerRuntimeView>
      const right = snapshot({ servers: { alpha: view(mutate(view())) } })
      expect(runtimeSnapshotsEqual(snapshot(), right), key).toBe(false)
    }
  })

  it('compares every nested RuntimeAuthorizationView field through its own compile-enforced map', () => {
    // The top-level table cannot see inside the nested attempt view: the
    // comparator expands it through a second mapped table so a FUTURE field on
    // RuntimeAuthorizationView (like today's additive `failure`) fails to
    // compile until it is compared — a nested field can never be swallowed.
    const mutations: {
      [K in keyof Required<RuntimeAuthorizationView>]: (current: RuntimeAuthorizationView) => RuntimeAuthorizationView
    } = {
      id: (current) => ({ ...current, id: current.id + '-next' }),
      phase: (current) => ({ ...current, phase: 'waiting-browser', authorizationUrl: 'https://as.test/a' }),
      authorizationUrl: (current) => ({ ...current, authorizationUrl: 'https://as.test/b' }),
      failure: (current) => ({ ...current, failure: 'cleanup' }),
    }
    const base: RuntimeAuthorizationView = { id: 'attempt-1', phase: 'failed', failure: 'timeout' }
    const withAttempt = (attempt: RuntimeAuthorizationView): RuntimeSnapshot =>
      snapshot({ servers: { alpha: view({ authorization: attempt }) } })
    for (const key of Object.keys(mutations) as (keyof RuntimeAuthorizationView)[]) {
      const mutate = mutations[key] as (current: RuntimeAuthorizationView) => RuntimeAuthorizationView
      expect(runtimeSnapshotsEqual(withAttempt(base), withAttempt(mutate(base))), key).toBe(false)
    }
  })

  it('repaints when ONLY the failed attempt reason changes (additive wire field)', () => {
    // Wire additive field: the host can change a failed attempt's fixed failure
    // identity (e.g. timeout -> cleanup) while id/phase/URL stay identical. The
    // comparator must publish the new view even though the UI does not render
    // the field yet: the equality defines what every `useRuntime` consumer
    // observes, and a repaint-less change would leave a stale attempt view.
    const failed = (failure: RuntimeAuthorizationFailure): RuntimeSnapshot =>
      snapshot({
        servers: { alpha: view({ authorization: { id: 'attempt-1', phase: 'failed', failure } }) },
      })
    expect(runtimeSnapshotsEqual(failed('timeout'), failed('cleanup'))).toBe(false)
    expect(runtimeSnapshotsEqual(failed('timeout'), failed('timeout'))).toBe(true)
    // Present vs absent failure is a difference too.
    expect(
      runtimeSnapshotsEqual(
        failed('timeout'),
        snapshot({ servers: { alpha: view({ authorization: { id: 'attempt-1', phase: 'failed' } }) } }),
      ),
    ).toBe(false)
  })

  it('detects attempt-view and error-code changes and a same-count key swap', () => {
    const withView = (authorization: NonNullable<ServerRuntimeView['authorization']>): RuntimeSnapshot =>
      snapshot({ servers: { alpha: view({ authorization }) } })
    expect(
      runtimeSnapshotsEqual(
        withView({ id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://as.test/a' }),
        withView({ id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://as.test/b' }),
      ),
    ).toBe(false)
    expect(
      runtimeSnapshotsEqual(
        withView({ id: 'attempt-1', phase: 'starting' }),
        withView({ id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://as.test/a' }),
      ),
    ).toBe(false)
    // An attempt view on only ONE side is a difference, even with the same phase.
    const one = snapshot({ servers: { alpha: view() } })
    const other = snapshot({ servers: { alpha: view({ authorization: { id: 'x', phase: 'failed' } }) } })
    expect(runtimeSnapshotsEqual(one, other)).toBe(false)
    expect(
      runtimeSnapshotsEqual(snapshot(), snapshot({ servers: { beta: view({ name: 'beta' }) } })),
    ).toBe(false)
    expect(
      runtimeSnapshotsEqual(
        snapshot({ servers: { alpha: view({ error: { code: 'timeout' } }) } }),
        snapshot({ servers: { alpha: view({ error: { code: 'protocol' } }) } }),
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

  it('maps every runtime phase to its locale key and tone — exhaustive', () => {
    const expected: [RuntimePhase, string, string][] = [
      ['connected', 'status.connected', 'ok'],
      ['connecting', 'status.connecting', 'warn'],
      ['reconnecting', 'status.reconnecting', 'warn'],
      ['waiting-credentials', 'status.waitingCredentials', 'warn'],
      ['waiting-authorization', 'status.waitingAuthorization', 'warn'],
      ['failed', 'status.failed', 'error'],
      ['stopped', 'status.stopped', 'idle'],
      ['disabled', 'status.disabled', 'idle'],
      ['unknown', 'status.unknown', 'idle'],
    ]
    for (const [phase, key, tone] of expected) {
      expect(statusKeyOf(phase), phase).toBe(key)
      expect(statusToneOf(phase), phase).toBe(tone)
    }
  })

  it('maps the five authorization reasons and the active/terminal attempt phases', () => {
    const reasons: [RuntimeAuthorizationReason, string][] = [
      ['missing', 'auth.reason.missing'],
      ['expired', 'auth.reason.expired'],
      ['binding', 'auth.reason.binding'],
      ['rejected', 'auth.reason.rejected'],
      ['scope', 'auth.reason.scope'],
    ]
    for (const [reason, key] of reasons) expect(authorizationReasonKey(reason), reason).toBe(key)
    const active: RuntimeAuthorizationPhase[] = ['starting', 'waiting-browser', 'exchanging', 'committing']
    const terminal: RuntimeAuthorizationPhase[] = ['authorized', 'cancelled', 'failed']
    for (const phase of active) expect(isAuthorizationActive(phase), phase).toBe(true)
    for (const phase of terminal) expect(isAuthorizationActive(phase), phase).toBe(false)
  })

  it('maps every fixed wire error code and falls back for unknown ones', () => {
    const codes: RuntimeErrorCode[] = [
      'gave-up',
      'reconnect-disabled',
      'generation-stuck',
      'forbidden',
      'timeout',
      'spawn-failed',
      'protocol',
      'connection-failed',
      'load',
      'cleanup',
      'conflict',
      'config',
      'seam',
      'invalid-credential',
    ]
    for (const code of codes) expect(runtimeErrorKey(code), code).toBe('runtime.error.' + code)
    // Action business failures are localized too (the section banner maps them).
    for (const code of [
      'bad-request',
      'not-found',
      'not-connected',
      'disabled',
      'oauth-unavailable',
      'oauth-failed',
      'oauth-cleanup',
      'internal',
    ]) {
      expect(runtimeErrorKey(code), code).toBe('runtime.error.' + code)
    }
    expect(runtimeErrorKey('some-future-code')).toBeUndefined()
    // Prototype members never resolve as code keys.
    expect(runtimeErrorKey('toString')).toBeUndefined()

    const t: TextSeat = (key) => 't:' + key
    expect(runtimeErrorText(t, { code: 'timeout' })).toBe('t:runtime.error.timeout')
    expect(runtimeErrorText(t, { code: 'future', message: 'host fallback' })).toBe('host fallback')
    expect(runtimeErrorText(t, { code: 'future' })).toBe('t:runtime.error')
  })

  it('needs attention for failed and both waiting phases, never for stopped/disabled', () => {
    for (const phase of ['failed', 'waiting-credentials', 'waiting-authorization'] as RuntimePhase[]) {
      expect(needsAttention(phase), phase).toBe(true)
    }
    const quiet: (RuntimePhase | undefined)[] = ['connected', 'connecting', 'reconnecting', 'stopped', 'disabled', 'unknown', undefined]
    for (const phase of quiet) expect(needsAttention(phase), String(phase)).toBe(false)
  })

  it('lists only detached (configured:false) rows in host order', () => {
    const runtime = snapshot({
      servers: {
        live: view({ name: 'live' }),
        gone: view({ name: 'gone', configured: false, phase: 'failed', error: { code: 'cleanup' } }),
        alsoGone: view({ name: 'alsoGone', configured: false, phase: 'stopped' }),
      },
    })
    expect(detachedRuntimeViews(runtime).map((entry) => entry.name)).toEqual(['gone', 'alsoGone'])
  })
})

describe('document projections', () => {
  it('collects the credential refs of one row including template refs', () => {
    const templateRow: ServerDef = {
      serverName: 'templated',
      transport: 'stdio',
      command: 'run',
      args: ['--token', '${credential:ARG_TOKEN}'],
      env: { EXTRA: '${credential:ENV_TOKEN}' },
      // The env map wins over the legacy envKeys container (adapter-emission
      // rule): the ignored legacy ref must not appear in the browser ref views.
      envKeys: ['LEGACY_TOKEN'],
    }
    expect(credentialRefsOf(templateRow)).toEqual(['ARG_TOKEN', 'ENV_TOKEN'])
    expect(serversUsingRef({ ...doc(), servers: [templateRow] }, 'ARG_TOKEN')).toEqual(['templated'])
    expect(serversUsingRef({ ...doc(), servers: [templateRow] }, 'LEGACY_TOKEN')).toEqual([])
  })

  it('finds the refs one server owns but no other server references', () => {
    const target: ServerDef = {
      serverName: 'beta',
      transport: 'stdio',
      command: 'node',
      env: { BETA: '${credential:BETA_TOKEN}' },
      envKeys: ['SHARED'],
    }
    const document: McpScopeDoc = { servers: [stdio('alpha', ['SHARED']), target], overrides: {}, disabled: {} }
    expect(orphanedRefsOf(document, 'beta')).toEqual(['BETA_TOKEN'])
    expect(orphanedRefsOf(document, 'missing')).toEqual([])
  })

  it('lists the servers one workspace explicitly enables and whether a server is in use', () => {
    const d = doc()
    expect(enabledServerNames(d, 'ws-1')).toEqual(['alpha'])
    expect(enabledServerNames(d, 'ws-2')).toEqual(['beta'])
    expect(enabledServerNames(d, 'ws-3')).toEqual([])
    expect(isServerInUse(d, d.servers[0]!, ['ws-1'])).toBe(true)
    expect(isServerInUse(d, d.servers[1]!, ['ws-1'])).toBe(false)
    const disabled: McpScopeDoc = { ...d, disabled: { alpha: true } }
    expect(isServerInUse(disabled, d.servers[0]!, ['ws-1'])).toBe(false)
  })

  it('formats a clock label and tolerates a missing timestamp', () => {
    expect(typeof clockOf(1_700_000_000_000)).toBe('string')
    expect(clockOf(undefined)).toBeUndefined()
  })
})
