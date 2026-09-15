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
 *
 * Chrome comes from the shared style seat (`./styles.ts`): the form is the
 * settings panel's editing surface (module fill + r12), its fields use the
 * official plugin-form input vocabulary, the transport choice is the Pill
 * primitive's pill over real radios, and the footer is the editor action row
 * (dismiss left, full-size commit capsule right).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  RESERVED_OVERRIDE_KEYS,
  SERVER_NAME_PATTERN,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  type ServerDef,
} from '../shared/model.js'
import type { SettingsKey } from './locales.js'
import { failureText, type SaveFailure, type SaveOutcome, type ServerSaveInput } from './controller.js'
import {
  parseHeaderLines,
  parseKeyValueLines,
  parseMcpSnippet,
  refFromHeaderName,
  splitCommandLine,
  type ImportedServer,
} from './import.js'
import type { SectionT } from './section.js'
import { cx, styles } from './styles.js'

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
  /** Global enable flag (the document's disabled map, inverted). */
  enabled: boolean
  /** Per-server timeout in ms as typed; '' = default. */
  timeoutMs: string
}

/** Names the "also found" note lists before it is truncated. */
const IMPORT_NAME_LIMIT = 8

export const EMPTY_DRAFT: AddDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  cwd: '',
  args: [''],
  env: [{ key: '', value: '' }],
  url: '',
  headers: [{ name: '', ref: '', value: '' }],
  enabled: true,
  timeoutMs: '',
}

/** Structural equality of two drafts (dirty-form protection). */
export function isDraftDirty(draft: AddDraft, initial: AddDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(initial)
}

/** Patch a draft from one parsed import (secret values stay write-only). */
export function draftFromImport(current: AddDraft, server: ImportedServer): AddDraft {
  const next: AddDraft = {
    ...current,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.name !== undefined && server.name !== '' ? { name: server.name } : {}),
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
  }
  if (server.transport === 'stdio') {
    return {
      ...next,
      command: server.command ?? '',
      args: (server.args ?? []).length > 0 ? [...server.args!] : [''],
      cwd: server.cwd ?? '',
      env: server.env.length > 0 ? [...server.env, { key: '', value: '' }] : [{ key: '', value: '' }],
    }
  }
  return {
    ...next,
    url: server.url ?? '',
    headers:
      server.headers.length > 0
        ? [...server.headers, { name: '', ref: '', value: '' }]
        : [{ name: '', ref: '', value: '' }],
  }
}

/**
 * Prefill a staged draft from an existing server definition (edit flow).
 * Secret values stay blank — a blank input keeps the stored value on save.
 */
export function draftFromServer(server: ServerDef, disabled = false): AddDraft {
  const enabled = !disabled
  const timeoutMs = server.timeoutMs !== undefined ? String(server.timeoutMs) : ''
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
      enabled,
      timeoutMs,
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
    enabled,
    timeoutMs,
  }
}

export interface AddProblems {
  /** Server-name field problem (pattern / duplicate / reserved). */
  name?: 'pattern' | 'duplicate' | 'reserved'
  command?: 'required'
  url?: 'required' | 'invalid'
  /** Timeout outside the supported bounds / not a whole number. */
  timeout?: 'range'
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
    const seenRefs = new Set<string>()
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
      } else if (seenRefs.has(ref)) {
        // Two header names can collapse onto one ref (X-Api-Key / X_Api_Key):
        // without this, saving silently shadows one credential with the other.
        problem = 'validation.refDuplicate' as const
      }
      problems.headers.push(problem)
      if (name !== '') seenNames.add(name)
      if (ref !== '') seenRefs.add(ref)
    }
  }

  const timeout = draft.timeoutMs.trim()
  if (timeout !== '') {
    const value = Number(timeout)
    if (!/^\d+$/.test(timeout) || !Number.isInteger(value) || value < TIMEOUT_MIN_MS || value > TIMEOUT_MAX_MS) {
      problems.timeout = 'range'
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
    problems.timeout !== undefined ||
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
  const timeout = draft.timeoutMs.trim()
  const timeoutMs = timeout === '' ? undefined : Number(timeout)
  const timing = timeoutMs !== undefined ? { timeoutMs } : {}
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
      ...timing,
    }
    return { server, secrets, enabled: draft.enabled }
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
    server: { serverName: name, transport: 'streamable-http', url: draft.url.trim(), headers, ...timing },
    secrets,
    enabled: draft.enabled,
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
  /**
   * Bumped by the section's header Add/Cancel control. When a form is open the
   * header button routes here instead of tearing the form down, so the form's
   * own unsaved-changes guard owns every dismissal path.
   */
  dismissToken?: number
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
  const invalid = props.problem !== undefined
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={props.id}>
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
        aria-invalid={invalid || undefined}
        onChange={(event) => props.onChange(event.target.value)}
        className={cx(styles.input, invalid && styles.inputInvalid)}
      />
      {props.hint !== undefined && <span className={styles.fieldHint}>{props.hint}</span>}
      {props.problem !== undefined && <span className={styles.fieldProblem}>{props.problem}</span>}
    </div>
  )
}

