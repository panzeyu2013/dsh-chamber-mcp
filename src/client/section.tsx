/**
 * "MCP servers" settings section shell.
 *
 * The page is a small stack, not one card per server:
 *   servers list -> server detail -> editor
 *   workspaces list -> workspace detail
 *
 * The shell owns the document-write queue, optimistic scope/allow state, the
 * transient success toast, persistent action errors and the confirm dialogs.
 * Every view is presentational and receives already-narrowed callbacks.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { isEnabled, isServerDisabled } from '../shared/model.js'
import {
  failureText,
  type McpScopeFace,
  type McpStoreSnapshot,
  type SaveOutcome,
  type ServerSaveInput,
} from './controller.js'
import type { RuntimeSnapshot, RuntimeTestResult, RuntimeToolEntry } from './runtime.js'
import { NS } from './locales.js'
import { ServerListView, type ServerFilter } from './views/server-list.js'
import { ServerDetail } from './views/server-detail.js'
import { WorkspaceListView } from './views/workspace-list.js'
import { WorkspaceDetailView } from './views/workspace-detail.js'
import { ServerEditor } from './views/server-editor.js'
import { ConfirmDialog, InlineNotice, Tabs } from './components/ui.js'
import { useWriteQueue } from './hooks/use-write-queue.js'
import { EMPTY_DRAFT, draftFromServer } from './draft.js'
import {
  isServerInUse,
  orphanedRefsOf,
  runtimeOf,
  runtimeSnapshotsEqual,
  serversUsingRef,
} from './view-model.js'
import { cx, styles } from './styles.js'
import {
  workspaceItemsOf,
  workspaceListStatusOf,
  type WorkspaceListHook,
} from './workspaces.js'

/** Locale seat type of this section's namespace. */
export type SectionT = TranslateNS<typeof NS>

/** Selector-hook shape of one observable store (mirror of the renderer hook). */
export interface SnapshotHook<Snapshot> {
  <T>(selector: (snapshot: Snapshot) => T): T
  <T>(selector: (snapshot: Snapshot) => T, equal: (left: T, right: T) => boolean): T
}

type DocHook = SnapshotHook<McpStoreSnapshot>

/**
 * The composed props this registration receives: owner share (`close`) +
 * locale `t` seat + framework-bound store hooks + the injected actions.
 */
