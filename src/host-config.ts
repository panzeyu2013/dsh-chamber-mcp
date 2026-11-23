/**
 * Document-row → upstream ConfigInput adapter and credential-key derivation
 * (host half).
 *
 * The settings document keeps our own array row (ServerDef); the official
 * dsh-mcp-client host consumes a ConfigInput. This module is the ONLY
 * translation point: name-aligned fields pass through, legacy read-compat
 * forms (timeoutMs, envKeys, headers[] rows) are rewritten to their upstream
 * equivalents, expandTemplates is DERIVED from the text (never stored in the
 * document), and the resolved config is obtained through exactly one
 * host.validate call (S6) so mount/probe/authorization share one object.
 * The credential-template value space/parser itself lives in
 * ./shared/defaults.ts; the functions below are thin host wrappers that add the
 * HostConfigError taxonomy.
 *
 * Credential values never transit this module's inputs or outputs: env/header
 * values are ${credential:REF} templates the mounted instance resolves at
 * connect time through the isolated credentials façade (the single SEC-02
 * authority). resolveCredentialRefs exists for diagnostics only and must never
 * be used as a pre-mount gate (TOCTOU).
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Config, ConfigInput, McpOAuthConfigInput } from '@deepseek-ai/dsh-mcp-client'
import {
  parseCredentialKey,
  type CredentialKey,
  type CredentialProvider,
} from '@deepseek-ai/dsh-credentials'
import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  INVALID_CREDENTIAL_VALUE_PATTERN,
  LEGACY_TIMEOUT_FIELD,
  OAUTH_CREDENTIAL_KEY_PATTERN,
  RECONNECT_DEFAULTS,
  SERVER_DEFAULTS,
  credentialRefsIn,
  credentialTemplateFor,
  isExactCredentialToken,
  templateOccurrencesIn,
  templatedValuesOf,
  templatesAreExpanded,
  type ReconnectConfig,
  type ServerDef,
  type ServerHeaderRow,
  type StdioServerDef,
  type StreamableHttpServerDef,
  type ToolLoading,
} from './shared/defaults.js'

/** Fixed failure classes of the document → upstream adapter. */
type HostConfigErrorCode =
  | 'invalid-config'
  | 'invalid-ref'
  | 'invalid-template'
  | 'duplicate-header'
  | 'unsupported-oauth'

/**
 * Host-side adapter failure. The code is the only identity the manager maps
 * onto a wire code (invalid-config, invalid-ref, …); the message and cause stay
 * host-side and may be logged but never cross the wire.
 */
export class HostConfigError extends Error {
  readonly code: HostConfigErrorCode

  constructor(code: HostConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostConfigError'
    this.code = code
  }
}

/** The single resolution verb of the upstream host (structural, test-friendly). */
export interface HostValidate {
  validate(input: ConfigInput, path: readonly string[]): Config
}

/** Options of toUpstreamConfig. */
interface HostConfigOptions {
  /** The per-server upstream host; when present the input is resolved exactly once. */
  host?: HostValidate
  /** Diagnostic sink for legacy-translation notices (field/ref names only, never values). */
  warn?: (message: string) => void
}

/** Prefix of every credential key this plugin derives. */
const CREDENTIAL_KEY_PREFIX = 'mcp-client/mcp-scope-'

/** Hex characters of the server-name hash in a derived credential key. */
const CREDENTIAL_KEY_HASH_LENGTH = 16

/** Path prefix the upstream host expects for one document row. */
const CONFIG_PATH: readonly string[] = ['servers']

/** Diagnostic path of one document row. */
function whereOf(def: ServerDef): string {
  return CONFIG_PATH.join('.') + '.' + def.serverName
}

/** Reject a raw string outside the credential-ref grammar (names only, no values). */
function assertCredentialRef(ref: string, where: string): string {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new HostConfigError('invalid-ref', where + ': credential ref is not a POSIX identifier')
  }
  return ref
}

