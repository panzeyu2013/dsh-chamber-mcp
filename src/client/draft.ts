/**
 * Pure staged-draft model of the server editor.
 *
 * React-free and host-free: the editor and its tests consume these functions.
 * Secrets stay as write-only literals in the draft; draftToServer is the only
 * place they are materialized for the credentials domain.
 *
 * Document shape (0.2.6 line): the draft writes the UPSTREAM credential forms a
 * mounted client consumes — stdio env / http headers maps whose values are
 * ${credential:REF} templates (see src/host-config.ts). Legacy envKeys /
 * {name,ref} header containers are READ-COMPAT only: draftFromServer accepts
 * them, draftToServer never emits them.
 *
 * Exposed fields: startup/close/tool-call timeouts + toolLoading radio,
 * plus the OAuth enable switch and its optional clientId/scope (http only). The
 * reconnect group is import-pass-through only: it rides AddDraft so an imported
 * definition is not silently stripped on save, but the editor does not expose
 * it. All numeric inputs stay STRINGS ('': use the upstream default) so an
 * empty field round-trips to "absent = default" and never materializes a value.
 */

import {
  CREDENTIAL_REF_PATTERN,
  CREDENTIAL_TOKEN_SOURCE,
  HEADER_NAME_PATTERN,
  MAX_TIMER_DELAY_MS,
  RECONNECT_DEFAULTS,
  RESERVED_OVERRIDE_KEYS,
  SERVER_NAME_PATTERN,
  TEMPLATE_OCCURRENCE_SOURCE,
  hasCredentialTemplate,
  isToolLoading,
  templateFor,
  type OAuthServerDef,
  type ReconnectConfig,
  type ServerDef,
  type ServerKnobDef,
  type ToolLoading,
} from '../shared/model.js'
import type { SettingsKey } from './locales.js'
import type { ServerSaveInput } from './controller.js'
import type { ImportedServer } from './import.js'

/** One staged env row: the child env key, its credential ref (blank = same as the key) and a write-only literal. */
export interface DraftEnvRow {
  key: string
  ref: string
  value: string
}

/** One staged request-header row: header name, its credential ref and a write-only literal. */
export interface DraftHeaderRow {
  name: string
  ref: string
  value: string
}

/** Reconnect policy as typed strings ('' = upstream default; import pass-through only). */
export interface DraftReconnect {
  enabled: boolean
  initialDelayMs: string
  maxDelayMs: string
  maxAttempts: string
}

/** All staged input of one add/edit flow. */
export interface AddDraft {
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string
  cwd: string
  args: string[]
  env: DraftEnvRow[]
  url: string
  headers: DraftHeaderRow[]
  /** Global enable flag (the document's disabled map, inverted). */
  enabled: boolean
  /** Per-server timeouts in ms as typed; '' = upstream default. */
  startupTimeoutMs: string
  closeTimeoutMs: string
  toolCallTimeoutMs: string
  /** Import-only reconnect policy (not exposed by the editor). */
  reconnect: DraftReconnect
  /** Eager (default) or on-demand tool registration. */
  toolLoading: ToolLoading
  /** Explicit OAuth enable switch (http only; presence of the block enables it). */
  oauthEnabled: boolean
  oauthClientId: string
  oauthScope: string
}

const EMPTY_RECONNECT: DraftReconnect = {
  enabled: RECONNECT_DEFAULTS.enabled,
  initialDelayMs: '',
  maxDelayMs: '',
  maxAttempts: '',
}

/** Frozen empty flow state (copy before mutating). */
export const EMPTY_DRAFT: AddDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  cwd: '',
  args: [''],
  env: [{ key: '', ref: '', value: '' }],
  url: '',
  headers: [{ name: '', ref: '', value: '' }],
  enabled: true,
  startupTimeoutMs: '',
  closeTimeoutMs: '',
  toolCallTimeoutMs: '',
  reconnect: { ...EMPTY_RECONNECT },
  toolLoading: 'eager',
  oauthEnabled: false,
  oauthClientId: '',
  oauthScope: '',
}

/**
 * Budget proving the OAuth block is present for an enable-with-defaults save.
 * The document normalizer reads an EMPTY oauth object as "absent", so enabling
 * OAuth without a clientId/scope needs one non-empty field. The upstream
 * request budget default is used: the mounted host resolves the same 10 s value
 * whether the field is present or omitted (0.2.3-alpha.2 OAuthSchema).
 */
