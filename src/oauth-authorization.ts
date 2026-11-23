/**
 * OAuth host module: credential-key helpers, wire/redaction mapping, the
 * owner wrapper over the official `McpOAuthAuthorization`, and the registry
 * that all three OAuth actions go through.
 *
 * The grant layer is NOT mirrored here. The mounted official instance owns
 * grant read/refresh/CAS/redaction and the `credentials/record-updated` retry;
 * an explicit authorization reuses the official browser flow through the SAME
 * private isolated `McpClientHost` a seat already constructed (S4/S6). This
 * module therefore adds no transport, no credential read, and no host-side
 * record listener — only:
 *
 * - **key helpers** — the effective credential-record address of a row (the
 *   derived `mcp-client/mcp-scope-<sha256[:16]>` key comes from host-config);
 * - **wire mapping** — detached views with whitelisted failure codes; upstream
 *   diagnostic text and any secret NEVER cross this boundary;
 * - **owner** — the only caller of `host.authorization(config, changed)`, and
 *   the translator of its fixed outcomes into {@link OAuthActionError};
 * - **registry** — one owner per `serverName` + definition fingerprint, plus
 *   the sign-out ordering (retire → dispose → unmount → deleteRecord → mount)
 *   against the lifecycle port implemented by the manager.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseCredentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  McpCloseResult,
  McpOAuthAttemptId,
  McpOAuthAttemptView,
  McpOAuthAuthorization,
  McpOAuthConfig,
  StreamableHttpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import { deriveCredentialKey } from './host-config.js'
import { OAUTH_CREDENTIAL_KEY_PATTERN } from './shared/defaults.js'
import { lastDefinitionOf } from './status.js'
import { sanitizeLogText, type HostLogger } from './log.js'
import type {
  OAuthActionCode,
  OAuthAttemptFailure,
  OAuthAttemptPhase,
  OAuthAttemptView,
} from './shared/oauth.js'
import type { McpScopeDoc, ServerDef, StreamableHttpServerDef } from './shared/model.js'
import type { McpClientHostLike } from './upstream.js'

/** Fixed English text of an OAuth business failure (host-generated; never upstream text). */
export const OAUTH_ACTION_MESSAGES: Readonly<Record<OAuthActionCode, string>> = {
  'oauth-not-configured': 'OAuth is not configured for this server',
  'oauth-unavailable': 'browser authorization is unavailable in this deployment',
  'oauth-busy': 'another authorization attempt is already active',
  'oauth-required': 'the server requires browser authorization',
  'oauth-failed': 'authorization failed',
  'oauth-cleanup': 'the authorization attempt could not be cleaned up',
}

/**
 * Business failure of one OAuth action, carrying a stable wire code and a fixed
 * message. The cause (an upstream failure) stays host-side and is never
 * projected.
 */
export class OAuthActionError extends Error {
  readonly code: OAuthActionCode

  constructor(code: OAuthActionCode, options?: ErrorOptions) {
    super(OAUTH_ACTION_MESSAGES[code], options)
    this.name = 'OAuthActionError'
    this.code = code
  }
}

/** One HTTP row with an explicit OAuth block (presence is what enables authorization). */
export type OAuthServerDefinition = StreamableHttpServerDef & {
  oauth: NonNullable<StreamableHttpServerDef['oauth']>
}

/** Narrow one configured row to its OAuth shape (undefined for stdio/no-oauth rows). */
export function oauthDefinitionOf(def: ServerDef | undefined): OAuthServerDefinition | undefined {
  if (def === undefined || def.transport !== 'streamable-http' || def.oauth === undefined) return undefined
  return def as OAuthServerDefinition
}

/**
 * The credential-record address one row authorizes: its explicit key when the
 * document names one, else the host-derived namespaced key.
 *
 * The derivation is host-config's single implementation (never duplicated); an
 * explicit key is re-validated with the credentials seam's own parser here so a
 * hand-edited document can never address another plugin's record.
 *
 * @param def - streamable-http row with an OAuth block.
 * @returns the branded record key.
 * @throws TypeError when an explicit key is outside the credentials grammar.
 */
export function effectiveCredentialKey(def: OAuthServerDefinition): CredentialKey {
  const explicit = def.oauth.credentialKey
  if (explicit === undefined) return deriveCredentialKey(def.serverName)
  // The plugin only ever writes/reads its OWN namespaced key: a hand-edited row
  // naming another plugin's record must not let sign-out delete that record.
  if (!OAUTH_CREDENTIAL_KEY_PATTERN.test(explicit)) {
    throw new Error('oauth.credentialKey must match ' + String(OAUTH_CREDENTIAL_KEY_PATTERN))
  }
  return parseCredentialKey(explicit)
}

