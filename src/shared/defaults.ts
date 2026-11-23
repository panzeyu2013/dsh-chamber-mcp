/**
 * Single source of the mcp-scope server defaults, field names, identifier
 * regexes, the canonical document-row types, the credential-template value
 * space/parser and the one document-row normalizer.
 *
 * **Zero imports — on purpose.** This module is shared by the host half and the
 * browser half (settings schema, `canonicalDoc`, the landed-write comparator,
 * the import/draft layer and the host config adapter). Keeping it free of
 * schemastery and of every `@deepseek-ai/*` value import keeps the browser
 * bundle pure and gives the document exactly ONE defaults table, so the UI, the
 * schema and the host can never disagree about what "default" means.
 *
 * The row types below are the canonical, upstream-named document shape, and
 * `src/shared/model.ts` re-exports them (aliases, never a second declaration).
 * The credential-template token finder / exact-token test / templated-value
 * enumeration / expansion detection below are the ONE value space of the
 * document↔upstream boundary: `model.ts` and `host-config.ts` are thin
 * wrappers over it (the host wrapper adds the HostConfigError taxonomy).
 *
 * @module
 */

/** Official mcp-client serverName contract: `/^[A-Za-z0-9_-]{1,32}$/`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** CredentialRef (env-var name / legacy row ref) contract: `[A-Za-z_][A-Za-z0-9_]*`. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** HTTP field-name (token) contract per RFC 9110 tchar. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** OAuth credential-record key grammar (browser-safe mirror; host re-validates). */
export const OAUTH_CREDENTIAL_KEY_PATTERN = /^mcp-client\/[a-z][a-z0-9-]*$/

/**
 * Control characters that must never reach a child env, an HTTP header, a
 * transport error string or a log line (SEC-02). Credential values containing
 * CR, LF or NUL are rejected on every resolve, by the credentials façade (the
 * single authority) and by the host-config diagnostics helper.
 */
export const INVALID_CREDENTIAL_VALUE_PATTERN = /[\r\n\0]/

/** `dsh-timeout` MAX_TIMER_DELAY_MS mirror; parity-tested, never imported (bundle purity). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Upstream default UTF-8 byte cap of attributed server instructions. */
const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

/** Upstream default character cap of one on-demand catalog tool summary. */
const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 160

/** Supported on-demand tool-loading modes. */
export type ToolLoading = 'eager' | 'on-demand'

/** The two supported tool-loading modes, in UI order. */
export const TOOL_LOADING_MODES: readonly ToolLoading[] = Object.freeze(['eager', 'on-demand'])

/** Whether a raw value is one of {@link TOOL_LOADING_MODES}. */
export function isToolLoading(value: unknown): value is ToolLoading {
  return value === 'eager' || value === 'on-demand'
}

/** Automatic reconnect policy for one MCP server connection (upstream shape). */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up (default 10). */
  maxAttempts?: number
}

/** Resolved reconnect policy (every field present). */
type ResolvedReconnectConfig = Readonly<Required<ReconnectConfig>>

/** Upstream reconnect defaults: 500 ms → 30 s, 10 attempts, enabled. */
export const RECONNECT_DEFAULTS: ResolvedReconnectConfig = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/**
 * The ONE server-defaults table. Every layer that needs a default reads it
 * here; a document never materializes these values (absent stays absent) — the
 * schema decode, `canonicalDoc` and the landed-write comparator compare the
 * UI's intended row with a host-resolved row through this table.
 */
