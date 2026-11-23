/**
 * Pure host status/classification helpers (host half).
 *
 * Extracted from `manager.ts` so the fixed-error classifiers, the bounded
 * tool-list cap, the document last-wins lookup and the status projection are
 * unit-testable (and reviewable) without a live manager, seat or service. Every
 * function here is deterministic and total: plain values in, wire values out —
 * no I/O, no service lookup, no upstream diagnostic text on the wire.
 *
 * The manager, the OAuth module and the spec suites import these entry points
 * from here directly (the manager no longer re-exports them).
 *
 * @module
 */

import type { McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  RuntimeErrorCode,
  RuntimeTestCode,
  ServerRuntimeView,
  ToolListView,
} from './shared/wire.js'
import type { OAuthAttemptView, OAuthReason } from './shared/oauth.js'
import type { ServerDef } from './shared/model.js'
import { RECONNECT_DEFAULTS } from './shared/defaults.js'
import { HostConfigError } from './host-config.js'
import { InvalidCredentialValueError, SeamMismatchError } from './facade.js'
import { safeErrorText } from './log.js'

/** Caps of the tool-list wire shape (SEC: bounded response, no schema bodies). */
export const TOOL_LIST_MAX = 200
const TOOL_NAME_MAX = 200
const TOOL_DESCRIPTION_MAX = 500

/**
 * Classify a seat/instance activation failure into a fixed wire code. Display
 * only: the upstream text stays host-side (classified, never forwarded).
 *
 * @param error - the activation rejection.
 * @returns the fixed wire error code.
 */
export function classifyActivationFailure(error: unknown): RuntimeErrorCode {
  if (error instanceof HostConfigError) return 'config'
  if (error instanceof SeamMismatchError) return 'seam'
  if (error instanceof InvalidCredentialValueError) return 'invalid-credential'
  const text = safeErrorText(error)
  if (/already in use by another mcp-client instance/i.test(text)) return 'conflict'
  if (/cleanup is incomplete/i.test(text)) return 'cleanup'
  if (/initial connection or tool synchronization failed/i.test(text)) return 'load'
  if (/server name must match|is not a .* option|must be a positive integer|must be a positive finite|invalid config/i.test(text)) return 'config'
  return 'load'
}

/**
 * Classify the `reconnecting` failure text into a fixed wire code. A
 * display-only classifier fed the mounted instance's diagnostic text.
 *
 * @param text - upstream failure text (host-side only).
 * @returns the fixed wire error code.
 */
export function classifyStatusError(text: string): RuntimeErrorCode {
  // The isolated credentials facade's fixed refusal (a value that must never
  // reach env/headers): retrying cannot resolve it.
  if (/invalid value \(CR\/LF\/NUL\)|InvalidCredentialValue/i.test(text)) return 'invalid-credential'
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(text)) return 'forbidden'
  if (/timed? out|timeout|ETIMEDOUT|aborted/i.test(text)) return 'timeout'
  if (/ENOENT|EACCES|EPERM|spawn/i.test(text)) return 'spawn-failed'
  if (/unexpected token|invalid json|parse error/i.test(text)) return 'protocol'
  return 'connection-failed'
}

/**
 * Classify an unexpected probe throw into a fixed test code.
 *
 * @param error - the probe rejection.
 * @returns the fixed test code.
 */
export function classifyTestFailure(error: unknown): RuntimeTestCode {
  if (error instanceof HostConfigError) return 'config'
  return 'internal'
}

/**
 * Classify one probe failure text into the wire's fixed test codes. An explicit
 * OAuth-required refusal is the one actionable case (the UI offers "Authorize");
 * every other failure keeps the runtime classifier.
 *
 * @param text - probe failure message (host-side only).
 * @returns the fixed test code.
 */
export function classifyProbeFailure(text: string): RuntimeTestCode {
  if (/MCP_AUTHORIZATION_REQUIRED|requires authorization/i.test(text)) return 'oauth-required'
  return classifyStatusError(text)
}

/**
 * Cap one committed eager tool generation for the wire: at most
 * {@link TOOL_LIST_MAX} entries, each name/description capped, no schema bodies.
 * Pure so the bounds are unit-testable without a live server.
 *
 * @param defs - the committed eager generation by public name.
 * @returns the bounded wire tool list with the true total count.
 */
