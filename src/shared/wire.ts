/**
 * Wire contract between the host half (routes / manager projection) and the
 * browser half of the mcp-scope settings namespace.
 *
 * **Zero imports — on purpose.** The browser bundle may only require react, so
 * every module reachable from `src/client/index.ts` must have no runtime
 * dependency (in particular no `@deepseek-ai/*` value import and no
 * `node:crypto`). This file is the single declaration of the three route
 * payloads and the runtime vocabulary; the host half imports it for typing and
 * the browser half re-exports the types, so the two halves cannot drift.
 *
 * Boundary rules:
 * - only fixed enums/codes cross the wire — never upstream diagnostic text,
 *   tokens, grants or credential values (upstream errors can embed secrets);
 * - every payload is plain JSON (numbers, strings, booleans, arrays, objects);
 * - additive evolution only: a new phase/code is an explicit member here, so
 *   the host projection and the browser switch stay exhaustive at compile time.
 *
 * @module
 */

/** Exact Fetch path of the runtime status route (host route + browser runtime). */
export const MCP_SCOPE_STATUS_PATH = '/api/mcp-scope.status'

/** Exact Fetch path of the runtime action route (connect/disconnect/restart/test/OAuth). */
export const MCP_SCOPE_ACTION_PATH = '/api/mcp-scope.action'

/** Exact Fetch path of the per-server tool-list route. */
export const MCP_SCOPE_TOOLS_PATH = '/api/mcp-scope.tools'

/**
 * Credential-record namespace owned by this plugin: every stored record key
 * starts with this prefix. The browser uses it only to filter the
 * `credentials/record-updated` notification (it cannot derive the host's
 * hashed per-server key).
 */
export const MCP_CLIENT_KEY_PREFIX = 'mcp-client/'

/**
 * Frozen runtime phase vocabulary published on the status wire.
 *
 * `failed` always carries a fixed {@link RuntimeErrorCode} in
 * {@link ServerRuntimeView.error} — never a message copied from upstream.
 */
export type RuntimePhase =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'waiting-credentials'
  | 'waiting-authorization'
  | 'failed'
  | 'stopped'
  | 'disabled'
  | 'unknown'

/**
 * Fixed failure codes of the runtime wire. These are the only failure
 * identities the browser ever sees; the host maps upstream text/records onto
 * this enum and drops everything else.
 */
export type RuntimeErrorCode =
  | 'gave-up'
  | 'reconnect-disabled'
  | 'generation-stuck'
  | 'forbidden'
  | 'timeout'
  | 'spawn-failed'
  | 'protocol'
  | 'connection-failed'
  | 'load'
  | 'cleanup'
  | 'conflict'
  | 'config'
  | 'seam'
  | 'invalid-credential'

/** Why a passive OAuth connection awaits explicit authorization (5 fixed reasons). */
export type RuntimeAuthorizationReason = 'missing' | 'expired' | 'binding' | 'rejected' | 'scope'

/** Observable phases of one browser authorization attempt (token-free by construction). */
export type RuntimeAuthorizationPhase =
  | 'starting'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'authorized'
  | 'cancelled'
  | 'failed'

/**
 * Fixed failure identity of a `failed` attempt: `timeout` (the through-browser
 * deadline elapsed), `cleanup` (attempt cleanup did not confirm), `rejected`
 * (the server or authorization server refused the attempt) and `failed`
 * (anything else). Upstream failure text is whitelisted onto this enum and is
 * NEVER forwarded.
 */
export type RuntimeAuthorizationFailure = 'timeout' | 'cleanup' | 'rejected' | 'failed'

/**
 * Token-free authorization attempt view: identity + phase + (while
 * `waiting-browser`) the authorization page URL + (while `failed`) the fixed
 * failure identity. No `lastError` text ever crosses the wire — `failure` is
 * the additive field (0.2.6 line) that lets the browser name the reason
 * without receiving upstream prose.
 */
export interface RuntimeAuthorizationView {
  /** Opaque attempt identity used by cancel-authorization (never echoed in errors). */
  readonly id: string
  /** Current attempt phase. */
  readonly phase: RuntimeAuthorizationPhase
  /** Authorization page to open; present only while `phase === 'waiting-browser'`. */
  readonly authorizationUrl?: string
  /** Fixed failure identity; present only while `phase === 'failed'`. */
  readonly failure?: RuntimeAuthorizationFailure
}