interface ServerDefaults {
  /** Per tool call / resource request deadline (upstream default 60 s). */
  readonly toolCallTimeoutMs: number
  /** One connection attempt + initial tool sync budget. */
  readonly startupTimeoutMs: number
  /** Transport closure + local cleanup budget (upstream default 5 s). */
  readonly closeTimeoutMs: number
  /** Automatic reconnect policy defaults. */
  readonly reconnect: ResolvedReconnectConfig
  /** On-demand loading is opt-in; eager is the default. */
  readonly toolLoading: ToolLoading
  /** Per-tool catalog summary cap (upstream default 160). */
  readonly catalogDescriptionMaxLength: number
  /** Attributed-instructions byte cap (upstream default 32768). */
  readonly maxInstructionBytes: number
  /** Whether a failed first connection fails activation (we always mount with `false`). */
  readonly failOnStartupError: boolean
  /** Whether `${credential:…}` expansion is on (derived from the text, never stored). */
  readonly expandTemplates: boolean
  /** Default stdio arguments. */
  readonly args: readonly string[]
  /** Default stdio environment map. */
  readonly env: Readonly<Record<string, string>>
  /** Default HTTP header map. */
  readonly headers: Readonly<Record<string, string>>
  /** Default stdio working directory (upstream forwards the empty string). */
  readonly cwd: string
}

/**
 * Frozen defaults for every server field. This is the only defaults table:
 * schemastery defaults, the landed-write comparator and the host adapter all
 * read it.
 */
export const SERVER_DEFAULTS: ServerDefaults = Object.freeze({
  toolCallTimeoutMs: 60_000,
  startupTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
  reconnect: RECONNECT_DEFAULTS,
  toolLoading: 'eager',
  catalogDescriptionMaxLength: DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH,
  maxInstructionBytes: DEFAULT_MAX_INSTRUCTION_BYTES,
  failOnStartupError: false,
  expandTemplates: false,
  args: Object.freeze([]),
  env: Object.freeze({}),
  headers: Object.freeze({}),
  cwd: '',
})

/**
 * Canonical upstream field names. Readers use these instead of inline string
 * literals so the document, import translation and host adapter cannot rename
 * a field independently.
 */
export const SERVER_FIELD_NAMES = Object.freeze({
  serverName: 'serverName',
  transport: 'transport',
  command: 'command',
  args: 'args',
  cwd: 'cwd',
  env: 'env',
  envKeys: 'envKeys',
  url: 'url',
  headers: 'headers',
  oauth: 'oauth',
  toolCallTimeoutMs: 'toolCallTimeoutMs',
  startupTimeoutMs: 'startupTimeoutMs',
  closeTimeoutMs: 'closeTimeoutMs',
  reconnect: 'reconnect',
  toolLoading: 'toolLoading',
  maxInstructionBytes: 'maxInstructionBytes',
  catalogDescriptionMaxLength: 'catalogDescriptionMaxLength',
  failOnStartupError: 'failOnStartupError',
  expandTemplates: 'expandTemplates',
})

/** Deprecated per-request timeout field (read-compat only; never written). */
export const LEGACY_TIMEOUT_FIELD = 'timeoutMs'

/** Prefix of one credential template token: `${credential:`. */
const CREDENTIAL_TEMPLATE_PREFIX = '${credential:'

/** Suffix of one credential template token. */
const CREDENTIAL_TEMPLATE_SUFFIX = '}'

/**
 * Regex source of one credential template token, as the upstream
 * `dsh-mcp-client` grammar defines it. Kept as a source string (not a shared
 * `/g` regex) so the ONE parser compiles a fresh state-free matcher per call.
 */
export const CREDENTIAL_TOKEN_SOURCE = '\\$\\{credential:([A-Za-z_][A-Za-z0-9_]*)\\}'

/**
 * Regex source of any `${…}` occurrence (well-formed or not) for fail-loud
 * template validation: only an occurrence that IS a credential token may pass
 * when template expansion is enabled.
 */
export const TEMPLATE_OCCURRENCE_SOURCE = '\\$\\{[^}]*\\}'

/**
 * One legacy HTTP header row (`{name, ref}`). Kept in the canonical row type so
 * read-compat input can still be reported by `validateDoc`, while writers emit
 * the upstream `headers` map with `${credential:REF}` values.
 */
export interface ServerHeaderRow {
  readonly name: string
  readonly ref: string
}

