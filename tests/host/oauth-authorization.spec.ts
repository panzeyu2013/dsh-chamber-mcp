/**
 * OAuth host module unit + integration suite: credential keys, wire/redaction
 * mapping, the owner wrapper, the registry (refusals, staleness, the sign-out
 * ordering) and the manager integration (lazy seat provisioning for disabled
 * OAuth rows, stale-seat retirement, status projection, probe classification and
 * the route-facing actions).
 *
 * No real upstream host is needed here: the owner/registry are exercised
 * against a structural fake host/owner, and the manager against a fake seat
 * (including the LAZY seat provisioning of globally disabled OAuth rows). The
 * real browser flow is covered by {@link ./oauth-acceptance.spec.ts}.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, parseCredentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  McpCloseResult,
  McpConnectionStatus,
  McpOAuthAttemptId,
  McpOAuthAttemptView,
  McpOAuthAuthorization,
  McpProbeResult,
} from '@deepseek-ai/dsh-mcp-client'
import type { AgentApplier } from '../../src/agents.ts'
import { createManager, RuntimeActionError, type ManagerHandle } from '../../src/manager.ts'
import {
  MCP_SCOPE_ACTION_PATH,
  type RuntimeAuthorizationView,
  type RuntimeStatusView,
} from '../../src/shared/wire.ts'
import {
  OAUTH_ACTION_MESSAGES,
  OAuthActionError,
  createOAuthOwner,
  createOAuthRegistry,
  effectiveCredentialKey,
  oauthDefinitionOf,
  translateOwnerFailure,
  wireAttempt,
  wireAttemptFailure,
  wireAttemptPhase,
  type OAuthLifecyclePort,
  type OAuthRegistry,
  type ResolvedOAuthBinding,
} from '../../src/oauth-authorization.ts'
import { wireAuthorizationReason } from '../../src/status.ts'
import { deriveCredentialKey, toUpstreamConfigInput } from '../../src/host-config.ts'
import { registerMcpScopeRoutes } from '../../src/routes.ts'
import type { McpScopeDoc, ServerDef, StreamableHttpServerDef } from '../../src/shared/model.ts'
import type { OAuthAttemptView } from '../../src/shared/oauth.ts'
import type { McpClientHostLike } from '../../src/upstream.ts'
import { FakeHost, FakeSeat } from '../support/fake-seat.js'

/** Server name used by the key pins and the manager fixtures. */
const SERVER_NAME = 'oauth-unit'

/** The derived credential key of {@link SERVER_NAME} (the manager's binding key). */
const SERVER_KEY = deriveCredentialKey(SERVER_NAME)

/** Logger double capturing host-side diagnostics. */
function testLogger(): { lines: string[]; info(message: string): void; warn(message: string): void; error(message: string): void } {
  const lines: string[] = []
  return {
    lines,
    info: (message) => void lines.push('info: ' + message),
    warn: (message) => void lines.push('warn: ' + message),
    error: (message) => void lines.push('error: ' + message),
  }
}

/** Poll one value until accepted (bounded). */
async function waitFor<T>(read: () => T | undefined, accept: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined && accept(value)) return value
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error('timed out waiting for ' + what)
}

/** A promise plus its resolvers (deferred lifecycle work). */
function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// Fake upstream host / owner
// ---------------------------------------------------------------------------

/** Construction options of {@link FakeOwner}. */
interface FakeOwnerOptions {
  /** Value `start()` returns (default: a `starting` view). */
  startView?: McpOAuthAttemptView
  /** Error `start()` rejects with. */
  startError?: unknown
  /** Result `dispose()` returns (default: confirmed). */
  disposeResult?: McpCloseResult
  /** Error `dispose()` rejects with. */
  disposeError?: unknown
  /** Error `cancel()` rejects with. */
  cancelError?: unknown
}

/** Structural double of the upstream `McpOAuthAuthorization`. */
class FakeOwner {
  view: McpOAuthAttemptView | undefined
  starts = 0
  cancels: string[] = []
  retires = 0
  disposals = 0
  readonly options: FakeOwnerOptions

  constructor(options: FakeOwnerOptions = {}) {
    this.options = options
  }

  current(): McpOAuthAttemptView | undefined {
    return this.view
  }

  async start(): Promise<McpOAuthAttemptView> {
    this.starts += 1
    if (this.options.startError !== undefined) throw this.options.startError
    this.view ??= this.options.startView ?? attemptView({ phase: 'starting' })
    return this.view
  }

  retire(): void {
    this.retires += 1
    this.retiredResult = true
  }

  retiredResult = false

  async cancel(id: string): Promise<void> {
    this.cancels.push(id)
    if (this.options.cancelError !== undefined) throw this.options.cancelError
    if (this.view?.id === id) this.view = { ...this.view, phase: 'cancelled' }
  }

  async dispose(): Promise<McpCloseResult> {
    this.disposals += 1
    if (this.options.disposeError !== undefined) throw this.options.disposeError
    return this.options.disposeResult ?? { closeConfirmed: true }
  }
}

/**
 * One SHARED-KIT fake host whose authorization verb creates recorded owner
 * doubles. The owner double is the registry's concern (this suite's FakeOwner);
 * the seat/host contract itself lives in tests/support/fake-seat.ts.
 */
function fakeHost(options: FakeOwnerOptions = {}): { host: FakeHost; created: FakeOwner[] } {
  const created: FakeOwner[] = []
  const host = new FakeHost({
    authorization: () => {
      const owner = new FakeOwner(options)
      created.push(owner)
      return owner as unknown as McpOAuthAuthorization
    },
  })
  return { host, created }
}

/** Build the one wire attempt view of these tests. */
function attemptView(fields: Partial<McpOAuthAttemptView> & { phase: McpOAuthAttemptView['phase'] }): McpOAuthAttemptView {
  return { id: 'attempt-1' as unknown as McpOAuthAttemptId, ...fields } as McpOAuthAttemptView
}

