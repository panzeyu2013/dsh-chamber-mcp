/**
 * Shared mount harness of the INDEPENDENT acceptance suite (contract C4).
 *
 * Nothing here is imported by production code: the acceptance suite drives the
 * real section component with injected store faces (the same technique the
 * owner suites use) so every assertion is black-box on the documented
 * behaviour, not on an implementation detail. Helpers discover the FROZEN
 * contract copy (the quoted zh sentences) from the shipped dictionaries so a
 * missing key fails loudly instead of silently matching English literals.
 */
import { createRoot, type Root } from 'react-dom/client'
import { McpScopeSection, type McpScopeSectionProps } from '../../src/client/section.tsx'
// pull the slot/locale module augmentations (register-site decls) into this program
import type {} from '../../src/client/index.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { McpScopeDoc, WorkspaceOverrides } from '../../src/shared/model.ts'
import type { RuntimeSnapshot, RuntimeTestResult, RuntimeToolEntry } from '../../src/client/runtime.ts'

export type ServerDefLike = McpScopeDoc['servers'][number]
export type Dictionary = Record<string, string>

export const dictionaries: Record<'en' | 'zh', Dictionary> = { en, zh }

/** The dictionary rendered by a mount (en unless stated). */
export function dictOf(locale: 'en' | 'zh' = 'en'): Dictionary {
  return dictionaries[locale]
}

/** Locale reader with a missing-key recorder (never throws inside a render). */
export function makeT(dict: Dictionary, missing: string[] = []) {
  return (key: string, params?: Record<string, string | number>): string => {
    const text = dict[key]
    if (text === undefined) {
      missing.push(key)
      return '[missing:' + key + ']'
    }
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))

export const EMPTY_RUNTIME: RuntimeSnapshot = { phase: 'ready', servers: {} }

export function stdioServer(
  serverName: string,
  extra: Partial<{ command: string; args: string[]; envKeys: string[] }> = {},
): ServerDefLike {
  return {
    serverName,
    transport: 'stdio',
    command: extra.command ?? 'node',
    args: extra.args ?? ['a.js'],
    ...(extra.envKeys !== undefined ? { envKeys: extra.envKeys } : {}),
  } as ServerDefLike
}

export function overridesOf(rows: Record<string, string[]>): WorkspaceOverrides {
  const out: WorkspaceOverrides = {}
  for (const [ws, names] of Object.entries(rows)) {
    const row: Record<string, true> = {}
    for (const name of names) row[name] = true
    out[ws] = row
  }
  return out
}

export type RuntimeViewLike = RuntimeSnapshot['servers'][string]

export function viewOf(name: string, state: RuntimeViewLike['state'] = 'connected'): RuntimeViewLike {
  return { name, state, attempts: 0, maxAttempts: 10, toolCount: 2 }
}

export interface RecordedWrite {
  action:
    | 'addServer'
    | 'replaceServer'
    | 'removeServer'
    | 'toggleWorkspace'
    | 'toggleWorkspaces'
    | 'toggleWorkspaceServers'
    | 'restoreScopeValues'
    | 'setServerEnabled'
    | 'unsetCredential'
  args: readonly unknown[]
}

export interface RecordedCalls {
  refresh: { silent?: boolean; server?: string }[]
  connect: string[]
  disconnect: string[]
  test: string[]
  tools: string[]
  /** Any document-writing action (settings write) the section was observed to call. */
  writes: string[]
  /** The arguments of each write, keyed by action (the acceptance contract). */
  writeArgs: RecordedWrite[]
}