/** One HTTP server's optional OAuth configuration (presence = explicitly enabled). */
export interface OAuthServerDef {
  /** Explicit credential-record key; absent = host-derived `mcp-client/mcp-scope-<hash>`. */
  readonly credentialKey?: string
  /** Pre-registered public client; absent = dynamic registration. */
  readonly clientId?: string
  /** Requested OAuth scope; absent = the server challenge's scope. */
  readonly scope?: string
  /** Per-request authorization-server budget in milliseconds. */
  readonly requestTimeoutMs?: number
  /** Through-browser authorization deadline in milliseconds. */
  readonly authorizationTimeoutMs?: number
}

/** Knob fields shared by both transports (all optional; absent means "upstream default"). */
export interface ServerKnobDef {
  /** Per tool call / resource request deadline in milliseconds. */
  toolCallTimeoutMs?: number
  /** Budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds. */
  closeTimeoutMs?: number
  /** Automatic reconnect policy; omission uses {@link RECONNECT_DEFAULTS}. */
  reconnect?: ReconnectConfig
  /** On-demand vs eager tool registration. */
  toolLoading?: ToolLoading
  /** Attributed-instructions byte cap. */
  maxInstructionBytes?: number
  /** On-demand catalog summary cap. */
  catalogDescriptionMaxLength?: number
  /** Upstream activation-failure policy (not exposed in the editor). */
  failOnStartupError?: boolean
  /** @deprecated Read-compat alias of `toolCallTimeoutMs` (translated by {@link normalizeServerDef}). */
  timeoutMs?: number
}

/** One stdio server row (upstream-named document shape). */
export interface StdioServerDef extends ServerKnobDef {
  serverName: string
  transport: 'stdio'
  /** Executable spawned directly (no shell). */
  command: string
  /** Arguments passed verbatim (template-capable). */
  args?: string[]
  /** Working directory; empty/absent = inherit. */
  cwd?: string
  /** Extra child environment; values are template-capable. */
  env?: Record<string, string>
  /** @deprecated Legacy credential-ref rows, translated to `env` templates on read. */
  envKeys?: string[]
}

/** One streamable-http server row (upstream-named document shape). */
export interface StreamableHttpServerDef extends ServerKnobDef {
  serverName: string
  transport: 'streamable-http'
  /** MCP endpoint URL (template-capable). */
  url: string
  /** Request headers; values are template-capable. Legacy `{name, ref}` rows are translated on read. */
  headers?: Record<string, string> | readonly ServerHeaderRow[]
  /** Explicit OAuth configuration; presence enables authorization. */
  oauth?: OAuthServerDef
}

/** One configured MCP server row. */
export type ServerDef = StdioServerDef | StreamableHttpServerDef

// ---------------------------------------------------------------------------
// The ONE credential-template value space and parser (pure; shared by the
// browser validation/ref flows and the host config adapter). Every walker in
// the tree reads this enumeration — a new document field means editing exactly
// ONE walker.
// ---------------------------------------------------------------------------

/**
 * The exact upstream credential template token for one reference. Pure
 * composition: the REF grammar is the caller's job (the editor validates a
 * write, the host adapter validates before emitting).
 *
 * @param ref - credential reference (env-var-style name).
 * @returns the upstream `${credential:REF}` token.
 */
export function credentialTemplateFor(ref: string): string {
  return CREDENTIAL_TEMPLATE_PREFIX + ref + CREDENTIAL_TEMPLATE_SUFFIX
}

/**
 * The credential refs one configured string names, in template order.
 *
 * @param value - a transport string (command/args/cwd/url/env value/header value).
 * @returns the referenced credential names (empty for a literal string).
 */
export function credentialRefsIn(value: string): string[] {
  const refs: string[] = []
  for (const match of value.matchAll(new RegExp(CREDENTIAL_TOKEN_SOURCE, 'g'))) refs.push(match[1] as string)
  return refs
}

/** Whether a configured string names at least one credential. */
export function hasCredentialTemplate(value: string): boolean {
  return credentialRefsIn(value).length > 0
}

/**
 * Whether a whole string is EXACTLY one well-formed credential token (no
 * surrounding text). This is the fail-loud template rule: while expansion is
 * enabled every other brace-delimited dollar occurrence is refused.
 */
export function isExactCredentialToken(value: string): boolean {
  return new RegExp('^' + CREDENTIAL_TOKEN_SOURCE + '$').test(value)
}

