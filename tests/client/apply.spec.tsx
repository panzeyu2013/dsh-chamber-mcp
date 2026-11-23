// @vitest-environment jsdom
/**
 * Runtime coverage of the browser entry (src/client/index.ts).
 *
 * The owner suites exercise the section, the controller, the runtime store and
 * the transcript row in isolation; this file pins the composition: the inject
 * list, locale registration, the settings.section options/inject face, and the
 * keyed tool-row registration at shadowing rank 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../../src/client/index.ts'
import { McpScopeSection } from '../../src/client/section.tsx'
import { McpSectionGlyph } from '../../src/client/tool-card/icon.tsx'
import { en } from '../../src/client/locales.ts'
import type { McpScopeDoc } from '../../src/shared/model.ts'

const noop = (): void => {}

function source<T>(get: () => T) {
  return { getSnapshot: get, subscribe: () => noop }
}

function makeCtx(options: { doc: McpScopeDoc; sessions?: unknown; failRegistrations?: readonly string[] }) {
  const specs: { spec: Record<string, unknown>; component: unknown }[] = []
  const effects: (() => void)[] = []
  const warns: string[] = []
  /** Forwarded host events the entry subscribed to, and their listeners. */
  const remoteEvents = new Map<string, ((...args: unknown[]) => void)[]>()
  let dictionaries: { en: Record<string, string>; zh: Record<string, string> } | undefined
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: options.doc, revision: 1, writable: true }),
    subscribe: () => noop,
    mutate: async () => undefined,
  }
  const ctx = {
    effect(fn: () => void | (() => void)) {
      const off = fn()
      if (typeof off === 'function') effects.push(off)
      return noop
    },
    on: () => noop,
    locale: {
      register: (_ns: string, dicts: { en: Record<string, string>; zh: Record<string, string> }) => {
        dictionaries = dicts
        return noop
      },
      bind: () => (key: keyof typeof en) => en[key] ?? String(key),
      subscribe: () => noop,
    },
    configForms: { get: (id: string) => (id === 'mcp-scope' ? scope : undefined) },
    remote: {
      $on: (event: string, listener: (...args: unknown[]) => void) => {
        const listeners = remoteEvents.get(event) ?? []
        listeners.push(listener)
        remoteEvents.set(event, listeners)
        return noop
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
        unset: async () => ({ ok: true, value: undefined }),
      },
    },
    slots: {
      inject(_key: string, callback: () => unknown) {
        const result = callback()
        return typeof result === 'function' ? result : noop
      },
      register(spec: Record<string, unknown>, component: unknown) {
        // Seat-failure seam: the containment tests make one registration throw,
        // exactly as an occupied same-priority slot does in the real slot core.
        if (options.failRegistrations?.includes(String(spec['name']))) {
          throw new Error(`slot "${String(spec['name'])}" already has a registration`)
        }
        specs.push({ spec, component })
        return noop
      },
    },
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    logger: { warn: (message: string) => warns.push(message) },
  }
  return {
    ctx: ctx as unknown as Context,
    specs,
    effects,
    warns,
    remoteEvents,
    dictionaries: () => dictionaries,
  }
}

const doc = (): McpScopeDoc => ({
  servers: [{ serverName: 'fixture', transport: 'stdio', command: 'node' }],
  overrides: {},
})

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

const mounted: { effects: (() => void)[] }[] = []
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    for (const dispose of entry.effects.reverse()) dispose()
  }
  document.body.replaceChildren()
})

