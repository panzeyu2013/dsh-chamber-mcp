/**
 * Shared pure model of the dsh-chamber-mcp settings namespace. No runtime
 * dependencies beyond the zero-import defaults table — imported by both the
 * host half and the browser half.
 *
 * The single source of the DOCUMENT row shape, the defaults table, the
 * identifier regexes, the upstream-named field vocabulary, the
 * credential-template value space/parser and normalizeServerDef is
 * ./defaults.ts; the row types are re-exported (aliased) here, never declared
 * twice. This module adds only what is genuinely shared ON TOP of that source:
 *
 * - the document envelope (McpScopeDoc) and the enablement/off-switch maps;
 * - the pure document helpers (dedupe/prune/canonicalize/enablement) and the
 *   validation rules (validateDoc) the editor runs before a write;
 * - the model-facing name/identity vocabulary (MCP_TOOL_PREFIX, the public-name
 *   cap and the tools-prefix hash suffix shared with the client).
 *
 * Both transports keep their legacy envKeys / {name,ref} header rows on the
 * canonical row shape so read-compat input can be validated and handed to the
 * host adapter, which rewrites them to the upstream env/header
 * credential-template maps.
 *
 * Read-compat placement: the legacy timeoutMs name is BOTH declared in
 * src/schema.ts (the schema decode runs before canonicalDoc) AND translated by
 * normalizeServerDef inside canonicalDoc, so a legacy settings.yaml profile row
 * cannot lose its timeout on the way in.
 *
 * @module
 */

import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  LEGACY_TIMEOUT_FIELD,
  MAX_TIMER_DELAY_MS,
  OAUTH_CREDENTIAL_KEY_PATTERN,
  RECONNECT_DEFAULTS,
  SERVER_NAME_PATTERN,
  TOOL_LOADING_MODES,
  credentialRefsIn,
  credentialTemplateFor,
  isExactCredentialToken,
  isToolLoading,
  normalizeServerDef,
  templateOccurrencesIn,
  templatedValuesOf,
  templatesAreExpanded,
  type ServerDef,
  type ServerHeaderRow,
  type StdioServerDef,
  type StreamableHttpServerDef,
} from './defaults.js'

// The shared vocabulary below is re-exported from the ONE source (./defaults.ts)
// under the model module's historical names; no constant or regex is declared
// twice. templateFor is the model-facing alias of the shared token composer
// (host-config additionally validates the ref before emitting).
export {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  MAX_TIMER_DELAY_MS,
  RECONNECT_DEFAULTS,
  SERVER_DEFAULTS,
  SERVER_NAME_PATTERN,
  TOOL_LOADING_MODES,
  credentialRefsIn,
  hasCredentialTemplate,
  isToolLoading,
  normalizeServerDef,
  templateOccurrencesIn,
  templatedValuesOf,
} from './defaults.js'
export { credentialTemplateFor as templateFor } from './defaults.js'
export { CREDENTIAL_TOKEN_SOURCE, TEMPLATE_OCCURRENCE_SOURCE } from './defaults.js'
export type {
  OAuthServerDef,
  ReconnectConfig,
  ServerDef,
  ServerHeaderRow,
  ServerKnobDef,
  StdioServerDef,
  StreamableHttpServerDef,
  ToolLoading,
} from './defaults.js'

/** Settings namespace registered by the host plugin and bound by the UI. */
export const MCP_SCOPE_NAMESPACE = 'mcp-scope'

/**
 * Public tool-name prefix of the official mcp__<serverName>__<rawName> contract.
 * Shared so the browser half can recognise MCP tools in the model-facing
 * request header without importing host code (the host build imports
 * node:crypto, which must never reach the client bundle) and so the applier can
 * attribute an upstream-built on-demand definition to its server.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** DeepSeek function-name contract: at most 64 characters. */
export const MAX_PUBLIC_NAME_LENGTH = 64

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
export const HASH_LENGTH = 12

