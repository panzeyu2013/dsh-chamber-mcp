/**
 * OAuth O2 acceptance: the REAL official browser-authorization flow through the
 * private isolated `McpClientHost` a seat owns, against an in-process fake
 * authorization server.
 *
 * This suite proves the parts a unit double cannot:
 * - the flow is registered on the official `AuthorizationService` and the
 *   callback rides the `webserver/request` waterfall at the URL the AS was
 *   given (derived from `authorizationUrl`, never hardcoded);
 * - PKCE S256 is enforced and an upstream-shaped grant record is committed
 *   through the credential seam;
 * - the mounted official instance self-heals on `credentials/record-updated`
 *   (no host-side listener): its status handle moves waiting-authorization →
 *   connected;
 * - cancel is id-matched, a replayed callback answers 410, and sign-out runs
 *   retire → dispose → unmount → deleteRecord → mount, leaving a fresh instance
 *   that reports waiting-authorization again.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import {
  CredentialProvider,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type {
  McpConnectionStatus,
  McpConnectionStatusHandle,
  McpOAuthConfig,
  McpServerInstance,
  StreamableHttpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import type {
  OAuthLifecyclePort,
  OAuthRegistry,
  ResolvedOAuthBinding,
} from '../../src/oauth-authorization.ts'
import { createOAuthRegistry } from '../../src/oauth-authorization.ts'
import { deriveCredentialKey } from '../../src/host-config.ts'
import { createServerSeat, type ServerSeat } from '../../src/server-fiber.ts'
import type { McpScopeDoc, StreamableHttpServerDef } from '../../src/shared/model.ts'
import { loadUpstreamMcpClient, resolveDefinitionConfig } from '../../src/upstream.ts'

/** One fixed server name of this suite (the derived credential key is pinned). */
const SERVER_NAME = 'oauth-acceptance'

/** Origin the fake host webserver reports (the callback URL authority). */
const WEBSERVER_ORIGIN = 'http://127.0.0.1:41888'

/** Poll budget of the asynchronous assertions (local network, generous). */
const WAIT_MS = 15_000

/** Poll period of the asynchronous assertions. */
const POLL_MS = 20

/** Log-safe one-line text for a failing assertion. */
function describeValue(value: unknown): string {
  return JSON.stringify(value)
}

/** Sleep one poll period. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Poll one value until the predicate accepts it (or the budget elapses). */
async function waitFor<T>(read: () => T | undefined, accept: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS
  let last: T | undefined
  while (Date.now() < deadline) {
    last = read()
    if (last !== undefined && accept(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('timed out waiting for ' + what + '; last=' + describeValue(last))
}

/** In-memory credential provider: the REAL seam class, so events/records behave like production. */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<CredentialKey, CredentialRecord>()

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: true }
  }

  async set(): Promise<void> {
    throw new Error('the acceptance suite never writes credential references')
  }

  async unset(): Promise<void> {}

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return record === undefined
      ? { configured: false, writable: true }
      : { configured: true, writable: true, kind: record.kind }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    this.notifyRecordUpdated(key)
    return next ?? this.records.get(key)
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    this.notifyRecordUpdated(key)
  }
}

/** The fake host webserver service: an origin plus the `getOrigin` verb. */
class FakeWebServer extends Service {
  readonly origin: string

  constructor(ctx: Context, origin: string) {
    super(ctx, 'webServer')
    this.origin = origin
  }

  getOrigin(): string {
    return this.origin
  }
}

/** Structural request/response of the `webserver/request` waterfall. */
interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string>
}

/** Structural response the callback listener writes to. */
interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): FakeResponse
  end(body?: string): void
}

/** Minimal response the callback listener can answer. */
function responseSink(): FakeResponse {
  const response: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
      return response
    },
    end(body) {
      response.body = body ?? ''
    },
  }
  return response
}

/** The fake authorization server handle (shape of tests/fixture/oauth-auth-server.mjs). */
interface FakeAuthorizationServer {
  origin: string
  resourceUrl: string
  state: {
    registrations: number
    lastRegistration: { redirect_uris?: string[]; client_name?: string } | undefined
    authorizationRequests: Array<Record<string, string>>
    tokenRequests: Array<Record<string, string>>
    refreshCalls: number
    verifierChecked: boolean
    replayedCodes: number
    mcpCalls: string[]
    acceptedTokens: Set<string>
    codesMinted: number
  }
  simulateConsent(authorizationUrl: string | URL): URL
  simulateDenial(authorizationUrl: string | URL, errorCode?: string): URL
  acceptsToken(token: string): boolean
  close(): Promise<void>
}

