// @vitest-environment jsdom
// Render evidence for the MCP section UI: the settings.section component
// renders server cards, per-workspace rows and the staged add/edit form from
// a live store snapshot, with all copy arriving through the locale seat (en
// dictionary). Live-harness tests exercise the real async flows end to end:
// per-card action failures surface as role="alert" banners inside the card,
// a successful add/edit announces through a role="status" note near the list
// and moves focus to the affected card header, and the workspace-list
// loading/error phases gate the per-card rows.
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { McpScopeSection, type McpScopeSectionProps } from '../../src/client/section.tsx'
// pull the slot/locale module augmentations (register-site decls) into this program
import type {} from '../../src/client/index.ts'
import { en, zh, countKey, type SettingsKey } from '../../src/client/locales.ts'
import { styles } from '../../src/client/styles.ts'
import { EMPTY_DRAFT, evaluateDraft } from '../../src/client/add-form.tsx'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { McpScopeDoc, WorkspaceOverrides } from '../../src/shared/model.ts'
import type { SaveOutcome, ServerSaveInput } from '../../src/client/controller.ts'
import type {
  RuntimeSnapshot,
  RuntimeTestResult,
  RuntimeToolEntry,
  ServerRuntimeView,
} from '../../src/client/runtime.ts'

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
  wsItems: { workspaceId: string; title: string }[]
  runtime?: RuntimeSnapshot
}

interface Actions {
  addServer?(input: ServerSaveInput): Promise<SaveOutcome>
  replaceServer?(oldName: string, input: ServerSaveInput): Promise<SaveOutcome>
  removeServer?(name: string): Promise<SaveOutcome>
  toggleWorkspace?(workspaceId: string, serverName: string, enabled: boolean): Promise<SaveOutcome>
  toggleWorkspaces?(serverName: string, enabled: boolean, workspaceIds: readonly string[]): Promise<SaveOutcome>
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

function snapshotOf(live: LiveState): {
  status: 'ready'
  doc: McpScopeDoc
  revision: number
  writable: boolean
  credentials: Record<string, CredentialInfo>
  credentialsAt: number
} {
  return { status: 'ready', doc: live.doc, revision: live.revision, writable: live.writable, credentials: live.credentials, credentialsAt: 0 }
}

const NOOP = async () => {}
const NOOP_REFRESH = async () => {}
const EMPTY_RUNTIME: RuntimeSnapshot = { phase: 'ready', servers: {} }

// Test-only casts: the composed props re-state framework types that collapse
// to opaque cross-package shapes in this dev tree (see docs/design.md §7).
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
    setServerEnabled: actions.setServerEnabled ?? OK,
    unsetCredential: actions.unsetCredential ?? OK,
    useRuntime: ((selector: (s: unknown) => unknown) =>
      selector(live.runtime ?? EMPTY_RUNTIME)) as unknown as McpScopeSectionProps['useRuntime'],
    refreshRuntime: actions.refreshRuntime ?? NOOP_REFRESH,
    connectServer: actions.connectServer ?? NOOP,
    disconnectServer: actions.disconnectServer ?? NOOP,
    testServer: actions.testServer ?? (async () => ({ ok: true })),
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

const tracked: Mounted[] = []
afterEach(() => {
  for (const mounted of tracked.splice(0)) mounted.unmount()
})

function buttonsOf(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll('button'))
}

function buttonByText(host: HTMLElement, text: string): HTMLElement | undefined {
  return buttonsOf(host).find((button) => (button.textContent ?? '').includes(text))
}

/** Set an input's value through the native setter (React onChange sees it). */
function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function inputById(host: HTMLElement, id: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)
  if (input === null) throw new Error(`missing input #${id}`)
  return input
}

const view = (configured: boolean, writable = true): CredentialInfo => ({ configured, writable })

const stdioServer = (serverName: string, envKeys: string[] = [], extra: Partial<{ command: string; args: string[] }> = {}): ServerDefLike => ({
  serverName,
  transport: 'stdio',
  command: extra.command ?? 'node',
  args: extra.args ?? ['a.js'],
  ...(envKeys.length > 0 ? { envKeys } : {}),
})

const httpServer = (serverName: string, url: string, headers: { name: string; ref: string }[]): ServerDefLike => ({
  serverName,
  transport: 'streamable-http',
  url,
  headers,
})

type ServerDefLike = McpScopeDoc['servers'][number]

const overridesOf = (rows: Record<string, string[]>): WorkspaceOverrides => {
  const out: WorkspaceOverrides = {}
  for (const [ws, names] of Object.entries(rows)) {
    const row: Record<string, true> = {}
    for (const name of names) row[name] = true
    out[ws] = row
  }
  return out
}

