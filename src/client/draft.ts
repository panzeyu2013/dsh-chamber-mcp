/**
 * Pure staged-draft model of the server editor.
 *
 * React-free and host-free: the editor and its tests consume these functions.
 * Secrets stay as write-only literals in the draft; draftToServer is the only
 * place they are materialized for the credentials domain.
 */

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
import type { ServerSaveInput } from './controller.js'
import type { ImportedServer } from './import.js'

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

/** Pure staged-draft validation. Problems with real content are revealed live;
 * Save stays clickable and submission opens the summary + focuses the first
 * invalid field (a disabled Save would be a dead end). */
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

/** Any row problem present? (submission blocks while true) */
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