describe('browser entry composition', () => {
  it('declares the services it calls and registers the settings section with its face', async () => {
    const harness = makeCtx({ doc: doc() })
    mounted.push({ effects: harness.effects })
    apply(harness.ctx)
    await flush()

    expect(inject).toEqual([
      'slots',
      'locale',
      'remote',
      'remote.credentials',
      'configForms',
      'workspaces',
      'sessions',
    ])

    const section = harness.specs.find((entry) => entry.spec['name'] === 'settings.section')
    expect(section).toBeDefined()
    expect(section!.component).toBe(McpScopeSection)
    expect(section!.spec['id']).toBe('mcp-scope')
    expect(section!.spec['order']).toBe(25)
    expect(section!.spec['locale']).toBe('mcp-scope.settings')
    expect((section!.spec['label'] as () => string)()).toBe('MCP servers')

    const face = (section!.spec['inject'] as () => Record<string, unknown>)()
    const hooks = face['hooks'] as {
      doc: { getSnapshot(): { status: string; doc: McpScopeDoc } }
      runtime: { getSnapshot(): unknown }
    }
    expect(hooks.doc.getSnapshot().status).toBe('ready')
    expect(hooks.doc.getSnapshot().doc.servers[0]?.serverName).toBe('fixture')
    expect(typeof hooks.runtime.getSnapshot).toBe('function')
    for (const action of [
      'addServer',
      'replaceServer',
      'removeServer',
      'toggleWorkspace',
      'toggleWorkspaces',
      'toggleWorkspaceServers',
      'restoreScopeValues',
      'setServerEnabled',
      'unsetCredential',
      'refreshRuntime',
      'connectServer',
      'disconnectServer',
      'restartServer',
      'testServer',
      'authorizeServer',
      'cancelAuthorization',
      'signOutServer',
      'loadTools',
    ]) {
      expect(typeof face[action], action).toBe('function')
    }

    expect(harness.dictionaries()?.en['nav']).toBe('MCP servers')
    expect(document.querySelector('style[data-plugin-css]')).not.toBeNull()
  })

  it('registers the settings sidebar icon through the official settings.section.icon seat', async () => {
    const harness = makeCtx({ doc: doc() })
    mounted.push({ effects: harness.effects })
    apply(harness.ctx)
    await flush()

    const icon = harness.specs.find((entry) => entry.spec['name'] === 'settings.section.icon')
    expect(icon, 'no settings.section.icon contribution registered').toBeDefined()
    // The seat keys by section id: an unmatched id silently keeps the shell's
    // gear, so the id is the load-bearing part of the registration.
    expect(icon!.spec['id']).toBe('mcp-scope')
    expect(icon!.spec['locale']).toBe('mcp-scope.settings')
    expect(icon!.component).toBe(McpSectionGlyph)

    // Owner props are {size, active}: the plug renders at the size the shell
    // asks for, strokes with currentColor and ignores `active`, so the row's
    // own colour token paints both states (no duplicate state styling here).
    const markup = renderToStaticMarkup(<McpSectionGlyph size={20} />)
    expect(markup).toContain('width="20"')
    expect(markup).toContain('height="20"')
    expect(markup).toContain('viewBox="0 0 24 24"')
    expect(markup).toContain('M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z')
    expect(markup).toContain('currentColor')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('subscribes the OAuth grant signal and forwards it into the silent-refresh store API', async () => {
    // alpha.2 forwards `credentials/record-updated`; that is what flips the
    // authorization pill after a grant commit without a fast poll. The entry
    // must subscribe at apply time and the handler must never throw into the
    // event stream.
    const harness = makeCtx({ doc: doc() })
    mounted.push({ effects: harness.effects })
    apply(harness.ctx)
    await flush()

    expect(Array.from(harness.remoteEvents.keys())).toEqual(
      expect.arrayContaining([
        'settings/document-updated',
        'credentials/reference-updated',
        'credentials/record-updated',
      ]),
    )
    const listeners = harness.remoteEvents.get('credentials/record-updated') ?? []
    expect(listeners).toHaveLength(1)
    expect(() => listeners[0]!('mcp-client/mcp-scope-abcd1234')).not.toThrow()
    // A key outside this plugin's namespace is an inert no-op.
    expect(() => listeners[0]!('other-plugin/key')).not.toThrow()
    expect(() => listeners[0]!(42)).not.toThrow()
  })

  it('never registers into the single-occupant settings.notice slot', async () => {
    // The official account plugin owns settings.notice; a same-priority second
    // registration throws inside apply and takes the whole browser half down
    // (alpha.2 slot fact F4) — this entry must never touch that seat.
    const harness = makeCtx({ doc: doc() })
    mounted.push({ effects: harness.effects })
    apply(harness.ctx)
    await flush()

    expect(harness.specs.some((entry) => entry.spec['name'] === 'settings.notice')).toBe(false)
  })

  it('contains a throwing section or icon registration instead of failing apply', async () => {
    const harness = makeCtx({
      doc: doc(),
      failRegistrations: ['settings.section', 'settings.section.icon'],
    })
    mounted.push({ effects: harness.effects })
    // ADR-10: a lost seat degrades (no section / no icon) and is reported once;
    // it must never throw out of the shell's mount path or become an uncaught
    // microtask error on a later declaration epoch.
    expect(() => apply(harness.ctx)).not.toThrow()
    await flush()

    expect(harness.specs.some((entry) => entry.spec['name'] === 'settings.section')).toBe(false)
    expect(harness.specs.some((entry) => entry.spec['name'] === 'settings.section.icon')).toBe(false)
    const contained = harness.warns.filter((message) => message.includes('could not register'))
    expect(contained).toHaveLength(2)
    expect(contained.some((message) => message.includes('the settings section'))).toBe(true)
    expect(contained.some((message) => message.includes('the settings sidebar icon'))).toBe(true)
    // The rest of the composition still mounted: the stylesheet is on the page.
    expect(document.querySelector('style[data-plugin-css]')).not.toBeNull()
  })

  it('registers one keyed tool.call.toolview per discovered MCP name at rank 1', async () => {
    const entries = [
      {
        type: 'event',
        event: {
          type: 'request/header',
          data: { header: { tools: [{ name: 'mcp__fixture__greet' }, { name: 'bash' }] } },
        },
      },
    ]
    const sessions = {
      list: source(() => ({
        ids: ['s1'],
        byId: { s1: { retainedBy: { mainView: 1 } } },
        phase: 'ready',
        projectionsBySession: {},
      })),
      binding: (id: string) => (id === 's1' ? { eventSource: source(() => ({ entries })) } : undefined),
      retainInfo: () => source(() => ({ retainedBy: { mainView: 1 } })),
    }
    const harness = makeCtx({ doc: doc(), sessions })
    mounted.push({ effects: harness.effects })
    apply(harness.ctx)
    await flush()

    const row = harness.specs.find(
      (entry) => entry.spec['name'] === 'tool.call.toolview' && entry.spec['key'] === 'mcp__fixture__greet',
    )
    expect(row, 'the discovered MCP name registered no keyed view').toBeDefined()
    expect(row!.spec['locale']).toBe('mcp-scope.settings')
    expect(row!.spec['priority']).toBe(1)
    expect(typeof row!.component).toBe('function')
    expect(harness.specs.some((entry) => entry.spec['key'] === 'bash')).toBe(false)
  })
})
