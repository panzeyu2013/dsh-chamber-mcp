/**
 * The staged Add-server form (hand-written controls, official card-form
 * style; no generic schema-form). Secrets are staged as write-only literals
 * and reach the credentials domain on Save only — they never enter the
 * settings document and never ride a response.
 */

import { useState } from 'react'
import {
  CREDENTIAL_REF_PATTERN,
  SERVER_NAME_PATTERN,
  type ServerDef,
} from '../shared/model.js'
import type { SettingsKey } from './locales.js'
import type { SaveOutcome, SecretWrite } from './controller.js'
import type { SectionT } from './section.js'

/** All staged input of one add flow. */
export interface AddDraft {
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string
  cwd: string
  args: string[]
  env: { key: string; value: string }[]
  url: string
  headers: { name: string; ref: string; value: string }[]
}

export const EMPTY_DRAFT: AddDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  cwd: '',
  args: [''],
  env: [{ key: '', value: '' }],
  url: '',
  headers: [{ name: '', ref: '', value: '' }],
}

export interface AddProblems {
  /** Server-name field problem (pattern / duplicate). */
  name?: 'pattern' | 'duplicate'
  command?: 'required'
  url?: 'required' | 'invalid'
  /** Per-row problem key (locales.validation.*), undefined = row fine. */
  env: (SettingsKey | undefined)[]
  headers: (SettingsKey | undefined)[]
}

function looksLikeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Pure staged-draft validation; UI renders problems only after first Save. */
export function evaluateDraft(draft: AddDraft, existingNames: readonly string[]): AddProblems {
  const problems: AddProblems = { env: [], headers: [] }
  const name = draft.name.trim()
  if (name === '' || !SERVER_NAME_PATTERN.test(name)) {
    problems.name = 'pattern'
  } else if (existingNames.includes(name)) {
    problems.name = 'duplicate'
  }

  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') problems.command = 'required'
    const seenKeys = new Set<string>()
    for (const row of draft.env) {
      const key = row.key.trim()
      const hasValue = row.value !== ''
      if (key === '' && !hasValue) {
        problems.env.push(undefined)
        continue
      }
      if (!CREDENTIAL_REF_PATTERN.test(key)) {
        problems.env.push('validation.refPattern' as const)
      } else if (seenKeys.has(key)) {
        problems.env.push('validation.envKeyDuplicate' as const)
      } else {
        problems.env.push(undefined)
      }
      if (key !== '') seenKeys.add(key)
    }
  } else {
    const url = draft.url.trim()
    if (url === '') {
      problems.url = 'required'
    } else if (!looksLikeHttpUrl(url)) {
      problems.url = 'invalid'
    }
    const seenNames = new Set<string>()
    for (const row of draft.headers) {
      const name = row.name.trim()
      const ref = row.ref.trim()
      const hasValue = row.value !== ''
      if (name === '' && ref === '' && !hasValue) {
        problems.headers.push(undefined)
        continue
      }
      let problem: SettingsKey | undefined
      if (name === '') {
        problem = 'validation.headerNameEmpty' as const
      } else if (seenNames.has(name)) {
        problem = 'validation.headerNameDuplicate' as const
      } else if (!CREDENTIAL_REF_PATTERN.test(ref)) {
        problem = 'validation.refPattern' as const
      }
      problems.headers.push(problem)
      if (name !== '') seenNames.add(name)
    }
  }
  return problems
}

/** Any row problem present? (save disabled while true) */
export function hasProblems(problems: AddProblems): boolean {
  return (
    problems.name !== undefined ||
    problems.command !== undefined ||
    problems.url !== undefined ||
    problems.env.some((p) => p !== undefined) ||
    problems.headers.some((p) => p !== undefined)
  )
}

/**
 * Materialize the staged draft into its wire shapes: the ServerDef plus the
 * secrets staged this run (non-empty literals). Callers must have checked
 * {@link hasProblems} first.
 */
export function draftToServer(draft: AddDraft): { server: ServerDef; secrets: SecretWrite[] } {
  const name = draft.name.trim()
  const secrets: SecretWrite[] = []
  if (draft.transport === 'stdio') {
    const envKeys: string[] = []
    for (const row of draft.env) {
      const key = row.key.trim()
      if (key === '') continue
      envKeys.push(key)
      if (row.value !== '') secrets.push({ ref: key, value: row.value })
    }
    const args = draft.args.map((arg) => arg.trim()).filter((arg) => arg !== '')
    const cwd = draft.cwd.trim()
    const server: ServerDef = {
      serverName: name,
      transport: 'stdio',
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(cwd !== '' ? { cwd } : {}),
      ...(envKeys.length > 0 ? { envKeys } : {}),
    }
    return { server, secrets }
  }
  const headers: { name: string; ref: string }[] = []
  for (const row of draft.headers) {
    const headerName = row.name.trim()
    const ref = row.ref.trim()
    if (headerName === '' && ref === '') continue
    headers.push({ name: headerName, ref })
    if (row.value !== '') secrets.push({ ref, value: row.value })
  }
  return {
    server: { serverName: name, transport: 'streamable-http', url: draft.url.trim(), headers },
    secrets,
  }
}

