/**
 * One MCP server card: definition details (command/URL), transport/summary
 * header, credential badges with a configured/unset/unknown tri-state, and
 * the per-workspace on/off rows (presence in `overrides[w][name]` =
 * explicitly OFF; absence = on by default).
 *
 * The card owns the outcome feedback of its own actions: a localized
 * transient role="alert" banner appears here (not at the section top) for a
 * failed toggle/remove/clear, clears when the next action starts or is
 * dismissed, and the removal confirm and the Clear control carry real
 * pending states. Async continuations never write state after unmount
 * (FE-11): success paths skip their trailing state writes entirely.
 *
 * Chrome comes from the shared style seat (`./styles.ts`): the card is the
 * settings-panel card vocabulary (elevation stroke + r14 + layer-3 fill, 12/14
 * inset); the transport tag is the Tag pill, the credential tones reuse the Tag
 * palette,
 * the rows' control is the Switch primitive's geometry over this plugin's own
 * controlled checkbox, and every action is a `size="sm"` capsule button.
 */

import { useEffect, useRef, useState } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { credentialRefsOf, isEnabled, isServerDisabled, type McpScopeDoc, type ServerDef } from '../shared/model.js'
import { failureText, type SaveFailure, type SaveOutcome } from './controller.js'
import { countKey, type SettingsKey } from './locales.js'
import type { RuntimePhase, RuntimeTestResult, RuntimeToolEntry, ServerRuntimeView } from './runtime.js'
import type { SectionT } from './section.js'
import { cx, styles } from './styles.js'
import type { WorkspaceItem, WorkspaceListStatus } from './workspaces.js'

