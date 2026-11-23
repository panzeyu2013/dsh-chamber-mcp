/**
 * Pure view-model helpers shared by the settings views.
 *
 * Kept React-free and dependency-free so the list/detail/workspace components
 * stay small and the mappings are unit-testable.
 *
 * Phase coverage is COMPILE-ENFORCED: the phase -> locale-key and phase -> tone
 * maps are exhaustive switches with no default, so adding a wire phase (see
 * src/shared/wire.ts) breaks the build until a user-visible label and tone
 * exist. runtimeSnapshotsEqual is COMPILE-ENFORCED through two mapped-type
 * field tables: a new ServerRuntimeView field fails the build until a
 * comparator is added (ViewFieldChecks), and so does a new nested
 * RuntimeAuthorizationView field (AuthorizationFieldChecks).
 */

import {
  credentialRefsOf,
  isEnabled,
  isServerDisabled,
  type McpScopeDoc,
  type ServerDef,
} from '../shared/model.js'
import type {
  RuntimeActionErrorCode,
  RuntimeAuthorizationPhase,
  RuntimeAuthorizationReason,
  RuntimeAuthorizationView,
  RuntimeErrorCode,
  RuntimePhase,
  RuntimeSnapshot,
  ServerRuntimeView,
} from './runtime.js'
import type { SettingsKey } from './locales.js'
import type { TextSeat } from './controller.js'

/** Runtime view of one server, via an OWN key (prototype-safe). */
export function runtimeOf(
  runtime: RuntimeSnapshot | undefined,
  serverName: string,
): ServerRuntimeView | undefined {
  if (runtime === undefined) return undefined
  return Object.hasOwn(runtime.servers, serverName) ? runtime.servers[serverName] : undefined
}

type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

/** Locale key of one runtime phase (exhaustive: a new phase must be labeled). */
export function statusKeyOf(state: RuntimePhase): SettingsKey {
  switch (state) {
    case 'connected':
      return 'status.connected'
    case 'connecting':
      return 'status.connecting'
    case 'reconnecting':
      return 'status.reconnecting'
    case 'waiting-credentials':
      return 'status.waitingCredentials'
    case 'waiting-authorization':
      return 'status.waitingAuthorization'
    case 'failed':
      return 'status.failed'
    case 'stopped':
      return 'status.stopped'
    case 'disabled':
      return 'status.disabled'
    case 'unknown':
      // The host reports unknown for a server it has not reconciled yet
      // ("configured but never tracked"). Saying "not started" here would claim
      // knowledge the plugin does not have.
      return 'status.unknown'
  }
}

/** Tone of one runtime phase (idle = neutral pill; exhaustive, no default). */
export function statusToneOf(state: RuntimePhase): StatusTone {
  switch (state) {
    case 'connected':
      return 'ok'
    case 'connecting':
    case 'reconnecting':
    case 'waiting-credentials':
    case 'waiting-authorization':
      return 'warn'
    case 'failed':
      return 'error'
    case 'stopped':
    case 'disabled':
    case 'unknown':
      return 'idle'
  }
}

/** Locale keys of the fixed host-side failure codes (never upstream text). */
const RUNTIME_ERROR_KEYS: Record<RuntimeErrorCode, SettingsKey> = {
  'gave-up': 'runtime.error.gave-up',
  'reconnect-disabled': 'runtime.error.reconnect-disabled',
  'generation-stuck': 'runtime.error.generation-stuck',
  forbidden: 'runtime.error.forbidden',
  timeout: 'runtime.error.timeout',
  'spawn-failed': 'runtime.error.spawn-failed',
  protocol: 'runtime.error.protocol',
  'connection-failed': 'runtime.error.connection-failed',
  load: 'runtime.error.load',
  cleanup: 'runtime.error.cleanup',
  conflict: 'runtime.error.conflict',
  config: 'runtime.error.config',
  seam: 'runtime.error.seam',
  'invalid-credential': 'runtime.error.invalid-credential',
}

/** Locale keys of the fixed action business failures. */
const ACTION_ERROR_KEYS: Record<RuntimeActionErrorCode, SettingsKey> = {
  'bad-request': 'runtime.error.bad-request',
  'not-found': 'runtime.error.not-found',
  'not-connected': 'runtime.error.not-connected',
  disabled: 'runtime.error.disabled',
  conflict: 'runtime.error.conflict',
  cleanup: 'runtime.error.cleanup',
  load: 'runtime.error.load',
  config: 'runtime.error.config',
  'oauth-not-configured': 'runtime.error.oauth-not-configured',
  'oauth-unavailable': 'runtime.error.oauth-unavailable',
  'oauth-busy': 'runtime.error.oauth-busy',
  'oauth-required': 'runtime.error.oauth-required',
  'oauth-failed': 'runtime.error.oauth-failed',
  'oauth-cleanup': 'runtime.error.oauth-cleanup',
  internal: 'runtime.error.internal',
}

