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
import { en, zh, type SettingsKey } from '../../src/client/locales.ts'
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

/** Regex source of a locale template: every placeholder becomes a number group. */
export function templatePattern(template: string): string {
  const escaped = template.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
  return escaped.replace(/\\\{(\w+)\\\}/g, '(\\d+)')
}

/** Every number captured by the template in one text (empty = not rendered). */
export function occurrencesOf(text: string, template: string): number[] {
  const re = new RegExp(templatePattern(template), 'g')
  return Array.from(text.matchAll(re), (match) => Number(match[1]))
}

/** First key whose zh text matches, or undefined when the frozen copy is absent. */
export function keyByZh(pattern: RegExp): SettingsKey | undefined {
  return (Object.keys(en) as SettingsKey[]).find((key) => pattern.test(zh[key] ?? ''))
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

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

export interface RecordedCalls {
  refresh: { silent?: boolean; server?: string }[]
  connect: string[]
  disconnect: string[]
  test: string[]
  tools: string[]
  /** Any document-writing action (settings write) the section was observed to call. */
  writes: string[]
}

export interface Actions {
  refreshRuntime?: (options?: { silent?: boolean; server?: string }) => Promise<void>
  addServer?: () => Promise<{ ok: boolean }>
  replaceServer?: () => Promise<{ ok: boolean }>
  removeServer?: () => Promise<{ ok: boolean }>
  toggleWorkspace?: () => Promise<{ ok: boolean }>
  toggleWorkspaces?: () => Promise<{ ok: boolean }>
  setServerEnabled?: () => Promise<{ ok: boolean }>
  unsetCredential?: () => Promise<{ ok: boolean }>
  connectServer?: (name: string) => Promise<unknown>
  disconnectServer?: (name: string) => Promise<unknown>
  testServer?: (name: string) => Promise<RuntimeTestResult>
  loadTools?: (name: string) => Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

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
}

export interface Harness {
  host: HTMLDivElement
  live: { doc: McpScopeDoc; revision: number; runtime?: RuntimeSnapshot }
  calls: RecordedCalls
  missing: string[]
  rerender(): void
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
  }
  const missing = options.missingKeys ?? []
  const dict = dictOf(options.locale)
  const t = makeT(dict, missing)
  const calls: RecordedCalls = { refresh: [], connect: [], disconnect: [], test: [], tools: [], writes: [] }
  const actions = options.actions ?? {}

  // Stable identities: a re-render must not look like a new store to the
  // section effects, or the "no extra request on re-render" assertion would be
  // testing the harness instead of the component.
  const refreshRuntime = async (refreshOptions?: { silent?: boolean; server?: string }): Promise<void> => {
    calls.refresh.push({ silent: refreshOptions?.silent, server: refreshOptions?.server })
    if (actions.refreshRuntime !== undefined) await actions.refreshRuntime(refreshOptions)
  }
  const addServer = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('addServer')
    return actions.addServer !== undefined ? actions.addServer() : { ok: true }
  }
  const replaceServer = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('replaceServer')
    return actions.replaceServer !== undefined ? actions.replaceServer() : { ok: true }
  }
  const removeServer = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('removeServer')
    return actions.removeServer !== undefined ? actions.removeServer() : { ok: true }
  }
  const toggleWorkspace = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('toggleWorkspace')
    return actions.toggleWorkspace !== undefined ? actions.toggleWorkspace() : { ok: true }
  }
  const toggleWorkspaces = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('toggleWorkspaces')
    return actions.toggleWorkspaces !== undefined ? actions.toggleWorkspaces() : { ok: true }
  }
  const setServerEnabled = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('setServerEnabled')
    return actions.setServerEnabled !== undefined ? actions.setServerEnabled() : { ok: true }
  }
  const unsetCredential = async (): Promise<{ ok: boolean }> => {
    calls.writes.push('unsetCredential')
    return actions.unsetCredential !== undefined ? actions.unsetCredential() : { ok: true }
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
      status: 'ready',
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
    rerender: () => root.render(<McpScopeSection {...props} />),
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

/** Accessible name as the a11y tree computes it (aria-label > title > text). */
export function accessibleName(element: Element): string {
  return [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.textContent,
  ]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ')
}

/**
 * Card element of one server: the element carrying the card-header id when the
 * shipped ids survive, otherwise the article whose text names the server.
 */
export function cardOf(host: HTMLElement, serverName: string): HTMLElement | undefined {
  const header = host.querySelector<HTMLElement>('[id="mcp-scope-card-' + serverName + '"]')
  if (header !== null) {
    return (header.closest('article') ?? header.parentElement ?? undefined) as HTMLElement | undefined
  }
  return Array.from(host.querySelectorAll<HTMLElement>('article')).find((card) =>
    (card.textContent ?? '').includes(serverName),
  )
}

/**
 * Workspace titles whose row is actually rendered: the title must be a leaf
 * text node and live inside an element that owns a checkbox (the row).
 */
export function renderedWorkspaceTitles(host: HTMLElement, titles: readonly string[]): string[] {
  return titles.filter((title) => {
    const node = Array.from(host.querySelectorAll<HTMLElement>('*')).find(
      (element) => element.children.length === 0 && (element.textContent ?? '').trim() === title,
    )
    if (node === undefined) return false
    const row = node.closest('li') ?? node.parentElement
    return row !== null && row.querySelector('input[type="checkbox"]') !== null
  })
}

/** The per-card status-refresh button of one card (its label is contract-discovered). */
export function perCardRefreshButton(card: HTMLElement, dict: Dictionary): HTMLButtonElement | undefined {
  const labels = Object.values(dict).filter((text) => /refresh|retry|刷新|重试/i.test(text))
  return buttonsOf(card).find((button) => {
    const name = accessibleName(button)
    return labels.some((label) => label !== '' && name.includes(label))
  })
}

/** Checkbox inputs inside one card box (workspace rows + the global enable switch). */
export function checkboxCount(root: ParentNode): number {
  return root.querySelectorAll('input[type="checkbox"]').length
}