/**
 * The identity suffix a lossy-normalized public name carries: underscore + 12
 * hex chars. Only meaningful together with MAX_PUBLIC_NAME_LENGTH (the
 * normalized name is truncated to the cap), because a raw MCP tool name may
 * legitimately end the same way.
 */
export const HASH_SUFFIX_PATTERN = new RegExp('_[0-9a-f]{' + HASH_LENGTH + '}$')

// The document row types (StdioServerDef / StreamableHttpServerDef / ServerDef)
// are the canonical row types declared by the ONE defaults module and re-exported
// (type-level only) from './defaults.js' above. The legacy credential containers
// (envKeys, {name,ref} header rows) stay on the row so read-compat documents can
// be validated and handed to src/host-config.ts, which rewrites them to the
// upstream credential-template env/header maps. New writes use the env/headers
// maps of ./defaults.ts.

/**
 * Per-workspace explicit ENABLES: overrides[w][serverName] === true means that
 * server is ON in that workspace. ABSENCE is the default, and the default is
 * OFF: a new server, a new workspace and a fresh session register no MCP tools
 * until the user turns them on. The record's PRESENCE is the signal (the value
 * stays true) so the dict-of-dicts shape keeps one switch = one atomic path op
 * (set/unset ['overrides', w, serverName]).
 */
export type WorkspaceOverrides = Record<string, Record<string, true>>

/**
 * Explicit global off-switches, keyed by serverName: presence (own property) of
 * true means that server is disabled everywhere (a hard kill that no workspace
 * enable can override). Like overrides, this is a sparse map so one switch is
 * ONE atomic path op (set/unset ['disabled', serverName]) instead of a
 * whole-array rewrite.
 */
export type DisabledServers = Record<string, true>

/** Smallest accepted millisecond budget (upstream schemas require >= 1). */
const TIMEOUT_BUDGET_MIN_MS = 1

/** Resolved settings-document shape (schema defaults ← base ← user layer). */
export interface McpScopeDoc {
  servers: ServerDef[]
  overrides: WorkspaceOverrides
  /**
   * Global off-switches. Optional on the type (older documents and most
   * constructions omit it) but always materialized by the schema, the decoder
   * and every writer; absent means empty.
   */
  disabled?: DisabledServers
}

/**
 * Frozen empty document. Runtime-frozen (strict-mode writes throw); typed as the
 * mutable shape because it is consumed as a schema/Config entry and every writer
 * copies before mutating.
 */
export const EMPTY_DOC: McpScopeDoc = Object.freeze({
  servers: Object.freeze([]),
  overrides: Object.freeze({}),
  disabled: Object.freeze({}),
}) as unknown as McpScopeDoc

/** A plain JSON object (arrays and null excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Prune enable rows that hold nothing: an explicit false/malformed value and a
 * row left empty by a toggle-off both carry no enablement (the record's PRESENCE
 * is the signal). Rows land through Object.fromEntries: assigning a workspace
 * literally named __proto__ would set the prototype and silently drop the row.
 */
export function pruneEmptyOverrideRows(overrides: WorkspaceOverrides): WorkspaceOverrides {
  const rows = new Map<string, Record<string, true>>()
  for (const [workspaceId, row] of Object.entries(overrides)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const rest: Record<string, true> = {}
    for (const [name, value] of Object.entries(row)) {
      if (value === true) rest[name] = true
    }
    if (Object.keys(rest).length > 0) rows.set(workspaceId, rest)
  }
  return Object.fromEntries(rows) as WorkspaceOverrides
}

/**
 * Canonical document shape from any decoded value: non-object server rows are
 * dropped (the schema union admits every object shape), each surviving row goes
 * through the ONE defaults normalizer (legacy timeoutMs becomes
 * toolCallTimeoutMs, upstream env/headers maps are preferred, unknown row fields
 * are dropped — the whitelist policy), a duplicate serverName keeps the LAST
 * definition (the same one the mounted instance ends up running), enable rows
 * are pruned to their true entries and disabled keys to their own true entries.
 *
 * A row the normalizer cannot classify (typod transport, missing serverName) is
 * kept verbatim so validateDoc can report it instead of silently losing user
 * data.
 *
 * The host read path, the browser decoder and the landed-write comparison all
 * normalize through here so every layer addresses ONE shape.
 */