/** Cap of an attempt id on the wire (upstream ids are opaque UUIDs). */
const ATTEMPT_ID_MAX = 64

/** Longest authorization URL published on the wire (a sanity bound, not a policy). */
const AUTHORIZATION_URL_MAX = 4096

/** Hosts for which plain HTTP is legitimate (the official host's own OAuth rule). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The wire phase of an upstream attempt, degrading an unknown/future variant to
 * the fixed `failed` terminal phase (the wire union is frozen).
 *
 * @param phase - upstream attempt phase.
 * @returns one of the seven frozen wire phases.
 */
export function wireAttemptPhase(phase: McpOAuthAttemptView['phase']): OAuthAttemptPhase {
  switch (phase) {
    case 'starting':
    case 'waiting-browser':
    case 'exchanging':
    case 'committing':
    case 'authorized':
    case 'cancelled':
    case 'failed':
      return phase
    default:
      // A future upstream phase must never surface as a healthy one.
      return 'failed'
  }
}

/**
 * Whitelist one upstream failure text into the fixed failure enum: the
 * through-browser deadline is `timeout`, an unsettled cleanup is `cleanup`, a
 * refusal (denied/rejected/declined) is `rejected`, and anything else is the
 * generic `failed`. The text itself NEVER leaves this function.
 *
 * @param lastError - upstream attempt failure text (host-side only).
 * @returns the fixed failure identity, or undefined when no failure was reported.
 */
export function wireAttemptFailure(lastError: string | undefined): OAuthAttemptFailure | undefined {
  if (lastError === undefined || lastError === '') return undefined
  if (/timed? out|timeout|MCP_TIMEOUT/i.test(lastError)) return 'timeout'
  if (/cleanup/i.test(lastError)) return 'cleanup'
  if (/rejected|denied|declined/i.test(lastError)) return 'rejected'
  return 'failed'
}

/**
 * The only authorization URL shape the wire accepts: HTTPS, or plain HTTP on a
 * loopback host (the rule the official host enforces for OAuth requests),
 * bounded in length. Everything else is dropped.
 */
function publishableAuthorizationUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value.length > AUTHORIZATION_URL_MAX) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return undefined
  return url.href
}

/**
 * Project one upstream attempt into the token-free wire view: bounded id, fixed
 * phase, the page only while waiting for the browser, and a whitelisted failure
 * identity — no upstream text, no tokens.
 *
 * @param view - upstream attempt view (undefined before the first attempt).
 * @returns the wire view, or undefined when there is no attempt.
 */
export function wireAttempt(view: McpOAuthAttemptView | undefined): OAuthAttemptView | undefined {
  if (view === undefined) return undefined
  const phase = wireAttemptPhase(view.phase)
  const authorizationUrl = phase === 'waiting-browser' ? publishableAuthorizationUrl(view.authorizationUrl) : undefined
  const failure = phase === 'failed' ? wireAttemptFailure(view.lastError) : undefined
  return {
    id: String(view.id).slice(0, ATTEMPT_ID_MAX),
    phase,
    ...(authorizationUrl === undefined ? {} : { authorizationUrl }),
    ...(failure === undefined ? {} : { failure }),
  }
}

/**
 * Translate any thrown owner/lifecycle failure into a fixed business failure.
 * Cleanup deadlines are the only distinguishable class (cancel keeps the grant
 * and blocks the remount); everything else is `oauth-failed`.
 *
 * @param error - the caught failure.
 * @returns the fixed business failure (the original error stays the cause).
 */
export function translateOwnerFailure(error: unknown): OAuthActionError {
  if (error instanceof OAuthActionError) return error
  if (/cleanup/i.test(sanitizeLogText(error))) return new OAuthActionError('oauth-cleanup', { cause: error })
  return new OAuthActionError('oauth-failed', { cause: error })
}

/**
 * One server's OAuth binding, owned by the lifecycle: the private isolated host
 * that creates the owner, the ONE resolved config shared with mount/probe (S6),
 * and the definition fingerprint the binding is valid for.
 */
export interface ResolvedOAuthBinding {
  readonly serverName: string
  readonly host: McpClientHostLike
  readonly config: StreamableHttpConfig & { oauth: McpOAuthConfig }
  readonly fingerprint: string
}

/** Construction deps of one owner wrapper. */
export interface OAuthOwnerDeps {
  readonly binding: ResolvedOAuthBinding
  readonly logger: HostLogger
  /** Called by the upstream owner after every attempt-view change. */
  onChanged(): void
}

