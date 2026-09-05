/**
 * `settings.section` page of the mcp-scope feature: server cards + staged
 * add form, driven entirely through the injected controller face (useDoc
 * store hook + actions) and the global `useWorkspaces` hook. No text is
 * hardcoded: every string arrives through the `t` locale seat of the
 * `mcp-scope.settings` namespace.
 */

import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpStoreSnapshot, McpScopeFace, SaveOutcome, SecretWrite } from './controller.js'
import type { ServerDef } from '../shared/model.js'
import { NS } from './locales.js'
import { AddServerForm } from './add-form.js'
import { ServerCard } from './server-card.js'
import { workspaceItemsOf, type WorkspaceListHook } from './workspaces.js'

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
  removeServer: McpScopeFace['removeServer']
  toggleWorkspace: McpScopeFace['toggleWorkspace']
  unsetCredential: McpScopeFace['unsetCredential']
}

const noticeStyle: React.CSSProperties = {
  margin: '0 0 8px',
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(192,57,43,0.1)',
  border: '1px solid rgba(192,57,43,0.4)',
  fontSize: 13,
}

/** Map a failed SaveOutcome onto localized banner text. */
function outcomeText(t: SectionT, outcome: SaveOutcome & { ok: false }): string {
  switch (outcome.reason) {
    case 'conflict':
      return t('error.conflict')
    case 'secret-write-failed':
      return t('error.secretWriteFailed', { refs: (outcome.refs ?? []).join(', ') })
    case 'save-failed':
      return t('error.saveFailed')
    case 'invalid':
      return t('error.unexpected')
  }
}

export function McpScopeSection(props: McpScopeSectionProps): ReactNode {
  const { t } = props
  const snapshot = props.useDoc((state) => state)
  const items = workspaceItemsOf(props.useWorkspaces((state) => state))
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<(SaveOutcome & { ok: false }) | null>(null)

  function report(outcome: SaveOutcome): void {
    setNotice(outcome.ok ? null : outcome)
  }

  if (snapshot.status === 'loading') {
    return <p style={{ opacity: 0.7 }}>{t('state.loading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p style={{ opacity: 0.8 }}>{t('state.unavailable')}</p>
  }

  const { doc, credentials, writable } = snapshot
  const existingNames = doc.servers.map((server) => server.serverName)
  const disabled = !writable || adding

  async function handleAdd(input: { server: ServerDef; secrets: readonly SecretWrite[] }): Promise<SaveOutcome> {
    const outcome = await props.addServer(input)
    report(outcome)
    return outcome
  }

  async function handleRemove(serverName: string): Promise<SaveOutcome> {
    const outcome = await props.removeServer(serverName)
    report(outcome)
    return outcome
  }

  async function handleToggle(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome> {
    const outcome = await props.toggleWorkspace(workspaceId, serverName, off)
    report(outcome)
    return outcome
  }

  async function handleUnsetCredential(ref: string): Promise<SaveOutcome> {
    const outcome = await props.unsetCredential(ref)
    report(outcome)
    return outcome
  }

  return (
    <div data-dsh-mcp-scope-section>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{t('nav')}</h2>
        <span style={{ flex: 1 }} />
        {writable && (
          <button type="button" onClick={() => setAdding((open) => !open)}>
            {adding ? t('action.cancel') : t('add.add')}
          </button>
        )}
      </header>

      {!writable && <p style={{ opacity: 0.7 }}>{t('state.readonly')}</p>}
      {notice !== null && (
        <p role="alert" style={noticeStyle}>
          {outcomeText(t, notice)}
        </p>
      )}

      {adding && (
        <AddServerForm
          t={t}
          existingNames={existingNames}
          writable={writable}
          onAdd={handleAdd}
          onClose={() => setAdding(false)}
        />
      )}

      {doc.servers.length === 0 && !adding ? (
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
            workspaces={items}
            onRemove={handleRemove}
            onToggle={handleToggle}
            onUnsetCredential={handleUnsetCredential}
          />
        ))
      )}
    </div>
  )
}
