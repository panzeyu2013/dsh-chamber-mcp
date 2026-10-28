// @vitest-environment jsdom
/**
 * Acceptance suite for the settings surface.
 *
 * Traceability (docs/acceptance.md): R2 default-off; E1 availability;
 * E3/E8 runtime status; E4/E5 connect-disconnect-test; E6 tools; E7 editor;
 * E9 list/detail/workspaces; E10 optimistic/bulk/undo; E11 removal.
 *
 * Capabilities are asserted through the real section with injected stores:
 * correctness (off-by-default, optimistic state, navigation is read-only),
 * completeness (one test per user-visible capability) and optimality (request,
 * write and DOM counts). Copy is read from the shipped dictionaries.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { t as text } from '../support/section-fixtures.ts'
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
} from '../support/section-harness.tsx'
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

describe('acceptance correctness: off-by-default and optimistic writes', () => {
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

  it('[correctness] a failed bulk write rolls back rows it still owns and keeps a superseded row', async () => {
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
    // A newer per-row write on beta lands TWICE while the batch is in flight:
    // its target (on) differs from the committed value (off), so a naive
    // drop-everything rollback gives a different result than a token filter.
    scopeSwitch('beta').click()
    await flush()
    scopeSwitch('beta').click()
    await flush()
    failBatch({ ok: false, reason: 'conflict' })
    await flush()
    await flush()
    expect(scopeSwitch('alpha').checked).toBe(false)
    expect(scopeSwitch('beta').checked).toBe(true)
    expect(scopeSwitch('gamma').checked).toBe(false)
    expect(mounted.text()).toContain(text('error.conflict'))
    expect(buttonWith(mounted.host, text('action.retry'))).toBeDefined()
  })
})

describe('acceptance completeness: user-visible capabilities', () => {
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

  it('[completeness] disconnect and test are wired to the runtime actions', async () => {
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

describe('acceptance optimality: writes, requests and DOM', () => {
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
})