/** Minimal shape of the upstream configured client surface used by the seat. */
type ResolvedOAuthConfig = StreamableHttpConfig & { oauth: McpOAuthConfig }

/** One booted acceptance harness. */
interface Harness {
  server: FakeAuthorizationServer
  ctx: Context
  credentials: MemoryCredentials
  seat: ServerSeat
  def: StreamableHttpServerDef
  config: ResolvedOAuthConfig
  binding: ResolvedOAuthBinding
  registry: OAuthRegistry
  key: CredentialKey
  /** Lifecycle call order observed by the fake port. */
  order: string[]
  /** Current live instance (replaced by a sign-out remount). */
  instance(): McpServerInstance | undefined
  /** Current status handle of the mounted instance (waited for the ready handshake). */
  status(): McpConnectionStatus
  /** Dispatch one `webserver/request` waterfall (returns how often `next` ran). */
  dispatch(request: FakeRequest, response: FakeResponse): Promise<number>
  /** Dispose the owner, instance, seat, services and the fake server. */
  dispose(): Promise<void>
}

/** Load the fixture through a non-literal dynamic import (JS file, no d.ts needed). */
async function loadFixture(): Promise<{ startOAuthServer(options?: Record<string, unknown>): Promise<FakeAuthorizationServer> }> {
  const href = new URL('../fixture/oauth-auth-server.mjs', import.meta.url).href
  return await import(/* @vite-ignore */ href) as {
    startOAuthServer(options?: Record<string, unknown>): Promise<FakeAuthorizationServer>
  }
}

/** The finite sequence every sign-out/remount assertion observes. */
function readStatus(handle: McpConnectionStatusHandle): McpConnectionStatus {
  return handle.current()
}

/**
 * Boot one seat + mounted instance + registry against the fake authorization
 * server. The fake lifecycle port is the only seam to the (absent) manager; it
 * records the sign-out ordering and remounts on the same seat host.
 */
async function boot(extra: { oauth?: StreamableHttpServerDef['oauth'] } = {}): Promise<Harness> {
  const fixture = await loadFixture()
  const server = await fixture.startOAuthServer()
  const ctx = new Context()
  const fibers: Fiber[] = []
  let credentials: MemoryCredentials | undefined
  const bootCreds = function bootCredentials(c: Context): void {
    credentials = new MemoryCredentials(c)
  }
  // The service plugins are loaded in dependency order: credentials first (the
  // authorization seam injects them), then the authorization seam, then the
  // webserver the OAuth owner resolves through its owner context.
  const credentialsFiber = ctx.plugin(bootCreds)
  fibers.push(credentialsFiber)
  await credentialsFiber
  if (credentials === undefined) throw new Error('the memory credentials service did not mount')
  const memory = credentials
  const authFiber = ctx.plugin(AuthorizationService)
  fibers.push(authFiber)
  await authFiber
  const wsFiber = ctx.plugin(function bootWebServer(c: Context): void {
    new FakeWebServer(c, WEBSERVER_ORIGIN)
  })
  fibers.push(wsFiber)
  await wsFiber

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
  const def: StreamableHttpServerDef = {
    serverName: SERVER_NAME,
    transport: 'streamable-http',
    url: server.resourceUrl,
    headers: [],
    oauth: extra.oauth ?? {},
  }
  const seat = await createServerSeat({
    ctx,
    upstream: await loadUpstreamMcpClient(),
    credentials: memory,
    logger,
    serverName: SERVER_NAME,
    epoch: 1,
    onCaptureChanged: () => undefined,
    hooks: {
      agentOf: () => undefined,
      admit: () => () => undefined,
      isApplied: () => false,
    },
  })
  const resolved = resolveDefinitionConfig(def, seat.host)
  if (resolved.transport !== 'streamable-http' || resolved.oauth === undefined) {
    throw new Error('the test definition must resolve to an OAuth streamable-http config')
  }
  const config = resolved as ResolvedOAuthConfig
  const key = deriveCredentialKey(SERVER_NAME)
  const binding: ResolvedOAuthBinding = {
    serverName: SERVER_NAME,
    host: seat.host,
    config,
    fingerprint: JSON.stringify(def),
  }

  const order: string[] = []
  let liveDef: StreamableHttpServerDef | undefined = def
  let instance: McpServerInstance | undefined = seat.mount(config)
  let handle: McpConnectionStatusHandle | undefined
  void instance.ready.then(
    (ready) => {
      handle = ready
    },
    () => undefined,
  )
  const lifecycle: OAuthLifecyclePort = {
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      return await work()
    },
    fingerprint(serverName: string): string | undefined {
      return serverName === SERVER_NAME && liveDef !== undefined ? JSON.stringify(liveDef) : undefined
    },
    wantsInstance(): boolean {
      return liveDef !== undefined
    },
    async unmount(): Promise<boolean> {
      order.push('unmount')
      const current = instance
      instance = undefined
      handle = undefined
      if (current !== undefined) await current.dispose()
      return true
    },
    mount(): void {
      order.push('mount')
      if (liveDef === undefined) return
      const mounted = seat.mount(config)
      instance = mounted
      handle = undefined
      void mounted.ready.then(
        (ready) => {
          handle = ready
        },
        () => undefined,
      )
    },
  }
  const doc: McpScopeDoc = { servers: [def], overrides: {} }
  const registry = createOAuthRegistry({
    ctx,
    logger,
    credentials: {
      deleteRecord: async (recordKey) => {
        order.push('delete')
        await memory.deleteRecord(recordKey)
      },
    },
    getDoc: () => ({ ...doc, servers: liveDef === undefined ? [] : [liveDef] }),
    bindings: { get: () => binding },
    lifecycle,
  })
  return {
    server,
    ctx,
    credentials: memory,
    seat,
    def,
    config,
    binding,
    registry,
    key,
    order,
    instance: () => instance,
    status(): McpConnectionStatus {
      if (handle === undefined) throw new Error('the mounted instance has not settled its ready handshake yet')
      return readStatus(handle)
    },
    async dispatch(request, response): Promise<number> {
      let nextCalls = 0
      const waterfall = (ctx as unknown as {
        waterfall(thisArg: unknown, name: string, ...args: unknown[]): Promise<unknown>
      }).waterfall.bind(ctx)
      await waterfall(ctx, 'webserver/request', request, response, async () => {
        nextCalls += 1
      })
      return nextCalls
    },
    async dispose(): Promise<void> {
      await registry.disposeAll()
      const current = instance
      instance = undefined
      handle = undefined
      if (current !== undefined) await current.dispose()
      await seat.disposeSeat()
      for (const fiber of fibers.reverse()) {
        try {
          await fiber.dispose()
        } catch {
          // The fake server is the only owner of sockets left.
        }
      }
      await server.close()
    },
  }
}