export function capToolList(defs: ReadonlyMap<string, ToolDefinition>): ToolListView {
  const tools: Array<{ publicName: string; description: string }> = []
  let truncated = false
  for (const [name, definition] of defs) {
    if (tools.length >= TOOL_LIST_MAX) {
      truncated = true
      break
    }
    tools.push({
      // ADR-5 degradation: only the model-facing name crosses the wire.
      publicName: name.slice(0, TOOL_NAME_MAX),
      description: (definition.description ?? '').slice(0, TOOL_DESCRIPTION_MAX),
    })
  }
  return { mode: 'definitions', tools, truncated, total: defs.size }
}

/**
 * The last definition of one serverName in document order (the duplicate rule:
 * the last row wins). `canonicalDoc` deduplicates, so this is normally the only
 * row — the loop keeps the read path total for a hand-built/stored document.
 *
 * @param defs - the document's server rows.
 * @param serverName - the server to look up.
 * @returns the winning row, or undefined when the server is not configured.
 */
export function lastDefinitionOf(defs: readonly ServerDef[], serverName: string): ServerDef | undefined {
  let found: ServerDef | undefined
  for (const def of defs) {
    if (def.serverName === serverName) found = def
  }
  return found
}

/**
 * Index document rows by serverName with the same last-wins rule.
 *
 * @param defs - the document's server rows.
 * @returns serverName → winning row.
 */
export function definitionsByName(defs: readonly ServerDef[]): Map<string, ServerDef> {
  const byName = new Map<string, ServerDef>()
  for (const def of defs) byName.set(def.serverName, def)
  return byName
}

/**
 * The five upstream authorization reasons, or undefined for an unknown one.
 * A future/unknown reason is OMITTED rather than cast onto the frozen wire
 * union.
 *
 * @param reason - upstream authorization reason.
 * @returns the frozen wire reason, or undefined.
 */
export function wireAuthorizationReason(reason: unknown): OAuthReason | undefined {
  switch (reason) {
    case 'missing':
    case 'expired':
    case 'binding':
    case 'rejected':
    case 'scope':
      return reason
    default:
      return undefined
  }
}

/**
 * Plain-value projection of one tracked record, so {@link projectStatus} needs
 * no record (and therefore no manager state) itself.
 */
export interface StatusProjectionRecord {
  /** Attempt budget per outage from the resolved reconnect policy. */
  readonly maxAttempts: number
  /** Whether the record carries an unconfirmed teardown (cleanup guard wins). */
  readonly cleanupFailure: boolean
  /** Classified activation/seat failure of the record, if any. */
  readonly loadError: RuntimeErrorCode | undefined
  /** Seam-canary mismatch of the live generation, if any. */
  readonly seam: { readonly captured: number; readonly reported: number } | undefined
  /** Latest upstream connection status. */
  readonly status: McpConnectionStatus | undefined
  /** Epoch ms of the last capture publication. */
  readonly syncedAt: number | undefined
  /** Tool count of the last published capture generation. */
  readonly captureCount: number
}

/** Inputs of one deterministic status projection (all plain values). */
export interface StatusProjectionInput {
  /** Configured server name. */
  readonly serverName: string
  /** Tracked record projection, or undefined for a never-mounted server. */
  readonly record: StatusProjectionRecord | undefined
  /** Whether the live row is a streamable-http row with an OAuth block. */
  readonly oauthConfigured: boolean
  /** Whether the live row is globally disabled. */
  readonly disabled: boolean
  /** Whether the live row is still named by the document. */
  readonly configured: boolean
  /** Whether the manual-stop latch currently holds this server. */
  readonly manualStopped: boolean
  /** Token-free attempt view of the server (ignored when not OAuth-configured). */
  readonly authorization: OAuthAttemptView | undefined
}

/** Shared (phase-independent) fields of one projected view. */
type StatusBase = Omit<ServerRuntimeView, 'phase'>

/**
 * Deterministic wire projection of one server per the frozen status table.
 * Pure: the same input always yields the same view (including the
 * `?server=` filtered entry), and no upstream text can cross this boundary —
 * only fixed enums/codes.
 *
 * @param input - the plain-value projection inputs.
 * @returns the frozen wire view.
 */