const OAUTH_ENABLE_SENTINEL_MS = 10_000

/** Structural equality of two drafts (dirty-form protection). */
export function isDraftDirty(draft: AddDraft, initial: AddDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(initial)
}

/** '' -> undefined, an invalid integer -> NaN, a number -> its value. */
function integerValue(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/.test(trimmed)) return Number.NaN
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : Number.NaN
}

/** Whether a parsed numeric field is unusable (present but outside the budget grammar). */
function invalidInteger(value: number | undefined, min: number, max: number): boolean {
  return value !== undefined && (Number.isNaN(value) || value < min || value > max)
}

/** Defensive copy of an imported reconnect block into its draft form. */
function reconnectFromImport(reconnect: ImportedServer['reconnect']): DraftReconnect {
  if (reconnect === undefined) return { ...EMPTY_RECONNECT }
  return {
    enabled: reconnect.enabled,
    initialDelayMs: reconnect.initialDelayMs ?? '',
    maxDelayMs: reconnect.maxDelayMs ?? '',
    maxAttempts: reconnect.maxAttempts ?? '',
  }
}

/** Prefill reconnect strings from a saved definition (absent = ''). */
function reconnectFromServer(reconnect: ReconnectConfig | undefined): DraftReconnect {
  if (reconnect === undefined) return { ...EMPTY_RECONNECT }
  return {
    enabled: reconnect.enabled ?? RECONNECT_DEFAULTS.enabled,
    initialDelayMs: reconnect.initialDelayMs === undefined ? '' : String(reconnect.initialDelayMs),
    maxDelayMs: reconnect.maxDelayMs === undefined ? '' : String(reconnect.maxDelayMs),
    maxAttempts: reconnect.maxAttempts === undefined ? '' : String(reconnect.maxAttempts),
  }
}

/** Number -> typed string (undefined stays ''). */
function textOf(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** The credential ref named by a value that is EXACTLY one template token. */
function tokenRefOf(value: string): string | undefined {
  const exact = new RegExp('^' + CREDENTIAL_TOKEN_SOURCE + '$')
  const match = exact.exec(value)
  return match === null ? undefined : (match[1] as string)
}

/** A header-map value that is not a token keeps a derived ref (name -> env-style). */
function headerRefOf(name: string): string {
  const cleaned = name.replace(/-/g, '_').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+/, '')
  if (cleaned === '') return ''
  return /^[A-Z_]/.test(cleaned) ? cleaned : '_' + cleaned
}

/** One blank trailing row appended to a non-empty staged row list. */
function rowsWithBlank<T>(rows: T[], blank: T): T[] {
  return rows.length > 0 ? [...rows, blank] : [blank]
}

/** Patch a draft from one parsed import (secret values stay write-only). */
export function draftFromImport(current: AddDraft, server: ImportedServer): AddDraft {
  const base: AddDraft = {
    ...current,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.name !== undefined && server.name !== '' ? { name: server.name } : {}),
    startupTimeoutMs: server.startupTimeoutMs ?? '',
    closeTimeoutMs: server.closeTimeoutMs ?? '',
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? '',
    reconnect: reconnectFromImport(server.reconnect),
    toolLoading: server.toolLoading ?? 'eager',
  }
  if (server.transport === 'stdio') {
    return {
      ...base,
      command: server.command ?? '',
      args: (server.args ?? []).length > 0 ? [...(server.args as string[])] : [''],
      cwd: server.cwd ?? '',
      env: rowsWithBlank([...server.env], { key: '', ref: '', value: '' }),
      url: '',
      headers: [{ name: '', ref: '', value: '' }],
      oauthEnabled: false,
      oauthClientId: '',
      oauthScope: '',
    }
  }
  return {
    ...base,
    command: '',
    args: [''],
    cwd: '',
    env: [{ key: '', ref: '', value: '' }],
    url: server.url ?? '',
    headers: rowsWithBlank([...server.headers], { name: '', ref: '', value: '' }),
    oauthEnabled: server.oauth !== undefined,
    oauthClientId: server.oauth?.clientId ?? '',
    oauthScope: server.oauth?.scope ?? '',
  }
}

/**
 * Prefill a staged draft from an existing server definition (edit flow).
 * Secret values stay blank — a blank input keeps the stored value on save.
 * Legacy envKeys / header rows read back as ref rows; a map value that is not a
 * credential token keeps a derived ref (the editor can only represent
 * credential-backed entries — documented read-compat limitation).
 */