/**
 * Preserve the historical grammar refusal of the legacy containers the shared
 * value space serializes: an emitted envKeys ref and an emitted header row must
 * name a legal ref / HTTP field (the map forms are validated by the editor and
 * by host.validate). The shared walker is pure, so the host adds its taxonomy
 * here instead of re-implementing a second walk.
 */
function validateEmittedLegacyContainers(def: ServerDef): void {
  if (def.transport === 'stdio') {
    if (def.env !== undefined) return
    for (const ref of def.envKeys ?? []) assertCredentialRef(ref, whereOf(def) + '.envKeys')
    return
  }
  const headers: unknown = def.headers
  if (!Array.isArray(headers)) return
  for (const row of headers as readonly ServerHeaderRow[]) {
    if (!HEADER_NAME_PATTERN.test(row.name)) {
      throw new HostConfigError('invalid-ref', whereOf(def) + '.headers: ' + JSON.stringify(row.name) + ' is not a header name')
    }
    assertCredentialRef(row.ref, whereOf(def) + '.headers')
  }
}

/**
 * Template-capable values of a configuration row, in adapter-emission order.
 * Thin wrapper over the ONE shared value space (./shared/defaults.ts): the host
 * half keeps this name and its legacy-container grammar refusal, and adds no
 * second walker.
 *
 * @param def - canonical document row.
 * @returns [value, field] pairs in the order the adapter emits them.
 */
export function templatedStringsOf(def: ServerDef): Array<[value: string, field: string]> {
  validateEmittedLegacyContainers(def)
  return templatedValuesOf(def).map(({ value, field }) => [value, field])
}

/**
 * Whether the adapter will set upstream `expandTemplates` for this row. Thin
 * wrapper over the shared expansion detector; exported for the SEC-02/parity
 * tests (the manager consumes the shared `templatesAreExpanded` directly).
 */
export function expandTemplatesFor(def: ServerDef): boolean {
  validateEmittedLegacyContainers(def)
  return templatesAreExpanded(def)
}

/**
 * The one representation of a credential template token.
 *
 * @param ref - credential reference (env-var-style name).
 * @returns the upstream ${credential:REF} token.
 * @throws HostConfigError invalid-ref when the ref is outside the grammar.
 */
export function templateFor(ref: string): string {
  assertCredentialRef(ref, 'template')
  return credentialTemplateFor(ref)
}

/**
 * Every credential ref named by a string, in template order (thin wrapper over
 * the shared token finder, kept as this module's historical name).
 *
 * @param text - a transport string (command/args/cwd/url/env value/header value).
 * @returns the referenced credential names (empty for a literal string).
 */
export function extractTemplateRefs(text: string): string[] {
  return credentialRefsIn(text)
}

/**
 * Reject any template occurrence (a brace-delimited dollar expression) that is
 * not exactly a credential token — thin wrapper over the shared exact-token
 * rule that supplies the host's HostConfigError taxonomy.
 * Only meaningful while template expansion is enabled (a token exists): a
 * server with no token at all keeps literal braces, the documented deviation
 * from the official manager's unconditional expandTemplates:true.
 *
 * @param text - a transport string.
 * @param where - diagnostic prefix naming the field.
 * @throws HostConfigError invalid-template for every non-token occurrence.
 */
export function assertNoUnknownTemplate(text: string, where = 'template'): void {
  for (const occurrence of templateOccurrencesIn(text)) {
    if (isExactCredentialToken(occurrence)) continue
    throw new HostConfigError('invalid-template', where + ': ' + JSON.stringify(occurrence) + ' is not a template token - use ' + templateFor('REF'))
  }
}

/**
 * Derive one server's OAuth credential-record key:
 * mcp-client/mcp-scope-<sha256(serverName)[:16 hex]>.
 *
 * The raw serverName cannot be used: the credentials seam admits only
 * lowercase hyphenated segments (^[a-z][a-z0-9-]*$), while server names may
 * contain uppercase and underscores. The derived key is validated with the
 * seam's own parser - a failure here is an implementation bug, never user input.
 *
 * @param serverName - configured server name.
 * @returns the branded credential key.
 */