export interface ServerCardProps {
  /** Parent surface has an open add/edit form: destructive card actions are disabled. */
  actionsDisabled?: boolean
  t: SectionT
  server: ServerDef
  doc: McpScopeDoc
  /** Configured/writable views per credential ref (host describe). */
  credentials: Readonly<Record<string, CredentialInfo>>
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Real workspace list lifecycle (rows gate on it). */
  workspaceStatus: WorkspaceListStatus
  /** Real workspaces (items only meaningful when status is 'ready'). */
  workspaces: readonly WorkspaceItem[]
  /**
   * Re-pull ONLY this server's runtime view (`refreshRuntime({ server })`).
   * Failures reject with their RuntimeCallError: this card renders the error.
   */
  onRefresh?(serverName: string): Promise<void>
  onEdit(): void
  onRemove(name: string): Promise<SaveOutcome>
  onToggle(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome>
  /** Batch per-workspace switch ("all on" / "all off"). */
  onToggleAll(serverName: string, off: boolean, workspaceIds: readonly string[]): Promise<SaveOutcome>
  /** Global enable/disable switch. */
  onSetEnabled(serverName: string, enabled: boolean): Promise<SaveOutcome>
  onUnsetCredential(ref: string): Promise<SaveOutcome>
  /** Live runtime view of this server (absent = no runtime channel / not loaded). */
  runtime?: ServerRuntimeView
  /** Lifecycle of the whole runtime snapshot (drives the degraded hint). */
  runtimePhase?: 'loading' | 'ready' | 'unavailable' | 'error'
  onConnect?(serverName: string): Promise<unknown>
  onDisconnect?(serverName: string): Promise<unknown>
  onTest?(serverName: string): Promise<RuntimeTestResult>
  onLoadTools?(serverName: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

/** Locale key of one runtime phase. */
function statusKeyOf(state: RuntimePhase): SettingsKey {
  switch (state) {
    case 'connected':
      return 'status.connected'
    case 'connecting':
      return 'status.connecting'
    case 'reconnecting':
      return 'status.reconnecting'
    case 'failed':
      return 'status.failed'
    case 'stopped':
      return 'status.stopped'
    case 'disabled':
      return 'status.disabled'
    default:
      return 'status.unknown'
  }
}

/** Locale key of one runtime error code (undefined = keep the host message). */
function runtimeErrorKey(code: string): SettingsKey | undefined {
  switch (code) {
    case 'connection-failed':
      return 'runtime.error.connection-failed'
    case 'gave-up':
      return 'runtime.error.gave-up'
    case 'reconnect-disabled':
      return 'runtime.error.reconnect-disabled'
    case 'generation-stuck':
      return 'runtime.error.generation-stuck'
    case 'forbidden':
      return 'runtime.error.forbidden'
    case 'timeout':
      return 'runtime.error.timeout'
    case 'spawn-failed':
      return 'runtime.error.spawn-failed'
    case 'protocol':
      return 'runtime.error.protocol'
    default:
      return undefined
  }
}

/** Localized text of one runtime error (fixed host codes never carry remote text). */
function runtimeErrorText(t: SectionT, error: { code: string; message: string }): string {
  const key = runtimeErrorKey(error.code)
  return key !== undefined ? t(key) : error.message
}

/** Tone class of one runtime phase (idle = no extra class). */
function statusToneOf(state: RuntimePhase): string | undefined {
  switch (state) {
    case 'connected':
      return styles.statusDotOk
    case 'connecting':
    case 'reconnecting':
      return styles.statusDotWarn
    case 'failed':
      return styles.statusDotError
    default:
      return undefined
  }
}

/** Inline refresh glyph (an icon, not copy: the button owns its labels). */
function RefreshGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.4 2.1v2.7h-2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Badge state of one ref: describe answers authoritatively, absence ≠ unset. */
function badgeState(
  credentials: Readonly<Record<string, CredentialInfo>>,
  ref: string,
): 'configured' | 'unset' | 'unknown' {
  const view = credentials[ref]
  if (view === undefined) return 'unknown' // describe pending/failed/never ran
  return view.configured === true ? 'configured' : 'unset'
}

/** Per-ref badge entries shown on the card (label = env key or header name). */
function badgeRowsOf(server: ServerDef): { key: string; label: string; ref: string }[] {
  if (server.transport === 'stdio') {
    return (server.envKeys ?? []).map((ref) => ({ key: ref, label: ref, ref }))
  }
  return (server.headers ?? []).map((header) => ({
    key: `${header.name}::${header.ref}`,
    label: header.name,
    ref: header.ref,
  }))
}

export function ServerCard(props: ServerCardProps): JSX.Element | null {
  const { t, server, doc, credentials, writable, workspaces, workspaceStatus } = props
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [pendingWs, setPendingWs] = useState<string | undefined>(undefined)
  const [removing, setRemoving] = useState(false)
  const [clearingRef, setClearingRef] = useState<string | null>(null)
  const [pendingEnabled, setPendingEnabled] = useState(false)
  const [pendingAll, setPendingAll] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  /** Runtime action/test failure text (not a document save failure). */
  const [runtimeFailure, setRuntimeFailure] = useState<string | null>(null)
  const [pendingRuntime, setPendingRuntime] = useState<'connect' | 'disconnect' | 'test' | null>(null)
  /** Transient success note (Test OK · N tools). */
  const [runtimeNote, setRuntimeNote] = useState<string | null>(null)
  /** This card's own status refresh in flight (the store merges only this server). */
  const [refreshing, setRefreshing] = useState(false)
  /** Inline refresh failure: the message is diagnostic, the visible line is localized. */
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null)
  /**
   * Whether the workspace block shows ALL rows (the exception list is the
   * default view). Local UI state only — never a settings write.
   */
  const [wsExpanded, setWsExpanded] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsSyncedAt, setToolsSyncedAt] = useState<number | undefined>(undefined)
  const [toolsView, setToolsView] = useState<{
    tools: RuntimeToolEntry[]
    truncated: boolean
    total: number
  } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // The failure banner is transient (auto-retires) and has a dismiss button;
  // it never outlives the card.
  useEffect(() => {
    if (failure === null) return
    const timer = window.setTimeout(() => setFailure(null), 8000)
    return () => window.clearTimeout(timer)
  }, [failure])
  useEffect(() => {
    if (runtimeFailure === null) return
    const timer = window.setTimeout(() => setRuntimeFailure(null), 8000)
    return () => window.clearTimeout(timer)
  }, [runtimeFailure])
  useEffect(() => {
    if (refreshFailure === null) return
    const timer = window.setTimeout(() => setRefreshFailure(null), 8000)
    return () => window.clearTimeout(timer)
  }, [refreshFailure])

  useEffect(() => {
    if (runtimeNote === null) return
    const timer = window.setTimeout(() => setRuntimeNote(null), 6000)
    return () => window.clearTimeout(timer)
  }, [runtimeNote])
  // Esc cancels the inline remove confirmation; focus returns to the Remove
  // button afterwards (the card stays mounted on cancel).
  const removeButtonRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!confirmingRemove) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFailure(null)
        setConfirmingRemove(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmingRemove])
  // The Remove button is not mounted while the confirmation is open, so focus
  // is restored after the re-render that closes it (not inside the key handler).
  const wasConfirmingRemove = useRef(false)
  useEffect(() => {
    if (wasConfirmingRemove.current && !confirmingRemove) removeButtonRef.current?.focus()
    wasConfirmingRemove.current = confirmingRemove
  }, [confirmingRemove])

  const refs = credentialRefsOf(server)
  const rowsReady = workspaceStatus === 'ready'
  const globallyDisabled = isServerDisabled(doc, server.serverName)
  /** Explicitly-OFF (exception) rows: the only rows shown while collapsed. */
  const exceptions = rowsReady
    ? workspaces.filter((ws) => !isEnabled(doc.overrides, ws.workspaceId, server.serverName))
    : []
  const offCount = exceptions.length
  const busy =
    removing ||
    pendingWs !== undefined ||
    clearingRef !== null ||
    pendingEnabled ||
    pendingAll ||
    pendingRuntime !== null
  const disabled = !writable || busy || props.actionsDisabled === true
  /** Workspace rows and bulk switches are inert while the server is globally off. */
  const rowsDisabled = disabled || globallyDisabled
  const runtime = props.runtime
  const runtimeState: RuntimePhase = runtime?.state ?? 'unknown'
  const statusTone = statusToneOf(runtimeState)
  /**
   * The per-card refresh is a status READ (never a settings write), so it is
   * disabled only while this card has an action in flight or while a
   * (re)connect is already rolling — the retry line below is the live signal
   * then. A read-only document does not block a status read.
   */
  const refreshDisabled =
    busy || refreshing || runtimeState === 'connecting' || runtimeState === 'reconnecting'
  // A publish that replaces this server's view (a later poll, an action)
  // makes the inline refresh failure stale: drop it with the view it describes.
  useEffect(() => {
    setRefreshFailure(null)
  }, [runtime])

  const summaryBits: string[] = []
  if (server.transport === 'stdio' && (server.envKeys?.length ?? 0) > 0) {
    summaryBits.push(t(countKey('server.envKeys', server.envKeys!.length), { count: server.envKeys!.length }))
  } else if (server.transport === 'streamable-http' && (server.headers?.length ?? 0) > 0) {
    summaryBits.push(t(countKey('server.headers', server.headers!.length), { count: server.headers!.length }))
  }
  if (globallyDisabled) {
    summaryBits.push(t('server.disabledTag'))
  }
  if (rowsReady && offCount > 0) {
    summaryBits.push(t(countKey('server.offWorkspaces', offCount), { count: offCount }))
  }

  const transportLabel = server.transport === 'stdio' ? t('transport.stdio') : t('transport.http')
  const commandLine =
    server.transport === 'stdio'
      ? [server.command, ...(server.args ?? [])].join(' ')
      : ''

  async function handleToggle(workspaceId: string, checked: boolean): Promise<void> {
    setFailure(null)
    setPendingWs(workspaceId)
    let outcome: SaveOutcome
    try {
      outcome = await props.onToggle(workspaceId, server.serverName, !checked)
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    setPendingWs(undefined)
    if (!outcome.ok) setFailure(outcome)
  }

  async function handleSetEnabled(enabled: boolean): Promise<void> {
    setFailure(null)
    setPendingEnabled(true)
    let outcome: SaveOutcome
    try {
      outcome = await props.onSetEnabled(server.serverName, enabled)
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    setPendingEnabled(false)
    if (!outcome.ok) setFailure(outcome)
  }

  async function handleToggleAll(off: boolean): Promise<void> {
    setFailure(null)
    setPendingAll(true)
    let outcome: SaveOutcome
    try {
      outcome = await props.onToggleAll(
        server.serverName,
        off,
        workspaces.map((ws) => ws.workspaceId),
      )
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    setPendingAll(false)
    if (!outcome.ok) setFailure(outcome)
  }

  async function handleRuntime(action: 'connect' | 'disconnect'): Promise<void> {
    const handler = action === 'connect' ? props.onConnect : props.onDisconnect
    if (handler === undefined) return
    setRuntimeFailure(null)
    setPendingRuntime(action)
    try {
      await handler(server.serverName)
    } catch (error) {
      if (mounted.current) setRuntimeFailure(error instanceof Error ? error.message : t('runtime.error'))
    }
    if (mounted.current) setPendingRuntime(null)
  }

  async function handleTest(): Promise<void> {
    if (props.onTest === undefined) return
    setRuntimeFailure(null)
    setPendingRuntime('test')
    try {
      const result = await props.onTest(server.serverName)
      if (mounted.current && !result.ok) {
        setRuntimeFailure(
          runtimeErrorText(t, { code: result.code ?? '', message: result.error ?? t('runtime.error') }),
        )
      } else if (mounted.current) {
        setRuntimeNote(t('action.testOk', { count: result.toolCount ?? 0 }))
      }
    } catch (error) {
      if (mounted.current) setRuntimeFailure(error instanceof Error ? error.message : t('runtime.error'))
    }
    if (mounted.current) setPendingRuntime(null)
  }

  /** Refresh ONLY this card's runtime view; other servers stay untouched. */
  async function handleRefresh(): Promise<void> {
    if (props.onRefresh === undefined || refreshing) return
    setRefreshFailure(null)
    setRefreshing(true)
    try {
      await props.onRefresh(server.serverName)
    } catch (error) {
      if (mounted.current) setRefreshFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  async function handleToggleTools(): Promise<void> {
    if (props.onLoadTools === undefined || toolsLoading) return
    if (toolsOpen) {
      setToolsOpen(false)
      return
    }
    setToolsOpen(true)
    // A listing is valid for one sync generation: re-fetch whenever the
    // server resynced (syncedAt moved) instead of serving a stale table.
    if (toolsView !== null && toolsSyncedAt === runtime?.syncedAt) return
    setToolsLoading(true)
    try {
      const listed = await props.onLoadTools(server.serverName)
      if (mounted.current) {
        setToolsView(listed)
        setToolsSyncedAt(runtime?.syncedAt)
      }
    } catch (error) {
      if (mounted.current) setRuntimeFailure(error instanceof Error ? error.message : t('runtime.error'))
    } finally {
      if (mounted.current) setToolsLoading(false)
    }
  }

  async function handleRemove(): Promise<void> {
    setFailure(null)
    setRemoving(true)
    let outcome: SaveOutcome
    try {
      outcome = await props.onRemove(server.serverName)
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    if (outcome.ok) {
      // Success removes this card; the parent re-renders without it. No
      // further state writes here (FE-11).
      return
    }
    setRemoving(false)
    setConfirmingRemove(false)
    setFailure(outcome)
  }

  async function handleClear(ref: string): Promise<void> {
    if (clearingRef !== null) return // pending state already covers this
    setFailure(null)
    setClearingRef(ref)
    let outcome: SaveOutcome
    try {
      outcome = await props.onUnsetCredential(ref)
    } catch {
      outcome = { ok: false, reason: 'secret-write-failed', refs: [ref] }
    }
    if (!mounted.current) return
    setClearingRef(null)
    if (!outcome.ok) setFailure(outcome)
  }

  /** One workspace row (shared by the exception list and the expanded list). */
  function workspaceRow(ws: WorkspaceItem): JSX.Element {
    const off = !isEnabled(doc.overrides, ws.workspaceId, server.serverName)
    // ONE toggle per card at a time: the controller judges a save by comparing
    // the landed document against the expectation it built from the base it
    // read, so a second overlapping toggle would report a spurious 'conflict'
    // (or be fenced away) even though nothing is wrong. Every row is inert
    // while one toggle is in flight, not just the row that was clicked.
    const pending = pendingWs !== undefined
    const id = `mcp-scope-${server.serverName}-${ws.workspaceId}`
    return (
      <li key={ws.workspaceId} className={styles.wsRow}>
        <span className={styles.switchBox}>
          <input
            id={id}
            type="checkbox"
            role="switch"
            className={styles.switchInput}
            checked={!off}
            disabled={rowsDisabled || pending}
            onChange={(event) => void handleToggle(ws.workspaceId, event.target.checked)}
          />
          <span className={styles.switch} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
        </span>
        <label htmlFor={id} className={styles.wsLabel}>
          {ws.title}
        </label>
        <span className={styles.wsState}>{off ? t('row.off') : t('row.on')}</span>
      </li>
    )
  }

  return (
    <article className={cx(styles.card, globallyDisabled && styles.cardDisabled)} aria-busy={busy || refreshing}>
      <header className={styles.cardHead}>
        {writable && (
          <span className={styles.switchBox}>
            <input
              id={`mcp-scope-enable-${server.serverName}`}
              type="checkbox"
              role="switch"
              aria-label={`${t('server.enableToggle')}: ${server.serverName}`}
              className={styles.switchInput}
              checked={!globallyDisabled}
              disabled={busy || props.actionsDisabled === true}
              onChange={(event) => void handleSetEnabled(event.target.checked)}
            />
            <span className={styles.switch} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
          </span>
        )}
        <strong
          id={`mcp-scope-card-${server.serverName}`}
          className={cx(styles.cardName, styles.focusRing)}
          tabIndex={-1}
        >
          {server.serverName}
        </strong>
        <span className={styles.tag}>{transportLabel}</span>
        {summaryBits.length > 0 && <span className={styles.cardMeta}>{summaryBits.join(' · ')}</span>}
        {!confirmingRemove && (
          <div className={styles.cardActions}>
            {props.onRefresh !== undefined && (
              <button
                type="button"
                className={cx(
                  styles.iconButton,
                  styles.cardRefresh,
                  refreshing && styles.cardRefreshBusy,
                )}
                aria-label={`${t('runtime.refresh')}: ${server.serverName}`}
                title={t('runtime.refresh')}
                aria-busy={refreshing}
                disabled={refreshDisabled}
                onClick={() => void handleRefresh()}
              >
                <RefreshGlyph />
              </button>
            )}
            {writable && (
              <>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  onClick={props.onEdit}
                  disabled={disabled}
                >
                  {t('server.edit')}
                </button>
                <button
                  ref={removeButtonRef}
                  type="button"
                  className={cx(styles.button, styles.buttonDanger, styles.buttonOutline)}
                  onClick={() => setConfirmingRemove(true)}
                  disabled={disabled}
                >
                  {t('server.remove')}
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <div className={styles.statusRow}>
        <span
          className={statusTone !== undefined ? cx(styles.statusDot, statusTone) : styles.statusDot}
          aria-hidden="true"
        />
        <span className={styles.statusText}>{t(statusKeyOf(runtimeState))}</span>
        {runtime?.state === 'connected' && runtime.toolCount > 0 && (
          <span className={styles.statusText}>{t('status.tools', { count: runtime.toolCount })}</span>
        )}
        {/* A start that keeps failing reports the attempt count, and during a
            bounded attempt the phase is 'connecting' (the host arms
            'reconnecting' only while the backoff timer waits), so the counter
            follows the retry phases rather than the backoff phase alone. It
            stays off a given-up card: the host counts the failing attempt, so
            the counter would read "attempt max+1/max" while the give-up copy
            line already carries the exhausted budget. */}
        {runtime !== undefined &&
          runtime.attempts > 0 &&
          (runtimeState === 'connecting' || runtimeState === 'reconnecting') && (
          <span className={styles.statusText}>
            {t('status.retry', { attempt: runtime.attempts, max: runtime.maxAttempts })}
          </span>
        )}
        <span className={styles.spacer} />
        {runtime !== undefined &&
          !globallyDisabled &&
          props.onConnect !== undefined &&
          props.onDisconnect !== undefined && (
            runtimeState === 'connected' || runtimeState === 'connecting' || runtimeState === 'reconnecting' ? (
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled || pendingRuntime !== null}
                onClick={() => void handleRuntime('disconnect')}
              >
                {pendingRuntime === 'disconnect' ? t('action.disconnecting') : t('action.disconnect')}
              </button>
            ) : (
              // A failed server's Connect IS its retry: rendered as the primary
              // (accent) action so the recovery path is unmistakable.
              <button
                type="button"
                className={
                  runtimeState === 'failed'
                    ? cx(styles.button, styles.buttonPrimary)
                    : cx(styles.button, styles.buttonOutline)
                }
                disabled={disabled || pendingRuntime !== null}
                onClick={() => void handleRuntime('connect')}
              >
                {pendingRuntime === 'connect' ? t('action.connecting') : t('action.connect')}
              </button>
            )
          )}
        {props.onTest !== undefined && runtime !== undefined && !globallyDisabled && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={disabled || pendingRuntime !== null}
            onClick={() => void handleTest()}
          >
            {pendingRuntime === 'test' ? t('action.testing') : t('action.test')}
          </button>
        )}
        {props.onLoadTools !== undefined && runtime !== undefined && runtime.toolCount > 0 && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={toolsLoading}
            onClick={() => void handleToggleTools()}
          >
            {toolsLoading ? t('tools.loading') : `${t('tools.title')} (${runtime.toolCount})`}
          </button>
        )}
      </div>

      {runtime?.error !== undefined && (
        <p className={styles.statusErrorText}>{runtimeErrorText(t, runtime.error)}</p>
      )}

      {/* The refresh failure line: localized copy, host detail in `title` only. */}
      {refreshFailure !== null && (
        <p className={styles.statusErrorText} title={refreshFailure}>
          {t('runtime.error')}
        </p>
      )}

      {runtime === undefined && (props.runtimePhase === 'unavailable' || props.runtimePhase === 'error') && (
        <p className={styles.hint}>
          {props.runtimePhase === 'error' ? t('runtime.error') : t('runtime.unavailable')}
        </p>
      )}

      {runtimeNote !== null && (
        <p role="status" className={styles.statusText}>
          {runtimeNote}
        </p>
      )}

      {runtimeFailure !== null && (
        <div role="alert" className={styles.noticeError}>
          <span className={styles.noticeText}>{runtimeFailure}</span>
          <button
            type="button"
            aria-label={t('action.dismiss')}
            className={styles.iconButton}
            onClick={() => setRuntimeFailure(null)}
          >
            ×
          </button>
        </div>
      )}

      {toolsOpen && (
        <div>
          {toolsView === null ? (
            <p className={styles.hint}>{t('tools.loading')}</p>
          ) : toolsView.tools.length === 0 ? (
            <p className={styles.hint}>{t('tools.empty')}</p>
          ) : (
            <>
              <ul className={styles.toolList}>
                {toolsView.tools.map((tool) => (
                  <li key={tool.publicName} className={styles.toolItem} title={tool.description}>
                    <span className={styles.toolName}>{tool.rawName}</span>
                    {tool.description !== '' ? ` — ${tool.description}` : ''}
                  </li>
                ))}
              </ul>
              {toolsView.truncated && (
                <p className={styles.hint}>
                  {t('tools.truncated', { count: toolsView.tools.length, total: toolsView.total })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {failure !== null && (
        <div role="alert" className={styles.noticeError}>
          <span className={styles.noticeText}>{failureText(t, failure)}</span>
          <button
            type="button"
            aria-label={t('action.dismiss')}
            className={styles.iconButton}
            onClick={() => setFailure(null)}
          >
            ×
          </button>
        </div>
      )}

      {confirmingRemove && (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            <strong>{t('server.removeConfirmTitle')}</strong> {t('server.removeConfirmBody')}
          </p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonDanger)}
              onClick={() => void handleRemove()}
              disabled={disabled}
            >
              {removing ? t('state.saving') : t('action.confirm')}
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => {
                setFailure(null)
                setConfirmingRemove(false)
                removeButtonRef.current?.focus()
              }}
              disabled={removing}
            >
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Definition details (UX-04): what the server actually runs / points at. */}
      {commandLine !== '' && (
        <code className={styles.code} title={commandLine}>
          {commandLine}
        </code>
      )}
      {server.transport === 'streamable-http' && (
        <code className={styles.code} title={server.url}>
          {server.url}
        </code>
      )}
      {server.transport === 'stdio' && server.cwd !== undefined && server.cwd !== '' && (
        <p className={styles.hint}>{t('server.cwd', { path: server.cwd })}</p>
      )}

      {refs.length > 0 && (
        <ul className={styles.badges}>
          {badgeRowsOf(server).map((row) => {
            const state = badgeState(credentials, row.ref)
            const view = credentials[row.ref]
            const clearable = writable && state === 'configured' && view?.writable !== false
            const clearPending = clearingRef === row.ref
            return (
              <li
                key={row.key}
                className={cx(
                  styles.badge,
                  state === 'configured' ? styles.badgeOk : state === 'unset' ? styles.badgeWarn : undefined,
                )}
              >
                {/* `title` is the fallback for the text the pill truncates
                    when a long header name or ref has to fit the card. */}
                <code className={styles.badgeKey} title={row.label}>
                  {row.label}
                </code>
                {row.ref !== row.label && (
                  <code className={styles.badgeRef} title={row.ref}>
                    {row.ref}
                  </code>
                )}
                <span>
                  {state === 'configured'
                    ? t('secret.configured')
                    : state === 'unset'
                      ? t('secret.unset')
                      : t('secret.unknown')}
                </span>
                {clearable && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    title={t('secret.clearHint')}
                    disabled={disabled}
                    onClick={() => void handleClear(row.ref)}
                  >
                    {clearPending ? t('secret.clearing') : t('secret.clear')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className={styles.wsBlock}>
        {workspaceStatus === 'loading' && <p className={styles.hint}>{t('workspaces.loading')}</p>}
        {workspaceStatus === 'error' && <p className={styles.hint}>{t('workspaces.error')}</p>}
        {rowsReady && workspaces.length === 0 && <p className={styles.hint}>{t('workspaces.empty')}</p>}
        {/* Collapsed default: the exception rows only — or ONE summary line
            when every workspace is on (the common case). */}
        {rowsReady && workspaces.length > 0 && !wsExpanded && (
          exceptions.length > 0 ? (
            <ul id={`mcp-scope-ws-rows-${server.serverName}`} className={styles.wsList}>
              {exceptions.map(workspaceRow)}
            </ul>
          ) : (
            <p className={styles.hint}>
              {t(countKey('row.allOnDefault', workspaces.length), { count: workspaces.length })}
            </p>
          )
        )}
        {/* Local UI state only (never a settings write): the toggle reveals
            every row and the bulk switches. */}
        {/* A single workspace needs this too: in the collapsed view its only row
            is hidden and no checkbox would be reachable, so the server could not
            be turned off for it at all. */}
        {rowsReady && workspaces.length > 0 && (
          <div className={styles.row}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              aria-expanded={wsExpanded}
              aria-controls={`mcp-scope-ws-rows-${server.serverName}`}
              onClick={() => setWsExpanded((open) => !open)}
            >
              {wsExpanded ? t('row.manageHide') : t('row.manage', { count: offCount })}
            </button>
          </div>
        )}
        {rowsReady && wsExpanded && (
          <>
            <ul id={`mcp-scope-ws-rows-${server.serverName}`} className={styles.wsList}>
              {workspaces.map(workspaceRow)}
            </ul>
            {/* Bulk switches only make sense with an actual choice. */}
            {workspaces.length > 1 && (
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={rowsDisabled}
                onClick={() => void handleToggleAll(false)}
              >
                {t('row.allOn')}
              </button>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={rowsDisabled}
                onClick={() => void handleToggleAll(true)}
              >
                {t('row.allOff')}
              </button>
            </div>
            )}
            <p className={styles.hint}>{t('server.defaultOn')}</p>
          </>
        )}
      </div>
    </article>
  )
}