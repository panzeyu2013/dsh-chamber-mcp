/**
 * Framework-free domain core of the MCP-servers settings section.
 *
 * Deliberately imports no React and no client UI package: components and the
 * cordis wiring (`apply`) consume this controller, and the pure write-plan
 * helpers (`buildSaveOps`, `toggleOp`, `decodeDoc`, …) are unit-tested
 * directly (tests/client/controller.spec.ts).
 *
 * Runtime-write layout (shared with `src/shared/model.ts`):
 *   servers:   ServerDef[]            — whole-array replace is ONE atomic op
 *   overrides: { [workspaceId]: { [serverName]: true } }  — presence = OFF
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
  validateDoc,
  type McpScopeDoc,
  type ServerDef,
  type WorkspaceOverrides,
} from '../shared/model.js'

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
  } else if (row && serverName in row) {
    delete row[serverName]
    if (Object.keys(row).length === 0) delete overrides[workspaceId]
  }
  return { servers: doc.servers, overrides }
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
      const had = name in prevRow
      const want = name in nextRow
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

/** Classify a rejected settings write (revision fence or other). */
export function classifySaveError(error: unknown): 'conflict' | 'save-failed' {
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
  | { ok: false; reason: 'invalid' | 'conflict' | 'save-failed' | 'secret-write-failed'; refs?: string[] }

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

/** Face the section registration injects (hooks → `useDoc` + actions). */
export interface McpScopeFace {
  hooks: {
    doc: McpStoreSource
  }
  addServer(input: { server: ServerDef; secrets: readonly SecretWrite[] }): Promise<SaveOutcome>
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

  /** Badge refresh after a credentials-domain change names one of our refs. */
  onCredentialRefUpdated(ref: string): void {
    if (this.disposed) return
    if (ref in this.snapshot.credentials) void this.refreshCredentials()
  }

  /** Re-describe every ref the current document names. */
  async refreshCredentials(): Promise<void> {
    if (this.disposed) return
    const refs = credentialRefsOfDoc(this.snapshot.doc)
    if (refs.length === 0) {
      if (Object.keys(this.snapshot.credentials).length > 0) {
        this.snapshot = { ...this.snapshot, credentials: EMPTY_CREDENTIALS, credentialsAt: this.snapshot.credentialsAt + 1 }
        this.publish()
      }
      return
    }
    try {
      const views = await this.credentials.describe(refs)
      if (this.disposed) return
      // Publish only what we asked for; unknown keys are dropped.
      const credentials: Record<string, CredentialInfo> = {}
      for (const ref of refs) {
        const view = views[ref]
        if (view) credentials[ref] = view
      }
      this.snapshot = { ...this.snapshot, credentials, credentialsAt: this.snapshot.credentialsAt + 1 }
      this.publish()
    } catch {
      // A describe failure must not break the section; badges stay stale and
      // the next refresh attempt (event or write) retries.
    }
  }

  /** Save one staged server: secrets first, then ONE atomic doc mutation. */
  async addServer(input: { server: ServerDef; secrets: readonly SecretWrite[] }): Promise<SaveOutcome> {
    const base = this.snapshot
    if (base.status === 'loading' || base.status === 'unavailable') {
      return { ok: false, reason: base.status === 'unavailable' ? 'save-failed' : 'invalid' }
    }
    const next: McpScopeDoc = { servers: [...base.doc.servers, input.server], overrides: base.doc.overrides }
    const outcome = await this.submitPlan(base, next, input.secrets)
    return outcome
  }

  /** Remove one server; credentials orphaned by the removal are cleared. */
  async removeServer(serverName: string): Promise<SaveOutcome> {
    const base = this.snapshot
    const target = base.doc.servers.find((server) => server.serverName === serverName)
    if (!target) return { ok: true }
    const next: McpScopeDoc = {
      servers: base.doc.servers.filter((server) => server.serverName !== serverName),
      overrides: base.doc.overrides,
    }
    const outcome = await this.submitPlan(base, next, [])
    return outcome
  }

  /** Toggle one workspace switch (atomic single-purpose mutation). */
  async toggleWorkspace(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome> {
    const base = this.snapshot
    if (base.status === 'loading' || base.status === 'unavailable') {
      return { ok: false, reason: 'save-failed' }
    }
    const ops = toggleOp(base.doc, workspaceId, serverName, off)
    if (ops.length === 0) return { ok: true }
    return this.applyOps(ops, base.revision)
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

  /**
   * Shared pipeline: (1) doc pre-validation, (2) sequential credential writes
   * for dirty secrets — any failure aborts BEFORE the document write,
   * (3) one revision-fenced mutation carrying the whole plan.
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
    const failedRefs: string[] = []
    for (const secret of dirty) {
      try {
        await this.credentials.set(secret.ref, secret.value)
      } catch {
        failedRefs.push(secret.ref)
      }
    }
    if (failedRefs.length > 0) {
      // Partial writes may have landed; the doc itself is untouched.
      return { ok: false, reason: 'secret-write-failed', refs: failedRefs }
    }
    const plan = buildSaveOps(base.doc, next)
    if (plan.ops.length > 0) {
      const written = await this.applyOps(plan.ops, base.revision)
      if (!written.ok) return written
    }
    if (plan.unsetRefs.length > 0) {
      await this.unsetQuietly(plan.unsetRefs)
    }
    return { ok: true }
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

  private async applyOps(
    ops: readonly SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SaveOutcome> {
    try {
      await this.scope.mutate(ops, expectedRevision)
    } catch (error) {
      const reason = classifySaveError(error)
      this.refresh()
      return { ok: false, reason }
    }
    this.refresh()
    return { ok: true }
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
