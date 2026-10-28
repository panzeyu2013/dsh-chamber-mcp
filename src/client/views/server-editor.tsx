/**
 * Add / edit server view.
 *
 * Independent from the list: while it is open no other surface is frozen. The
 * editor is the only place with an explicit Save; workspace scope and global
 * availability are immediate switches on the detail page. Validation is
 * submitted rather than silently disabling Save, and the footer always names
 * the first field to fix.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import {
  EMPTY_DRAFT,
  draftFromImport,
  draftToServer,
  evaluateDraft,
  hasProblems,
  isDraftDirty,
  type AddDraft,
} from '../draft.js'
import {
  parseHeaderLines,
  parseKeyValueLines,
  parseMcpSnippetCandidates,
  refFromHeaderName,
  splitCommandLine,
  type ImportCandidate,
} from '../import.js'
import { failureText, type SaveFailure, type SaveOutcome, type ServerSaveInput } from '../controller.js'
import type { SectionT } from '../section.js'
import { ConfirmDialog, InlineNotice, Modal } from '../components/ui.js'
import { cx, styles } from '../styles.js'

export interface ServerEditorProps {
  t: SectionT
  mode: 'add' | 'edit'
  initial: AddDraft
  /** Original name in edit mode (draft persistence key + rename warning). */
  originalName?: string
  existingNames: readonly string[]
  writable: boolean
  credentials: Readonly<Record<string, CredentialInfo>>
  /** Open the import modal immediately (empty-state "import" path). */
  autoImport?: boolean
  onSave(input: ServerSaveInput): Promise<SaveOutcome>
  onCancel(): void
  onSaved(name: string, kind: 'added' | 'updated'): void
}

interface ProblemEntry {
  key: string
  id: string
  label: string
  message: string
}

const STORAGE_PREFIX = 'mcp-scope.draft.v2:'

function storageKeyOf(mode: 'add' | 'edit', name: string | undefined): string {
  return STORAGE_PREFIX + (mode === 'add' ? 'add' : 'edit:' + (name ?? ''))
}

function withoutSecrets(draft: AddDraft): AddDraft {
  return {
    ...draft,
    env: draft.env.map((row) => ({ key: row.key, value: '' })),
    headers: draft.headers.map((row) => ({ name: row.name, ref: row.ref, value: '' })),
  }
}

function loadPersistedDraft(key: string): AddDraft | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<AddDraft>
    if (candidate.transport !== 'stdio' && candidate.transport !== 'streamable-http') return null
    const base = { ...EMPTY_DRAFT }
    const merged: AddDraft = {
      ...base,
      ...candidate,
      name: typeof candidate.name === 'string' ? candidate.name : '',
      command: typeof candidate.command === 'string' ? candidate.command : '',
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : '',
      url: typeof candidate.url === 'string' ? candidate.url : '',
      timeoutMs: typeof candidate.timeoutMs === 'string' ? candidate.timeoutMs : '',
      args: Array.isArray(candidate.args) && candidate.args.length > 0 ? candidate.args.map(String) : [''],
      env:
        Array.isArray(candidate.env) && candidate.env.length > 0
          ? candidate.env.map((row) => ({ key: String(row.key ?? ''), value: '' }))
          : [{ key: '', value: '' }],
      headers:
        Array.isArray(candidate.headers) && candidate.headers.length > 0
          ? candidate.headers.map((row) => ({
              name: String(row.name ?? ''),
              ref: String(row.ref ?? ''),
              value: '',
            }))
          : [{ name: '', ref: '', value: '' }],
      enabled: candidate.enabled !== false,
    }
    return merged
  } catch {
    return null
  }
}

function persistDraft(key: string, draft: AddDraft): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(key, JSON.stringify(withoutSecrets(draft)))
  } catch {
    /* storage is best effort; never break the editor */
  }
}

function clearPersistedDraft(key: string): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* best effort */
  }
}

interface FieldProps {
  id: string
  label: string
  value: string
  disabled: boolean
  hint?: string
  problem?: string
  required?: boolean
  type?: 'text' | 'password'
  placeholder?: string
  autoFocus?: boolean
  onChange(value: string): void
}

