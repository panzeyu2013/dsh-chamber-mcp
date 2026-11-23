/**
 * Servers view: one scannable row per server.
 *
 * The row is the ONLY interactive target: it opens the server detail. Status,
 * workspace scope and tool count are read-only signals, so there is no
 * ambiguous switch in the list. All strings arrive through the locale seat.
 *
 * Retained rows (E7): a server REMOVED from the document can still have a
 * runtime record until its teardown is confirmed (`configured: false`). Those
 * rows are rendered non-interactively with the cleanup tag instead of
 * disappearing while the connection is still shutting down.
 */

import { useMemo, type ReactNode } from 'react'
import { isEnabled, isServerDisabled, type McpScopeDoc, type ServerDef } from '../../shared/model.js'
import type { RuntimePhase, RuntimeSnapshot, ServerRuntimeView } from '../runtime.js'
import type { SectionT } from '../section.js'
import type { WorkspaceItem, WorkspaceListStatus } from '../workspaces.js'
import { EmptyState, StatusBadge } from '../components/ui.js'
import { cx, styles } from '../styles.js'
import {
  clockOf,
  needsAttention,
  runtimeOf,
  statusKeyOf,
  statusToneOf,
} from '../view-model.js'

export type ServerFilter = 'all' | 'connected' | 'attention' | 'unused'

export interface ServerListViewProps {
  t: SectionT
  doc: McpScopeDoc
  runtime: RuntimeSnapshot
  runtimePhase: RuntimeSnapshot['phase']
  workspaceStatus: WorkspaceListStatus
  workspaces: readonly WorkspaceItem[]
  query: string
  onQueryChange(query: string): void
  filter: ServerFilter
  onFilterChange(filter: ServerFilter): void
  onOpen(serverName: string): void
  onAdd(): void
  onImport(): void
  writable: boolean
}

/** Workspace scope of one server: enabled count over a settled list. */
function scopeOf(
  doc: McpScopeDoc,
  server: ServerDef,
  workspaces: readonly WorkspaceItem[],
  status: WorkspaceListStatus,
): { enabled: number; total: number } | undefined {
  if (status !== 'ready') return undefined
  let enabled = 0
  for (const workspace of workspaces) {
    if (isEnabled(doc.overrides, workspace.workspaceId, server.serverName)) enabled += 1
  }
  return { enabled, total: workspaces.length }
}

function matchesFilter(
  server: ServerDef,
  filter: ServerFilter,
  doc: McpScopeDoc,
  runtime: RuntimeSnapshot,
  workspaces: readonly WorkspaceItem[],
  workspaceStatus: WorkspaceListStatus,
): boolean {
  if (filter === 'all') return true
  const view = runtimeOf(runtime, server.serverName)
  if (filter === 'connected') return view?.phase === 'connected'
  if (filter === 'attention') {
    if (view !== undefined) return needsAttention(view.phase) || view.phase === 'reconnecting'
    return runtime.phase === 'unavailable' || runtime.phase === 'error'
  }
  if (filter === 'unused') {
    if (isServerDisabled(doc, server.serverName)) return false
    if (workspaceStatus !== 'ready') return false
    return !workspaces.some((workspace) => isEnabled(doc.overrides, workspace.workspaceId, server.serverName))
  }
  return true
}

/** The tool-count label of one row: catalog tools for on-demand servers. */
function toolCountLabel(t: SectionT, server: ServerDef, view: ServerRuntimeView): string | undefined {
  if (view.toolCount <= 0) return undefined
  return server.toolLoading === 'on-demand'
    ? t('status.catalogTools', { count: view.toolCount })
    : t('status.tools', { count: view.toolCount })
}

/** One retained (configured:false) runtime row, non-interactive. */
function retainedRow(t: SectionT, view: ServerRuntimeView): ReactNode {
  return (
    <li key={'retained:' + view.name} className={styles.serverRow} data-server-retained={view.name}>
      <div className={styles.serverRowButton} aria-disabled="true">
        <span className={styles.serverRowTop}>
          <span className={styles.serverRowName}>{view.name}</span>
          <span className={styles.serverRowTags}>
            <span className={styles.tag}>{t('server.cleanupTag')}</span>
          </span>
          <span className={styles.serverRowStats} />
        </span>
        <span className={styles.serverRowMeta}>
          <StatusBadge
            tone={statusToneOf(view.phase)}
            label={t(statusKeyOf(view.phase))}
          />
        </span>
      </div>
    </li>
  )
}

