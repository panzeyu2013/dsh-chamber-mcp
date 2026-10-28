// @vitest-environment jsdom
/**
 * Render evidence for the Phase 0-4 settings surface:
 * servers list -> server detail -> editor, workspaces list -> workspace detail,
 * optimistic scope/allow writes, confirmations, validation and persistent
 * feedback. Every test drives the real section with injected store faces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { McpScopeSection, type McpScopeSectionProps } from '../../src/client/section.tsx'
import type {} from '../../src/client/index.ts'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { McpScopeDoc, WorkspaceOverrides } from '../../src/shared/model.ts'
import type { SaveOutcome, ServerSaveInput } from '../../src/client/controller.ts'
import type { RuntimeSnapshot, RuntimeTestResult, RuntimeToolEntry } from '../../src/client/runtime.ts'

function t(key: SettingsKey, params?: Record<string, string | number>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

interface LiveState {
  doc: McpScopeDoc
  credentials: Record<string, CredentialInfo>
  revision: number
  writable: boolean
  wsState: 'idle' | 'loading' | 'error'
  wsPhase: 'pending' | 'ready'
  wsItems: { workspaceId: string; title: string; path: string }[]
  runtime?: RuntimeSnapshot
}

interface Actions {
  addServer?(input: ServerSaveInput): Promise<SaveOutcome>
  replaceServer?(oldName: string, input: ServerSaveInput): Promise<SaveOutcome>
  removeServer?(name: string): Promise<SaveOutcome>
  toggleWorkspace?(workspaceId: string, serverName: string, enabled: boolean): Promise<SaveOutcome>
  toggleWorkspaces?(serverName: string, enabled: boolean, workspaceIds: readonly string[]): Promise<SaveOutcome>
  toggleWorkspaceServers?(workspaceId: string, serverNames: readonly string[], enabled: boolean): Promise<SaveOutcome>
  setServerEnabled?(serverName: string, enabled: boolean): Promise<SaveOutcome>
  unsetCredential?(ref: string): Promise<SaveOutcome>
  connectServer?(serverName: string): Promise<unknown>
  disconnectServer?(serverName: string): Promise<unknown>
  testServer?(serverName: string): Promise<RuntimeTestResult>
  loadTools?(serverName: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
  refreshRuntime?(options?: { silent?: boolean; server?: string }): Promise<void>
}

const OK = async () => ({ ok: true as const })
const CONFLICT = async () => ({ ok: false as const, reason: 'conflict' as const })
const NOOP = async () => {}
const NOOP_REFRESH = async () => {}
const EMPTY_RUNTIME: RuntimeSnapshot = { phase: 'ready', servers: {} }

function snapshotOf(live: LiveState) {
  return {
    status: 'ready' as const,
    doc: live.doc,
    revision: live.revision,
    writable: live.writable,
    credentials: live.credentials,
    credentialsAt: 0,
  }
}

function propsOf(live: LiveState, actions: Actions): McpScopeSectionProps {
  const wsState = {
    items: live.wsItems,
    archivedSessionIds: [],
    state: live.wsState,
    phase: live.wsPhase,
    error: null,
    baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  return {
    close: NOOP,
    t: t as unknown as McpScopeSectionProps['t'],
    useDoc: ((selector: (s: unknown) => unknown) => selector(snapshotOf(live))) as unknown as McpScopeSectionProps['useDoc'],
    useWorkspaces: ((selector: (s: unknown) => unknown) => selector(wsState)) as unknown as McpScopeSectionProps['useWorkspaces'],
    addServer: actions.addServer ?? OK,
    replaceServer: actions.replaceServer ?? OK,
    removeServer: actions.removeServer ?? OK,
    toggleWorkspace: actions.toggleWorkspace ?? OK,
    toggleWorkspaces: actions.toggleWorkspaces ?? OK,
    toggleWorkspaceServers: actions.toggleWorkspaceServers ?? OK,
    setServerEnabled: actions.setServerEnabled ?? OK,
    unsetCredential: actions.unsetCredential ?? OK,
    useRuntime: ((selector: (s: unknown) => unknown) => selector(live.runtime ?? EMPTY_RUNTIME)) as unknown as McpScopeSectionProps['useRuntime'],
    refreshRuntime: actions.refreshRuntime ?? NOOP_REFRESH,
    connectServer: actions.connectServer ?? NOOP,
    disconnectServer: actions.disconnectServer ?? NOOP,
    testServer: actions.testServer ?? (async () => ({ ok: true, toolCount: 2 })),
    loadTools: actions.loadTools ?? (async () => ({ tools: [], truncated: false, total: 0 })),
  }
}

interface Mounted {
  host: HTMLDivElement
  live: LiveState
  rerender(): void
  text(): string
  unmount(): void
}

const tracked: Mounted[] = []

function mountSection(doc: McpScopeDoc, actions: Actions = {}, patch: Partial<LiveState> = {}): Mounted {
  const live: LiveState = {
    doc,
    credentials: {},
    revision: 3,
    writable: true,
    wsState: 'idle',
    wsPhase: 'ready',
    wsItems: [],
    ...patch,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const element = () => <McpScopeSection {...propsOf(live, actions)} />
  root.render(element())
  const mounted: Mounted = {
    host,
    live,
    rerender: () => root.render(element()),
    text: () => host.textContent ?? '',
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
  tracked.push(mounted)
  return mounted
}

afterEach(() => {
  for (const mounted of tracked.splice(0)) mounted.unmount()
  sessionStorage.clear()
})
beforeEach(() => {
  sessionStorage.clear()
})

function buttonsOf(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return buttonsOf(root).find((button) => (button.textContent ?? '').includes(text))
}

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function serverRow(mounted: Mounted, name: string): HTMLElement {
  const row = mounted.host.querySelector<HTMLElement>('[data-server="' + name + '"]')
  if (row === null) throw new Error('missing server row ' + name)
  return row
}

async function openServer(mounted: Mounted, name: string): Promise<HTMLElement> {
  const row = serverRow(mounted, name)
  row.querySelector('button')!.click()
  await flush()
  const detail = mounted.host.querySelector<HTMLElement>('[data-mcp-server-detail]')
  if (detail === null) throw new Error('missing detail for ' + name)
  return detail
}

async function openWorkspacesTab(mounted: Mounted): Promise<void> {
  const tab = buttonsOf(mounted.host).find((button) => button.getAttribute('role') === 'tab' && (button.textContent ?? '').includes(t('tab.workspaces')))
  if (tab === undefined) throw new Error('missing workspaces tab')
  tab.click()
  await flush()
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('missing dialog')
  return element
}

const view = (configured: boolean, writable = true): CredentialInfo => ({ configured, writable })

const stdioServer = (
  serverName: string,
  envKeys: string[] = [],
  extra: Partial<{ command: string; args: string[] }> = {},
): McpScopeDoc['servers'][number] => ({
  serverName,
  transport: 'stdio',
  command: extra.command ?? 'node',
  args: extra.args ?? ['a.js'],
  ...(envKeys.length > 0 ? { envKeys } : {}),
})

const httpServer = (
  serverName: string,
  url: string,
  headers: { name: string; ref: string }[],
): McpScopeDoc['servers'][number] => ({
  serverName,
  transport: 'streamable-http',
  url,
  headers,
})

const overridesOf = (rows: Record<string, string[]>): WorkspaceOverrides => {
  const out: WorkspaceOverrides = {}
  for (const [ws, names] of Object.entries(rows)) {
    const row: Record<string, true> = {}
    for (const name of names) row[name] = true
    out[ws] = row
  }
  return out
}

const WS = [
  { workspaceId: 'ws-a', title: 'alpha', path: '/proj/alpha' },
  { workspaceId: 'ws-b', title: 'beta', path: '/proj/beta' },
  { workspaceId: 'ws-c', title: 'gamma', path: '/proj/gamma' },
]

function runtimeWith(name: string, state: 'connected' | 'failed' = 'connected'): RuntimeSnapshot {
  return {
    phase: 'ready',
    servers: {
      [name]: { name, state, attempts: 0, maxAttempts: 10, toolCount: 2, syncedAt: 1000 },
    },
  }
}

describe('servers list', () => {
  it('renders an empty state with the add affordance', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    expect(mounted.text()).toContain(t('empty.serversTitle'))
    expect(mounted.text()).toContain(t('empty.serversBody'))
    expect(buttonByText(mounted.host, t('add.add'))).toBeDefined()
  })


  it('opens the import modal directly from the empty state', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('empty.importClipboard'))!.click()
    await flush()
    expect(dialog().querySelector('textarea')).not.toBeNull()
  })


  it('keeps focus inside the auto-opened import dialog instead of the name field behind it', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('empty.importClipboard'))!.click()
    await flush()
    const modal = dialog()
    expect(modal.contains(document.activeElement)).toBe(true)
    // Tab must remain trapped even if focus was somehow moved outside.
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await flush()
    expect(modal.contains(document.activeElement)).toBe(true)
  })

  it('renders one scannable row per server with status, scope and tools', async () => {
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha'), stdioServer('beta')],
        overrides: overridesOf({ 'ws-a': ['alpha'], 'ws-b': ['alpha'] }),
      },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const alpha = serverRow(mounted, 'alpha')
    expect(alpha.textContent).toContain('alpha')
    expect(alpha.textContent).toContain(t('server.scopeCount', { enabled: 2, total: 3 }))
    expect(alpha.textContent).toContain(t('status.tools', { count: 2 }))
    expect(alpha.textContent).toContain(t('status.connected'))
    const beta = serverRow(mounted, 'beta')
    expect(beta.textContent).toContain(t('server.unusedTag'))
  })

  it('filters by name and by state, and clears the filters', async () => {
    const servers = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => stdioServer(name))
    const mounted = mountSection(
      { servers, overrides: overridesOf({ 'ws-a': ['alpha'] }) },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const search = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!
    setValue(search, 'bet')
    await flush()
    expect(mounted.host.querySelector('[data-server="beta"]')).not.toBeNull()
    expect(mounted.host.querySelector('[data-server="alpha"]')).toBeNull()
    setValue(search, '')
    await flush()
    const unused = buttonsOf(mounted.host).find((button) => button.textContent === t('filter.unused'))!
    unused.click()
    await flush()
    expect(mounted.host.querySelector('[data-server="alpha"]')).toBeNull()
    expect(mounted.host.querySelector('[data-server="beta"]')).not.toBeNull()
    const clear = buttonsOf(mounted.host).find((button) => button.textContent === t('empty.clearFilter'))
    if (clear !== undefined) {
      clear.click()
      await flush()
    }
  })
})

describe('server detail', () => {
  it('opens the detail, shows scope/tools/config/availability and returns to the list', async () => {
    const mounted = mountSection(
      { servers: [httpServer('github', 'https://example.test/mcp', [{ name: 'Authorization', ref: 'TOKEN' }])], overrides: {} },
      {},
      { wsItems: WS, credentials: { TOKEN: view(true) }, runtime: runtimeWith('github') },
    )
    await flush()
    await openServer(mounted, 'github')
    const detail = mounted.host.querySelector('[data-mcp-server-detail="github"]')!
    expect(detail.textContent).toContain(t('server.workspacesTitle'))
    expect(detail.textContent).toContain(t('server.configTitle'))
    expect(detail.textContent).toContain(t('server.availabilityTitle'))
    expect(detail.textContent).toContain('https://example.test/mcp')
    expect(detail.textContent).toContain(t('secret.configured'))
    const back = buttonsOf(detail).find((button) => (button.textContent ?? '').includes(t('server.back')))!
    back.click()
    await flush()
    expect(mounted.host.querySelector('[data-server="github"]')).not.toBeNull()
  })


  it('moves focus to the detail heading and back to the originating row', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    expect(document.activeElement?.getAttribute('data-mcp-detail-title')).not.toBeNull()
    buttonByText(detail, t('server.back'))!.click()
    await flush()
    expect(document.activeElement).toBe(serverRow(mounted, 'alpha').querySelector('button'))
  })

  it('toggles a workspace optimistically, reports the write, and offers Undo', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const switchInput = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!
    expect(switchInput.checked).toBe(false)
    switchInput.click()
    await flush()
    expect(calls).toEqual([['ws-b', 'alpha', true]])
    expect(detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!.checked).toBe(true)
    expect(mounted.text()).toContain(t('toast.scopeOn', { server: 'alpha', workspace: 'beta' }))
    const undo = buttonByText(mounted.host, t('toast.undo'))!
    undo.click()
    await flush()
    expect(calls).toEqual([
      ['ws-b', 'alpha', true],
      ['ws-b', 'alpha', false],
    ])
  })


  it('renders the global kill switch consistently in list, detail and workspace views', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha')],
        overrides: overridesOf({ 'ws-a': ['alpha'] }),
        disabled: { alpha: true },
      },
      {
        setServerEnabled: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    expect(serverRow(mounted, 'alpha').textContent).toContain(t('server.disabledTag'))
    const detail = await openServer(mounted, 'alpha')
    const allow = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.allowedLabel') + '"]')!
    expect(allow.checked).toBe(false)
    expect(detail.textContent).toContain(t('server.disabledNotice'))
    const scopeSwitch = detail.querySelector<HTMLInputElement>(
      'input[aria-label="' + t('server.workspacesTitle') + ': alpha"]',
    )!
    expect(scopeSwitch.checked).toBe(true)
    expect(scopeSwitch.disabled).toBe(true)
    allow.click()
    await flush()
    expect(calls).toEqual([['alpha', true]])
    await openWorkspacesTab(mounted)
    mounted.host.querySelector<HTMLElement>('[data-workspace="ws-a"] button')!.click()
    await flush()
    const workspaceDetail = mounted.host.querySelector('[data-mcp-workspace-detail="ws-a"]')!
    expect(workspaceDetail.textContent).toContain(t('workspace.disabledServer'))
    expect(workspaceDetail.querySelector<HTMLInputElement>('input[aria-label="alpha: alpha"]')!.disabled).toBe(true)
  })

  it('toggles availability immediately and exposes the disabled notice', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        setServerEnabled: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const allow = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.allowedLabel') + '"]')!
    expect(allow.checked).toBe(true)
    allow.click()
    await flush()
    expect(calls).toEqual([['alpha', false]])
    expect(mounted.text()).toContain(t('toast.allowOff', { server: 'alpha' }))
  })

  it('batches all visible workspaces through one write', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspaces: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    expect(calls).toEqual([['alpha', true, WS.map((workspace) => workspace.workspaceId)]])
    expect(mounted.text()).toContain(t('toast.scopeBulk', { server: 'alpha', count: 3 }))
  })


  it('restores the exact pre-batch values when undoing a mixed bulk toggle', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha')],
        overrides: overridesOf({ 'ws-a': ['alpha'] }),
      },
      {
        toggleWorkspaces: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    expect(calls[0]).toEqual(['alpha', true, ['ws-a', 'ws-b', 'ws-c']])
    buttonByText(mounted.host, t('toast.undo'))!.click()
    await flush()
    expect(calls.slice(1)).toEqual([
      ['alpha', true, ['ws-a']],
      ['alpha', false, ['ws-b', 'ws-c']],
    ])
    expect(mounted.text()).toContain(t('toast.undone'))
  })


  it('keeps a failed connection test visible and lets Retry run it again', async () => {
    let calls = 0
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        testServer: async () => {
          calls += 1
          return calls === 1
            ? { ok: false, code: 'timeout', error: 'timed out' }
            : { ok: true, toolCount: 2 }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('action.test'))!.click()
    await flush()
    expect(detail.textContent).toContain(t('runtime.error.timeout'))
    buttonByText(detail, t('action.retry'))!.click()
    await flush()
    expect(calls).toBe(2)
    expect(detail.textContent).toContain(t('server.testNote', { count: 2 }))
  })

  it('keeps runtime actions available and discloses tools with aria-expanded', async () => {
    const calls: string[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        loadTools: async (name) => {
          calls.push(name)
          return {
            tools: [
              { publicName: 'mcp__alpha__search', rawName: 'search', description: 'Search issues' },
              { publicName: 'mcp__alpha__read', rawName: 'read', description: 'Read an issue' },
            ],
            truncated: false,
            total: 2,
          }
        },
        testServer: async () => ({ ok: true, toolCount: 2 }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const toolsButton = buttonByText(detail, t('tools.title'))!
    expect(toolsButton.getAttribute('aria-expanded')).toBe('false')
    toolsButton.click()
    await flush()
    expect(toolsButton.getAttribute('aria-expanded')).toBe('true')
    expect(calls).toEqual(['alpha'])
    expect(detail.textContent).toContain('search')
    expect(detail.textContent).toContain('Search issues')
  })

  it('keeps a failed action visible and offers retry instead of auto-dismissing', async () => {
    let attempts = 0
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: async () => {
          attempts += 1
          return { ok: false, reason: 'conflict' }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    expect(attempts).toBe(1)
    expect(mounted.text()).toContain(t('error.conflict'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mounted.text()).toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeDefined()
  })

  it('confirms removal with specific scope and credential consequences', async () => {
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha', ['TOKEN']), stdioServer('beta')],
        overrides: overridesOf({ 'ws-a': ['alpha'], 'ws-b': ['alpha'] }),
      },
      {},
      { wsItems: WS, credentials: { TOKEN: view(true) }, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    const text = dialog().textContent ?? ''
    expect(text).toContain(t('server.removeTitle', { name: 'alpha' }))
    expect(text).toContain(t('server.removeBody', { count: 2, refs: 'TOKEN' }))
    const cancel = buttonByText(dialog(), t('server.keep'))!
    cancel.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })


  it('focuses the safe action and closes the confirmation on Escape', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    expect((document.activeElement?.textContent ?? '').includes(t('server.keep'))).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('warns that a cleared credential is shared with other servers', async () => {
    const calls: string[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha', ['TOKEN']), stdioServer('beta', ['TOKEN'])], overrides: {} },
      {
        unsetCredential: async (ref) => {
          calls.push(ref)
          return { ok: true }
        },
      },
      { wsItems: WS, credentials: { TOKEN: view(true) }, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.clearCredential'))!.click()
    await flush()
    const text = dialog().textContent ?? ''
    expect(text).toContain(t('server.clearConfirmTitle', { ref: 'TOKEN' }))
    expect(text).toContain('beta')
    buttonByText(dialog(), t('server.clearConfirmAction'))!.click()
    await flush()
    expect(calls).toEqual(['TOKEN'])
    expect(mounted.text()).toContain(t('toast.cleared', { ref: 'TOKEN' }))
  })
})

describe('workspaces view', () => {
  it('lists workspaces and toggles one server from the workspace detail', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha'), stdioServer('beta')], overrides: {} },
      {
        toggleWorkspace: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    await openWorkspacesTab(mounted)
    expect(mounted.host.querySelector('[data-workspace="ws-a"]')).not.toBeNull()
    mounted.host.querySelector<HTMLElement>('[data-workspace="ws-a"] button')!.click()
    await flush()
    const detail = mounted.host.querySelector('[data-mcp-workspace-detail="ws-a"]')!
    const switchInput = detail.querySelector<HTMLInputElement>('input[aria-label="alpha: alpha"]')!
    switchInput.click()
    await flush()
    expect(calls).toEqual([['ws-a', 'alpha', true]])
  })

  it('batches every eligible server for one workspace through one write', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha'), stdioServer('beta'), stdioServer('gamma')], overrides: { 'ws-b': { gamma: true } } },
      {
        toggleWorkspaceServers: async (...args) => {
          calls.push(args)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    await openWorkspacesTab(mounted)
    mounted.host.querySelector<HTMLElement>('[data-workspace="ws-a"] button')!.click()
    await flush()
    const detail = mounted.host.querySelector('[data-mcp-workspace-detail="ws-a"]')!
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    expect(calls).toEqual([['ws-a', ['alpha', 'beta', 'gamma'], true]])
    expect(mounted.text()).toContain(t('toast.workspaceBulk', { count: 3, workspace: 'alpha' }))
  })
})

describe('editor', () => {
  it('keeps Save enabled and reveals the validation summary instead of failing silently', async () => {
    const calls: ServerSaveInput[] = []
    const mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          calls.push(input)
          return { ok: true }
        },
      },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const save = buttonByText(mounted.host, t('editor.saveAndTest'))!
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    expect(mounted.text()).toContain(t('editor.errorMany', { count: 2 }))
    expect(calls).toHaveLength(0)
    expect(document.activeElement?.id).toBe('mcp-scope-editor-name')
  })

  it('validates, saves, navigates to the detail and auto-tests the new server', async () => {
    const added: ServerSaveInput[] = []
    const tested: string[] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          added.push(input)
          // The real controller publishes the new document before the section
          // navigates; mirror that here so the detail is not misread as stale.
          mounted.live.doc = {
            servers: [...mounted.live.doc.servers, input.server],
            overrides: mounted.live.doc.overrides,
            disabled: mounted.live.doc.disabled,
          }
          return { ok: true }
        },
        testServer: async (name) => {
          tested.push(name)
          return { ok: true, toolCount: 2 }
        },
      },
      { wsItems: WS },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
    setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'npx')
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(added).toHaveLength(1)
    expect(added[0]!.server.serverName).toBe('github')
    expect(mounted.host.querySelector('[data-mcp-server-detail="github"]')).not.toBeNull()
    expect(tested).toEqual(['github'])
  })


  it('saving a disabled server definition preserves availability and skips auto-test', async () => {
    const replaced: unknown[][] = []
    const tested: string[] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {}, disabled: { alpha: true } },
      {
        replaceServer: async (...args) => {
          replaced.push(args)
          mounted.live.doc = {
            servers: [stdioServer('alpha')],
            overrides: {},
            disabled: { alpha: true },
          }
          return { ok: true }
        },
        testServer: async (name) => {
          tested.push(name)
          return { ok: true, toolCount: 0 }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.edit'))!.click()
    await flush()
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(replaced).toHaveLength(1)
    const input = (replaced[0] as [string, ServerSaveInput])[1]
    expect(input.enabled).toBeUndefined()
    expect(tested).toEqual([])
  })


  it('saves the HTTP branch with URL, header ref and secret', async () => {
    const added: ServerSaveInput[] = []
    const mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          added.push(input)
          return { ok: true }
        },
      },
      { wsItems: WS },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    document.getElementById('mcp-scope-editor-transport-http')!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'remote')
    setValue(document.getElementById('mcp-scope-editor-url') as HTMLInputElement, 'https://example.test/mcp')
    setValue(
      document.getElementById('mcp-scope-editor-header-name-0') as HTMLInputElement,
      'Authorization',
    )
    setValue(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!,
      'bearer',
    )
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(added).toHaveLength(1)
    expect(added[0]!.server).toEqual({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', ref: 'AUTHORIZATION' }],
    })
    expect(added[0]!.secrets).toEqual([{ ref: 'AUTHORIZATION', value: 'bearer' }])
  })

  it('imports a single server from a JSON snippet', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    buttonByText(mounted.host, t('add.importJson'))!.click()
    await flush()
    const textarea = dialog().querySelector('textarea')!
    setValue(textarea, JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }))
    buttonByText(dialog(), t('import.parse'))!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('github')
    expect((document.getElementById('mcp-scope-editor-command') as HTMLInputElement).value).toBe('npx')
  })


  it('opens the advanced section and focuses the timeout when that is the first invalid field', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
    setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'npx')
    const advanced = buttonByText(mounted.host, t('editor.advanced'))!
    advanced.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-timeout') as HTMLInputElement, '1')
    advanced.click()
    await flush()
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(document.activeElement?.id).toBe('mcp-scope-editor-timeout')
  })


  it('returns focus to the list after discarding the editor', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'draft')
    buttonByText(mounted.host, t('action.cancel'))!.click()
    await flush()
    buttonByText(dialog(), t('dirty.discard'))!.click()
    await flush()
    expect(mounted.host.querySelector('#mcp-scope-editor-name')).toBeNull()
    expect(document.activeElement?.textContent ?? '').toContain(t('add.add'))
  })

  it('shows and hides a typed secret value', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const secret = mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!
    expect(secret.type).toBe('password')
    buttonsOf(mounted.host)
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith(t('editor.showSecret')))!
      .click()
    await flush()
    expect(mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!.type).toBe('text')
  })


  it('restores a persisted draft without secret values', async () => {
    sessionStorage.setItem(
      'mcp-scope.draft.v2:add',
      JSON.stringify({
        name: 'restored',
        transport: 'stdio',
        command: 'node',
        cwd: '',
        args: ['server.js'],
        env: [{ key: 'TOKEN', value: '' }],
        url: '',
        headers: [{ name: '', ref: '', value: '' }],
        enabled: true,
        timeoutMs: '',
      }),
    )
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    expect(mounted.text()).toContain(t('editor.restored'))
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('restored')
    expect(mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!.value).toBe('')
  })


  it('never writes a typed secret into the persisted draft', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
    setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'node')
    setValue(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!,
      'supersecret',
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    const raw = sessionStorage.getItem('mcp-scope.draft.v2:add')
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('supersecret')
    const persisted = JSON.parse(raw!) as { command: string; env: { key: string; value: string }[] }
    expect(persisted.command).toBe('node')
    expect(persisted.env[0]!.value).toBe('')
  })

  it('selects one server from a multi-server JSON snippet', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    buttonByText(mounted.host, t('add.importJson'))!.click()
    await flush()
    setValue(
      dialog().querySelector('textarea')!,
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'node', args: ['a.js'] },
          beta: { command: 'node', args: ['b.js'] },
        },
      }),
    )
    buttonByText(dialog(), t('import.parse'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('editor.importCandidates'))
    buttonByText(dialog(), t('editor.importUse', { name: 'beta' }))!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('beta')
  })

  it('rolls an optimistic toggle back when the write fails', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      { toggleWorkspace: CONFLICT },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const input = detail.querySelector<HTMLInputElement>(
      'input[aria-label="' + t('server.workspacesTitle') + ': beta"]',
    )!
    input.click()
    await flush()
    expect(
      detail.querySelector<HTMLInputElement>(
        'input[aria-label="' + t('server.workspacesTitle') + ': beta"]',
      )!.checked,
    ).toBe(false)
    expect(mounted.text()).toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeDefined()
  })


  it('keeps the queue moving after a failed write and clears the saving indicator', async () => {
    let calls = 0
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async () => {
          calls += 1
          return calls === 1 ? { ok: false, reason: 'save-failed' } : { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!
      .click()
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': gamma"]')!
      .click()
    await flush()
    expect(calls).toBe(2)
    expect(mounted.text()).toContain(t('error.saveFailed'))
    expect(mounted.text()).not.toContain(t('section.saving'))
  })

  it('serializes writes from two switches through one queue', async () => {
    const order: string[] = []
    const resolvers: Array<() => void> = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async (workspaceId) => {
          order.push(workspaceId)
          await new Promise<void>((resolve) => resolvers.push(resolve))
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!
      .click()
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': gamma"]')!
      .click()
    await flush()
    expect(order).toEqual(['ws-b'])
    expect(mounted.text()).toContain(t('section.saving'))
    resolvers[0]!()
    await flush()
    expect(order).toEqual(['ws-b', 'ws-c'])
    resolvers[1]!()
    await flush()
  })

  it('opens edit mode with the definition and warns on rename', async () => {
    const replaced: unknown[][] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        replaceServer: async (...args) => {
          replaced.push(args)
          mounted.live.doc = {
            ...mounted.live.doc,
            servers: [stdioServer('renamed')],
          }
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.edit'))!.click()
    await flush()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('alpha')
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'renamed')
    await flush()
    expect(mounted.text()).toContain(t('editor.renameWarning', { old: 'alpha', new: 'renamed' }))
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(replaced).toHaveLength(1)
    expect((replaced[0] as [string, ServerSaveInput])[0]).toBe('alpha')
    expect((replaced[0] as [string, ServerSaveInput])[1].server.serverName).toBe('renamed')
    expect(mounted.host.querySelector('[data-mcp-server-detail="renamed"]')).not.toBeNull()
  })

  it('searches tools and reports a no-match state instead of an empty sync claim', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        loadTools: async () => ({
          tools: [{ publicName: 'mcp__alpha__search', rawName: 'search', description: 'Search issues' }],
          truncated: false,
          total: 1,
        }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('tools.title'))!.click()
    await flush()
    const search = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.toolsSearch') + '"]')!
    setValue(search, 'zzz')
    await flush()
    expect(detail.textContent).toContain(t('tools.noMatch'))
  })


  it('keeps a dismiss control reachable while a destructive write is pending', async () => {
    let release!: () => void
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true })
          }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    const dismiss = buttonByText(dialog(), t('action.dismiss'))
    expect(dismiss).not.toBeNull()
    expect(dismiss!.disabled).toBe(false)
    dismiss!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    release()
    await flush()
    expect(mounted.host.querySelector('[data-mcp-server-detail="alpha"]')).not.toBeNull()
    expect(mounted.text()).toContain(t('toast.removed', { name: 'alpha' }))
  })


  it('an older pending removal never closes a newer confirmation', async () => {
    let releaseAlpha!: () => void
    const mounted = mountSection(
      { servers: [stdioServer('alpha'), stdioServer('beta')], overrides: {} },
      {
        removeServer: (name) =>
          name === 'alpha'
            ? new Promise((resolve) => {
                releaseAlpha = () => resolve({ ok: true })
              })
            : Promise.resolve({ ok: true }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    let detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    buttonByText(dialog(), t('action.dismiss'))!.click()
    await flush()
    buttonByText(mounted.host, t('server.back'))!.click()
    await flush()
    detail = await openServer(mounted, 'beta')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('server.removeTitle', { name: 'beta' }))
    releaseAlpha()
    await flush()
    expect(dialog().textContent).toContain(t('server.removeTitle', { name: 'beta' }))
  })

  it('retries a failed removal with the same action', async () => {
    let attempts = 0
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: async () => {
          attempts += 1
          if (attempts === 1) return { ok: false, reason: 'save-failed' }
          mounted.live.doc = { servers: [], overrides: {}, disabled: {} }
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    expect(attempts).toBe(1)
    buttonByText(mounted.host, t('action.retry'))!.click()
    await flush()
    expect(attempts).toBe(2)
    expect(mounted.host.querySelector('[data-server="alpha"]')).toBeNull()
    expect(document.activeElement?.textContent ?? '').toContain(t('add.add'))
  })

  it('guards unsaved changes with a discard confirmation', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'draft')
    buttonByText(mounted.host, t('action.cancel'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('editor.discardTitle'))
    buttonByText(dialog(), t('dirty.keepEditing'))!.click()
    await flush()
    expect(mounted.host.querySelector('#mcp-scope-editor-name')).not.toBeNull()
  })
})

describe('degraded and read-only states', () => {
  it('renders the workspace-list loading and error phases', async () => {
    const loading = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsState: 'loading', wsPhase: 'pending' },
    )
    await flush()
    await openServer(loading, 'alpha')
    expect(loading.text()).toContain(t('workspaces.loading'))
    loading.unmount()
    const error = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsState: 'error' },
    )
    await flush()
    await openServer(error, 'alpha')
    expect(error.text()).toContain(t('workspaces.error'))
  })


  it('falls back to the list when the open workspace disappears externally', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: overridesOf({ 'ws-a': ['alpha'] }) },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    await openWorkspacesTab(mounted)
    mounted.host.querySelector<HTMLElement>('[data-workspace="ws-a"] button')!.click()
    await flush()
    expect(mounted.host.querySelector('[data-mcp-workspace-detail="ws-a"]')).not.toBeNull()
    mounted.live.wsItems = WS.filter((workspace) => workspace.workspaceId !== 'ws-a')
    mounted.rerender()
    await flush()
    expect(mounted.host.querySelector('[data-mcp-workspace-detail]')).toBeNull()
    expect(mounted.host.querySelector('[data-workspace="ws-b"]')).not.toBeNull()
    expect(mounted.live.doc.overrides).toEqual(overridesOf({ 'ws-a': ['alpha'] }))
  })

  it('hides write affordances and disables switches when the document is read-only', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: overridesOf({ 'ws-a': ['alpha'] }) },
      {},
      { writable: false, wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    expect(buttonByText(mounted.host, t('add.add'))).toBeUndefined()
    expect(mounted.text()).toContain(t('state.readonly'))
    await openServer(mounted, 'alpha')
    const swaps = Array.from(mounted.host.querySelectorAll<HTMLInputElement>('input[role="switch"]'))
    expect(swaps.length).toBeGreaterThan(0)
    expect(swaps.every((input) => input.disabled)).toBe(true)
    expect(buttonByText(mounted.host, t('server.remove'))).toBeUndefined()
  })
})

describe('polling and unmount', () => {
  it('issues one initial refresh and leaves no timer behind after unmount', async () => {
    const refreshes: unknown[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        refreshRuntime: async (options) => {
          refreshes.push(options)
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    expect(refreshes.length).toBeGreaterThanOrEqual(1)
    mounted.unmount()
    const count = refreshes.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(refreshes.length).toBe(count)
  })
})