export interface AddServerFormProps {
  t: SectionT
  /** serverNames already present in the document (duplicate check). */
  existingNames: readonly string[]
  writable: boolean
  onAdd(input: { server: ServerDef; secrets: readonly SecretWrite[] }): Promise<SaveOutcome>
  onClose(): void
}

/** Plain labelled text input row with optional inline problem text. */
function Field(props: {
  label: string
  id: string
  value: string
  disabled: boolean
  hint?: string
  problem?: string
  type?: 'text' | 'password'
  placeholder?: string
  onChange(value: string): void
}): JSX.Element {
  return (
    <div style={{ marginBottom: 6 }}>
      <label htmlFor={props.id} style={{ display: 'block', fontSize: 13, marginBottom: 2 }}>
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      {props.hint !== undefined && (
        <span style={{ fontSize: 12, opacity: 0.7 }}>{props.hint}</span>
      )}
      {props.problem !== undefined && (
        <span style={{ fontSize: 12, color: '#c0392b', display: 'block' }}>{props.problem}</span>
      )}
    </div>
  )
}

export function AddServerForm(props: AddServerFormProps): JSX.Element {
  const { t, writable } = props
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const disabled = !writable || saving

  const problems = evaluateDraft(draft, props.existingNames)
  const invalid = hasProblems(problems)

  function patch(patch: Partial<AddDraft>): void {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  function patchEnv(index: number, patch: { key?: string; value?: string }): void {
    setDraft((prev) => ({
      ...prev,
      env: prev.env.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))
  }

  function patchHeader(index: number, patch: { name?: string; ref?: string; value?: string }): void {
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))
  }

  async function handleSave(): Promise<void> {
    setAttempted(true)
    if (invalid) return
    setSaving(true)
    try {
      const outcome = await props.onAdd(draftToServer(draft))
      if (outcome.ok) {
        props.onClose()
      } else {
        setSaving(false)
      }
    } finally {
      setSaving(false)
    }
  }

  const nameProblem = attempted ? problems.name : undefined
  const showCommand = attempted && draft.transport === 'stdio' ? problems.command : undefined
  const showUrl = attempted && draft.transport === 'streamable-http' ? problems.url : undefined
  const envProblems = attempted ? problems.env : problems.env.map(() => undefined)
  const headerProblems = attempted ? problems.headers : problems.headers.map(() => undefined)

  return (
    <section aria-label={t('add.title')} style={{ border: '1px dashed rgba(127,127,127,0.5)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{t('add.title')}</h3>

      <Field
        id="mcp-scope-add-name"
        label={t('add.serverName')}
        value={draft.name}
        disabled={disabled}
        hint={t('add.toolPrefixHint', { name: draft.name.trim() || '…' })}
        problem={nameProblem !== undefined ? t(nameProblem === 'pattern' ? 'validation.namePattern' : 'validation.duplicateName') : undefined}
        onChange={(name) => patch({ name })}
      />

      <div style={{ marginBottom: 6 }}>
        <span style={{ display: 'block', fontSize: 13, marginBottom: 2 }}>{t('add.transport')}</span>
        <label style={{ marginRight: 12, fontSize: 13 }}>
          <input
            type="radio"
            name="mcp-scope-transport"
            checked={draft.transport === 'stdio'}
            disabled={disabled}
            onChange={() => patch({ transport: 'stdio' })}
          />{' '}
          {t('transport.stdio')}
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name="mcp-scope-transport"
            checked={draft.transport === 'streamable-http'}
            disabled={disabled}
            onChange={() => patch({ transport: 'streamable-http' })}
          />{' '}
          {t('transport.http')}
        </label>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <Field
            id="mcp-scope-add-command"
            label={t('add.command')}
            value={draft.command}
            disabled={disabled}
            hint={t('add.commandUserHint')}
            problem={showCommand !== undefined ? t('validation.commandRequired') : undefined}
            onChange={(command) => patch({ command })}
          />

          <div style={{ marginBottom: 6 }}>
            <span style={{ display: 'block', fontSize: 13, marginBottom: 2 }}>{t('add.args')}</span>
            {draft.args.map((arg, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input
                  aria-label={`${t('add.args')} ${index + 1}`}
                  type="text"
                  value={arg}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({ args: draft.args.map((a, i) => (i === index ? event.target.value : a)) })
                  }
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  disabled={disabled || draft.args.length <= 1}
                  onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                >
                  {t('server.remove')}
                </button>
              </div>
            ))}
            <button type="button" disabled={disabled} onClick={() => patch({ args: [...draft.args, ''] })}>
              {t('add.argAdd')}
            </button>
          </div>

          <Field
            id="mcp-scope-add-cwd"
            label={t('add.cwd')}
            value={draft.cwd}
            disabled={disabled}
            onChange={(cwd) => patch({ cwd })}
          />

          <div style={{ marginBottom: 6 }}>
            <span style={{ display: 'block', fontSize: 13, marginBottom: 2 }}>{t('add.envKey')}</span>
            <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.7 }}>{t('add.envSectionHint')}</p>
            {draft.env.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <input
                  aria-label={`${t('add.envKey')} ${index + 1}`}
                  type="text"
                  value={row.key}
                  disabled={disabled}
                  onChange={(event) => patchEnv(index, { key: event.target.value })}
                  style={{ flex: 1 }}
                />
                <input
                  aria-label={`${t('add.secretValueLabel')} ${index + 1}`}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  disabled={disabled}
                  placeholder={t('add.secretPlaceholder')}
                  onChange={(event) => patchEnv(index, { value: event.target.value })}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  disabled={disabled || draft.env.length <= 1}
                  onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                >
                  {t('server.remove')}
                </button>
              </div>
            ))}
            <button type="button" disabled={disabled} onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}>
              {t('add.argAdd')}
            </button>
            {envProblems.some((p) => p !== undefined) && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: '#c0392b' }}>
                {envProblems.map((problem, index) =>
                  problem !== undefined ? (
                    <li key={index}>{t(problem)}</li>
                  ) : null,
                )}
              </ul>
            )}
          </div>
        </>
      ) : (
        <>
          <Field
            id="mcp-scope-add-url"
            label={t('add.url')}
            value={draft.url}
            disabled={disabled}
            problem={
              showUrl !== undefined
                ? showUrl === 'required'
                  ? t('validation.urlRequired')
                  : t('validation.invalidUrl')
                : undefined
            }
            onChange={(url) => patch({ url })}
          />

          <div style={{ marginBottom: 6 }}>
            <span style={{ display: 'block', fontSize: 13, marginBottom: 2 }}>{t('add.headerName')}</span>
            <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.7 }}>{t('add.headerSectionHint')}</p>
            {draft.headers.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <input
                  aria-label={`${t('add.headerName')} ${index + 1}`}
                  type="text"
                  value={row.name}
                  disabled={disabled}
                  onChange={(event) => patchHeader(index, { name: event.target.value })}
                  style={{ flex: 1 }}
                  placeholder="Authorization"
                />
                <input
                  aria-label={`${t('add.credentialRef')} ${index + 1}`}
                  type="text"
                  value={row.ref}
                  disabled={disabled}
                  onChange={(event) => patchHeader(index, { ref: event.target.value })}
                  style={{ flex: 1 }}
                  placeholder="AUTH_TOKEN"
                />
                <input
                  aria-label={`${t('add.secretValueLabel')} ${index + 1}`}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  disabled={disabled}
                  placeholder={t('add.secretPlaceholder')}
                  onChange={(event) => patchHeader(index, { value: event.target.value })}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  disabled={disabled || draft.headers.length <= 1}
                  onClick={() => patch({ headers: draft.headers.filter((_, i) => i !== index) })}
                >
                  {t('server.remove')}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() => patch({ headers: [...draft.headers, { name: '', ref: '', value: '' }] })}
            >
              {t('add.argAdd')}
            </button>
            {headerProblems.some((p) => p !== undefined) && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: '#c0392b' }}>
                {headerProblems.map((problem, index) =>
                  problem !== undefined ? <li key={index}>{t(problem)}</li> : null,
                )}
              </ul>
            )}
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" disabled={disabled || invalid} onClick={() => void handleSave()}>
          {saving ? t('state.saving') : t('action.save')}
        </button>
        <button type="button" disabled={saving} onClick={props.onClose}>
          {t('action.cancel')}
        </button>
      </div>
    </section>
  )
}