export function canonicalDoc(raw: unknown): McpScopeDoc {
  if (!isRecord(raw)) return EMPTY_DOC
  const rawServers: unknown[] = Array.isArray(raw.servers) ? raw.servers : []
  const servers: ServerDef[] = []
  const at = new Map<string, number>()
  for (const row of rawServers) {
    if (!isRecord(row)) continue
    const normalized = normalizeServerDef(row)
    // The defaults normalizer emits the upstream-named shape, which is a
    // superset of this document row shape (env/headers maps included). The
    // editor writes those maps, while hand-edited/imported documents may still
    // carry the legacy containers (read-compat only).
    const candidate = (normalized ?? row) as ServerDef
    const name = (candidate as { serverName?: unknown }).serverName
    if (typeof name === 'string') {
      const seen = at.get(name)
      if (seen !== undefined) {
        servers[seen] = candidate
        continue
      }
      at.set(name, servers.length)
    }
    servers.push(candidate)
  }
  const overrides = isRecord(raw.overrides)
    ? pruneEmptyOverrideRows(raw.overrides as unknown as WorkspaceOverrides)
    : {}
  return { servers, overrides, disabled: pruneDisabled(raw.disabled as DisabledServers | undefined) }
}

/**
 * Default-OFF evaluation: only an explicit per-workspace record enables a
 * server, so a new server, a new workspace and a fresh session all start with no
 * MCP tools registered until the user turns them on. Presence is OWN-property
 * presence: rows are plain objects and a serverName that collides with an
 * Object.prototype member (e.g. toString) must never read as an inherited
 * "enabled" record (pre-release F1).
 */
export function isEnabled(overrides: WorkspaceOverrides, workspaceId: string, serverName: string): boolean {
  if (!Object.hasOwn(overrides, workspaceId)) return false
  const row = overrides[workspaceId]
  return row !== null && typeof row === 'object' && Object.hasOwn(row, serverName)
}

/**
 * Global enablement: a serverName that has an OWN true entry in disabled is off
 * everywhere. Absence means not globally disabled: the server is allowed, and
 * isEnabled still decides whether any workspace enables it — mirroring that
 * function's own-property rule so prototype-member names keep working.
 */
export function isServerDisabled(doc: McpScopeDoc, serverName: string): boolean {
  const disabled = doc.disabled
  return disabled !== undefined && Object.hasOwn(disabled, serverName) && disabled[serverName] === true
}

/**
 * Keep only true entries of a decoded/raw global off-switch map. Returns the
 * input reference when nothing had to be dropped, so downstream no-op checks can
 * compare by identity.
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
  // Object.fromEntries defines OWN properties: a literal __proto__ key stays an
  // entry instead of silently becoming the prototype (F1 discipline).
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

/** Immutable doc-level form of setDisabledKey (off = disabled). */
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
 * empty. Used by removal flows so a removed server cannot resurrect as "enabled"
 * through an orphaned row when it is later re-added.
 */
export function removeServerOverrides(overrides: WorkspaceOverrides, serverName: string): WorkspaceOverrides {
  let changed = false
  const entries: [string, Record<string, true>][] = []
  for (const [workspaceId, row] of Object.entries(overrides)) {
    const rest: Record<string, true> = {}
    for (const name of Object.keys(row)) {
      if (name !== serverName) rest[name] = true
      else changed = true
    }
    if (Object.keys(rest).length > 0) entries.push([workspaceId, rest])
  }
  // Object.fromEntries defines OWN properties: a literal __proto__ workspace
  // stays a row instead of silently becoming the prototype.
  return changed ? (Object.fromEntries(entries) as WorkspaceOverrides) : overrides
}

/**
 * Object-key names that must never be used as serverNames: overrides rows are
 * plain objects keyed by serverName with own-key presence semantics, and these
 * names would break the off-switch lookup (in/bracket reads on __proto__ etc.
 * resolve inherited members).
 */