/** One streamable-http OAuth row of the document. */
function httpDef(oauth: StreamableHttpServerDef['oauth'] = {}): StreamableHttpServerDef {
  return {
    serverName: SERVER_NAME,
    transport: 'streamable-http',
    url: 'http://127.0.0.1:1/mcp',
    headers: [],
    oauth,
  }
}

/** The resolved OAuth binding of one row over a fake host (real host-config adapter). */
function bindingOf(host: FakeHost, def: StreamableHttpServerDef = httpDef()): ResolvedOAuthBinding {
  const input = toUpstreamConfigInput(def, new Set())
  const resolved = host.validate(input, ['servers', def.serverName])
  if (resolved.transport !== 'streamable-http' || resolved.oauth === undefined) {
    throw new Error('the fixture definition must resolve to an OAuth streamable-http config')
  }
  return {
    serverName: def.serverName,
    host: host as unknown as McpClientHostLike,
    config: resolved as ResolvedOAuthBinding['config'],
    fingerprint: JSON.stringify(def),
  }
}

/** A root context that only exposes the two browser-authorization services. */
function browserContext(withServices = true): Context {
  const ctx = new Context()
  if (withServices) {
    ctx.provide('authorization', {})
    ctx.provide('webServer', { getOrigin: () => 'http://127.0.0.1:41888' })
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Credential keys
// ---------------------------------------------------------------------------

describe('credential keys', () => {
  it('derives a valid namespaced key for arbitrary server names', () => {
    for (const name of ['alpha', 'GitHub', 'My_Server', 'a', 'x-1', 'a'.repeat(32)]) {
      const key = deriveCredentialKey(name)
      expect(String(key)).toMatch(/^mcp-client\/[a-z][a-z0-9-]*$/)
      expect(() => parseCredentialKey(String(key))).not.toThrow()
      const row: StreamableHttpServerDef = { ...httpDef(), serverName: name }
      const oauthRow = oauthDefinitionOf(row)
      expect(oauthRow).toBeDefined()
      if (oauthRow !== undefined) expect(String(effectiveCredentialKey(oauthRow))).toBe(String(key))
    }
  })

  it('pins the documented derived keys', () => {
    expect(String(deriveCredentialKey('alpha'))).toBe('mcp-client/mcp-scope-8ed3f6ad685b959e')
    expect(String(deriveCredentialKey('GitHub'))).toBe('mcp-client/mcp-scope-f911e414cf6bdfc5')
    expect(String(deriveCredentialKey('My_Server'))).toBe('mcp-client/mcp-scope-7115d58347ed501b')
  })

  it('keeps an explicit valid key and re-validates it with the credentials parser', () => {
    const explicit = httpDef({ credentialKey: 'mcp-client/custom-id' })
    expect(String(effectiveCredentialKey(oauthDefinitionOf(explicit) as NonNullable<ReturnType<typeof oauthDefinitionOf>>)))
      .toBe('mcp-client/custom-id')
    const invalid = httpDef({ credentialKey: 'Not/A/Key!' })
    expect(() => effectiveCredentialKey(oauthDefinitionOf(invalid) as NonNullable<ReturnType<typeof oauthDefinitionOf>>)).toThrow()
  })

  it('narrows only http rows with an OAuth block (never stdio)', () => {
    expect(oauthDefinitionOf(undefined)).toBeUndefined()
    const stdio: ServerDef = { serverName: 's', transport: 'stdio', command: 'node' }
    expect(oauthDefinitionOf(stdio)).toBeUndefined()
    const plainHttp: ServerDef = { serverName: 'h', transport: 'streamable-http', url: 'http://127.0.0.1/mcp' }
    expect(oauthDefinitionOf(plainHttp)).toBeUndefined()
    expect(oauthDefinitionOf(httpDef())).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------

describe('wire mapping', () => {
  it('maps the five upstream authorization reasons and drops unknown ones', () => {
    for (const reason of ['missing', 'expired', 'binding', 'rejected', 'scope'] as const) {
      expect(wireAuthorizationReason(reason)).toBe(reason)
    }
    expect(wireAuthorizationReason('future-reason')).toBeUndefined()
    expect(wireAuthorizationReason(undefined)).toBeUndefined()
    expect(wireAuthorizationReason(42)).toBeUndefined()
  })

  it('publishes the authorization page only while waiting-browser, and only for HTTPS/loopback HTTP', () => {
    expect(wireAttempt(attemptView({ phase: 'waiting-browser', authorizationUrl: 'https://as.example/authorize?state=1' })))
      .toMatchObject({ phase: 'waiting-browser', authorizationUrl: 'https://as.example/authorize?state=1' })
    expect(wireAttempt(attemptView({ phase: 'waiting-browser', authorizationUrl: 'http://127.0.0.1:9/a' })))
      .toMatchObject({ authorizationUrl: 'http://127.0.0.1:9/a' })
    // Plain HTTP outside loopback is the official host's own refusal, mirrored here.
    expect(wireAttempt(attemptView({ phase: 'waiting-browser', authorizationUrl: 'http://as.example/a' }))?.authorizationUrl)
      .toBeUndefined()
    expect(wireAttempt(attemptView({ phase: 'waiting-browser', authorizationUrl: 'javascript:alert(1)' }))?.authorizationUrl)
      .toBeUndefined()
    expect(wireAttempt(attemptView({ phase: 'waiting-browser', authorizationUrl: 'https://as.example/' + 'x'.repeat(4096) }))?.authorizationUrl)
      .toBeUndefined()
    // The URL is stripped from every other phase.
    expect(wireAttempt(attemptView({ phase: 'starting', authorizationUrl: 'https://as.example/a' }))?.authorizationUrl)
      .toBeUndefined()
    expect(wireAttempt(attemptView({ phase: 'exchanging', authorizationUrl: 'https://as.example/a' }))?.authorizationUrl)
      .toBeUndefined()
  })

  it('whitelists failed-attempt text into fixed failure codes and never forwards it', () => {
    expect(wireAttemptFailure('MCP OAuth authorization timed out')).toBe('timeout')
    expect(wireAttemptFailure('MCP OAuth cleanup did not settle')).toBe('cleanup')
    expect(wireAttemptFailure('MCP OAuth requires authorization: rejected')).toBe('rejected')
    expect(wireAttemptFailure('MCP OAuth verifier is unavailable')).toBe('failed')
    expect(wireAttemptFailure('secret=super-secret-value failed')).toBe('failed')
    expect(wireAttemptFailure(undefined)).toBeUndefined()
    expect(wireAttemptFailure('')).toBeUndefined()
    const wired = wireAttempt(attemptView({ phase: 'failed', lastError: 'MCP OAuth request failed: token=TOKEN-LEAK' }))
    expect(wired).toEqual({ id: 'attempt-1', phase: 'failed', failure: 'failed' })
    expect(JSON.stringify(wired)).not.toContain('TOKEN-LEAK')
    expect(JSON.stringify(wired)).not.toContain('lastError')
  })

  it('caps the attempt id and degrades an unknown phase to failed', () => {
    const long = wireAttempt({ id: 'x'.repeat(200) as unknown as McpOAuthAttemptId, phase: 'starting' })
    expect(long?.id.length).toBe(64)
    expect(wireAttemptPhase('future-phase' as McpOAuthAttemptView['phase'])).toBe('failed')
    expect(wireAttempt(attemptView({ phase: 'committing' }))?.phase).toBe('committing')
  })
})

// ---------------------------------------------------------------------------
// Owner wrapper
// ---------------------------------------------------------------------------

describe('owner', () => {
  it('creates the upstream owner lazily once and reuses it for start/current/cancel', async () => {
    const { host, created } = fakeHost()
    const owner = createOAuthOwner({ binding: bindingOf(host), logger: testLogger(), onChanged: () => undefined })
    expect(owner.current()).toBeUndefined()
    expect(host.authorizations).toBe(0)
    await owner.start()
    await owner.start()
    await owner.cancel('attempt-1')
    expect(host.authorizations).toBe(1)
    expect(created[0]?.starts).toBe(2)
    expect(created[0]?.cancels).toEqual(['attempt-1'])
    expect(String(owner.key)).toBe(String(SERVER_KEY))
  })

  it('retires and disposes the upstream owner exactly once, reporting cleanup', async () => {
    const { host, created } = fakeHost()
    const owner = createOAuthOwner({ binding: bindingOf(host), logger: testLogger(), onChanged: () => undefined })
    // Dispose before any attempt is a confirmed no-op and never creates an owner.
    expect(await owner.dispose()).toEqual({ closeConfirmed: true })
    expect(host.authorizations).toBe(0)
    await owner.start()
    owner.retire()
    expect(created[0]?.retires).toBe(1)
    expect(await owner.dispose()).toEqual({ closeConfirmed: true })
    expect(created[0]?.disposals).toBe(1)
  })

  it('maps a cleanup deadline and a generic start failure onto fixed codes', async () => {
    const { host: cleanupHost } = fakeHost({ startError: new Error('MCP OAuth cleanup did not settle') })
    const cleanupOwner = createOAuthOwner({ binding: bindingOf(cleanupHost), logger: testLogger(), onChanged: () => undefined })
    await expect(cleanupOwner.start()).rejects.toMatchObject({ code: 'oauth-cleanup', message: OAUTH_ACTION_MESSAGES['oauth-cleanup'] })

    const { host: failingHost } = fakeHost({ startError: new Error('registerFlow failed: DUPLICATE_FLOW') })
    const failingOwner = createOAuthOwner({ binding: bindingOf(failingHost), logger: testLogger(), onChanged: () => undefined })
    await expect(failingOwner.start()).rejects.toMatchObject({ code: 'oauth-failed' })

    const { host: cancelHost } = fakeHost({ cancelError: new Error('MCP OAuth cleanup failed') })
    const cancelOwner = createOAuthOwner({ binding: bindingOf(cancelHost), logger: testLogger(), onChanged: () => undefined })
    await expect(cancelOwner.cancel('attempt-1')).resolves.toBeUndefined() // no owner yet: no-op
    await cancelOwner.start()
    await expect(cancelOwner.cancel('attempt-1')).rejects.toMatchObject({ code: 'oauth-cleanup' })
  })

  it('reports a throwing dispose as an unconfirmed cleanup and a malformed key as oauth-failed', async () => {
    const { host } = fakeHost({ disposeError: new Error('boom') })
    const owner = createOAuthOwner({ binding: bindingOf(host), logger: testLogger(), onChanged: () => undefined })
    await owner.start()
    expect(await owner.dispose()).toMatchObject({ closeConfirmed: false })
    // A hand-edited document can carry a key the credentials seam refuses; the
    // owner must refuse it with a fixed code instead of throwing a raw TypeError.
    const valid = bindingOf(fakeHost().host)
    const brokenBinding: ResolvedOAuthBinding = {
      ...valid,
      config: { ...valid.config, oauth: { ...valid.config.oauth, credentialKey: 'Not/A/Key' } },
    }
    expect(() => createOAuthOwner({
      binding: brokenBinding,
      logger: testLogger(),
      onChanged: () => undefined,
    })).toThrowError(OAuthActionError)
  })

  it('refuses to create an owner when the upstream host lost its authorization verb', async () => {
    const brokenHost = {} as unknown as McpClientHostLike
    const owner = createOAuthOwner({
      binding: { ...bindingOf(fakeHost().host), host: brokenHost },
      logger: testLogger(),
      onChanged: () => undefined,
    })
    await expect(owner.start()).rejects.toMatchObject({ code: 'oauth-unavailable' })
    expect(translateOwnerFailure(new Error('cleanup exploded'))).toMatchObject({ code: 'oauth-cleanup' })
    expect(translateOwnerFailure(new OAuthActionError('oauth-busy'))).toMatchObject({ code: 'oauth-busy' })
  })
})

// ---------------------------------------------------------------------------
// Registry: refusals, staleness, sign-out ordering
// ---------------------------------------------------------------------------

/** Fake lifecycle port recording the calls and configurable outcomes. */
class FakeLifecycle implements OAuthLifecyclePort {
  readonly order: string[] = []
  readonly unmountResults: boolean[] = []
  fingerprintCalls = 0
  /** Fingerprint returned for every call; a function may return a different value over time. */
  fingerprintValue: string | undefined
  fingerprintSource: (() => string | undefined) | undefined
  wants = true
  /** Deferred exclusive work (busy-latch tests). */
  gate: Promise<void> | undefined

  fingerprintFor = JSON.stringify(httpDef())

  fingerprintOnce(): string | undefined {
    this.fingerprintCalls += 1
    if (this.fingerprintSource !== undefined) return this.fingerprintSource()
    return this.fingerprintValue ?? this.fingerprintFor
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.order.push('exclusive')
    if (this.gate === undefined) return work()
    return this.gate.then(work)
  }

  fingerprint(serverName: string): string | undefined {
    if (serverName !== SERVER_NAME) return undefined
    return this.fingerprintOnce()
  }

  wantsInstance(): boolean {
    return this.wants
  }

  async unmount(_serverName: string): Promise<boolean> {
    this.order.push('unmount')
    const next = this.unmountResults.shift()
    return next ?? true
  }

  mount(): void {
    this.order.push('mount')
  }
}

/** One registry harness: context, doc, binding and the recording fakes. */
interface RegistryHarness {
  ctx: Context
  registry: OAuthRegistry
  lifecycle: FakeLifecycle
  host: FakeHost
  created: FakeOwner[]
  def: StreamableHttpServerDef
  binding: ResolvedOAuthBinding
  setDef(def: StreamableHttpServerDef | undefined): void
  setBinding(binding: ResolvedOAuthBinding | undefined): void
  deleted: CredentialKey[]
  failDelete: boolean
}

/** Build a registry over fakes (services present unless `services` is false). */
function registryHarness(options: { services?: boolean; def?: StreamableHttpServerDef; binding?: boolean } = {}): RegistryHarness {
  const ctx = browserContext(options.services ?? true)
  const def = options.def ?? httpDef()
  const { host, created } = fakeHost()
  const oauthRow = def.transport === 'streamable-http' && def.oauth !== undefined
  const binding = oauthRow ? bindingOf(host, def as StreamableHttpServerDef) : undefined
  const lifecycle = new FakeLifecycle()
  let liveDef: ServerDef | undefined = def
  let liveBinding: ResolvedOAuthBinding | undefined = options.binding === false ? undefined : binding
  const deleted: CredentialKey[] = []
  const state = {
    failDelete: false,
  }
  const logger = testLogger()
  const registry = createOAuthRegistry({
    ctx,
    logger,
    credentials: {
      deleteRecord: async (key) => {
        deleted.push(key)
        if (state.failDelete) throw new Error('record deletion failed')
      },
    },
    getDoc: (): McpScopeDoc => ({ servers: liveDef === undefined ? [] : [liveDef], overrides: {} }),
    bindings: { get: () => liveBinding },
    lifecycle,
  })
  return {
    ctx,
    registry,
    lifecycle,
    host,
    created,
    def: binding === undefined ? httpDef() : def as StreamableHttpServerDef,
    binding: binding as ResolvedOAuthBinding,
    setDef: (next) => {
      liveDef = next
    },
    setBinding: (next) => {
      liveBinding = next
    },
    deleted,
    get failDelete() {
      return state.failDelete
    },
    set failDelete(value: boolean) {
      state.failDelete = value
    },
  }
}

describe('registry', () => {
  it('refuses authorize with oauth-not-configured / oauth-unavailable', async () => {
    const plain = registryHarness({ def: { serverName: SERVER_NAME, transport: 'streamable-http', url: 'http://127.0.0.1/mcp' } })
    await expect(plain.registry.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-not-configured' })
    await expect(plain.registry.authorize('absent')).rejects.toMatchObject({ code: 'oauth-not-configured' })

    const unbound = registryHarness({ binding: false })
    await expect(unbound.registry.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-unavailable' })

    const headless = registryHarness({ services: false })
    await expect(headless.registry.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-unavailable' })
    expect(headless.registry.available()).toBe(false)
  })

  it('caches one owner per binding and drops the view when the fingerprint changes', async () => {
    const harness = registryHarness()
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
    await harness.registry.authorize(SERVER_NAME)
    expect(harness.host.authorizations).toBe(1)
    expect(harness.registry.attemptView(SERVER_NAME)?.phase).toBe('starting')

    // Same fingerprint: the cached owner is reused, never a second host owner.
    await harness.registry.authorize(SERVER_NAME)
    expect(harness.host.authorizations).toBe(1)

    // A changed definition invalidates the cached view immediately.
    harness.setBinding({ ...harness.binding, fingerprint: 'changed' })
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
    await harness.registry.authorize(SERVER_NAME)
    expect(harness.host.authorizations).toBe(2)
    expect(harness.created[0]?.retires).toBe(1)
    expect(harness.created[0]?.disposals).toBe(1)

    // A vanished binding never serves the stale owner's view.
    harness.setBinding(undefined)
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
  })

  it('authorizes a globally disabled OAuth row (the document is the authority)', async () => {
    const harness = registryHarness()
    // The registry only reads the document row: the global off-switch gates the
    // instance mount (manager), never the explicit authorization.
    const def = harness.def
    harness.setDef(def)
    const view = await harness.registry.authorize(SERVER_NAME)
    expect(view.phase).toBe('starting')
    expect(harness.registry.attemptView(SERVER_NAME)?.phase).toBe('starting')
  })

  it('serializes sign-out and refuses authorize/cancel while it runs', async () => {
    const harness = registryHarness()
    await harness.registry.authorize(SERVER_NAME)
    const gate = deferred()
    harness.lifecycle.gate = gate.promise
    const signingOut = harness.registry.signOut(SERVER_NAME)
    // The sign-out is waiting inside the exclusive section (never inside a
    // second enqueue, which would deadlock the real mutation chain).
    expect(harness.registry.attemptView(SERVER_NAME)?.phase).toBe('starting')
    await expect(harness.registry.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-busy' })
    await expect(harness.registry.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-busy' })
    gate.resolve()
    await signingOut
    expect(harness.lifecycle.order).toContain('unmount')
  })

  it('signs out in the upstream order: retire → dispose → unmount → deleteRecord → mount', async () => {
    const harness = registryHarness()
    await harness.registry.authorize(SERVER_NAME)
    const owner = harness.created[0] as FakeOwner
    let retiredWhenUnmounted: boolean | undefined
    const originalUnmount = harness.lifecycle.unmount.bind(harness.lifecycle)
    harness.lifecycle.unmount = async (serverName: string) => {
      retiredWhenUnmounted = owner.retiredResult
      return await originalUnmount(serverName)
    }
    await harness.registry.signOut(SERVER_NAME)
    expect(retiredWhenUnmounted).toBe(true)
    expect(owner.disposals).toBe(1)
    expect(harness.lifecycle.order).toEqual(['exclusive', 'unmount', 'mount'])
    expect(harness.deleted).toEqual([SERVER_KEY])
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
  })

  it('keeps the grant and refuses the remount when owner cleanup is unconfirmed', async () => {
    const harness = registryHarness()
    // The owner is created with the default confirmed dispose; force the failure.
    await harness.registry.authorize(SERVER_NAME)
    const owner = harness.created[0] as FakeOwner
    owner.options.disposeResult = { closeConfirmed: false, cleanupError: 'MCP OAuth cleanup did not settle' }
    await expect(harness.registry.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-cleanup' })
    expect(harness.lifecycle.order).not.toContain('unmount')
    expect(harness.lifecycle.order).not.toContain('mount')
    expect(harness.deleted).toEqual([])
  })

  it('aborts sign-out when the definition changed before the deletion', async () => {
    const harness = registryHarness()
    await harness.registry.authorize(SERVER_NAME)
    let calls = 0
    harness.lifecycle.fingerprintSource = () => {
      calls += 1
      // First call is the snapshot; the next ones see a changed definition.
      return calls === 1 ? harness.lifecycle.fingerprintFor : 'changed'
    }
    await expect(harness.registry.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-failed' })
    expect(harness.lifecycle.order).not.toContain('unmount')
    expect(harness.deleted).toEqual([])
  })

  it('signs out a disabled/never-mounted row from the live document and remounts', async () => {
    const harness = registryHarness()
    // No authorize: no owner, no binding — sign-out still works from the doc.
    harness.setBinding(undefined)
    await harness.registry.signOut(SERVER_NAME)
    expect(harness.lifecycle.order).toEqual(['exclusive', 'unmount', 'mount'])
    expect(harness.deleted).toEqual([SERVER_KEY])
  })

  it('maps a deleteRecord failure to oauth-failed and still remounts', async () => {
    const harness = registryHarness()
    harness.failDelete = true
    await expect(harness.registry.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-failed' })
    expect(harness.lifecycle.order).toEqual(['exclusive', 'unmount', 'mount'])
    expect(harness.deleted).toEqual([SERVER_KEY])
  })

  it('keeps the grant when the instance unmount is unconfirmed', async () => {
    const harness = registryHarness()
    harness.lifecycle.unmountResults.push(false)
    await expect(harness.registry.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-cleanup' })
    expect(harness.deleted).toEqual([])
    expect(harness.lifecycle.order).not.toContain('mount')
  })

  it('disposes every cached owner on teardown', async () => {
    const harness = registryHarness()
    await harness.registry.authorize(SERVER_NAME)
    await harness.registry.disposeAll()
    expect(harness.created[0]?.retires).toBe(1)
    expect(harness.created[0]?.disposals).toBe(1)
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Manager integration: seat provisioning, status projection, probe, sign-out
// ---------------------------------------------------------------------------

/**
 * Per-test activation knobs this suite maps onto the SHARED fake seat
 * (`tests/support/fake-seat.ts`). T2: the suite keeps no second seat/host
 * double; only the owner double stays local (the registry's concern).
 */
interface BootSeatOptions {
  /** Initial instance status (default: waiting-authorization/missing). */
  status?: McpConnectionStatus
  /** Rejection reason of `instance.ready` (activation failure). */
  readyError?: unknown
  /** Probe outcome the manual test action observes. */
  probeResult?: McpProbeResult
  /** Options of every owner the seat host creates. */
  owner?: FakeOwnerOptions
}

/** One booted manager harness. */
interface ManagerHarness {
  manager: ManagerHandle
  seats: FakeSeat[]
  owners: FakeOwner[]
  events: string[]
  deleted: CredentialKey[]
  credentials: { failDelete: boolean }
  setDoc(next: McpScopeDoc): void
  flush(): Promise<void>
}

/** Boot a bridge manager over a fake seat factory and fake services. */
async function bootManager(options: {
  doc?: McpScopeDoc
  services?: boolean
  seat?: BootSeatOptions
  /** First seat creation throws once (the F1 failed-lazy-provisioning pin). */
  seatErrorOnce?: unknown
} = {}): Promise<ManagerHarness> {
  const ctx = new Context()
  const events: string[] = []
  const deleted: CredentialKey[] = []
  const credentialState = { failDelete: false }
  ctx.provide('credentials', {
    async resolve() { return undefined },
    async describe() { return { configured: false, writable: true } },
    async set() { throw new Error('not used') },
    async unset() {},
    async readRecord() { return undefined },
    async describeRecord() { return { configured: false, writable: true } },
    async listRecords() { return [] },
    async modifyRecord() { return undefined },
    async deleteRecord(key: CredentialKey) {
      if (credentialState.failDelete) throw new Error('record deletion failed')
      deleted.push(key)
      events.push('delete')
    },
  } as unknown as CredentialProvider)
  if (options.services ?? true) {
    ctx.provide('authorization', {})
    ctx.provide('webServer', { getOrigin: () => 'http://127.0.0.1:41888' })
  }
  let doc: McpScopeDoc = options.doc ?? { servers: [httpDef()], overrides: {} }
  const seats: FakeSeat[] = []
  const owners: FakeOwner[] = []
  let pendingSeatError = options.seatErrorOnce
  const applier: AgentApplier = {
    syncServerState() {},
    removeServer() {},
    admit() {
      return () => undefined
    },
    isApplied() {
      return false
    },
    reconcile() {},
    dispose() {},
  }
  const manager = createManager({
    ctx,
    logger: testLogger(),
    getDoc: () => doc,
    applier,
    seatFactory: async (deps) => {
      // The F1 pin throws ONCE from the first lazy provisioning attempt.
      if (pendingSeatError !== undefined) {
        const error = pendingSeatError
        pendingSeatError = undefined
        throw error
      }
      const knobs = options.seat ?? {}
      // Every manager test drives the activation continuation through the fake's
      // immediate settlement: the instance settles ready with the given (or
      // default) status, so no test owns a ready deferred.
      const ownerOptions = knobs.owner ?? {
        startView: attemptView({ phase: 'waiting-browser', authorizationUrl: 'https://as.example/authorize?state=1' }),
      }
      const seat = new FakeSeat(
        deps.serverName,
        deps.epoch,
        {
          readyStatus: knobs.status ?? { state: 'waiting-authorization', reason: 'missing', lastError: '' },
          ...(knobs.readyError === undefined ? {} : { readyError: knobs.readyError }),
          ...(knobs.probeResult === undefined ? {} : { probeResult: knobs.probeResult }),
          events,
          authorization: () => {
            const owner = new FakeOwner(ownerOptions)
            owners.push(owner)
            return owner as unknown as McpOAuthAuthorization
          },
        },
        deps.onCaptureChanged,
      )
      seats.push(seat)
      return seat
    },
  })
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    }
  }
  return {
    manager,
    seats,
    owners,
    events,
    deleted,
    credentials: {
      get failDelete() {
        return credentialState.failDelete
      },
      set failDelete(value: boolean) {
        credentialState.failDelete = value
      },
    },
    setDoc: (next) => {
      doc = next
    },
    flush,
  }
}

describe('manager integration', () => {
  it('authorizes a globally disabled OAuth row lazily: no seat before the action, mount gated', async () => {
    const harness = await bootManager({
      doc: { servers: [httpDef()], overrides: {}, disabled: { [SERVER_NAME]: true } },
    })
    harness.manager.reconcile()
    await harness.flush()
    // H1: reconcile MUST NOT provision a seat + private host for a globally
    // disabled OAuth row (the old eager branch cost one child fiber + host per
    // row); the authorize action provisions it on demand.
    expect(harness.seats).toHaveLength(0)
    expect(harness.manager.runtimeStatus(SERVER_NAME).servers[0]?.phase).toBe('disabled')

    const result = await harness.manager.authorize(SERVER_NAME)
    expect(result.name).toBe(SERVER_NAME)
    expect(result.authorization?.phase).toBe('waiting-browser')
    expect(result.authorization?.authorizationUrl).toContain('https://as.example/authorize')
    // The action provisioned the seat lazily (and created its one owner)...
    expect(harness.seats.length).toBe(1)
    expect(harness.seats[0]?.host.authorizations).toBe(1)
    // ...and no instance was mounted.
    expect(harness.seats[0]?.mounts).toBe(0)
    const status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('disabled')
    expect(status?.authorization?.phase).toBe('waiting-browser')
    await harness.manager.dispose()
  })

  // F1 (Round A): a FAILED lazy provisioning used to poison rec.loadError, and
  // reconcile skips a never-mounted row that carries that marker — so a later
  // successful authorize + enable stayed failed{load} forever (only an explicit
  // connect recovered). The marker is now cleared by a successful provision.
  it('clears a FAILED lazy provisioning marker on a later success so enable mounts (F1)', async () => {
    const harness = await bootManager({
      doc: { servers: [httpDef()], overrides: {}, disabled: { [SERVER_NAME]: true } },
      seatErrorOnce: new Error('transient provisioning failure'),
    })
    harness.manager.reconcile()
    await harness.flush()
    expect(harness.seats).toHaveLength(0)

    // The first authorize fails while lazily provisioning: the record is left
    // with an activation-failure marker (hidden by the disabled phase).
    await expect(harness.manager.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-unavailable' })
    expect(harness.seats).toHaveLength(0)
    expect(harness.manager.runtimeStatus(SERVER_NAME).servers[0]?.phase).toBe('disabled')

    // A later SUCCESSFUL authorize must clear that marker: otherwise the record
    // stays failed{load} and reconcile skips it even when the row is enabled.
    const authorized = await harness.manager.authorize(SERVER_NAME)
    expect(authorized.authorization?.phase).toBe('waiting-browser')
    expect(harness.seats).toHaveLength(1)

    // Enabling the row now mounts the SAME lazily provisioned seat on reconcile:
    // no explicit connect, no false activation failure.
    harness.setDoc({ servers: [httpDef()], overrides: {} })
    harness.manager.reconcile()
    await harness.flush()
    const status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('waiting-authorization')
    expect(status?.error).toBeUndefined()
    expect(harness.seats).toHaveLength(1)
    expect(harness.seats[0]?.instances).toHaveLength(1)
    await harness.manager.dispose()
  })

  it('signs out a globally disabled OAuth row off the document, without provisioning a seat', async () => {
    const harness = await bootManager({
      doc: { servers: [httpDef()], overrides: {}, disabled: { [SERVER_NAME]: true } },
    })
    harness.manager.reconcile()
    await harness.flush()
    expect(harness.seats).toHaveLength(0)
    // Sign-out only reads the document and deletes the grant: it needs no seat,
    // host or instance for a row that was never authorized.
    await expect(harness.manager.signOut(SERVER_NAME)).resolves.toMatchObject({ name: SERVER_NAME })
    expect(harness.deleted).toEqual([SERVER_KEY])
    expect(harness.seats).toHaveLength(0)
    expect(harness.manager.runtimeStatus(SERVER_NAME).servers[0]?.phase).toBe('disabled')
    await harness.manager.dispose()
  })

  it('retires the OAuth owner and disposes the stale seat when a disabled OAuth row switches to stdio', async () => {
    const harness = await bootManager({
      doc: { servers: [httpDef()], overrides: {}, disabled: { [SERVER_NAME]: true } },
    })
    harness.manager.reconcile()
    await harness.flush()
    // No eager seat (H1); the explicit authorization below creates the one seat
    // a disabled row can legitimately hold.
    expect(harness.seats).toHaveLength(0)
    await harness.manager.authorize(SERVER_NAME)
    expect(harness.seats).toHaveLength(1)
    const seat = harness.seats[0]!
    const owner = harness.owners[0]
    expect(owner).toBeDefined()

    // The row becomes a disabled stdio definition (its OAuth block disappears):
    // H2 — the stale seat, private host and cached owner must not outlive it.
    harness.setDoc({
      servers: [{ serverName: SERVER_NAME, transport: 'stdio', command: 'node', args: [] }],
      overrides: {},
      disabled: { [SERVER_NAME]: true },
    })
    harness.manager.reconcile()
    await harness.flush()
    expect(seat.disposeSeatCalls).toBe(1)
    expect(owner?.disposals).toBe(1)
    // The reconcile never re-provisions while disabled...
    expect(harness.seats).toHaveLength(1)
    // ...and the row keeps its document-only disabled projection.
    const status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('disabled')
    expect(status?.authorization).toBeUndefined()
    await harness.manager.dispose()
  })

  it('maps waiting-authorization reasons and the attempt view, never upstream text', async () => {
    const harness = await bootManager({
      seat: {
        status: { state: 'waiting-authorization', reason: 'scope', lastError: 'upstream text SECRET-REASON' },
        owner: { startView: attemptView({ phase: 'failed', lastError: 'MCP OAuth authorization timed out: token=TOKEN-LEAK' }) },
      },
    })
    harness.manager.reconcile()
    await harness.flush()
    let status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('waiting-authorization')
    expect(status?.authReason).toBe('scope')
    expect(JSON.stringify(status)).not.toContain('SECRET-REASON')

    // An unknown/future reason is omitted rather than cast onto the wire union.
    const handle = harness.seats[0]?.instances[0]?.status
    handle?.update({ state: 'waiting-authorization', reason: 'future-reason' as never, lastError: 'upstream text' })
    status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('waiting-authorization')
    expect(status?.authReason).toBeUndefined()

    // A failed attempt carries the whitelisted failure enum only.
    const authorized = await harness.manager.authorize(SERVER_NAME)
    expect(authorized.authorization?.phase).toBe('failed')
    // The action result is typed with the frozen base view; the host projection
    // adds the fixed failure identity (shared/oauth.ts OAuthAttemptView).
    expect((authorized.authorization as OAuthAttemptView | undefined)?.failure).toBe('timeout')
    expect(JSON.stringify(authorized)).not.toContain('TOKEN-LEAK')
    expect(JSON.stringify(authorized)).not.toContain('timed out')
    await harness.manager.dispose()
  })

  it('classifies an OAuth probe failure as oauth-required', async () => {
    const harness = await bootManager({
      seat: {
        readyError: new Error('initial connection failed'),
        probeResult: {
          ok: false,
          stage: 'connect',
          message: 'MCP OAuth requires authorization: missing',
          durationMs: 1,
          closeConfirmed: true,
        },
      },
    })
    harness.manager.reconcile()
    await harness.flush()
    const result = await harness.manager.test(SERVER_NAME)
    expect(result).toMatchObject({ ok: false, stage: 'connect', code: 'oauth-required' })
    await harness.manager.dispose()
  })

  it('signs out in order, deletes the derived key and remounts', async () => {
    const harness = await bootManager()
    harness.manager.reconcile()
    await harness.flush()
    await harness.manager.authorize(SERVER_NAME)
    const owner = harness.owners[0]
    expect(owner).toBeDefined()

    await harness.manager.signOut(SERVER_NAME)
    expect(harness.events).toEqual(['mount', 'unmount', 'delete', 'mount'])
    expect(harness.deleted).toEqual([SERVER_KEY])
    // The sign-out pre-retires (abort a non-committing attempt) and the owner
    // dispose retires again; retire is idempotent upstream.
    expect(owner?.retires).toBeGreaterThanOrEqual(1)
    expect(owner?.disposals).toBe(1)
    // The remounted instance reads no grant and reports waiting-authorization
    // itself (the plugin synthesizes nothing); the stale attempt view is gone.
    const remounted = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(remounted?.phase).toBe('waiting-authorization')
    expect(remounted?.authReason).toBe('missing')
    expect(remounted?.authorization).toBeUndefined()
    await harness.manager.dispose()
  })

  it('keeps the grant and retains failed{cleanup} when owner cleanup is unconfirmed', async () => {
    const harness = await bootManager({ seat: { owner: { disposeResult: { closeConfirmed: false } } } })
    harness.manager.reconcile()
    await harness.flush()
    await harness.manager.authorize(SERVER_NAME)
    await expect(harness.manager.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-cleanup' })
    expect(harness.deleted).toEqual([])
    expect(harness.events).toEqual(['mount'])
    const status = harness.manager.runtimeStatus(SERVER_NAME).servers[0]
    expect(status?.phase).toBe('failed')
    expect(status?.error?.code).toBe('cleanup')
    await harness.manager.dispose()
  })

  it('rejects authorize/cancel/sign-out for unknown and non-OAuth servers', async () => {
    const plain: ServerDef = { serverName: SERVER_NAME, transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', headers: [] }
    const harness = await bootManager({ doc: { servers: [plain], overrides: {} } })
    harness.manager.reconcile()
    await expect(harness.manager.authorize('absent')).rejects.toMatchObject({ code: 'not-found' })
    await expect(harness.manager.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-not-configured' })
    await expect(harness.manager.cancelAuthorization(SERVER_NAME, 'attempt-1')).rejects.toMatchObject({ code: 'oauth-not-configured' })
    await expect(harness.manager.signOut(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-not-configured' })
    await harness.manager.dispose()
  })

  it('answers oauth-unavailable when the browser services are absent (headless)', async () => {
    const harness = await bootManager({ services: false })
    harness.manager.reconcile()
    await expect(harness.manager.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-unavailable' })
    await harness.manager.dispose()
  })

  it('does not lazily provision a disabled OAuth seat when the browser services are absent', async () => {
    const harness = await bootManager({
      services: false,
      doc: { servers: [httpDef()], overrides: {}, disabled: { [SERVER_NAME]: true } },
    })
    harness.manager.reconcile()
    await harness.flush()
    await expect(harness.manager.authorize(SERVER_NAME)).rejects.toMatchObject({ code: 'oauth-unavailable' })
    // The fixed unavailable code short-circuits BEFORE the lazy seat creation.
    expect(harness.seats).toHaveLength(0)
    await harness.manager.dispose()
  })

  it('treats a stale cancel id as a successful no-op', async () => {
    const harness = await bootManager()
    harness.manager.reconcile()
    await harness.flush()
    await harness.manager.authorize(SERVER_NAME)
    await expect(harness.manager.cancelAuthorization(SERVER_NAME, 'stale-attempt')).resolves.toMatchObject({ name: SERVER_NAME })
    expect(harness.owners[0]?.cancels).toEqual(['stale-attempt'])
    await harness.manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Routes: real actions, fixed statuses, no id echo
// ---------------------------------------------------------------------------

/** One registered route dispatch function. */
interface RouteDispatcher {
  path: string
  methods: string[]
  fetch(request: Request): Promise<Response>
}

/** Register the runtime routes over a fake manager and capture the dispatchers. */
async function routeHarness(manager: Partial<ManagerHandle>): Promise<{ dispatch(path: string, body: unknown): Promise<Response>; dispatchers: RouteDispatcher[] }> {
  const ctx = new Context()
  const dispatchers: RouteDispatcher[] = []
  ctx.provide('connection', {
    fetch: {
      register(spec: RouteDispatcher): () => void {
        dispatchers.push(spec)
        return () => undefined
      },
    },
  })
  registerMcpScopeRoutes(ctx, manager as ManagerHandle)
  await waitFor(() => (dispatchers.length === 3 ? dispatchers : undefined), () => true, 'three route dispatchers')
  return {
    dispatchers,
    async dispatch(path, body) {
      const spec = dispatchers.find((entry) => entry.path === path)
      if (spec === undefined) throw new Error('no dispatcher for ' + path)
      return await spec.fetch(new Request('http://host' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
    },
  }
}

describe('routes', () => {
  it('accepts authorize/sign-out and validates the cancel-authorization id', async () => {
    const calls: string[] = []
    const manager: Partial<ManagerHandle> = {
      authorize: async (serverName) => {
        calls.push('authorize:' + serverName)
        return { name: serverName, phase: 'waiting-authorization', authorization: { id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://as.example/a' } }
      },
      cancelAuthorization: async (serverName, id) => {
        calls.push('cancel:' + serverName + ':' + id)
        return { name: serverName, phase: 'waiting-authorization' }
      },
      signOut: async (serverName) => {
        calls.push('signOut:' + serverName)
        return { name: serverName, phase: 'connecting' }
      },
      runtimeStatus: () => ({ v: 1, at: 0, servers: [] }) as RuntimeStatusView,
      toolList: () => undefined,
    }
    const harness = await routeHarness(manager)
    const authorized = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'authorize', server: SERVER_NAME })
    expect(authorized.status).toBe(200)
    expect(authorized.headers.get('cache-control')).toBe('no-store')
    const authorizedBody = await authorized.json() as { ok: boolean; value: { authorization?: RuntimeAuthorizationView } }
    expect(authorizedBody.ok).toBe(true)
    expect(authorizedBody.value.authorization).toMatchObject({ id: 'attempt-1', phase: 'waiting-browser' })

    const cancelled = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'cancel-authorization', server: SERVER_NAME, attemptId: 'attempt-1' })
    expect(cancelled.status).toBe(200)
    const signedOut = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'sign-out', server: SERVER_NAME })
    expect(signedOut.status).toBe(200)
    expect(calls).toEqual(['authorize:' + SERVER_NAME, 'cancel:' + SERVER_NAME + ':attempt-1', 'signOut:' + SERVER_NAME])

    // Missing / malformed ids are 400 and the submitted id is never echoed back.
    const missing = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'cancel-authorization', server: SERVER_NAME })
    expect(missing.status).toBe(400)
    const malformed = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'cancel-authorization', server: SERVER_NAME, attemptId: 'secret-id with space' })
    expect(malformed.status).toBe(400)
    expect(JSON.stringify(await malformed.json())).not.toContain('secret-id')
    const tooLong = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'cancel-authorization', server: SERVER_NAME, attemptId: 'x'.repeat(65) })
    expect(tooLong.status).toBe(400)
  })

  it('maps OAuth business failures onto 409/500 without leaking upstream text', async () => {
    const unavailable: Partial<ManagerHandle> = {
      authorize: async () => {
        throw new RuntimeActionError('oauth-unavailable', OAUTH_ACTION_MESSAGES['oauth-unavailable'])
      },
      runtimeStatus: () => ({ v: 1, at: 0, servers: [] }) as RuntimeStatusView,
      toolList: () => undefined,
    }
    const harness = await routeHarness(unavailable)
    const busy = await harness.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'authorize', server: SERVER_NAME })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ ok: false, error: { code: 'oauth-unavailable' } })

    const failed = await routeHarness({
      signOut: async () => {
        throw new RuntimeActionError('oauth-failed', 'authorization failed')
      },
      runtimeStatus: () => ({ v: 1, at: 0, servers: [] }) as RuntimeStatusView,
      toolList: () => undefined,
    })
    const response = await failed.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'sign-out', server: SERVER_NAME })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'oauth-failed' } })

    const cleanup = await routeHarness({
      signOut: async () => {
        throw new RuntimeActionError('oauth-cleanup', 'the authorization attempt could not be cleaned up')
      },
      runtimeStatus: () => ({ v: 1, at: 0, servers: [] }) as RuntimeStatusView,
      toolList: () => undefined,
    })
    expect((await cleanup.dispatch(MCP_SCOPE_ACTION_PATH, { action: 'sign-out', server: SERVER_NAME })).status).toBe(500)
  })
})
