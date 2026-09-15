// @vitest-environment jsdom
/**
 * The injected-tools row: one line in the conversation lane, DERIVED from the
 * harness's own `request/header` events (the plugin writes no session event).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  McpInjectionRow,
  createInjectionNodeDefinition,
  registerInjectionRow,
  type InjectionContextReaderLike,
  type InjectionRowState,
} from '../../src/client/injection-row.tsx'
import { MCP_INJECTION_NODE_KIND } from '../../src/client/injection.ts'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { ServerDef } from '../../src/shared/model.ts'

const t = (key: SettingsKey, params?: Record<string, string | number>): string =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const definition = createInjectionNodeDefinition()

/** One `request/header` event carrying the given model-facing tool names. */
const header = (seq: number, reason: string, names: string[]): { type: string; seq: number; time: number; data: unknown } => ({
  type: 'request/header',
  seq,
  time: 1,
  data: { header: { config: {}, tools: names.map((name) => ({ name })) }, reason },
})

const zotero = ['mcp__zotero__search', 'mcp__zotero__item']

/** Reader whose nearest predecessor state is the given one. */
const readerWith = (state: InjectionRowState | undefined): InjectionContextReaderLike => ({
  previous: <State,>(kind: string) =>
    kind === MCP_INJECTION_NODE_KIND && state !== undefined ? { state: state as unknown as Readonly<State> } : undefined,
})

const stateOf = (event: ReturnType<typeof header>, previous?: InjectionRowState): InjectionRowState =>
  definition.start(undefined, { event }, readerWith(previous))

const nodeOf = (state: InjectionRowState): Record<string, unknown> | null =>
  definition.buildViewNode({ key: 'k', id: 'i', state })

let root: Root | undefined
let host: HTMLElement | undefined

async function render(data: unknown): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<McpInjectionRow node={{ data }} t={t} />)
  // React commits concurrently: wait one tick before asserting on the DOM.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return host
}

afterEach(() => {
  root?.unmount()
  root = undefined
  host?.remove()
  host = undefined
})

describe('MCP injection row view', () => {
  it('renders one line with the plug glyph, every server and the tool total', async () => {
    const node = await render({ servers: [{ name: 'zotero', toolCount: 43 }, { name: 'email', toolCount: 18 }] })
    const row = node.querySelector('[data-mcp-injection]')
    expect(row).not.toBeNull()
    expect(node.textContent).toContain(en['injection.title'])
    expect(node.textContent).toContain('zotero (43)')
    expect(node.textContent).toContain('email (18)')
    expect(node.textContent).toContain('61 tools in context')
    // the shipped icon, not a literal
    expect(row?.querySelector('svg')).not.toBeNull()
  })

  it('renders nothing when the payload is unusable', async () => {
    for (const data of [undefined, null, {}, { servers: [] }, { servers: [{ name: '' }] }]) {
      const node = await render(data)
      expect(node.querySelector('[data-mcp-injection]')).toBeNull()
    }
  })
})

describe('MCP injection node definition', () => {
  it('matches ONLY request/header, and every header opens its own Context', () => {
    // The engine allows one start per Context id and throws on a second one, so
    // the id is the event's own seq — never a session-wide row id that a bounded
    // window could open without its matching event.
    expect(definition.match(header(12, 'initial', zotero))).toEqual({ id: '12', role: 'start' })
    expect(definition.match(header(40, 'series', zotero))).toEqual({ id: '40', role: 'start' })
    expect(definition.match({ type: 'user/message', seq: 1 })).toBeNull()
    expect(definition.match({})).toBeNull()
  })

  it('derives the injected set from the header and anchors just before it', () => {
    const state = stateOf(header(12, 'initial', zotero))
    expect(state.servers).toEqual([{ name: 'zotero', toolCount: 2 }])
    expect(state.total).toBe(2)
    expect(state.unchanged).toBe(false)
    const node = nodeOf(state)
    expect(node).toMatchObject({
      key: 'k',
      id: 'i',
      kind: 'mcp-scope-injected',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 11.9,
      data: { servers: [{ name: 'zotero', toolCount: 2 }], total: 2 },
    })
  })

  it('adds NO row when the nearest earlier header offered the same set', () => {
    const previous = stateOf(header(12, 'initial', zotero))
    const state = stateOf(header(40, 'series', zotero), previous)
    expect(state.unchanged).toBe(true)
    expect(nodeOf(state)).toBeNull()
  })

  it('adds one row where a real change took effect', () => {
    const previous = stateOf(header(12, 'initial', zotero))
    const state = stateOf(header(40, 'change', [...zotero, 'mcp__email__send']), previous)
    expect(state.unchanged).toBe(false)
    expect(nodeOf(state)).toMatchObject({
      anchorSeq: 39.9,
      data: { servers: [{ name: 'email', toolCount: 1 }, { name: 'zotero', toolCount: 2 }], total: 3 },
    })
  })

  it('shows nothing for a request that carried no MCP tools', () => {
    const state = stateOf(header(7, 'initial', ['run_code', 'read_file']))
    expect(state.servers).toEqual([])
    expect(nodeOf(state)).toBeNull()
  })

  it('re-emits a MATERIALIZED row hidden instead of withdrawing it', () => {
    // The engine throws when a Definition drops a target node it already
    // materialized ("withdrew materialized target ...; return the same key with
    // hidden visibility instead"). A later evaluation can flip this Context to
    // unchanged or empty — a prepended history page supplies the predecessor the
    // first pass could not see — so an existing row must stay, hidden.
    const previous = stateOf(header(12, 'initial', zotero))
    const unchanged = stateOf(header(40, 'series', zotero), previous)
    const empty = stateOf(header(60, 'series', ['run_code']))
    const materialized = new Map<string, unknown>([['chat', { key: 'k' }]])

    expect(definition.buildViewNode({ key: 'k', id: 'i', state: unchanged, current: materialized })).toMatchObject({
      key: 'k',
      kind: 'mcp-scope-injected',
      visibility: 'hidden',
    })
    expect(definition.buildViewNode({ key: 'k', id: 'i', state: empty, current: materialized })).toMatchObject({
      visibility: 'hidden',
    })
    // Nothing materialized yet: the same states render no node at all.
    expect(definition.buildViewNode({ key: 'k', id: 'i', state: unchanged })).toBeNull()
    expect(definition.buildViewNode({ key: 'k', id: 'i', state: empty })).toBeNull()
  })

  it('keeps its state on update and skips a context that has no start yet', () => {
    const state = stateOf(header(12, 'initial', zotero))
    expect(definition.update({ state })).toBe(state)
    expect(definition.buildViewNode({ key: 'k', id: 'i' })).toBeNull()
  })

  it('uses the configured server list for longest-prefix ownership', () => {
    const servers = (): ServerDef[] => [{ serverName: 'my_server', transport: 'stdio', command: 'run' }]
    const scoped = createInjectionNodeDefinition({ servers })
    const state = scoped.start(undefined, { event: header(3, 'initial', ['mcp__my_server__tool']) })
    expect(state.servers).toEqual([{ name: 'my_server', toolCount: 1 }])
  })
})

