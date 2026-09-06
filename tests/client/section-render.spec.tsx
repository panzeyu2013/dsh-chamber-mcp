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
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { McpScopeDoc, WorkspaceOverrides } from '../../src/shared/model.ts'
import type { SaveOutcome, ServerSaveInput } from '../../src/client/controller.ts'

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
}

interface Actions {
  addServer?(input: ServerSaveInput): Promise<SaveOutcome>
  replaceServer?(oldName: string, input: ServerSaveInput): Promise<SaveOutcome>
  removeServer?(name: string): Promise<SaveOutcome>
  toggleWorkspace?(workspaceId: string, serverName: string, off: boolean): Promise<SaveOutcome>
  unsetCredential?(ref: string): Promise<SaveOutcome>
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

// Test-only casts: the composed props re-state framework types that collapse
// to opaque cross-package shapes in this dev tree (see docs/ui-notes.md).
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
    unsetCredential: actions.unsetCredential ?? OK,
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
    expect(text).toContain(t(countKey('server.offWorkspaces', 1), { count: 1 })) // 'Off in 1 workspace'
    // definition details (UX-04): command + args line and http url
    expect(text).toContain('node a.js --x')
    expect(text).toContain('http://x/mcp')
    // header names ride the badge rows
    expect(text).toContain('Authorization')
    expect(text).toContain('AUTH')
    // workspace rows
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain(en['server.newWorkspaceDefault'])
    expect(text).toContain(en['row.on'])
    expect(text).toContain(en['row.off'])
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
    expect(text).toContain(t(countKey('server.offWorkspaces', 2), { count: 2 })) // 'Off in 2 workspaces'
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
    expect(loading.text()).not.toContain(en[countKey('server.offWorkspaces', 1)].replace('{count}', '1'))
    loading.unmount()
    const failed = mountSection(doc, {}, { wsState: 'error', wsPhase: 'ready', wsItems: [] })
    await flush()
    expect(failed.text()).toContain(en['workspaces.error'])
    expect(failed.text()).not.toContain(en['workspaces.empty'])
    // settled list with zero workspaces is the only "empty" case
    failed.unmount()
    const empty = mountSection(doc, {}, { wsState: 'idle', wsPhase: 'ready', wsItems: [] })
    await flush()
    expect(empty.text()).toContain(en['workspaces.empty'])
  })

  it('shows a per-card role="alert" banner when a card action fails (not a section-top notice)', async () => {
    const doc: McpScopeDoc = {
      servers: [stdioServer('a', ['TOK'])],
      overrides: {},
    }
    const mounted = mountSection(
      doc,
      { toggleWorkspace: CONFLICT },
      { wsItems: [{ workspaceId: 'ws-1', title: 'work' }] },
    )
    await flush()
    expect(mounted.text()).not.toContain(en['error.conflict'])
    const switchInput = mounted.host.querySelector<HTMLInputElement>('input[role="switch"]')
    if (switchInput === null) throw new Error('missing switch')
    switchInput.click()
    await flush()
    const alerts = Array.from(mounted.host.querySelectorAll('[role="alert"]'))
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.textContent).toContain(en['error.conflict'])
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

  it('zh dictionary mirrors the en key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