export function draftFromServer(server: ServerDef, disabled = false): AddDraft {
  const common = {
    name: server.serverName,
    transport: server.transport,
    enabled: !disabled,
    startupTimeoutMs: textOf(server.startupTimeoutMs),
    closeTimeoutMs: textOf(server.closeTimeoutMs),
    // canonicalDoc translates the deprecated alias, but an in-memory caller may
    // still hand us one: read it the same way.
    toolCallTimeoutMs: textOf(server.toolCallTimeoutMs ?? server.timeoutMs),
    reconnect: reconnectFromServer(server.reconnect),
    toolLoading: isToolLoading(server.toolLoading) ? server.toolLoading : 'eager',
  }
  if (server.transport === 'stdio') {
    const env: DraftEnvRow[] = server.env !== undefined
      ? Object.entries(server.env).map(([key, value]) => ({ key, ref: tokenRefOf(value) ?? key, value: '' }))
      : (server.envKeys ?? []).map((ref) => ({ key: ref, ref, value: '' }))
    return {
      ...common,
      command: server.command,
      cwd: server.cwd ?? '',
      args: (server.args ?? []).length > 0 ? [...(server.args as string[])] : [''],
      env: rowsWithBlank(env, { key: '', ref: '', value: '' }),
      url: '',
      headers: [{ name: '', ref: '', value: '' }],
      oauthEnabled: false,
      oauthClientId: '',
      oauthScope: '',
    }
  }
  // The document row type accepts the legacy {name,ref} rows and the upstream
  // header MAP, so read both forms.
  const headersRaw: unknown = server.headers
  const headerRows: DraftHeaderRow[] = Array.isArray(headersRaw)
    ? (headersRaw as readonly { name: string; ref: string }[]).map((row) => ({ name: row.name, ref: row.ref, value: '' }))
    : Object.entries(headersRaw ?? {}).map(([name, value]) => ({
        name,
        ref: tokenRefOf(value) ?? headerRefOf(name),
        value: '',
      }))
  return {
    ...common,
    command: '',
    cwd: '',
    args: [''],
    env: [{ key: '', ref: '', value: '' }],
    url: server.url,
    headers: rowsWithBlank(headerRows, { name: '', ref: '', value: '' }),
    oauthEnabled: server.oauth !== undefined,
    oauthClientId: server.oauth?.clientId ?? '',
    oauthScope: server.oauth?.scope ?? '',
  }
}

/** One staged-draft validation problem (literals are mapped to locale keys by the editor). */
export interface AddProblems {
  /** Server-name field problem (pattern / duplicate / reserved). */
  name?: 'pattern' | 'duplicate' | 'reserved'
  command?: 'required' | 'template'
  /** Working directory carries a non-token brace expression while expansion is on. */
  cwd?: 'template'
  url?: 'required' | 'invalid' | 'template'
  /** Per-arg problem key (locales.validation.*), undefined = arg fine. */
  args: (SettingsKey | undefined)[]
  startupTimeoutMs?: 'range'
  closeTimeoutMs?: 'range'
  toolCallTimeoutMs?: 'range'
  reconnect?: 'initial' | 'max' | 'attempts' | 'order'
  /** Per-row problem key (locales.validation.*), undefined = row fine. */
  env: (SettingsKey | undefined)[]
  headers: (SettingsKey | undefined)[]
  /** OAuth problem: blank clientId, stdio transport, or Authorization-header conflict. */
  oauth?: 'clientId' | 'stdio' | 'header'
}

/** Exact-token matcher (compiled once; a fresh global matcher is used per scan). */
const TOKEN_EXACT_SOURCE = '^' + CREDENTIAL_TOKEN_SOURCE + '$'

/** Every non-token brace-delimited dollar expression (the mounted host trap). */
function hasTemplateTrap(value: string): boolean {
  const exact = new RegExp(TOKEN_EXACT_SOURCE)
  for (const match of value.matchAll(new RegExp(TEMPLATE_OCCURRENCE_SOURCE, 'g'))) {
    if (!exact.test(match[0])) return true
  }
  return false
}

/**
 * Whether the document this draft materializes will have template expansion
 * enabled (the host adapter derives it from the presence of any credential
 * token). Only then is a literal ${...} expression a mount-time failure.
 */
