/**
 * `settings.section` page of the mcp-scope feature: server cards + staged
 * add/edit form, driven entirely through the injected controller face (useDoc
 * store hook + actions) and the global `useWorkspaces` hook. No text is
 * hardcoded: every string arrives through the `t` locale seat of the
 * `mcp-scope.settings` namespace.
 *
 * Outcome feedback is per surface: cards own their toggle/remove/clear
 * failures (transient role="alert" banners), the staged form owns its own
 * save failures, and a successful add/edit is announced by the section as a
 * role="status" note near the list while focus moves to the affected card
 * header. There is no single top-level error banner anymore (UX-01/UX-03).
 *
 * Chrome comes from the shared style seat (`./styles.ts`): the section column
 * and title are the settings-panel vocabulary, the header action is the
 * official `settings.action` outline capsule, and the servers are the panel's
 * card list.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpStoreSnapshot, McpScopeFace, SaveOutcome, ServerSaveInput } from './controller.js'
import { isServerDisabled, type ServerDef } from '../shared/model.js'
import type { RuntimeSnapshot, RuntimeTestResult, RuntimeToolEntry } from './runtime.js'
import { NS } from './locales.js'
import { AddServerForm, EMPTY_DRAFT, draftFromServer } from './add-form.js'
import { ServerCard } from './server-card.js'
import { cx, styles } from './styles.js'
import { workspaceItemsOf, workspaceListStatusOf, type WorkspaceListHook } from './workspaces.js'

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
 * locale `t` seat + framework-bound `useDoc` store hook + global
 * `useWorkspaces` + the injected actions. The framework's own composed type
 * is inferred from the register options at the registration site; this
 * interface re-states the same members with locally-resolvable types
 * (several official cross-package type re-exports collapse to `any` in this
 * dev tree — see docs/design.md §7).
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
  setServerEnabled: McpScopeFace['setServerEnabled']
  unsetCredential: McpScopeFace['unsetCredential']
  /** Live runtime-status store (host routes over the Connection carrier). */
  useRuntime: SnapshotHook<RuntimeSnapshot>
  /**
   * Refresh the runtime snapshot. With `server` the store re-pulls ONLY that
   * server's view and merges it (a failure rejects: the card renders it);
   * without it the whole map is refreshed, retaining the previous views when
   * the pass fails (stale-while-revalidate).
   */
  refreshRuntime(options?: { silent?: boolean; server?: string }): Promise<void>
  connectServer(serverName: string): Promise<unknown>
  disconnectServer(serverName: string): Promise<unknown>
  testServer(serverName: string): Promise<RuntimeTestResult>
  loadTools(serverName: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

/** One staged-form session: add mode, or edit mode replacing `original`. */
type StagedForm =
  | { mode: 'add' }
  | { mode: 'edit'; original: ServerDef }

export function McpScopeSection(props: McpScopeSectionProps): ReactNode {
  const { t } = props
  const snapshot = props.useDoc((state) => state)
  const runtime = props.useRuntime((state) => state)
  const wsState = props.useWorkspaces((state) => state)
  const items = workspaceItemsOf(wsState)
  const workspaceStatus = workspaceListStatusOf(wsState)
  const [staged, setStaged] = useState<StagedForm | null>(null)
  /** Header Add/Cancel presses routed into the open form's discard guard. */
  const [dismissToken, setDismissToken] = useState(0)
  /** Case-insensitive server-name filter (pure list narrowing). */
  const [query, setQuery] = useState('')
  // A form save in flight: the section's Add/Cancel button must not tear the
  // form down mid-save (R2F-2) — secrets and/or the document write could
  // still land with no surface reporting them.
  const [busy, setBusy] = useState(false)
  /** Name of the server whose add/edit just succeeded (role="status" note). */
  const [justSaved, setJustSaved] = useState<{ name: string; kind: 'added' | 'updated' } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The success note is transient; the timer is cleaned up on unmount.
  useEffect(() => {
    if (justSaved === null) return
    const timer = window.setTimeout(() => setJustSaved(null), 6000)
    return () => window.clearTimeout(timer)
  }, [justSaved])

  // Runtime status: fetch once per document revision (a commit can change
  // enablement/overrides) and then poll while this panel is actually visible.
  const refreshRuntime = props.refreshRuntime
  useEffect(() => {
    void refreshRuntime({ silent: true })
  }, [refreshRuntime, snapshot.revision])
  useEffect(() => {
    // Nothing to poll when no server is configured (the store stays ready).
    if (snapshot.doc.servers.length === 0) return undefined
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void refreshRuntime({ silent: true })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refreshRuntime, snapshot.doc.servers.length])

  // Refocus sensibly after a successful add/edit: move focus to the affected
  // card header (browsers scroll it into view). Only runs when the card
  // actually exists in the committed tree.
  useEffect(() => {
    if (justSaved === null) return
    document.getElementById(`mcp-scope-card-${justSaved.name}`)?.focus()
  }, [justSaved])

  if (snapshot.status === 'loading') {
    return <p className={styles.empty}>{t('state.loading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p className={styles.empty}>{t('state.unavailable')}</p>
  }

  const { doc, credentials, writable } = snapshot
  const formOpen = staged !== null
  const existingNames = doc.servers
    .filter((server) => staged?.mode !== 'edit' || server.serverName !== staged.original.serverName)
    .map((server) => server.serverName)
  const needle = query.trim().toLowerCase()
  const visibleServers = needle === ''
    ? doc.servers
    : doc.servers.filter((server) => server.serverName.toLowerCase().includes(needle))
  // Stale-while-revalidate: the snapshot kept its last good server views while
  // reporting an error/unavailable phase. With no views there is nothing stale
  // to keep, and the per-card degradation messages stay as they are.
  const staleRuntime =
    (runtime.phase === 'error' || runtime.phase === 'unavailable') &&
    Object.keys(runtime.servers).length > 0
  /** A full refresh whose failure is already published into the snapshot phase. */
  const refreshAllQuietly = (): void => {
    void refreshRuntime().catch(() => {})
  }
  /** Per-card refresh: the store merges only that server's view. */
  const refreshOneServer = (serverName: string): Promise<void> =>
    refreshRuntime({ server: serverName, silent: true })

  async function handleAdd(input: ServerSaveInput): Promise<SaveOutcome> {
    setBusy(true)
    try {
      const outcome = await props.addServer(input)
      if (!mounted.current || !outcome.ok) return outcome // form reports failures itself
      setStaged(null)
      setJustSaved({ name: input.server.serverName, kind: 'added' })
      return outcome
    } finally {
      // A REJECTING save (not just an `ok:false` outcome) must not latch the
      // header buttons off for the rest of the panel's lifetime.
      if (mounted.current) setBusy(false)
    }
  }

  async function handleEdit(input: ServerSaveInput): Promise<SaveOutcome> {
    if (staged?.mode !== 'edit') return { ok: false, reason: 'save-failed' }
    const originalName = staged.original.serverName
    setBusy(true)
    try {
      const outcome = await props.replaceServer(originalName, input)
      if (!mounted.current || !outcome.ok) return outcome // form reports failures itself
      setStaged(null)
      setJustSaved({ name: input.server.serverName, kind: 'updated' })
      return outcome
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className={styles.section} data-dsh-chamber-mcp-section>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('nav')}</h2>
        <span className={styles.spacer} />
        {doc.servers.length > 0 && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            onClick={refreshAllQuietly}
          >
            {t('runtime.refresh')}
          </button>
        )}
        {writable && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={busy}
            onClick={() => {
              setJustSaved(null)
              // A form is open: route the dismissal through the form, whose
              // unsaved-changes guard decides (header and footer agree).
              if (staged === null) setStaged({ mode: 'add' })
              else setDismissToken((token) => token + 1)
            }}
          >
            {formOpen ? t('action.cancel') : t('add.add')}
          </button>
        )}
      </header>

      {!writable && <p className={styles.empty}>{t('state.readonly')}</p>}

      {doc.servers.length > 0 && staged === null && (
        <div className={styles.field}>
          <input
            type="search"
            aria-label={t('search.placeholder')}
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={styles.input}
          />
        </div>
      )}

      {staged?.mode === 'add' && (
        <AddServerForm
          key="add"
          t={t}
          titleKey="add.title"
          initial={EMPTY_DRAFT}
          existingNames={existingNames}
          writable={writable}
          dismissToken={dismissToken}
          onSave={handleAdd}
          onClose={() => setStaged(null)}
        />
      )}
      {staged?.mode === 'edit' && (
        <AddServerForm
          key={`edit-${staged.original.serverName}`}
          t={t}
          titleKey="edit.title"
          initial={draftFromServer(staged.original, isServerDisabled(doc, staged.original.serverName))}
          existingNames={existingNames}
          writable={writable}
          dismissToken={dismissToken}
          onSave={handleEdit}
          onClose={() => setStaged(null)}
        />
      )}

      {justSaved !== null && (
        <p role="status" className={styles.noticeOk}>
          {justSaved.kind === 'added'
            ? t('add.added', { name: justSaved.name })
            : t('edit.saved', { name: justSaved.name })}
        </p>
      )}

      {staleRuntime && (
        <div className={styles.staleBanner} role="status">
          <span className={styles.staleText}>{t('runtime.stale')}</span>
          <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={refreshAllQuietly}>
            {t('action.retry')}
          </button>
        </div>
      )}

      {doc.servers.length === 0 && staged === null ? (
        <p className={styles.empty}>{t('empty.servers')}</p>
      ) : needle !== '' && visibleServers.length === 0 ? (
        <p className={styles.empty}>{t('search.none', { query: query.trim() })}</p>
      ) : (
        <ul className={styles.list}>
          {visibleServers.map((server) => (
            <li key={server.serverName}>
              <ServerCard
                t={t}
                server={server}
                doc={doc}
                credentials={credentials}
                writable={writable}
                workspaceStatus={workspaceStatus}
                workspaces={items}
                actionsDisabled={staged !== null}
                onEdit={() => {
                  setJustSaved(null)
                  setStaged({ mode: 'edit', original: server })
                }}
                onRemove={props.removeServer}
                onToggle={props.toggleWorkspace}
                onToggleAll={props.toggleWorkspaces}
                onSetEnabled={props.setServerEnabled}
                onUnsetCredential={props.unsetCredential}
                runtime={
                  Object.hasOwn(runtime.servers, server.serverName)
                    ? runtime.servers[server.serverName]
                    : undefined
                }
                runtimePhase={runtime.phase}
                onRefresh={refreshOneServer}
                onConnect={props.connectServer}
                onDisconnect={props.disconnectServer}
                onTest={props.testServer}
                onLoadTools={props.loadTools}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
