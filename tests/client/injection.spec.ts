/**
 * Registered-tools notice parsing (browser half).
 *
 * The notice is derived from the harness's own session events, so these tests
 * pin the pure pieces the lane depends on: the two name sources (a request's
 * tool array and the rendered system prompt a PTC presentation declares the
 * same tools in), the header-to-set projection (servers, exact counts, and the
 * bounded name list the expanded body renders), and the defensive payload
 * reader.
 */

import { describe, expect, it } from 'vitest'
import type { ServerDef } from '../../src/shared/model.js'
import {
  INJECTION_NAME_LIMIT,
  MCP_INJECTION_NODE_KIND,
  injectionNamesOfHeader,
  injectionNamesOfPrompt,
  injectionOmittedOf,
  injectionServersOfNames,
  injectionServersOfRequest,
  injectionSignature,
  readInjectionPayload,
} from '../../src/client/injection.js'

/** One configured stdio server (only the identity matters here). */
const server = (serverName: string): ServerDef => ({ serverName, transport: 'stdio', command: 'run' })

/** One `request/header` payload carrying the given model-facing tool names. */
const headerData = (...names: string[]): unknown => ({
  header: { config: { provider: 'p', model: 'm' }, tools: names.map((name) => ({ name })) },
  reason: 'initial',
})

describe('request header → names', () => {
  it('keeps only MCP names, in tool order, without repeats', () => {
    expect(
      injectionNamesOfHeader(headerData('read_file', 'mcp__zotero__search', 'run_code', 'mcp__zotero__search')),
    ).toEqual(['mcp__zotero__search'])
  })

  it('never throws on a hostile or malformed header shape', () => {
    for (const data of [
      undefined,
      null,
      'x',
      42,
      {},
      { header: null },
      { header: 'nope' },
      { header: { tools: 'nope' } },
      { header: { tools: [null, 1, 'x', {}, { name: 42 }, { name: '' }] } },
    ]) {
      expect(injectionNamesOfHeader(data)).toEqual([])
    }
  })
})

