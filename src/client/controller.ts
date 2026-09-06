/**
 * Framework-free domain core of the MCP-servers settings section.
 *
 * Deliberately imports no React and no client UI package: components and the
 * cordis wiring (`apply`) consume this controller, and the pure write-plan
 * helpers (`buildSaveOps`, `toggleOp`, `decodeDoc`, `docsEqual`, …) are
 * unit-tested directly (tests/client/controller.spec.ts).
 *
 * Runtime-write layout (shared with `src/shared/model.ts`):
 *   servers:   ServerDef[]            — whole-array replace is ONE atomic op
 *   overrides: { [workspaceId]: { [serverName]: true } }  — presence = OFF
 *
 * Write-verification contract: this runtime's scope.mutate RESOLVES even when
 * the Host refuses the write (the refusal triggers an internal mirror reload
 * and a silent return), so a resolved promise alone never reports success —
 * `applyOps` re-reads the scope after the mutation and compares the landed
 * document against the intended one (FE-1).
 */

import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  CREDENTIAL_REF_PATTERN,
  EMPTY_DOC,
  MCP_SCOPE_NAMESPACE,
  credentialRefsOf,
  isEnabled,
  removeServerOverrides,
  validateDoc,
  type McpScopeDoc,
  type ServerDef,
  type WorkspaceOverrides,
} from '../shared/model.js'
import type { SettingsKey } from './locales.js'

export { MCP_SCOPE_NAMESPACE }
export type { CredentialInfo }

/** Rows whose last explicit off-switch was toggled back on are dropped. */
export function pruneEmptyOverrideRows(overrides: WorkspaceOverrides): WorkspaceOverrides {
  const next: WorkspaceOverrides = {}
  for (const [workspaceId, row] of Object.entries(overrides)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const rest: Record<string, true> = {}
    for (const [name, off] of Object.entries(row)) {
      if (off === true) rest[name] = true
    }
    if (Object.keys(rest).length > 0) next[workspaceId] = rest
  }
  return next
}

/**
 * Canonical shape of one bound-scope document. Host-side the value is already
 * schema-validated; this only guards structure (missing arrays, malformed
 * rows) so the UI never trips on an unexpected wire shape.
 */
export function decodeDoc(raw: unknown): McpScopeDoc {
  if (raw === null || typeof raw !== 'object') return EMPTY_DOC
  const section = raw as Record<string, unknown>
  const servers = Array.isArray(section.servers)
    ? (section.servers as unknown[]).filter((s): s is ServerDef => s !== null && typeof s === 'object')
    : []
  const overridesRaw = section.overrides
  const overrides =
    overridesRaw !== null && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw)
      ? pruneEmptyOverrideRows(overridesRaw as WorkspaceOverrides)
      : {}
  return { servers, overrides }
}

/** Copy a doc into canonical shape (empty override rows pruned). */
export function normalizeDoc(doc: McpScopeDoc): McpScopeDoc {
  return { servers: doc.servers, overrides: pruneEmptyOverrideRows(doc.overrides) }
}