/** Lifecycle handle of one server's authorization owner. */
export interface OAuthOwnerHandle {
  /** The credential record this owner's attempts address. */
  readonly key: CredentialKey
  /** Detached attempt view without starting a flow (undefined before the first attempt). */
  current(): OAuthAttemptView | undefined
  /** Start (or report) the active attempt, mapped onto the wire view. */
  start(): Promise<OAuthAttemptView>
  /** Cancel the matching attempt; stale ids are a no-op (upstream parity). */
  cancel(id: string): Promise<void>
  /** Reject new starts and withdraw active work (owner teardown step one). */
  retire(): void
  /** Retire and await attempt/callback/flow cleanup (owner teardown step two). */
  dispose(): Promise<McpCloseResult>
}

/** Read the authorization verb defensively (upstream drift must not crash a request). */
function authorizationVerbOf(host: McpClientHostLike): McpClientHostLike['authorization'] {
  const candidate = (host as { authorization?: unknown }).authorization
  if (typeof candidate !== 'function') throw new OAuthActionError('oauth-unavailable')
  return candidate.bind(host) as McpClientHostLike['authorization']
}

/**
 * Wrap the official `McpOAuthAuthorization` of one binding: lazy creation, wire
 * projection and fixed failure translation. This is the ONLY place that calls
 * `host.authorization`, so an owner can never live on a second host (the host
 * reference is passed, never reconstructed — ONE private host per seat, the
 * same resolved config mount/probe use).
 *
 * @param deps - binding, logger and change callback.
 * @returns the owner lifecycle handle.
 * @throws OAuthActionError when the binding's credential key is malformed.
 */
export function createOAuthOwner(deps: OAuthOwnerDeps): OAuthOwnerHandle {
  const { binding } = deps
  let key: CredentialKey
  try {
    key = parseCredentialKey(binding.config.oauth.credentialKey)
  } catch (error) {
    throw new OAuthActionError('oauth-failed', { cause: error })
  }
  let upstream: McpOAuthAuthorization | undefined
  const ensure = (): McpOAuthAuthorization => {
    if (upstream !== undefined) return upstream
    const authorization = authorizationVerbOf(binding.host)
    try {
      upstream = authorization(binding.config, deps.onChanged)
    } catch (error) {
      deps.logger.warn('mcp-scope(' + binding.serverName + '): the OAuth owner could not be created: ' + sanitizeLogText(error))
      throw translateOwnerFailure(error)
    }
    return upstream
  }
  return {
    key,
    current: (): OAuthAttemptView | undefined => (upstream === undefined ? undefined : wireAttempt(upstream.current())),
    async start(): Promise<OAuthAttemptView> {
      const owner = ensure()
      let view: McpOAuthAttemptView
      try {
        view = await owner.start()
      } catch (error) {
        throw translateOwnerFailure(error)
      }
      const wired = wireAttempt(view)
      if (wired === undefined) throw new OAuthActionError('oauth-failed')
      return wired
    },
    async cancel(id: string): Promise<void> {
      const owner = upstream
      if (owner === undefined) return
      try {
        await owner.cancel(String(id) as unknown as McpOAuthAttemptId)
      } catch (error) {
        throw translateOwnerFailure(error)
      }
    },
    retire(): void {
      upstream?.retire()
    },
    async dispose(): Promise<McpCloseResult> {
      const owner = upstream
      upstream = undefined
      if (owner === undefined) return { closeConfirmed: true }
      try {
        return await owner.dispose()
      } catch (error) {
        // Total by contract: a throwing dispose is an unconfirmed cleanup.
        return { closeConfirmed: false, cleanupError: sanitizeLogText(error) }
      }
    },
  }
}

/**
 * Lifecycle seam the registry drives. The manager implements it against its
 * mutation chain, document, records and seat fibers; the registry never mounts,
 * unmounts or creates a host itself.
 */
export interface OAuthLifecyclePort {
  /** Run one mutation on the manager's exclusive chain and hand back its value. */
  exclusive<T>(work: () => Promise<T>): Promise<T>
  /** Serialized fingerprint of the live definition (undefined when absent). */
  fingerprint(serverName: string): string | undefined
  /** Whether the server should currently hold a mounted instance (enabled && not latched). */
  wantsInstance(serverName: string): boolean
  /** Dispose the live instance; false when its cleanup is unconfirmed. */
  unmount(serverName: string): Promise<boolean>
  /** Mount a fresh instance when {@link wantsInstance} (scheduled by the manager). */
  mount(serverName: string): void
}

