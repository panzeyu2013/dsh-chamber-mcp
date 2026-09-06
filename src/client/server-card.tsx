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
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { isEnabled, credentialRefsOf, type McpScopeDoc, type ServerDef } from '../shared/model.js'
import { failureText, type SaveFailure, type SaveOutcome } from './controller.js'
import { countKey } from './locales.js'
import type { SectionT } from './section.js'
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

const alertStyle: CSSProperties = {
  margin: '0 0 8px',
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(192,57,43,0.1)',
  border: '1px solid rgba(192,57,43,0.4)',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
}

const codeLineStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginTop: 6,
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
    <article
      style={{ border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}
      aria-busy={busy}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong id={`mcp-scope-card-${server.serverName}`} tabIndex={-1}>
          {server.serverName}
        </strong>
        <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 10, border: '1px solid rgba(127,127,127,0.45)', color: 'var(--text-2, #555)' }}>
          {transportLabel}
        </span>
        {summaryBits.length > 0 && <span style={{ fontSize: 12, opacity: 0.8 }}>{summaryBits.join(' · ')}</span>}
        <span style={{ flex: 1 }} />
        {writable && !confirmingRemove && (
          <>
            <button
              ref={removeButtonRef}
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={disabled}
              style={{ marginRight: 0 }}
            >
              {t('server.remove')}
            </button>
            <button type="button" onClick={props.onEdit} disabled={disabled}>
              {t('server.edit')}
            </button>
          </>
        )}
      </header>

      {failure !== null && (
        <div role="alert" style={alertStyle}>
          <span style={{ flex: 1 }}>{failureText(t, failure)}</span>
          <button
            type="button"
            aria-label={t('action.dismiss')}
            onClick={() => setFailure(null)}
            style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {confirmingRemove && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(127,127,127,0.08)' }}>
          <p style={{ margin: 0 }}>
            <strong>{t('server.removeConfirmTitle')}</strong> {t('server.removeConfirmBody')}
          </p>
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => void handleRemove()} disabled={disabled}>
              {removing ? t('state.saving') : t('action.confirm')}
            </button>
            <button
              type="button"
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
        <code style={codeLineStyle} title={commandLine}>
          {commandLine}
        </code>
      )}
      {server.transport === 'streamable-http' && (
        <code style={codeLineStyle} title={server.url}>
          {server.url}
        </code>
      )}
      {server.transport === 'stdio' && server.cwd !== undefined && server.cwd !== '' && (
        <p style={{ margin: '2px 0 0', fontSize: 12, opacity: 0.7 }}>
          {t('server.cwd', { path: server.cwd })}
        </p>
      )}

      {refs.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {badgeRowsOf(server).map((row) => {
            const state = badgeState(credentials, row.ref)
            const view = credentials[row.ref]
            const clearable = writable && state === 'configured' && view?.writable !== false
            const clearPending = clearingRef === row.ref
            return (
              <li key={row.key} style={{ fontSize: 12, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <code>{row.label}</code>
                {row.ref !== row.label && (
                  <code style={{ opacity: 0.6, fontSize: 11 }}>{row.ref}</code>
                )}
                <span style={{ opacity: 0.85 }}>
                  {state === 'configured'
                    ? t('secret.configured')
                    : state === 'unset'
                      ? t('secret.unset')
                      : t('secret.unknown')}
                </span>
                {clearable && (
                  <button
                    type="button"
                    style={{ fontSize: 12, padding: '0 4px' }}
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

      <div style={{ marginTop: 8 }}>
        <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.75 }}>{t('server.defaultOn')}</p>
        {workspaceStatus === 'loading' && (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>{t('workspaces.loading')}</p>
        )}
        {workspaceStatus === 'error' && (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>{t('workspaces.error')}</p>
        )}
        {rowsReady && workspaces.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>{t('workspaces.empty')}</p>
        )}
        {rowsReady && workspaces.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {workspaces.map((ws) => {
              const off = !isEnabled(doc.overrides, ws.workspaceId, server.serverName)
              const pending = pendingWs === ws.workspaceId
              return (
                <li key={ws.workspaceId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0' }}>
                  <input
                    id={`mcp-scope-${server.serverName}-${ws.workspaceId}`}
                    type="checkbox"
                    role="switch"
                    checked={!off}
                    disabled={disabled || pending}
                    onChange={(event) => void handleToggle(ws.workspaceId, event.target.checked)}
                  />
                  <label htmlFor={`mcp-scope-${server.serverName}-${ws.workspaceId}`} style={{ flex: 1, fontSize: 13 }}>
                    {ws.title}
                  </label>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{off ? t('row.off') : t('row.on')}</span>
                </li>
              )
            })}
          </ul>
        )}
        {rowsReady && workspaces.length > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.6 }}>{t('server.newWorkspaceDefault')}</p>
        )}
      </div>
    </article>
  )
}