export interface McpScopeSectionProps {
  /** Settings shell owner share: close the settings panel. */
  close: () => void
  t: SectionT
  useDoc: DocHook
  useWorkspaces: WorkspaceListHook
  addServer: McpScopeFace['addServer']
  replaceServer: McpScopeFace['replaceServer']
  removeServer: McpScopeFace['removeServer']
  toggleWorkspace: McpScopeFace['toggleWorkspace']
  toggleWorkspaces: McpScopeFace['toggleWorkspaces']
  toggleWorkspaceServers: McpScopeFace['toggleWorkspaceServers']
  setServerEnabled: McpScopeFace['setServerEnabled']
  unsetCredential: McpScopeFace['unsetCredential']
  /** Live runtime-status store (host routes over the Connection carrier). */
  useRuntime: SnapshotHook<RuntimeSnapshot>
  refreshRuntime(options?: { silent?: boolean; server?: string }): Promise<void>
  connectServer(serverName: string): Promise<unknown>
  disconnectServer(serverName: string): Promise<unknown>
  testServer(serverName: string): Promise<RuntimeTestResult>
  loadTools(serverName: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

type BaseView =
  | { kind: 'servers' }
  | { kind: 'server'; name: string }
  | { kind: 'workspaces' }
  | { kind: 'workspace'; id: string }

type SectionView =
  | BaseView
  | { kind: 'editor'; mode: 'add' | 'edit'; name?: string; returnTo: BaseView }

interface PendingEntry {
  value: boolean
  settled: boolean
  token: number
  workspaceId?: string
  serverName?: string
}

interface ToastState {
  message: string
  undo?: () => void
}

interface FailureState {
  message: string
  retry?: () => void
}

type ConfirmState =
  | null
  | { kind: 'remove'; id: number; serverName: string; workspaceCount: number; refs: string[] }
  | { kind: 'clear'; id: number; ref: string; servers: string[] }

const scopeKey = (workspaceId: string, serverName: string): string =>
  JSON.stringify([workspaceId, serverName])

export function McpScopeSection(props: McpScopeSectionProps): ReactNode {
  const { t } = props
  const snapshot = props.useDoc((state) => state)
  const runtime = props.useRuntime((state) => state, runtimeSnapshotsEqual)
  const wsState = props.useWorkspaces((state) => state)
  const workspaces = workspaceItemsOf(wsState)
  const workspaceStatus = workspaceListStatusOf(wsState)
  const queue = useWriteQueue()
  const [view, setView] = useState<SectionView>({ kind: 'servers' })
  const [serverQuery, setServerQuery] = useState('')
  const [serverFilter, setServerFilter] = useState<ServerFilter>('all')
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaceServerQuery, setWorkspaceServerQuery] = useState('')
  const [pendingAllow, setPendingAllow] = useState<Record<string, PendingEntry>>({})
  const [pendingScope, setPendingScope] = useState<Record<string, PendingEntry>>({})
  const [toast, setToast] = useState<ToastState | null>(null)
  const [failure, setFailure] = useState<FailureState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [confirmPending, setConfirmPending] = useState(false)
  const confirmSeq = useRef(0)
  const activeConfirmId = useRef<number | null>(null)
  const [autoTestName, setAutoTestName] = useState<string | null>(null)
  const [editorAutoImport, setEditorAutoImport] = useState(false)
  const tokenRef = useRef(0)
  const alive = useRef(true)
  const previousView = useRef<SectionView | null>(null)
  const pendingAllowRef = useRef(pendingAllow)
  const pendingScopeRef = useRef(pendingScope)
  pendingAllowRef.current = pendingAllow
  pendingScopeRef.current = pendingScope

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const { doc, credentials, writable } = snapshot
  const workspaceIds = useMemo(
    () => workspaces.map((workspace) => workspace.workspaceId),
    [workspaces],
  )
  const unusedCount = useMemo(() => {
    if (workspaceStatus !== 'ready' || workspaceIds.length === 0) return 0
    return doc.servers.filter(
      (server) => !isServerDisabled(doc, server.serverName) && !isServerInUse(doc, server, workspaceIds),
    ).length
  }, [doc, workspaceIds, workspaceStatus])
  const connectedCount = useMemo(() => {
    let count = 0
    for (const server of doc.servers) {
      if (isServerDisabled(doc, server.serverName)) continue
      if (runtimeOf(runtime, server.serverName)?.state === 'connected') count += 1
    }
    return count
  }, [doc, runtime])
  const staleRuntime =
    (runtime.phase === 'error' || runtime.phase === 'unavailable') &&
    Object.keys(runtime.servers).length > 0

  /** Drop optimistic entries once committed data reflects them or they vanish. */
  useEffect(() => {
    const serverExists = (name: string): boolean =>
      doc.servers.some((server) => server.serverName === name)
    const workspaceExists = (workspaceId: string): boolean =>
      workspaceStatus !== 'ready' || workspaces.some((workspace) => workspace.workspaceId === workspaceId)
    setPendingAllow((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [name, entry] of Object.entries(prev)) {
        if (!entry.settled) continue
        if (!serverExists(name) || (!isServerDisabled(doc, name)) === entry.value) {
          delete next[name]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setPendingScope((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [key, entry] of Object.entries(prev)) {
        if (!entry.settled || entry.workspaceId === undefined || entry.serverName === undefined) continue
        if (
          !serverExists(entry.serverName) ||
          !workspaceExists(entry.workspaceId) ||
          isEnabled(doc.overrides, entry.workspaceId, entry.serverName) === entry.value
        ) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [doc, workspaces, workspaceStatus, pendingAllow, pendingScope])

  /** Initial runtime refresh per document revision. */
  useEffect(() => {
    void props.refreshRuntime({ silent: true })
  }, [props.refreshRuntime, snapshot.revision])

  /** Poll while the panel is visible; back off after a failed pass. */
  useEffect(() => {
    if (doc.servers.length === 0) return undefined
    let stopped = false
    let timer = 0
    const delay = runtime.phase === 'error' || runtime.phase === 'unavailable' ? 30000 : 10000
    const tick = async (): Promise<void> => {
      if (stopped) return
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        try {
          await props.refreshRuntime({ silent: true })
        } catch {
          /* the store publishes its own phase; polling must not throw into the page */
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), delay)
    }
    timer = window.setTimeout(() => void tick(), delay)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [props.refreshRuntime, doc.servers.length, runtime.phase])

  useEffect(() => {
    if (toast === null) return undefined
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Move focus with the view: detail heading on open, the originating row on
  // back, the first field when the editor mounts. This is what makes the
  // drill-in usable from the keyboard.
  useEffect(() => {
    const previous = previousView.current
    previousView.current = view
    if (previous === null || typeof document === 'undefined') return
    // Attribute lookup by VALUE, never by selector interpolation: upstream
    // workspace ids are opaque and may contain quotes or backslashes.
    const byData = (attribute: string, value: string): HTMLElement | null =>
      Array.from(document.querySelectorAll<HTMLElement>('[' + attribute + ']')).find(
        (element) => element.getAttribute(attribute) === value,
      ) ?? null
    let target: HTMLElement | null = null
    if (view.kind === 'server') {
      target = byData('data-mcp-server-detail', view.name)?.querySelector<HTMLElement>(
        '[data-mcp-detail-title]',
      ) ?? null
    } else if (view.kind === 'workspace') {
      target = byData('data-mcp-workspace-detail', view.id)?.querySelector<HTMLElement>(
        '[data-mcp-detail-title]',
      ) ?? null
    } else if (view.kind === 'editor') {
      // An auto-opened import dialog owns focus; the modal's focus trap must
      // not be undercut by a parent effect focusing the name field behind it.
      if (!editorAutoImport) target = document.getElementById('mcp-scope-editor-name')
    } else if (previous.kind === 'server') {
      target = byData('data-server', previous.name)?.querySelector<HTMLElement>('button') ?? null
    } else if (previous.kind === 'workspace') {
      target = byData('data-workspace', previous.id)?.querySelector<HTMLElement>('button') ?? null
    }
    // The entity that caused the transition may have been removed (a delete
    // confirmation) or the editor may have been opened from the Add button:
    // land on a stable control of the destination list instead of the body.
    if (target === null && view.kind === 'servers' && (previous.kind === 'server' || previous.kind === 'editor')) {
      target =
        document.querySelector<HTMLElement>('[data-mcp-servers-view] [data-server] button') ??
        document.querySelector<HTMLElement>('[data-mcp-servers-view] button')
    }
    if (
      target === null &&
      view.kind === 'workspaces' &&
      (previous.kind === 'workspace' || previous.kind === 'editor')
    ) {
      target =
        document.querySelector<HTMLElement>('[data-mcp-workspaces-view] [data-workspace] button') ??
        document.querySelector<HTMLElement>('[data-mcp-workspaces-view] button')
    }
    target?.focus()
  }, [view])

  // A server/workspace can disappear while its detail is open (another tab,
  // an external edit). Fall back to the list instead of rendering a dead view.
  useEffect(() => {
    if (view.kind === 'server' && !doc.servers.some((server) => server.serverName === view.name)) {
      setView({ kind: 'servers' })
    }
    if (view.kind === 'workspace' && workspaceStatus === 'ready' && !workspaces.some((item) => item.workspaceId === view.id)) {
      setView({ kind: 'workspaces' })
    }
  }, [doc.servers, view, workspaces, workspaceStatus])

  function showToast(message: string, undo?: () => void): void {
    setToast({ message, undo })
  }

  function reportFailure(outcome: SaveOutcome, retry?: () => void): void {
    if (outcome.ok) return
    setFailure({ message: failureText(t, outcome), ...(retry !== undefined ? { retry } : {}) })
  }

  function allowValue(serverName: string): boolean {
    return pendingAllow[serverName]?.value ?? !isServerDisabled(doc, serverName)
  }

  function allowPending(serverName: string): boolean {
    return pendingAllow[serverName] !== undefined
  }

  function scopeValue(workspaceId: string, serverName: string): boolean {
    return pendingScope[scopeKey(workspaceId, serverName)]?.value ?? isEnabled(doc.overrides, workspaceId, serverName)
  }

  function scopePending(workspaceId: string, serverName: string): boolean {
    return pendingScope[scopeKey(workspaceId, serverName)] !== undefined
  }

  function markAllowSettled(serverName: string, token: number): void {
    setPendingAllow((prev) => {
      const entry = prev[serverName]
      if (entry === undefined || entry.token !== token) return prev
      return { ...prev, [serverName]: { ...entry, settled: true } }
    })
  }

  function dropAllow(serverName: string, token: number): void {
    setPendingAllow((prev) => {
      const entry = prev[serverName]
      if (entry === undefined || entry.token !== token) return prev
      const next = { ...prev }
      delete next[serverName]
      return next
    })
  }

  function markScopeSettled(keys: readonly string[], token: number): void {
    setPendingScope((prev) => {
      let changed = false
      const next = { ...prev }
      for (const key of keys) {
        const entry = prev[key]
        if (entry === undefined || entry.token !== token) continue
        next[key] = { ...entry, settled: true }
        changed = true
      }
      return changed ? next : prev
    })
  }

  function dropScope(keys: readonly string[], token: number): void {
    setPendingScope((prev) => {
      let changed = false
      const next = { ...prev }
      for (const key of keys) {
        const entry = prev[key]
        if (entry === undefined || entry.token !== token) continue
        delete next[key]
        changed = true
      }
      return changed ? next : prev
    })
  }

  async function handleSetEnabled(serverName: string, enabled: boolean, undoable = true): Promise<void> {
    if (!writable) return
    const token = ++tokenRef.current
    setPendingAllow((prev) => ({
      ...prev,
      [serverName]: { value: enabled, settled: false, token },
    }))
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.setServerEnabled(serverName, enabled))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    const currentAllow = pendingAllowRef.current[serverName]
    if (outcome.ok && currentAllow !== undefined && currentAllow.token !== token) return
    if (outcome.ok) {
      markAllowSettled(serverName, token)
      showToast(
        t(enabled ? 'toast.allowOn' : 'toast.allowOff', { server: serverName }),
        undoable
          ? () => void handleSetEnabled(serverName, !enabled, false)
          : undefined,
      )
      return
    }
    const current = pendingAllowRef.current[serverName]
    if (current !== undefined && current.token !== token) return
    dropAllow(serverName, token)
    reportFailure(outcome, () => void handleSetEnabled(serverName, enabled, undoable))
  }

  async function handleToggleScope(
    workspaceId: string,
    serverName: string,
    next: boolean,
    undoable = true,
    message?: string,
  ): Promise<void> {
    if (!writable) return
    const key = scopeKey(workspaceId, serverName)
    const token = ++tokenRef.current
    setPendingScope((prev) => ({
      ...prev,
      [key]: { value: next, settled: false, token, workspaceId, serverName },
    }))
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.toggleWorkspace(workspaceId, serverName, next))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    const currentScope = pendingScopeRef.current[key]
    if (outcome.ok && currentScope !== undefined && currentScope.token !== token) return
    const workspaceTitle =
      workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.title ?? workspaceId
    if (outcome.ok) {
      markScopeSettled([key], token)
      showToast(
        message ??
          t(next ? 'toast.scopeOn' : 'toast.scopeOff', {
            server: serverName,
            workspace: workspaceTitle,
          }),
        undoable
          ? () => void handleToggleScope(workspaceId, serverName, !next, false, t('toast.undone'))
          : undefined,
      )
      return
    }
    const current = pendingScopeRef.current[key]
    if (current !== undefined && current.token !== token) return
    dropScope([key], token)
    reportFailure(outcome, () => void handleToggleScope(workspaceId, serverName, next, undoable, message))
  }

  async function handleServerBulk(
    serverName: string,
    enabled: boolean,
    workspaceIdsToWrite: readonly string[],
    undoable = true,
  ): Promise<void> {
    const targetIds =
      workspaceStatus === 'ready'
        ? workspaceIdsToWrite.filter((workspaceId) =>
            workspaces.some((workspace) => workspace.workspaceId === workspaceId),
          )
        : [...workspaceIdsToWrite]
    if (!writable || targetIds.length === 0) return
    // Undo restores the PRE-BATCH value of each row, not the inverse of the
    // batch target: "all on" over a mixed set must put the originally-on rows
    // back on and the originally-off rows back off.
    const previous = targetIds.map((workspaceId) => ({
      workspaceId,
      value: scopeValue(workspaceId, serverName),
    }))
    const token = ++tokenRef.current
    const keys = targetIds.map((workspaceId) => scopeKey(workspaceId, serverName))
    setPendingScope((prev) => {
      const next = { ...prev }
      for (const workspaceId of targetIds) {
        next[scopeKey(workspaceId, serverName)] = {
          value: enabled,
          settled: false,
          token,
          workspaceId,
          serverName,
        }
      }
      return next
    })
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.toggleWorkspaces(serverName, enabled, targetIds))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    if (outcome.ok) {
      markScopeSettled(keys, token)
      showToast(
        t('toast.scopeBulk', { server: serverName, count: targetIds.length }),
        undoable ? () => void restoreServerBulk(serverName, previous) : undefined,
      )
      return
    }
    if (keys.some((key) => {
      const entry = pendingScopeRef.current[key]
      return entry !== undefined && entry.token !== token
    })) return
    dropScope(keys, token)
    reportFailure(outcome, () => void handleServerBulk(serverName, enabled, targetIds, undoable))
  }

  async function handleWorkspaceBulk(
    workspaceId: string,
    enabled: boolean,
    serverNames: readonly string[],
    undoable = true,
  ): Promise<void> {
    const targetNames = serverNames.filter((serverName) =>
      doc.servers.some((server) => server.serverName === serverName),
    )
    if (!writable || targetNames.length === 0) return
    const previous = targetNames.map((serverName) => ({
      serverName,
      value: scopeValue(workspaceId, serverName),
    }))
    const token = ++tokenRef.current
    const keys = targetNames.map((serverName) => scopeKey(workspaceId, serverName))
    setPendingScope((prev) => {
      const next = { ...prev }
      for (const serverName of targetNames) {
        next[scopeKey(workspaceId, serverName)] = {
          value: enabled,
          settled: false,
          token,
          workspaceId,
          serverName,
        }
      }
      return next
    })
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.toggleWorkspaceServers(workspaceId, targetNames, enabled))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    const workspaceTitle =
      workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.title ?? workspaceId
    if (outcome.ok) {
      markScopeSettled(keys, token)
      showToast(
        t('toast.workspaceBulk', { count: targetNames.length, workspace: workspaceTitle }),
        undoable ? () => void restoreWorkspaceBulk(workspaceId, previous) : undefined,
      )
      return
    }
    if (keys.some((key) => {
      const entry = pendingScopeRef.current[key]
      return entry !== undefined && entry.token !== token
    })) return
    dropScope(keys, token)
    reportFailure(outcome, () => void handleWorkspaceBulk(workspaceId, enabled, targetNames, undoable))
  }


  /** Restore a mixed server→workspaces batch to its exact pre-batch values. */
  async function restoreServerBulk(
    serverName: string,
    previous: readonly { workspaceId: string; value: boolean }[],
  ): Promise<void> {
    if (!writable || previous.length === 0) return
    const token = ++tokenRef.current
    const keys = previous.map((entry) => scopeKey(entry.workspaceId, serverName))
    setPendingScope((prev) => {
      const next = { ...prev }
      for (const entry of previous) {
        next[scopeKey(entry.workspaceId, serverName)] = {
          value: entry.value,
          settled: false,
          token,
          workspaceId: entry.workspaceId,
          serverName,
        }
      }
      return next
    })
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(async () => {
        const onIds = previous.filter((entry) => entry.value).map((entry) => entry.workspaceId)
        const offIds = previous.filter((entry) => !entry.value).map((entry) => entry.workspaceId)
        let last: SaveOutcome = { ok: true }
        if (onIds.length > 0) last = await props.toggleWorkspaces(serverName, true, onIds)
        if (last.ok && offIds.length > 0) last = await props.toggleWorkspaces(serverName, false, offIds)
        return last
      })
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    if (outcome.ok) {
      markScopeSettled(keys, token)
      showToast(t('toast.undone'))
      return
    }
    dropScope(keys, token)
    reportFailure(outcome, () => void restoreServerBulk(serverName, previous))
  }

  /** Restore a mixed workspace→servers batch to its exact pre-batch values. */
  async function restoreWorkspaceBulk(
    workspaceId: string,
    previous: readonly { serverName: string; value: boolean }[],
  ): Promise<void> {
    if (!writable || previous.length === 0) return
    const token = ++tokenRef.current
    const keys = previous.map((entry) => scopeKey(workspaceId, entry.serverName))
    setPendingScope((prev) => {
      const next = { ...prev }
      for (const entry of previous) {
        next[scopeKey(workspaceId, entry.serverName)] = {
          value: entry.value,
          settled: false,
          token,
          workspaceId,
          serverName: entry.serverName,
        }
      }
      return next
    })
    setFailure(null)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(async () => {
        const onNames = previous.filter((entry) => entry.value).map((entry) => entry.serverName)
        const offNames = previous.filter((entry) => !entry.value).map((entry) => entry.serverName)
        let last: SaveOutcome = { ok: true }
        if (onNames.length > 0) last = await props.toggleWorkspaceServers(workspaceId, onNames, true)
        if (last.ok && offNames.length > 0) last = await props.toggleWorkspaceServers(workspaceId, offNames, false)
        return last
      })
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    if (outcome.ok) {
      markScopeSettled(keys, token)
      showToast(t('toast.undone'))
      return
    }
    dropScope(keys, token)
    reportFailure(outcome, () => void restoreWorkspaceBulk(workspaceId, previous))
  }

  function baseViewOf(current: SectionView): BaseView {
    if (current.kind === 'server') return current
    if (current.kind === 'workspace') return current
    if (current.kind === 'workspaces') return { kind: 'workspaces' }
    return { kind: 'servers' }
  }

  function go(next: BaseView): void {
    setFailure(null)
    setAutoTestName(null)
    setView(next)
  }

  function openAdd(autoImport = false): void {
    setFailure(null)
    setAutoTestName(null)
    setEditorAutoImport(autoImport)
    setView({ kind: 'editor', mode: 'add', returnTo: baseViewOf(view) })
  }

  function openEdit(serverName: string): void {
    setFailure(null)
    setAutoTestName(null)
    setEditorAutoImport(false)
    setView({ kind: 'editor', mode: 'edit', name: serverName, returnTo: { kind: 'server', name: serverName } })
  }

  async function saveEditor(input: ServerSaveInput): Promise<SaveOutcome> {
    if (view.kind !== 'editor') return { ok: false, reason: 'invalid' }
    try {
      return await queue.run(() =>
        view.mode === 'edit' && view.name !== undefined
          ? props.replaceServer(view.name, { ...input, enabled: undefined })
          : props.addServer(input),
      )
    } catch {
      return { ok: false, reason: 'save-failed' }
    }
  }

  function handleSaved(name: string, kind: 'added' | 'updated'): void {
    setFailure(null)
    setView({ kind: 'server', name })
    setAutoTestName(name)
    setServerQuery('')
    setServerFilter('all')
    showToast(t(kind === 'added' ? 'add.added' : 'edit.saved', { name }))
  }

  function requestRemove(serverName: string): void {
    setFailure(null)
    // Count the document's enable records directly: the workspace list may
    // still be loading, and an override row is the source of truth for "how
    // many workspaces enable this server".
    const workspaceCount = Object.values(doc.overrides).filter((row) =>
      Object.hasOwn(row, serverName),
    ).length
    const id = ++confirmSeq.current
    activeConfirmId.current = id
    setConfirmPending(false)
    setConfirm({
      kind: 'remove',
      id,
      serverName,
      workspaceCount,
      refs: orphanedRefsOf(doc, serverName),
    })
  }

  function requestClear(ref: string): void {
    setFailure(null)
    const id = ++confirmSeq.current
    activeConfirmId.current = id
    setConfirmPending(false)
    setConfirm({ kind: 'clear', id, ref, servers: serversUsingRef(doc, ref) })
  }

  async function performRemove(serverName: string, id?: number): Promise<void> {
    const stale = (): boolean => id !== undefined && activeConfirmId.current !== id
    if (!stale()) setConfirmPending(true)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.removeServer(serverName))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!alive.current) return
    if (stale()) {
      // The dialog was dismissed or replaced while this write was in flight.
      // Never close/take over a newer confirmation; still report the outcome.
      if (outcome.ok) showToast(t('toast.removed', { name: serverName }))
      else reportFailure(outcome, () => void performRemove(serverName, -1))
      return
    }
    setConfirmPending(false)
    setConfirm(null)
    activeConfirmId.current = null
    if (outcome.ok) {
      setAutoTestName(null)
      setView({ kind: 'servers' })
      showToast(t('toast.removed', { name: serverName }))
      return
    }
    reportFailure(outcome, () => void performRemove(serverName, -1))
  }

  async function performClear(ref: string, id?: number): Promise<void> {
    const stale = (): boolean => id !== undefined && activeConfirmId.current !== id
    if (!stale()) setConfirmPending(true)
    let outcome: SaveOutcome
    try {
      outcome = await queue.run(() => props.unsetCredential(ref))
    } catch {
      outcome = { ok: false, reason: 'secret-write-failed', refs: [ref] }
    }
    if (!alive.current) return
    if (stale()) {
      if (outcome.ok) showToast(t('toast.cleared', { ref }))
      else reportFailure(outcome, () => void performClear(ref, -1))
      return
    }
    setConfirmPending(false)
    setConfirm(null)
    activeConfirmId.current = null
    if (outcome.ok) {
      showToast(t('toast.cleared', { ref }))
      return
    }
    reportFailure(outcome, () => void performClear(ref, -1))
  }

  if (snapshot.status === 'loading') {
    return <p className={styles.empty}>{t('state.loading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p className={styles.empty}>{t('state.unavailable')}</p>
  }

  const activeTab = view.kind === 'workspaces' || view.kind === 'workspace' ? 'workspaces' : 'servers'
  const editorState = useMemo(() => {
    if (view.kind !== 'editor') return { initial: EMPTY_DRAFT, existingNames: [] as string[] }
    const server =
      view.mode === 'edit' && view.name !== undefined
        ? doc.servers.find((item) => item.serverName === view.name)
        : undefined
    return {
      initial:
        server !== undefined ? draftFromServer(server, isServerDisabled(doc, server.serverName)) : EMPTY_DRAFT,
      existingNames: doc.servers
        .filter((item) => view.mode !== 'edit' || item.serverName !== view.name)
        .map((item) => item.serverName),
    }
  }, [doc, view])
  const editorInitial = editorState.initial
  const editorExistingNames = editorState.existingNames

  const failureNotice =
    failure !== null ? (
      <InlineNotice
        tone="error"
        onDismiss={() => setFailure(null)}
        dismissLabel={t('action.dismiss')}
        action={
          failure.retry !== undefined ? (
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => {
                const retry = failure.retry
                setFailure(null)
                retry?.()
              }}
            >
              {t('action.retry')}
            </button>
          ) : undefined
        }
      >
        {failure.message}
      </InlineNotice>
    ) : null

  const toastNotice =
    toast !== null ? (
      <div role="status" className={styles.toast}>
        <span className={styles.toastText}>{toast.message}</span>
        {toast.undo !== undefined && (
          <button
            type="button"
            className={styles.toastAction}
            onClick={() => {
              const undo = toast.undo
              setToast(null)
              undo?.()
            }}
          >
            {t('toast.undo')}
          </button>
        )}
        <button
          type="button"
          className={cx(styles.iconButton, styles.toastClose)}
          aria-label={t('action.dismiss')}
          onClick={() => setToast(null)}
        >
          ×
        </button>
      </div>
    ) : null

  const confirmDialog = (
    <ConfirmDialog
      open={confirm !== null}
      title={
        confirm === null
          ? ''
          : confirm.kind === 'remove'
            ? t('server.removeTitle', { name: confirm.serverName })
            : t('server.clearConfirmTitle', { ref: confirm.ref })
      }
      body={
        confirm === null ? null : confirm.kind === 'remove' ? (
          <p>
            {confirm.refs.length > 0
              ? t('server.removeBody', {
                  count: confirm.workspaceCount,
                  refs: confirm.refs.join(', '),
                })
              : t('server.removeBodyNoRefs', { count: confirm.workspaceCount })}
          </p>
        ) : (
          <p>
            {t('server.clearConfirmBody')}
            {confirm.servers.length > 1 && (
              <>
                {' '}
                {t('server.clearConfirmShared', { servers: confirm.servers.join(', ') })}
              </>
            )}
          </p>
        )
      }
      confirmLabel={
        confirm === null
          ? ''
          : confirm.kind === 'remove'
            ? t('server.removeAction')
            : t('server.clearConfirmAction')
      }
      cancelLabel={
        confirm === null
          ? ''
          : confirmPending
            ? t('action.dismiss')
            : confirm.kind === 'remove'
              ? t('server.keep')
              : t('action.cancel')
      }
      closeLabel={t('action.cancel')}
      danger
      pending={confirmPending}
      onConfirm={() => {
        if (confirm === null) return
        if (confirm.kind === 'remove') void performRemove(confirm.serverName, confirm.id)
        else void performClear(confirm.ref, confirm.id)
      }}
      onCancel={() => {
        // The write itself cannot be cancelled; dismissing the dialog is safe
        // and keeps a keyboard user from being trapped when all action buttons
        // on the confirm side are disabled during the pending write. Clearing
        // the active id makes the eventual outcome unable to close a newer
        // confirmation.
        activeConfirmId.current = null
        setConfirmPending(false)
        setConfirm(null)
      }}
    />
  )

  if (view.kind === 'editor') {
    return (
      <div className={styles.section} data-dsh-chamber-mcp-section>
        {toastNotice}
        {failureNotice}
        <ServerEditor
          key={view.mode + ':' + (view.name ?? 'new')}
          t={t}
          mode={view.mode}
          initial={editorInitial}
          originalName={view.mode === 'edit' ? view.name : undefined}
          existingNames={editorExistingNames}
          writable={writable}
          credentials={credentials}
          autoImport={editorAutoImport}
          onSave={saveEditor}
          onCancel={() => go(view.returnTo)}
          onSaved={handleSaved}
        />
        {confirmDialog}
      </div>
    )
  }

  return (
    <div className={styles.section} data-dsh-chamber-mcp-section>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('nav')}</h2>
        <span className={styles.spacer} />
        {writable && (
          <div className={styles.headActions}>
            {queue.pending > 0 && <span className={styles.summary}>{t('section.saving')}</span>}
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => openAdd(false)}
            >
              {t('add.add')}
            </button>
          </div>
        )}
      </header>
      <p className={styles.subtitle}>{t('section.subtitle')}</p>
      <div className={styles.searchToolbar}>
        <Tabs
          ariaLabel={t('tab.aria')}
          items={[
            { id: 'servers', label: t('tab.servers'), count: doc.servers.length },
            {
              id: 'workspaces',
              label: t('tab.workspaces'),
              ...(workspaceStatus === 'ready' ? { count: workspaces.length } : {}),
            },
          ]}
          active={activeTab}
          onSelect={(id) => {
            if (id === 'workspaces') go({ kind: 'workspaces' })
            else go({ kind: 'servers' })
          }}
        />
        <span className={styles.spacer} />
        <span className={styles.summary}>
          {runtime.phase !== 'ready' && Object.keys(runtime.servers).length === 0
            ? t(runtime.phase === 'loading' ? 'section.summaryLoading' : 'section.summaryUnavailable', {
                servers: doc.servers.length,
              })
            : t('section.summary', { servers: doc.servers.length, connected: connectedCount })}
        </span>
      </div>

      {!writable && <InlineNotice tone="warn">{t('state.readonly')}</InlineNotice>}
      {unusedCount > 0 && (
        <InlineNotice
          tone="info"
          action={
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => {
                setServerQuery('')
                setServerFilter('unused')
                go({ kind: 'servers' })
              }}
            >
              {t('section.unusedReview')}
            </button>
          }
        >
          {t('section.unused', { count: unusedCount })}
        </InlineNotice>
      )}
      {staleRuntime && (
        <InlineNotice
          tone="warn"
          action={
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => void props.refreshRuntime().catch(() => {})}
            >
              {t('action.retry')}
            </button>
          }
        >
          {t('runtime.stale')}
        </InlineNotice>
      )}
      {failureNotice}
      {toastNotice}

      <div
        role="tabpanel"
        id={'mcp-scope-panel-' + activeTab}
        aria-labelledby={'mcp-scope-tab-' + activeTab}
      >
      {view.kind === 'servers' && (
        <ServerListView
          t={t}
          doc={doc}
          runtime={runtime}
          runtimePhase={runtime.phase}
          workspaceStatus={workspaceStatus}
          workspaces={workspaces}
          query={serverQuery}
          onQueryChange={setServerQuery}
          filter={serverFilter}
          onFilterChange={setServerFilter}
          onOpen={(name) => go({ kind: 'server', name })}
          onAdd={() => openAdd(false)}
          onImport={() => openAdd(true)}
          writable={writable}
        />
      )}
      {view.kind === 'server' && (() => {
        const server = doc.servers.find((item) => item.serverName === view.name)
        if (server === undefined) return null
        return (
          <ServerDetail
            key={server.serverName}
            t={t}
            server={server}
            doc={doc}
            credentials={credentials}
            writable={writable}
            workspaces={workspaces}
            workspaceStatus={workspaceStatus}
            runtime={runtimeOf(runtime, server.serverName)}
            runtimePhase={runtime.phase}
            allowValue={allowValue(server.serverName)}
            allowPending={allowPending(server.serverName)}
            scopeValue={(workspaceId) => scopeValue(workspaceId, server.serverName)}
            scopePending={(workspaceId) => scopePending(workspaceId, server.serverName)}
            onBack={() => go({ kind: 'servers' })}
            onEdit={() => openEdit(server.serverName)}
            onSetEnabled={(next) => void handleSetEnabled(server.serverName, next)}
            onToggleScope={(workspaceId, next) => void handleToggleScope(workspaceId, server.serverName, next)}
            onBulkScope={(enabled, ids) => void handleServerBulk(server.serverName, enabled, ids)}
            onConnect={() => props.connectServer(server.serverName)}
            onDisconnect={() => props.disconnectServer(server.serverName)}
            onTest={() => props.testServer(server.serverName)}
            onRefresh={() => props.refreshRuntime({ server: server.serverName, silent: true })}
            onLoadTools={() => props.loadTools(server.serverName)}
            onRemove={() => requestRemove(server.serverName)}
            onClearCredential={(ref) => requestClear(ref)}
            autoTest={autoTestName === server.serverName}
            onAutoTestConsumed={() => setAutoTestName(null)}
          />
        )
      })()}
      {view.kind === 'workspaces' && (
        <WorkspaceListView
          t={t}
          doc={doc}
          workspaces={workspaces}
          workspaceStatus={workspaceStatus}
          query={workspaceQuery}
          onQueryChange={setWorkspaceQuery}
          onOpen={(id) => {
            setWorkspaceServerQuery('')
            go({ kind: 'workspace', id })
          }}
          writable={writable}
        />
      )}
      {view.kind === 'workspace' && (() => {
        const workspace = workspaces.find((item) => item.workspaceId === view.id)
        if (workspace === undefined) return null
        return (
          <WorkspaceDetailView
            key={workspace.workspaceId}
            t={t}
            doc={doc}
            workspace={workspace}
            runtime={runtime}
            runtimePhase={runtime.phase}
            writable={writable}
            query={workspaceServerQuery}
            onQueryChange={setWorkspaceServerQuery}
            onBack={() => go({ kind: 'workspaces' })}
            scopeValue={(serverName) => scopeValue(workspace.workspaceId, serverName)}
            scopePending={(serverName) => scopePending(workspace.workspaceId, serverName)}
            onToggle={(serverName, next) =>
              void handleToggleScope(workspace.workspaceId, serverName, next)
            }
            onBulk={(enabled, names) => void handleWorkspaceBulk(workspace.workspaceId, enabled, names)}
            onAdd={() => openAdd(false)}
          />
        )
      })()}
      </div>
      {confirmDialog}
    </div>
  )
}
