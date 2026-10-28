/**
 * Pure view-model helpers shared by the settings views.
 *
 * Kept React-free and dependency-free so the list/detail/workspace components
 * stay small and the mappings are unit-testable.
 */

import {
  credentialRefsOf,
  isEnabled,
  isServerDisabled,
  type McpScopeDoc,
  type ServerDef,
} from '../shared/model.js'
import type { RuntimePhase, RuntimeSnapshot, ServerRuntimeView } from './runtime.js'
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

export type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

/** Locale key of one runtime phase. */
export function statusKeyOf(state: RuntimePhase): SettingsKey {
  switch (state) {
    case 'connected':
      return 'status.connected'
    case 'connecting':
      return 'status.connecting'
    case 'reconnecting':
      return 'status.reconnecting'
    case 'failed':
      return 'status.failed'
    case 'stopped':
      return 'status.stopped'
    case 'disabled':
      return 'status.disabled'
    case 'unknown':
      // The host reports 'unknown' for a server it has not reconciled yet
      // ("enabled but never tracked"). Saying "not started" here would claim
      // knowledge the plugin does not have.
      return 'status.unknown'
  }
}

/** Tone of one runtime phase (idle = neutral pill). */
export function statusToneOf(state: RuntimePhase): StatusTone {
  switch (state) {
    case 'connected':
      return 'ok'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    case 'failed':
      return 'error'
    default:
      return 'idle'
  }
}

/** Locale key of one runtime error code (undefined = keep the host message). */
export function runtimeErrorKey(code: string): SettingsKey | undefined {
  switch (code) {
    case 'connection-failed':
      return 'runtime.error.connection-failed'
    case 'gave-up':
      return 'runtime.error.gave-up'
    case 'reconnect-disabled':
      return 'runtime.error.reconnect-disabled'
    case 'generation-stuck':
      return 'runtime.error.generation-stuck'
    case 'forbidden':
      return 'runtime.error.forbidden'
    case 'timeout':
      return 'runtime.error.timeout'
    case 'spawn-failed':
      return 'runtime.error.spawn-failed'
    case 'protocol':
      return 'runtime.error.protocol'
    default:
      return undefined
  }
}

/** Localized text of one runtime error (fixed host codes never carry remote text). */
export function runtimeErrorText(
  t: TextSeat,
  error: { code: string; message: string },
): string {
  const key = runtimeErrorKey(error.code)
  return key !== undefined ? t(key) : error.message
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

/** Whether the state needs the user's attention (failed / reconnect exhausted). */
export function needsAttention(state: RuntimePhase | undefined): boolean {
  return state === 'failed'
}

/**
 * Value equality for two runtime snapshots, ignoring the wall-clock `at`
 * field. The section subscribes through this comparator so an unchanged 10 s
 * poll does not re-render the whole page.
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
    if (
      a.state !== b.state ||
      a.attempts !== b.attempts ||
      a.maxAttempts !== b.maxAttempts ||
      a.nextRetryAt !== b.nextRetryAt ||
      a.connectedAt !== b.connectedAt ||
      a.syncedAt !== b.syncedAt ||
      a.toolCount !== b.toolCount ||
      a.error?.code !== b.error?.code ||
      a.error?.message !== b.error?.message
    ) {
      return false
    }
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