/** Construction deps of {@link createOAuthRegistry}. */
export interface OAuthRegistryDeps {
  readonly ctx: Context
  readonly logger: HostLogger
  /** Record deletion is the ONLY grant write the plugin performs (sign-out). */
  readonly credentials: Pick<CredentialProvider, 'deleteRecord'>
  /** Read the current settings document (never cached). */
  getDoc(): McpScopeDoc
  /** The live per-server binding, owned by the lifecycle (seat host + resolved config). */
  readonly bindings: { get(serverName: string): ResolvedOAuthBinding | undefined }
  readonly lifecycle: OAuthLifecyclePort
}

/** The plugin-level OAuth action surface the manager exposes to the routes. */
export interface OAuthRegistry {
  /** Whether browser authorization services are mounted in this deployment. */
  available(): boolean
  /** Cached attempt view of one server (stale bindings never serve a view). */
  attemptView(serverName: string): OAuthAttemptView | undefined
  /** Start (or report) explicit authorization; works for globally disabled servers. */
  authorize(serverName: string): Promise<OAuthAttemptView>
  /** Cancel the selected attempt; absent owners and stale ids are a no-op. */
  cancel(serverName: string, id: string): Promise<void>
  /** Delete the stored grant and restart the server without it (upstream ordering). */
  signOut(serverName: string): Promise<void>
  /** Dispose one cached owner (seat teardown / definition change); reports cleanup. */
  disposeOwner(serverName: string): Promise<McpCloseResult | undefined>
  /** Retire every owner synchronously, then await all disposals (bounded upstream). */
  disposeAll(): Promise<void>
}

/** One cached owner, valid only for the binding fingerprint it was created with. */
interface CachedOwner {
  readonly owner: OAuthOwnerHandle
  readonly fingerprint: string
}

/**
 * Create the plugin-level authorization registry. It owns no effects, no
 * listener and no host: it caches {@link OAuthOwnerHandle}s keyed by server name
 * and judges staleness by the binding fingerprint, so a definition change or a
 * removed row can never serve (or leak) an old attempt.
 *
 * @param deps - context, credentials delete verb, document/binding/lifecycle ports.
 * @returns the registry consumed by the manager.
 */