export function deriveCredentialKey(serverName: string): CredentialKey {
  const hash = createHash('sha256').update(serverName, 'utf8').digest('hex').slice(0, CREDENTIAL_KEY_HASH_LENGTH)
  try {
    return parseCredentialKey(CREDENTIAL_KEY_PREFIX + hash)
  } catch (error) {
    throw new HostConfigError('invalid-config', 'the derived OAuth credential key is not a valid credential key', { cause: error })
  }
}

/** Legacy env keys translated to one env template per key. */
function translatedEnv(def: StdioServerDef, opts: HostConfigOptions): Record<string, string> {
  if (def.env !== undefined) {
    if (def.envKeys !== undefined && def.envKeys.length > 0) {
      opts.warn?.('mcp-scope(' + def.serverName + '): legacy envKeys ignored because env is configured')
    }
    return { ...def.env }
  }
  const env: Record<string, string> = {}
  for (const ref of def.envKeys ?? []) {
    assertCredentialRef(ref, whereOf(def) + '.envKeys')
    opts.warn?.('mcp-scope(' + def.serverName + '): legacy envKeys row translated to an env template')
    env[ref] = templateFor(ref)
  }
  return env
}

/** Legacy header rows translated to a header template map; duplicate names refused. */
function translatedHeaders(def: StreamableHttpServerDef, opts: HostConfigOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  if (def.headers === undefined) return headers
  if (!Array.isArray(def.headers)) return { ...(def.headers as Record<string, string>) }
  const seen = new Set<string>()
  for (const row of def.headers as readonly ServerHeaderRow[]) {
    if (!HEADER_NAME_PATTERN.test(row.name)) {
      throw new HostConfigError('invalid-ref', whereOf(def) + '.headers: ' + JSON.stringify(row.name) + ' is not a header name')
    }
    assertCredentialRef(row.ref, whereOf(def) + '.headers')
    const lower = row.name.toLowerCase()
    if (seen.has(lower)) {
      throw new HostConfigError('duplicate-header', whereOf(def) + '.headers: duplicate header ' + JSON.stringify(row.name))
    }
    seen.add(lower)
    opts.warn?.('mcp-scope(' + def.serverName + '): legacy header row translated to a header template')
    headers[row.name] = templateFor(row.ref)
  }
  return headers
}

/** OAuth slice of one http row, or undefined when OAuth is not configured. */
function oauthInput(def: StreamableHttpServerDef): McpOAuthConfigInput | undefined {
  const oauth = def.oauth
  if (oauth === undefined) return undefined
  if (oauth.credentialKey !== undefined) {
    // Grammar AND namespace: only mcp-client/<id> records belong to this plane.
    if (!OAUTH_CREDENTIAL_KEY_PATTERN.test(oauth.credentialKey)) {
      throw new HostConfigError(
        'invalid-config',
        whereOf(def) + '.oauth.credentialKey must match ' + String(OAUTH_CREDENTIAL_KEY_PATTERN),
      )
    }
    try {
      parseCredentialKey(oauth.credentialKey)
    } catch (error) {
      throw new HostConfigError('invalid-config', whereOf(def) + '.oauth.credentialKey is not a valid credential key', { cause: error })
    }
  }
  const input: McpOAuthConfigInput = {
    credentialKey: oauth.credentialKey ?? String(deriveCredentialKey(def.serverName)),
  }
  if (oauth.clientId !== undefined) input.clientId = oauth.clientId
  if (oauth.scope !== undefined) input.scope = oauth.scope
  if (oauth.requestTimeoutMs !== undefined) input.requestTimeoutMs = oauth.requestTimeoutMs
  if (oauth.authorizationTimeoutMs !== undefined) input.authorizationTimeoutMs = oauth.authorizationTimeoutMs
  return input
}