function expansionEnabled(draft: AddDraft): boolean {
  if (draft.transport === 'stdio') {
    if (draft.env.some((row) => row.key.trim() !== '')) return true
    return [draft.command, draft.cwd, ...draft.args].some((value) => hasCredentialTemplate(value))
  }
  if (draft.headers.some((row) => row.name.trim() !== '' && row.ref.trim() !== '')) return true
  return hasCredentialTemplate(draft.url)
}

function looksLikeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Reconnect validation, judged with the upstream defaults merged. */
function reconnectProblem(reconnect: DraftReconnect): AddProblems['reconnect'] {
  const initial = integerValue(reconnect.initialDelayMs)
  const max = integerValue(reconnect.maxDelayMs)
  const attempts = integerValue(reconnect.maxAttempts)
  if (invalidInteger(initial, 1, MAX_TIMER_DELAY_MS)) return 'initial'
  if (invalidInteger(max, 1, MAX_TIMER_DELAY_MS)) return 'max'
  if (attempts !== undefined && (Number.isNaN(attempts) || attempts < 1)) return 'attempts'
  const resolvedInitial = initial ?? RECONNECT_DEFAULTS.initialDelayMs
  const resolvedMax = max ?? RECONNECT_DEFAULTS.maxDelayMs
  if (resolvedInitial > resolvedMax) return 'order'
  return undefined
}

/** Value-staged env rows: key/ref grammar and duplicate keys. */
function envProblems(draft: AddDraft): (SettingsKey | undefined)[] {
  const problems: (SettingsKey | undefined)[] = []
  const seenKeys = new Set<string>()
  for (const row of draft.env) {
    const key = row.key.trim()
    const ref = row.ref.trim() || key
    const hasValue = row.value !== ''
    if (key === '' && row.ref.trim() === '' && !hasValue) {
      problems.push(undefined)
      continue
    }
    let problem: SettingsKey | undefined
    if (key === '' || !CREDENTIAL_REF_PATTERN.test(key)) {
      problem = 'validation.refPattern'
    } else if (seenKeys.has(key)) {
      problem = 'validation.envKeyDuplicate'
    } else if (ref !== '' && !CREDENTIAL_REF_PATTERN.test(ref)) {
      problem = 'validation.refPattern'
    }
    problems.push(problem)
    if (key !== '') seenKeys.add(key)
  }
  return problems
}

/** Staged header rows: field-name/ref grammar and duplicate names/refs. */
function headerProblems(draft: AddDraft): (SettingsKey | undefined)[] {
  const problems: (SettingsKey | undefined)[] = []
  const seenNames = new Set<string>()
  const seenRefs = new Set<string>()
  for (const row of draft.headers) {
    const name = row.name.trim()
    const ref = row.ref.trim()
    const hasValue = row.value !== ''
    if (name === '' && ref === '' && !hasValue) {
      problems.push(undefined)
      continue
    }
    let problem: SettingsKey | undefined
    if (name === '') {
      problem = 'validation.headerNameEmpty'
    } else if (!HEADER_NAME_PATTERN.test(name)) {
      problem = 'validation.headerNameToken'
    } else if (seenNames.has(name)) {
      problem = 'validation.headerNameDuplicate'
    } else if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      problem = 'validation.refPattern'
    } else if (seenRefs.has(ref)) {
      // Two header names can collapse onto one ref (X-Api-Key / X_Api_Key):
      // without this, saving silently shadows one credential with the other.
      problem = 'validation.refDuplicate'
    }
    problems.push(problem)
    if (name !== '') seenNames.add(name)
    if (ref !== '') seenRefs.add(ref)
  }
  return problems
}

/** OAuth block problems (http only; the data-model rules of validateDoc mirror these). */
function oauthProblem(draft: AddDraft): AddProblems['oauth'] {
  if (draft.transport === 'stdio') return draft.oauthEnabled ? 'stdio' : undefined
  if (!draft.oauthEnabled) return undefined
  const hasAuthorizationHeader = draft.headers.some(
    (row) => row.name.trim() !== '' && row.name.trim().toLowerCase() === 'authorization',
  )
  if (hasAuthorizationHeader) return 'header'
  if (draft.oauthClientId !== '' && draft.oauthClientId.trim() === '') return 'clientId'
  return undefined
}

/**
 * Pure staged-draft validation. Problems with real content are revealed live;
 * Save stays clickable and submission opens the summary + focuses the first
 * invalid field (a disabled Save would be a dead end).
 */
