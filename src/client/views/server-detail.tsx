/**
 * Server detail: action row, authorization, scope, tools, configuration,
 * credentials, availability and the danger zone. The list owns scanning; this
 * view owns one server.
 *
 * Wire rules this view obeys (src/shared/wire.ts, frozen):
 * - the phase vocabulary is fixed, so the status pill renders `statusKeyOf`
 *   (an unknown phase is impossible at compile time);
 * - a failure carries a fixed `code` only — never upstream text — so the notice
 *   localizes with `runtimeErrorKey` and falls back to one generic sentence;
 * - the authorization attempt view is token-free: this view renders its phase
 *   and the (copyable) authorization URL, nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { credentialRefsIn, type McpScopeDoc, type ServerDef } from '../../shared/model.js'
import type {
  RuntimeAuthorizationView,
  RuntimeErrorView,
  RuntimePhase,
  RuntimeSnapshot,
  RuntimeTestResult,
  ServerRuntimeView,
  ToolListView,
} from '../runtime.js'
import type { SectionT } from '../section.js'
import type { WorkspaceItem, WorkspaceListStatus } from '../workspaces.js'
import { ConfirmDialog, CopyButton, InlineNotice, SectionBlock, StatusBadge, SwitchControl } from '../components/ui.js'
import { cx, styles } from '../styles.js'
import {
  authorizationReasonKey,
  clockOf,
  isAuthorizationActive,
  runtimeErrorKey,
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
  onRestart(): Promise<unknown>
  /** Starts one attempt; the owning section owns the popup + failure surface. */
  onAuthorize(): void
  onCancelAuthorization(attemptId: string): void
  onSignOut(): void
  /** True while this server has an OAuth action in flight. */
  authorizationPending?: boolean
  onRefresh(): Promise<void>
  onLoadTools(): Promise<ToolListView>
  /** Popup-blocked fallback: the authorization page URL for this server. */
  authorizationFallback?: string
  onRemove(): void
  onClearCredential(ref: string): void
  autoTest?: boolean
  onAutoTestConsumed(): void
}

interface CredentialRow {
  key: string
  label: string
  /** Credential ref the row's value comes from. */
  ref: string
}

/** Credential rows of one server, from both the legacy rows and the new maps. */
function credentialRowsOf(server: ServerDef): CredentialRow[] {
  const rows: CredentialRow[] = []
  const seen = new Set<string>()
  const add = (key: string, label: string, ref: string): void => {
    if (ref === '' || seen.has(key)) return
    seen.add(key)
    rows.push({ key, label, ref })
  }
  if (server.transport === 'stdio') {
    for (const ref of server.envKeys ?? []) add(ref, ref, ref)
    for (const [name, value] of Object.entries(server.env ?? {})) {
      for (const ref of credentialRefsIn(value)) add(name + '::' + ref, name, ref)
    }
    return rows
  }
  const headers: unknown = server.headers
  if (Array.isArray(headers)) {
    for (const row of headers as readonly { name: string; ref: string }[]) add(row.name + '::' + row.ref, row.name, row.ref)
  } else if (headers !== null && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      for (const ref of credentialRefsIn(value)) add(name + '::' + ref, name, ref)
    }
  }
  return rows
}

function badgeState(
  credentials: Readonly<Record<string, CredentialInfo>>,
  ref: string,
): 'configured' | 'unset' | 'unknown' {
  const view = credentials[ref]
  if (view === undefined) return 'unknown'
  return view.configured === true ? 'configured' : 'unset'
}

/**
 * Upstream-named definition of one server (Copy JSON). Credential-template
 * values are copy verbatim — a template is a REF, not a secret — while stored
 * secret VALUES never enter this view at all.
 */