function Field(props: FieldProps): JSX.Element {
  const hintId = props.hint !== undefined ? props.id + '-hint' : undefined
  const problemId = props.problem !== undefined ? props.id + '-problem' : undefined
  return (
    <div className={styles.editorField}>
      <label className={styles.fieldLabel} htmlFor={props.id}>
        {props.label}
        {props.required === true && <span className={styles.fieldHint}> · {props.required === true ? '*' : ''}</span>}
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
        aria-invalid={props.problem !== undefined || undefined}
        aria-required={props.required === true || undefined}
        aria-describedby={[hintId, problemId].filter((value): value is string => value !== undefined).join(' ') || undefined}
        onChange={(event) => props.onChange(event.target.value)}
        className={cx(styles.input, props.problem !== undefined && styles.inputInvalid)}
      />
      {props.hint !== undefined && (
        <span id={hintId} className={styles.fieldHint}>
          {props.hint}
        </span>
      )}
      {props.problem !== undefined && (
        <span id={problemId} className={styles.fieldProblem}>
          {props.problem}
        </span>
      )}
    </div>
  )
}

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

export function ServerEditor(props: ServerEditorProps): ReactNode {
  const { t, writable, credentials } = props
  const persistenceKey = storageKeyOf(props.mode, props.originalName ?? props.initial.name)
  const persisted = useRef<AddDraft | null | undefined>(undefined)
  if (persisted.current === undefined) persisted.current = loadPersistedDraft(persistenceKey)
  const initialDraft = persisted.current ?? props.initial
  const [draft, setDraft] = useState<AddDraft>(() => initialDraft)
  const [restored] = useState<boolean>(() => persisted.current !== null)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(props.autoImport === true)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<'empty' | 'invalid' | 'unsupported' | null>(null)
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(
    initialDraft.cwd !== '' || initialDraft.timeoutMs !== '',
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const autoImported = useRef(false)
  const mounted = useRef(true)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const initialRef = useRef(props.initial)
  initialRef.current = props.initial
  const skipPersistOnUnmount = useRef(false)
  const dirty = isDraftDirty(draft, props.initial)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Debounce storage writes; an unmount (settings closed, view change) flushes
  // the latest draft synchronously, except after save/discard cleared it.
  useEffect(() => {
    if (!dirty) {
      clearPersistedDraft(persistenceKey)
      return undefined
    }
    const timer = window.setTimeout(() => persistDraft(persistenceKey, latestDraft.current), 300)
    return () => window.clearTimeout(timer)
  }, [draft, dirty, persistenceKey])

  useEffect(
    () => () => {
      if (skipPersistOnUnmount.current) return
      if (isDraftDirty(latestDraft.current, initialRef.current)) {
        persistDraft(persistenceKey, latestDraft.current)
      }
    },
    [persistenceKey],
  )

  useEffect(() => {
    if (note === null) return undefined
    const timer = window.setTimeout(() => setNote(null), 6000)
    return () => window.clearTimeout(timer)
  }, [note])

  const problems = evaluateDraft(draft, props.existingNames)
  const invalid = hasProblems(problems)
  const disabled = !writable || saving
  const availabilityDisabled = props.mode === 'edit' ? props.initial.enabled === false : !draft.enabled
  const nameId = 'mcp-scope-editor-name'
  const commandId = 'mcp-scope-editor-command'
  const urlId = 'mcp-scope-editor-url'
  const timeoutId = 'mcp-scope-editor-timeout'

  function patch(next: Partial<AddDraft>): void {
    setDraft((prev) => ({ ...prev, ...next }))
  }

  function patchEnv(index: number, next: { key?: string; value?: string }): void {
    setDraft((prev) => ({
      ...prev,
      env: prev.env.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }))
  }

  function patchHeader(index: number, next: { name?: string; ref?: string; value?: string }): void {
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }))
  }

  function problemEntries(): ProblemEntry[] {
    const entries: ProblemEntry[] = []
    if (problems.name !== undefined) {
      entries.push({
        key: 'name',
        id: nameId,
        label: t('add.serverName'),
        message: t(
          problems.name === 'pattern'
            ? 'validation.namePattern'
            : problems.name === 'reserved'
              ? 'validation.nameReserved'
              : 'validation.duplicateName',
        ),
      })
    }
    if (problems.command !== undefined) {
      entries.push({ key: 'command', id: commandId, label: t('add.command'), message: t('validation.commandRequired') })
    }
    if (problems.url !== undefined) {
      entries.push({
        key: 'url',
        id: urlId,
        label: t('add.url'),
        message: t(problems.url === 'required' ? 'validation.urlRequired' : 'validation.invalidUrl'),
      })
    }
    if (problems.timeout !== undefined) {
      entries.push({ key: 'timeout', id: timeoutId, label: t('add.timeout'), message: t('validation.timeout') })
    }
    problems.env.forEach((problem, index) => {
      if (problem === undefined) return
      entries.push({
        key: 'env-' + index,
        id: 'mcp-scope-editor-env-key-' + index,
        label: t('add.envKey') + ' ' + (index + 1),
        message: t(problem),
      })
    })
    problems.headers.forEach((problem, index) => {
      if (problem === undefined) return
      const refProblem = problem === 'validation.refPattern' || problem === 'validation.refDuplicate'
      entries.push({
        key: 'header-' + index,
        id: refProblem ? 'mcp-scope-editor-header-ref-' + index : 'mcp-scope-editor-header-name-' + index,
        label: t(refProblem ? 'add.credentialRef' : 'add.headerName') + ' ' + (index + 1),
        message: t(problem),
      })
    })
    return entries
  }

  function focusProblem(id: string): void {
    if (typeof document === 'undefined') return
    const element = document.getElementById(id)
    if (element !== null) {
      element.focus()
      return
    }
    // The timeout field lives in the advanced disclosure: open it, then focus
    // on the next frame once the input exists.
    if (id === timeoutId) {
      setAdvancedOpen(true)
      window.setTimeout(() => document.getElementById(timeoutId)?.focus(), 0)
    }
  }

  function focusFirstProblem(): void {
    const first = problemEntries()[0]
    if (first === undefined) return
    focusProblem(first.id)
  }

  function requestClose(): void {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else {
      skipPersistOnUnmount.current = true
      clearPersistedDraft(persistenceKey)
      props.onCancel()
    }
  }

  async function handleSave(): Promise<void> {
    if (saving) return
    setAttempted(true)
    setFailure(null)
    if (invalid) {
      focusFirstProblem()
      return
    }
    setSaving(true)
    let outcome: SaveOutcome
    try {
      outcome = await props.onSave(draftToServer(draft))
    } catch {
      outcome = { ok: false, reason: 'save-failed' }
    }
    if (!mounted.current) return
    if (outcome.ok) {
      skipPersistOnUnmount.current = true
      clearPersistedDraft(persistenceKey)
      setSaving(false)
      props.onSaved(draft.name.trim(), props.mode === 'edit' ? 'updated' : 'added')
      return
    }
    setFailure(outcome)
    setSaving(false)
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    void handleSave()
  }

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

  async function pasteCommand(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    const tokens = splitCommandLine(text)
    if (tokens.length === 0) return
    const [command, ...args] = tokens
    patch({ command: command ?? '', args: args.length > 0 ? args : [''] })
    setNote(t('paste.argsImported', { count: args.length }))
  }

  async function pasteEnv(): Promise<void> {
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

  async function pasteHeaders(): Promise<void> {
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

  function closeImport(): void {
    setImportOpen(false)
    window.setTimeout(() => document.getElementById('mcp-scope-editor-name')?.focus(), 0)
  }

  function applyImport(candidate: ImportCandidate): void {
    setDraft((prev) => draftFromImport(prev, candidate.server))
    closeImport()
    setImportText('')
    setImportCandidates([])
    setImportError(null)
    setNote(
      candidate.name !== undefined && candidate.name !== ''
        ? t('editor.importNote', { name: candidate.name })
        : t('editor.manual'),
    )
  }

  function parseImport(): void {
    const outcome = parseMcpSnippetCandidates(importText)
    if (!outcome.ok) {
      setImportError(outcome.reason)
      setImportCandidates([])
      return
    }
    setImportError(null)
    setImportCandidates(outcome.candidates)
    if (outcome.candidates.length === 1) applyImport(outcome.candidates[0]!)
  }

  async function importFromClipboard(): Promise<void> {
    const text = await readClipboard()
    if (text === null || !mounted.current) return
    setImportText(text)
    setImportError(null)
    setImportCandidates([])
  }

  useEffect(() => {
    if (props.autoImport !== true || autoImported.current) return
    autoImported.current = true
    void importFromClipboard()
    // Mount-time intent only; later prop changes must not steal the clipboard.
  }, [props.autoImport])

  const envRevealKey = (row: { key: string; value: string }, index: number): string =>
    'env:' + (row.key.trim() !== '' ? 'key:' + row.key.trim() : '#' + index)
  const headerRevealKey = (
    row: { name: string; ref: string; value: string },
    index: number,
  ): string =>
    'header:' +
    (row.ref.trim() !== ''
      ? 'ref:' + row.ref.trim()
      : row.name.trim() !== ''
        ? 'name:' + row.name.trim()
        : '#' + index)
  const isRevealed = (key: string): boolean => revealed[key] === true
  const reveal = (key: string, next: boolean): void => {
    setRevealed((prev) => ({ ...prev, [key]: next }))
  }

  const nameProblem = attempted || draft.name.trim() !== '' ? problems.name : undefined
  const commandProblem = attempted || draft.command.trim() !== '' ? problems.command : undefined
  const urlProblem = attempted || draft.url.trim() !== '' ? problems.url : undefined
  const timeoutProblem = attempted || draft.timeoutMs.trim() !== '' ? problems.timeout : undefined
  const entries = problemEntries()
  const showSummary = attempted && entries.length > 0
  const renameHint =
    props.mode === 'edit' &&
    props.originalName !== undefined &&
    draft.name.trim() !== '' &&
    draft.name.trim() !== props.originalName
      ? t('editor.renameWarning', { old: props.originalName, new: draft.name.trim() })
      : undefined

  return (
    <form
      aria-label={t(props.mode === 'add' ? 'add.title' : 'edit.title')}
      onSubmit={handleSubmit}
      className={styles.editor}
      noValidate
    >
      <div className={styles.editorHead}>
        <button type="button" className={styles.detailBack} disabled={saving} onClick={requestClose}>
          <span aria-hidden="true">←</span> {t('editor.back')}
        </button>
        <h2 className={styles.editorTitle}>{t(props.mode === 'add' ? 'add.title' : 'edit.title')}</h2>
        <p className={styles.editorSub}>{t('editor.subtitle')}</p>
      </div>

      {!writable && <InlineNotice tone="warn">{t('state.readonly')}</InlineNotice>}
      {availabilityDisabled && (
        <InlineNotice tone="info">
          {t(props.mode === 'add' ? 'editor.importedDisabled' : 'editor.disabledNotice')}
        </InlineNotice>
      )}
      {restored && <InlineNotice tone="info">{t('editor.restored')}</InlineNotice>}
      {failure !== null && (
        <InlineNotice tone="error" onDismiss={() => setFailure(null)} dismissLabel={t('action.dismiss')}>
          {failureText(t, failure)}
        </InlineNotice>
      )}
      {note !== null && <p role="status" className={styles.editorNote}>{note}</p>}
      {showSummary && (
        <div className={styles.editorErrorSummary} role="alert">
          <p className={styles.editorErrorTitle}>
            {t(entries.length === 1 ? 'editor.errorOne' : 'editor.errorMany', { count: entries.length })}
          </p>
          <ul className={styles.editorErrorList}>
            {entries.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className={styles.editorErrorLink}
                  onClick={() => focusProblem(entry.id)}
                >
                  {entry.label}: {entry.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.editorSource}>
        <span className={styles.fieldLabel}>{t('editor.startFrom')}</span>
        <button
          type="button"
          className={cx(styles.button, styles.buttonOutline)}
          disabled={disabled}
          onClick={() => {
            setImportOpen(true)
            setImportError(null)
            setImportCandidates([])
          }}
        >
          {t('add.importJson')}
        </button>
        {draft.transport === 'stdio' && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            disabled={disabled}
            title={t('add.pasteCommandHint')}
            onClick={() => void pasteCommand()}
          >
            {t('add.pasteCommand')}
          </button>
        )}
      </div>

      <div className={styles.editorGrid}>
        <Field
          id={nameId}
          label={t('add.serverName')}
          value={draft.name}
          disabled={disabled}
          autoFocus
          required
          hint={
            renameHint ??
            t('add.toolPrefixHint', { name: draft.name.trim() || t('add.ellipsis') })
          }
          problem={
            nameProblem !== undefined
              ? t(
                  nameProblem === 'pattern'
                    ? 'validation.namePattern'
                    : nameProblem === 'reserved'
                      ? 'validation.nameReserved'
                      : 'validation.duplicateName',
                )
              : undefined
          }
          onChange={(name) => patch({ name })}
        />
        <div className={styles.editorField}>
          <span className={styles.fieldLabel}>{t('add.transport')}</span>
          <div role="radiogroup" aria-label={t('add.transport')} className={styles.choices}>
            <TransportChoice
              id="mcp-scope-editor-transport-stdio"
              label={t('transport.stdio')}
              checked={draft.transport === 'stdio'}
              disabled={disabled}
              onSelect={() => patch({ transport: 'stdio' })}
            />
            <TransportChoice
              id="mcp-scope-editor-transport-http"
              label={t('transport.http')}
              checked={draft.transport === 'streamable-http'}
              disabled={disabled}
              onSelect={() => patch({ transport: 'streamable-http' })}
            />
          </div>
        </div>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <Field
            id={commandId}
            label={t('add.command')}
            value={draft.command}
            disabled={disabled}
            required
            hint={t('add.commandUserHint')}
            problem={commandProblem !== undefined ? t('validation.commandRequired') : undefined}
            onChange={(command) => patch({ command })}
          />
          <div className={styles.editorSection}>
            <h3 className={styles.editorSectionTitle}>{t('add.args')}</h3>
            {draft.args.map((arg, index) => (
              <div key={index} className={styles.keyValueRow}>
                <input
                  aria-label={t('add.args') + ' ' + (index + 1)}
                  type="text"
                  value={arg}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({ args: draft.args.map((value, i) => (i === index ? event.target.value : value)) })
                  }
                  className={cx(styles.input, styles.keyValueCell)}
                />
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline, styles.rowRemove)}
                  aria-label={t('add.argRemove') + ' ' + (index + 1)}
                  disabled={disabled || draft.args.length <= 1}
                  onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                >
                  ×
                </button>
              </div>
            ))}
            <div>
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

          <div className={styles.editorSection}>
            <div className={styles.detailSectionHead}>
              <div className={styles.detailSectionHeading}>
                <h3 className={styles.editorSectionTitle}>{t('add.envKey')}</h3>
                <p className={styles.detailSectionHint}>{t('add.envSectionHint')}</p>
              </div>
              <div className={styles.detailSectionActions}>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={disabled}
                  onClick={() => void pasteEnv()}
                >
                  {t('add.pasteEnv')}
                </button>
              </div>
            </div>
            {draft.env.map((row, index) => {
              const problem = problems.env[index]
              const keyInvalid = problem !== undefined
              const revealKey = envRevealKey(row, index)
              const configured = row.key.trim() !== '' && credentials[row.key.trim()]?.configured === true
              return (
                <div key={index} className={styles.keyValueRow}>
                  <input
                    id={'mcp-scope-editor-env-key-' + index}
                    aria-label={t('add.envKey') + ' ' + (index + 1)}
                    type="text"
                    value={row.key}
                    disabled={disabled}
                    aria-invalid={keyInvalid || undefined}
                    onChange={(event) => patchEnv(index, { key: event.target.value })}
                    className={cx(styles.input, styles.keyValueCell, keyInvalid && styles.inputInvalid)}
                    placeholder={t('add.credentialRefPlaceholder')}
                  />
                  <div className={styles.secretInputWrap}>
                    <input
                      aria-label={t('add.secretValueLabel') + ' ' + (index + 1)}
                      type={isRevealed(revealKey) ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={row.value}
                      disabled={disabled}
                      placeholder={configured ? t('editor.secretKeep') : t('add.secretPlaceholder')}
                      onChange={(event) => patchEnv(index, { value: event.target.value })}
                      className={cx(styles.input, styles.keyValueCell)}
                    />
                    <button
                      type="button"
                      className={styles.revealButton}
                      aria-label={
                        (isRevealed(revealKey) ? t('editor.hideSecret') : t('editor.showSecret')) + ' ' + (index + 1)
                      }
                      disabled={disabled}
                      onClick={() => reveal(revealKey, !isRevealed(revealKey))}
                    >
                      {isRevealed(revealKey) ? t('editor.hideSecret') : t('editor.showSecret')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={cx(styles.button, styles.buttonOutline, styles.rowRemove)}
                    aria-label={t('add.envRemove') + ' ' + (index + 1)}
                    disabled={disabled || draft.env.length <= 1}
                    onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <div>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}
              >
                {t('add.envAdd')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <Field
            id={urlId}
            label={t('add.url')}
            value={draft.url}
            disabled={disabled}
            required
            problem={
              urlProblem !== undefined
                ? t(urlProblem === 'required' ? 'validation.urlRequired' : 'validation.invalidUrl')
                : undefined
            }
            onChange={(url) => patch({ url })}
          />
          <div className={styles.editorSection}>
            <div className={styles.detailSectionHead}>
              <div className={styles.detailSectionHeading}>
                <h3 className={styles.editorSectionTitle}>{t('add.headerName')}</h3>
                <p className={styles.detailSectionHint}>{t('add.headerSectionHint')}</p>
              </div>
              <div className={styles.detailSectionActions}>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonOutline)}
                  disabled={disabled}
                  title={t('add.pasteHeadersHint')}
                  onClick={() => void pasteHeaders()}
                >
                  {t('add.pasteHeaders')}
                </button>
              </div>
            </div>
            {draft.headers.map((row, index) => {
              const problem = problems.headers[index]
              const revealKey = headerRevealKey(row, index)
              const refProblem = problem === 'validation.refPattern' || problem === 'validation.refDuplicate'
              const nameProblemRow = problem !== undefined && !refProblem
              const configured = row.ref.trim() !== '' && credentials[row.ref.trim()]?.configured === true
              return (
                <div key={index} className={styles.keyValueRow}>
                  <input
                    id={'mcp-scope-editor-header-name-' + index}
                    aria-label={t('add.headerName') + ' ' + (index + 1)}
                    type="text"
                    value={row.name}
                    disabled={disabled}
                    aria-invalid={nameProblemRow || undefined}
                    placeholder={t('add.headerNamePlaceholder')}
                    onChange={(event) =>
                      patchHeader(index, {
                        name: event.target.value,
                        ...(row.ref.trim() === '' ? { ref: refFromHeaderName(event.target.value) } : {}),
                      })
                    }
                    className={cx(styles.input, styles.keyValueCell, nameProblemRow && styles.inputInvalid)}
                  />
                  <input
                    id={'mcp-scope-editor-header-ref-' + index}
                    aria-label={t('add.credentialRef') + ' ' + (index + 1)}
                    type="text"
                    value={row.ref}
                    disabled={disabled}
                    aria-invalid={refProblem || undefined}
                    placeholder={t('add.credentialRefPlaceholder')}
                    onChange={(event) => patchHeader(index, { ref: event.target.value })}
                    className={cx(styles.input, styles.keyValueCell, refProblem && styles.inputInvalid)}
                  />
                  <div className={styles.secretInputWrap}>
                    <input
                      aria-label={t('add.secretValueLabel') + ' ' + (index + 1)}
                      type={isRevealed(revealKey) ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={row.value}
                      disabled={disabled}
                      placeholder={configured ? t('editor.secretKeep') : t('add.secretPlaceholder')}
                      onChange={(event) => patchHeader(index, { value: event.target.value })}
                      className={cx(styles.input, styles.keyValueCell)}
                    />
                    <button
                      type="button"
                      className={styles.revealButton}
                      aria-label={
                        (isRevealed(revealKey) ? t('editor.hideSecret') : t('editor.showSecret')) + ' ' + (index + 1)
                      }
                      disabled={disabled}
                      onClick={() => reveal(revealKey, !isRevealed(revealKey))}
                    >
                      {isRevealed(revealKey) ? t('editor.hideSecret') : t('editor.showSecret')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={cx(styles.button, styles.buttonOutline, styles.rowRemove)}
                    aria-label={t('add.headerRemove') + ' ' + (index + 1)}
                    disabled={disabled || draft.headers.length <= 1}
                    onClick={() => patch({ headers: draft.headers.filter((_, i) => i !== index) })}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <div>
              <button
                type="button"
                className={cx(styles.button, styles.buttonOutline)}
                disabled={disabled}
                onClick={() => patch({ headers: [...draft.headers, { name: '', ref: '', value: '' }] })}
              >
                {t('add.headerAdd')}
              </button>
            </div>
          </div>
        </>
      )}

      <div>
        <button
          type="button"
          className={styles.editorAdvanced}
          aria-expanded={advancedOpen}
          aria-controls="mcp-scope-editor-advanced"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
          <span>{t('editor.advanced')}</span>
        </button>
        {advancedOpen && (
          <div id="mcp-scope-editor-advanced" className={styles.editorAdvancedBody}>
            {draft.transport === 'stdio' && (
              <Field
                id="mcp-scope-editor-cwd"
                label={t('add.cwd')}
                value={draft.cwd}
                disabled={disabled}
                onChange={(cwd) => patch({ cwd })}
              />
            )}
            <Field
              id={timeoutId}
              label={t('add.timeout')}
              value={draft.timeoutMs}
              disabled={disabled}
              hint={t('add.timeoutHint')}
              problem={timeoutProblem !== undefined ? t('validation.timeout') : undefined}
              onChange={(timeoutMs) => patch({ timeoutMs })}
            />
          </div>
        )}
      </div>

      <div className={styles.editorFooter}>
        <span className={styles.editorFooterHint}>
          {showSummary
            ? t(entries.length === 1 ? 'editor.errorOne' : 'editor.errorMany', { count: entries.length })
            : t('editor.credentialsHint')}
        </span>
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
          disabled={disabled}
        >
          {saving ? t('state.saving') : t('editor.saveAndTest')}
        </button>
      </div>

      <Modal
        open={importOpen}
        title={t('import.title')}
        onClose={closeImport}
        closeLabel={t('action.cancel')}
        wide
        actions={
          <>
            <button
              type="button"
              className={cx(styles.button, styles.buttonOutline)}
              disabled={disabled}
              onClick={() => void importFromClipboard()}
            >
              {t('import.paste')}
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonPrimary)}
              disabled={disabled || importText.trim() === ''}
              onClick={parseImport}
            >
              {t('import.parse')}
            </button>
          </>
        }
      >
        <div className={styles.field}>
          <p className={styles.fieldHint}>{t('import.hint')}</p>
          <textarea
            aria-label={t('editor.importTextarea')}
            data-autofocus
            className={cx(styles.textarea, importError !== null && styles.inputInvalid)}
            value={importText}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => {
              setImportText(event.target.value)
              setImportError(null)
              setImportCandidates([])
            }}
          />
          {importError !== null && (
            <span className={styles.fieldProblem}>
              {t(importError === 'unsupported' ? 'import.errorNoServer' : 'import.error')}
            </span>
          )}
          {importCandidates.length > 1 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('editor.importCandidates')}</span>
              <ul className={styles.candidateList}>
                {importCandidates.map((candidate, index) => (
                  <li key={(candidate.name ?? '') + index}>
                    <button
                      type="button"
                      className={cx(styles.button, styles.buttonOutline)}
                      onClick={() => applyImport(candidate)}
                    >
                      {t('editor.importUse', { name: candidate.name ?? t('add.ellipsis') })}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDiscard}
        title={t('editor.discardTitle')}
        body={t('editor.discardBody')}
        confirmLabel={t('dirty.discard')}
        cancelLabel={t('dirty.keepEditing')}
        closeLabel={t('action.cancel')}
        danger
        onConfirm={() => {
          setConfirmDiscard(false)
          skipPersistOnUnmount.current = true
          clearPersistedDraft(persistenceKey)
          props.onCancel()
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </form>
  )
}