export function ServerListView(props: ServerListViewProps): ReactNode {
  const { t, doc, runtime, workspaces, workspaceStatus } = props
  const needle = props.query.trim().toLowerCase()
  const servers = useMemo(
    () =>
      doc.servers.filter(
        (server) =>
          (needle === '' || server.serverName.toLowerCase().includes(needle)) &&
          matchesFilter(server, props.filter, doc, runtime, workspaces, workspaceStatus),
      ),
    [doc, runtime, workspaces, workspaceStatus, needle, props.filter],
  )
  // Detached rows have no document entry: they can only match the "all" and
  // "attention" filters, and a text query still applies.
  const retained = useMemo(() => {
    if (props.filter !== 'all' && props.filter !== 'attention') return []
    const known = new Set(doc.servers.map((server) => server.serverName))
    return Object.values(runtime.servers).filter(
      (view) =>
        view.configured === false &&
        !known.has(view.name) &&
        (needle === '' || view.name.toLowerCase().includes(needle)) &&
        (props.filter === 'all' || needsAttention(view.phase)),
    )
  }, [doc.servers, runtime.servers, needle, props.filter])
  const showSearch = doc.servers.length >= 5 || props.query !== ''
  const hasFilter = needle !== '' || props.filter !== 'all'
  const clearFilters = (): void => {
    props.onQueryChange('')
    props.onFilterChange('all')
  }

  return (
    <div className={styles.section} data-mcp-servers-view>
      {(showSearch || doc.servers.length > 0) && (
        <div className={styles.searchToolbar}>
          {showSearch && (
            <div className={styles.searchField}>
              <input
                type="search"
                aria-label={t('search.placeholder')}
                placeholder={t('search.placeholder')}
                value={props.query}
                onChange={(event) => props.onQueryChange(event.target.value)}
                className={styles.searchInput}
              />
            </div>
          )}
          <div className={styles.filterChips} role="group" aria-label={t('filter.label')}>
            {(['all', 'connected', 'attention', 'unused'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={props.filter === filter}
                className={cx(styles.filterChip, props.filter === filter && styles.filterChipActive)}
                onClick={() => props.onFilterChange(filter)}
              >
                {t(
                  filter === 'all'
                    ? 'filter.all'
                    : filter === 'connected'
                      ? 'filter.connected'
                      : filter === 'attention'
                        ? 'filter.attention'
                        : 'filter.unused',
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {doc.servers.length === 0 && retained.length === 0 ? (
        <EmptyState
          title={t('empty.serversTitle')}
          body={t('empty.serversBody')}
          actions={
            <>
              <button
                type="button"
                className={cx(styles.button, styles.buttonPrimary)}
                disabled={!props.writable}
                onClick={props.onAdd}
              >
                {t('add.add')}
              </button>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={!props.writable}
                onClick={props.onImport}
              >
                {t('empty.importClipboard')}
              </button>
            </>
          }
        />
      ) : servers.length === 0 && retained.length === 0 ? (
        <EmptyState
          compact
          title={hasFilter ? t('empty.filterTitle') : t('list.emptyFiltered')}
          body={hasFilter ? t('empty.filterBody') : undefined}
          actions={
            hasFilter ? (
              <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={clearFilters}>
                {t('empty.clearFilter')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className={styles.serverList}>
          {servers.map((server) => {
            const disabled = isServerDisabled(doc, server.serverName)
            const view = runtimeOf(runtime, server.serverName)
            // A missing view means "we do not know yet" (the row usually lands
            // one refresh later), never "stopped": that word claims a state the
            // snapshot did not report.
            const phase: RuntimePhase = disabled ? 'disabled' : (view?.phase ?? 'unknown')
            const scope = scopeOf(doc, server, workspaces, workspaceStatus)
            const serviceUnavailable = runtime.phase === 'unavailable' || runtime.phase === 'error'
            const statusLabel =
              view === undefined && props.runtimePhase === 'loading'
                ? t('state.loading')
                : view === undefined && serviceUnavailable
                  ? t('status.unavailable')
                  : t(statusKeyOf(phase))
            const synced = clockOf(view?.syncedAt)
            const scopeLabel =
              scope === undefined
                ? t('server.scopeUnknown')
                : t('server.scopeCount', { enabled: scope.enabled, total: scope.total })
            const unused =
              !disabled && workspaceStatus === 'ready' && scope !== undefined && scope.enabled === 0
            const conflict = view?.error?.code === 'conflict'
            return (
              <li key={server.serverName} className={styles.serverRow} data-server={server.serverName}>
                <button
                  type="button"
                  className={styles.serverRowButton}
                  aria-label={server.serverName + ', ' + statusLabel + ', ' + scopeLabel}
                  onClick={() => props.onOpen(server.serverName)}
                >
                  <span className={styles.serverRowTop}>
                    <span className={styles.serverRowName}>{server.serverName}</span>
                    <span className={styles.serverRowTags}>
                      <span className={styles.tag}>
                        {server.transport === 'stdio' ? t('transport.stdio') : t('transport.http')}
                      </span>
                      {disabled && <span className={styles.tag}>{t('server.disabledTag')}</span>}
                      {conflict && <span className={styles.conflictTag}>{t('server.conflictTag')}</span>}
                    </span>
                    <span className={styles.serverRowStats}>
                      <span className={styles.scopeText}>{scopeLabel}</span>
                      {view !== undefined && toolCountLabel(t, server, view) !== undefined && (
                        <span>{toolCountLabel(t, server, view)}</span>
                      )}
                    </span>
                    <span className={styles.serverRowChevron} aria-hidden="true">
                      ›
                    </span>
                  </span>
                  <span className={styles.serverRowMeta}>
                    <StatusBadge tone={disabled ? 'idle' : statusToneOf(phase)} label={statusLabel} />
                    {unused && <span className={styles.serverRowUnused}>{t('server.unusedTag')}</span>}
                    {view !== undefined && unused === false && view.phase === 'connected' && synced !== undefined && (
                      <span>{t('server.syncedAt', { time: synced })}</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
          {retained.map((view) => retainedRow(t, view))}
        </ul>
      )}
    </div>
  )
}
