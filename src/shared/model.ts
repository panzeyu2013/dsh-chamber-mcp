/**
 * Shared pure model of the dsh-chamber-mcp settings namespace. No runtime
 * dependencies — imported by both the host half and (type-only where possible)
 * the browser half.
 */

/** Settings namespace registered by the host plugin and bound by the UI. */
export const MCP_SCOPE_NAMESPACE = 'mcp-scope'

/** Cordis plugin name of the host entry (also the credentials record scope). */
export const MCP_SCOPE_PLUGIN_NAME = 'mcp-scope'

/** Official mcp-client serverName contract: /^[A-Za-z0-9_-]{1,32}$/. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** CredentialRef (env-var name) contract: /^[A-Za-z_][A-Za-z0-9_]*$/. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** HTTP field-name (token) contract per RFC 9110 tchar. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Public tool-name prefix of the official `mcp__<serverName>__<rawName>`
 * contract. Shared so the browser half can recognise MCP tools in the
 * model-facing request header without importing host code (the host build
 * imports `node:crypto`, which must never reach the client bundle).
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** DeepSeek function-name contract: at most 64 characters. */
export const MAX_PUBLIC_NAME_LENGTH = 64

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
export const HASH_LENGTH = 12

/**
 * The identity suffix a lossy-normalized public name carries: `_` + 12 hex
 * chars. Only meaningful together with {@link MAX_PUBLIC_NAME_LENGTH} (the
 * normalized name is truncated to the cap), because a raw MCP tool name may
 * legitimately end the same way.
 */
export const HASH_SUFFIX_PATTERN = new RegExp(`_[0-9a-f]{${HASH_LENGTH}}$`)

export interface StdioServerDef {
  serverName: string
  transport: 'stdio'
  /** Executable spawned directly (no shell). */
  command: string
  /** Arguments passed verbatim. */
  args?: string[]
  /** Working directory; empty/absent = inherit. */
  cwd?: string
  /** Credential refs whose resolved values are added to the child env. */
  envKeys?: string[]
  /**
   * Per-server request timeout in ms (tools/call + one tools/list page);
   * absent = {@link TIMEOUT_DEFAULT_MS} (official default). Bounded by
   * {@link TIMEOUT_MIN_MS}..{@link TIMEOUT_MAX_MS}.
   */
  timeoutMs?: number
}

export interface StreamableHttpServerDef {
  serverName: string
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Request-header rows; values come from the credentials domain. */
  headers?: { name: string; ref: string }[]
  /**
   * Per-server request timeout in ms (tools/call + one tools/list page);
   * absent = {@link TIMEOUT_DEFAULT_MS} (official default). Bounded by
   * {@link TIMEOUT_MIN_MS}..{@link TIMEOUT_MAX_MS}.
   */
  timeoutMs?: number
}

export type ServerDef = StdioServerDef | StreamableHttpServerDef

/**
 * Per-workspace explicit ENABLES: `overrides[w][serverName] === true` ⇔ that
 * server is ON in that workspace. ABSENCE is the default, and the default is
 * OFF: a new server, a new workspace and a fresh session register no MCP tools
 * until the user turns them on. The record's PRESENCE is the signal (the value
 * stays `true`) so the dict-of-dicts shape keeps one switch = one atomic path
 * op (`set/unset ['overrides', w, serverName]`).
 */
export type WorkspaceOverrides = Record<string, Record<string, true>>

/**
 * Explicit global off-switches, keyed by serverName: presence (own property)
 * of `true` ⇔ that server is disabled everywhere (a hard kill that no
 * workspace enable can override). Like `overrides`, this is a
 * dict-of-dicts-shaped sparse map so one switch is ONE atomic path op
 * (`set/unset ['disabled', serverName]`) instead of a whole-array rewrite.
 */
export type DisabledServers = Record<string, true>

/** Bounds of the per-server request timeout (ms). */
export const TIMEOUT_MIN_MS = 1_000
export const TIMEOUT_MAX_MS = 600_000
/** Official default used when a server defines no `timeoutMs`. */
export const TIMEOUT_DEFAULT_MS = 60_000