/**
 * Locale key of one fixed runtime/action code (undefined = unknown code; the
 * caller falls back to the host message or a generic label, never to raw
 * upstream prose).
 */
export function runtimeErrorKey(code: string): SettingsKey | undefined {
  if (Object.hasOwn(RUNTIME_ERROR_KEYS, code)) return RUNTIME_ERROR_KEYS[code as RuntimeErrorCode]
  if (Object.hasOwn(ACTION_ERROR_KEYS, code)) return ACTION_ERROR_KEYS[code as RuntimeActionErrorCode]
  return undefined
}

/** Localized text of one runtime error (fixed codes never carry remote text). */
export function runtimeErrorText(
  t: TextSeat,
  error: { code: string; message?: string },
): string {
  const key = runtimeErrorKey(error.code)
  if (key !== undefined) return t(key)
  // The wire never carries message text; a RuntimeCallError may carry the
  // host-fixed fallback. Unknown codes degrade to a generic label.
  return typeof error.message === 'string' && error.message !== '' ? error.message : t('runtime.error')
}

/** Locale key of one passive-authorization reason (5 fixed reasons). */
export function authorizationReasonKey(reason: RuntimeAuthorizationReason): SettingsKey {
  switch (reason) {
    case 'missing':
      return 'auth.reason.missing'
    case 'expired':
      return 'auth.reason.expired'
    case 'binding':
      return 'auth.reason.binding'
    case 'rejected':
      return 'auth.reason.rejected'
    case 'scope':
      return 'auth.reason.scope'
  }
}

/**
 * Whether an authorization attempt is still running: the UI offers Cancel and
 * paints an "authorizing" state only for these phases (terminal phases —
 * authorized/cancelled/failed — are history, not activity).
 */
export function isAuthorizationActive(phase: RuntimeAuthorizationPhase): boolean {
  switch (phase) {
    case 'starting':
    case 'waiting-browser':
    case 'exchanging':
    case 'committing':
      return true
    case 'authorized':
    case 'cancelled':
    case 'failed':
      return false
  }
}

/** Server names whose definition references one credential ref. */
export function serversUsingRef(doc: McpScopeDoc, ref: string): string[] {
  return doc.servers
    .filter((server) => credentialRefsOf(server).includes(ref))
    .map((server) => server.serverName)
}

/** Credential refs referenced by this server but by no other server. */
export function orphanedRefsOf(doc: McpScopeDoc, serverName: string): string[] {
  const target = doc.servers.find((server) => server.serverName === serverName)
  if (target === undefined) return []
  const others = new Set<string>()
  for (const server of doc.servers) {
    if (server.serverName === serverName) continue
    for (const ref of credentialRefsOf(server)) others.add(ref)
  }
  return credentialRefsOf(target).filter((ref) => !others.has(ref))
}

/** How many servers one workspace explicitly enables. */
export function enabledServerNames(
  doc: McpScopeDoc,
  workspaceId: string,
): string[] {
  return doc.servers
    .filter((server) => isEnabled(doc.overrides, workspaceId, server.serverName))
    .map((server) => server.serverName)
}

/** A server is "in use" when allowed AND enabled somewhere; used for the unused nudge. */
export function isServerInUse(doc: McpScopeDoc, server: ServerDef, workspaceIds: readonly string[]): boolean {
  if (isServerDisabled(doc, server.serverName)) return false
  return workspaceIds.some((workspaceId) => isEnabled(doc.overrides, workspaceId, server.serverName))
}

/**
 * Whether the state needs the user's attention: failed, or one of the two
 * passive waits the user has to resolve (missing credentials / browser
 * authorization). Everything else is self-driving.
 */
export function needsAttention(state: RuntimePhase | undefined): boolean {
  return state === 'failed' || state === 'waiting-credentials' || state === 'waiting-authorization'
}

/**
 * Rows retained after the document stopped naming the server: the host keeps
 * them while their teardown is unconfirmed (E7 "removed, cleanup pending").
 * Host array order is preserved by the snapshot map.
 */