function jsonOf(server: ServerDef): string {
  const entry: Record<string, unknown> = { serverName: server.serverName, transport: server.transport }
  if (server.transport === 'stdio') {
    entry.command = server.command
    if ((server.args ?? []).length > 0) entry.args = server.args
    if (server.cwd !== undefined && server.cwd !== '') entry.cwd = server.cwd
    if ((server.envKeys ?? []).length > 0) entry.envKeys = server.envKeys
    if (server.env !== undefined && Object.keys(server.env).length > 0) entry.env = server.env
  } else {
    entry.url = server.url
    if (server.headers !== undefined && (!Array.isArray(server.headers) || server.headers.length > 0)) {
      entry.headers = server.headers
    }
    if (server.oauth !== undefined) {
      entry.oauth = {
        ...(server.oauth.clientId !== undefined ? { clientId: server.oauth.clientId } : {}),
        ...(server.oauth.scope !== undefined ? { scope: server.oauth.scope } : {}),
      }
    }
  }
  if (server.startupTimeoutMs !== undefined) entry.startupTimeoutMs = server.startupTimeoutMs
  if (server.closeTimeoutMs !== undefined) entry.closeTimeoutMs = server.closeTimeoutMs
  if (server.toolCallTimeoutMs !== undefined) entry.toolCallTimeoutMs = server.toolCallTimeoutMs
  if (server.reconnect !== undefined) entry.reconnect = server.reconnect
  if (server.toolLoading !== undefined) entry.toolLoading = server.toolLoading
  return JSON.stringify({ mcpServers: { [server.serverName]: entry } }, null, 2)
}

/** Localized text of one fixed failure code (never upstream prose). */
function errorTextOf(t: SectionT, error: RuntimeErrorView): string {
  const key = runtimeErrorKey(error.code)
  return key !== undefined ? t(key) : t('runtime.error')
}

/** Action row: connect/disconnect, test, restart, refresh status. */
function ActionRow(props: {
  t: SectionT
  phase: RuntimePhase
  disabled: boolean
  writable: boolean
  connectPending: 'connect' | 'disconnect' | null
  testPending: boolean
  restartPending: boolean
  refreshing: boolean
  onConnect(): void
  onDisconnect(): void
  onTest(): void
  onRestart(): void
  onRefresh(): void
}): ReactNode {
  const { t, phase } = props
  const waiting = phase === 'waiting-authorization'
  const busy = phase === 'connecting' || phase === 'reconnecting'
  return (
    <div className={styles.detailActions}>
      {!props.disabled && (
        <button
          type="button"
          className={cx(
            styles.button,
            phase === 'connected' || busy ? styles.buttonOutline : styles.buttonPrimary,
          )}
          // Connect/disconnect is inert while a browser authorization is
          // pending (the mounted instance owns that lifecycle; a connect would
          // race the attempt). The host refuses it too — the button must not
          // look like it can work.
          disabled={waiting || props.connectPending !== null || busy}
          onClick={phase === 'connected' || busy ? props.onDisconnect : props.onConnect}
        >
          {props.connectPending === 'connect'
            ? t('action.connecting')
            : props.connectPending === 'disconnect'
              ? t('action.disconnecting')
              : phase === 'connected' || busy
                ? t('action.disconnect')
                : t('action.connect')}
        </button>
      )}
      {waiting && <span className={styles.tag}>{t('status.waitingAuthorization')}</span>}
      <button
        type="button"
        className={cx(styles.button, styles.buttonOutline)}
        disabled={props.testPending}
        onClick={props.onTest}
      >
        {props.testPending ? t('action.testing') : t('action.test')}
      </button>
      {props.writable && (
        <button
          type="button"
          className={cx(styles.button, styles.buttonOutline)}
          disabled={props.restartPending || busy}
          onClick={props.onRestart}
        >
          {props.restartPending ? t('action.restarting') : t('action.restart')}
        </button>
      )}
      <button
        type="button"
        className={cx(styles.button, styles.buttonOutline)}
        disabled={props.refreshing || busy}
        aria-busy={props.refreshing}
        onClick={props.onRefresh}
      >
        {t('runtime.refresh')}
      </button>
    </div>
  )
}

/** Meaningful OAuth status of one server view. */
function authorizationStatusKey(
  runtime: ServerRuntimeView | undefined,
  attempt: RuntimeAuthorizationView | undefined,
): 'auth.status.disconnected' | 'auth.status.waiting' | 'auth.status.authorizing' | 'auth.status.connected' | 'auth.status.rejected' {
  // An ACTIVE attempt outranks the waiting phase: the waiting pill describes
  // "needs the user", the authorizing label describes the attempt in flight.
  if (attempt !== undefined && isAuthorizationActive(attempt.phase)) return 'auth.status.authorizing'
  if (runtime?.phase === 'waiting-authorization') return 'auth.status.waiting'
  if (runtime?.phase === 'connected' || attempt?.phase === 'authorized') return 'auth.status.connected'
  if (attempt?.phase === 'failed' || runtime?.phase === 'failed') return 'auth.status.rejected'
  return 'auth.status.disconnected'
}