export function evaluateDraft(draft: AddDraft, existingNames: readonly string[]): AddProblems {
  const problems: AddProblems = { args: [], env: [], headers: [] }
  const name = draft.name.trim()
  if (name === '' || !SERVER_NAME_PATTERN.test(name)) {
    problems.name = 'pattern'
  } else if (RESERVED_OVERRIDE_KEYS.has(name)) {
    problems.name = 'reserved'
  } else if (existingNames.includes(name)) {
    problems.name = 'duplicate'
  }

  const expanded = expansionEnabled(draft)
  if (draft.transport === 'stdio') {
    const command = draft.command.trim()
    if (command === '') problems.command = 'required'
    else if (expanded && hasTemplateTrap(command)) problems.command = 'template'
    for (const arg of draft.args) problems.args.push(expanded && hasTemplateTrap(arg) ? 'validation.templateSyntax' : undefined)
    if (draft.cwd !== '' && expanded && hasTemplateTrap(draft.cwd)) problems.cwd = 'template'
    problems.env = envProblems(draft)
  } else {
    const url = draft.url.trim()
    if (url === '') {
      problems.url = 'required'
    } else if (!looksLikeHttpUrl(url)) {
      problems.url = 'invalid'
    } else if (expanded && hasTemplateTrap(url)) {
      problems.url = 'template'
    }
    problems.headers = headerProblems(draft)
  }

  if (invalidInteger(integerValue(draft.startupTimeoutMs), 1, MAX_TIMER_DELAY_MS)) {
    problems.startupTimeoutMs = 'range'
  }
  if (invalidInteger(integerValue(draft.closeTimeoutMs), 1, MAX_TIMER_DELAY_MS)) {
    problems.closeTimeoutMs = 'range'
  }
  if (invalidInteger(integerValue(draft.toolCallTimeoutMs), 1, MAX_TIMER_DELAY_MS)) {
    problems.toolCallTimeoutMs = 'range'
  }
  problems.reconnect = reconnectProblem(draft.reconnect)
  problems.oauth = oauthProblem(draft)
  return problems
}

/** Any problem present? (submission blocks while true) */
export function hasProblems(problems: AddProblems): boolean {
  return (
    problems.name !== undefined ||
    problems.command !== undefined ||
    problems.cwd !== undefined ||
    problems.url !== undefined ||
    problems.args.some((problem) => problem !== undefined) ||
    problems.startupTimeoutMs !== undefined ||
    problems.closeTimeoutMs !== undefined ||
    problems.toolCallTimeoutMs !== undefined ||
    problems.reconnect !== undefined ||
    problems.env.some((problem) => problem !== undefined) ||
    problems.headers.some((problem) => problem !== undefined) ||
    problems.oauth !== undefined
  )
}

/** Focus target of the first staged problem (visual order consumed by the editor). */
export type DraftProblemField =
  | 'name'
  | 'command'
  | 'url'
  | 'cwd'
  | 'startupTimeoutMs'
  | 'closeTimeoutMs'
  | 'toolCallTimeoutMs'
  | 'reconnect'
  | 'oauth'
  | { arg: number }
  | { env: number }
  | { header: number }

/**
 * First problem in the editor's visual order: name -> command/url -> args ->
 * cwd -> the three timeouts -> reconnect -> env rows -> header rows -> oauth.
 */
export function firstProblemField(problems: AddProblems): DraftProblemField | undefined {
  if (problems.name !== undefined) return 'name'
  if (problems.command !== undefined) return 'command'
  if (problems.url !== undefined) return 'url'
  const arg = problems.args.findIndex((problem) => problem !== undefined)
  if (arg >= 0) return { arg }
  if (problems.cwd !== undefined) return 'cwd'
  if (problems.startupTimeoutMs !== undefined) return 'startupTimeoutMs'
  if (problems.closeTimeoutMs !== undefined) return 'closeTimeoutMs'
  if (problems.toolCallTimeoutMs !== undefined) return 'toolCallTimeoutMs'
  if (problems.reconnect !== undefined) return 'reconnect'
  const env = problems.env.findIndex((problem) => problem !== undefined)
  if (env >= 0) return { env }
  const header = problems.headers.findIndex((problem) => problem !== undefined)
  if (header >= 0) return { header }
  if (problems.oauth !== undefined) return 'oauth'
  return undefined
}