/** The upstream-named input shared by both transports. */
interface CommonInput {
  serverName: string
  toolCallTimeoutMs: number
  startupTimeoutMs: number
  closeTimeoutMs: number
  reconnect: ReconnectConfig
  toolLoading: ToolLoading
  catalogDescriptionMaxLength: number
  maxInstructionBytes: number
  failOnStartupError: boolean
  expandTemplates: boolean
}

/** Resolve the reconnect policy (defaults + row overrides, unknown keys preserved for validateDoc). */
function resolvedReconnect(def: ServerDef): ReconnectConfig {
  return def.reconnect === undefined ? { ...RECONNECT_DEFAULTS } : { ...RECONNECT_DEFAULTS, ...def.reconnect }
}

/** Emit the legacy-translation notice once per row (field name only). */
function warnLegacyTimeout(def: ServerDef, opts: HostConfigOptions): void {
  if (def.toolCallTimeoutMs === undefined && def.timeoutMs !== undefined) {
    opts.warn?.('mcp-scope(' + def.serverName + '): legacy ' + LEGACY_TIMEOUT_FIELD + ' translated to toolCallTimeoutMs')
  }
}

/** Assert the caller's ref set equals the token-derived set (internal drift guard). */
function assertRefsMatch(values: ReadonlyArray<readonly [string, string]>, refs: ReadonlySet<string>, where: string): void {
  const derived = new Set<string>()
  for (const [value] of values) for (const ref of extractTemplateRefs(value)) derived.add(ref)
  const missing = [...derived].filter((ref) => !refs.has(ref))
  const unexpected = [...refs].filter((ref) => !derived.has(ref))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new HostConfigError('invalid-template', where + ': the credential-ref set disagrees with the configured templates')
  }
}

/** Validate template syntax when expansion is on (a token exists). */
function assertTemplateSyntax(values: ReadonlyArray<readonly [string, string]>, where: string): void {
  for (const [value, field] of values) assertNoUnknownTemplate(value, where + '.' + field)
}

/**
 * Map one document row to the upstream ConfigInput WITHOUT resolving it.
 * Pure: no ctx, no credential read, no validation beyond the adapter's own
 * ref/template/duplicate rules (the single resolution step is toUpstreamConfig
 * with a host).
 *
 * @param def - canonical document row (see normalizeServerDef).
 * @param refs - the credential refs the caller derived for this row; must equal
 *   the refs named by the emitted templates (drift is a bug, refused loudly).
 * @param opts - optional diagnostic sink for legacy-translation notices.
 * @returns the upstream configuration input (defaults resolved, absent fields
 *   materialized from SERVER_DEFAULTS).
 */
export function toUpstreamConfigInput(
  def: ServerDef,
  refs: ReadonlySet<string>,
  opts: HostConfigOptions = {},
): ConfigInput {
  const where = whereOf(def)
  warnLegacyTimeout(def, opts)
  const values = templatedStringsOf(def)
  const expandTemplates = templatesAreExpanded(def)
  if (expandTemplates) assertTemplateSyntax(values, where)
  assertRefsMatch(values, refs, where)
  const common: CommonInput = {
    serverName: def.serverName,
    toolCallTimeoutMs: def.toolCallTimeoutMs ?? def.timeoutMs ?? SERVER_DEFAULTS.toolCallTimeoutMs,
    startupTimeoutMs: def.startupTimeoutMs ?? SERVER_DEFAULTS.startupTimeoutMs,
    closeTimeoutMs: def.closeTimeoutMs ?? SERVER_DEFAULTS.closeTimeoutMs,
    reconnect: resolvedReconnect(def),
    toolLoading: def.toolLoading ?? SERVER_DEFAULTS.toolLoading,
    catalogDescriptionMaxLength: def.catalogDescriptionMaxLength ?? SERVER_DEFAULTS.catalogDescriptionMaxLength,
    maxInstructionBytes: def.maxInstructionBytes ?? SERVER_DEFAULTS.maxInstructionBytes,
    // Mount never blocks on the initial handshake: the per-server seat awaits
    // instance.ready AFTER activation, so a failing first attempt must not fail
    // the fiber. The hidden row field is therefore ignored on purpose.
    failOnStartupError: SERVER_DEFAULTS.failOnStartupError,
    expandTemplates,
  }
  if (def.transport === 'stdio') {
    if ((def as StdioServerDef & { oauth?: unknown }).oauth !== undefined) {
      throw new HostConfigError('unsupported-oauth', where + ': OAuth is supported only on streamable-http servers')
    }
    return {
      transport: 'stdio',
      ...common,
      command: def.command,
      args: [...(def.args ?? SERVER_DEFAULTS.args)],
      cwd: def.cwd ?? SERVER_DEFAULTS.cwd,
      env: translatedEnv(def, opts),
    }
  }
  const oauth = oauthInput(def)
  const base = {
    transport: 'streamable-http' as const,
    ...common,
    url: def.url,
    headers: translatedHeaders(def, opts),
  }
  return oauth === undefined ? base : { ...base, oauth }
}

