// @vitest-environment jsdom
/**
 * INDEPENDENT acceptance suite for the Phase 0-4 settings surface (C4).
 *
 * Capabilities are asserted through the real section with injected stores:
 * correctness (off-by-default, optimistic state, navigation is read-only),
 * completeness (one test per user-visible capability) and optimality (request,
 * write and DOM counts). Copy is read from the shipped dictionaries.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import { styles } from '../../src/client/styles.ts'
import {
  buttonsOf,
  cleanupSections,
  flush,
  mountSection,
  overridesOf,
  stdioServer,
  viewOf,
  type Harness,
} from './harness.tsx'
import type { RuntimeSnapshot } from '../../src/client/runtime.ts'

afterEach(() => {
  cleanupSections()
})

const SERVER = 'alpha'
const WS = [
  { workspaceId: 'ws-1', title: 'alpha' },
  { workspaceId: 'ws-2', title: 'beta' },
  { workspaceId: 'ws-3', title: 'gamma' },
]

function runtimeWith(names: readonly string[], phase: RuntimeSnapshot['phase'] = 'ready'): RuntimeSnapshot {
  const servers: Record<string, ReturnType<typeof viewOf>> = {}
  for (const name of names) servers[name] = viewOf(name)
  return { phase, servers }
}

function text(key: SettingsKey, params?: Record<string, string | number>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

function buttonWith(root: ParentNode, label: string): HTMLButtonElement {
  const button = buttonsOf(root).find((candidate) => (candidate.textContent ?? '').includes(label))
  if (button === undefined) throw new Error('missing button: ' + label)
  return button
}

function rowOf(mounted: Harness, name: string): HTMLElement {
  const row = mounted.host.querySelector<HTMLElement>('[data-server="' + name + '"]')
  if (row === null) throw new Error('missing row ' + name)
  return row
}

async function openServer(mounted: Harness, name: string): Promise<HTMLElement> {
  rowOf(mounted, name).querySelector('button')!.click()
  await flush()
  const detail = mounted.host.querySelector<HTMLElement>('[data-mcp-server-detail]')
  if (detail === null) throw new Error('missing detail for ' + name)
  return detail
}

async function openWorkspaces(mounted: Harness): Promise<void> {
  const tab = buttonsOf(mounted.host).find(
    (button) =>
      button.getAttribute('role') === 'tab' && (button.textContent ?? '').includes(text('tab.workspaces')),
  )
  if (tab === undefined) throw new Error('missing workspaces tab')
  tab.click()
  await flush()
}

async function openWorkspace(mounted: Harness, id: string): Promise<HTMLElement> {
  const row = mounted.host.querySelector<HTMLElement>('[data-workspace="' + id + '"]')
  if (row === null) throw new Error('missing workspace row ' + id)
  row.querySelector('button')!.click()
  await flush()
  const detail = mounted.host.querySelector<HTMLElement>('[data-mcp-workspace-detail="' + id + '"]')
  if (detail === null) throw new Error('missing workspace detail ' + id)
  return detail
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('missing dialog')
  return element
}

describe('C4 correctness: off-by-default and optimistic writes', () => {
  it('[correctness] a configured server is off in every workspace by default', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    expect(rowOf(mounted, SERVER).textContent).toContain(
      text('server.scopeCount', { enabled: 0, total: WS.length }),
    )
    const detail = await openServer(mounted, SERVER)
    const switches = Array.from(detail.querySelectorAll<HTMLInputElement>('input[role="switch"]'))
    // The availability switch is on; every workspace switch is off.
    const workspaceSwitches = switches.filter((input) => input.getAttribute('aria-label')?.startsWith(text('server.workspacesTitle')))
    expect(workspaceSwitches).toHaveLength(WS.length)
    expect(workspaceSwitches.every((input) => input.checked === false)).toBe(true)
  })

  it('[correctness] a scope toggle shows its new value before the write settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = mountSection(
      {
        doc: { servers: [stdioServer(SERVER)], overrides: {} },
        wsItems: WS,
        runtime: runtimeWith([SERVER]),
        actions: {
          toggleWorkspace: async () => {
            await gate
            return { ok: true }
          },
        },
      },
    )
    await flush()
    const detail = await openServer(mounted, SERVER)
    const input = detail.querySelector<HTMLInputElement>(
      'input[aria-label="' + text('server.workspacesTitle') + ': beta"]',
    )!
    input.click()
    await flush()
    expect(
      detail.querySelector<HTMLInputElement>(
        'input[aria-label="' + text('server.workspacesTitle') + ': beta"]',
      )!.checked,
    ).toBe(true)
    release()
    await flush()
  })


  it('[correctness] a committed document clears the optimistic entry instead of pinning it', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + text('server.workspacesTitle') + ': beta"]')!
      .click()
    await flush()
    expect(
      detail.querySelector<HTMLInputElement>(
        'input[aria-label="' + text('server.workspacesTitle') + ': beta"]',
      )!.checked,
    ).toBe(true)
    // The controller publishes the new document before the write resolves.
    mounted.commitDoc({
      servers: [stdioServer(SERVER)],
      overrides: overridesOf({ 'ws-2': [SERVER] }),
    })
    await flush()
    // An external revert must now be followed, not masked by a stale pending.
    mounted.commitDoc({ servers: [stdioServer(SERVER)], overrides: {} })
    await flush()
    expect(
      mounted.host.querySelector<HTMLInputElement>(
        'input[aria-label="' + text('server.workspacesTitle') + ': beta"]',
      )!.checked,
    ).toBe(false)
  })

  it('[correctness] navigating between views performs no settings write', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    await openServer(mounted, SERVER)
    buttonWith(mounted.host, text('server.back')).click()
    await flush()
    await openWorkspaces(mounted)
    await openWorkspace(mounted, 'ws-1')
    buttonWith(mounted.host, text('workspace.back')).click()
    await flush()
    expect(mounted.calls.writes).toEqual([])
  })

  it('[correctness] a document that was still loading finishes into the list', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
      docStatus: 'loading',
    })
    await flush()
    expect(mounted.text()).toContain(text('state.loading'))
    mounted.setDocStatus('ready')
    await flush()
    expect(rowOf(mounted, SERVER)).not.toBeNull()
    mounted.setDocStatus('unavailable')
    await flush()
    expect(mounted.text()).toContain(text('state.unavailable'))
    mounted.setDocStatus('ready')
    await flush()
    expect(rowOf(mounted, SERVER)).not.toBeNull()
  })

  it('[correctness] a failed bulk write leaves every row on the committed value and reports once', async () => {
    let failBatch!: (outcome: { ok: false; reason: 'conflict' }) => void
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
      actions: {
        toggleWorkspaces: () =>
          new Promise((resolve) => {
            failBatch = resolve
          }),
        toggleWorkspace: async () => ({ ok: true }),
      },
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    const scopeSwitch = (title: string): HTMLInputElement =>
      mounted.host.querySelector<HTMLInputElement>(
        'input[aria-label="' + text('server.workspacesTitle') + ': ' + title + '"]',
      )!
    buttonWith(detail, text('row.allOn')).click()
    await flush()
    // A newer per-row write on beta while the batch is in flight.
    scopeSwitch('beta').click()
    await flush()
    failBatch({ ok: false, reason: 'conflict' })
    await flush()
    await flush()
    expect(scopeSwitch('alpha').checked).toBe(false)
    expect(scopeSwitch('beta').checked).toBe(false)
    expect(scopeSwitch('gamma').checked).toBe(false)
    expect(mounted.text()).toContain(text('error.conflict'))
  })
})

describe('C4 completeness: one test per user-visible capability', () => {
  it('[completeness] every server has a list row with its scope and status', async () => {
    const names = ['alpha', 'beta', 'gamma']
    const mounted = mountSection({
      doc: { servers: names.map((name) => stdioServer(name)), overrides: {} },
      wsItems: WS,
      runtime: runtimeWith(names),
    })
    await flush()
    for (const name of names) {
      expect(rowOf(mounted, name).textContent).toContain(name)
      expect(rowOf(mounted, name).textContent).toContain(text('status.connected'))
    }
    expect(mounted.host.querySelectorAll('.' + styles.serverRow)).toHaveLength(names.length)
  })

  it('[completeness] a per-server refresh hits only that server', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    const before = mounted.calls.refresh.length
    buttonWith(detail, text('runtime.refresh')).click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toEqual([{ silent: true, server: SERVER }])
  })

  it('[completeness] connect, disconnect and test are real actions', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    buttonWith(detail, text('action.disconnect')).click()
    await flush()
    expect(mounted.calls.disconnect).toEqual([SERVER])
    buttonWith(detail, text('action.test')).click()
    await flush()
    expect(mounted.calls.test).toEqual([SERVER])
  })


  it('[completeness] Connect is reachable and sends the server name', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: { phase: 'ready', servers: { [SERVER]: viewOf(SERVER, 'failed') } },
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    buttonWith(detail, text('action.connect')).click()
    await flush()
    expect(mounted.calls.connect).toEqual([SERVER])
  })

  it('[completeness] the tools disclosure loads the host tool list once', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
      actions: {
        loadTools: async () => ({
          tools: [{ publicName: 'mcp__alpha__search', rawName: 'search', description: 'Search' }],
          truncated: false,
          total: 1,
        }),
      },
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    const toolsButton = buttonWith(detail, text('tools.title'))
    toolsButton.click()
    await flush()
    expect(mounted.calls.tools).toEqual([SERVER])
    toolsButton.click()
    await flush()
    toolsButton.click()
    await flush()
    // The list is cached for the current sync generation.
    expect(mounted.calls.tools).toEqual([SERVER])
  })

  it('[completeness] one scope switch is one write; bulk scope is still one write', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + text('server.workspacesTitle') + ': beta"]')!
      .click()
    await flush()
    expect(mounted.calls.writes).toEqual(['toggleWorkspace'])
    expect(mounted.calls.writeArgs[0]).toEqual({
      action: 'toggleWorkspace',
      args: ['ws-2', SERVER, true],
    })
    buttonWith(detail, text('row.allOn')).click()
    await flush()
    expect(mounted.calls.writes).toEqual(['toggleWorkspace', 'toggleWorkspaces'])
    expect(mounted.calls.writeArgs[1]).toEqual({
      action: 'toggleWorkspaces',
      args: [SERVER, true, ['ws-1', 'ws-2', 'ws-3']],
    })
  })


  it('[completeness] the off direction is wired: single off, then bulk off', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: overridesOf({ 'ws-2': [SERVER] }) },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    const switchInput = detail.querySelector<HTMLInputElement>(
      'input[aria-label="' + text('server.workspacesTitle') + ': beta"]',
    )!
    expect(switchInput.checked).toBe(true)
    switchInput.click()
    await flush()
    expect(mounted.calls.writeArgs[0]).toEqual({
      action: 'toggleWorkspace',
      args: ['ws-2', SERVER, false],
    })
    buttonWith(detail, text('row.allOff')).click()
    await flush()
    expect(mounted.calls.writeArgs[1]).toEqual({
      action: 'toggleWorkspaces',
      args: [SERVER, false, ['ws-1', 'ws-2', 'ws-3']],
    })
  })

  it('[completeness] workspace detail toggles a server and batches one workspace', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer('alpha'), stdioServer('beta')], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith(['alpha', 'beta']),
    })
    await flush()
    await openWorkspaces(mounted)
    const detail = await openWorkspace(mounted, 'ws-1')
    detail.querySelector<HTMLInputElement>('input[aria-label="alpha: alpha"]')!.click()
    await flush()
    expect(mounted.calls.writes).toEqual(['toggleWorkspace'])
    expect(mounted.calls.writeArgs[0]).toEqual({
      action: 'toggleWorkspace',
      args: ['ws-1', 'alpha', true],
    })
    buttonWith(detail, text('row.allOn')).click()
    await flush()
    expect(mounted.calls.writes).toEqual(['toggleWorkspace', 'toggleWorkspaceServers'])
    expect(mounted.calls.writeArgs[1]).toEqual({
      action: 'toggleWorkspaceServers',
      args: ['ws-1', ['alpha', 'beta'], true],
    })
  })



  it('[completeness] undoing a workspace bulk restores its exact prior mix', async () => {
    const mounted = mountSection({
      doc: {
        servers: [stdioServer('alpha'), stdioServer('beta'), stdioServer('gamma')],
        overrides: overridesOf({ 'ws-1': ['alpha'] }),
      },
      wsItems: WS,
      runtime: runtimeWith(['alpha', 'beta', 'gamma']),
    })
    await flush()
    await openWorkspaces(mounted)
    const detail = await openWorkspace(mounted, 'ws-1')
    buttonWith(detail, text('row.allOn')).click()
    await flush()
    buttonWith(mounted.host, text('toast.undo')).click()
    await flush()
    expect(mounted.calls.writeArgs.slice(1)).toEqual([
      {
        action: 'restoreScopeValues',
        args: [[
          { workspaceId: 'ws-1', serverName: 'alpha', enabled: true },
          { workspaceId: 'ws-1', serverName: 'beta', enabled: false },
          { workspaceId: 'ws-1', serverName: 'gamma', enabled: false },
        ]],
      },
    ])
  })

  it('[completeness] the Workspaces tab filters workspaces by name', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      workspaceId: 'ws-' + index,
      title: 'project-' + index,
    }))
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: items,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    await openWorkspaces(mounted)
    const search = mounted.host.querySelector<HTMLInputElement>(
      'input[aria-label="' + text('wsFilter.placeholder') + '"]',
    )!
    setValue(search, 'project-3')
    await flush()
    expect(mounted.host.querySelector('[data-workspace="ws-3"]')).not.toBeNull()
    expect(mounted.host.querySelector('[data-workspace="ws-1"]')).toBeNull()
  })

  it('[completeness] the detail removes a server only after the specific confirmation', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: overridesOf({ 'ws-1': [SERVER] }) },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    buttonWith(detail, text('server.remove')).click()
    await flush()
    expect(dialog().textContent).toContain(text('server.removeTitle', { name: SERVER }))
    buttonWith(dialog(), text('server.removeAction')).click()
    await flush()
    expect(mounted.calls.writes).toEqual(['removeServer'])
    expect(mounted.calls.writeArgs[0]).toEqual({ action: 'removeServer', args: [SERVER] })
  })

  it('[completeness] the editor is reachable from the list and the detail', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    buttonWith(mounted.host, text('add.add')).click()
    await flush()
    expect(mounted.host.textContent).toContain(text('add.title'))
    buttonWith(mounted.host, text('action.cancel')).click()
    await flush()
    await openServer(mounted, SERVER)
    buttonWith(mounted.host, text('server.edit')).click()
    await flush()
    expect(mounted.host.textContent).toContain(text('edit.title'))
  })

  it('[completeness] a stale runtime keeps its views and retries the full refresh once', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER], 'error'),
    })
    await flush()
    expect(mounted.text()).toContain(text('runtime.stale'))
    expect(mounted.host.querySelector('[data-server="' + SERVER + '"]')).not.toBeNull()
    const before = mounted.calls.refresh.length
    buttonWith(mounted.host, text('action.retry')).click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added.length).toBe(1)
    expect(added[0]).toEqual({ silent: undefined, server: undefined })
  })


  it('[completeness] an unavailable runtime with no cached views shows no stale banner', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: { phase: 'unavailable', servers: {} },
    })
    await flush()
    expect(mounted.text()).not.toContain(text('runtime.stale'))
    expect(mounted.text()).toContain(text('status.unavailable'))
  })

  it('[completeness] runtime status unavailable still leaves Test reachable', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: { phase: 'unavailable', servers: {} },
    })
    await flush()
    const detail = await openServer(mounted, SERVER)
    expect(detail.textContent).toContain(text('runtime.unavailable'))
    buttonWith(detail, text('action.test')).click()
    await flush()
    expect(mounted.calls.test).toEqual([SERVER])
  })
})

describe('C4 optimality: writes, requests and DOM', () => {
  it('[optimality] a re-render performs no extra write or refresh', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const writes = mounted.calls.writes.length
    const refreshes = mounted.calls.refresh.length
    mounted.rerender()
    await flush()
    expect(mounted.calls.writes.length).toBe(writes)
    expect(mounted.calls.refresh.length).toBe(refreshes)
  })

  it('[optimality] the list renders no workspace switches (scope is detail-only)', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: overridesOf({ 'ws-1': [SERVER] }) },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    expect(mounted.host.querySelectorAll('input[role="switch"]')).toHaveLength(0)
    await openServer(mounted, SERVER)
    const scopeSwitches = Array.from(mounted.host.querySelectorAll<HTMLInputElement>('input[role="switch"]')).filter(
      (input) => input.getAttribute('aria-label')?.startsWith(text('server.workspacesTitle')),
    )
    expect(scopeSwitches).toHaveLength(WS.length)
  })

  it('[optimality] unmounting cancels the status timer', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const before = mounted.calls.refresh.length
    mounted.unmount()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mounted.calls.refresh.length).toBe(before)
  })
})