export function createOAuthRegistry(deps: OAuthRegistryDeps): OAuthRegistry {
  const { logger } = deps
  /** serverName → the owner of its current binding. */
  const owners = new Map<string, CachedOwner>()
  /** serverNames whose sign-out is running (authorize/cancel refuse meanwhile). */
  const signingOut = new Set<string>()

  /** The live OAuth row or a fixed business failure (never throws raw document errors). */
  function requireOAuthDefinition(serverName: string): OAuthServerDefinition {
    const def = oauthDefinitionOf(lastDefinitionOf(deps.getDoc().servers, serverName))
    if (def === undefined) throw new OAuthActionError('oauth-not-configured')
    return def
  }

  /** Whether the browser-authorization services are mounted (lookups, never injects). */
  function available(): boolean {
    try {
      return deps.ctx.get('authorization') !== undefined && deps.ctx.get('webServer') !== undefined
    } catch {
      return false
    }
  }

  /** Drop one cached owner: retire synchronously, then await its bounded cleanup. */
  async function disposeOwnerInternal(serverName: string): Promise<McpCloseResult | undefined> {
    const cached = owners.get(serverName)
    if (cached === undefined) return undefined
    owners.delete(serverName)
    cached.owner.retire()
    let result: McpCloseResult
    try {
      result = await cached.owner.dispose()
    } catch (error) {
      result = { closeConfirmed: false, cleanupError: sanitizeLogText(error) }
    }
    if (!result.closeConfirmed || result.cleanupError !== undefined) {
      logger.warn('mcp-scope(' + serverName + '): the OAuth authorization owner cleanup was not confirmed')
    }
    return result
  }

  /** Cached view of one server, never from a binding with a different fingerprint. */
  function attemptView(serverName: string): OAuthAttemptView | undefined {
    const cached = owners.get(serverName)
    if (cached === undefined) return undefined
    const binding = deps.bindings.get(serverName)
    if (binding === undefined || binding.fingerprint !== cached.fingerprint) return undefined
    return cached.owner.current()
  }

  async function authorize(serverName: string): Promise<OAuthAttemptView> {
    // Configured, OAuth-enabled row first: this is the fixed not-configured code.
    requireOAuthDefinition(serverName)
    if (signingOut.has(serverName)) throw new OAuthActionError('oauth-busy')
    const binding = deps.bindings.get(serverName)
    if (binding === undefined) throw new OAuthActionError('oauth-unavailable')
    if (!available()) throw new OAuthActionError('oauth-unavailable')
    const cached = owners.get(serverName)
    let owner: CachedOwner
    if (cached !== undefined && cached.fingerprint === binding.fingerprint) {
      owner = cached
    } else {
      // A definition change retires the previous owner before a new flow exists.
      await disposeOwnerInternal(serverName)
      let handle: OAuthOwnerHandle
      try {
        handle = createOAuthOwner({
          binding,
          logger,
          // Status is pull-only in this plugin: the browser refreshes through
          // the action response and the forwarded credentials/record-updated
          // event, so the owner needs no push callback.
          onChanged: () => undefined,
        })
      } catch (error) {
        throw translateOwnerFailure(error)
      }
      owner = { owner: handle, fingerprint: binding.fingerprint }
      owners.set(serverName, owner)
    }
    try {
      return await owner.owner.start()
    } catch (error) {
      throw translateOwnerFailure(error)
    }
  }

  async function cancel(serverName: string, id: string): Promise<void> {
    if (signingOut.has(serverName)) return
    const cached = owners.get(serverName)
    if (cached === undefined) return
    try {
      await cached.owner.cancel(id)
    } catch (error) {
      throw translateOwnerFailure(error)
    }
  }

  async function signOut(serverName: string): Promise<void> {
    // The live document, not the runtime record: sign-out must also work for a
    // globally disabled or never-mounted OAuth server (upstream parity).
    const def = requireOAuthDefinition(serverName)
    if (signingOut.has(serverName)) throw new OAuthActionError('oauth-busy')
    let key: CredentialKey
    try {
      key = effectiveCredentialKey(def)
    } catch (error) {
      throw new OAuthActionError('oauth-failed', { cause: error })
    }
    const fingerprint = deps.lifecycle.fingerprint(serverName)
    if (fingerprint === undefined) throw new OAuthActionError('oauth-unavailable')
    signingOut.add(serverName)
    try {
      // Abort a non-committing attempt immediately; an already admitted commit
      // still completes and is awaited by disposeOwner below.
      owners.get(serverName)?.owner.retire()
      await deps.lifecycle.exclusive(async () => {
        const assertUnchanged = (): void => {
          if (deps.lifecycle.fingerprint(serverName) !== fingerprint) {
            // The row (or its credential binding) changed under the sign-out:
            // keep the grant, never delete a record the new definition may own.
            throw new OAuthActionError('oauth-failed')
          }
        }
        assertUnchanged()
        const cleanup = await disposeOwnerInternal(serverName)
        if (cleanup !== undefined && (!cleanup.closeConfirmed || cleanup.cleanupError !== undefined)) {
          // Grant kept, no remount: the manager retains failed{cleanup}.
          throw new OAuthActionError('oauth-cleanup')
        }
        let clean: boolean
        try {
          clean = await deps.lifecycle.unmount(serverName)
        } catch (error) {
          logger.warn('mcp-scope(' + serverName + '): unmount during sign-out failed: ' + sanitizeLogText(error))
          throw new OAuthActionError('oauth-failed', { cause: error })
        }
        if (!clean) throw new OAuthActionError('oauth-cleanup')
        assertUnchanged()
        try {
          await deps.credentials.deleteRecord(key)
        } catch (error) {
          logger.error('mcp-scope(' + serverName + '): the OAuth grant could not be deleted during sign-out')
          throw new OAuthActionError('oauth-failed', { cause: error })
        } finally {
          // Never leave the server dead because the deletion failed: the fresh
          // instance reads no grant and reports waiting-authorization by itself.
          deps.lifecycle.mount(serverName)
        }
      })
    } catch (error) {
      throw translateOwnerFailure(error)
    } finally {
      signingOut.delete(serverName)
    }
  }

  async function disposeAll(): Promise<void> {
    const entries = [...owners.values()]
    owners.clear()
    signingOut.clear()
    // Retire first (synchronous withdrawal), then await every bounded dispose.
    for (const cached of entries) cached.owner.retire()
    await Promise.allSettled(entries.map(async (cached) => {
      const result = await cached.owner.dispose()
      if (!result.closeConfirmed || result.cleanupError !== undefined) {
        logger.warn('mcp-scope: an OAuth authorization owner cleanup was not confirmed during teardown')
      }
    }))
  }

  return {
    available,
    attemptView,
    authorize,
    cancel,
    signOut,
    disposeOwner: disposeOwnerInternal,
    disposeAll,
  }
}