/**
 * Map one document row to the resolved upstream config through the host's ONE
 * validation step (S6). Mount, probe and authorization must reuse the returned
 * object until the definition changes - a second validation reopens the
 * binding bug the single-resolution rule closed.
 *
 * @param def - canonical document row.
 * @param refs - credential refs for this row (see toUpstreamConfigInput).
 * @param opts - host + optional warning sink; without host the pure input is returned.
 * @returns the resolved Config when a host is supplied, else the ConfigInput.
 * @throws HostConfigError with a fixed code; the upstream cause stays host-side.
 */
export function toUpstreamConfig(
  def: ServerDef,
  refs: ReadonlySet<string>,
  opts: HostConfigOptions & { host: HostValidate },
): Config
export function toUpstreamConfig(def: ServerDef, refs: ReadonlySet<string>, opts?: HostConfigOptions): ConfigInput
export function toUpstreamConfig(
  def: ServerDef,
  refs: ReadonlySet<string>,
  opts: HostConfigOptions = {},
): ConfigInput | Config {
  const input = toUpstreamConfigInput(def, refs, opts)
  if (opts.host === undefined) return input
  try {
    return opts.host.validate(input, [...CONFIG_PATH, def.serverName])
  } catch (error) {
    if (error instanceof HostConfigError) throw error
    throw new HostConfigError('invalid-config', whereOf(def) + ': the upstream client rejected the resolved configuration', { cause: error })
  }
}

/**
 * Resolve credential refs through the REAL provider for diagnostics (a
 * settings hint / test preflight). Values with CR/LF/NUL are refused; the
 * error names the ref, never the value.
 *
 * NOT a mount-time gate: the credentials façade re-resolves on every connect
 * attempt and is the single SEC-02 authority, which is what closes the
 * resolve-then-use TOCTOU window.
 *
 * @param refs - credential references to resolve.
 * @param credentials - the real credential provider.
 * @returns ref -> value for every configured, valid ref.
 */
export async function resolveCredentialRefs(
  refs: Iterable<string>,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>()
  for (const ref of refs) {
    assertCredentialRef(ref, 'credential refs')
    const resolved = await credentials.resolve(ref as Parameters<CredentialProvider['resolve']>[0])
    if (resolved === undefined || resolved.value === '') {
      throw new HostConfigError('invalid-ref', 'credential ref ' + JSON.stringify(ref) + ' is not configured')
    }
    if (INVALID_CREDENTIAL_VALUE_PATTERN.test(resolved.value)) {
      throw new HostConfigError('invalid-ref', 'credential ref ' + JSON.stringify(ref) + ' resolved to an invalid value (CR/LF/NUL)')
    }
    values.set(ref, resolved.value)
  }
  return values
}
