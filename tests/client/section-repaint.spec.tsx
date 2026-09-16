// @vitest-environment jsdom
/**
 * A settings update must DIFF IN PLACE. The reported symptom ("enabling a
 * server flashes the whole panel") can only come from a re-render that throws
 * the subtree away and rebuilds it, so this pins the property that rules our
 * section out: one settings commit may touch text and attributes, but it must
 * add and remove NO node.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { McpScopeSection, type McpScopeSectionProps } from '../../src/client/section.tsx'
import { styles } from '../../src/client/styles.ts'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { McpScopeDoc } from '../../src/shared/model.ts'
import type { CredentialInfo } from '../../src/client/controller.ts'

function t(key: SettingsKey, params?: Record<string, string | number>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

const live = {
  doc: {
    servers: [
      { serverName: 'alpha', transport: 'stdio', command: 'node', args: ['a.js'], envKeys: [] },
      { serverName: 'beta', transport: 'stdio', command: 'node', args: ['b.js'], envKeys: [] },
    ],
    overrides: {},
    disabled: {},
  } as McpScopeDoc,
  revision: 3,
}

function propsOf(): McpScopeSectionProps {
  const wsState = {
    items: [
      { workspaceId: 'ws-1', title: 'tmp' },
      { workspaceId: 'ws-2', title: 'daily' },
      { workspaceId: 'ws-3', title: 'quant' },
      { workspaceId: 'ws-4', title: 'perf' },
      { workspaceId: 'ws-5', title: 'literature' },
    ],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  const snapshot = {
    status: 'ready',
    doc: live.doc,
    revision: live.revision,
    writable: true,
    credentials: {} as Record<string, CredentialInfo>,
    credentialsAt: 0,
  }
  const runtime = { phase: 'ready', servers: {} }
  const ok = async () => ({ ok: true as const })
  return {
    close: async () => {},
    t: t as unknown as McpScopeSectionProps['t'],
    useDoc: ((selector: (s: unknown) => unknown) => selector(snapshot)) as unknown as McpScopeSectionProps['useDoc'],
    useWorkspaces: ((selector: (s: unknown) => unknown) => selector(wsState)) as unknown as McpScopeSectionProps['useWorkspaces'],
    addServer: ok,
    replaceServer: ok,
    removeServer: ok,
    toggleWorkspace: ok,
    toggleWorkspaces: ok,
    setServerEnabled: ok,
    unsetCredential: ok,
    useRuntime: ((selector: (s: unknown) => unknown) => selector(runtime)) as unknown as McpScopeSectionProps['useRuntime'],
    refreshRuntime: async () => {},
    connectServer: async () => {},
    disconnectServer: async () => {},
    testServer: async () => ({ ok: true }),
    loadTools: async () => ({ tools: [], truncated: false, total: 0 }),
  }
}

const tracked: { root: Root; host: HTMLDivElement }[] = []
afterEach(() => {
  for (const entry of tracked.splice(0)) {
    entry.root.unmount()
    entry.host.remove()
  }
})

describe('section repaint discipline', () => {
  it('diffs a settings commit in place: no node is added or removed', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(<McpScopeSection {...propsOf()} />)
    tracked.push({ root, host })
    await flush()
    // Open every card's workspace list so the update has the most to churn.
    const manage = en['row.manage'].split('(')[0]!.trim()
    for (const button of Array.from(host.querySelectorAll('button'))) {
      if ((button.textContent ?? '').includes(manage)) (button as HTMLButtonElement).click()
    }
    await flush()
    const rows = host.querySelectorAll('.' + styles.wsRow).length
    expect(rows).toBeGreaterThan(0)
    const counts = { added: 0, removed: 0 }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        counts.added += record.addedNodes.length
        counts.removed += record.removedNodes.length
      }
    })
    observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true })
    // ONE settings commit: a workspace enable plus a revision bump.
    live.doc = { ...live.doc, overrides: { 'ws-1': { alpha: true } } }
    live.revision = 4
    root.render(<McpScopeSection {...propsOf()} />)
    await flush()
    observer.disconnect()
    expect(counts).toEqual({ added: 0, removed: 0 })
  })
})