describe('rendered system prompt → names', () => {
  it('extracts the declared public names from a generated SDK block', () => {
    // The shape a PTC presentation renders: the whole alphabet is legal —
    // server names and raw tool names may carry '-' and '_'.
    const prompt = [
      '## Writing code for run_code',
      '```ts',
      'interface ToolArgsMap {',
      '  /** Send a message. */',
      '  mcp__email__send: {',
      '    to: string;',
      '  };',
      '  mcp__my-server__do-thing: unknown;',
      '  mcp__my_server__tool_2: unknown;',
      '  mcp__zotero__fetch: unknown;',
      '}',
      '```',
    ].join('\n')
    expect(injectionNamesOfPrompt(prompt)).toEqual([
      'mcp__email__send',
      'mcp__my-server__do-thing',
      'mcp__my_server__tool_2',
      'mcp__zotero__fetch',
    ])
  })

  it('keeps lossy and hyphenated names intact, never splitting one', () => {
    // A lossy normalization appends `_<12-hex sha256>`; the declaration as a
    // whole is the name, and a `serverName` may itself carry '-' or '__'.
    const prompt = [
      '  mcp__srv__tool_ab12cd34ef56: unknown;',
      '  mcp__my-server__do-thing: unknown;',
      '  mcp__a__b__tool: unknown;',
    ].join('\n')
    expect(injectionNamesOfPrompt(prompt)).toEqual([
      'mcp__srv__tool_ab12cd34ef56',
      'mcp__my-server__do-thing',
      'mcp__a__b__tool',
    ])
  })

  it('ignores a name a tool description merely mentions', () => {
    // Every schema description is rendered into the same block as a JSDoc line,
    // so a mention there must not read as a registration.
    const prompt = [
      'interface ToolArgsMap {',
      '  /** Use mcp__speech__transcribe for audio. */',
      '  mcp__zotero__search: unknown;',
      '}',
    ].join('\n')
    expect(injectionNamesOfPrompt(prompt)).toEqual(['mcp__zotero__search'])
  })

  it('reads the Python SDK declarations as well', () => {
    // The python renderer declares bare identifiers as `async def <name>(…)`
    // and everything else as `# tools["<name>"](…)`.
    const prompt = [
      '    async def mcp__zotero__fetch(self, args: Foo) -> Bar: ...',
      '    # tools["mcp__sharelatex__write"](args: Foo) -> Bar',
    ].join('\n')
    expect(injectionNamesOfPrompt(prompt)).toEqual(['mcp__zotero__fetch', 'mcp__sharelatex__write'])
  })

  it('stays linear on a prompt that is nothing but prefixes, and bounds a name', () => {
    // The scanner is hand-rolled because a backtracking pattern was quadratic
    // over generated prompt text: 180 KB of bare prefixes took seconds on the UI
    // thread (every header evaluation and every history prepend runs this).
    const started = performance.now()
    expect(injectionNamesOfPrompt('mcp__a'.repeat(30_000))).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
    // A run longer than the contract's own 64-character budget is not a name.
    expect(injectionNamesOfPrompt('  mcp__a__' + 'b'.repeat(2000) + ': x')).toEqual([])
  })

  it('stays linear on ONE long line, where scanning back per candidate was quadratic', () => {
    // The declaration check used to walk back to the line start for every
    // candidate: a single line of generated prompt text (hundreds of KB) took
    // seconds. Both a declaring and a prose-shaped single line must be cheap.
    const declaring = '  mcp__a__b: x '.repeat(20_000)
    const prose = 'x mcp__a__b: y '.repeat(20_000)
    const started = performance.now()
    expect(injectionNamesOfPrompt(declaring)).toEqual(['mcp__a__b'])
    expect(injectionNamesOfPrompt(prose)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not read a tool description that names a CONFIGURED server', () => {
    // Every schema description renders into the same block as a JSDoc line. If
    // such a mention counted, a workspace that enables nothing would claim tools
    // it never registered — the exact state the default-off contract creates.
    const prompt = '  /** Equivalent to mcp__zotero__search: see the docs. */'
    expect(injectionNamesOfPrompt(prompt)).toEqual([])
    expect(injectionServersOfRequest({ header: headerData('run_code'), prompt }, [server('zotero')])).toEqual([])
  })

  it('reads the quoted member form and rejects a name that ends its line', () => {
    expect(injectionNamesOfPrompt('  "mcp__zotero__search": unknown;')).toEqual(['mcp__zotero__search'])
    expect(injectionNamesOfPrompt('  see mcp__zotero__search\n: unknown;')).toEqual([])
  })

  it('ignores non-MCP names, malformed names and unreadable input', () => {
    for (const text of [undefined, null, 42, '', 'read_file run_code', 'MCP__zotero__fetch', 'mcp__']) {
      expect(injectionNamesOfPrompt(text)).toEqual([])
    }
    // A name needs a server part, a non-empty tool part and an identifier
    // boundary — the shapes the `mcp__` contract emits and nothing else.
    for (const text of ['mcp__onlyone: x', '  mcp__foo__: unknown;', 'xmcp__zotero__search: unknown;', '_mcp__acme__t: unknown;']) {
      expect(injectionNamesOfPrompt(text)).toEqual([])
    }
  })
})

describe('names → registered set', () => {
  it('groups by owning server, sorted, and treats the input as a set', () => {
    const servers = injectionServersOfNames(
      ['mcp__zotero__search', 'mcp__zotero__item', 'mcp__email__send', 'mcp__zotero__search'],
      [server('zotero'), server('email')],
    )
    expect(servers).toEqual([
      { name: 'email', toolCount: 1, tools: ['mcp__email__send'] },
      { name: 'zotero', toolCount: 2, tools: ['mcp__zotero__item', 'mcp__zotero__search'] },
    ])
  })

  it('resolves the owning server by the longest configured prefix', () => {
    // A serverName may itself contain '__' (and '-'), so splitting the public
    // name at the first boundary would attribute the tool of "a__b" to "a".
    expect(injectionServersOfNames(['mcp__a__b__tool'], [server('a__b'), server('a')])).toEqual([
      { name: 'a__b', toolCount: 1, tools: ['mcp__a__b__tool'] },
    ])
    expect(injectionServersOfNames(['mcp__my-server__tool'], [server('my-server')])).toEqual([
      { name: 'my-server', toolCount: 1, tools: ['mcp__my-server__tool'] },
    ])
  })

  it('reports only names a CONFIGURED server owns', () => {
    // The tool-row lane falls back to the first `__` boundary so a historical
    // call still renders; this notice reports registrations, and a name with no
    // configured owner is prose or a stale header — reporting it would claim a
    // server that does not exist.
    expect(injectionServersOfNames(['mcp__a__b__tool'], [])).toEqual([])
    expect(injectionServersOfNames(['mcp__ghost__do_thing'], [server('zotero')])).toEqual([])
  })

  it('drops MCP-prefixed names that carry no server/tool boundary', () => {
    expect(injectionServersOfNames(['mcp__', 'mcp__onlyone'], [])).toEqual([])
  })

  it('caps the carried names per server while the count stays exact', () => {
    const names = Array.from({ length: INJECTION_NAME_LIMIT + 7 }, (_, index) => `mcp__a__t${String(index)}`)
    const [carried] = injectionServersOfNames(names, [server('a')])
    expect(carried?.toolCount).toBe(INJECTION_NAME_LIMIT + 7)
    expect(carried?.tools).toHaveLength(INJECTION_NAME_LIMIT)
    expect(injectionOmittedOf(carried!)).toBe(7)
  })
})

describe('one request → registered set (dual source)', () => {
  it('unions the header tools with the prompt declarations without double counting', () => {
    // A "both" presentation exposes the schemas twice; every other request has
    // them in exactly one of the two shapes.
    const servers = injectionServersOfRequest(
      {
        header: headerData('run_code', 'mcp__zotero__search', 'mcp__email__send'),
        prompt: [
          '  mcp__zotero__search: unknown;',
          '  mcp__zotero__fetch: unknown;',
          '  mcp__sharelatex__write: unknown;',
        ].join('\n'),
      },
      [server('zotero'), server('email'), server('sharelatex')],
    )
    expect(servers).toEqual([
      { name: 'email', toolCount: 1, tools: ['mcp__email__send'] },
      { name: 'sharelatex', toolCount: 1, tools: ['mcp__sharelatex__write'] },
      { name: 'zotero', toolCount: 2, tools: ['mcp__zotero__fetch', 'mcp__zotero__search'] },
    ])
  })

  it('reads a PTC request: header carries only run_code, the prompt declares the tools', () => {
    const servers = injectionServersOfRequest(
      { header: headerData('run_code'), prompt: '  mcp__zotero__fetch: unknown;' },
      [server('zotero')],
    )
    expect(servers).toEqual([{ name: 'zotero', toolCount: 1, tools: ['mcp__zotero__fetch'] }])
  })

  it('reads a native request: the prompt declares nothing', () => {
    const servers = injectionServersOfRequest({ header: headerData('mcp__zotero__fetch'), prompt: '' }, [server('zotero')])
    expect(servers).toEqual([{ name: 'zotero', toolCount: 1, tools: ['mcp__zotero__fetch'] }])
  })

  it('never reports a server that is not configured', () => {
    // Real prompts render every tool DESCRIPTION into the SDK block, so a
    // mention may sit in a declaration-shaped position (followed by "(") while
    // naming a server this deployment does not run.
    const servers = injectionServersOfRequest(
      {
        header: headerData('run_code'),
        prompt: 'Use mcp__speech__transcribe(args) for audio.\n  mcp__zotero__search: unknown;',
      },
      [server('zotero')],
    )
    expect(servers).toEqual([{ name: 'zotero', toolCount: 1, tools: ['mcp__zotero__search'] }])
  })

  it('reads a request that exposed nothing', () => {
    expect(injectionServersOfRequest({ header: headerData('run_code'), prompt: 'no tools here' }, [server('zotero')])).toEqual([])
  })
})

describe('injection payload reader', () => {
  it('reads the payload the row node carries', () => {
    const payload = readInjectionPayload({
      servers: [
        { name: 'zotero', toolCount: 43, tools: ['mcp__zotero__search'] },
        { name: 'email', toolCount: 18 },
      ],
    })
    // An absent tools list normalizes to empty: the collapsed line still has
    // its exact count and the body simply lists no names.
    expect(payload?.servers).toEqual([
      { name: 'zotero', toolCount: 43, tools: ['mcp__zotero__search'] },
      { name: 'email', toolCount: 18, tools: [] },
    ])
  })

  it('never throws on a malformed payload (the lane renders nothing instead)', () => {
    for (const data of [undefined, null, 'x', 42, {}, { servers: 'nope' }, { servers: [] }, { servers: [null, 1, {}, { name: '' }] }]) {
      expect(readInjectionPayload(data)).toBeUndefined()
    }
  })

  it('normalizes a missing or hostile tool count to zero', () => {
    const payload = readInjectionPayload({ servers: [{ name: 'a', toolCount: -1 }, { name: 'b', toolCount: Number.NaN }, { name: 'c' }] })
    expect(payload?.servers).toEqual([
      { name: 'a', toolCount: 0, tools: [] },
      { name: 'b', toolCount: 0, tools: [] },
      { name: 'c', toolCount: 0, tools: [] },
    ])
  })

  it('keeps only real names from a hostile tools list', () => {
    const payload = readInjectionPayload({
      servers: [{ name: 'a', toolCount: 2, tools: ['mcp__a__x', null, 7, '', 'mcp__a__y'] }],
    })
    expect(payload?.servers[0]?.tools).toEqual(['mcp__a__x', 'mcp__a__y'])
  })
})

describe('expanded-body omission', () => {
  it('reports only what the cap left out', () => {
    // A capped list names the remainder…
    expect(
      injectionOmittedOf({
        name: 'a',
        toolCount: INJECTION_NAME_LIMIT + 7,
        tools: Array.from({ length: INJECTION_NAME_LIMIT }, (_, index) => 'mcp__a__t' + String(index)),
      }),
    ).toBe(7)
    // …a list that fits omits nothing…
    expect(injectionOmittedOf({ name: 'a', toolCount: 2, tools: ['mcp__a__x', 'mcp__a__y'] })).toBe(0)
    // …and a payload that carries no names at all claims nothing.
    expect(injectionOmittedOf({ name: 'a', toolCount: 43, tools: [] })).toBe(0)
  })
})

describe('notice identity', () => {
  it('keeps the node kind stable and keys the signature on the whole set', () => {
    expect(MCP_INJECTION_NODE_KIND).toBe('mcp-scope-injected')
    expect(
      injectionSignature([
        { name: 'a', toolCount: 1, tools: ['mcp__a__x'] },
        { name: 'b', toolCount: 2, tools: ['mcp__b__x', 'mcp__b__y'] },
      ]),
    ).toBe('a:1:mcp__a__x,b:2:mcp__b__x\u0000mcp__b__y')
    expect(injectionSignature([])).toBe('')
  })

  it('treats a same-count tool swap as a real change', () => {
    // The collapsed line looks identical, but the expanded body would not: the
    // names are part of the change key.
    expect(injectionSignature([{ name: 'a', toolCount: 1, tools: ['mcp__a__x'] }])).not.toBe(
      injectionSignature([{ name: 'a', toolCount: 1, tools: ['mcp__a__y'] }]),
    )
  })
})
