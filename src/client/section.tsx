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
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpStoreSnapshot, McpScopeFace, SaveOutcome, ServerSaveInput } from './controller.js'
import type { ServerDef } from '../shared/model.js'
import { NS } from './locales.js'
import { AddServerForm, EMPTY_DRAFT, draftFromServer } from './add-form.js'
import { ServerCard } from './server-card.js'
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
 * dev tree — see docs/ui-notes.md).
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
  unsetCredential: McpScopeFace['unsetCredential']
}

const statusStyle: React.CSSProperties = {
  margin: '0 0 8px',
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(39,174,96,0.1)',
  border: '1px solid rgba(39,174,96,0.4)',
  fontSize: 13,
}

/** One staged-form session: add mode, or edit mode replacing `original`. */
type StagedForm =
  | { mode: 'add' }
  | { mode: 'edit'; original: ServerDef }

export function McpScopeSection(props: McpScopeSectionProps): ReactNode {
  const { t } = props
  const snapshot = props.useDoc((state) => state)
  const wsState = props.useWorkspaces((state) => state)
  const items = workspaceItemsOf(wsState)
  const workspaceStatus = workspaceListStatusOf(wsState)
  const [staged, setStaged] = useState<StagedForm | null>(null)
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

  // Refocus sensibly after a successful add/edit: move focus to the affected
  // card header (browsers scroll it into view). Only runs when the card
  // actually exists in the committed tree.
  useEffect(() => {
    if (justSaved === null) return
    document.getElementById(`mcp-scope-card-${justSaved.name}`)?.focus()
  }, [justSaved])

  if (snapshot.status === 'loading') {
    return <p style={{ opacity: 0.7 }}>{t('state.loading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p style={{ opacity: 0.8 }}>{t('state.unavailable')}</p>
  }

  const { doc, credentials, writable } = snapshot
  const formOpen = staged !== null
  const existingNames = doc.servers
    .filter((server) => staged?.mode !== 'edit' || server.serverName !== staged.original.serverName)
    .map((server) => server.serverName)

  async function handleAdd(input: ServerSaveInput): Promise<SaveOutcome> {
    const outcome = await props.addServer(input)
    if (!mounted.current || !outcome.ok) return outcome // form reports failures itself
    setStaged(null)
    setJustSaved({ name: input.server.serverName, kind: 'added' })
    return outcome
  }

  async function handleEdit(input: ServerSaveInput): Promise<SaveOutcome> {
    if (staged?.mode !== 'edit') return { ok: false, reason: 'save-failed' }
    const originalName = staged.original.serverName
    const outcome = await props.replaceServer(originalName, input)
    if (!mounted.current || !outcome.ok) return outcome // form reports failures itself
    setStaged(null)
    setJustSaved({ name: input.server.serverName, kind: 'updated' })
    return outcome
  }

  return (
    <div data-dsh-mcp-scope-section>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{t('nav')}</h2>
        <span style={{ flex: 1 }} />
        {writable && (
          <button
            type="button"
            onClick={() => {
              setJustSaved(null)
              setStaged((open) => (open === null ? { mode: 'add' } : null))
            }}
          >
            {formOpen ? t('action.cancel') : t('add.add')}
          </button>
        )}
      </header>

      {!writable && <p style={{ opacity: 0.7 }}>{t('state.readonly')}</p>}

      {staged?.mode === 'add' && (
        <AddServerForm
          key="add"
          t={t}
          titleKey="add.title"
          initial={EMPTY_DRAFT}
          existingNames={existingNames}
          writable={writable}
          onSave={handleAdd}
          onClose={() => setStaged(null)}
        />
      )}
      {staged?.mode === 'edit' && (
        <AddServerForm
          key={`edit-${staged.original.serverName}`}
          t={t}
          titleKey="edit.title"
          initial={draftFromServer(staged.original)}
          existingNames={existingNames}
          writable={writable}
          onSave={handleEdit}
          onClose={() => setStaged(null)}
        />
      )}

      {justSaved !== null && (
        <p role="status" style={statusStyle}>
          {justSaved.kind === 'added'
            ? t('add.added', { name: justSaved.name })
            : t('edit.saved', { name: justSaved.name })}
        </p>
      )}

      {doc.servers.length === 0 && staged === null ? (
        <p style={{ opacity: 0.75 }}>{t('empty.servers')}</p>
      ) : (
        doc.servers.map((server) => (
          <ServerCard
            key={server.serverName}
            t={t}
            server={server}
            doc={doc}
            credentials={credentials}
            writable={writable}
            workspaceStatus={workspaceStatus}
            workspaces={items}
            onEdit={() => {
              setJustSaved(null)
              setStaged({ mode: 'edit', original: server })
            }}
            onRemove={props.removeServer}
            onToggle={props.toggleWorkspace}
            onUnsetCredential={props.unsetCredential}
          />
        ))
      )}
    </div>
  )
}