/**
 * Every `${…}` occurrence of one configured string, in order — well-formed
 * credential tokens and malformed occurrences alike (the fail-loud rule needs to
 * see both).
 */
export function templateOccurrencesIn(value: string): string[] {
  const occurrences: string[] = []
  for (const match of value.matchAll(new RegExp(TEMPLATE_OCCURRENCE_SOURCE, 'g'))) occurrences.push(match[0])
  return occurrences
}

/**
 * One template-capable value of a server row, in adapter-emission order.
 * `generated` marks a value the adapter synthesizes from a legacy
 * envKeys/{name,ref} container (always a well-formed token by construction);
 * `free` marks a value the document supplies verbatim (a non-token occurrence
 * there is the validation trap).
 */
export interface TemplatedValue {
  /** Field path inside the row, e.g. args[0] or headers[Authorization]. */
  readonly field: string
  /** The configured/emitted string. */
  readonly value: string
  /** `generated` = adapter-synthesized legacy template; `free` = document-supplied. */
  readonly kind: 'free' | 'generated'
}

/**
 * The ONE templated-value space of one server row: exactly the strings the host
 * adapter emits into the upstream config — and therefore the strings the mounted
 * instance runs template expansion over — in stable field order.
 *
 * Adapter-emission rules encoded here (this is what removes the old
 * env/envKeys vs headers/{name,ref} drift): the upstream env/headers MAP wins
 * over the legacy envKeys/{name,ref} container (`canonicalDoc` drops the legacy
 * container when the map exists), so a legacy ref contributes its generated
 * template only when the map is absent.
 *
 * @param server - canonical document row.
 * @returns every templated value, in stable field order.
 */
export function templatedValuesOf(server: ServerDef): TemplatedValue[] {
  const values: TemplatedValue[] = []
  if (server.transport === 'stdio') {
    // Legacy container first (the historical emitted order), and only while the
    // env map is absent: the map wins and the ignored envKeys must not look
    // like it contributes refs or enables expansion.
    if (server.env === undefined) {
      for (const ref of server.envKeys ?? []) {
        values.push({ field: 'envKeys', value: credentialTemplateFor(ref), kind: 'generated' })
      }
    }
    values.push({ field: 'command', value: server.command, kind: 'free' })
    for (const [index, arg] of (server.args ?? []).entries()) {
      values.push({ field: 'args[' + index + ']', value: arg, kind: 'free' })
    }
    if (server.cwd !== undefined) values.push({ field: 'cwd', value: server.cwd, kind: 'free' })
    for (const [key, value] of Object.entries(server.env ?? {})) {
      values.push({ field: 'env[' + key + ']', value, kind: 'free' })
    }
    return values
  }
  values.push({ field: 'url', value: server.url, kind: 'free' })
  const headers: unknown = server.headers
  if (Array.isArray(headers)) {
    for (const row of headers as readonly ServerHeaderRow[]) {
      values.push({ field: 'headers[' + row.name + ']', value: credentialTemplateFor(row.ref), kind: 'generated' })
    }
  } else if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') values.push({ field: 'headers[' + key + ']', value, kind: 'free' })
    }
  }
  return values
}

/**
 * Whether the host adapter enables template expansion for one row: exactly when
 * the emitted value space carries a credential token (a legacy container forces
 * a generated one). The single expansion detector shared by the editor's
 * validation (template trap) and the host adapter's `expandTemplates`.
 */
export function templatesAreExpanded(server: ServerDef): boolean {
  return templatedValuesOf(server).some(({ value }) => hasCredentialTemplate(value))
}

/** A plain JSON object (arrays and null excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Copy a string array, dropping non-string members; absent stays absent. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Copy a string dictionary, dropping non-string values; absent stays absent. */
function stringDict(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Copy a legacy `{name, ref}` header-row array; absent stays absent. */
function headerRows(value: unknown): readonly ServerHeaderRow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: ServerHeaderRow[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.ref !== 'string') continue
    rows.push({ name: entry.name, ref: entry.ref })
  }
  return rows
}

