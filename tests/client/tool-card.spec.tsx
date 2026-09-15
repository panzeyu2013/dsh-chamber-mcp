// @vitest-environment jsdom
// MCP tool-row evidence: identity derivation from the model-facing request
// header, per-state rendering (running vs settled vs failed vs interrupted),
// the expand/collapse interaction, and the accessibility surface. Every string
// asserted here comes from the en dictionary, so a hard-coded literal in the
// row fails the suite.
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { SectionT } from '../../src/client/section.tsx'
import { styles } from '../../src/client/styles.ts'
import type { ServerDef } from '../../src/shared/model.ts'
import {
  argsRawOf,
  identifyMcpTool,
  mcpToolNamesOf,
  resultTextOf,
  rowStateOf,
  summarizeArgs,
  type McpToolBlockLike,
} from '../../src/client/tool-card/names.ts'
import { McpToolRow } from '../../src/client/tool-card/row.tsx'
import { mcpToolView } from '../../src/client/tool-card/view.tsx'

const t = ((key: SettingsKey, params?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))) as unknown as SectionT

const STDIO: ServerDef = { serverName: 'fixture', transport: 'stdio', command: 'node', args: ['srv.mjs'] }
const HTTP: ServerDef = { serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.com/x' }

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

interface Mounted {
  host: HTMLElement
  unmount(): void
}

const tracked: Mounted[] = []
afterEach(() => {
  for (const mounted of tracked.splice(0)) mounted.unmount()
})

function mountRow(identity: ReturnType<typeof identifyMcpTool>, block: McpToolBlockLike): Mounted {
  if (identity === undefined) throw new Error('test identity must resolve')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(<McpToolRow identity={identity} t={t} block={block} />)
  const mounted: Mounted = {
    host,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
  tracked.push(mounted)
  return mounted
}

/** The leading slot's state mark, when the row renders one. */
function dotOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.${styles.toolDot}`)
}

/** The visually hidden run-state word, when the row renders one. */
function hiddenStatusOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.${styles.toolVisuallyHidden}`)
}

/** The plug glyph (the leading mark of a non-terminal row). */
function plugOf(host: HTMLElement): SVGPathElement | null {
  return host.querySelector<SVGPathElement>('svg path[d^="M18 8v5"]')
}

/** The row's head line (the clickable line of the transcript row). */
function headOf(host: HTMLElement): HTMLElement {
  const head = host.querySelector<HTMLElement>(`.${styles.toolHead}`)
  if (head === null) throw new Error('row head missing')
  return head
}

describe('MCP tool identity', () => {
  it('derives server, tool and transport from a configured public name', () => {
    const identity = identifyMcpTool('mcp__github__search_issues', [STDIO, HTTP])
    expect(identity).toMatchObject({
      publicName: 'mcp__github__search_issues',
      serverName: 'github',
      toolName: 'search_issues',
      transport: 'streamable-http',
      normalized: false,
    })
  })

  it('binds the LONGEST configured server name (serverName may itself contain _)', () => {
    const short: ServerDef = { serverName: 'a', transport: 'stdio', command: 'node' }
    const long: ServerDef = { serverName: 'a_b', transport: 'stdio', command: 'node' }
    expect(identifyMcpTool('mcp__a_b__tool', [short, long])?.serverName).toBe('a_b')
    expect(identifyMcpTool('mcp__a_b__tool', [long, short])?.serverName).toBe('a_b')
    // …and still resolves the short one when the long one is not a prefix.
    expect(identifyMcpTool('mcp__a__tool', [short, long])?.serverName).toBe('a')
  })

  it('marks a truncated/hashed public name as normalized', () => {
    const raw = 'x'.repeat(41)
    const publicName = `mcp__srv__${raw}_0123456789ab`
    expect(publicName.length).toBe(64)
    const identity = identifyMcpTool(publicName, [{ serverName: 'srv', transport: 'stdio', command: 'node' }])
    expect(identity?.normalized).toBe(true)
    expect(identifyMcpTool('mcp__srv__short', [{ serverName: 'srv', transport: 'stdio', command: 'node' }])?.normalized).toBe(false)
  })

  it('still renders a tool whose server left the document, without a transport badge', () => {
    const identity = identifyMcpTool('mcp__gone__tool', [HTTP])
    expect(identity).toMatchObject({ serverName: 'gone', toolName: 'tool', transport: undefined })
  })

  it('ignores names outside the MCP contract', () => {
    expect(identifyMcpTool('bash', [HTTP])).toBeUndefined()
    expect(identifyMcpTool('mcp__noseparator', [HTTP])).toBeUndefined()
    expect(identifyMcpTool('mcp__gone__', [HTTP])?.toolName).toBe('')
  })
})