/** Stable structural equality for server lists (arrays: order matters). */
export function serversEqual(left: readonly ServerDef[], right: readonly ServerDef[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function arrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Field-wise structural equality of two server definitions, ignoring object
 * key order and treating absent arrays as empty (wire decoders may drop or
 * add empty containers without changing semantics). Used by the landed-write
 * comparison, which must never trip on representation noise.
 */
export function serverDefEqual(left: ServerDef, right: ServerDef): boolean {
  if (left.serverName !== right.serverName || left.transport !== right.transport) return false
  if (left.transport === 'stdio' && right.transport === 'stdio') {
    if (left.command !== right.command) return false
    if ((left.cwd ?? '') !== (right.cwd ?? '')) return false
    if (!arrayEqual(left.args ?? [], right.args ?? [])) return false
    return arrayEqual(left.envKeys ?? [], right.envKeys ?? [])
  }
  if (left.transport === 'streamable-http' && right.transport === 'streamable-http') {
    if (left.url !== right.url) return false
    const leftHeaders = left.headers ?? []
    const rightHeaders = right.headers ?? []
    return (
      leftHeaders.length === rightHeaders.length &&
      leftHeaders.every((header, index) => {
        const other = rightHeaders[index]
        return other !== undefined && header.name === other.name && header.ref === other.ref
      })
    )
  }
  return false
}

/**
 * Whole-document structural equality over both sides normalized (empty
 * override rows pruned). Servers must match in order, element-wise; override
 * rows are compared as key sets. This is the re-read check that decides
 * whether a mutation actually LANDED (FE-1).
 */
export function docsEqual(left: McpScopeDoc, right: McpScopeDoc): boolean {
  const a = normalizeDoc(left)
  const b = normalizeDoc(right)
  if (a.servers.length !== b.servers.length) return false
  for (let index = 0; index < a.servers.length; index += 1) {
    const server = a.servers[index]
    const other = b.servers[index]
    if (server === undefined || other === undefined || !serverDefEqual(server, other)) return false
  }
  const aKeys = Object.keys(a.overrides)
  const bKeys = Object.keys(b.overrides)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((workspaceId) => {
    const aRow = a.overrides[workspaceId]
    const bRow = b.overrides[workspaceId]
    if (aRow === undefined || bRow === undefined) return false
    const aNames = Object.keys(aRow)
    const bNames = Object.keys(bRow)
    return aNames.length === bNames.length && aNames.every((name) => name in bRow)
  })
}

/** All credential refs a whole document references, deduplicated, in doc order. */
export function credentialRefsOfDoc(doc: McpScopeDoc): string[] {
  const seen = new Set<string>()
  const refs: string[] = []
  for (const server of doc.servers) {
    for (const ref of credentialRefsOf(server)) {
      if (!seen.has(ref)) {
        seen.add(ref)
        refs.push(ref)
      }
    }
  }
  return refs
}

/** Set `off` for one (workspace, server); undefined vs {name:true} presence. */
export function overrideDoc(
  doc: McpScopeDoc,
  workspaceId: string,
  serverName: string,
  off: boolean,
): McpScopeDoc {
  const overrides: WorkspaceOverrides = {}
  for (const [ws, row] of Object.entries(doc.overrides)) {
    overrides[ws] = { ...row }
  }
  const row = overrides[workspaceId]
  if (off) {
    overrides[workspaceId] = { ...(row ?? {}), [serverName]: true }
  } else if (row !== undefined && row !== null && Object.hasOwn(row, serverName)) {
    delete row[serverName]
    if (Object.keys(row).length === 0) delete overrides[workspaceId]
  }
  return { servers: doc.servers, overrides }
}

/**
 * Rename the off-switch keys of one server across every workspace row
 * (edit-with-rename). Presence semantics are preserved per workspace; rows
 * that did not switch the old name off are returned untouched.
 */
export function renameOverrideKey(
  overrides: WorkspaceOverrides,
  from: string,
  to: string,
): WorkspaceOverrides {
  if (from === to) return overrides
  const next: WorkspaceOverrides = {}
  let changed = false
  for (const [workspaceId, row] of Object.entries(overrides)) {
    const rest: Record<string, true> = {}
    for (const name of Object.keys(row)) {
      if (name === from) {
        rest[to] = true
        changed = true
      } else {
        rest[name] = true
      }
    }
    if (Object.keys(rest).length > 0) next[workspaceId] = rest
  }
  return changed ? next : overrides
}

/** Path ops turning `prev`'s overrides into `next`'s (both canonical). */
function diffOverrides(prev: McpScopeDoc, next: McpScopeDoc): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = []
  const workspaceIds = new Set([...Object.keys(prev.overrides), ...Object.keys(next.overrides)])
  for (const ws of workspaceIds) {
    const prevRow = prev.overrides[ws] ?? {}
    const nextRow = next.overrides[ws] ?? {}
    const names = new Set([...Object.keys(prevRow), ...Object.keys(nextRow)])
    for (const name of names) {
      // Own-property semantics (F1): `in` would read Object.prototype
      // members as phantom off-switches for names like `toString`.
      const had = Object.hasOwn(prevRow, name)
      const want = Object.hasOwn(nextRow, name)
      if (had === want) continue
      ops.push(
        want
          ? { op: 'set', path: ['overrides', ws, name], value: true }
          : { op: 'unset', path: ['overrides', ws, name] },
      )
    }
    if (Object.keys(prevRow).length > 0 && Object.keys(nextRow).length === 0) {
      ops.push({ op: 'unset', path: ['overrides', ws] })
    }
  }
  return ops
}

/** All credential refs prev referenced that no remaining server still uses. */
function orphanedRefs(prev: McpScopeDoc, next: McpScopeDoc): string[] {
  const stillUsed = new Set(credentialRefsOfDoc(next))
  const orphaned: string[] = []
  for (const ref of credentialRefsOfDoc(prev)) {
    if (!stillUsed.has(ref)) orphaned.push(ref)
  }
  return orphaned
}

/**
 * Pure write plan diffing two canonical documents.
 *
 * One `set ['servers']` op carries the whole array (atomic, redacted-writer
 * safe: the UI holds the full document it writes, unlike per-index ops which
 * would need confirmed host array-path semantics); overrides move through
 * one path op per toggled (workspace, server) with empty-row pruning, exactly
 * the atomic per-workspace toggle the shared model stores.
 */
export function buildSaveOps(
  prev: McpScopeDoc,
  next: McpScopeDoc,
): { ops: SettingsPathOpView[]; unsetRefs: string[] } {
  const from = normalizeDoc(prev)
  const to = normalizeDoc(next)
  const ops: SettingsPathOpView[] = []
  if (!serversEqual(from.servers, to.servers)) {
    ops.push({ op: 'set', path: ['servers'], value: to.servers as unknown as JsonValue })
  }
  ops.push(...diffOverrides(from, to))
  return { ops, unsetRefs: orphanedRefs(from, to) }
}

/** Pure plan for one workspace switch. Empty when nothing would change. */
export function toggleOp(
  prev: McpScopeDoc,
  workspaceId: string,
  serverName: string,
  off: boolean,
): SettingsPathOpView[] {
  const from = normalizeDoc(prev)
  const to = overrideDoc(from, workspaceId, serverName, off)
  return diffOverrides(from, to)
}

/** Whether the staged document passes the shared host-side validation. */
export function docErrors(doc: McpScopeDoc): string[] {
  return validateDoc(doc)
}

/**
 * Classify a rejected settings write (revision fence or other).
 *
 * Platform rule: failures are discriminated by their typed surface — a
 * RemoteError carries `code` plus the `isDSHRemoteError` marker, and the
 * host's own conflict error carries `code: 'SETTINGS_CONFLICT'` — never by
 * message text. Check the typed surface first; the message scan is only a
 * backstop for non-platform errors (FE-2).
 */
export function classifySaveError(error: unknown): 'conflict' | 'save-failed' {
  if (error !== null && typeof error === 'object') {
    const typed = error as { code?: unknown; isDSHRemoteError?: unknown }
    if (typeof typed.code === 'string') {
      return typed.code === 'settings/conflict' || typed.code === 'SETTINGS_CONFLICT'
        ? 'conflict'
        : 'save-failed'
    }
    if (typed.isDSHRemoteError === true) return 'save-failed'
  }
  const candidate =
    error !== null && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)
  if (/conflict|revision|stale|expected/i.test(candidate)) return 'conflict'
  return 'save-failed'
}