/** Wait until the mounted instance reports one connection status state. */
async function waitForState(harness: Harness, state: McpConnectionStatus['state'], reason?: string): Promise<McpConnectionStatus> {
  return await waitFor(
    () => {
      try {
        return harness.status()
      } catch {
        return undefined
      }
    },
    (status) => status.state === state && (reason === undefined || (status.state === 'waiting-authorization' && status.reason === reason)),
    'status ' + state + (reason === undefined ? '' : ' (' + reason + ')'),
  )
}

/** Wait until the registry reports one attempt phase. */
async function waitForPhase(harness: Harness, phase: string): Promise<{ id: string; phase: string; authorizationUrl?: string }> {
  return await waitFor(
    () => harness.registry.attemptView(SERVER_NAME),
    (view) => view.phase === phase,
    'attempt phase ' + phase,
  )
}

/** Derive the callback URL the AS was handed (never a literal private path). */
function redirectUriOf(authorizationUrl: string): URL {
  const url = new URL(authorizationUrl)
  const redirectUri = url.searchParams.get('redirect_uri')
  if (redirectUri === null) throw new Error('the authorization URL names no redirect_uri')
  return new URL(redirectUri)
}

/** Dispatch one callback URL through the fake webserver waterfall. */
async function dispatchCallback(harness: Harness, callback: URL): Promise<{ status: number; nextCalls: number; body: string }> {
  const response = responseSink()
  const request: FakeRequest = {
    method: 'GET',
    url: callback.pathname + callback.search,
    headers: { host: new URL(WEBSERVER_ORIGIN).host },
  }
  const nextCalls = await harness.dispatch(request, response)
  return { status: response.status, nextCalls, body: response.body }
}

/** Run one full authorization: boot, authorize, consent, callback, authorized. */
async function authorizeFully(harness: Harness): Promise<void> {
  const started = await harness.registry.authorize(SERVER_NAME)
  expect(started.phase === 'starting' || started.phase === 'waiting-browser').toBe(true)
  const waiting = await waitForPhase(harness, 'waiting-browser')
  if (waiting.authorizationUrl === undefined) throw new Error('waiting-browser published no authorization URL')
  const callback = harness.server.simulateConsent(waiting.authorizationUrl)
  const answered = await dispatchCallback(harness, callback)
  expect(answered.status).toBe(200)
  expect(answered.nextCalls).toBe(0)
  await waitForPhase(harness, 'authorized')
}

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()
    if (harness !== undefined) await harness.dispose()
  }
})