describe('session event window collection', () => {
  it('collects distinct MCP names from the request headers', () => {
    const entries = [
      { type: 'event', event: { type: 'user/message', data: {} } },
      { type: 'transient', event: { type: 'assistant/live-chunk', data: {} } },
      {
        type: 'event',
        event: {
          type: 'request/header',
          data: { header: { tools: [{ name: 'mcp__github__search' }, { name: 'bash' }] } },
        },
      },
      {
        type: 'event',
        event: { type: 'request/header', data: { header: { tools: [{ name: 'mcp__github__search' }, { name: 'mcp__fixture__greet' }] } } },
      },
    ]
    expect(mcpToolNamesOf(entries)).toEqual(['mcp__github__search', 'mcp__fixture__greet'])
  })

  it('is empty (never throwing) for a window without a header', () => {
    expect(mcpToolNamesOf([])).toEqual([])
    expect(mcpToolNamesOf([{ type: 'event', event: { type: 'request/header', data: null } }])).toEqual([])
    expect(mcpToolNamesOf([{ type: 'event', event: { type: 'request/header', data: { header: {} } } }])).toEqual([])
  })

  it('collects the name of a call whose describing header left the paged window', () => {
    // The window is a bounded tail page (≈50 messages) while `request/header`
    // is appended at loop boundaries/on change, not per turn — so a rendered
    // call can outlive its header. The call event itself still names it.
    const entries = [
      { type: 'event', event: { type: 'assistant/message', data: {} } },
      { type: 'event', event: { type: 'tool/call', data: { turn: 3, step: 1, callId: 'c9', name: 'mcp__fixture__echo', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', data: { turn: 3, step: 1, message: { callId: 'c9', content: [], isError: false } } } },
    ]
    expect(mcpToolNamesOf(entries)).toEqual(['mcp__fixture__echo'])
  })

  it('collects MCP names dispatched from inside a programmatic call', () => {
    // Under a `ptc` agent preset the model-facing call is `run_code` and the
    // header lists only that tool: an MCP tool is visible ONLY in the dispatch
    // events, so without them the transcript renders every MCP call generic.
    const entries = [
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'run_code', arguments: '{}' } } },
      {
        type: 'event',
        event: {
          type: 'tool/ptc-dispatch-start',
          data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'mcp__zotero__fetch', arguments: '{}' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/ptc-dispatch',
          data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'mcp__zotero__fetch', content: [], isError: false },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/ptc-dispatch-start',
          data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:2', name: 'bash', arguments: '{}' },
        },
      },
    ]
    expect(mcpToolNamesOf(entries)).toEqual(['mcp__zotero__fetch'])
  })

  it('deduplicates a name offered by a header and called later', () => {
    const entries = [
      { type: 'event', event: { type: 'request/header', data: { header: { tools: [{ name: 'mcp__fixture__echo' }] } } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'mcp__fixture__echo' } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c2', name: 'bash' } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c3' } } },
    ]
    expect(mcpToolNamesOf(entries)).toEqual(['mcp__fixture__echo'])
  })
})