export function projectStatus(input: StatusProjectionInput): ServerRuntimeView {
  const { serverName, record } = input
  const maxAttempts = record === undefined ? RECONNECT_DEFAULTS.maxAttempts : record.maxAttempts
  // The current/last token-free attempt view comes from the authorization
  // registry, which refuses to serve a view from a stale binding fingerprint.
  // Every phase carries it when one exists: a disabled OAuth server is still
  // authorizable, so its attempt must stay observable.
  const authorization = input.oauthConfigured ? input.authorization : undefined
  const base: StatusBase = {
    name: serverName,
    configured: input.configured,
    attempts: 0,
    maxAttempts,
    toolCount: 0,
    ...(authorization === undefined ? {} : { authorization }),
  }
  if (input.disabled) return { ...base, phase: 'disabled' }
  if (record === undefined) return { ...base, phase: 'unknown' }
  // An unconfirmed teardown outranks the manual-stop latch: the operator asked
  // for a stop, but the host could not confirm it, so the row is a failure.
  if (record.cleanupFailure) {
    return { ...base, phase: 'failed', error: { code: 'cleanup' } }
  }
  if (input.manualStopped) return { ...base, phase: 'stopped' }
  if (record.loadError !== undefined) {
    return { ...base, phase: 'failed', error: { code: record.loadError } }
  }
  if (record.seam !== undefined) {
    return { ...base, phase: 'failed', toolCount: record.seam.reported, error: { code: 'seam' } }
  }
  const status = record.status
  if (status === undefined) return { ...base, phase: 'unknown' }
  // The base already carries every phase-independent field (including the
  // attempt view); a synced generation adds the one host timestamp and the
  // switch below only overrides per-phase fields (one spread site, so no branch
  // can silently drop the attempt view).
  const statusBase: StatusBase = record.syncedAt === undefined ? base : { ...base, syncedAt: record.syncedAt }
  switch (status.state) {
    case 'closed':
      return { ...statusBase, phase: 'stopped' }
    case 'waiting-credentials':
      return { ...statusBase, phase: 'waiting-credentials' }
    case 'waiting-authorization': {
      // The five upstream reasons are whitelisted; an unknown/future reason is
      // omitted rather than cast onto the frozen wire union.
      const authReason = wireAuthorizationReason(status.reason)
      return {
        ...statusBase,
        phase: 'waiting-authorization',
        ...(authReason === undefined ? {} : { authReason }),
      }
    }
    case 'connecting':
      return {
        ...statusBase,
        phase: 'connecting',
        attempts: status.attempt,
        toolCount: record.captureCount,
      }
    case 'connected':
      return {
        ...statusBase,
        phase: 'connected',
        toolCount: status.toolCount,
        connectedAt: status.connectedAt,
      }
    case 'reconnecting':
      if (classifyStatusError(status.lastError) === 'invalid-credential') {
        // The isolated credentials facade refuses a CR/LF/NUL value on every
        // attempt; retrying cannot fix it, so surface the actionable phase.
        return { ...statusBase, phase: 'waiting-credentials' }
      }
      return {
        ...statusBase,
        phase: 'reconnecting',
        attempts: status.attempt,
        maxAttempts: status.maxAttempts,
        nextRetryAt: status.nextRetryAtMs,
        toolCount: record.captureCount,
        error: { code: classifyStatusError(status.lastError) },
      }
    case 'failed':
      switch (status.reason) {
        case 'gave-up':
          // Exhaustion unregisters the tools upstream; the capture is empty.
          return { ...statusBase, phase: 'failed', error: { code: 'gave-up' } }
        case 'reconnect-disabled':
          return {
            ...statusBase,
            phase: 'failed',
            toolCount: record.captureCount,
            error: { code: 'reconnect-disabled' },
          }
        case 'unclosed-generation':
          return {
            ...statusBase,
            phase: 'failed',
            toolCount: record.captureCount,
            error: { code: 'generation-stuck' },
          }
        default:
          // Unknown future stop reason: degrade to a fixed load code, never to
          // a healthy phase (the wire union stays frozen).
          return { ...statusBase, phase: 'failed', error: { code: 'load' } }
      }
    default:
      // Unknown future status variant: degrade to a fixed load code.
      return { ...statusBase, phase: 'failed', error: { code: 'load' } }
  }
}
