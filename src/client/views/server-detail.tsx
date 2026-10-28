/**
 * Server detail: scope, connection state, tools, configuration, availability
 * and the danger zone. The list owns scanning; this view owns one server.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { type McpScopeDoc, type ServerDef } from '../../shared/model.js'
import type { RuntimeSnapshot, RuntimeTestResult, RuntimeToolEntry, ServerRuntimeView } from '../runtime.js'
import type { SectionT } from '../section.js'
import type { WorkspaceItem, WorkspaceListStatus } from '../workspaces.js'
import { CopyButton, InlineNotice, SectionBlock, StatusBadge, SwitchControl } from '../components/ui.js'
import { cx, styles } from '../styles.js'
import {
  clockOf,
  runtimeErrorText,
  serversUsingRef,
  statusKeyOf,
  statusToneOf,
} from '../view-model.js'

export interface ServerDetailProps {
  t: SectionT
  server: ServerDef
  doc: McpScopeDoc
  credentials: Readonly<Record<string, CredentialInfo>>
  writable: boolean
  workspaces: readonly WorkspaceItem[]
  workspaceStatus: WorkspaceListStatus
  runtime?: ServerRuntimeView
  runtimePhase: RuntimeSnapshot['phase']
  allowValue: boolean
  allowPending: boolean
  scopeValue(workspaceId: string): boolean
  scopePending(workspaceId: string): boolean
  onBack(): void
  onEdit(): void
  onSetEnabled(next: boolean): void
  onToggleScope(workspaceId: string, next: boolean): void
  onBulkScope(enabled: boolean, workspaceIds: readonly string[]): void
  onConnect(): Promise<unknown>
  onDisconnect(): Promise<unknown>
  onTest(): Promise<RuntimeTestResult>
  onRefresh(): Promise<void>
  onLoadTools(): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
  onRemove(): void
  onClearCredential(ref: string): void
  autoTest?: boolean
  onAutoTestConsumed(): void
}

interface CredentialRow {
  key: string
  label: string
  ref: string
}

function credentialRowsOf(server: ServerDef): CredentialRow[] {
  if (server.transport === 'stdio') {
    return (server.envKeys ?? []).map((ref) => ({ key: ref, label: ref, ref }))
  }
  return (server.headers ?? []).map((header) => ({
    key: header.name + '::' + header.ref,
    label: header.name,
    ref: header.ref,
  }))
}

function badgeState(
  credentials: Readonly<Record<string, CredentialInfo>>,
  ref: string,
): 'configured' | 'unset' | 'unknown' {
  const view = credentials[ref]
  if (view === undefined) return 'unknown'
  return view.configured === true ? 'configured' : 'unset'
}

function jsonOf(server: ServerDef): string {
  const entry: Record<string, unknown> = { transport: server.transport }
  if (server.transport === 'stdio') {
    entry.command = server.command
    if ((server.args ?? []).length > 0) entry.args = server.args
    if (server.cwd !== undefined && server.cwd !== '') entry.cwd = server.cwd
    if ((server.envKeys ?? []).length > 0) entry.envKeys = server.envKeys
  } else {
    entry.url = server.url
    if ((server.headers ?? []).length > 0) entry.headers = server.headers
  }
  if (server.timeoutMs !== undefined) entry.timeoutMs = server.timeoutMs
  return JSON.stringify({ mcpServers: { [server.serverName]: entry } }, null, 2)
}

export function ServerDetail(props: ServerDetailProps): ReactNode {
  const { t, server, doc, credentials, workspaces, workspaceStatus } = props
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const [wsQuery, setWsQuery] = useState('')
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [tools, setTools] = useState<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number } | null>(null)
  const [toolsSyncedAt, setToolsSyncedAt] = useState<number | undefined>(undefined)
  const [toolsQuery, setToolsQuery] = useState('')
  const [testPending, setTestPending] = useState(false)
  const [connectPending, setConnectPending] = useState<'connect' | 'disconnect' | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [runtimeFailure, setRuntimeFailure] = useState<{ message: string; retry: () => void } | null>(null)
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null)
  const [testNote, setTestNote] = useState<string | null>(null)
  const autoTested = useRef(false)
  const runtime = props.runtime
  // The optimistic availability value drives the rest of the page too: a
  // pending "disable everywhere" must disable the workspace switches at once.
  const disabled = !props.allowValue
  const serviceUnavailable = props.runtimePhase === 'unavailable' || props.runtimePhase === 'error'
  // No view = "unknown", never "stopped": the snapshot may simply not have
  // answered for this server yet.
  const state = disabled ? 'disabled' : (runtime?.state ?? 'unknown')
  const busyPhase = state === 'connecting' || state === 'reconnecting'
  const statusLabel = disabled
    ? t('status.disabled')
    : runtime === undefined && props.runtimePhase === 'loading'
      ? t('state.loading')
      : runtime === undefined && serviceUnavailable
        ? t('server.statusUnavailable')
        : t(statusKeyOf(state))
  const statusTone = disabled ? 'idle' : runtime === undefined && serviceUnavailable ? 'idle' : statusToneOf(state)
  const synced = clockOf(runtime?.syncedAt)
  const checked = clockOf(runtime?.connectedAt)
  const maybeError = runtime?.error
  const credentialRows = credentialRowsOf(server)
  const scopeEnabledCount = workspaces.filter((workspace) => props.scopeValue(workspace.workspaceId)).length

  const runTest = useCallback(async (): Promise<void> => {
    if (testPending) return
    setRuntimeFailure(null)
    setTestNote(null)
    setTestPending(true)
    try {
      const result = await props.onTest()
      if (!mounted.current) return
      if (!result.ok) {
        setRuntimeFailure({
          message: runtimeErrorText(t, {
            code: result.code ?? '',
            message: result.error ?? t('server.testFailed'),
          }),
          retry: () => void runTest(),
        })
      } else {
        setTestNote(t('server.testNote', { count: result.toolCount ?? 0 }))
      }
    } catch (error) {
      if (mounted.current) {
        setRuntimeFailure({
          message: error instanceof Error ? error.message : t('runtime.error'),
          retry: () => void runTest(),
        })
      }
    } finally {
      if (mounted.current) setTestPending(false)
    }
  }, [props, t, testPending])

  useEffect(() => {
    if (testNote === null) return undefined
    const timer = window.setTimeout(() => setTestNote(null), 6000)
    return () => window.clearTimeout(timer)
  }, [testNote])

  useEffect(() => {
    if (props.autoTest !== true || autoTested.current) return
    autoTested.current = true
    props.onAutoTestConsumed()
    // A disabled server is not supervised; a probe would fail for the expected
    // reason and add noise. Test stays available in the header.
    if (disabled) return
    void runTest()
  }, [disabled, props, runTest])

  async function runConnect(action: 'connect' | 'disconnect'): Promise<void> {
    if (connectPending !== null) return
    setRuntimeFailure(null)
    setConnectPending(action)
    try {
      if (action === 'connect') await props.onConnect()
      else await props.onDisconnect()
      // The runtime store refreshes itself after act(); a second per-server
      // pass here is a duplicate request, not a freshness guarantee.
    } catch (error) {
      if (mounted.current) {
        setRuntimeFailure({
          message: error instanceof Error ? error.message : t('runtime.error'),
          retry: () => void runConnect(action),
        })
      }
    } finally {
      if (mounted.current) setConnectPending(null)
    }
  }

  async function runRefresh(): Promise<void> {
    if (refreshing) return
    setRefreshFailure(null)
    setRefreshing(true)
    try {
      await props.onRefresh()
    } catch (error) {
      if (mounted.current) setRefreshFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  async function loadTools(): Promise<void> {
    if (toolsLoading) return
    setToolsLoading(true)
    try {
      const listed = await props.onLoadTools()
      if (mounted.current) {
        setTools(listed)
        setToolsSyncedAt(runtime?.syncedAt)
      }
    } catch (error) {
      if (mounted.current) {
        setRuntimeFailure({
          message: error instanceof Error ? error.message : t('runtime.error'),
          retry: () => void loadTools(),
        })
      }
    } finally {
      if (mounted.current) setToolsLoading(false)
    }
  }

  function toggleTools(): void {
    if (toolsOpen) {
      setToolsOpen(false)
      return
    }
    setToolsOpen(true)
    if (tools === null || toolsSyncedAt !== runtime?.syncedAt) void loadTools()
  }

  // While the table is open, a new sync generation (tools/list_changed,
  // reconnect) refetches it without requiring a collapse/expand cycle.
  useEffect(() => {
    if (!toolsOpen || tools === null) return
    if (runtime?.syncedAt !== undefined && toolsSyncedAt !== runtime.syncedAt) {
      void loadTools()
    }
  }, [runtime?.syncedAt, tools, toolsOpen])

  const needle = wsQuery.trim().toLowerCase()
  const visibleWorkspaces = useMemo(
    () =>
      needle === ''
        ? workspaces
        : workspaces.filter(
            (workspace) =>
              workspace.title.toLowerCase().includes(needle) ||
              workspace.path.toLowerCase().includes(needle),
          ),
    [needle, workspaces],
  )
  // The filter must stay reachable while it is narrowing the list: a workspace
  // disappearing in another tab can take the count under the threshold, and a
  // hidden input would strand the remaining rows behind a query nobody can
  // clear. The sibling list views keep the same invariant.
  const wsFilterVisible = workspaces.length >= 5 || needle !== ''
  const wsFiltered = wsFilterVisible && needle !== ''
  const rowsDisabled = !props.writable || disabled || props.allowPending
  const bulkIds = visibleWorkspaces.map((workspace) => workspace.workspaceId)
  const toolNeedle = toolsQuery.trim().toLowerCase()
  const visibleTools =
    tools === null
      ? []
      : tools.tools.filter(
          (tool) =>
            toolNeedle === '' ||
            tool.rawName.toLowerCase().includes(toolNeedle) ||
            tool.description.toLowerCase().includes(toolNeedle),
        )
  const toolCount = Math.max(runtime?.toolCount ?? 0, tools?.tools.length ?? 0)
  // Machine-readable on purpose: this is pasted into bug reports, so it must
  // stay copy that carries no locale and no user-facing prose.
  const diagnosticText = JSON.stringify(
    {
      server: server.serverName,
      transport: server.transport,
      state: String(state),
      ...(maybeError !== undefined ? { code: maybeError.code, message: maybeError.message } : {}),
      ...(runtime !== undefined ? { attempts: runtime.attempts, maxAttempts: runtime.maxAttempts } : {}),
      ...(runtime?.syncedAt !== undefined ? { syncedAt: new Date(runtime.syncedAt).toISOString() } : {}),
    },
    null,
    2,
  )

  return (
    <div className={styles.detail} data-mcp-server-detail={server.serverName}>
      <button type="button" className={styles.detailBack} onClick={props.onBack}>
        <span aria-hidden="true">←</span> {t('server.back')}
      </button>

      <div className={styles.detailHead}>
        <div className={styles.detailTitleGroup}>
          <h2 className={styles.detailTitle} tabIndex={-1} data-mcp-detail-title>
            {server.serverName}
          </h2>
          <p className={styles.detailSub}>
            <span className={styles.tag}>
              {server.transport === 'stdio' ? t('transport.stdio') : t('transport.http')}
            </span>
            {server.transport === 'stdio' && <span> · {server.command}</span>}
            {server.transport === 'streamable-http' && <span> · {server.url}</span>}
          </p>
        </div>
        <div className={styles.detailActions}>
          {!disabled && (
            <button
              type="button"
              className={cx(
                styles.button,
                runtime?.state === 'connected' || busyPhase ? styles.buttonOutline : styles.buttonPrimary,
              )}
              disabled={connectPending !== null}
              onClick={() =>
                void runConnect(runtime?.state === 'connected' || busyPhase ? 'disconnect' : 'connect')
              }
            >
              {connectPending === 'connect'
                ? t('action.connecting')
                : connectPending === 'disconnect'
                  ? t('action.disconnecting')
                  : runtime?.state === 'connected' || busyPhase
                    ? t('action.disconnect')
                    : t('action.connect')}
            </button>
          )}
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={testPending}
            onClick={() => void runTest()}
          >
            {testPending ? t('action.testing') : t('action.test')}
          </button>
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={refreshing || runtime?.state === 'connecting' || runtime?.state === 'reconnecting'}
            aria-busy={refreshing}
            onClick={() => void runRefresh()}
          >
            {t('runtime.refresh')}
          </button>
        </div>
      </div>

      <div className={styles.detailStatusRow}>
        <StatusBadge tone={statusTone} label={statusLabel} />
        {workspaceStatus === 'ready' && (
          <span>{t('server.scopeCount', { enabled: scopeEnabledCount, total: workspaces.length })}</span>
        )}
        {runtime !== undefined && runtime.toolCount > 0 && (
          <span>{t('status.tools', { count: runtime.toolCount })}</span>
        )}
        {runtime !== undefined &&
          runtime.attempts > 0 &&
          (state === 'connecting' || state === 'reconnecting') && (
            <span>{t('status.retry', { attempt: runtime.attempts, max: runtime.maxAttempts })}</span>
          )}
        {checked !== undefined && <span>{t('server.lastCheckedAt', { time: checked })}</span>}
        {synced !== undefined && <span>{t('server.syncedAt', { time: synced })}</span>}
      </div>

      {maybeError !== undefined && (
        <InlineNotice
          tone="error"
          action={
            <>
              <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={() => void runTest()}>
                {t('action.retry')}
              </button>
              <CopyButton
                text={diagnosticText}
                label={t('server.copyDiagnostic')}
                copiedLabel={t('server.diagnosticCopied')}
                failedLabel={t('server.diagnosticFailed')}
              />
            </>
          }
        >
          {runtimeErrorText(t, maybeError)}
        </InlineNotice>
      )}
      {runtimeFailure !== null && (
        <InlineNotice
          tone="error"
          onDismiss={() => setRuntimeFailure(null)}
          dismissLabel={t('action.dismiss')}
          action={
            <>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                onClick={() => runtimeFailure.retry()}
              >
                {t('action.retry')}
              </button>
              <CopyButton
                text={diagnosticText}
                label={t('server.copyDiagnostic')}
                copiedLabel={t('server.diagnosticCopied')}
                failedLabel={t('server.diagnosticFailed')}
              />
            </>
          }
        >
          {runtimeFailure.message}
        </InlineNotice>
      )}
      {refreshFailure !== null && (
        <InlineNotice
          tone="warn"
          onDismiss={() => setRefreshFailure(null)}
          dismissLabel={t('action.dismiss')}
          action={
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => void runRefresh()}
            >
              {t('action.retry')}
            </button>
          }
        >
          {t('runtime.refreshFailed', { message: refreshFailure })}
        </InlineNotice>
      )}
      {testNote !== null && (
        <InlineNotice
          tone="success"
          onDismiss={() => setTestNote(null)}
          dismissLabel={t('action.dismiss')}
        >
          {testNote}
        </InlineNotice>
      )}
      {runtime === undefined && serviceUnavailable && (
        <InlineNotice tone="info">{t('runtime.unavailable')}</InlineNotice>
      )}

      <div className={styles.detailBody}>
        <SectionBlock
          title={t('server.workspacesTitle')}
          hint={
            disabled
              ? t('server.disabledNotice')
              : workspaceStatus === 'ready'
                ? t('server.workspacesHint')
                : undefined
          }
          actions={
            workspaceStatus === 'ready' && workspaces.length > 1 ? (
              <>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={rowsDisabled || visibleWorkspaces.length === 0}
                  onClick={() => props.onBulkScope(true, bulkIds)}
                >
                  {wsFiltered ? t('row.allOnShown', { count: visibleWorkspaces.length }) : t('row.allOn')}
                </button>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={rowsDisabled || visibleWorkspaces.length === 0}
                  onClick={() => props.onBulkScope(false, bulkIds)}
                >
                  {wsFiltered ? t('row.allOffShown', { count: visibleWorkspaces.length }) : t('row.allOff')}
                </button>
              </>
            ) : undefined
          }
        >
          {workspaceStatus === 'loading' && <p className={styles.hint}>{t('workspaces.loading')}</p>}
          {workspaceStatus === 'error' && <p className={styles.hint}>{t('workspaces.error')}</p>}
          {workspaceStatus === 'ready' && workspaces.length === 0 && (
            <p className={styles.hint}>{t('server.scopeEmpty')}</p>
          )}
          {workspaceStatus === 'ready' && workspaces.length > 0 && wsFilterVisible && (
            <div className={styles.searchToolbar}>
              <div className={styles.searchField}>
                <input
                  type="search"
                  aria-label={t('wsFilter.placeholder')}
                  placeholder={t('wsFilter.placeholder')}
                  value={wsQuery}
                  onChange={(event) => setWsQuery(event.target.value)}
                  className={styles.searchInput}
                />
              </div>
            </div>
          )}
          {workspaceStatus === 'ready' && workspaces.length > 0 && (
            <ul className={styles.scopeGrid}>
              {visibleWorkspaces.map((workspace) => {
                const id = 'mcp-scope-' + server.serverName + '-' + workspace.workspaceId
                return (
                  <li key={workspace.workspaceId} className={styles.scopeRow}>
                    <SwitchControl
                      id={id}
                      checked={props.scopeValue(workspace.workspaceId)}
                      disabled={rowsDisabled}
                      pending={props.scopePending(workspace.workspaceId)}
                      ariaLabel={t('server.workspacesTitle') + ': ' + workspace.title}
                      onChange={(next) => props.onToggleScope(workspace.workspaceId, next)}
                    />
                    <label htmlFor={id} className={styles.scopeName} title={workspace.path}>
                      {workspace.title}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {workspaceStatus === 'ready' && wsFiltered && visibleWorkspaces.length === 0 && (
            <p className={styles.hint}>{t('wsFilter.none', { query: wsQuery.trim() })}</p>
          )}
        </SectionBlock>

        <SectionBlock title={t('server.toolsTitle')} hint={t('server.toolsHint')} actions={undefined}>
          <div className={styles.toolPanel}>
            <button
              type="button"
              className={styles.toolDisclosure}
              aria-expanded={toolsOpen}
              aria-controls={'mcp-scope-tools-' + server.serverName}
              onClick={toggleTools}
            >
              <span aria-hidden="true">{toolsOpen ? '▾' : '▸'}</span>
              <span>{t('tools.title')}</span>
              {toolCount > 0 && <span className={styles.tabCount}>{toolCount}</span>}
            </button>
            {toolsOpen && (
              <div id={'mcp-scope-tools-' + server.serverName} className={styles.toolBody2}>
                {toolsLoading && <p className={styles.hint}>{t('tools.loading')}</p>}
                {!toolsLoading && tools === null && toolCount === 0 && (
                  <div className={styles.toolSearchRow}>
                    <p className={styles.hint}>{t('server.toolsNoRuntime')}</p>
                    <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={() => void runTest()}>
                      {t('action.test')}
                    </button>
                  </div>
                )}
                {!toolsLoading && tools !== null && tools.tools.length === 0 && (
                  <p className={styles.hint}>{t('server.toolsEmpty')}</p>
                )}
                {!toolsLoading && tools !== null && tools.tools.length > 0 && (
                  <>
                    <div className={styles.toolSearchRow}>
                      <div className={styles.searchField}>
                        <input
                          type="search"
                          aria-label={t('server.toolsSearch')}
                          placeholder={t('server.toolsSearch')}
                          value={toolsQuery}
                          onChange={(event) => setToolsQuery(event.target.value)}
                          className={styles.searchInput}
                        />
                      </div>
                      <button
                        type="button"
                        className={cx(styles.button, styles.buttonOutline)}
                        disabled={toolsLoading}
                        onClick={() => void loadTools()}
                      >
                        {t('server.toolsRefresh')}
                      </button>
                      <CopyButton
                        text={tools.tools.map((tool) => tool.rawName + ' — ' + tool.description).join('\n')}
                        label={t('server.toolsCopy')}
                        copiedLabel={t('server.toolsCopied')}
                        failedLabel={t('server.toolsCopyFailed')}
                      />
                    </div>
                    <ul className={styles.toolList}>
                      {visibleTools.map((tool) => (
                        <li key={tool.publicName} className={styles.toolRow}>
                          <span className={styles.toolRowName} title={tool.publicName}>
                            {tool.rawName}
                          </span>
                          <span className={styles.toolRowDesc} title={tool.description}>
                            {tool.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {tools.truncated && (
                      <p className={styles.toolTruncate}>
                        {t('tools.truncated', { count: tools.tools.length, total: tools.total })}
                      </p>
                    )}
                    {visibleTools.length === 0 && (
                      <p className={styles.hint}>{t('tools.noMatch')}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </SectionBlock>

        <SectionBlock
          title={t('server.configTitle')}
          hint={t('server.configHint')}
          actions={
            <>
              {props.writable && (
                <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={props.onEdit}>
                  {t('server.edit')}
                </button>
              )}
              <CopyButton
                text={jsonOf(server)}
                label={t('server.copyJson')}
                copiedLabel={t('server.copyJsonDone')}
                failedLabel={t('server.copyJsonFailed')}
              />
            </>
          }
        >
          <div className={styles.configGrid}>
            {server.transport === 'stdio' ? (
              <>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>{t('server.command')}</span>
                  <code className={styles.configValue}>
                    {[server.command, ...(server.args ?? [])].join(' ')}
                  </code>
                </div>
                {server.cwd !== undefined && server.cwd !== '' && (
                  <div className={styles.configItem}>
                    <span className={styles.configLabel}>{t('server.cwdLabel')}</span>
                    <span className={styles.configValue}>{server.cwd}</span>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>{t('server.url')}</span>
                <code className={styles.configValue}>{server.url}</code>
              </div>
            )}
            <div className={styles.configItem}>
              <span className={styles.configLabel}>{t('server.timeout')}</span>
              <span className={styles.configValue}>
                {server.timeoutMs !== undefined
                  ? t('server.timeoutValue', { value: server.timeoutMs })
                  : t('server.timeoutDefault')}
              </span>
            </div>
          </div>
        </SectionBlock>

        {credentialRows.length > 0 && (
          <SectionBlock title={t('server.credentialsTitle')} hint={t('server.credentialsHint')}>
            <ul className={styles.credentialList}>
              {credentialRows.map((row) => {
                const state = badgeState(credentials, row.ref)
                const view = credentials[row.ref]
                const shared = serversUsingRef(doc, row.ref).filter((name) => name !== server.serverName)
                const clearable = props.writable && state === 'configured' && view?.writable !== false
                return (
                  <li key={row.key} className={styles.credentialRow}>
                    <div className={styles.credentialMain}>
                      <code className={styles.credentialName} title={row.label}>
                        {row.label}
                      </code>
                      {row.ref !== row.label && (
                        <code className={styles.credentialName} title={row.ref}>
                          {row.ref}
                        </code>
                      )}
                      <span className={styles.credentialState}>
                        {state === 'configured'
                          ? t('secret.configured')
                          : state === 'unset'
                            ? t('secret.unset')
                            : t('secret.unknown')}
                      </span>
                      <div className={styles.credentialActions}>
                        {clearable && (
                          <button
                            type="button"
                            className={cx(styles.button, styles.buttonOutline)}
                            aria-label={t('server.clearCredential') + ' ' + row.label}
                            onClick={() => props.onClearCredential(row.ref)}
                          >
                            {t('server.clearCredential')}
                          </button>
                        )}
                      </div>
                    </div>
                    {shared.length > 0 && (
                      <span className={styles.credentialShared}>
                        {t('server.credentialShared', { servers: shared.join(', ') })}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </SectionBlock>
        )}

        <SectionBlock title={t('server.availabilityTitle')}>
          <div className={styles.availabilityRow}>
            <SwitchControl
              id={'mcp-scope-allow-' + server.serverName}
              checked={props.allowValue}
              disabled={!props.writable || props.allowPending}
              pending={props.allowPending}
              ariaLabel={t('server.allowedLabel')}
              ariaDescribedBy={'mcp-scope-allow-hint-' + server.serverName}
              onChange={props.onSetEnabled}
            />
            <div className={styles.availabilityBody}>
              <label htmlFor={'mcp-scope-allow-' + server.serverName} className={styles.scopeName}>
                {t('server.allowedLabel')}
              </label>
              <p id={'mcp-scope-allow-hint-' + server.serverName} className={styles.availabilityHint}>
                {t('server.allowedHint')}
              </p>
            </div>
          </div>
          {disabled && (
            <InlineNotice tone="warn">
              {t('server.disabledNotice')}
            </InlineNotice>
          )}
        </SectionBlock>

        {props.writable && (
          <SectionBlock title={t('danger.title')} tone="danger">
            <div className={styles.dangerZone}>
              <p className={styles.dangerHint}>{t('danger.removeHint')}</p>
              <div className={styles.dangerActions}>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonDanger, styles.buttonOutline)}
                  onClick={props.onRemove}
                >
                  {t('server.remove')}
                </button>
              </div>
            </div>
          </SectionBlock>
        )}
      </div>
    </div>
  )
}
