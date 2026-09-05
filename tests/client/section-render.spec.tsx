// @vitest-environment jsdom
// Render evidence for the MCP section UI: the settings.section component
// renders server cards, per-workspace rows and the add form from a store
// snapshot, with all copy arriving through the locale seat (en dictionary).
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { McpScopeSection, type McpScopeSectionProps } from '../../src/client/section.tsx'
// pull the slot/locale module augmentations (register-site decls) into this program
import type {} from '../../src/client/index.ts'
import { en, zh, type SettingsKey } from '../../src/client/locales.ts'
import type { McpScopeDoc } from '../../src/shared/model.ts'

function t(key: SettingsKey, params?: Record<string, string | number>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

const NOOP = async () => ({ ok: true as const })

// Test-only casts: the composed props re-state framework types that collapse to
// opaque cross-package shapes in this dev tree (see docs/ui-notes.md).
function propsOf(doc: McpScopeDoc, workspaceItems: { workspaceId: string; title: string }[]): McpScopeSectionProps {
  const snapshot = { status: 'ready' as const, doc, revision: 3, writable: true, credentials: {}, credentialsAt: 0 }
  const state = { items: workspaceItems, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined }
  return {
    close: () => {},
    t: t as unknown as McpScopeSectionProps['t'],
    useDoc: ((selector: (s: unknown) => unknown) => selector(snapshot)) as unknown as McpScopeSectionProps['useDoc'],
    useWorkspaces: ((selector: (s: unknown) => unknown) => selector(state)) as unknown as McpScopeSectionProps['useWorkspaces'],
    addServer: NOOP,
    removeServer: NOOP,
    toggleWorkspace: NOOP,
    unsetCredential: NOOP,
  }
}

async function renderText(props: McpScopeSectionProps): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<McpScopeSection {...props} />)
  await new Promise((r) => setTimeout(r, 20)) // flush React 18 async render
  return host.textContent ?? ''
}

describe('McpScopeSection render', () => {
  it('renders the section header, empty state and the add-server affordance', async () => {
    const text = await renderText(propsOf({ servers: [], overrides: {} }, []))
    expect(text).toContain(en.nav)
    expect(text).toContain(en['empty.servers'])
    expect(text).toContain(en['add.add'])
  })

  it('renders server cards with transport, scope summary and workspace rows', async () => {
    const doc: McpScopeDoc = {
      servers: [
        { serverName: 'fixture', transport: 'stdio', command: 'node', args: ['a.js'], envKeys: ['TOK'] },
        { serverName: 'ctx', transport: 'streamable-http', url: 'http://x/mcp', headers: [{ name: 'Authorization', ref: 'AUTH' }] },
      ],
      overrides: { 'ws-b': { fixture: true } },
    }
    const items = [
      { workspaceId: 'ws-a', title: 'alpha' },
      { workspaceId: 'ws-b', title: 'beta' },
    ]
    const text = await renderText(propsOf(doc, items))
    expect(text).toContain('fixture')
    expect(text).toContain('ctx')
    expect(text).toContain(en['transport.stdio'])
    expect(text).toContain(en['transport.http'])
    expect(text).toContain('Off in 1 workspaces')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain(en['server.newWorkspaceDefault'])
    expect(text).toContain(en['row.on'])
    expect(text).toContain(en['row.off'])
    // credential ref badges
    expect(text).toContain('TOK')
    expect(text).toContain(en['secret.unset'])
  })

  it('zh dictionary mirrors the en key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