/** One transport choice: a native radio under the pill it paints. */
function TransportChoice(props: {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  onSelect(): void
}): JSX.Element {
  return (
    <label className={styles.choice} htmlFor={props.id}>
      <input
        id={props.id}
        type="radio"
        name="mcp-scope-transport"
        className={styles.choiceInput}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onSelect}
      />
      <span className={styles.choicePill}>{props.label}</span>
    </label>
  )
}

export function AddServerForm(props: AddServerFormProps): JSX.Element {
  const { t, writable } = props
  const [draft, setDraft] = useState<AddDraft>(props.initial)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /** Transient paste/import outcome (role="status", never a failure banner). */
  const [note, setNote] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importProblem, setImportProblem] = useState<'invalid' | 'unsupported' | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Transient note: auto-retires like the card's failure banner.
  useEffect(() => {
    if (note === null) return
    const timer = window.setTimeout(() => setNote(null), 6000)
    return () => window.clearTimeout(timer)
  }, [note])
  const dirty = isDraftDirty(draft, props.initial)
  const requestClose = (): void => {
    if (dirty) setConfirmDiscard(true)
    else props.onClose()
  }
  // The section header's Add/Cancel button routes here while a form is open;
  // skip the first run (mount) so an initial token never closes a fresh form.
  const dismissSeen = useRef(props.dismissToken)
  useEffect(() => {
    if (props.dismissToken === undefined || dismissSeen.current === props.dismissToken) return
    dismissSeen.current = props.dismissToken
    requestClose()
    // requestClose reads the latest draft through the render closure.
  })
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
    (problems.timeout !== undefined && draft.timeoutMs.trim() !== '') ||
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

  /** Clipboard read through the browser API (never available in jsdom tests). */
  async function readClipboard(): Promise<string | null> {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (clipboard === undefined) throw new Error('clipboard unavailable')
      return await clipboard.readText()
    } catch {
      setNote(t('clipboard.readFailed'))
      return null
    }
  }

  async function handlePasteCommand(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    const tokens = splitCommandLine(text)
    if (tokens.length === 0) return
    const [command, ...args] = tokens
    patch({ command: command ?? '', args: args.length > 0 ? args : [''] })
    setNote(t('paste.argsImported', { count: args.length }))
  }

  async function handlePasteEnv(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    const rows = parseKeyValueLines(text)
    if (rows.length === 0) {
      setNote(t('paste.noneFound'))
      return
    }
    setDraft((prev) => ({
      ...prev,
      env: [
        ...prev.env.filter((row) => row.key.trim() !== '' || row.value !== ''),
        ...rows,
        { key: '', value: '' },
      ],
    }))
    setNote(t('paste.envImported', { count: rows.length }))
  }

  async function handlePasteHeaders(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    const rows = parseHeaderLines(text)
    if (rows.length === 0) {
      setNote(t('paste.noneFound'))
      return
    }
    setDraft((prev) => ({
      ...prev,
      headers: [
        ...prev.headers.filter((row) => row.name.trim() !== '' || row.ref.trim() !== '' || row.value !== ''),
        ...rows.map((row) => ({ name: row.name, ref: refFromHeaderName(row.name), value: row.value })),
        { name: '', ref: '', value: '' },
      ],
    }))
    setNote(t('paste.headersImported', { count: rows.length }))
  }

  /** Fill the staged draft from one JSON snippet — never saves anything. */
  function handleImport(): void {
    const outcome = parseMcpSnippet(importText)
    if (!outcome.ok) {
      // Tell "unreadable JSON" apart from "readable, but no server in it".
      setImportProblem(outcome.reason === 'unsupported' ? 'unsupported' : 'invalid')
      return
    }
    setDraft((prev) => draftFromImport(prev, outcome.server))
    setImportOpen(false)
    setImportText('')
    setImportProblem(null)
    if (outcome.others.length > 0) {
      const shown = outcome.others.slice(0, IMPORT_NAME_LIMIT)
      const rest = outcome.others.length - shown.length
      const others = shown.join(', ') + (rest > 0 ? t('import.more', { count: String(rest) }) : '')
      setNote(t('import.multiple', { name: outcome.server.name ?? '', others }))
    }
  }

  async function handleImportClipboard(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    setImportText(text)
    setImportProblem(null)
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
    <form aria-label={t(props.titleKey)} onSubmit={handleSubmit} className={styles.form}>
      <h3 className={styles.formTitle}>{t(props.titleKey)}</h3>

      {failure !== null && (
        <p role="alert" className={styles.noticeError}>
          <span className={styles.noticeText}>{failureText(t, failure)}</span>
        </p>
      )}

      {note !== null && (
        <p role="status" className={styles.fieldHint}>
          {note}
        </p>
      )}

      <div className={styles.row}>
        <button
          type="button"
          className={cx(styles.button, styles.buttonOutline)}
          disabled={disabled}
          onClick={() => {
            setImportOpen((open) => !open)
            setImportProblem(null)
          }}
        >
          {t('add.importJson')}
        </button>
      </div>

      {importOpen && (
        <div role="dialog" aria-label={t('import.title')} className={styles.dialog}>
          <span className={styles.fieldLabel}>{t('import.title')}</span>
          <p className={styles.fieldHint}>{t('import.hint')}</p>
          <textarea
            aria-label={t('import.textareaLabel')}
            className={cx(styles.textarea, importProblem !== null && styles.inputInvalid)}
            value={importText}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => {
              setImportText(event.target.value)
              setImportProblem(null)
            }}
          />
          {importProblem !== null && (
            <span className={styles.fieldProblem}>
              {t(importProblem === 'unsupported' ? 'import.errorNoServer' : 'import.error')}
            </span>
          )}
          <div className={styles.row}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              disabled={disabled}
              onClick={() => void handleImportClipboard()}
            >
              {t('import.paste')}
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonPrimary)}
              disabled={disabled || importText.trim() === ''}
              onClick={handleImport}
            >
              {t('import.parse')}
            </button>
          </div>
        </div>
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

      <div className={styles.toggleRow}>
        <span className={styles.switchBox}>
          <input
            id="mcp-scope-add-enabled"
            type="checkbox"
            role="switch"
            className={styles.switchInput}
            checked={draft.enabled}
            disabled={disabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span className={styles.switch} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
        </span>
        <label htmlFor="mcp-scope-add-enabled" className={styles.toggleLabel}>
          {t('add.enabled')}
        </label>
      </div>
      <span className={styles.fieldHint}>{t('add.enabledHint')}</span>

      <div role="radiogroup" aria-label={t('add.transport')} className={styles.field}>
        <span className={styles.fieldLabel}>{t('add.transport')}</span>
        <div className={styles.choices}>
          <TransportChoice
            id="mcp-scope-transport-stdio"
            label={t('transport.stdio')}
            checked={draft.transport === 'stdio'}
            disabled={disabled}
            onSelect={() => patch({ transport: 'stdio' })}
          />
          <TransportChoice
            id="mcp-scope-transport-http"
            label={t('transport.http')}
            checked={draft.transport === 'streamable-http'}
            disabled={disabled}
            onSelect={() => patch({ transport: 'streamable-http' })}
          />
        </div>
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

          <div className={styles.row}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              disabled={disabled}
              title={t('add.pasteCommandHint')}
              onClick={() => void handlePasteCommand()}
            >
              {t('add.pasteCommand')}
            </button>
          </div>

          <div className={styles.rowsGroup}>
            <span className={styles.fieldLabel}>{t('add.args')}</span>
            {draft.args.map((arg, index) => (
              <div key={index} className={styles.row}>
                <input
                  aria-label={`${t('add.args')} ${index + 1}`}
                  type="text"
                  value={arg}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({ args: draft.args.map((a, i) => (i === index ? event.target.value : a)) })
                  }
                  className={cx(styles.input, styles.rowInput)}
                />
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={disabled || draft.args.length <= 1}
                  onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                >
                  {t('add.argRemove')}
                </button>
              </div>
            ))}
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => patch({ args: [...draft.args, ''] })}
              >
                {t('add.argAdd')}
              </button>
            </div>
          </div>

          <Field
            id="mcp-scope-add-cwd"
            label={t('add.cwd')}
            value={draft.cwd}
            disabled={disabled}
            onChange={(cwd) => patch({ cwd })}
          />

          <div className={styles.rowsGroup}>
            <span className={styles.fieldLabel}>{t('add.envKey')}</span>
            <p className={styles.fieldHint}>{t('add.envSectionHint')}</p>
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => void handlePasteEnv()}
              >
                {t('add.pasteEnv')}
              </button>
            </div>
            {draft.env.map((row, index) => {
              // Every env-row problem is about the key, so the key input carries
              // the invalid border: the list below names the problem, the border
              // says which control it belongs to.
              const keyInvalid = envProblems[index] !== undefined
              return (
                <div key={index} className={styles.row}>
                  <input
                    aria-label={`${t('add.envKey')} ${index + 1}`}
                    type="text"
                    value={row.key}
                    disabled={disabled}
                    aria-invalid={keyInvalid || undefined}
                    onChange={(event) => patchEnv(index, { key: event.target.value })}
                    className={cx(styles.input, styles.rowInput, keyInvalid && styles.inputInvalid)}
                  />
                  <input
                    aria-label={`${t('add.secretValueLabel')} ${index + 1}`}
                    type="password"
                    autoComplete="new-password"
                    value={row.value}
                    disabled={disabled}
                    placeholder={t('add.secretPlaceholder')}
                    onChange={(event) => patchEnv(index, { value: event.target.value })}
                    className={cx(styles.input, styles.rowInput)}
                  />
                  <button
                    type="button"
                    className={cx(styles.button, styles.buttonOutline)}
                    disabled={disabled || draft.env.length <= 1}
                    onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                  >
                    {t('add.envRemove')}
                  </button>
                </div>
              )
            })}
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}
              >
                {t('add.envAdd')}
              </button>
            </div>
            {envProblems.some((p) => p !== undefined) && (
              <ul className={styles.problems}>
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

          <div className={styles.rowsGroup}>
            <span className={styles.fieldLabel}>{t('add.headerName')}</span>
            <p className={styles.fieldHint}>{t('add.headerSectionHint')}</p>
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                title={t('add.pasteHeadersHint')}
                onClick={() => void handlePasteHeaders()}
              >
                {t('add.pasteHeaders')}
              </button>
            </div>
            {draft.headers.map((row, index) => {
              // The problem names the field it belongs to: a ref problem marks
              // the ref input, every other one the header-name input.
              const issue = headerProblems[index]
              const refInvalid = issue === 'validation.refPattern' || issue === 'validation.refDuplicate'
              const nameInvalid = issue !== undefined && !refInvalid
              return (
                <div key={index} className={styles.row}>
                  <input
                    aria-label={`${t('add.headerName')} ${index + 1}`}
                    type="text"
                    value={row.name}
                    disabled={disabled}
                    aria-invalid={nameInvalid || undefined}
                    onChange={(event) => patchHeader(index, { name: event.target.value })}
                    className={cx(styles.input, styles.rowInput, nameInvalid && styles.inputInvalid)}
                    placeholder={t('add.headerNamePlaceholder')}
                  />
                  <input
                    aria-label={`${t('add.credentialRef')} ${index + 1}`}
                    type="text"
                    value={row.ref}
                    disabled={disabled}
                    aria-invalid={refInvalid || undefined}
                    onChange={(event) => patchHeader(index, { ref: event.target.value })}
                    className={cx(styles.input, styles.rowInput, refInvalid && styles.inputInvalid)}
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
                    className={cx(styles.input, styles.rowInput)}
                  />
                  <button
                    type="button"
                    className={cx(styles.button, styles.buttonOutline)}
                    disabled={disabled || draft.headers.length <= 1}
                    onClick={() => patch({ headers: draft.headers.filter((_, i) => i !== index) })}
                  >
                    {t('add.headerRemove')}
                  </button>
                </div>
              )
            })}
            <div className={styles.row}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => patch({ headers: [...draft.headers, { name: '', ref: '', value: '' }] })}
              >
                {t('add.headerAdd')}
              </button>
            </div>
            {headerProblems.some((p) => p !== undefined) && (
              <ul className={styles.problems}>
                {headerProblems.map((problem, index) =>
                  problem !== undefined ? <li key={index}>{t(problem)}</li> : null,
                )}
              </ul>
            )}
          </div>
        </>
      )}

      <Field
        id="mcp-scope-add-timeout"
        label={t('add.timeout')}
        value={draft.timeoutMs}
        disabled={disabled}
        hint={t('add.timeoutHint')}
        problem={reveal && problems.timeout !== undefined ? t('validation.timeout') : undefined}
        onChange={(timeoutMs) => patch({ timeoutMs })}
      />

      {confirmDiscard && (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>{t('dirty.confirm')}</p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonDanger)}
              onClick={props.onClose}
            >
              {t('dirty.discard')}
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              onClick={() => setConfirmDiscard(false)}
            >
              {t('dirty.keepEditing')}
            </button>
          </div>
        </div>
      )}

      <div className={styles.formActions}>
        <button
          type="button"
          className={cx(styles.button, styles.buttonMd, styles.buttonOutline)}
          disabled={saving}
          onClick={requestClose}
        >
          {t('action.cancel')}
        </button>
        <button
          type="submit"
          className={cx(styles.button, styles.buttonMd, styles.buttonPrimary)}
          disabled={disabled || invalid}
        >
          {saving ? t('state.saving') : t('action.save')}
        </button>
      </div>
    </form>
  )
}