export function detachedRuntimeViews(snapshot: RuntimeSnapshot): readonly ServerRuntimeView[] {
  return Object.values(snapshot.servers).filter((view) => view.configured === false)
}

type ViewFieldChecks = {
  [K in keyof Required<ServerRuntimeView>]: (a: ServerRuntimeView, b: ServerRuntimeView) => boolean
}

/**
 * The nested attempt-view comparator, also mapped: `RuntimeAuthorizationView`
 * is a wire object, so a NEW field inside it must fail the build until it is
 * compared here. Hand-listing id/phase/url would silently swallow the additive
 * `failure` field — the host can move a failed attempt from timeout to cleanup
 * WITHOUT changing id or phase, and a swallowed change would leave every
 * `useRuntime` consumer on the stale attempt view.
 */
type AuthorizationFieldChecks = {
  [K in keyof Required<RuntimeAuthorizationView>]: (
    a: RuntimeAuthorizationView,
    b: RuntimeAuthorizationView,
  ) => boolean
}

const AUTHORIZATION_VIEW_FIELDS: AuthorizationFieldChecks = {
  id: (a, b) => a.id === b.id,
  phase: (a, b) => a.phase === b.phase,
  authorizationUrl: (a, b) => a.authorizationUrl === b.authorizationUrl,
  // The UI renders the attempt PHASE and URL only (the detail never paints a
  // failure reason today), but the comparator still compares the fixed
  // identity: equality is what the store publishes, so a same-id/same-phase
  // reason change must repaint instead of being masked (and a future label can
  // rely on it). No locale map is needed while nothing renders it.
  failure: (a, b) => a.failure === b.failure,
}

/** Field-by-field equality of one (possibly absent) attempt view. */
function authorizationViewsEqual(
  a: RuntimeAuthorizationView | undefined,
  b: RuntimeAuthorizationView | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return (Object.keys(AUTHORIZATION_VIEW_FIELDS) as Array<keyof AuthorizationFieldChecks>)
    .every((field) => AUTHORIZATION_VIEW_FIELDS[field](a, b))
}

/**
 * Per-field comparator table: the mapped type makes a NEW wire field a compile
 * error until it is compared here (a forgotten field would silently suppress
 * the repaint that shows it).
 */
const SERVER_VIEW_FIELDS: ViewFieldChecks = {
  name: (a, b) => a.name === b.name,
  phase: (a, b) => a.phase === b.phase,
  configured: (a, b) => a.configured === b.configured,
  attempts: (a, b) => a.attempts === b.attempts,
  maxAttempts: (a, b) => a.maxAttempts === b.maxAttempts,
  nextRetryAt: (a, b) => a.nextRetryAt === b.nextRetryAt,
  connectedAt: (a, b) => a.connectedAt === b.connectedAt,
  syncedAt: (a, b) => a.syncedAt === b.syncedAt,
  toolCount: (a, b) => a.toolCount === b.toolCount,
  authReason: (a, b) => a.authReason === b.authReason,
  error: (a, b) => a.error?.code === b.error?.code,
  authorization: (a, b) => authorizationViewsEqual(a.authorization, b.authorization),
}

/** Field-by-field equality of one server's runtime view (every wire field). */
function serverViewEqual(a: ServerRuntimeView, b: ServerRuntimeView): boolean {
  return (Object.keys(SERVER_VIEW_FIELDS) as Array<keyof ViewFieldChecks>).every((field) => SERVER_VIEW_FIELDS[field](a, b))
}

/**
 * Value equality for two runtime snapshots, ignoring the wall-clock at field.
 * The section subscribes through this comparator so an unchanged 10 s poll does
 * not re-render the whole page (and a changed authorization URL/attempt phase
 * DOES repaint).
 */
export function runtimeSnapshotsEqual(
  left: RuntimeSnapshot,
  right: RuntimeSnapshot,
): boolean {
  if (left === right) return true
  if (left.phase !== right.phase || left.error !== right.error) return false
  const leftKeys = Object.keys(left.servers)
  const rightKeys = Object.keys(right.servers)
  if (leftKeys.length !== rightKeys.length) return false
  for (const name of leftKeys) {
    const a = left.servers[name]
    const b = right.servers[name]
    if (a === undefined || b === undefined) return false
    if (!serverViewEqual(a, b)) return false
  }
  return true
}

/** Local clock label for a sync timestamp (locale formatting, no fixed zone). */
export function clockOf(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) return undefined
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return undefined
  }
}