/** Explicit knobs of one materialized row (only non-default values are ever written). */
function knobsOf(draft: AddDraft): ServerKnobDef {
  const knobs: ServerKnobDef = {}
  const startup = integerValue(draft.startupTimeoutMs)
  if (startup !== undefined && !Number.isNaN(startup)) knobs.startupTimeoutMs = startup
  const close = integerValue(draft.closeTimeoutMs)
  if (close !== undefined && !Number.isNaN(close)) knobs.closeTimeoutMs = close
  const toolCall = integerValue(draft.toolCallTimeoutMs)
  if (toolCall !== undefined && !Number.isNaN(toolCall)) knobs.toolCallTimeoutMs = toolCall
  const reconnect = reconnectConfigOf(draft.reconnect)
  if (reconnect !== undefined) knobs.reconnect = reconnect
  // 'eager' is the upstream default: writing it would only pin a representation.
  if (draft.toolLoading === 'on-demand') knobs.toolLoading = 'on-demand'
  return knobs
}

/** Reconnect block of one materialized row, or undefined for "use upstream defaults". */
function reconnectConfigOf(reconnect: DraftReconnect): ReconnectConfig | undefined {
  const initial = integerValue(reconnect.initialDelayMs)
  const max = integerValue(reconnect.maxDelayMs)
  const attempts = integerValue(reconnect.maxAttempts)
  if (
    reconnect.enabled === RECONNECT_DEFAULTS.enabled &&
    initial === undefined &&
    max === undefined &&
    attempts === undefined
  ) {
    return undefined
  }
  const out: ReconnectConfig = { enabled: reconnect.enabled }
  if (initial !== undefined && !Number.isNaN(initial)) out.initialDelayMs = initial
  if (max !== undefined && !Number.isNaN(max)) out.maxDelayMs = max
  if (attempts !== undefined && !Number.isNaN(attempts)) out.maxAttempts = attempts
  return out
}

/** OAuth block of one materialized row (never carries a credentialKey: the host derives it). */
function oauthConfigOf(draft: AddDraft): OAuthServerDef | undefined {
  if (draft.transport !== 'streamable-http' || !draft.oauthEnabled) return undefined
  const clientId = draft.oauthClientId.trim()
  const scope = draft.oauthScope.trim()
  const oauth: { clientId?: string; scope?: string } = {}
  if (clientId !== '') oauth.clientId = clientId
  if (scope !== '') oauth.scope = scope
  if (Object.keys(oauth).length === 0) return { requestTimeoutMs: OAUTH_ENABLE_SENTINEL_MS }
  return oauth as OAuthServerDef
}

/**
 * Materialize the staged draft into its wire shapes: the ServerDef plus the
 * secrets staged this run (non-empty literals). Blank secret values simply keep
 * whatever the credentials domain already holds for the ref. Callers must have
 * checked {@link hasProblems} first.
 */
export function draftToServer(draft: AddDraft): ServerSaveInput {
  const name = draft.name.trim()
  const secrets: SecretWriteLike[] = []
  const knobs = knobsOf(draft)
  if (draft.transport === 'stdio') {
    const args = draft.args.map((arg) => arg.trim()).filter((arg) => arg !== '')
    const cwd = draft.cwd.trim()
    const env: Record<string, string> = {}
    for (const row of draft.env) {
      const key = row.key.trim()
      if (key === '') continue
      const ref = row.ref.trim() || key
      env[key] = templateFor(ref)
      if (row.value !== '') secrets.push({ ref, value: row.value })
    }
    const server: ServerDef = {
      serverName: name,
      transport: 'stdio',
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(cwd !== '' ? { cwd } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...knobs,
    }
    return { server, secrets, enabled: draft.enabled }
  }
  const headers: Record<string, string> = {}
  for (const row of draft.headers) {
    const headerName = row.name.trim()
    const ref = row.ref.trim()
    if (headerName === '' || ref === '') continue
    headers[headerName] = templateFor(ref)
    if (row.value !== '') secrets.push({ ref, value: row.value })
  }
  const oauth = oauthConfigOf(draft)
  // The document row accepts both the legacy {name,ref} rows and the upstream
  // credential-template map; the writer emits the map (host-config.ts consumes
  // exactly that).
  const server: ServerDef = {
    serverName: name,
    transport: 'streamable-http',
    url: draft.url.trim(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    ...knobs,
  }
  return { server, secrets, enabled: draft.enabled }
}

/** Structural twin of SecretWrite used by draftToServer's return typing. */
type SecretWriteLike = { ref: string; value: string }
