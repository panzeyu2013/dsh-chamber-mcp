/**
 * Workspace view: the mirror of the server list. One row per workspace, with
 * how many MCP servers it enables; selecting a row opens that workspace's
 * server switches. This is the surface that answers "what can this workspace
 * use?" without walking every server detail.
 */

import { useMemo, type ReactNode } from 'react'
import type { McpScopeDoc } from '../../shared/model.js'
import type { SectionT } from '../section.js'
import type { WorkspaceItem, WorkspaceListStatus } from '../workspaces.js'
import { EmptyState } from '../components/ui.js'
import { styles } from '../styles.js'
import { enabledServerNames } from '../view-model.js'

export interface WorkspaceListViewProps {
  t: SectionT
  doc: McpScopeDoc
  workspaces: readonly WorkspaceItem[]
  workspaceStatus: WorkspaceListStatus
  query: string
  onQueryChange(query: string): void
  onOpen(workspaceId: string): void
  writable: boolean
}

export function WorkspaceListView(props: WorkspaceListViewProps): ReactNode {
  const { t, doc, workspaces, workspaceStatus } = props
  const needle = props.query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      needle === ''
        ? workspaces
        : workspaces.filter(
            (workspace) =>
              workspace.title.toLowerCase().includes(needle) ||
              (workspace.path ?? '').toLowerCase().includes(needle),
          ),
    [needle, workspaces],
  )
  const showSearch = workspaces.length >= 5 || props.query !== ''

  if (workspaceStatus === 'loading') return <p className={styles.hint}>{t('workspaces.loading')}</p>
  if (workspaceStatus === 'error') return <p className={styles.hint}>{t('workspaces.error')}</p>
  if (workspaces.length === 0) {
    return (
      <EmptyState
        title={t('empty.workspacesTitle')}
        body={t('empty.workspacesBody')}
      />
    )
  }

  return (
    <div className={styles.section} data-mcp-workspaces-view>
      {showSearch && (
        <div className={styles.searchToolbar}>
          <div className={styles.searchField}>
            <input
              type="search"
              aria-label={t('wsFilter.placeholder')}
              placeholder={t('wsFilter.placeholder')}
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              className={styles.searchInput}
            />
          </div>
        </div>
      )}
      {visible.length === 0 ? (
        <EmptyState compact title={t('list.emptyFiltered')} />
      ) : (
        <ul className={styles.serverList}>
          {visible.map((workspace) => {
            // Scope counts are the STORED enable records (independent of the
            // global kill switch), matching the server-side summary and the
            // N/M shown on the Workspaces detail. A disabled server is shown
            // as such, not silently subtracted from the scope count.
            const enabled = enabledServerNames(doc, workspace.workspaceId).length
            const total = doc.servers.length
            return (
              <li key={workspace.workspaceId} className={styles.serverRow} data-workspace={workspace.workspaceId}>
                <button
                  type="button"
                  className={styles.serverRowButton}
                  aria-label={t('workspace.open', { name: workspace.title })}
                  onClick={() => props.onOpen(workspace.workspaceId)}
                >
                  <span className={styles.serverRowTop}>
                    <span className={styles.serverRowName}>{workspace.title}</span>
                    <span className={styles.serverRowStats}>
                      <span>{t('workspace.scopeCount', { enabled, total })}</span>
                      <span className={styles.serverRowChevron} aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </span>
                  <span className={styles.serverRowMeta}>
                    <span className={workspace.path === '' ? undefined : styles.scopePath}>
                      {workspace.path}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