/** Outcome of a full save pipeline, keyed for localized display. */
export type SaveOutcome =
  | { ok: true }
  | {
      ok: false
      reason: 'invalid' | 'conflict' | 'save-failed' | 'secret-write-failed'
      refs?: string[]
      /** Refs this attempt overwrote (had a stored value before) whose new
       * literal remains stored although the document write was refused —
       * surfaced so the UI can tell the user the truth (R2U-02). */
      keptSecretRefs?: string[]
    }

export type SaveFailure = SaveOutcome & { ok: false }

/** Locale key of one failed outcome's message (components call `t(key)`). */
export function failureKey(failure: SaveFailure): SettingsKey {
  switch (failure.reason) {
    case 'conflict':
      return 'error.conflict'
    case 'secret-write-failed':
      return 'error.secretWriteFailed'
    case 'save-failed':
      return 'error.saveFailed'
    case 'invalid':
      return 'error.unexpected'
  }
}

/** Interpolation params for the failed-outcome message, when it has any. */
export function failureParams(failure: SaveFailure): Record<string, string> | undefined {
  return failure.reason === 'secret-write-failed' ? { refs: (failure.refs ?? []).join(', ') } : undefined
}

/** Minimal structural translate seat (compatible with the injected `t`). */
export interface TextSeat {
  (key: SettingsKey, params?: Record<string, string | number>): string
}