describe('MCP injection row registration', () => {
  /** Minimal cordis-like host: the effect runs immediately, disposer retained. */
  const mountHost = (options: { inject?: boolean; injectThrows?: boolean; registerThrows?: boolean } = {}) => {
    const definitions: unknown[] = []
    const views: { options: Record<string, unknown>; view: unknown }[] = []
    const disposers: (() => void)[] = []
    const injectedNames: string[][] = []
    const scope = {
      effect(callback: () => void | (() => void)) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      slots: {
        inject(_seat: string, callback: () => void | (() => void)) { callback() },
        register(viewOptions: Record<string, unknown>, view: unknown) {
          views.push({ options: viewOptions, view })
          return () => {}
        },
      },
      uiConversation: {
        events: {
          register(definition: unknown) {
            if (options.registerThrows === true) throw new Error('Definition "mcp-scope-injected" is already registered')
            definitions.push(definition)
            return () => {}
          },
        },
      },
    }
    const errors: unknown[] = []
    const host = options.inject === false
      ? {}
      : {
          inject(names: readonly string[], apply: (value: unknown) => void) {
            injectedNames.push([...names])
            if (options.injectThrows === true) throw new Error('service uiConversation is unavailable')
            apply(scope)
          },
        }
    registerInjectionRow(host as never, { onError: (error) => errors.push(error) })
    return { definitions, views, errors, disposers, injectedNames }
  }

  it('registers the header-driven definition and the keyed chat-node view', () => {
    const mounted = mountHost()
    expect(mounted.injectedNames).toEqual([['uiConversation']])
    expect(mounted.definitions).toHaveLength(1)
    expect((mounted.definitions[0] as { kind: string }).kind).toBe(MCP_INJECTION_NODE_KIND)
    expect(mounted.views).toHaveLength(1)
    expect(mounted.views[0]?.options).toMatchObject({ name: 'conversation.chat.node', key: MCP_INJECTION_NODE_KIND })
    expect(mounted.views[0]?.view).toBe(McpInjectionRow)
    expect(mounted.errors).toEqual([])
    // Disposal (HMR/unload) reaches the definition registration.
    for (const dispose of mounted.disposers) dispose()
  })

  it('degrades silently when the optional conversation service is absent', () => {
    const mounted = mountHost({ inject: false })
    expect(mounted.definitions).toEqual([])
    expect(mounted.views).toEqual([])
    expect(mounted.errors).toEqual([])
  })

  it('contains a registration failure instead of failing the plugin apply', () => {
    // A second apply without disposal (HMR) makes events.register throw; the row
    // must stay off while the rest of the plugin keeps working.
    const unavailable = mountHost({ injectThrows: true })
    expect(unavailable.errors).toHaveLength(1)
    const duplicate = mountHost({ registerThrows: true })
    expect(duplicate.errors).toHaveLength(1)
    expect(duplicate.definitions).toEqual([])
  })
})

describe('MCP injection node definition (ownership)', () => {
  it('uses the configured server list for longest-prefix ownership', () => {
    const servers = (): ServerDef[] => [{ serverName: 'my_server', transport: 'stdio', command: 'run' }]
    const scoped = createInjectionNodeDefinition({ servers })
    const state = scoped.start(undefined, { event: header(3, 'initial', ['mcp__my_server__tool']) })
    expect(state.servers).toEqual([{ name: 'my_server', toolCount: 1 }])
  })
})
