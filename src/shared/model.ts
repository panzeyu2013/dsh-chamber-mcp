/**
 * Shared pure model of the dsh-mcp-scope settings namespace. No runtime
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
}

export interface StreamableHttpServerDef {
  serverName: string
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Request-header rows; values come from the credentials domain. */
  headers?: { name: string; ref: string }[]
}

export type ServerDef = StdioServerDef | StreamableHttpServerDef

/** Per-workspace explicit off-switches: overrides[w][serverName] === true ⇔ off. */
export type WorkspaceOverrides = Record<string, Record<string, true>>

/** Resolved settings-document shape (schema defaults ← base ← user layer). */
export interface McpScopeDoc {
  servers: ServerDef[]
  overrides: WorkspaceOverrides
}

/**
 * Frozen empty document. Runtime-frozen (strict-mode writes throw); typed as
 * the mutable shape because it is consumed as a schema/installSection entry
 * and every writer copies before mutating.
 */
export const EMPTY_DOC: McpScopeDoc = Object.freeze({
  servers: Object.freeze([]),
  overrides: Object.freeze({}),
}) as unknown as McpScopeDoc

/** Default-on evaluation: no record ⇒ enabled (new servers & workspaces on). */
export function isEnabled(overrides: WorkspaceOverrides, workspaceId: string, serverName: string): boolean {
  const row = overrides[workspaceId]
  return row === undefined || row[serverName] === undefined
}

/**
 * Remove a server from every workspace's off-switch rows, pruning rows that
 * become empty. Used by removal flows so a removed server cannot resurrect
 * as "off" through an orphaned row when it is later re-added.
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
      errors.push(`server "${server.serverName}": reserved name (would break the per-workspace off-switch)`)
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
        if (header.name === '') errors.push(`server "${server.serverName}": header name must not be empty`)
        if (names.has(header.name)) errors.push(`server "${server.serverName}": header "${header.name}" listed twice`)
        names.add(header.name)
        if (!CREDENTIAL_REF_PATTERN.test(header.ref)) {
          errors.push(`server "${server.serverName}": header ref "${header.ref}" must match ${CREDENTIAL_REF_PATTERN}`)
        }
      }
    }
  }
  return errors
}