describe('OAuth acceptance (real host + fake authorization server)', () => {
  it('runs start → waiting-browser → callback → authorized and commits an upstream-shaped grant', async () => {
    const harness = await boot()
    harnesses.push(harness)

    // Host validation applies the upstream OAuth budgets (nothing hardcoded).
    expect(harness.config.oauth.requestTimeoutMs).toBe(10_000)
    expect(harness.config.oauth.authorizationTimeoutMs).toBe(600_000)
    expect(String(harness.config.oauth.credentialKey)).toBe(String(harness.key))

    // A mounted instance without a grant waits passively (no browser, no host listener).
    const passive = await waitForState(harness, 'waiting-authorization', 'missing')
    expect(passive.state).toBe('waiting-authorization')

    const started = await harness.registry.authorize(SERVER_NAME)
    expect(started.phase === 'starting' || started.phase === 'waiting-browser').toBe(true)
    const waiting = await waitForPhase(harness, 'waiting-browser')
    const authorizationUrl = waiting.authorizationUrl
    expect(typeof authorizationUrl).toBe('string')
    const page = new URL(authorizationUrl as string)
    expect(page.origin).toBe(harness.server.origin)
    expect(page.searchParams.get('code_challenge_method')).toBe('S256')
    expect(page.searchParams.get('response_type')).toBe('code')
    expect(page.searchParams.get('scope')).toBe('mcp')

    // The redirect URI is DERIVED from the page the AS was handed; the private
    // callback path is pinned as sha256(credentialKey), never hardcoded here.
    const redirect = redirectUriOf(page.href)
    expect(redirect.origin).toBe(WEBSERVER_ORIGIN)
    expect(redirect.pathname).toBe('/mcp/oauth/callback/' + sha256Hex(String(harness.key)))
    // The dynamic registration carried the DERIVED redirect URI (no literal path).
    expect(harness.server.state.lastRegistration?.redirect_uris).toEqual([redirect.href])

    const callback = harness.server.simulateConsent(page.href)
    expect(harness.server.state.authorizationRequests.length).toBe(1)
    expect(harness.server.state.authorizationRequests[0]?.redirect_uri).toBe(redirect.href)
    const answered = await dispatchCallback(harness, callback)
    expect(answered.status).toBe(200)
    expect(answered.nextCalls).toBe(0)
    expect(answered.body).toContain('Authorization received')
    const authorized = await waitForPhase(harness, 'authorized')
    expect(authorized.phase).toBe('authorized')

    // PKCE S256 was verified by the AS and dynamic registration happened once.
    expect(harness.server.state.verifierChecked).toBe(true)
    expect(harness.server.state.registrations).toBe(1)
    expect(harness.server.state.tokenRequests[0]?.grant_type).toBe('authorization_code')

    // The committed record is the upstream grant shape at the derived key.
    const record = harness.credentials.records.get(harness.key)
    expect(record?.kind).toBe('grant')
    const payload = (record as { payload: Record<string, unknown> }).payload
    expect(payload.type).toBe('mcp-oauth-grant')
    expect(payload.version).toBe(1)
    expect(payload.serverUrl).toBe(harness.server.resourceUrl)
    expect(payload.issuer).toBe(harness.server.origin)
    expect(typeof payload.id).toBe('string')
    expect(payload.configuredClientId).toBeUndefined()
    const tokens = payload.tokens as Record<string, unknown>
    expect(typeof tokens.access_token).toBe('string')
    expect(typeof tokens.refresh_token).toBe('string')
    expect(harness.server.acceptsToken(String(tokens.access_token))).toBe(true)

    // Self-healing: the mounted instance reconnects on record-updated and
    // reaches connected with the advertised tool generation — no host listener.
    const connected = await waitForState(harness, 'connected')
    expect(connected.state === 'connected' ? connected.toolCount : -1, JSON.stringify(harness.server.state.mcpCalls)).toBe(1)
    expect(harness.server.state.mcpCalls).toContain('initialize')
    expect(harness.server.state.mcpCalls).toContain('tools/list')
  })

  it('pins the callback path to sha256(credentialKey), answers 400 for a bad state and 410 for a replay', async () => {
    const harness = await boot()
    harnesses.push(harness)
    const started = await harness.registry.authorize(SERVER_NAME)
    expect(started.phase === 'starting' || started.phase === 'waiting-browser').toBe(true)
    const waiting = await waitForPhase(harness, 'waiting-browser')
    const page = new URL(waiting.authorizationUrl as string)
    const redirect = redirectUriOf(page.href)
    // Pinned upstream contract: the owner derives this path privately from the
    // credential key, so the browser never needs to know it in advance.
    expect(redirect.pathname).toBe('/mcp/oauth/callback/' + sha256Hex(String(harness.key)))

    // A wrong state answers 400 and consumes nothing.
    const state = page.searchParams.get('state') ?? ''
    const forged = harness.server.simulateConsent(page.href)
    forged.searchParams.set('state', state.slice(0, -1) + (state.endsWith('a') ? 'b' : 'a'))
    const rejected = await dispatchCallback(harness, forged)
    expect(rejected.status).toBe(400)
    expect(harness.credentials.records.get(harness.key)).toBeUndefined()

    // The genuine callback succeeds; an immediate replay answers 410 while the
    // attempt is still exchanging (the code was consumed exactly once).
    const genuine = harness.server.simulateConsent(page.href)
    const accepted = await dispatchCallback(harness, genuine)
    expect(accepted.status).toBe(200)
    const replay = await dispatchCallback(harness, genuine)
    expect(replay.status).toBe(410)
    expect(replay.nextCalls).toBe(0)
    await waitForPhase(harness, 'authorized')
    expect(harness.server.state.tokenRequests.length).toBe(1)
  })

  it('cancels a matching attempt, ignores a stale id, and withdraws the flow', async () => {
    const harness = await boot()
    harnesses.push(harness)
    await harness.registry.authorize(SERVER_NAME)
    const waiting = await waitForPhase(harness, 'waiting-browser')
    const attemptId = waiting.id
    expect(attemptId.length).toBeGreaterThan(0)

    // A stale id is a successful no-op (upstream parity), the live one cancels.
    await harness.registry.cancel(SERVER_NAME, 'stale-attempt-id')
    expect(harness.registry.attemptView(SERVER_NAME)?.phase).toBe('waiting-browser')
    await harness.registry.cancel(SERVER_NAME, attemptId)
    const cancelled = await waitForPhase(harness, 'cancelled')
    expect(cancelled.phase).toBe('cancelled')

    // Cancel withdraws the callback listener with the attempt (no dangling
    // private route) and leaves the grant untouched.
    const page = new URL(waiting.authorizationUrl as string)
    const late = harness.server.simulateConsent(page.href)
    const lateResult = await dispatchCallback(harness, late)
    expect(lateResult.nextCalls).toBe(1)
    expect(lateResult.status).toBe(0)
    expect(harness.credentials.records.get(harness.key)).toBeUndefined()
  })

  it('authorizes a pre-registered clientId without dynamic registration', async () => {
    const harness = await boot({ oauth: { clientId: 'pre-registered-client', scope: 'mcp' } })
    harnesses.push(harness)
    await authorizeFully(harness)
    expect(harness.server.state.registrations).toBe(0)
    expect(harness.server.state.authorizationRequests[0]?.client_id).toBe('pre-registered-client')
    expect(harness.server.state.authorizationRequests[0]?.scope).toBe('mcp')
    const record = harness.credentials.records.get(harness.key) as { payload: Record<string, unknown> } | undefined
    expect(record?.payload.configuredClientId).toBe('pre-registered-client')
    expect(record?.payload.configuredScope).toBe('mcp')
  })

  it('signs out in the upstream order and remounts into waiting-authorization', async () => {
    const harness = await boot()
    harnesses.push(harness)
    await authorizeFully(harness)
    await waitForState(harness, 'connected')
    expect(harness.credentials.records.has(harness.key)).toBe(true)

    await harness.registry.signOut(SERVER_NAME)

    // retire → dispose → unmount → deleteRecord → mount (the fake port records
    // unmount/delete/mount; retire/dispose are observed through the flow).
    expect(harness.order).toEqual(['unmount', 'delete', 'mount'])
    expect(harness.credentials.records.has(harness.key)).toBe(false)
    const remounted = await waitForState(harness, 'waiting-authorization', 'missing')
    expect(remounted.state).toBe('waiting-authorization')
    expect(harness.registry.attemptView(SERVER_NAME)).toBeUndefined()
  })
})

/** SHA-256 hex digest of one string (the owner's private callback path). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