/** Resolved settings-document shape (schema defaults ← base ← user layer). */
export interface McpScopeDoc {
  servers: ServerDef[]
  overrides: WorkspaceOverrides
  /**
   * Global off-switches. Optional on the type (older documents and most
   * constructions omit it) but always materialized by the schema, the
   * decoder and every writer; absent ≡ empty.
   */
  disabled?: DisabledServers
}

/**
 * Frozen empty document. Runtime-frozen (strict-mode writes throw); typed as
 * the mutable shape because it is consumed as a schema/installSection entry
 * and every writer copies before mutating.
 */
export const EMPTY_DOC: McpScopeDoc = Object.freeze({
  servers: Object.freeze([]),
  overrides: Object.freeze({}),
  disabled: Object.freeze({}),
}) as unknown as McpScopeDoc

/**
 * Default-OFF evaluation: only an explicit per-workspace record enables a
 * server, so a new server, a new workspace and a fresh session all start with
 * no MCP tools registered until the user turns them on. Presence is OWN-property
 * presence: rows are plain objects and a serverName that collides with an
 * Object.prototype member (e.g. `toString`) must never read as an inherited
 * "enabled" record (pre-release F1).
 */
export function isEnabled(overrides: WorkspaceOverrides, workspaceId: string, serverName: string): boolean {
  if (!Object.hasOwn(overrides, workspaceId)) return false
  const row = overrides[workspaceId]
  return row !== null && typeof row === 'object' && Object.hasOwn(row, serverName)
}

/**
 * Global enablement: a serverName that has an OWN `true` entry in `disabled`
 * is off everywhere. Absence = not globally disabled: the server is allowed,
 * and {@link isEnabled} still decides whether any workspace enables it —
 * mirroring that function's own-property rule so prototype-member names keep
 * working.
 */
export function isServerDisabled(doc: McpScopeDoc, serverName: string): boolean {
  const disabled = doc.disabled
  return disabled !== undefined && Object.hasOwn(disabled, serverName) && disabled[serverName] === true
}

/**
 * Keep only `true` entries of a decoded/raw global off-switch map. Returns
 * the input reference when nothing had to be dropped, so downstream no-op
 * checks can compare by identity.
 */
export function pruneDisabled(disabled: DisabledServers | undefined): DisabledServers {
  if (disabled === undefined || disabled === null || typeof disabled !== 'object' || Array.isArray(disabled)) {
    return {}
  }
  let dropped = false
  const entries: [string, true][] = []
  for (const [name, value] of Object.entries(disabled)) {
    if (value === true) entries.push([name, true])
    else dropped = true
  }
  // Object.fromEntries defines OWN properties: a literal `__proto__` key stays
  // an entry instead of silently becoming the prototype (F1 discipline).
  return dropped ? (Object.fromEntries(entries) as DisabledServers) : disabled
}

/**
 * Set or clear one server's global off-switch. Returns the same reference when
 * nothing changes, so callers can cheaply detect no-ops.
 */
export function setDisabledKey(
  disabled: DisabledServers | undefined,
  serverName: string,
  off: boolean,
): DisabledServers {
  const current = pruneDisabled(disabled)
  if (off) {
    if (Object.hasOwn(current, serverName)) return current
    return { ...current, [serverName]: true }
  }
  if (!Object.hasOwn(current, serverName)) return current
  const next = { ...current }
  delete next[serverName]
  return next
}

/** Immutable doc-level form of {@link setDisabledKey} (`off` = disabled). */
export function setServerDisabled(doc: McpScopeDoc, serverName: string, off: boolean): McpScopeDoc {
  const current = pruneDisabled(doc.disabled)
  if (off === Object.hasOwn(current, serverName)) return doc // already in the requested state
  return { servers: doc.servers, overrides: doc.overrides, disabled: setDisabledKey(current, serverName, off) }
}

/** Drop a removed server's global off-switch so a re-add starts allowed (still off until a workspace enables it). */
export function removeServerDisabled(disabled: DisabledServers | undefined, serverName: string): DisabledServers {
  return setDisabledKey(disabled, serverName, false)
}