/** Localized text of a failed outcome through the caller's translate seat. */
export function failureText(t: TextSeat, failure: SaveFailure): string {
  const params = failureParams(failure)
  const base = params === undefined ? t(failureKey(failure)) : t(failureKey(failure), params)
  const kept = failure.keptSecretRefs
  if (kept === undefined || kept.length === 0) return base
  return `${base} ${t('error.conflictKeptRefs', { refs: kept.join(', ') })}`
}

export interface SecretWrite {
  ref: string
  value: string
}

/**
 * Structural fold of the rc.1 Typert Remote result union (business failures
 * ride the `{ok:false}` branch instead of throwing).
 */
export type RemoteResultLike<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message?: string } }

/** Structural subset of the rc.1 `SettingsScope<T>` the controller needs. */
export interface SettingsScopePort {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: McpScopeDoc | undefined
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<void>
}

/** Structural subset of the rc.1 `remote.credentials` namespace. */
export interface CredentialsGateway {
  describe(refs: readonly string[]): Promise<Readonly<Record<string, CredentialInfo>>>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** The reactive store snapshot the section subscribes to. */
export interface McpStoreSnapshot {
  /** Mirrors the bound scope's document status. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Decoded document (empty while loading/unavailable). */
  doc: McpScopeDoc
  /** Namespace revision fencing the next write. */
  revision: number | undefined
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Configured/writable views per credential ref, refreshed via describe. */
  credentials: Readonly<Record<string, CredentialInfo>>
  /** Monotone counter bumped whenever credentials were re-described. */
  credentialsAt: number
}

/** Observable store source handed to the renderer (`hooks.doc` seat). */
export interface McpStoreSource {
  getSnapshot(): McpStoreSnapshot
  subscribe(listener: () => void): () => void
}

/** One staged server save (add or whole-array replace). */
export interface ServerSaveInput {
  server: ServerDef
  secrets: readonly SecretWrite[]
}

/** Face the section registration injects (hooks → `useDoc` + actions). */
export interface McpScopeFace {
  hooks: {
    doc: McpStoreSource
  }
  addServer(input: ServerSaveInput): Promise<SaveOutcome>
  /** Replace an existing server (edit): whole-array save under its old name. */
  replaceServer(oldServerName: string, input: ServerSaveInput): Promise<SaveOutcome>
  removeServer(serverName: string): Promise<SaveOutcome>
  toggleWorkspace(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome>
  /** Clear one stored credential literal (badge "Clear" affordance). */
  unsetCredential(ref: string): Promise<SaveOutcome>
}

const EMPTY_CREDENTIALS: Readonly<Record<string, CredentialInfo>> = Object.freeze({})

/**
 * Owns the scope subscription and the save pipelines; components hold no
 * domain logic. Constructor binds nothing — call {@link start} from an
 * effect (returns its disposer) so teardown is fiber-owned.
 */
export class McpScopeController {
  private readonly scope: SettingsScopePort
  private readonly credentials: CredentialsGateway
  private snapshot: McpStoreSnapshot
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private unsubscribeScope: (() => void) | undefined
  /** Bumped at every describe start; stale runs must not publish (FE-6). */
  private credentialsGeneration = 0

  constructor(scope: SettingsScopePort, credentials: CredentialsGateway) {
    this.scope = scope
    this.credentials = credentials
    this.snapshot = this.derive()
  }

  /** Observable face of the store (getSnapshot stable between publishes). */
  get store(): McpStoreSource {
    return { getSnapshot: () => this.snapshot, subscribe: (fn) => this.subscribe(fn) }
  }

