// @vitest-environment jsdom
/**
 * The registered-tools row: one disclosure line in the conversation lane, DERIVED
 * from the harness's own session events — the union of the request's tool array
 * and the names its rendered system prompt DECLARES (the plugin writes nothing
 * into a session) — plus the render/registration contract around it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  McpInjectionRow,
  createInjectionNodeDefinition,
  registerInjectionRow,
  type InjectionContextReaderLike,
  type InjectionMatchLike,
  type InjectionRowState,
} from '../../src/client/injection-row.tsx'
import { INJECTION_NAME_LIMIT, MCP_INJECTION_NODE_KIND } from '../../src/client/injection.ts'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { ServerDef } from '../../src/shared/model.ts'

const t = (key: SettingsKey, params?: Record<string, string | number>): string =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

/**
 * Server identities the spec's public names belong to. The notice only reports
 * names a CONFIGURED server owns (an unowned name is prose or a stale header),
 * so the default definition is given the live list the plugin would pass it.
 */
const SERVER_NAMES = ['a', 'a__b', 'email', 'fixture', 'my-server', 'my_server', 'sharelatex', 'zotero']

const definition = createInjectionNodeDefinition({
  servers: () => SERVER_NAMES.map((serverName) => ({ serverName, transport: 'stdio', command: 'run' })),
})

/** One `request/header` event carrying the given model-facing tool names. */
const header = (seq: number, reason: string, names: string[]): { type: string; seq: number; time: number; data: unknown } => ({
  type: 'request/header',
  seq,
  time: 1,
  data: { header: { config: {}, tools: names.map((name) => ({ name })) }, reason },
})

/** Two zotero tools, in the order the projection reports them (sorted). */
const zotero = ['mcp__zotero__item', 'mcp__zotero__search']

/**
 * Reader whose nearest predecessor state is the given one, and whose
 * `system-message` Context carries the given effective prompt text (the
 * official shape the Chat lane's own `request-prompt` definition reads).
 */
const readerWith = (
  state: InjectionRowState | undefined,
  prompt?: string,
  promptAnchor?: { turn?: number; step?: number },
): InjectionContextReaderLike => ({
  previous: <State,>(kind: string) => {
    if (kind === MCP_INJECTION_NODE_KIND && state !== undefined) return { state: state as unknown as Readonly<State> }
    if (kind === 'system-message' && prompt !== undefined) {
      return { state: { effective: { text: prompt } } as unknown as Readonly<State> }
    }
    if (kind === 'request-prompt' && promptAnchor !== undefined) {
      return { state: promptAnchor as unknown as Readonly<State> }
    }
    return undefined
  },
})

/** Engine-resolved location of a first-step request (turn start 6, step start 8). */
const stepLocation = { kind: 'step', turn: { turn: 1, start: { seq: 6 } }, step: { step: 1, start: { seq: 8 } } }

const stateOf = (
  event: ReturnType<typeof header>,
  previous?: InjectionRowState,
  location?: InjectionMatchLike['location'],
  prompt?: string,
  promptAnchor?: { turn?: number; step?: number },
): InjectionRowState => {
  const match: InjectionMatchLike = location === undefined ? { event } : { event, location }
  return definition.start(undefined, match, readerWith(previous, prompt, promptAnchor))
}

const nodeOf = (state: InjectionRowState): Record<string, unknown> | null =>
  definition.buildViewNode({ key: 'k', id: 'i', state })

let root: Root | undefined
let host: HTMLElement | undefined

/** React commits concurrently: wait one tick before asserting on the DOM. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function render(data: unknown): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<McpInjectionRow node={{ data }} t={t} />)
  await flush()
  return host
}

/** The disclosure head of the rendered notice (the row IS the control). */
function headOf(node: HTMLElement): HTMLElement {
  const head = node.querySelector<HTMLElement>('[data-mcp-injection] [role="button"]')
  if (head === null) throw new Error('the notice row is not a control')
  return head
}

afterEach(() => {
  root?.unmount()
  root = undefined
  host?.remove()
  host = undefined
})