/** One server's capped runtime view (never carries credential material or upstream text). */
export interface ServerRuntimeView {
  /** Configured server name. */
  readonly name: string
  /** Frozen wire phase. */
  readonly phase: RuntimePhase
  /**
   * Whether the server is still named by the live settings document. A retained
   * row with `configured: false` is a cleanup-pending record removed from the
   * document but kept on screen until its teardown is confirmed.
   */
  readonly configured: boolean
  /** Tool count of the live generation (catalog size for on-demand servers). */
  readonly toolCount: number
  /** Consecutive failed attempts in the current outage (0 outside connecting/reconnecting). */
  readonly attempts: number
  /** Attempt budget per outage from the resolved reconnect policy. */
  readonly maxAttempts: number
  /** Epoch milliseconds when the next reconnect attempt fires (reconnecting only). */
  readonly nextRetryAt?: number
  /** Epoch milliseconds when connect + initial tool sync completed (connected only). */
  readonly connectedAt?: number
  /** Epoch milliseconds when the last capture generation was published (host-sourced). */
  readonly syncedAt?: number
  /** Why authorization is required (waiting-authorization only). */
  readonly authReason?: RuntimeAuthorizationReason
  /** Current/last token-free authorization attempt view. */
  readonly authorization?: RuntimeAuthorizationView
  /** Fixed failure identity (failed only). */
  readonly error?: RuntimeErrorView
}

/** Fixed failure identity of one runtime phase. */
export interface RuntimeErrorView {
  readonly code: RuntimeErrorCode
}

/** Whole-document runtime status response (`v` is the wire version). */
export interface RuntimeStatusView {
  readonly v: 1
  /** Epoch milliseconds the snapshot was produced. */
  readonly at: number
  readonly servers: readonly ServerRuntimeView[]
}

/** One capped tool identity (eager definitions or nothing for a catalog-only view). */
export interface RuntimeToolEntry {
  /** Model-facing name (the upstream public name; the raw MCP name is not on the wire). */
  readonly publicName: string
  /** First-line description, capped for the wire. */
  readonly description: string
}

/**
 * Tool-list response mode: `definitions` lists the eager generation;
 * `catalog` marks an on-demand server whose definitions live behind the
 * loader (the entry list is empty, `total` carries the offered count).
 */
export type ToolListMode = 'definitions' | 'catalog'

/** Capped tool-list response for one server. */
export interface ToolListView {
  readonly mode: ToolListMode
  readonly tools: readonly RuntimeToolEntry[]
  /** Whether the response hit the wire entry cap. */
  readonly truncated: boolean
  /** Total committed tool count (>= tools.length when truncated). */
  readonly total: number
}

/** Phase a probe failure is attributed to. */
type RuntimeTestStage = 'connect' | 'list'

/** Fixed probe failure codes (never the upstream message). */
export type RuntimeTestCode = RuntimeErrorCode | 'oauth-required' | 'internal'

/** Result of one manual connection test (probe). */
export interface RuntimeTestResult {
  readonly ok: boolean
  /** Advertised tool count when the probe succeeded. */
  readonly toolCount?: number
  /** Whether the advertised tool list was longer than the probe's return cap. */
  readonly truncated?: boolean
  /** Stage the failure was raised in (failed probes only). */
  readonly stage?: RuntimeTestStage
  /** Fixed failure identity (failed probes only). */
  readonly code?: RuntimeTestCode
}

/** Runtime phase after a successful action (the post-action projected state). */
export interface RuntimeActionResult {
  readonly name: string
  readonly phase: RuntimePhase
}

/** Result of one authorize action: the attempt view the browser opens without polling. */
export interface RuntimeAuthorizeResult extends RuntimeActionResult {
  /** Present while the attempt is still observable (starting/waiting-browser/…). */
  readonly authorization?: RuntimeAuthorizationView
}

/** The seven fixed runtime actions. */
export type RuntimeActionKind =
  | 'connect'
  | 'disconnect'
  | 'restart'
  | 'test'
  | 'authorize'
  | 'cancel-authorization'
  | 'sign-out'

/** One action request body (POST {@link MCP_SCOPE_ACTION_PATH}). */
export interface RuntimeActionRequest {
  readonly action: RuntimeActionKind
  /** Configured server name (validated against the name contract by the host). */
  readonly server: string
  /** Opaque attempt identity, required only for `cancel-authorization` (never echoed). */
  readonly attemptId?: string
}

/**
 * Fixed business failure codes of a runtime action. The route layer maps them
 * to HTTP statuses; the browser never parses the accompanying message beyond
 * a host-fixed fallback.
 */
export type RuntimeActionErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'not-connected'
  | 'disabled'
  | 'conflict'
  | 'cleanup'
  | 'load'
  | 'config'
  | 'oauth-not-configured'
  | 'oauth-unavailable'
  | 'oauth-busy'
  | 'oauth-required'
  | 'oauth-failed'
  | 'oauth-cleanup'
  | 'internal'
