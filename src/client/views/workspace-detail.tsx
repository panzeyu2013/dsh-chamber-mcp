/**
 * Workspace detail: one switch per server for this workspace.
 *
 * This is the workspace-centric half of the scope model. Writes go through the
 * section's optimistic queue; a globally disabled server stays visible but its
 * switch explains why it cannot be turned on here.
 */

import { useMemo, type ReactNode } from 'react'
import { isServerDisabled, type McpScopeDoc } from '../../shared/model.js'
import type { RuntimeSnapshot } from '../runtime.js'
import type { SectionT } from '../section.js'
import type { WorkspaceItem } from '../workspaces.js'
import { EmptyState, SectionBlock, StatusBadge, SwitchControl } from '../components/ui.js'
import { cx, styles } from '../styles.js'
import { runtimeOf, statusKeyOf, statusToneOf } from '../view-model.js'

export interface WorkspaceDetailViewProps {
  t: SectionT
  doc: McpScopeDoc
  workspace: WorkspaceItem
  runtime: RuntimeSnapshot
  runtimePhase: RuntimeSnapshot['phase']
  writable: boolean
  query: string
  onQueryChange(query: string): void
  onBack(): void
  scopeValue(serverName: string): boolean
  scopePending(serverName: string): boolean
  onToggle(serverName: string, next: boolean): void
  onBulk(enabled: boolean, serverNames: readonly string[]): void
  onAdd(): void
}

export function WorkspaceDetailView(props: WorkspaceDetailViewProps): ReactNode {
  const { t, doc, workspace, runtime } = props
  const needle = props.query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      needle === ''
        ? doc.servers
        : doc.servers.filter((server) => server.serverName.toLowerCase().includes(needle)),
    [doc.servers, needle],
  )
  const eligible = visible
    .filter((server) => !isServerDisabled(doc, server.serverName))
    .map((server) => server.serverName)
  // Stored scope count, matching the server-side list/detail summary. The
  // status badge still says "Disabled everywhere" for a globally stopped
  // server; its override remains visible and is not silently subtracted.
  const enabledCount = doc.servers.filter((server) => props.scopeValue(server.serverName)).length
  const showSearch = doc.servers.length >= 5 || props.query !== ''
  const filtered = needle !== ''

  return (
    <div className={styles.detail} data-mcp-workspace-detail={workspace.workspaceId}>
      <button type="button" className={styles.detailBack} onClick={props.onBack}>
        <span aria-hidden="true">←</span> {t('workspace.back')}
      </button>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleGroup}>
          <h2 className={styles.detailTitle} tabIndex={-1} data-mcp-detail-title>
            {workspace.title}
          </h2>
          <p className={styles.detailSub}>{workspace.path}</p>
        </div>
      </div>
      <div className={styles.detailStatusRow}>
        <span>{t('workspace.scopeCount', { enabled: enabledCount, total: doc.servers.length })}</span>
      </div>

      {doc.servers.length === 0 ? (
        <EmptyState
          title={t('workspace.noServers')}
          body={t('workspace.noServersBody')}
          actions={
            props.writable ? (
              <button type="button" className={cx(styles.button, styles.buttonPrimary)} onClick={props.onAdd}>
                {t('add.add')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <SectionBlock
          title={t('workspace.serversTitle')}
          hint={t('workspace.subtitle')}
          actions={
            doc.servers.length > 1 ? (
              <>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={!props.writable || eligible.length === 0}
                  onClick={() => props.onBulk(true, eligible)}
                >
                  {filtered ? t('row.allOnShown', { count: eligible.length }) : t('row.allOn')}
                </button>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={!props.writable || eligible.length === 0}
                  onClick={() => props.onBulk(false, eligible)}
                >
                  {filtered ? t('row.allOffShown', { count: eligible.length }) : t('row.allOff')}
                </button>
              </>
            ) : undefined
          }
        >
          {showSearch && (
            <div className={styles.searchToolbar}>
              <div className={styles.searchField}>
                <input
                  type="search"
                  aria-label={t('workspace.search')}
                  placeholder={t('workspace.search')}
                  value={props.query}
                  onChange={(event) => props.onQueryChange(event.target.value)}
                  className={styles.searchInput}
                />
              </div>
            </div>
          )}
          {visible.length === 0 ? (
            <p className={styles.hint}>{t('list.emptyFiltered')}</p>
          ) : (
            <ul className={styles.scopeGrid}>
              {visible.map((server) => {
                const disabled = isServerDisabled(doc, server.serverName)
                const view = runtimeOf(runtime, server.serverName)
                const serviceUnavailable = runtime.phase === 'unavailable' || runtime.phase === 'error'
                const state = disabled ? 'disabled' : (view?.state ?? (serviceUnavailable ? 'unknown' : 'stopped'))
                const label =
                  view === undefined && runtime.phase === 'loading'
                    ? t('state.loading')
                    : view === undefined && serviceUnavailable
                      ? t('server.statusUnavailable')
                      : t(statusKeyOf(state))
                const id = 'mcp-scope-ws-' + workspace.workspaceId + '-' + server.serverName
                return (
                  <li key={server.serverName} className={styles.scopeRow}>
                    <SwitchControl
                      id={id}
                      checked={props.scopeValue(server.serverName)}
                      disabled={!props.writable || disabled}
                      pending={props.scopePending(server.serverName)}
                      ariaLabel={server.serverName + ': ' + workspace.title}
                      onChange={(next) => props.onToggle(server.serverName, next)}
                    />
                    <label htmlFor={id} className={styles.scopeName}>
                      {server.serverName}
                    </label>
                    <StatusBadge
                      tone={disabled ? 'idle' : statusToneOf(state)}
                      label={disabled ? t('workspace.disabledServer') : label}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </SectionBlock>
      )}
    </div>
  )
}