describe('McpScopeSection render', () => {
  it('renders the section header, empty state and the add-server affordance', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    expect(mounted.text()).toContain(en.nav)
    expect(mounted.text()).toContain(en['empty.servers'])
    expect(mounted.text()).toContain(en['add.add'])
  })

  it('renders server cards with pluralized summaries, definition details, badge tri-state and workspace rows', async () => {
    const doc: McpScopeDoc = {
      servers: [
        stdioServer('fixture', ['TOK'], { command: 'node', args: ['a.js', '--x'] }),
        httpServer('ctx', 'http://x/mcp', [{ name: 'Authorization', ref: 'AUTH' }]),
      ],
      overrides: overridesOf({ 'ws-b': ['fixture'] }),
    }
    const mounted = mountSection(doc, {}, {
      wsItems: [
        { workspaceId: 'ws-a', title: 'alpha' },
        { workspaceId: 'ws-b', title: 'beta' },
      ],
    })
    await flush()
    const text = mounted.text()
    // card identities + transports
    expect(text).toContain('fixture')
    expect(text).toContain('ctx')
    expect(text).toContain(en['transport.stdio'])
    expect(text).toContain(en['transport.http'])
    // singular plural forms for count 1
    expect(text).toContain(t(countKey('server.envKeys', 1), { count: 1 })) // '1 env key'
    expect(text).toContain(t(countKey('server.headers', 1), { count: 1 })) // '1 header'
    expect(text).toContain(t(countKey('server.enabledWorkspaces', 1), { count: 1 })) // 'On in 1 workspace'
    // the never-enabled server reports the off-by-default state
    expect(text).toContain(en['server.notEnabled'])
    // definition details (UX-04): command + args line and http url
    expect(text).toContain('node a.js --x')
    expect(text).toContain('http://x/mcp')
    // header names ride the badge rows
    expect(text).toContain('Authorization')
    expect(text).toContain('AUTH')
    // workspace rows: ENABLED workspaces only — ws-b enables fixture, so ONLY
    // that row renders; ws-a (default off) stays collapsed away.
    expect(text).toContain('beta')
    expect(text).not.toContain('alpha')
    expect(text).toContain(en['row.on'])
    expect(text).toContain(t('row.manage', { count: 1 }))
    // a card with zero enabled workspaces summarizes instead of listing them
    expect(text).toContain(t(countKey('row.allOffDefault', 2), { count: 2 }))
    // no describe has run: badges are neutral 'unknown', not 'Not configured'
    expect(text).toContain(en['secret.unknown'])
    expect(text).not.toContain(en['secret.unset'])
    expect(text).not.toContain(en['secret.clear'])
  })

  it('pluralizes multi-count summaries and renders configured/unset badge states from describe views', async () => {
    const doc: McpScopeDoc = {
      servers: [stdioServer('multi', ['TOK', 'KEY2'])],
      overrides: overridesOf({ 'ws-a': ['multi'], 'ws-b': ['multi'] }),
    }
    const mounted = mountSection(
      doc,
      {},
      {
        credentials: { TOK: view(true), KEY2: view(false) },
        wsItems: [
          { workspaceId: 'ws-a', title: 'alpha' },
          { workspaceId: 'ws-b', title: 'beta' },
        ],
      },
    )
    await flush()
    const text = mounted.text()
    expect(text).toContain(t(countKey('server.envKeys', 2), { count: 2 })) // '2 env keys'
    expect(text).toContain(t(countKey('server.enabledWorkspaces', 2), { count: 2 })) // 'On in 2 workspaces'
    // both enabled workspaces are the collapsed card's exception rows
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain(en['secret.configured'])
    expect(text).toContain(en['secret.unset'])
    expect(text).toContain(en['secret.clear']) // only the configured ref is clearable
  })

  it('surfaces the workspace-list loading and error phases instead of "no workspaces"', async () => {
    const doc: McpScopeDoc = { servers: [stdioServer('solo', ['TOK'])], overrides: {} }
    const loading = mountSection(doc, {}, { wsState: 'loading', wsPhase: 'pending', wsItems: [] })
    await flush()
    expect(loading.text()).toContain(en['workspaces.loading'])
    expect(loading.text()).not.toContain(en['workspaces.empty'])
    // The workspace list is not ready, so neither enablement summary renders.
    expect(loading.text()).not.toContain(en['server.notEnabled'])
    expect(loading.text()).not.toContain(t(countKey('server.enabledWorkspaces', 1), { count: 1 }))
    loading.unmount()
    const failed = mountSection(doc, {}, { wsState: 'error', wsPhase: 'ready', wsItems: [] })
    await flush()
    expect(failed.text()).toContain(en['workspaces.error'])
    expect(failed.text()).not.toContain(en['workspaces.empty'])
    expect(failed.text()).not.toContain(en['server.notEnabled'])
    // settled list with zero workspaces is the only "empty" case
    failed.unmount()
    const empty = mountSection(doc, {}, { wsState: 'idle', wsPhase: 'ready', wsItems: [] })
    await flush()
    expect(empty.text()).toContain(en['workspaces.empty'])
  })

  it('shows a per-card role="alert" banner when a card action fails (not a section-top notice)', async () => {
    const doc: McpScopeDoc = {
      servers: [stdioServer('a', ['TOK'])],
      // ws-1 explicitly ENABLES 'a', so its row is visible while collapsed
      overrides: overridesOf({ 'ws-1': ['a'] }),
    }
    const mounted = mountSection(
      doc,
      { toggleWorkspace: CONFLICT },
      { wsItems: [{ workspaceId: 'ws-1', title: 'work' }] },
    )
    await flush()
    expect(mounted.text()).not.toContain(en['error.conflict'])
    // The card's first switch is the global enable toggle; this test targets
    // the per-workspace row by id.
    const switchInput = mounted.host.querySelector<HTMLInputElement>('#mcp-scope-a-ws-1')
    if (switchInput === null) throw new Error('missing workspace switch')
    switchInput.click()
    await flush()
    const alerts = Array.from(mounted.host.querySelectorAll('[role="alert"]'))
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.textContent).toContain(en['error.conflict'])
  })

  it('toggles a server globally and renders the disabled state from the document', async () => {
    const calls: { name: string; enabled: boolean }[] = []
    const doc: McpScopeDoc = {
      servers: [stdioServer('a')],
      overrides: {},
      disabled: { a: true },
    }
    const mounted = mountSection(doc, {
      setServerEnabled: async (name, enabled) => {
        calls.push({ name, enabled })
        return { ok: true }
      },
    })
    await flush()
    expect(mounted.text()).toContain(en['server.disabledTag'])
    const toggle = mounted.host.querySelector<HTMLInputElement>('#mcp-scope-enable-a')
    if (toggle === null) throw new Error('missing enable toggle')
    expect(toggle.checked).toBe(false)
    toggle.click()
    await flush()
    expect(calls).toEqual([{ name: 'a', enabled: true }])
  })

  it('batches per-workspace switches through the card\'s all-on/all-off controls', async () => {
    const calls: { enabled: boolean; ids: readonly string[] }[] = []
    const doc: McpScopeDoc = { servers: [stdioServer('a')], overrides: {} }
    const mounted = mountSection(
      doc,
      {
        toggleWorkspaces: async (_name, enabled, ids) => {
          calls.push({ enabled, ids })
          return { ok: true }
        },
      },
      {
        wsItems: [
          { workspaceId: 'ws-1', title: 'one' },
          { workspaceId: 'ws-2', title: 'two' },
        ],
      },
    )
    await flush()
    // The bulk switches live in the expanded (all-rows) view.
    buttonByText(mounted.host, t('row.manage', { count: 0 }))!.click()
    await flush()
    buttonByText(mounted.host, en['row.allOn'])!.click()
    await flush()
    buttonByText(mounted.host, en['row.allOff'])!.click()
    await flush()
    expect(calls).toEqual([
      { enabled: true, ids: ['ws-1', 'ws-2'] },
      { enabled: false, ids: ['ws-1', 'ws-2'] },
    ])
  })

  it('filters the card list by server name', async () => {
    const doc: McpScopeDoc = {
      servers: [stdioServer('alpha'), stdioServer('beta')],
      overrides: {},
    }
    const mounted = mountSection(doc)
    await flush()
    const search = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')
    if (search === null) throw new Error('missing search input')
    setValue(search, 'alp')
    await flush()
    expect(mounted.text()).toContain('alpha')
    expect(mounted.text()).not.toContain('beta')
    setValue(search, 'nope')
    await flush()
    expect(mounted.text()).toContain(t('search.none', { query: 'nope' }))
  })

  it('guards unsaved form changes behind an inline discard confirmation', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    // A pristine form closes directly.
    buttonByText(mounted.host, en['action.cancel'])!.click()
    await flush()
    expect(mounted.host.querySelector('form')).toBeNull()

    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    setValue(inputById(mounted.host, 'mcp-scope-add-name'), 'typed')
    await flush()
    buttonByText(mounted.host, en['action.cancel'])!.click()
    await flush()
    // Dirty: the form stays and asks.
    expect(mounted.host.querySelector('form')).not.toBeNull()
    expect(mounted.text()).toContain(en['dirty.confirm'])
    buttonByText(mounted.host, en['dirty.keepEditing'])!.click()
    await flush()
    expect(mounted.host.querySelector('form')).not.toBeNull()
    expect(mounted.text()).not.toContain(en['dirty.confirm'])
    buttonByText(mounted.host, en['action.cancel'])!.click()
    await flush()
    buttonByText(mounted.host, en['dirty.discard'])!.click()
    await flush()
    expect(mounted.host.querySelector('form')).toBeNull()
  })

  it('imports one server from a pasted JSON snippet into the staged form', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    buttonByText(mounted.host, en['add.importJson'])!.click()
    await flush()
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('missing import textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, JSON.stringify({ mcpServers: { imported: { command: 'node server.js', env: { TOKEN: 's' } } } }))
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    buttonByText(mounted.host, en['import.parse'])!.click()
    await flush()
    expect(inputById(mounted.host, 'mcp-scope-add-name').value).toBe('imported')
    expect(inputById(mounted.host, 'mcp-scope-add-command').value).toBe('node')
    const envKey = mounted.host.querySelector<HTMLInputElement>('[aria-label="' + en['add.envKey'] + ' 1"]')
    expect(envKey?.value).toBe('TOKEN')
  })

  it('imports a brace-less opencode config section pasted from a real settings file', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    buttonByText(mounted.host, en['add.importJson'])!.click()
    await flush()
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('missing import textarea')
    // The reported paste: an opencode `mcp` section without its outer braces.
    const section = [
      '"mcp": {',
      '  "zotero": { "type": "local", "command": ["/Users/me/.local/bin/zotero-mcp"], "enabled": true },',
      '  "iMCP": { "type": "local", "command": ["/Applications/iMCP.app/Contents/MacOS/imcp-server"], "enabled": true },',
      '  "email": { "type": "local", "command": ["uvx", "mcp-email-server", "stdio"], "enabled": true }',
      '}',
    ].join('\n')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, section)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    buttonByText(mounted.host, en['import.parse'])!.click()
    await flush()
    expect(inputById(mounted.host, 'mcp-scope-add-name').value).toBe('zotero')
    expect(inputById(mounted.host, 'mcp-scope-add-command').value).toBe('/Users/me/.local/bin/zotero-mcp')
    expect(mounted.text()).toContain(t('import.multiple', { name: 'zotero', others: 'iMCP, email' }))
  })

  it('flags two header rows that collapse onto the same credential ref', () => {
    const draft = {
      ...EMPTY_DRAFT,
      name: 'srv',
      transport: 'streamable-http' as const,
      url: 'https://x/mcp',
      headers: [
        { name: 'X-Api-Key', ref: 'X_API_KEY', value: '' },
        { name: 'X_Api_Key', ref: 'X_API_KEY', value: '' },
        { name: '', ref: '', value: '' },
      ],
    }
    expect(evaluateDraft(draft, []).headers).toEqual([undefined, 'validation.refDuplicate', undefined])
  })

  it('tells unreadable JSON apart from JSON without a server entry', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    buttonByText(mounted.host, en['add.importJson'])!.click()
    await flush()
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('missing import textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, '{nope')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    buttonByText(mounted.host, en['import.parse'])!.click()
    await flush()
    expect(mounted.text()).toContain(t('import.error'))
    expect(mounted.text()).not.toContain(t('import.errorNoServer'))
    setter.call(textarea, '{"hello":1}')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    buttonByText(mounted.host, en['import.parse'])!.click()
    await flush()
    expect(mounted.text()).toContain(t('import.errorNoServer'))
  })

  it('caps the "also found" note and reports how many names are left out', async () => {
    const servers = Array.from({ length: 12 }, (_, index) => ({ command: 'node s' + index }))
    const section = JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s, i) => ['s' + i, s])) })
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    buttonByText(mounted.host, en['add.importJson'])!.click()
    await flush()
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('missing import textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, section)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    buttonByText(mounted.host, en['import.parse'])!.click()
    await flush()
    const note = t('import.multiple', { name: 's0', others: 's1, s2, s3, s4, s5, s6, s7, s8' + t('import.more', { count: '3' }) })
    expect(mounted.text()).toContain(note)
    expect(mounted.text()).not.toContain('s11')
  })

  it('renders the runtime status row, drives connect and discloses the tool list', async () => {
    const calls: string[] = []
    const runtime: RuntimeSnapshot = {
      phase: 'ready',
      at: 1,
      servers: {
        a: {
          name: 'a',
          state: 'failed',
          attempts: 3,
          maxAttempts: 10,
          toolCount: 2,
          error: { code: 'connection-failed', message: 'boom' },
        },
      },
    }
    const mounted = mountSection(
      { servers: [stdioServer('a')], overrides: {} },
      {
        connectServer: async (name) => {
          calls.push('connect:' + name)
          return {}
        },
        loadTools: async (name) => {
          calls.push('tools:' + name)
          return {
            tools: [{ publicName: 'mcp__a__t', rawName: 't', description: 'does things' }],
            truncated: true,
            total: 2000,
          }
        },
      },
      { runtime },
    )
    await flush()
    expect(mounted.text()).toContain(en['status.failed'])
    // The host message never crosses the wire; the card localizes the code.
    expect(mounted.text()).toContain(en['runtime.error.connection-failed'])
    expect(mounted.text()).not.toContain('boom')
    buttonByText(mounted.host, en['action.connect'])!.click()
    await flush()
    expect(calls).toContain('connect:a')
    buttonByText(mounted.host, en['tools.title'] + ' (2)')!.click()
    await flush()
    expect(calls).toContain('tools:a')
    expect(mounted.text()).toContain('does things')
    // Truncation reports the TRUE total, not the displayed count.
    expect(mounted.text()).toContain(t('tools.truncated', { count: 1, total: 2000 }))
  })

  it('never reads runtime state through Object.prototype for prototype-name servers', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('toString')], overrides: {} },
      {},
      { runtime: { phase: 'unavailable', servers: {}, error: 'offline' } },
    )
    await flush()
    // Own-property lookup only: an inherited member must not look like a view.
    expect(mounted.text()).toContain(en['runtime.unavailable'])
    expect(buttonByText(mounted.host, en['action.connect'])).toBeUndefined()
    expect(buttonByText(mounted.host, en['action.test'])).toBeUndefined()
  })

  it('reveals an out-of-range timeout instead of leaving Save dead', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    setValue(inputById(mounted.host, 'mcp-scope-add-name'), 'ok')
    setValue(inputById(mounted.host, 'mcp-scope-add-command'), 'node')
    setValue(inputById(mounted.host, 'mcp-scope-add-timeout'), '500')
    await flush()
    expect(mounted.text()).toContain(en['validation.timeout'])
    const save = buttonByText(mounted.host, en['action.save']) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('degrades to a hint when the runtime channel is unavailable', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('a')], overrides: {} },
      {},
      { runtime: { phase: 'unavailable', servers: {}, error: 'offline' } },
    )
    await flush()
    expect(mounted.text()).toContain(en['runtime.unavailable'])
    expect(mounted.text()).toContain(en['status.unknown'])
  })

  it('wires a real form: Enter submits through onSubmit, non-submit buttons stay type=button', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    const form = mounted.host.querySelector('form')
    if (form === null) throw new Error('add form must be a real <form>')
    const buttons = Array.from(form.querySelectorAll('button'))
    const save = buttonByText(mounted.host, en['action.save'])
    const cancel = buttonByText(mounted.host, en['action.cancel'])
    if (save === undefined || cancel === undefined) throw new Error('missing save/cancel')
    expect(save.getAttribute('type')).toBe('submit')
    expect(cancel.getAttribute('type')).toBe('button')
    expect(buttons.every((b) => b.getAttribute('type') !== null)).toBe(true)
    // autofocus lands on the server-name field
    expect(document.activeElement?.id).toBe('mcp-scope-add-name')
  })

  it('announces a successful add near the list and focuses the new card header', async () => {
    const doc: McpScopeDoc = { servers: [], overrides: {} }
    const mounted = mountSection(doc, {
      addServer: async (input) => {
        mounted.live.doc = { servers: [...mounted.live.doc.servers, input.server], overrides: mounted.live.doc.overrides }
        mounted.live.revision += 1
        mounted.rerender()
        return { ok: true }
      },
    })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    setValue(inputById(mounted.host, 'mcp-scope-add-name'), 'git')
    setValue(inputById(mounted.host, 'mcp-scope-add-command'), 'git-mcp')
    // the form is a real <form>: submit event == Enter submission
    const form = mounted.host.querySelector('form')
    if (form === null) throw new Error('missing form')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    // form closed, success announced with role=status near the list, card present
    expect(mounted.text()).toContain(t('add.added', { name: 'git' }))
    const status = mounted.host.querySelector('[role="status"]')
    expect(status?.textContent).toContain('git')
    expect(mounted.text()).toContain('git-mcp')
    expect(buttonByText(mounted.host, en['action.cancel'])).toBeUndefined() // staged form closed
    expect(document.activeElement?.id).toBe('mcp-scope-card-git')
  })

  it('keeps the form open with an inline role="alert" failure when a save is refused', async () => {
    const mounted = mountSection({ servers: [], overrides: {} }, {
      addServer: CONFLICT,
    })
    await flush()
    buttonByText(mounted.host, en['add.add'])!.click()
    await flush()
    setValue(inputById(mounted.host, 'mcp-scope-add-name'), 'git')
    setValue(inputById(mounted.host, 'mcp-scope-add-command'), 'git-mcp')
    const save = buttonByText(mounted.host, en['action.save'])
    if (save === undefined) throw new Error('missing save')
    save.click()
    await flush()
    // form still open with its own alert; no section-top notice anywhere
    expect(buttonByText(mounted.host, en['action.cancel'])).toBeDefined()
    const alerts = Array.from(mounted.host.querySelectorAll('[role="alert"]'))
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.textContent).toContain(en['error.conflict'])
    // save button is usable again (not stuck in Saving)
    expect(buttonByText(mounted.host, en['action.save'])).toBeDefined()
    expect(mounted.text()).not.toContain(en['state.saving'])
  })

  it('opens the staged form prefilled from the document for edit and replaces the server on save', async () => {
    const doc: McpScopeDoc = {
      servers: [stdioServer('alpha', ['TOK'], { command: 'npx', args: [] })],
      overrides: overridesOf({ 'ws-1': ['alpha'] }),
    }
    const mounted = mountSection(
      doc,
      {
        replaceServer: async (oldName, input) => {
          mounted.live.doc = {
            servers: mounted.live.doc.servers.map((s) => (s.serverName === oldName ? input.server : s)),
            overrides: mounted.live.doc.overrides,
          }
          mounted.live.revision += 1
          mounted.rerender()
          return { ok: true }
        },
      },
      { wsItems: [{ workspaceId: 'ws-1', title: 'work' }] },
    )
    await flush()
    buttonByText(mounted.host, en['server.edit'])!.click()
    await flush()
    expect(mounted.text()).toContain(en['edit.title'])
    expect(inputById(mounted.host, 'mcp-scope-add-name').value).toBe('alpha')
    expect(inputById(mounted.host, 'mcp-scope-add-command').value).toBe('npx')
    setValue(inputById(mounted.host, 'mcp-scope-add-name'), 'alpha2')
    setValue(inputById(mounted.host, 'mcp-scope-add-command'), 'npx2')
    const save = buttonByText(mounted.host, en['action.save'])
    if (save === undefined) throw new Error('missing save')
    save.click()
    await flush()
    expect(mounted.text()).toContain(t('edit.saved', { name: 'alpha2' }))
    expect(mounted.text()).toContain('npx2')
    expect(mounted.live.doc.servers[0]?.serverName).toBe('alpha2')
    expect(document.activeElement?.id).toBe('mcp-scope-card-alpha2')
  })

  it("refreshes only the clicked card's server and reports a rejection inline", async () => {
    const calls: ({ silent?: boolean; server?: string } | undefined)[] = []
    let fail = false
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = mountSection(
      { servers: [stdioServer('a'), httpServer('b', 'http://x/mcp', [])], overrides: {} },
      {
        refreshRuntime: async (options) => {
          calls.push(options)
          if (options?.server === 'a') await gate
          if (fail) throw new Error('runtime route is not mounted at this origin (HTTP 404)')
        },
      },
    )
    await flush()
    const refreshButton = (name: string): HTMLButtonElement => {
      const button = mounted.host.querySelector<HTMLButtonElement>(
        `button[aria-label="${en['runtime.refresh']}: ${name}"]`,
      )
      if (button === null) throw new Error(`missing refresh button for ${name}`)
      return button
    }
    // Every card carries its own refresh affordance; the mount pass was full.
    expect(refreshButton('a')).toBeDefined()
    expect(refreshButton('b')).toBeDefined()
    expect(calls.filter((options) => options?.server !== undefined)).toEqual([])

    refreshButton('a').click()
    await flush()
    // Exactly one request, scoped to the clicked server (never the whole table).
    expect(calls.filter((options) => options?.server !== undefined)).toEqual([{ server: 'a', silent: true }])
    expect(refreshButton('a').disabled).toBe(true)
    expect(refreshButton('a').className).toContain(styles.cardRefreshBusy)
    release()
    await flush()
    expect(refreshButton('a').disabled).toBe(false)
    expect(refreshButton('a').className).not.toContain(styles.cardRefreshBusy)

    // A rejection is owned by the card: localized line, host detail in title.
    fail = true
    refreshButton('a').click()
    await flush()
    const line = Array.from(mounted.host.querySelectorAll<HTMLParagraphElement>('p[title]')).find(
      (node) => node.textContent === en['runtime.error'],
    )
    expect(line?.className).toContain(styles.statusErrorText)
    expect(line?.getAttribute('title')).toContain('runtime route is not mounted')
  })

  it("marks a failed card's reconnect as the primary action and freezes refresh while reconnecting", async () => {
    const doc: McpScopeDoc = { servers: [stdioServer('a')], overrides: {} }
    const view = (state: 'failed' | 'reconnecting'): ServerRuntimeView => ({
      name: 'a',
      state,
      attempts: 2,
      maxAttempts: 5,
      toolCount: 0,
    })
    const failed = mountSection(doc, {}, { runtime: { phase: 'ready', servers: { a: view('failed') } } })
    await flush()
    expect(buttonByText(failed.host, en['action.connect'])!.className).toContain(styles.buttonPrimary)
    failed.unmount()

    const reconnecting = mountSection(doc, {}, {
      runtime: { phase: 'ready', servers: { a: view('reconnecting') } },
    })
    await flush()
    const refresh = reconnecting.host.querySelector<HTMLButtonElement>(
      `button[aria-label="${en['runtime.refresh']}: a"]`,
    )
    expect(refresh!.disabled).toBe(true)
    expect(reconnecting.text()).toContain(t('status.retry', { attempt: 2, max: 5 }))
  })

  it('shows the attempt counter during a connecting retry and renders no global header refresh', async () => {
    const doc: McpScopeDoc = { servers: [stdioServer('a'), stdioServer('b')], overrides: {} }
    const connecting: ServerRuntimeView = {
      name: 'a',
      state: 'connecting',
      attempts: 2,
      maxAttempts: 5,
      toolCount: 0,
    }
    const mounted = mountSection(doc, {}, { runtime: { phase: 'ready', servers: { a: connecting } } })
    await flush()
    // The section header no longer offers a global refresh: Add is its only action.
    const sectionHeader = mounted.host.querySelector('header')
    expect(sectionHeader).not.toBeNull()
    expect(
      Array.from(sectionHeader!.querySelectorAll('button')).some((button) =>
        (button.textContent ?? '').includes(en['runtime.refresh']),
      ),
    ).toBe(false)
    // An ATTEMPT reports 'connecting', not 'reconnecting' — the counter still names it.
    expect(mounted.text()).toContain(en['status.connecting'])
    expect(mounted.text()).toContain(t('status.retry', { attempt: 2, max: 5 }))

    // The counter belongs to retries, not to a healthy generation.
    mounted.live.runtime = { phase: 'ready', servers: { a: { ...connecting, state: 'connected' } } }
    mounted.rerender()
    await flush()
    expect(mounted.text()).toContain(en['status.connected'])
    expect(mounted.text()).not.toContain(t('status.retry', { attempt: 2, max: 5 }))

    // Nor to a given-up card: the host counts the attempt that exhausted the
    // budget, so a counter here would read "attempt 6/5" next to the give-up
    // line that already names the exhausted budget.
    mounted.live.runtime = {
      phase: 'ready',
      servers: { a: { ...connecting, state: 'failed', attempts: 5, maxAttempts: 5 } },
    }
    mounted.rerender()
    await flush()
    expect(mounted.text()).toContain(en['status.failed'])
    expect(mounted.text()).not.toContain(t('status.retry', { attempt: 5, max: 5 }))
  })

  it('keeps the stale views behind one banner and retries the full refresh from it', async () => {
    const calls: ({ silent?: boolean; server?: string } | undefined)[] = []
    const doc: McpScopeDoc = { servers: [stdioServer('a')], overrides: {} }
    const staleView: ServerRuntimeView = {
      name: 'a',
      state: 'connected',
      attempts: 0,
      maxAttempts: 5,
      toolCount: 3,
    }
    const mounted = mountSection(
      doc,
      {
        refreshRuntime: async (options) => {
          calls.push(options)
        },
      },
      { runtime: { phase: 'error', at: 9, servers: { a: staleView }, error: 'polls are failing' } },
    )
    await flush()
    expect(mounted.text()).toContain(en['runtime.stale'])
    expect(mounted.text()).toContain(en['status.connected']) // the kept view still renders
    expect(mounted.text()).toContain(t('status.tools', { count: 3 }))
    buttonByText(mounted.host, en['action.retry'])!.click()
    await flush()
    // The banner retries the WHOLE snapshot, not one card's view.
    expect(calls.filter((options) => options?.server === undefined)).toHaveLength(2)
    expect(calls.filter((options) => options?.server !== undefined)).toHaveLength(0)
    mounted.unmount()

    // Without a kept view there is nothing stale: no banner, today's message.
    const empty = mountSection(doc, {}, {
      runtime: { phase: 'unavailable', servers: {}, error: 'no runtime route' },
    })
    await flush()
    expect(empty.text()).not.toContain(en['runtime.stale'])
    expect(empty.text()).toContain(en['runtime.unavailable'])
  })

  it('collapses workspace rows to enabled exceptions, summarizes the default-off state and never writes on expansion', async () => {
    const writes: string[] = []
    const mounted = mountSection(
      { servers: [stdioServer('a')], overrides: overridesOf({ 'ws-1': ['a'] }) },
      {
        toggleWorkspace: async () => {
          writes.push('toggle')
          return { ok: true }
        },
        toggleWorkspaces: async () => {
          writes.push('toggleAll')
          return { ok: true }
        },
        setServerEnabled: async () => {
          writes.push('enabled')
          return { ok: true }
        },
      },
      {
        wsItems: [
          { workspaceId: 'ws-1', title: 'one' },
          { workspaceId: 'ws-2', title: 'two' },
        ],
      },
    )
    await flush()
    // Default: the ENABLED row only; the default-off row is collapsed away.
    expect(mounted.text()).toContain('one')
    expect(mounted.text()).not.toContain('two')
    expect(mounted.text()).not.toContain(en['server.defaultOff'])
    buttonByText(mounted.host, t('row.manage', { count: 1 }))!.click()
    await flush()
    // Expanded: ALL rows + the bulk switches + the default-off hint.
    expect(mounted.text()).toContain('two')
    expect(mounted.text()).toContain(en['server.defaultOff'])
    expect(mounted.text()).toContain(en['row.on'])
    expect(mounted.text()).toContain(en['row.off'])
    expect(buttonByText(mounted.host, en['row.allOn'])).toBeDefined()
    expect(buttonByText(mounted.host, en['row.allOff'])).toBeDefined()
    expect(writes).toEqual([]) // expansion is local UI state, not a settings write
    buttonByText(mounted.host, t('row.manageHide', { count: 1 }))!.click()
    await flush()
    expect(mounted.text()).not.toContain('two')
    expect(writes).toEqual([])
    mounted.unmount()

    // Zero enabled workspaces: exactly ONE default-off summary line, no rows.
    const none = mountSection(
      { servers: [stdioServer('a')], overrides: {} },
      {},
      {
        wsItems: [
          { workspaceId: 'ws-1', title: 'one' },
          { workspaceId: 'ws-2', title: 'two' },
        ],
      },
    )
    await flush()
    const summary = t(countKey('row.allOffDefault', 2), { count: 2 })
    expect(none.text().split(summary).length - 1).toBe(1)
    expect(none.host.querySelectorAll('.' + styles.wsRow)).toHaveLength(0)
    expect(none.text()).not.toContain('one')
    expect(none.text()).not.toContain('two')
  })

  it('orders the card actions edit-then-remove and outlines the remove button', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: [{ workspaceId: 'ws-1', title: 'work' }] },
    )
    await flush()
    const actionTexts = Array.from(mounted.host.querySelectorAll('header button')).map((button) =>
      button.textContent?.trim(),
    )
    const editIndex = actionTexts.indexOf(en['server.edit'])
    const removeIndex = actionTexts.indexOf(en['server.remove'])
    expect(editIndex).toBeGreaterThanOrEqual(0)
    expect(removeIndex).toBeGreaterThan(editIndex)
    const remove = buttonByText(mounted.host, en['server.remove'])
    expect(remove?.className).toContain(styles.buttonOutline)
    expect(remove?.className).toContain(styles.buttonDanger)
    // Edit is the same capsule without the destructive variant: one control
    // group, the red LABEL (one shared frame) being the only difference.
    const edit = buttonByText(mounted.host, en['server.edit'])
    expect(edit?.className).toContain(styles.buttonOutline)
    expect(edit?.className).not.toContain(styles.buttonDanger)
  })

  it('keeps the workspace exception control reachable with a SINGLE workspace', async () => {
    const writes: { workspaceId: string; enabled: boolean }[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async (workspaceId, _serverName, enabled) => {
          writes.push({ workspaceId, enabled })
          return { ok: true }
        },
      },
      { wsItems: [{ workspaceId: 'ws-1', title: 'only-one' }] },
    )
    await flush()
    // Collapsed: the only workspace is default-off, so the summary line renders
    // instead of a row; the manage control must still be reachable.
    expect(mounted.host.querySelectorAll('.' + styles.wsRow)).toHaveLength(0)
    const toggle = buttonByText(mounted.host, t('row.manage', { count: 0 }))
    expect(toggle).toBeDefined()
    toggle?.click()
    await flush()
    const rows = mounted.host.querySelectorAll('.' + styles.wsRow)
    expect(rows).toHaveLength(1)
    expect(mounted.text()).toContain('only-one')
    const input = rows[0]?.querySelector('input')
    expect(input).not.toBeNull()
    input?.click()
    await flush()
    expect(writes).toEqual([{ workspaceId: 'ws-1', enabled: true }])
  })

  it('toggles from the state word too: the whole text run is the label', async () => {
    const writes: { workspaceId: string; enabled: boolean }[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async (workspaceId, _serverName, enabled) => {
          writes.push({ workspaceId, enabled })
          return { ok: true } as const
        },
      },
      { wsItems: [{ workspaceId: 'ws-1', title: 'one' }] },
    )
    await flush()
    buttonByText(mounted.host, t('row.manage', { count: 0 }))?.click()
    await flush()
    const row = mounted.host.querySelector('.' + styles.wsRow)
    const label = row?.querySelector('.' + styles.wsLabel)
    const state = row?.querySelector('.' + styles.wsState)
    expect(label).not.toBeNull()
    expect(state).not.toBeNull()
    // The state word is INSIDE the label: as an inert sibling it looked the same
    // but swallowed the click, which is the "dead hit area" a user hits when
    // aiming at the row's right edge.
    expect(label?.contains(state as Node)).toBe(true)
    expect(row?.lastElementChild).toBe(label)
    state?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(writes).toEqual([{ workspaceId: 'ws-1', enabled: true }])
  })

  it('follows a LIVE workspace list: a new workspace starts off, a deleted one leaves nothing behind', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: { 'ws-1': { alpha: true } } },
      {},
      { wsItems: [{ workspaceId: 'ws-1', title: 'one' }] },
    )
    await flush()
    // ws-1 is enabled, so the collapsed card counts it.
    expect(buttonByText(mounted.host, t('row.manage', { count: 1 }))).toBeDefined()

    // A workspace created while the card is on screen arrives switched OFF: the
    // count does not move and no write happens.
    mounted.live.wsItems.push({ workspaceId: 'ws-2', title: 'two' })
    mounted.rerender()
    await flush()
    expect(buttonByText(mounted.host, t('row.manage', { count: 1 }))).toBeDefined()

    buttonByText(mounted.host, t('row.manage', { count: 1 }))?.click()
    await flush()
    const inputs = Array.from(mounted.host.querySelectorAll<HTMLInputElement>('.' + styles.wsRow + ' input'))
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.checked).toBe(true)
    expect(inputs[1]?.checked).toBe(false)
    expect(mounted.text()).toContain('two')

    // DELETING a workspace drops its row and its pair from the count. A deleted
    // workspace can leave a record in the settings document (the host keeps what
    // the last write put there) and nothing may surface from it: the rows and the
    // count both come from the live list.
    mounted.live.wsItems.splice(0, 1)
    mounted.rerender()
    await flush()
    expect(mounted.text()).not.toContain('one')
    expect(mounted.host.querySelectorAll('.' + styles.wsRow)).toHaveLength(1)
    expect(buttonByText(mounted.host, t('row.manageHide', { count: 0 }))).toBeDefined()
    buttonByText(mounted.host, t('row.manageHide', { count: 0 }))?.click()
    await flush()
    // Nothing is enabled any more, so the collapsed card falls back to the
    // default-off summary and the count reads zero — no phantom "one".
    expect(mounted.text()).toContain(t(countKey('row.allOffDefault', 1), { count: 1 }))
    expect(buttonByText(mounted.host, t('row.manage', { count: 0 }))).toBeDefined()
  })

  it('leads the expanded list with the bulk pair', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      {
        wsItems: [
          { workspaceId: 'ws-1', title: 'one' },
          { workspaceId: 'ws-2', title: 'two' },
        ],
      },
    )
    await flush()
    buttonByText(mounted.host, t('row.manage', { count: 0 }))?.click()
    await flush()
    const allOn = buttonByText(mounted.host, t('row.allOn'))
    const list = mounted.host.querySelector('.' + styles.wsList)
    expect(allOn).toBeDefined()
    expect(list).not.toBeNull()
    // A long workspace list would push a trailing pair past the fold.
    expect(allOn?.compareDocumentPosition(list as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('serializes workspace toggles: every row is inert while one save is in flight', async () => {
    let release: (outcome: { ok: true }) => void = () => {}
    const pending = new Promise<{ ok: true }>((resolve) => {
      release = resolve
    })
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      { toggleWorkspace: async () => pending },
      { wsItems: [{ workspaceId: 'ws-1', title: 'one' }, { workspaceId: 'ws-2', title: 'two' }] },
    )
    await flush()
    buttonByText(mounted.host, t('row.manage', { count: 0 }))?.click()
    await flush()
    const inputs = Array.from(mounted.host.querySelectorAll<HTMLInputElement>('.' + styles.wsRow + ' input'))
    expect(inputs).toHaveLength(2)

    inputs[0]?.click()
    await flush()
    // The save is still in flight, so BOTH rows stay inert: an overlapping
    // toggle on the second row would be judged against a single-change
    // expectation built from the same base and report a spurious conflict.
    expect(inputs[0]?.disabled).toBe(true)
    expect(inputs[1]?.disabled).toBe(true)

    release({ ok: true })
    await flush()
    expect(inputs[0]?.disabled).toBe(false)
    expect(inputs[1]?.disabled).toBe(false)
  })

  it('zh dictionary mirrors the en key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})