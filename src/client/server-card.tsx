/**
 * One MCP server card: transport/summary header, credential badges, and the
 * per-workspace on/off rows (presence in `overrides[w][name]` = explicitly
 * OFF; absence = on by default).
 */

import { useState } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { isEnabled, credentialRefsOf, type McpScopeDoc, type ServerDef } from '../shared/model.js'
import type { SaveOutcome } from './controller.js'
import type { SectionT } from './section.js'
import type { WorkspaceItem } from './workspaces.js'

export interface ServerCardProps {
  t: SectionT
  server: ServerDef
  doc: McpScopeDoc
  /** Configured/writable views per credential ref (host describe). */
  credentials: Readonly<Record<string, CredentialInfo>>
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Real workspaces (empty items => nothing to toggle). */
  workspaces: readonly WorkspaceItem[]
  onRemove(name: string): Promise<SaveOutcome>
  onToggle(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome>
  onUnsetCredential(ref: string): Promise<SaveOutcome>
}

export function ServerCard(props: ServerCardProps): JSX.Element | null {
  const { t, server, doc, credentials, writable, workspaces } = props
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [pendingWs, setPendingWs] = useState<string | undefined>(undefined)
  const [removing, setRemoving] = useState(false)

  const refs = credentialRefsOf(server)
  const offCount = workspaces.filter((ws) => !isEnabled(doc.overrides, ws.workspaceId, server.serverName)).length
  const disabled = !writable || removing || pendingWs !== undefined

  const summaryBits: string[] = []
  if (server.transport === 'stdio' && (server.envKeys?.length ?? 0) > 0) {
    summaryBits.push(t('server.envKeys', { count: server.envKeys!.length }))
  } else if (server.transport === 'streamable-http' && (server.headers?.length ?? 0) > 0) {
    summaryBits.push(t('server.headers', { count: server.headers!.length }))
  }
  if (offCount > 0) summaryBits.push(t('server.offWorkspaces', { count: offCount }))

  const transportLabel = server.transport === 'stdio' ? t('transport.stdio') : t('transport.http')

  async function handleToggle(workspaceId: string, checked: boolean): Promise<void> {
    setPendingWs(workspaceId)
    try {
      await props.onToggle(workspaceId, server.serverName, !checked)
    } finally {
      setPendingWs(undefined)
    }
  }

  async function handleRemove(): Promise<void> {
    setRemoving(true)
    try {
      const outcome = await props.onRemove(server.serverName)
      if (!outcome.ok) setConfirmingRemove(false)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <article style={{ border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{server.serverName}</strong>
        <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 10, border: '1px solid rgba(127,127,127,0.45)', color: 'var(--text-2, #555)' }}>
          {transportLabel}
        </span>
        {summaryBits.length > 0 && <span style={{ fontSize: 12, opacity: 0.8 }}>{summaryBits.join(' · ')}</span>}
        <span style={{ flex: 1 }} />
        {writable && !confirmingRemove && (
          <button type="button" onClick={() => setConfirmingRemove(true)} disabled={disabled}>
            {t('server.remove')}
          </button>
        )}
      </header>

      {confirmingRemove && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(127,127,127,0.08)' }}>
          <p style={{ margin: 0 }}>
            <strong>{t('server.removeConfirmTitle')}</strong> {t('server.removeConfirmBody')}
          </p>
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => void handleRemove()} disabled={disabled}>
              {t('action.confirm')}
            </button>
            <button type="button" onClick={() => setConfirmingRemove(false)} disabled={removing}>
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}

      {refs.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {refs.map((ref) => {
            const view = credentials[ref]
            const configured = view?.configured === true
            const clearable = writable && view?.writable !== false && configured
            return (
              <li key={ref} style={{ fontSize: 12, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <code>{ref}</code>
                <span style={{ opacity: 0.85 }}>{configured ? t('secret.configured') : t('secret.unset')}</span>
                {clearable && (
                  <button
                    type="button"
                    style={{ fontSize: 12, padding: '0 4px' }}
                    title={t('secret.clearHint')}
                    disabled={disabled}
                    onClick={() => void props.onUnsetCredential(ref)}
                  >
                    {t('secret.clear')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div style={{ marginTop: 8 }}>
        <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.75 }}>{t('server.defaultOn')}</p>
        {workspaces.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>{t('workspaces.empty')}</p>
        ) : (
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
        {workspaces.length > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.6 }}>{t('server.newWorkspaceDefault')}</p>
        )}
      </div>
    </article>
  )
}