  /** The registration-inject face: store hook seat + bound actions. */
  face(): McpScopeFace {
    const self = this
    return {
      hooks: { doc: this.store },
      addServer: (input) => self.addServer(input),
      replaceServer: (oldServerName, input) => self.replaceServer(oldServerName, input),
      removeServer: (serverName) => self.removeServer(serverName),
      toggleWorkspace: (workspaceId, serverName, off) => self.toggleWorkspace(workspaceId, serverName, off),
      unsetCredential: (ref) => self.unsetCredential(ref),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to the bound scope; returns the combined disposer. */
  start(): () => void {
    this.unsubscribeScope = this.scope.subscribe(() => {
      this.snapshot = this.derive()
      this.publish()
      void this.refreshCredentials()
    })
    // Initial describe pass so badges render on first open.
    void this.refreshCredentials()
    return () => this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.credentialsGeneration += 1
    this.unsubscribeScope?.()
    this.unsubscribeScope = undefined
    this.listeners.clear()
  }

  /** Re-read the scope snapshot and re-describe current refs. */
  refresh(): void {
    if (this.disposed) return
    this.snapshot = this.derive()
    this.publish()
    void this.refreshCredentials()
  }

  /**
   * Badge refresh after a credentials-domain change names one of our refs.
   * The gate is the CURRENT DOC's ref set, not badge-map membership: a
   * previous describe may have failed (ref absent from the map) and this
   * event is the quiet retry that must still refresh (UX-08).
   */
  onCredentialRefUpdated(ref: string): void {
    if (this.disposed) return
    if (credentialRefsOfDoc(this.snapshot.doc).includes(ref)) void this.refreshCredentials()
  }

  /**
   * Re-describe every ref the current document names.
   *
   * FE-6: out-of-order-publish guard. Overlapping runs (a doc change or a
   * reference event while a describe is in flight) may settle out of order;
   * a run may publish only while it is still the newest run AND the doc's
   * ref set is still exactly the set it described. Stale results are
   * discarded instead of rolling back fresher views.
   */
  async refreshCredentials(): Promise<void> {
    if (this.disposed) return
    const refs = credentialRefsOfDoc(this.snapshot.doc)
    if (refs.length === 0) {
      this.credentialsGeneration += 1 // invalidate any in-flight describe
      if (Object.keys(this.snapshot.credentials).length > 0) {
        this.snapshot = { ...this.snapshot, credentials: EMPTY_CREDENTIALS, credentialsAt: this.snapshot.credentialsAt + 1 }
        this.publish()
      }
      return
    }
    const generation = ++this.credentialsGeneration
    const refsAtStart = refs
    try {
      const views = await this.credentials.describe(refs)
      if (this.disposed) return
      if (generation !== this.credentialsGeneration) return // superseded by a newer run
      const refsNow = credentialRefsOfDoc(this.snapshot.doc)
      if (refsNow.length !== refsAtStart.length || refsNow.some((ref, index) => ref !== refsAtStart[index])) {
        return // the document moved on while the describe was in flight
      }
      // Publish only what we asked for; unknown keys are dropped.
      const credentials: Record<string, CredentialInfo> = {}
      for (const ref of refs) {
        const view = views[ref]
        if (view) credentials[ref] = view
      }
      this.snapshot = { ...this.snapshot, credentials, credentialsAt: this.snapshot.credentialsAt + 1 }
      this.publish()
    } catch {
      // A describe failure must not break the section; badges stay
      // last-known/unknown and the next refresh attempt (event or write)
      // retries.
    }
  }

  /** Save one staged server: secrets first, then ONE atomic doc mutation. */
  async addServer(input: ServerSaveInput): Promise<SaveOutcome> {
    const base = this.snapshot
    if (base.status === 'loading' || base.status === 'unavailable') {
      return { ok: false, reason: base.status === 'unavailable' ? 'save-failed' : 'invalid' }
    }
    const next: McpScopeDoc = { servers: [...base.doc.servers, input.server], overrides: base.doc.overrides }
    return this.submitPlan(base, next, input.secrets)
  }

  /**
   * Replace one server in place (edit flow). The staged definition replaces
   * the original at its index through the same whole-array save pipeline;
   * per-workspace off-switches follow a rename (overrides are keyed by
   * serverName). A missing original means the list moved on — surface that
   * as a conflict instead of silently appending.
   */
  async replaceServer(oldServerName: string, input: ServerSaveInput): Promise<SaveOutcome> {
    const base = this.snapshot
    if (base.status === 'loading' || base.status === 'unavailable') {
      return { ok: false, reason: base.status === 'unavailable' ? 'save-failed' : 'invalid' }
    }
    if (!base.doc.servers.some((server) => server.serverName === oldServerName)) {
      return { ok: false, reason: 'conflict' }
    }
    const renamed = input.server.serverName !== oldServerName
    const servers = base.doc.servers.map((server) => (server.serverName === oldServerName ? input.server : server))
    const overrides = renamed
      ? renameOverrideKey(base.doc.overrides, oldServerName, input.server.serverName)
      : base.doc.overrides
    return this.submitPlan(base, { servers, overrides }, input.secrets)
  }

  /** Remove one server; credentials orphaned by the removal are cleared. */
  async removeServer(serverName: string): Promise<SaveOutcome> {
    const base = this.snapshot
    const target = base.doc.servers.find((server) => server.serverName === serverName)
    if (!target) return { ok: true }
    const next: McpScopeDoc = {
      servers: base.doc.servers.filter((server) => server.serverName !== serverName),
      // Prune the removed server from every workspace's off-switch rows so a
      // later re-add cannot resurrect as OFF through an orphaned row.
      overrides: removeServerOverrides(base.doc.overrides, serverName),
    }
    return this.submitPlan(base, next, [])
  }

  /** Toggle one workspace switch (atomic single-purpose mutation). */
  async toggleWorkspace(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome> {
    const base = this.snapshot
    if (base.status === 'loading' || base.status === 'unavailable') {
      return { ok: false, reason: 'save-failed' }
    }
    const ops = toggleOp(base.doc, workspaceId, serverName, off)
    if (ops.length === 0) return { ok: true }
    const next = overrideDoc(base.doc, workspaceId, serverName, off)
    return this.applyOps(ops, base.revision, next)
  }

  /** Clear one stored credential literal (write-only domain, no doc write). */
  async unsetCredential(ref: string): Promise<SaveOutcome> {
    if (!CREDENTIAL_REF_PATTERN.test(ref)) return { ok: false, reason: 'invalid' }
    try {
      await this.credentials.unset(ref)
    } catch {
      return { ok: false, reason: 'secret-write-failed', refs: [ref] }
    }
    void this.refreshCredentials()
    return { ok: true }
  }

  /** Whether the snapshot's badge map proves a stored value for `ref`. */
  private wasConfigured(base: McpStoreSnapshot, ref: string): boolean {
    const view = base.credentials[ref]
    return view !== undefined && view.configured === true
  }

  /**
   * Shared pipeline: (1) doc pre-validation, (2) sequential credential writes
   * for dirty secrets — any failure aborts BEFORE the document write with
   * auto-cleanup of the values this attempt newly stored, (3) one
   * revision-fenced mutation carrying the whole plan, whose landing is
   * verified by re-read. When the document write is refused or conflicts,
   * the credentials this attempt stored that had NO stored value before are
   * auto-unset: a cancelled/failed add must never leave an untraceable
   * literal behind (FE-1 / UX-02). Refs that carried a stored value before
   * the save are never unset — the old value cannot be restored.
   */
  private async submitPlan(
    base: McpStoreSnapshot,
    next: McpScopeDoc,
    secrets: readonly SecretWrite[],
  ): Promise<SaveOutcome> {
    if (docErrors(next).length > 0) return { ok: false, reason: 'invalid' }
    const dirty: SecretWrite[] = secrets.filter((s) => s.value.length > 0)
    for (const secret of dirty) {
      if (!CREDENTIAL_REF_PATTERN.test(secret.ref)) return { ok: false, reason: 'invalid' }
    }
    const preconfigured = new Set(dirty.filter((s) => this.wasConfigured(base, s.ref)).map((s) => s.ref))
    const failedRefs: string[] = []
    const newlyStored: string[] = []
    for (const secret of dirty) {
      try {
        await this.credentials.set(secret.ref, secret.value)
        newlyStored.push(secret.ref)
      } catch {
        failedRefs.push(secret.ref)
      }
    }
    if (failedRefs.length > 0) {
      // Abort-on-secret-failure: partial writes of THIS attempt are undone
      // (new values only); the doc itself is untouched.
      await this.cleanupNewlyStored(newlyStored, preconfigured)
      return { ok: false, reason: 'secret-write-failed', refs: failedRefs }
    }
    const plan = buildSaveOps(base.doc, next)
    if (plan.ops.length > 0) {
      const written = await this.applyOps(plan.ops, base.revision, next)
      if (!written.ok) {
        // Doc write refused/conflicted: undo the secrets this attempt wrote
        // (new refs only), then report. Refs that already held a value keep
        // the newly typed literal — the old value cannot be restored — and
        // that fact is surfaced for honest copy.
        await this.cleanupNewlyStored(newlyStored, preconfigured)
        const kept = dirty.filter((secret) => preconfigured.has(secret.ref)).map((secret) => secret.ref)
        return kept.length > 0 ? { ...written, keptSecretRefs: kept } : written
      }
    }
    if (plan.unsetRefs.length > 0) {
      await this.unsetQuietly(plan.unsetRefs)
    }
    return { ok: true }
  }

  /**
   * Best-effort cleanup of refs this attempt stored that had no value before.
   * A ref the CURRENT (post-refresh) document still references is never
   * unset: the refusal path is exactly when another writer may have just
   * committed that ref into a document that won — deleting it would destroy
   * the winner's fresh value (R2S-1).
   */
  private async cleanupNewlyStored(
    newlyStored: readonly string[],
    preconfigured: ReadonlySet<string>,
  ): Promise<void> {
    const referenced = new Set(credentialRefsOfDoc(this.snapshot.doc))
    const cleanup = newlyStored.filter((ref) => !preconfigured.has(ref) && !referenced.has(ref))
    if (cleanup.length > 0) await this.unsetQuietly(cleanup)
  }

  /** Best-effort credential cleanup after a successful document write. */
  private async unsetQuietly(refs: readonly string[]): Promise<void> {
    for (const ref of refs) {
      try {
        await this.credentials.unset(ref)
      } catch {
        // Best effort: an unset refusal (e.g. inherited-env shadowing) must
        // not fail an already committed removal.
      }
    }
    if (refs.length > 0) void this.refreshCredentials()
  }

  /**
   * One atomic, revision-fenced scope mutation with LANDED verification.
   *
   * This runtime's scope.mutate RESOLVES even when the Host refuses the
   * write (the refusal triggers an internal mirror reload and a silent
   * return), so a resolved promise alone cannot report success. After the
   * mutation settles we re-read the scope snapshot and compare the doc
   * against the intended one (both normalized); anything but an exact match
   * means the write did not land and must surface as a conflict — never as
   * ok (FE-1). The catch branch covers local/transport faults only.
   */
  private async applyOps(
    ops: readonly SettingsPathOpView[],
    expectedRevision: number | undefined,
    expectedDoc: McpScopeDoc,
  ): Promise<SaveOutcome> {
    let thrown: unknown
    try {
      await this.scope.mutate(ops, expectedRevision)
    } catch (error) {
      thrown = error
    }
    if (this.disposed) return { ok: false, reason: 'save-failed' }
    this.refresh()
    if (thrown !== undefined) {
      return { ok: false, reason: classifySaveError(thrown) }
    }
    return docsEqual(this.snapshot.doc, expectedDoc) ? { ok: true } : { ok: false, reason: 'conflict' }
  }

  private derive(): McpStoreSnapshot {
    const view = this.scope.getSnapshot()
    const prev = this.snapshot?.credentials ?? EMPTY_CREDENTIALS
    const prevAt = this.snapshot?.credentialsAt ?? 0
    return {
      status: view.status,
      doc: decodeDoc(view.value),
      revision: view.revision,
      writable: view.writable,
      credentials: prev,
      credentialsAt: prevAt,
    }
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener()
  }
}