describe('call reading', () => {
  const running: McpToolBlockLike = { callId: 'c1', argsRaw: '{"repo":"dsh","state":"open"}' }
  const settled: McpToolBlockLike = {
    kind: 'tool-result',
    callId: 'c1',
    call: { argsRaw: '{"repo":"dsh"}' },
    content: [
      { type: 'text', text: 'first line\nsecond line' },
      { type: 'image', mimeType: 'image/png' },
    ],
    isError: false,
    time: 1_700_000_001_200,
    callTime: 1_700_000_000_000,
  }

  it('reads arguments from either form', () => {
    expect(argsRawOf(running)).toBe('{"repo":"dsh","state":"open"}')
    expect(argsRawOf(settled)).toBe('{"repo":"dsh"}')
    expect(argsRawOf({ kind: 'tool-result', call: null })).toBe('')
  })

  it('classifies the four states like the shipped rows', () => {
    expect(rowStateOf(running)).toBe('running')
    expect(rowStateOf(settled)).toBe('ok')
    expect(rowStateOf({ ...settled, isError: true })).toBe('error')
    expect(rowStateOf({ ...settled, error: { code: 'interrupted', name: 'x' } })).toBe('stopped')
  })

  it('summarizes the first string argument and flattens the result', () => {
    expect(summarizeArgs('{"repo":"dsh","other":1}')).toBe('dsh')
    expect(summarizeArgs('{"count":3}')).toBe('{"count":3}')
    expect(summarizeArgs('not json')).toBe('not json')
    expect(summarizeArgs('')).toBe('')
    expect(resultTextOf(settled)).toContain('first line')
    expect(resultTextOf(settled)).toContain('"type":"image"')
    expect(resultTextOf({ kind: 'tool-result' })).toBe('')
  })
})