describe('MCP injection row view', () => {
  it('collapsed, it renders ONLY the registered line — no source, no count', async () => {
    const node = await render({
      servers: [
        { name: 'zotero', toolCount: 43, tools: ['mcp__zotero__search'] },
        { name: 'email', toolCount: 18, tools: ['mcp__email__send'] },
      ],
    })
    const row = node.querySelector('[data-mcp-injection]')
    expect(row).not.toBeNull()
    // The shipped icon, not a literal.
    expect(row?.querySelector('svg')).not.toBeNull()
    const head = headOf(node)
    expect(head.textContent).toBe(en['injection.title'])
    expect(node.textContent).not.toContain('zotero')
    expect(node.textContent).not.toContain('email')
    expect(node.textContent).not.toContain('61')
    // Collapsed like the shipped rows: a control with no body yet.
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.getAttribute('tabindex')).toBe('0')
    expect(node.querySelector('[data-injection-body]')).toBeNull()
  })

  it('opens on one summary line, then a disclosure per source, then that source list', async () => {
    const node = await render({
      servers: [
        { name: 'zotero', toolCount: 43, tools: ['mcp__zotero__search', 'mcp__zotero__fetch'] },
        { name: 'email', toolCount: 18, tools: ['mcp__email__send'] },
      ],
    })
    const head = headOf(node)
    head.click()
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(node.querySelector('[data-mcp-injection]')?.hasAttribute('data-open')).toBe(true)
    // FIRST line: every source with its count.
    expect(node.querySelector('[data-injection-summary]')?.textContent).toBe('zotero (43) · email (18)')
    // THEN one disclosure per source, all closed: no tool name yet.
    const serverHeads = Array.from(node.querySelectorAll('[data-injection-server-head]'))
    expect(serverHeads.map((entry) => entry.getAttribute('data-injection-server-head'))).toEqual(['zotero', 'email'])
    expect(serverHeads.map((entry) => entry.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    expect(serverHeads[0]?.textContent).toBe('zotero (43)')
    expect(node.querySelector('[data-injection-tool]')).toBeNull()
    // Expanding ONE source names only that source's tools.
    ;(serverHeads[0] as HTMLElement).click()
    await flush()
    expect(serverHeads[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(Array.from(node.querySelectorAll('[data-injection-tool]')).map((el) => el.textContent)).toEqual([
      'mcp__zotero__search',
      'mcp__zotero__fetch',
    ])
    // A list that fits omits nothing: the count IS the number of names.
    expect(node.querySelector('[data-injection-server-tools]')?.textContent).not.toContain('not listed')
    // The root collapses the whole body again.
    head.click()
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(node.querySelector('[data-injection-body]')).toBeNull()
  })

  it('expands from the keyboard like the shipped rows (root and source)', async () => {
    const node = await render({ servers: [{ name: 'a', toolCount: 1, tools: ['mcp__a__x'] }] })
    const head = headOf(node)
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    const source = node.querySelector('[data-injection-server-head]') as HTMLElement
    source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(source.getAttribute('aria-expanded')).toBe('true')
    expect(node.querySelector('[data-injection-tool]')?.textContent).toBe('mcp__a__x')
    source.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await flush()
    expect(source.getAttribute('aria-expanded')).toBe('false')
    expect(node.querySelector('[data-injection-tool]')).toBeNull()
    head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // Any other key leaves the row alone…
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // …and Enter/Space swallow the default (a Space would otherwise scroll).
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    expect(head.dispatchEvent(space)).toBe(false)
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')
  })

  it('lists a source with no carried names without an omission line', async () => {
    // The packed-bundle artifact check renders exactly this shape.
    const node = await render({ servers: [{ name: 'fixture', toolCount: 2 }] })
    headOf(node).click()
    await flush()
    const source = node.querySelector('[data-injection-server-head]') as HTMLElement
    expect(source.textContent).toBe('fixture (2)')
    source.click()
    await flush()
    expect(node.querySelector('[data-injection-server-tools]')?.textContent).not.toContain('not listed')
  })

  it('reports the names the cap left out instead of dropping them', async () => {
    const carried = Array.from({ length: INJECTION_NAME_LIMIT }, (_, index) => `mcp__big__t${String(index)}`)
    const node = await render({ servers: [{ name: 'big', toolCount: INJECTION_NAME_LIMIT + 41, tools: carried }] })
    headOf(node).click()
    await flush()
    ;(node.querySelector('[data-injection-server-head]') as HTMLElement).click()
    await flush()
    const tools = node.querySelector('[data-injection-server-tools]')
    expect(tools?.querySelectorAll('[data-injection-tool]')).toHaveLength(INJECTION_NAME_LIMIT)
    expect(tools?.textContent).toContain(t('injection.omitted', { count: 41 }))
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

  it('anchors immediately BEFORE the system-prompt card of a first step', () => {
    // Real assembly order of one turn: turn/start (6), step/start (8), the
    // system/message prompt card (anchored on the turn start by the Chat
    // lane's own request-prompt definition), the user message (10), the
    // auto-injected context rows (11, 12) and the header (13) last. The notice
    // belongs above the card: it is a hint about the request, not a row of it.
    const state = stateOf(header(13, 'initial', zotero), undefined, stepLocation)
    expect(state.anchorSeq).toBe(5.9)
    expect(nodeOf(state)).toMatchObject({ anchorSeq: 5.9, visibility: 'visible' })
  })

  it('declares a session-level location so the chat lane cannot re-anchor the row', () => {
    // The Chat lane re-anchors any turn/step-located node that sits before the
    // turn's opening human input onto that input (rank 2, i.e. after the user
    // message and the collapsed process control) and folds process-window
    // members away in the compact view. A session location opts out of both, so
    // the row keeps the anchor computed above.
    const node = nodeOf(stateOf(header(13, 'initial', zotero), undefined, stepLocation))
    expect(node?.location).toEqual({ kind: 'session' })
  })

  it('anchors before the step card of a later step in the same turn', () => {
    // Steps after the first are opened by a card anchored on their OWN step
    // start, so the row mirrors that anchor instead of the turn start.
    const later = { kind: 'step', turn: { turn: 1, start: { seq: 6 } }, step: { step: 2, start: { seq: 20 } } }
    const state = stateOf(header(25, 'series', zotero), undefined, later, undefined, { turn: 1, step: 1 })
    expect(state.anchorSeq).toBe(19.9)
  })

  it('mirrors the official anchor for a header that repeats its predecessor step', () => {
    // The official requestPromptAnchor keeps the card on the header event when
    // the preceding request was the same turn/step, so a second changed set in
    // one step must not jump to the turn start.
    const state = stateOf(header(40, 'series', zotero), undefined, stepLocation, undefined, { turn: 1, step: 1 })
    expect(state.anchorSeq).toBe(39.9)
  })

  it('mirrors the official anchor for a series that started before the window', () => {
    // A resumed window has no predecessor Context and a non-initial reason: the
    // official rule anchors the card on the header itself, and the row follows.
    const later = { kind: 'step', turn: { turn: 1, start: { seq: 20 } }, step: { step: 2, start: { seq: 24 } } }
    expect(stateOf(header(200, 'resume', zotero), undefined, later).anchorSeq).toBe(199.9)
    expect(stateOf(header(200, 'change', zotero), undefined, later).anchorSeq).toBe(199.9)
    // …while an `initial` header of the same window still follows the card
    // (step 2 anchors on its own step start, 24).
    expect(stateOf(header(200, 'initial', zotero), undefined, later).anchorSeq).toBe(23.9)
  })

  it('keeps the anchor a materialized row already rendered with', () => {
    // The engine replays a prepended history page through start() again; without
    // stabilization a row first anchored at header - 0.1 could jump to
    // card - 0.1 once its predecessor page arrives.
    const state = stateOf(header(13, 'initial', zotero), undefined, stepLocation)
    expect(nodeOf(state)).toMatchObject({ anchorSeq: 5.9 })
    const materialized = new Map<string, unknown>([['chat', { key: 'k', anchorSeq: 3.9 }]])
    expect(definition.buildViewNode({ key: 'k', id: 'i', state, current: materialized })).toMatchObject({ anchorSeq: 3.9 })
  })

  it('anchors at the step start when the window reports no step number', () => {
    // An older window shape cannot tell a first step from a later one: the row
    // then uses the step start (the one degraded case, just after the card).
    const noStepNumber = { kind: 'step', turn: { turn: 1, start: { seq: 6 } }, step: { start: { seq: 8 } } }
    expect(stateOf(header(13, 'initial', zotero), undefined, noStepNumber).anchorSeq).toBe(7.9)
  })

  it('reads a PTC request: run_code in the header, the tools in the system prompt', () => {
    // Under a ptc agent preset the header carries only run_code and the
    // generated SDK section declares every registered tool in the prompt; the
    // row must still report the registered set.
    const prompt = 'interface ToolArgsMap {\n  mcp__zotero__fetch: unknown;\n  mcp__zotero__search: unknown;\n}'
    const state = stateOf(header(13, 'initial', ['run_code']), undefined, stepLocation, prompt)
    expect(state.servers).toEqual([
      { name: 'zotero', toolCount: 2, tools: ['mcp__zotero__fetch', 'mcp__zotero__search'] },
    ])
    expect(state.total).toBe(2)
    expect(nodeOf(state)).toMatchObject({ visibility: 'visible', data: { total: 2 } })
  })

  it('unions both sources without double counting', () => {
    const prompt = 'mcp__zotero__item mcp__zotero__search'
    const state = stateOf(header(13, 'initial', zotero), undefined, stepLocation, prompt)
    expect(state.servers).toEqual([{ name: 'zotero', toolCount: 2, tools: zotero }])
  })

  it('falls back to just before the header when the window resolves no step', () => {
    const state = stateOf(header(12, 'initial', zotero), undefined, { kind: 'unresolved' })
    expect(state.servers).toEqual([{ name: 'zotero', toolCount: 2, tools: zotero }])
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
      data: { servers: [{ name: 'zotero', toolCount: 2, tools: zotero }], total: 2 },
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
      data: {
        servers: [
          { name: 'email', toolCount: 1, tools: ['mcp__email__send'] },
          { name: 'zotero', toolCount: 2, tools: zotero },
        ],
        total: 3,
      },
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
    expect(state.servers).toEqual([{ name: 'my_server', toolCount: 1, tools: ['mcp__my_server__tool'] }])
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
    expect(state.servers).toEqual([{ name: 'my_server', toolCount: 1, tools: ['mcp__my_server__tool'] }])
  })
})