export const RESERVED_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

// ---------------------------------------------------------------------------
// Credential-template projections. The ONE token finder, exact-token test,
// templated-value enumeration and expansion detection live in ./defaults.ts
// (zero imports, browser-safe) and are re-exported above under this module's
// historical names; only the composed document projections stay here.
// ---------------------------------------------------------------------------

/**
 * All credential refs a server definition references, de-duplicated in stable
 * order, read through the ONE templated-value space. The walker decides which
 * legacy containers count (the adapter-emission rule: the env/headers MAP wins
 * over a legacy envKeys/{name,ref} container, so an ignored legacy row cannot
 * make an orphaned ref look used), and this function only de-duplicates the
 * tokens of the values it yields.
 *
 * Refs are names, never values: this is the ref filter used by credential
 * rotation, orphan cleanup and the browser "server uses this credential" view.
 */
export function credentialRefsOf(server: ServerDef): string[] {
  const refs: string[] = []
  for (const { value } of templatedValuesOf(server)) {
    for (const ref of credentialRefsIn(value)) {
      if (ref !== '' && !refs.includes(ref)) refs.push(ref)
    }
  }
  return refs
}

// ---------------------------------------------------------------------------
// Document validation (the editor's pre-write gate; the host read path never
// throws and host.validate stays the mount-time authority).
// ---------------------------------------------------------------------------

/** Whether a millisecond budget is a positive integer within one Node timer. */
function isBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= TIMEOUT_BUDGET_MIN_MS && value <= MAX_TIMER_DELAY_MS
}

/** Whether a value is a finite positive number within one Node timer (upstream reconnect/oauth grammar). */
function isFiniteDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= MAX_TIMER_DELAY_MS
}

/** One server's transport-independent knob fields; appends human-readable errors. */
function validateKnobs(serverName: string, server: ServerDef, errors: string[]): void {
  for (const field of ['toolCallTimeoutMs', 'startupTimeoutMs', 'closeTimeoutMs'] as const) {
    const value = server[field]
    if (value !== undefined && !isBudget(value)) {
      errors.push(
        'server "' + serverName + '": ' + field + ' must be an integer between ' + TIMEOUT_BUDGET_MIN_MS + ' and ' + MAX_TIMER_DELAY_MS,
      )
    }
  }
  // Deprecated read-compat alias: still validated while a document carries it,
  // so a legacy timeout cannot silently degrade to the default.
  const legacy = (server as unknown as Record<string, unknown>)[LEGACY_TIMEOUT_FIELD]
  if (legacy !== undefined && !isBudget(legacy)) {
    errors.push(
      'server "' + serverName + '": ' + LEGACY_TIMEOUT_FIELD + ' must be an integer between ' + TIMEOUT_BUDGET_MIN_MS + ' and ' + MAX_TIMER_DELAY_MS,
    )
  }
  if (server.toolLoading !== undefined && !isToolLoading(server.toolLoading)) {
    const modes = TOOL_LOADING_MODES.map((mode) => '"' + mode + '"').join(', ')
    errors.push('server "' + serverName + '": toolLoading must be one of ' + modes)
  }
  if (server.reconnect !== undefined) validateReconnect(serverName, server.reconnect, errors)
  if (server.transport === 'streamable-http' && server.oauth !== undefined) {
    validateOAuth(serverName, server.oauth, server, errors)
  }
  if (server.transport === 'stdio' && (server as { oauth?: unknown }).oauth !== undefined) {
    errors.push('server "' + serverName + '": oauth is supported only on streamable-http servers')
  }
}

