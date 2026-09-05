/**
 * The staged Add/Edit-server form (hand-written controls, official card-form
 * style; no generic schema-form). Secrets are staged as write-only literals
 * and reach the credentials domain on Save only — they never enter the
 * settings document and never ride a response. In edit mode the draft is
 * prefilled from the document and a blank secret value keeps the stored
 * credential (the semantics `add.headerSectionHint`/`add.envSectionHint`
 * promise).
 *
 * The whole surface is one real <form>: Enter submits, every non-submit
 * control is `type="button"`, and the server-name field autofocuses on open.
 * Outcome feedback is owned by the form (a localized role="alert" failure
 * banner); success closes through `onClose` and is announced by the section.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  RESERVED_OVERRIDE_KEYS,
  SERVER_NAME_PATTERN,
  type ServerDef,
} from '../shared/model.js'
import type { SettingsKey } from './locales.js'
import { failureText, type SaveFailure, type SaveOutcome, type ServerSaveInput } from './controller.js'
import type { SectionT } from './section.js'

/** All staged input of one add/edit flow. */
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

/**
 * Prefill a staged draft from an existing server definition (edit flow).
 * Secret values stay blank — a blank input keeps the stored value on save.
 */
export function draftFromServer(server: ServerDef): AddDraft {
  if (server.transport === 'stdio') {
    return {
      name: server.serverName,
      transport: 'stdio',
      command: server.command,
      cwd: server.cwd ?? '',
      args: (server.args ?? []).length > 0 ? [...server.args!] : [''],
      env: (server.envKeys ?? []).map((key) => ({ key, value: '' })),
      url: '',
      headers: [{ name: '', ref: '', value: '' }],
    }
  }
  return {
    name: server.serverName,
    transport: 'streamable-http',
    command: '',
    cwd: '',
    args: [''],
    url: server.url,
    env: [{ key: '', value: '' }],
    headers: (server.headers ?? []).map((header) => ({ name: header.name, ref: header.ref, value: '' })),
  }
}