/** Carry one server's global off-switch across a rename (edit-with-rename). */
export function renameDisabledKey(
  disabled: DisabledServers | undefined,
  from: string,
  to: string,
): DisabledServers {
  const current = pruneDisabled(disabled)
  if (from === to || !Object.hasOwn(current, from)) return current
  const entries: [string, true][] = []
  for (const [name, value] of Object.entries(current)) {
    entries.push([name === from ? to : name, value])
  }
  return Object.fromEntries(entries) as DisabledServers
}

/**
 * Remove a server from every workspace's ENABLE rows, pruning rows that become
 * empty. Used by removal flows so a removed server cannot resurrect as
 * "enabled" through an orphaned row when it is later re-added.
 */
export function removeServerOverrides(overrides: WorkspaceOverrides, serverName: string): WorkspaceOverrides {
  let changed = false
  const next: WorkspaceOverrides = {}
  for (const [workspaceId, row] of Object.entries(overrides)) {
    const rest: Record<string, true> = {}
    for (const name of Object.keys(row)) {
      if (name !== serverName) rest[name] = true
      else changed = true
    }
    if (Object.keys(rest).length > 0) next[workspaceId] = rest
  }
  return changed ? next : overrides
}

/**
 * Object-key names that must never be used as serverNames: overrides rows are
 * plain objects keyed by serverName with own-key presence semantics, and
 * these names would break the off-switch lookup (`in`/bracket reads on
 * `__proto__` etc. resolve inherited members).
 */
export const RESERVED_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** All credential refs a server definition references. */
export function credentialRefsOf(server: ServerDef): string[] {
  return server.transport === 'stdio'
    ? (server.envKeys ?? [])
    : (server.headers ?? []).map((h) => h.ref)
}

/** Wire-document guard used by the host validate hook and by the UI before writes. */
export function validateDoc(doc: McpScopeDoc): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const server of doc.servers) {
    if (!SERVER_NAME_PATTERN.test(server.serverName)) {
      errors.push(`server "${server.serverName}": name must match ${SERVER_NAME_PATTERN}`)
    }
    if (RESERVED_OVERRIDE_KEYS.has(server.serverName)) {
      errors.push(`server "${server.serverName}": reserved name (would break the per-workspace enable record)`)
    }
    if (seen.has(server.serverName)) errors.push(`server "${server.serverName}": duplicate serverName`)
    seen.add(server.serverName)
    if (server.transport === 'stdio') {
      if (server.command === undefined || server.command === '') {
        errors.push(`server "${server.serverName}": command is required`)
      }
      const keys = server.envKeys ?? []
      const refs = new Set<string>()
      for (const key of keys) {
        if (!CREDENTIAL_REF_PATTERN.test(key)) {
          errors.push(`server "${server.serverName}": env key "${key}" must match ${CREDENTIAL_REF_PATTERN}`)
        }
        if (refs.has(key)) errors.push(`server "${server.serverName}": env key "${key}" listed twice`)
        refs.add(key)
      }
    } else {
      if (server.url === undefined || server.url === '') {
        errors.push(`server "${server.serverName}": url is required`)
      }
      const names = new Set<string>()
      for (const header of server.headers ?? []) {
        if (!HEADER_NAME_PATTERN.test(header.name)) {
          errors.push(`server "${server.serverName}": header name "${header.name}" is not a valid HTTP field name`)
        }
        if (names.has(header.name)) errors.push(`server "${server.serverName}": header "${header.name}" listed twice`)
        names.add(header.name)
        if (!CREDENTIAL_REF_PATTERN.test(header.ref)) {
          errors.push(`server "${server.serverName}": header ref "${header.ref}" must match ${CREDENTIAL_REF_PATTERN}`)
        }
      }
    }
    if (server.timeoutMs !== undefined) {
      const timeout = server.timeoutMs
      if (!Number.isInteger(timeout) || timeout < TIMEOUT_MIN_MS || timeout > TIMEOUT_MAX_MS) {
        errors.push(
          `server "${server.serverName}": timeoutMs must be an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`,
        )
      }
    }
  }
  return errors
}