export interface Actions {
  refreshRuntime?: (options?: { silent?: boolean; server?: string }) => Promise<void>
  addServer?: (input: unknown) => Promise<{ ok: boolean }>
  replaceServer?: (oldName: string, input: unknown) => Promise<{ ok: boolean }>
  removeServer?: (name: string) => Promise<{ ok: boolean }>
  toggleWorkspace?: (workspaceId: string, serverName: string, enabled: boolean) => Promise<{ ok: boolean }>
  toggleWorkspaces?: (
    serverName: string,
    enabled: boolean,
    workspaceIds: readonly string[],
  ) => Promise<{ ok: boolean }>
  toggleWorkspaceServers?: (
    workspaceId: string,
    serverNames: readonly string[],
    enabled: boolean,
  ) => Promise<{ ok: boolean }>
  restoreScopeValues?: (
    entries: readonly { workspaceId: string; serverName: string; enabled: boolean }[],
  ) => Promise<{ ok: boolean }>
  setServerEnabled?: (serverName: string, enabled: boolean) => Promise<{ ok: boolean }>
  unsetCredential?: (ref: string) => Promise<{ ok: boolean }>
  connectServer?: (name: string) => Promise<unknown>
  disconnectServer?: (name: string) => Promise<unknown>
  testServer?: (name: string) => Promise<RuntimeTestResult>
  loadTools?: (name: string) => Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

export type DocStatus = 'loading' | 'ready' | 'unavailable'

export interface MountOptions {
  doc: McpScopeDoc
  wsItems?: readonly { workspaceId: string; title: string }[]
  runtime?: RuntimeSnapshot
  locale?: 'en' | 'zh'
  writable?: boolean
  revision?: number
  credentials?: Record<string, CredentialInfo>
  /** Collected when a render asks for a key its dictionary does not carry. */
  missingKeys?: string[]
  actions?: Actions
  /** Document status at mount (a live change goes through `setDocStatus`). */
  docStatus?: DocStatus
}

export interface Harness {
  host: HTMLDivElement
  live: { doc: McpScopeDoc; revision: number; runtime?: RuntimeSnapshot; docStatus: DocStatus }
  calls: RecordedCalls
  missing: string[]
  /** Flip the document status (a real store publishes loading -> ready). */
  setDocStatus(status: DocStatus): void
  rerender(): void
  /** Commit a new document (the write succeeded) and re-render. */
  commitDoc(next: McpScopeDoc): void
  unmount(): void
  text(): string
}

function workspaceStateOf(live: { wsItems: readonly { workspaceId: string; title: string }[] }) {
  return {
    items: live.wsItems,
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: undefined,
  }
}

const mounted: Harness[] = []

/** Unmount everything a spec mounted (call from afterEach). */
export function cleanupSections(): void {
  for (const harness of mounted.splice(0)) harness.unmount()
}

export function mountSection(options: MountOptions): Harness {
  const live = {
    doc: options.doc,
    revision: options.revision ?? 3,
    runtime: options.runtime,
    wsItems: options.wsItems ?? [],
    docStatus: options.docStatus ?? ('ready' as DocStatus),
  }
  const missing = options.missingKeys ?? []
  const dict = dictOf(options.locale)
  const t = makeT(dict, missing)
  const calls: RecordedCalls = {
    refresh: [],
    connect: [],
    disconnect: [],
    test: [],
    tools: [],
    writes: [],
    writeArgs: [],
  }
  const actions = options.actions ?? {}

  // Stable identities: a re-render must not look like a new store to the
  // section effects, or the "no extra request on re-render" assertion would be
  // testing the harness instead of the component.
  const refreshRuntime = async (refreshOptions?: { silent?: boolean; server?: string }): Promise<void> => {
    calls.refresh.push({ silent: refreshOptions?.silent, server: refreshOptions?.server })
    if (actions.refreshRuntime !== undefined) await actions.refreshRuntime(refreshOptions)
  }
  const addServer = async (input: unknown): Promise<{ ok: boolean }> => {
    calls.writes.push('addServer')
    calls.writeArgs.push({ action: 'addServer', args: [input] })
    return actions.addServer !== undefined ? actions.addServer(input) : { ok: true }
  }
  const replaceServer = async (oldName: string, input: unknown): Promise<{ ok: boolean }> => {
    calls.writes.push('replaceServer')
    calls.writeArgs.push({ action: 'replaceServer', args: [oldName, input] })
    return actions.replaceServer !== undefined ? actions.replaceServer(oldName, input) : { ok: true }
  }
  const removeServer = async (name: string): Promise<{ ok: boolean }> => {
    calls.writes.push('removeServer')
    calls.writeArgs.push({ action: 'removeServer', args: [name] })
    return actions.removeServer !== undefined ? actions.removeServer(name) : { ok: true }
  }
  const toggleWorkspace = async (
    workspaceId: string,
    serverName: string,
    enabled: boolean,
  ): Promise<{ ok: boolean }> => {
    calls.writes.push('toggleWorkspace')
    calls.writeArgs.push({ action: 'toggleWorkspace', args: [workspaceId, serverName, enabled] })
    return actions.toggleWorkspace !== undefined
      ? actions.toggleWorkspace(workspaceId, serverName, enabled)
      : { ok: true }
  }
  const toggleWorkspaces = async (
    serverName: string,
    enabled: boolean,
    workspaceIds: readonly string[],
  ): Promise<{ ok: boolean }> => {
    calls.writes.push('toggleWorkspaces')
    calls.writeArgs.push({ action: 'toggleWorkspaces', args: [serverName, enabled, [...workspaceIds]] })
    return actions.toggleWorkspaces !== undefined
      ? actions.toggleWorkspaces(serverName, enabled, workspaceIds)
      : { ok: true }
  }
  const toggleWorkspaceServers = async (
    workspaceId: string,
    serverNames: readonly string[],
    enabled: boolean,
  ): Promise<{ ok: boolean }> => {
    calls.writes.push('toggleWorkspaceServers')
    calls.writeArgs.push({
      action: 'toggleWorkspaceServers',
      args: [workspaceId, [...serverNames], enabled],
    })
    return actions.toggleWorkspaceServers !== undefined
      ? actions.toggleWorkspaceServers(workspaceId, serverNames, enabled)
      : { ok: true }
  }
  const restoreScopeValues = async (
    entries: readonly { workspaceId: string; serverName: string; enabled: boolean }[],
  ): Promise<{ ok: boolean }> => {
    calls.writes.push('restoreScopeValues')
    calls.writeArgs.push({ action: 'restoreScopeValues', args: [entries.map((entry) => ({ ...entry }))] })
    return actions.restoreScopeValues !== undefined
      ? actions.restoreScopeValues(entries)
      : { ok: true }
  }
  const setServerEnabled = async (serverName: string, enabled: boolean): Promise<{ ok: boolean }> => {
    calls.writes.push('setServerEnabled')
    calls.writeArgs.push({ action: 'setServerEnabled', args: [serverName, enabled] })
    return actions.setServerEnabled !== undefined
      ? actions.setServerEnabled(serverName, enabled)
      : { ok: true }
  }
  const unsetCredential = async (ref: string): Promise<{ ok: boolean }> => {
    calls.writes.push('unsetCredential')
    calls.writeArgs.push({ action: 'unsetCredential', args: [ref] })
    return actions.unsetCredential !== undefined ? actions.unsetCredential(ref) : { ok: true }
  }
  const connectServer = async (name: string): Promise<unknown> => {
    calls.connect.push(name)
    return actions.connectServer !== undefined ? actions.connectServer(name) : {}
  }
  const disconnectServer = async (name: string): Promise<unknown> => {
    calls.disconnect.push(name)
    return actions.disconnectServer !== undefined ? actions.disconnectServer(name) : {}
  }
  const testServer = async (name: string): Promise<RuntimeTestResult> => {
    calls.test.push(name)
    return actions.testServer !== undefined ? actions.testServer(name) : { ok: true, toolCount: 0 }
  }
  const loadTools = async (name: string) => {
    calls.tools.push(name)
    return actions.loadTools !== undefined
      ? actions.loadTools(name)
      : { tools: [], truncated: false, total: 0 }
  }

  const docHook = ((selector: (snapshot: unknown) => unknown) =>
    selector({
      status: live.docStatus,
      doc: live.doc,
      revision: live.revision,
      writable: options.writable ?? true,
      credentials: options.credentials ?? {},
      credentialsAt: 0,
    })) as unknown as McpScopeSectionProps['useDoc']
  const workspacesHook = ((selector: (snapshot: unknown) => unknown) =>
    selector(workspaceStateOf(live))) as unknown as McpScopeSectionProps['useWorkspaces']
  const runtimeHook = ((selector: (snapshot: unknown) => unknown) =>
    selector(live.runtime ?? EMPTY_RUNTIME)) as unknown as McpScopeSectionProps['useRuntime']

  const props: McpScopeSectionProps = {
    close: () => {},
    t: t as unknown as McpScopeSectionProps['t'],
    useDoc: docHook,
    useWorkspaces: workspacesHook,
    addServer: addServer as unknown as McpScopeSectionProps['addServer'],
    replaceServer: replaceServer as unknown as McpScopeSectionProps['replaceServer'],
    removeServer: removeServer as unknown as McpScopeSectionProps['removeServer'],
    toggleWorkspace: toggleWorkspace as unknown as McpScopeSectionProps['toggleWorkspace'],
    toggleWorkspaces: toggleWorkspaces as unknown as McpScopeSectionProps['toggleWorkspaces'],
    toggleWorkspaceServers: toggleWorkspaceServers as unknown as McpScopeSectionProps['toggleWorkspaceServers'],
    restoreScopeValues: restoreScopeValues as unknown as McpScopeSectionProps['restoreScopeValues'],
    setServerEnabled: setServerEnabled as unknown as McpScopeSectionProps['setServerEnabled'],
    unsetCredential: unsetCredential as unknown as McpScopeSectionProps['unsetCredential'],
    useRuntime: runtimeHook,
    refreshRuntime,
    connectServer,
    disconnectServer,
    testServer,
    loadTools,
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(<McpScopeSection {...props} />)

  let unmounted = false
  const harness: Harness = {
    host,
    live,
    calls,
    missing,
    setDocStatus: (status: DocStatus) => {
      live.docStatus = status
      root.render(<McpScopeSection {...props} />)
    },
    rerender: () => root.render(<McpScopeSection {...props} />),
    commitDoc: (next: McpScopeDoc) => {
      live.doc = next
      live.revision += 1
      root.render(<McpScopeSection {...props} />)
    },
    unmount: () => {
      if (unmounted) return
      unmounted = true
      root.unmount()
      host.remove()
    },
    text: () => host.textContent ?? '',
  }
  mounted.push(harness)
  return harness
}

/** All buttons under one root, in document order. */
export function buttonsOf(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
}