/**
 * Authorization section (http servers configured for OAuth, or any server the
 * host reports as waiting). The attempt is HOST-owned: this view only renders
 * its phase / URL and dispatches the four actions.
 */
function AuthorizationSection(props: {
  t: SectionT
  runtime?: ServerRuntimeView
  writable: boolean
  fallbackUrl?: string
  pending: boolean
  onAuthorize(): void
  onCancel(attemptId: string): void
  onSignOut(): void
  onOpenPage(url: string): void
}): ReactNode {
  const { t, runtime } = props
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const attempt = runtime?.authorization
  const statusKey = authorizationStatusKey(runtime, attempt)
  const active = attempt !== undefined && isAuthorizationActive(attempt.phase)
  const credited = statusKey === 'auth.status.connected'
  const reasonKey = runtime?.authReason !== undefined ? authorizationReasonKey(runtime.authReason) : undefined
  const tone = statusKey === 'auth.status.rejected' ? 'error' : credited ? 'ok' : active || statusKey === 'auth.status.waiting' ? 'warn' : 'idle'
  const url = attempt?.authorizationUrl ?? props.fallbackUrl
  return (
    <SectionBlock
      title={t('auth.title')}
      hint={credited ? t('auth.bindingHint') : t('auth.completesInBrowser')}
      actions={
        props.writable ? (
          <>
            {!active && (
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={props.pending}
                onClick={props.onAuthorize}
              >
                {credited ? t('auth.authorizeAgain') : t('auth.authorize')}
              </button>
            )}
            {active && (
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={props.pending}
                onClick={() => {
                  if (attempt !== undefined) props.onCancel(attempt.id)
                }}
              >
                {t('auth.cancel')}
              </button>
            )}
            {credited && (
              <button
                type="button"
                className={cx(styles.button, styles.buttonDanger, styles.buttonOutline)}
                disabled={props.pending}
                onClick={() => setConfirmSignOut(true)}
              >
                {t('auth.signOut')}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <div className={styles.authStatusRow}>
        <StatusBadge tone={tone} label={t(statusKey)} />
        {reasonKey !== undefined && <span className={styles.authReason}>{t(reasonKey)}</span>}
      </div>
      {active && attempt?.phase === 'waiting-browser' && (
        <p className={styles.hint}>{t('auth.completesInBrowser')}</p>
      )}
      {url !== undefined && (
        <div className={styles.authUrlRow}>
          <code className={styles.authUrl}>{url}</code>
          {attempt?.phase === 'waiting-browser' && (
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => props.onOpenPage(url)}
            >
              {t('auth.openPage')}
            </button>
          )}
          <CopyButton
            text={url}
            label={t('auth.copyUrl')}
            copiedLabel={t('auth.copiedUrl')}
            failedLabel={t('auth.copyUrlFailed')}
          />
        </div>
      )}
      {props.fallbackUrl !== undefined && (
        <InlineNotice tone="warn" action={undefined}>
          {t('auth.popupBlocked')}
        </InlineNotice>
      )}
      <ConfirmDialog
        open={confirmSignOut}
        title={t('auth.signOut')}
        body={t('auth.signOutConfirm')}
        confirmLabel={t('auth.signOut')}
        cancelLabel={t('action.cancel')}
        closeLabel={t('action.cancel')}
        danger
        onConfirm={() => {
          setConfirmSignOut(false)
          props.onSignOut()
        }}
        onCancel={() => setConfirmSignOut(false)}
      />
    </SectionBlock>
  )
}

/** On-demand catalog / eager tool table. */
function ToolsSection(props: {
  t: SectionT
  server: ServerDef
  runtime?: ServerRuntimeView
  onProbe(): void
  onLoadTools(): Promise<ToolListView>
}): ReactNode {
  const { t, server, runtime } = props
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listed, setListed] = useState<ToolListView | null>(null)
  const [syncedAt, setSyncedAt] = useState<number | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const load = useCallback(async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setFailure(null)
    try {
      const result = await props.onLoadTools()
      if (!mounted.current) return
      setListed(result)
      setSyncedAt(runtime?.syncedAt)
    } catch {
      if (mounted.current) setFailure(t('runtime.error'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [loading, props, runtime?.syncedAt, t])
  const onDemand = listed?.mode === 'catalog' || server.toolLoading === 'on-demand'
  const toolCount = Math.max(runtime?.toolCount ?? 0, listed?.total ?? 0)
  const needle = query.trim().toLowerCase()
  const visibleTools =
    listed !== null && listed.mode === 'definitions'
      ? listed.tools.filter(
          (tool) =>
            needle === '' ||
            tool.publicName.toLowerCase().includes(needle) ||
            tool.description.toLowerCase().includes(needle),
        )
      : []
  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (listed === null || syncedAt !== runtime?.syncedAt) void load()
  }
  // A new capture generation while the table is open refetches it without a
  // collapse/expand cycle.
  useEffect(() => {
    if (!open || listed === null) return
    if (runtime?.syncedAt !== undefined && syncedAt !== runtime.syncedAt) void load()
  }, [runtime?.syncedAt, listed, open])
  return (
    <SectionBlock
      title={onDemand ? t('server.catalogTitle') : t('server.toolsTitle')}
      hint={onDemand ? t('server.catalogHint') : t('server.toolsHint')}
      actions={undefined}
    >
      <div className={styles.toolPanel}>
        <button
          type="button"
          className={styles.toolDisclosure}
          aria-expanded={open}
          aria-controls={'mcp-scope-tools-' + server.serverName}
          onClick={toggle}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>{t('tools.title')}</span>
          {toolCount > 0 && (
            <span className={styles.tabCount}>
              {onDemand ? t('status.catalogTools', { count: toolCount }) : toolCount}
            </span>
          )}
        </button>
        {open && (
          <div id={'mcp-scope-tools-' + server.serverName} className={styles.toolBody2}>
            {loading && <p className={styles.hint}>{t('tools.loading')}</p>}
            {failure !== null && (
              <InlineNotice
                tone="error"
                onDismiss={() => setFailure(null)}
                dismissLabel={t('action.dismiss')}
                action={
                  <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={() => void load()}>
                    {t('action.retry')}
                  </button>
                }
              >
                {failure}
              </InlineNotice>
            )}
            {!loading && listed === null && toolCount === 0 && (
              <div className={styles.toolSearchRow}>
                <p className={styles.hint}>{t('server.toolsNoRuntime')}</p>
                <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={props.onProbe}>
                  {t('action.test')}
                </button>
              </div>
            )}
            {!loading && listed === null && toolCount > 0 && (
              <p className={styles.hint}>{t('server.toolsLoading')}</p>
            )}
            {!loading && listed !== null && listed.mode === 'catalog' && (
              <>
                <p className={styles.hint}>{t('server.catalogCount', { count: listed.total })}</p>
                <p className={styles.hint}>{t('server.catalogCountHint')}</p>
              </>
            )}
            {!loading && listed !== null && listed.mode === 'definitions' && listed.tools.length === 0 && (
              <p className={styles.hint}>{t('server.toolsEmpty')}</p>
            )}
            {!loading && listed !== null && listed.mode === 'definitions' && listed.tools.length > 0 && (
              <>
                <div className={styles.toolSearchRow}>
                  <div className={styles.searchField}>
                    <input
                      type="search"
                      aria-label={t('server.toolsSearch')}
                      placeholder={t('server.toolsSearch')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className={styles.searchInput}
                    />
                  </div>
                  <button
                    type="button"
                    className={cx(styles.button, styles.buttonOutline)}
                    disabled={loading}
                    onClick={() => void load()}
                  >
                    {t('server.toolsRefresh')}
                  </button>
                  <CopyButton
                    text={listed.tools.map((tool) => tool.publicName + ' — ' + tool.description).join('\n')}
                    label={t('server.toolsCopy')}
                    copiedLabel={t('server.toolsCopied')}
                    failedLabel={t('server.toolsCopyFailed')}
                  />
                </div>
                <ul className={styles.toolList}>
                  {visibleTools.map((tool) => (
                    <li key={tool.publicName} className={styles.toolRow}>
                      <span className={styles.toolRowName} title={tool.publicName}>
                        {tool.publicName}
                      </span>
                      <span className={styles.toolRowDesc} title={tool.description}>
                        {tool.description}
                      </span>
                    </li>
                  ))}
                </ul>
                {listed.truncated && (
                  <p className={styles.toolTruncate}>
                    {t('tools.truncated', { count: listed.tools.length, total: listed.total })}
                  </p>
                )}
                {visibleTools.length === 0 && <p className={styles.hint}>{t('tools.noMatch')}</p>}
              </>
            )}
          </div>
        )}
      </div>
    </SectionBlock>
  )
}

/** One value row of the configuration grid: explicit value or "Default". */
function valueOrDefault(t: SectionT, value: number | undefined): string {
  return value !== undefined ? t('server.msValue', { value }) : t('server.valueDefault')
}

/** Configuration rows of one server (the exposed knobs + import-only extras). */
function ConfigurationSection(props: {
  t: SectionT
  server: ServerDef
  writable: boolean
  onEdit(): void
}): ReactNode {
  const { t, server } = props
  const reconnect = server.reconnect
  return (
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
              <code className={styles.configValue}>{[server.command, ...(server.args ?? [])].join(' ')}</code>
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
          <span className={styles.configLabel}>{t('server.startupTimeout')}</span>
          <span className={styles.configValue}>{valueOrDefault(t, server.startupTimeoutMs)}</span>
        </div>
        <div className={styles.configItem}>
          <span className={styles.configLabel}>{t('server.closeTimeout')}</span>
          <span className={styles.configValue}>{valueOrDefault(t, server.closeTimeoutMs)}</span>
        </div>
        <div className={styles.configItem}>
          <span className={styles.configLabel}>{t('server.toolCallTimeout')}</span>
          <span className={styles.configValue}>{valueOrDefault(t, server.toolCallTimeoutMs)}</span>
        </div>
        <div className={styles.configItem}>
          <span className={styles.configLabel}>{t('add.toolLoading')}</span>
          <span className={styles.configValue}>
            {server.toolLoading === 'on-demand' ? t('add.toolLoadingOnDemand') : t('add.toolLoadingEager')}
          </span>
        </div>
        {reconnect !== undefined && (
          <div className={styles.configItem}>
            <span className={styles.configLabel}>{t('server.reconnect')}</span>
            <span className={styles.configValue}>
              {reconnect.enabled === false
                ? t('server.reconnectOff')
                : t('server.reconnectSummary', {
                    initial: reconnect.initialDelayMs ?? 500,
                    max: reconnect.maxDelayMs ?? 30000,
                    attempts: reconnect.maxAttempts ?? 10,
                  })}
            </span>
          </div>
        )}
        {server.transport === 'streamable-http' && server.oauth !== undefined && (
          <div className={styles.configItem}>
            <span className={styles.configLabel}>{t('auth.title')}</span>
            <span className={styles.configValue}>
              {server.oauth.scope !== undefined ? server.oauth.scope : t('server.valueDefault')}
            </span>
          </div>
        )}
      </div>
    </SectionBlock>
  )
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
  const [testPending, setTestPending] = useState(false)
  const [connectPending, setConnectPending] = useState<'connect' | 'disconnect' | null>(null)
  const [restartPending, setRestartPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [runtimeFailure, setRuntimeFailure] = useState<{ message: string; retry: () => void } | null>(null)
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null)
  const [testNote, setTestNote] = useState<string | null>(null)
  const autoTested = useRef(false)
  /**
   * Synchronous action locks. State alone cannot stop a double click: BOTH
   * clicks run before the first re-render (React flushes at the end of the
   * discrete event), so the second invocation would send a duplicate host
   * action and its `finally` would even clear the first one's pending flag.
   */
  const actionLocks = useRef(new Set<string>())
  const lock = (key: string): boolean => {
    if (actionLocks.current.has(key)) return false
    actionLocks.current.add(key)
    return true
  }
  const unlock = (key: string): void => {
    actionLocks.current.delete(key)
  }
  const runtime = props.runtime
  // The optimistic availability value drives the rest of the page too: a
  // pending "disable everywhere" must disable the workspace switches at once.
  const disabled = !props.allowValue
  const serviceUnavailable = props.runtimePhase === 'unavailable' || props.runtimePhase === 'error'
  // No view = "unknown", never "stopped": the snapshot may simply not have
  // answered for this server yet.
  const phase: RuntimePhase = disabled ? 'disabled' : (runtime?.phase ?? 'unknown')
  const statusLabel = disabled
    ? t('status.disabled')
    : runtime === undefined && props.runtimePhase === 'loading'
      ? t('state.loading')
      : runtime === undefined && serviceUnavailable
        ? t('server.statusUnavailable')
        : t(statusKeyOf(phase))
  const statusTone = disabled ? 'idle' : runtime === undefined && serviceUnavailable ? 'idle' : statusToneOf(phase)
  const synced = clockOf(runtime?.syncedAt)
  const checked = clockOf(runtime?.connectedAt)
  const maybeError = runtime?.error
  const credentialRows = credentialRowsOf(server)
  const scopeEnabledCount = workspaces.filter((workspace) => props.scopeValue(workspace.workspaceId)).length
  const onDemand = server.toolLoading === 'on-demand'
  const attempt = runtime?.authorization
  const showAuthorization =
    server.transport === 'streamable-http' &&
    (server.oauth !== undefined || runtime?.phase === 'waiting-authorization' || attempt !== undefined)

  const runTest = useCallback(async (): Promise<void> => {
    if (!lock('test')) return
    setRuntimeFailure(null)
    setTestNote(null)
    setTestPending(true)
    try {
      const result = await props.onTest()
      if (!mounted.current) return
      if (!result.ok) {
        const key = result.code !== undefined ? runtimeErrorKey(result.code) : undefined
        setRuntimeFailure({
          message: key !== undefined ? t(key) : t('server.testFailed'),
          retry: () => void runTest(),
        })
      } else {
        setTestNote(t('server.testNote', { count: result.toolCount ?? 0 }))
      }
    } catch {
      if (mounted.current) {
        setRuntimeFailure({ message: t('runtime.error'), retry: () => void runTest() })
      }
    } finally {
      unlock('test')
      if (mounted.current) setTestPending(false)
    }
  }, [props, t])

  useEffect(() => {
    if (testNote === null) return undefined
    const timer = window.setTimeout(() => setTestNote(null), 6000)
    return () => window.clearTimeout(timer)
  }, [testNote])

  useEffect(() => {
    if (props.autoTest !== true || autoTested.current) return
    autoTested.current = true
    props.onAutoTestConsumed()
    if (disabled) return
    void runTest()
  }, [disabled, props, runTest])

  async function runConnect(action: 'connect' | 'disconnect'): Promise<void> {
    if (!lock('connect')) return
    setRuntimeFailure(null)
    setConnectPending(action)
    try {
      if (action === 'connect') await props.onConnect()
      else await props.onDisconnect()
    } catch {
      if (mounted.current) {
        setRuntimeFailure({ message: t('runtime.error'), retry: () => void runConnect(action) })
      }
    } finally {
      unlock('connect')
      if (mounted.current) setConnectPending(null)
    }
  }

  async function runRestart(): Promise<void> {
    if (!lock('restart')) return
    setRuntimeFailure(null)
    setRestartPending(true)
    try {
      await props.onRestart()
    } catch {
      if (mounted.current) {
        setRuntimeFailure({ message: t('runtime.error'), retry: () => void runRestart() })
      }
    } finally {
      unlock('restart')
      if (mounted.current) setRestartPending(false)
    }
  }

  async function runRefresh(): Promise<void> {
    if (!lock('refresh')) return
    setRefreshFailure(null)
    setRefreshing(true)
    try {
      await props.onRefresh()
    } catch {
      if (mounted.current) setRefreshFailure(t('runtime.refreshFailed', { message: '' }))
    } finally {
      unlock('refresh')
      if (mounted.current) setRefreshing(false)
    }
  }

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
  const wsFilterVisible = workspaces.length >= 5 || needle !== ''
  const wsFiltered = wsFilterVisible && needle !== ''
  const rowsDisabled = !props.writable || disabled || props.allowPending
  const bulkIds = visibleWorkspaces.map((workspace) => workspace.workspaceId)
  // Machine-readable on purpose: this is pasted into bug reports, so it must
  // stay copy that carries no locale and no user-facing prose.
  const diagnosticText = JSON.stringify(
    {
      server: server.serverName,
      transport: server.transport,
      state: phase,
      ...(maybeError !== undefined ? { code: maybeError.code } : {}),
      ...(runtime !== undefined ? { attempts: runtime.attempts, maxAttempts: runtime.maxAttempts } : {}),
      ...(attempt !== undefined ? { authorizationPhase: attempt.phase } : {}),
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
        <ActionRow
          t={t}
          phase={phase}
          disabled={disabled}
          writable={props.writable}
          connectPending={connectPending}
          testPending={testPending}
          restartPending={restartPending}
          refreshing={refreshing}
          onConnect={() => void runConnect('connect')}
          onDisconnect={() => void runConnect('disconnect')}
          onTest={() => void runTest()}
          onRestart={() => void runRestart()}
          onRefresh={() => void runRefresh()}
        />
      </div>

      <div className={styles.detailStatusRow}>
        <StatusBadge tone={statusTone} label={statusLabel} />
        {workspaceStatus === 'ready' && (
          <span>{t('server.scopeCount', { enabled: scopeEnabledCount, total: workspaces.length })}</span>
        )}
        {runtime !== undefined && runtime.toolCount > 0 && (
          <span>
            {onDemand
              ? t('status.catalogTools', { count: runtime.toolCount })
              : t('status.tools', { count: runtime.toolCount })}
          </span>
        )}
        {attempt !== undefined && <span>{t(authorizationStatusKey(runtime, attempt))}</span>}
        {runtime !== undefined &&
          runtime.attempts > 0 &&
          (phase === 'connecting' || phase === 'reconnecting') && (
            <span>{t('status.retry', { attempt: runtime.attempts, max: runtime.maxAttempts })}</span>
          )}
        {checked !== undefined && <span>{t('server.lastCheckedAt', { time: checked })}</span>}
        {synced !== undefined && <span>{t('server.syncedAt', { time: synced })}</span>}
        {maybeError?.code === 'conflict' && <span className={styles.conflictTag}>{t('server.conflictTag')}</span>}
        {runtime?.configured === false && <span className={styles.tag}>{t('server.cleanupTag')}</span>}
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
          {errorTextOf(t, maybeError)}
        </InlineNotice>
      )}
      {maybeError?.code === 'conflict' && <InlineNotice tone="warn">{t('server.conflictNotice')}</InlineNotice>}
      {runtime?.configured === false && <InlineNotice tone="warn">{t('server.cleanupNotice')}</InlineNotice>}
      {runtimeFailure !== null && (
        <InlineNotice
          tone="error"
          onDismiss={() => setRuntimeFailure(null)}
          dismissLabel={t('action.dismiss')}
          action={
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => runtimeFailure.retry()}
            >
              {t('action.retry')}
            </button>
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
            <button type="button" className={cx(styles.button, styles.buttonOutline)} onClick={() => void runRefresh()}>
              {t('action.retry')}
            </button>
          }
        >
          {refreshFailure}
        </InlineNotice>
      )}
      {testNote !== null && (
        <InlineNotice tone="success" onDismiss={() => setTestNote(null)} dismissLabel={t('action.dismiss')}>
          {testNote}
        </InlineNotice>
      )}
      {runtime === undefined && serviceUnavailable && (
        <InlineNotice tone="info">{t('runtime.unavailable')}</InlineNotice>
      )}

      <div className={styles.detailBody}>
        {showAuthorization && (
          <AuthorizationSection
            t={t}
            runtime={runtime}
            writable={props.writable}
            fallbackUrl={props.authorizationFallback}
            pending={props.authorizationPending === true}
            onAuthorize={() => props.onAuthorize()}
            onCancel={(attemptId) => props.onCancelAuthorization(attemptId)}
            onSignOut={() => props.onSignOut()}
            onOpenPage={(url) => {
              // The attempt's URL is the host's authorization page: opening it
              // in a new tab is the whole action (the popup was already opened
              // synchronously by the section's click handler).
              if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
            }}
          />
        )}

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

        <ToolsSection
          t={t}
          server={server}
          runtime={runtime}
          onProbe={() => void runTest()}
          onLoadTools={() => props.onLoadTools()}
        />

        <ConfigurationSection t={t} server={server} writable={props.writable} onEdit={props.onEdit} />

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
          {disabled && <InlineNotice tone="warn">{t('server.disabledNotice')}</InlineNotice>}
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