export interface AddProblems {
  /** Server-name field problem (pattern / duplicate / reserved). */
  name?: 'pattern' | 'duplicate' | 'reserved'
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

/** Pure staged-draft validation. Problems with real content are revealed live
 * (an invalid draft always explains itself — the Save button is disabled while
 * invalid, so gating on a submit attempt would be a dead end). */
export function evaluateDraft(draft: AddDraft, existingNames: readonly string[]): AddProblems {
  const problems: AddProblems = { env: [], headers: [] }
  const name = draft.name.trim()
  if (name === '' || !SERVER_NAME_PATTERN.test(name)) {
    problems.name = 'pattern'
  } else if (RESERVED_OVERRIDE_KEYS.has(name)) {
    problems.name = 'reserved'
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
      } else if (!HEADER_NAME_PATTERN.test(name)) {
        problem = 'validation.headerNameToken' as const
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
 * secrets staged this run (non-empty literals). Blank secret values simply
 * keep whatever the credentials domain already holds for the ref. Callers
 * must have checked {@link hasProblems} first.
 */
export function draftToServer(draft: AddDraft): ServerSaveInput {
  const name = draft.name.trim()
  const secrets: SecretWriteLike[] = []
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

/** Structural twin of SecretWrite used by draftToServer's return typing. */
type SecretWriteLike = { ref: string; value: string }

export interface AddServerFormProps {
  t: SectionT
  /** Form identity: 'add.title' or 'edit.title'. */
  titleKey: 'add.title' | 'edit.title'
  /** Initial staged draft (EMPTY_DRAFT for add; prefilled for edit). */
  initial: AddDraft
  /** serverNames already present in the document (duplicate check). */
  existingNames: readonly string[]
  writable: boolean
  onSave(input: ServerSaveInput): Promise<SaveOutcome>
  /** Called after a successful save (parent closes/announces). */
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
  autoFocus?: boolean
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
        autoFocus={props.autoFocus}
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

const rowActionStyle = { flex: 1, boxSizing: 'border-box' as const }

export function AddServerForm(props: AddServerFormProps): JSX.Element {
  const { t, writable } = props
  const [draft, setDraft] = useState<AddDraft>(props.initial)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const disabled = !writable || saving

  const problems = evaluateDraft(draft, props.existingNames)
  const invalid = hasProblems(problems)
  // Reveal problems that have real content immediately; pristine empty-field
  // 'required' hints only appear after the first Save attempt.
  const reveal =
    attempted ||
    (problems.name !== undefined && draft.name.trim() !== '') ||
    (problems.command !== undefined && draft.command.trim() !== '') ||
    (problems.url !== undefined && draft.url.trim() !== '') ||
    problems.env.some((problem) => problem !== undefined) ||
    problems.headers.some((problem) => problem !== undefined)

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

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    void handleSave()
  }

  /**
   * FE-11: no state writes after the success path — the parent closes (and
   * unmounts) this form on success, so the continuation returns before any
   * further setState; failure keeps the form mounted and reports inline.
   */
  async function handleSave(): Promise<void> {
    if (saving) return
    setAttempted(true)
    setFailure(null)
    if (invalid) return
    setSaving(true)
    let outcome: SaveOutcome
    try {
      outcome = await props.onSave(draftToServer(draft))
    } catch {
      // The controller actions never throw; this guards local faults only.
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    if (outcome.ok) {
      setSaving(false)
      props.onClose()
      return
    }
    setFailure(outcome)
    setSaving(false)
  }

  const nameProblem = reveal ? problems.name : undefined
  const showCommand = reveal && draft.transport === 'stdio' ? problems.command : undefined
  const showUrl = reveal && draft.transport === 'streamable-http' ? problems.url : undefined
  const envProblems = reveal ? problems.env : problems.env.map(() => undefined)
  const headerProblems = reveal ? problems.headers : problems.headers.map(() => undefined)

  return (
    <form
      aria-label={t(props.titleKey)}
      onSubmit={handleSubmit}
      style={{ border: '1px dashed rgba(127,127,127,0.5)', borderRadius: 8, padding: 12, marginBottom: 10 }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{t(props.titleKey)}</h3>

      {failure !== null && (
        <p role="alert" style={{ margin: '0 0 8px', padding: '6px 10px', borderRadius: 6, background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.4)', fontSize: 13 }}>
          {failureText(t, failure)}
        </p>
      )}

      <Field
        id="mcp-scope-add-name"
        label={t('add.serverName')}
        value={draft.name}
        disabled={disabled}
        autoFocus
        hint={t('add.toolPrefixHint', { name: draft.name.trim() || t('add.ellipsis') })}
        problem={nameProblem !== undefined ? t(nameProblem === 'pattern' ? 'validation.namePattern' : nameProblem === 'reserved' ? 'validation.nameReserved' : 'validation.duplicateName') : undefined}
        onChange={(name) => patch({ name })}
      />

      <div role="radiogroup" aria-label={t('add.transport')} style={{ marginBottom: 6 }}>
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
                  style={rowActionStyle}
                />
                <button
                  type="button"
                  disabled={disabled || draft.args.length <= 1}
                  onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                >
                  {t('add.argRemove')}
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
                  style={rowActionStyle}
                />
                <input
                  aria-label={`${t('add.secretValueLabel')} ${index + 1}`}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  disabled={disabled}
                  placeholder={t('add.secretPlaceholder')}
                  onChange={(event) => patchEnv(index, { value: event.target.value })}
                  style={rowActionStyle}
                />
                <button
                  type="button"
                  disabled={disabled || draft.env.length <= 1}
                  onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                >
                  {t('add.envRemove')}
                </button>
              </div>
            ))}
            <button type="button" disabled={disabled} onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}>
              {t('add.envAdd')}
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
                  style={rowActionStyle}
                  placeholder={t('add.headerNamePlaceholder')}
                />
                <input
                  aria-label={`${t('add.credentialRef')} ${index + 1}`}
                  type="text"
                  value={row.ref}
                  disabled={disabled}
                  onChange={(event) => patchHeader(index, { ref: event.target.value })}
                  style={rowActionStyle}
                  placeholder={t('add.credentialRefPlaceholder')}
                />
                <input
                  aria-label={`${t('add.secretValueLabel')} ${index + 1}`}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  disabled={disabled}
                  placeholder={t('add.secretPlaceholder')}
                  onChange={(event) => patchHeader(index, { value: event.target.value })}
                  style={rowActionStyle}
                />
                <button
                  type="button"
                  disabled={disabled || draft.headers.length <= 1}
                  onClick={() => patch({ headers: draft.headers.filter((_, i) => i !== index) })}
                >
                  {t('add.headerRemove')}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() => patch({ headers: [...draft.headers, { name: '', ref: '', value: '' }] })}
            >
              {t('add.headerAdd')}
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
        <button type="submit" disabled={disabled || invalid}>
          {saving ? t('state.saving') : t('action.save')}
        </button>
        <button type="button" disabled={saving} onClick={props.onClose}>
          {t('action.cancel')}
        </button>
      </div>
    </form>
  )
}