/** Reconnect policy validation, mirroring upstream resolveReconnectPolicy. */
function validateReconnect(serverName: string, reconnect: unknown, errors: string[]): void {
  if (!isRecord(reconnect)) {
    errors.push('server "' + serverName + '": reconnect must be an object')
    return
  }
  for (const key of Object.keys(reconnect)) {
    if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) {
      errors.push('server "' + serverName + '": reconnect.' + key + ' is not a reconnect option')
    }
  }
  if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') {
    errors.push('server "' + serverName + '": reconnect.enabled must be a boolean')
  }
  for (const field of ['initialDelayMs', 'maxDelayMs'] as const) {
    const value = reconnect[field]
    if (value !== undefined && !isFiniteDelay(value)) {
      errors.push('server "' + serverName + '": reconnect.' + field + ' must be a positive number no greater than ' + MAX_TIMER_DELAY_MS)
    }
  }
  if (reconnect.maxAttempts !== undefined) {
    const attempts = reconnect.maxAttempts
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
      errors.push('server "' + serverName + '": reconnect.maxAttempts must be a positive integer')
    }
  }
  // Judged with the defaults merged (upstream resolves absent fields first).
  const initial = reconnect.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const max = reconnect.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  if (typeof initial === 'number' && typeof max === 'number' && initial > max) {
    errors.push('server "' + serverName + '": reconnect.initialDelayMs must be less than or equal to reconnect.maxDelayMs')
  }
}

/** OAuth block validation (data model only; the host OAuth schema is the mount authority). */
function validateOAuth(
  serverName: string,
  oauth: unknown,
  server: StreamableHttpServerDef,
  errors: string[],
): void {
  if (!isRecord(oauth)) {
    errors.push('server "' + serverName + '": oauth must be an object')
    return
  }
  const credentialKey = oauth.credentialKey
  if (credentialKey !== undefined) {
    if (typeof credentialKey !== 'string' || !OAUTH_CREDENTIAL_KEY_PATTERN.test(credentialKey)) {
      errors.push('server "' + serverName + '": oauth.credentialKey must match ' + OAUTH_CREDENTIAL_KEY_PATTERN)
    }
  }
  if (oauth.clientId !== undefined && (typeof oauth.clientId !== 'string' || !/\S/.test(oauth.clientId))) {
    errors.push('server "' + serverName + '": oauth.clientId must be a non-empty string')
  }
  if (oauth.scope !== undefined && typeof oauth.scope !== 'string') {
    errors.push('server "' + serverName + '": oauth.scope must be a string')
  }
  for (const field of ['requestTimeoutMs', 'authorizationTimeoutMs'] as const) {
    const value = oauth[field]
    if (value !== undefined && !isFiniteDelay(value)) {
      errors.push('server "' + serverName + '": oauth.' + field + ' must be a positive number no greater than ' + MAX_TIMER_DELAY_MS)
    }
  }
  // The mounted host refuses OAuth beside an Authorization header (upstream
  // hasOAuthWithAuthorizationHeader) — reject at save time, never after save.
  const headers: unknown = server.headers
  const names = Array.isArray(headers)
    ? (headers as readonly ServerHeaderRow[]).map((row) => row.name)
    : isRecord(headers) ? Object.keys(headers) : []
  if (names.some((name) => name.toLowerCase() === 'authorization')) {
    errors.push('server "' + serverName + '": oauth and an Authorization header cannot be configured together')
  }
}

/**
 * Wire-document guard used by the host validate hook and by the UI before
 * writes. Error strings are human copy for the editor; the host read path never
 * throws.
 *
 * Unknown-field policy: row-level unknown fields are dropped by the one defaults
 * normalizer (whitelist, so every layer addresses one shape) and cannot be seen
 * here except where a container is intentionally kept verbatim — the reconnect
 * object — whose unknown keys ARE reported. Unknown top-level keys are ignored
 * (the Config schema owns the document envelope).
 */