describe('MCP tool row rendering', () => {
  const identity = identifyMcpTool('mcp__fixture__greet', [STDIO])

  it('renders the settled row: title, transport tag, duration, no busy state', async () => {
    const mounted = mountRow(identity, {
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: '{"name":"world"}' },
      content: [{ type: 'text', text: 'hello world' }],
      isError: false,
      time: 1_700_000_001_200,
      callTime: 1_700_000_000_000,
    })
    await flush()
    const head = headOf(mounted.host)
    expect(mounted.host.textContent).toContain('fixture · greet')
    expect(mounted.host.textContent).toContain(en['transport.stdio'])
    expect(mounted.host.textContent).toContain('1.2s')
    expect(mounted.host.textContent).toContain('world')
    expect(head.getAttribute('data-state')).toBe('ok')
    expect(head.hasAttribute('aria-busy')).toBe(false)
    // The wire name rides the row root, as it does on the shipped rows.
    expect(mounted.host.querySelector(`.${styles.toolCard}`)?.getAttribute('data-tool')).toBe(
      'mcp__fixture__greet',
    )
    // Non-terminal rows keep the tool glyph and render no state mark.
    expect(plugOf(mounted.host)).not.toBeNull()
    expect(dotOf(mounted.host)).toBeNull()
    // Settled-ok rows carry no state word (the shipped `stateStatus` rule): the
    // row's own text is the accessible name.
    expect(hiddenStatusOf(mounted.host)).toBeNull()
  })

  it('renders the running row differently: busy, primary state, no duration', async () => {
    const mounted = mountRow(identity, { callId: 'c1', argsRaw: '{"name":"world"}' })
    await flush()
    const head = headOf(mounted.host)
    expect(head.getAttribute('data-state')).toBe('running')
    expect(head.getAttribute('aria-busy')).toBe('true')
    // The duration only exists once the call settled.
    expect(mounted.host.querySelector(`.${styles.toolDuration}`)).toBeNull()
    expect(dotOf(mounted.host)).toBeNull()
    expect(hiddenStatusOf(mounted.host)?.textContent).toBe(en['tool.running'])
  })

  it('offers the hover chevron only when the row can expand', async () => {
    const expandable = mountRow(identity, { callId: 'c1', argsRaw: '{"name":"world"}' })
    await flush()
    expect(expandable.host.querySelector(`.${styles.toolGlyphHover}`)).not.toBeNull()
    expect(expandable.host.querySelector(`.${styles.toolGlyphIdle}`)).not.toBeNull()

    const plain = mountRow(identity, { callId: 'c2', argsRaw: '' })
    await flush()
    expect(plain.host.querySelector(`.${styles.toolGlyphHover}`)).toBeNull()
    expect(plain.host.querySelector(`.${styles.toolGlyphIdle}`)).not.toBeNull()
  })

  it('marks a normalized (hashed) name in the expanded body', async () => {
    // 64 chars in total: `mcp__fixture__` (14) + 37 + `_` + 12 hex.
    const hashed = identifyMcpTool(`mcp__fixture__${'x'.repeat(37)}_0123456789ab`, [STDIO])
    expect(hashed?.normalized).toBe(true)
    const mounted = mountRow(hashed, { callId: 'c3', argsRaw: '{"name":"world"}' })
    await flush()
    headOf(mounted.host).click()
    await flush()
    expect(mounted.host.textContent).toContain(en['tool.normalized'])
  })

  it('expands to the raw arguments and the rendered result, and collapses again', async () => {
    const mounted = mountRow(identity, {
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: '{"name":"world"}' },
      content: [{ type: 'text', text: 'hello world' }],
      isError: false,
    })
    await flush()
    const head = headOf(mounted.host)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(mounted.host.querySelector('pre')).toBeNull()

    head.click()
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    // Open: the glyph yields to the chevron (the shipped disclosure behaviour).
    expect(head.hasAttribute('data-open')).toBe(true)
    expect(plugOf(mounted.host)).toBeNull()
    const codes = Array.from(mounted.host.querySelectorAll('pre')).map((node) => node.textContent)
    expect(codes).toEqual(['{"name":"world"}', 'hello world'])
    expect(mounted.host.textContent).toContain(en['tool.input'])
    expect(mounted.host.textContent).toContain(en['tool.output'])

    head.click()
    await flush()
    expect(mounted.host.querySelector('pre')).toBeNull()
  })

  it('expands from the keyboard and stays closed when there is nothing to show', async () => {
    const expandable = mountRow(identity, { callId: 'c1', argsRaw: '{"name":"world"}' })
    await flush()
    const head = headOf(expandable.host)
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(head.getAttribute('aria-expanded')).toBe('true')

    const empty = mountRow(identity, { callId: 'c2', argsRaw: '' })
    await flush()
    const emptyHead = headOf(empty.host)
    // Nothing to show: the line is not a control at all.
    expect(emptyHead.getAttribute('role')).toBeNull()
    expect(emptyHead.hasAttribute('tabindex')).toBe(false)
    expect(emptyHead.hasAttribute('aria-expanded')).toBe(false)
    emptyHead.click()
    await flush()
    expect(empty.host.querySelector('pre')).toBeNull()
  })

  it('surfaces a failure on the summary line and marks the output', async () => {
    const mounted = mountRow(identity, {
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: '{"name":"world"}' },
      content: [{ type: 'text', text: 'boom: server refused\nstack' }],
      isError: true,
    })
    await flush()
    const head = headOf(mounted.host)
    expect(head.getAttribute('data-state')).toBe('error')
    // Terminal state: the leading slot yields to the state mark (error dot),
    // exactly as the shipped tool rows do — the title itself is untinted.
    expect(dotOf(mounted.host)?.getAttribute('data-state')).toBe('error')
    expect(plugOf(mounted.host)).toBeNull()
    expect(mounted.host.textContent).toContain('boom: server refused')
    expect(hiddenStatusOf(mounted.host)?.textContent).toBe(en['tool.failed'])
    head.click()
    await flush()
    expect(mounted.host.querySelector('pre[data-error]')).not.toBeNull()
  })

  it('marks an interrupted call as stopped', async () => {
    const mounted = mountRow(identity, {
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: '{"name":"world"}' },
      content: [],
      isError: false,
      error: { code: 'interrupted', name: 'Interrupted' },
    })
    await flush()
    const head = headOf(mounted.host)
    expect(head.getAttribute('data-state')).toBe('stopped')
    expect(dotOf(mounted.host)?.getAttribute('data-state')).toBe('warning')
    expect(plugOf(mounted.host)).toBeNull()
    expect(hiddenStatusOf(mounted.host)?.textContent).toBe(en['tool.stopped'])
    head.click()
    await flush()
    expect(mounted.host.textContent).toContain(en['tool.noOutput'])
  })
})

describe('registrable view factory', () => {
  it('binds the captured identity to the seat-supplied call node', async () => {
    const bound = identifyMcpTool('mcp__github__search', [HTTP])
    const View = mcpToolView(bound!)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(<View t={t} block={{ callId: 'c1', argsRaw: '{"q":"x"}' }} />)
    await flush()
    expect(host.textContent).toContain('github · search')
    root.unmount()
    host.remove()
  })
})
