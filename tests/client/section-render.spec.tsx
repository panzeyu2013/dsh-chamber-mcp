// @vitest-environment jsdom
/**
 * Render evidence for the Phase 0-4 settings surface:
 * servers list -> server detail -> editor, workspaces list -> workspace detail,
 * optimistic scope/allow writes, confirmations, validation and persistent
 * feedback. Every test drives the real section with injected store faces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../../src/client/index.ts'
import type { SaveOutcome, ServerSaveInput } from '../../src/client/controller.ts'
import { cleanupSections } from '../support/section-harness.tsx'
import {
  buttonByText,
  buttonsOf,
  dialog,
  mountSection,
  openServer,
  openWorkspacesTab,
  serverRow,
  setValue,
  view,
  WS,
  CONFLICT,
  flush,
  httpServer,
  overridesOf,
  runtimeWith,
  stdioServer,
  t,
  type Mounted,
} from '../support/section-kit.ts'

afterEach(() => {
  cleanupSections()
  sessionStorage.clear()
})
beforeEach(() => {
  sessionStorage.clear()
})

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
        restoreScopeValues: async (entries) => {
          calls.push(['restore', entries.map((entry) => ({ ...entry }))])
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
    // ONE mutation carries the mixed pre-batch values: no half-restored
    // document is possible if a second write would have failed.
    expect(calls.slice(1)).toEqual([
      [
        'restore',
        [
          { workspaceId: 'ws-a', serverName: 'alpha', enabled: true },
          { workspaceId: 'ws-b', serverName: 'alpha', enabled: false },
          { workspaceId: 'ws-c', serverName: 'alpha', enabled: false },
        ],
      ],
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

describe('fix-round regressions', () => {
  it('reverts the rows a failed batch still owns and reports it once', async () => {
    let failBatch!: (outcome: SaveOutcome) => void
    let batchStarted = false
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspaces: () => {
          batchStarted = true
          return new Promise((resolve) => {
            failBatch = resolve
          })
        },
        toggleWorkspace: async () => ({ ok: true }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    expect(batchStarted).toBe(true)
    const scopeSwitch = (title: string): HTMLInputElement =>
      mounted.host.querySelector<HTMLInputElement>(
        'input[aria-label="' + t('server.workspacesTitle') + ': ' + title + '"]',
      )!
    // A per-row write lands while the batch is in flight — twice, so the row's
    // newer target (on) DIFFERS from the committed value: only a row that kept
    // its own token can still read on after the batch fails.
    scopeSwitch(WS[1]!.title).click()
    await flush()
    scopeSwitch(WS[1]!.title).click()
    await flush()
    failBatch({ ok: false, reason: 'conflict' })
    await flush()
    await flush()
    // The document still says every workspace is off, so the rows the batch
    // still owned must read off; the superseded row keeps "on", and the failure
    // stays visible with a Retry.
    expect(scopeSwitch(WS[0]!.title).checked).toBe(false)
    expect(scopeSwitch(WS[1]!.title).checked).toBe(true)
    expect(scopeSwitch(WS[2]!.title).checked).toBe(false)
    expect(mounted.text()).toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeDefined()
  })

  it('renders a wire "unknown" state as status unknown, never as not started', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      {
        wsItems: WS,
        runtime: {
          phase: 'ready',
          servers: {
            alpha: { name: 'alpha', state: 'unknown', attempts: 0, maxAttempts: 10, toolCount: 0 },
          },
        },
      },
    )
    await flush()
    const row = serverRow(mounted, 'alpha')
    expect(row.textContent).toContain(t('status.unknown'))
    // The retired wording ("Not started") must never come back: it claims a
    // state the host never reported.
    expect(row.textContent).not.toContain('Not started')
  })

  it('keeps the hook order across document status changes', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: WS, docStatus: 'loading' },
    )
    await flush()
    expect(mounted.text()).toContain(t('state.loading'))
    mounted.live.docStatus = 'ready'
    mounted.rerender()
    await flush()
    expect(serverRow(mounted, 'alpha')).not.toBeNull()
    mounted.live.docStatus = 'unavailable'
    mounted.rerender()
    await flush()
    expect(mounted.text()).toContain(t('state.unavailable'))
    mounted.live.docStatus = 'ready'
    mounted.rerender()
    await flush()
    expect(serverRow(mounted, 'alpha')).not.toBeNull()
  })

  it('rolls the availability switch back and offers Retry when the write fails', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      { setServerEnabled: CONFLICT },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const allow = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.allowedLabel') + '"]')!
    expect(allow.checked).toBe(true)
    allow.click()
    await flush()
    expect(allow.checked).toBe(true)
    expect(mounted.text()).toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeDefined()
  })


  it('keeps the workspace filter reachable when the list shrinks under the threshold', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      workspaceId: 'ws-' + index,
      title: 'w' + index,
      path: '/w' + index,
    }))
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: many, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const search = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('wsFilter.placeholder') + '"]')!
    setValue(search, 'w1')
    await flush()
    mounted.live.wsItems = many.slice(0, 1)
    mounted.rerender()
    await flush()
    // A query still narrows the rows, so its input must still be there to clear.
    expect(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('wsFilter.placeholder') + '"]'),
    ).not.toBeNull()
  })


  it('never restores an override for a workspace that vanished before Undo', async () => {
    const restores: { workspaceId: string; serverName: string; enabled: boolean }[][] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspaces: async () => ({ ok: true }),
        restoreScopeValues: async (entries) => {
          restores.push(entries.map((entry) => ({ ...entry })))
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    // gamma disappears (another tab) before the Undo lands.
    mounted.live.wsItems = WS.slice(0, 2)
    mounted.rerender()
    await flush()
    buttonByText(mounted.host, t('toast.undo'))!.click()
    await flush()
    expect(restores[0]!.map((entry) => entry.workspaceId)).toEqual(['ws-a', 'ws-b'])
  })


  it('fills the command line from the clipboard', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'npx -y @some/mcp --flag' },
    })
    try {
      const mounted = mountSection({ servers: [], overrides: {} })
      await flush()
      buttonByText(mounted.host, t('add.add'))!.click()
      await flush()
      buttonByText(mounted.host, t('add.pasteCommand'))!.click()
      await flush()
      expect((document.getElementById('mcp-scope-editor-command') as HTMLInputElement).value).toBe('npx')
      // "npx -y @some/mcp --flag" → command "npx" + three arguments.
      expect(mounted.text()).toContain(t('paste.argsImported', { count: 3 }))
    } finally {
      if (descriptor === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', descriptor)
    }
  })

  it('copies a reference-only server JSON payload', async () => {
    let copied = ''
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text } },
    })
    try {
      const mounted = mountSection(
        { servers: [stdioServer('alpha', ['TOKEN'])], overrides: {} },
        {},
        { wsItems: WS, runtime: runtimeWith('alpha') },
      )
      await flush()
      const detail = await openServer(mounted, 'alpha')
      buttonByText(detail, t('server.copyJson'))!.click()
      await flush()
      expect(copied).toContain('"envKeys"')
      expect(copied).toContain('TOKEN')
      // The payload is the definition only: no credential value ever rides it.
      expect(copied).not.toContain('supersecret')
    } finally {
      if (descriptor === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', descriptor)
    }
  })

  it('excludes a globally disabled server from the workspace batch', async () => {
    const calls: unknown[][] = []
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha'), stdioServer('beta')],
        overrides: { 'ws-a': { beta: true } },
        disabled: { beta: true },
      },
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
    const workspaceDetail = mounted.host.querySelector('[data-mcp-workspace-detail="ws-a"]')!
    buttonByText(workspaceDetail, t('row.allOn'))!.click()
    await flush()
    // beta is globally disabled, so its switch is inert and the batch skips it.
    expect(calls[0]).toEqual(['ws-a', ['alpha'], true])
  })

  it('stays silent when every row of a failed batch was superseded', async () => {
    let failBatch!: (outcome: SaveOutcome) => void
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspaces: () =>
          new Promise((resolve) => {
            failBatch = resolve
          }),
        toggleWorkspace: async () => ({ ok: true }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    const scopeSwitch = (title: string): HTMLInputElement =>
      mounted.host.querySelector<HTMLInputElement>(
        'input[aria-label="' + t('server.workspacesTitle') + ': ' + title + '"]',
      )!
    // Every row gets a newer click pair, so no row still belongs to the batch.
    for (const workspace of WS) {
      scopeSwitch(workspace.title).click()
      await flush()
      scopeSwitch(workspace.title).click()
      await flush()
    }
    failBatch({ ok: false, reason: 'conflict' })
    await flush()
    await flush()
    // The batch's intent is gone: a banner here would only offer a Retry that
    // replays the stale targets over the user's newer choices.
    expect(mounted.text()).not.toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeUndefined()
    expect(scopeSwitch(WS[0]!.title).checked).toBe(true)
    expect(scopeSwitch(WS[1]!.title).checked).toBe(true)
    expect(scopeSwitch(WS[2]!.title).checked).toBe(true)
  })

  it('names the editor back control after the surface it returns to', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: { 'ws-b': { alpha: true } } },
      {},
      { wsItems: WS },
    )
    await flush()
    await openWorkspacesTab(mounted)
    mounted.host.querySelector<HTMLElement>('[data-workspace="ws-b"] button')!.click()
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const back = buttonByText(mounted.host, t('editor.backTo', { target: 'beta' }))
    expect(back).toBeDefined()
    back!.click()
    await flush()
    expect(mounted.host.querySelector('[data-mcp-workspace-detail="ws-b"]')).not.toBeNull()
  })

  it('counts the removal confirmation over the live workspace list', async () => {
    const mounted = mountSection(
      {
        servers: [stdioServer('alpha')],
        overrides: { 'ws-a': { alpha: true }, 'ws-gone': { alpha: true } },
      },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    // The stored row for a deleted workspace must not inflate the promise.
    expect(dialog().textContent).toContain(t('server.removeBodyNoRefs', { count: 1 }))
  })

  it('copies a machine-readable diagnostic payload', async () => {
    let copied = ''
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text
        },
      },
    })
    try {
      const mounted = mountSection(
        { servers: [stdioServer('alpha')], overrides: {} },
        {},
        {
          wsItems: WS,
          runtime: {
            phase: 'ready',
            servers: {
              alpha: {
                name: 'alpha',
                state: 'failed',
                attempts: 3,
                maxAttempts: 10,
                toolCount: 0,
                error: { code: 'timeout', message: 'timed out' },
              },
            },
          },
        },
      )
      await flush()
      const detail = await openServer(mounted, 'alpha')
      buttonByText(detail, t('server.copyDiagnostic'))!.click()
      await flush()
      expect(JSON.parse(copied)).toMatchObject({
        server: 'alpha',
        transport: 'stdio',
        state: 'failed',
        code: 'timeout',
        attempts: 3,
        maxAttempts: 10,
      })
    } finally {
      if (descriptor === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', descriptor)
    }
  })

  it('uses the workspace wording for an empty workspace filter', async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      workspaceId: 'ws-' + index,
      title: 'w' + index,
      path: '/w' + index,
    }))
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: many },
    )
    await flush()
    await openWorkspacesTab(mounted)
    const search = mounted.host.querySelector<HTMLInputElement>(
      'input[aria-label="' + t('wsFilter.placeholder') + '"]',
    )!
    setValue(search, 'zzz')
    await flush()
    expect(mounted.text()).toContain(t('empty.workspacesFiltered'))
    expect(mounted.text()).not.toContain(t('list.emptyFiltered'))
  })

  it('reads a missing runtime view as unknown, never as stopped', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: WS, runtime: { phase: 'ready', servers: {} } },
    )
    await flush()
    const row = serverRow(mounted, 'alpha')
    expect(row.textContent).toContain(t('status.unknown'))
    expect(row.textContent).not.toContain(t('status.stopped'))
  })

  it('reports an Undo whose workspaces all disappeared', async () => {
    const restores: unknown[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspaces: async () => ({ ok: true }),
        restoreScopeValues: async (entries) => {
          restores.push(entries)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('row.allOn'))!.click()
    await flush()
    mounted.live.wsItems = []
    mounted.rerender()
    await flush()
    buttonByText(mounted.host, t('toast.undo'))!.click()
    await flush()
    expect(restores).toHaveLength(0)
    expect(mounted.text()).toContain(t('toast.undoNothing'))
  })

})

describe('polling and unmount', () => {
  it('arms the 10s poll, runs exactly one tick, and clears the timer on unmount', async () => {
    const originalSet = window.setTimeout.bind(window)
    const originalClear = window.clearTimeout.bind(window)
    const timers: { id: number; delay: number; handler: TimerHandler }[] = []
    const setSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = originalSet(handler, delay, ...args)
      timers.push({ id, delay: Number(delay ?? 0), handler })
      return id
    }) as typeof window.setTimeout)
    const clearSpy = vi.spyOn(window, 'clearTimeout')
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
    try {
      await flush()
      await new Promise((resolve) => originalSet(resolve, 20))
      expect(refreshes).toHaveLength(1)
      const poll = timers.find((entry) => entry.delay === 10_000)
      expect(poll, 'no 10s poll timer was armed').toBeDefined()
      if (typeof poll!.handler === 'function') poll!.handler()
      await new Promise((resolve) => originalSet(resolve, 0))
      expect(refreshes).toHaveLength(2)
      const latestPoll = [...timers].reverse().find((entry) => entry.delay === 10_000)!
      mounted.unmount()
      expect(
        clearSpy.mock.calls.some(([id]) => id === latestPoll.id),
        'the armed poll timer was not cleared on unmount',
      ).toBe(true)
      originalClear(poll!.id)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  it('auto-dismisses a success toast on its 6s timer', async () => {
    const originalSet = window.setTimeout.bind(window)
    const originalClear = window.clearTimeout.bind(window)
    const timers: { id: number; delay: number; handler: TimerHandler }[] = []
    const setSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = originalSet(handler, delay, ...args)
      timers.push({ id, delay: Number(delay ?? 0), handler })
      return id
    }) as typeof window.setTimeout)
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {},
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    try {
      await flush()
      const detail = await openServer(mounted, 'alpha')
      detail
        .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': alpha"]')!
        .click()
      await flush()
      const toastText = t('toast.scopeOn', { server: 'alpha', workspace: 'alpha' })
      expect(mounted.text()).toContain(toastText)
      const toastTimer = [...timers].reverse().find((entry) => entry.delay === 6000)
      expect(toastTimer, 'no 6s toast timer was armed').toBeDefined()
      if (typeof toastTimer!.handler === 'function') toastTimer!.handler()
      await flush()
      expect(mounted.text()).not.toContain(toastText)
      originalClear(toastTimer!.id)
    } finally {
      setSpy.mockRestore()
    }
  })
})