export function validateDoc(doc: McpScopeDoc): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const server of doc.servers) {
    if (server === null || typeof server !== 'object') continue
    const serverName: unknown = (server as { serverName?: unknown }).serverName
    const label = typeof serverName === 'string' ? serverName : String(serverName)
    if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
      errors.push('server "' + label + '": name must match ' + SERVER_NAME_PATTERN)
    } else {
      if (RESERVED_OVERRIDE_KEYS.has(serverName)) {
        errors.push('server "' + serverName + '": reserved name (would break the per-workspace enable record)')
      }
      if (seen.has(serverName)) errors.push('server "' + serverName + '": duplicate serverName')
      seen.add(serverName)
    }
    const transport: unknown = (server as { transport?: unknown }).transport
    if (transport === 'stdio') {
      validateStdio(label, server as StdioServerDef, errors)
    } else if (transport === 'streamable-http') {
      validateHttp(label, server as StreamableHttpServerDef, errors)
    } else {
      errors.push('server "' + label + '": transport must be "stdio" or "streamable-http"')
      continue
    }
    validateKnobs(label, server as ServerDef, errors)
    validateTemplateTrap(label, server as ServerDef, errors)
  }
  return errors
}

/** One stdio row's transport-specific rules (legacy env rows + new env map). */
function validateStdio(serverName: string, server: StdioServerDef, errors: string[]): void {
  if (server.command === undefined || server.command === '') {
    errors.push('server "' + serverName + '": command is required')
  }
  const keys = Array.isArray(server.envKeys) ? server.envKeys : []
  const refs = new Set<string>()
  for (const key of keys) {
    if (!CREDENTIAL_REF_PATTERN.test(key)) {
      errors.push('server "' + serverName + '": env key "' + key + '" must match ' + CREDENTIAL_REF_PATTERN)
    }
    if (refs.has(key)) errors.push('server "' + serverName + '": env key "' + key + '" listed twice')
    refs.add(key)
  }
}

/** One streamable-http row's transport-specific rules (legacy header rows + new map). */
function validateHttp(serverName: string, server: StreamableHttpServerDef, errors: string[]): void {
  if (server.url === undefined || server.url === '') {
    errors.push('server "' + serverName + '": url is required')
  }
  const headers: unknown = server.headers
  if (Array.isArray(headers)) {
    const names = new Set<string>()
    for (const header of headers as readonly ServerHeaderRow[]) {
      if (!HEADER_NAME_PATTERN.test(header.name)) {
        errors.push('server "' + serverName + '": header name "' + header.name + '" is not a valid HTTP field name')
      }
      if (names.has(header.name)) errors.push('server "' + serverName + '": header "' + header.name + '" listed twice')
      names.add(header.name)
      if (!CREDENTIAL_REF_PATTERN.test(header.ref)) {
        errors.push('server "' + serverName + '": header ref "' + header.ref + '" must match ' + CREDENTIAL_REF_PATTERN)
      }
    }
  } else if (isRecord(headers)) {
    // The new map form: map keys are unique by construction but must still be
    // legal HTTP field names (the mounted transport would refuse them).
    for (const name of Object.keys(headers)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        errors.push('server "' + serverName + '": header name "' + name + '" is not a valid HTTP field name')
      }
    }
  }
}

/**
 * The template trap: the host adapter derives expandTemplates=true as soon as
 * the emitted value space carries one credential token (a legacy container
 * forces a generated one), and the mounted client then refuses any
 * brace-delimited dollar occurrence that is not exactly a token. A literal shell
 * expression anywhere the adapter emits (command/args/cwd/url AND an env/header
 * map value) would therefore fail AFTER save as failed{load} — reject it at
 * validation time instead. A server with no token at all keeps literal braces
 * (documented deviation).
 *
 * The walk is the SAME templated-value space the adapter emits: free values are
 * the document-supplied strings (the ones that can smuggle a non-token), while a
 * generated legacy template is a well-formed token by construction.
 */
function validateTemplateTrap(serverName: string, server: ServerDef, errors: string[]): void {
  if (!templatesAreExpanded(server)) return
  for (const { field, value, kind } of templatedValuesOf(server)) {
    if (kind === 'generated') continue
    for (const occurrence of templateOccurrencesIn(value)) {
      if (isExactCredentialToken(occurrence)) continue
      errors.push(
        'server "' + serverName + '": ' + field + ' contains ' + JSON.stringify(occurrence) + ', which is not a template token — use ' + credentialTemplateFor('REF'),
      )
    }
  }
}