/** Copy the OAuth block (known keys only); an empty block reads as absent. */
function oauthDef(value: unknown): OAuthServerDef | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string | number> = {}
  for (const key of ['credentialKey', 'clientId', 'scope'] as const) {
    const entry = value[key]
    if (typeof entry === 'string') out[key] = entry
  }
  for (const key of ['requestTimeoutMs', 'authorizationTimeoutMs'] as const) {
    const entry = value[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
  }
  return Object.keys(out).length === 0 ? undefined : (out as OAuthServerDef)
}

/** Copy the shared knob fields; absent stays absent (no defaults materialized). */
function knobDef(raw: Record<string, unknown>): ServerKnobDef {
  const out: ServerKnobDef = {}
  const newTimeout = raw.toolCallTimeoutMs
  if (typeof newTimeout === 'number' && Number.isFinite(newTimeout)) out.toolCallTimeoutMs = newTimeout
  else if (typeof raw[LEGACY_TIMEOUT_FIELD] === 'number' && Number.isFinite(raw[LEGACY_TIMEOUT_FIELD])) {
    // Legacy read-compat: translate the old name only when the new one is absent.
    out.toolCallTimeoutMs = raw[LEGACY_TIMEOUT_FIELD] as number
  }
  for (const key of ['startupTimeoutMs', 'closeTimeoutMs', 'maxInstructionBytes', 'catalogDescriptionMaxLength'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  if (typeof raw.toolLoading === 'string') {
    // Unknown enum values survive so validateDoc can name them; the editor can
    // never write one and host.validate refuses it at mount time.
    out.toolLoading = raw.toolLoading as ToolLoading
  }
  if (typeof raw.failOnStartupError === 'boolean') out.failOnStartupError = raw.failOnStartupError
  if (isRecord(raw.reconnect)) {
    // Verbatim copy: unknown keys must survive so validateDoc can report them
    // rather than silently dropping a user's typo.
    out.reconnect = { ...raw.reconnect } as ReconnectConfig
  }
  return out
}

/**
 * Canonicalize ONE server row: keep known fields only, translate the legacy
 * `timeoutMs` alias (only when `toolCallTimeoutMs` is absent), prefer the
 * upstream `env`/`headers` maps over legacy `envKeys`/`{name,ref}` rows, and
 * NEVER materialize a default. Idempotent; never mutates its input.
 *
 * @param raw - candidate row from the settings document (decoded or hand-edited).
 * @returns the canonical row, or `undefined` for a structurally unusable row
 *   (not an object, no string `serverName`, or an unrecognized transport).
 *   Callers that must surface an invalid row (e.g. a typo'd transport) keep the
 *   raw row themselves and report it through `validateDoc`.
 */
export function normalizeServerDef(raw: unknown): ServerDef | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.serverName !== 'string') return undefined
  const knobs = knobDef(raw)
  if (raw.transport === 'stdio') {
    if (typeof raw.command !== 'string') return undefined
    const row: StdioServerDef = { serverName: raw.serverName, transport: 'stdio', command: raw.command, ...knobs }
    const args = stringArray(raw.args)
    if (args !== undefined) row.args = args
    if (typeof raw.cwd === 'string') row.cwd = raw.cwd
    const env = stringDict(raw.env)
    if (env !== undefined) row.env = env
    else {
      const legacyKeys = stringArray(raw.envKeys)
      if (legacyKeys !== undefined) row.envKeys = legacyKeys
    }
    return row
  }
  if (raw.transport === 'streamable-http') {
    if (typeof raw.url !== 'string') return undefined
    const row: StreamableHttpServerDef = { serverName: raw.serverName, transport: 'streamable-http', url: raw.url, ...knobs }
    const headers = stringDict(raw.headers)
    if (headers !== undefined) row.headers = headers
    else {
      const rows = headerRows(raw.headers)
      if (rows !== undefined) row.headers = rows
    }
    const oauth = oauthDef(raw.oauth)
    if (oauth !== undefined) row.oauth = oauth
    return row
  }
  return undefined
}
