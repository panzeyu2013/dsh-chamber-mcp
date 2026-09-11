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
 * settings-panel card vocabulary (0.5px hairline + r16 + layer-3 fill), the
 * transport tag is the Tag pill, the credential tones reuse the Tag palette,
 * the rows' control is the Switch primitive's geometry over this plugin's own
 * controlled checkbox, and every action is a `size="sm"` capsule button.
 */

import { useEffect, useRef, useState } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { isEnabled, credentialRefsOf, type McpScopeDoc, type ServerDef } from '../shared/model.js'
import { failureText, type SaveFailure, type SaveOutcome } from './controller.js'
import { countKey } from './locales.js'
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
  onEdit(): void
  onRemove(name: string): Promise<SaveOutcome>
  onToggle(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome>
  onUnsetCredential(ref: string): Promise<SaveOutcome>
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
  const [failure, setFailure] = useState<SaveFailure | null>(null)
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
  // Esc cancels the inline remove confirmation; focus returns to the Remove
  // button afterwards (the card stays mounted on cancel).
  const removeButtonRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!confirmingRemove) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFailure(null)
        setConfirmingRemove(false)
        removeButtonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmingRemove])

  const refs = credentialRefsOf(server)
  const rowsReady = workspaceStatus === 'ready'
  const offCount = rowsReady
    ? workspaces.filter((ws) => !isEnabled(doc.overrides, ws.workspaceId, server.serverName)).length
    : 0
  const busy = removing || pendingWs !== undefined || clearingRef !== null
  const disabled = !writable || busy || props.actionsDisabled === true

  const summaryBits: string[] = []
  if (server.transport === 'stdio' && (server.envKeys?.length ?? 0) > 0) {
    summaryBits.push(t(countKey('server.envKeys', server.envKeys!.length), { count: server.envKeys!.length }))
  } else if (server.transport === 'streamable-http' && (server.headers?.length ?? 0) > 0) {
    summaryBits.push(t(countKey('server.headers', server.headers!.length), { count: server.headers!.length }))
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

  return (
    <article className={styles.card} aria-busy={busy}>
      <header className={styles.cardHead}>
        <strong
          id={`mcp-scope-card-${server.serverName}`}
          className={cx(styles.cardName, styles.focusRing)}
          tabIndex={-1}
        >
          {server.serverName}
        </strong>
        <span className={styles.tag}>{transportLabel}</span>
        {summaryBits.length > 0 && <span className={styles.cardMeta}>{summaryBits.join(' · ')}</span>}
        {writable && !confirmingRemove && (
          <div className={styles.cardActions}>
            <button
              ref={removeButtonRef}
              type="button"
              className={cx(styles.button, styles.buttonDanger)}
              onClick={() => setConfirmingRemove(true)}
              disabled={disabled}
            >
              {t('server.remove')}
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={props.onEdit}
              disabled={disabled}
            >
              {t('server.edit')}
            </button>
          </div>
        )}
      </header>

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
        <p className={styles.hint}>{t('server.defaultOn')}</p>
        {workspaceStatus === 'loading' && <p className={styles.hint}>{t('workspaces.loading')}</p>}
        {workspaceStatus === 'error' && <p className={styles.hint}>{t('workspaces.error')}</p>}
        {rowsReady && workspaces.length === 0 && <p className={styles.hint}>{t('workspaces.empty')}</p>}
        {rowsReady && workspaces.length > 0 && (
          <ul className={styles.wsList}>
            {workspaces.map((ws) => {
              const off = !isEnabled(doc.overrides, ws.workspaceId, server.serverName)
              const pending = pendingWs === ws.workspaceId
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
                      disabled={disabled || pending}
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
            })}
          </ul>
        )}
        {rowsReady && workspaces.length > 0 && (
          <p className={styles.hint}>{t('server.newWorkspaceDefault')}</p>
        )}
      </div>
    </article>
  )
}
