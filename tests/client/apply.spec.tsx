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
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../../src/client/index.ts'
import { McpScopeSection } from '../../src/client/section.tsx'
import { en } from '../../src/client/locales.ts'
import type { McpScopeDoc } from '../../src/shared/model.ts'

const noop = (): void => {}

function source<T>(get: () => T) {
  return { getSnapshot: get, subscribe: () => noop }
}

function makeCtx(options: { doc: McpScopeDoc; sessions?: unknown }) {
  const specs: { spec: Record<string, unknown>; component: unknown }[] = []
  const effects: (() => void)[] = []
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
      $on: () => noop,
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
        specs.push({ spec, component })
        return noop
      },
    },
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    logger: { warn: noop },
  }
  return {
    ctx: ctx as unknown as Context,
    specs,
    effects,
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
      'testServer',
      'loadTools',
    ]) {
      expect(typeof face[action], action).toBe('function')
    }

    expect(harness.dictionaries()?.en['nav']).toBe('MCP servers')
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
