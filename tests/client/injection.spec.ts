/**
 * Injection-notice parsing (browser half).
 *
 * The notice is derived from the harness's own `request/header` events, so
 * these tests pin the two pure pieces the lane depends on: the header-to-set
 * projection and the defensive node-payload reader.
 */

import { describe, expect, it } from 'vitest'
import type { ServerDef } from '../../src/shared/model.js'
import {
  MCP_INJECTION_NODE_KIND,
  injectionServersOfHeader,
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

describe('request header → injected set', () => {
  it('keeps only MCP tools and groups them by owning server, sorted by name', () => {
    const servers = injectionServersOfHeader(
      headerData('read_file', 'run_code', 'mcp__zotero__search', 'mcp__zotero__item', 'mcp__email__send'),
      [server('zotero'), server('email')],
    )
    expect(servers).toEqual([
      { name: 'email', toolCount: 1 },
      { name: 'zotero', toolCount: 2 },
    ])
  })

  it('resolves the owning server by the longest configured prefix', () => {
    // A serverName may itself contain '__', so splitting the public name at the
    // first boundary would attribute the tool of "a__b" to the server "a".
    const servers = injectionServersOfHeader(headerData('mcp__a__b__tool'), [server('a__b'), server('a')])
    expect(servers).toEqual([{ name: 'a__b', toolCount: 1 }])
  })

  it('falls back to the first boundary when the server is not configured (best effort)', () => {
    expect(injectionServersOfHeader(headerData('mcp__a__b__tool'), [])).toEqual([{ name: 'a', toolCount: 1 }])
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
      expect(injectionServersOfHeader(data, [server('zotero')])).toEqual([])
    }
  })

  it('drops MCP-prefixed names that carry no server/tool boundary', () => {
    expect(injectionServersOfHeader(headerData('mcp__', 'mcp__onlyone'), [])).toEqual([])
  })

  it('counts repeated names instead of collapsing them', () => {
    expect(injectionServersOfHeader(headerData('mcp__a__x', 'mcp__a__x'), [])).toEqual([{ name: 'a', toolCount: 2 }])
  })
})

describe('injection payload reader', () => {
  it('reads the payload the row node carries', () => {
    const payload = readInjectionPayload({ servers: [{ name: 'zotero', toolCount: 43 }, { name: 'email', toolCount: 18 }] })
    expect(payload?.servers).toEqual([{ name: 'zotero', toolCount: 43 }, { name: 'email', toolCount: 18 }])
    expect(payload?.total).toBe(61)
  })

  it('never throws on a malformed payload (the lane renders nothing instead)', () => {
    for (const data of [undefined, null, 'x', 42, {}, { servers: 'nope' }, { servers: [] }, { servers: [null, 1, {}, { name: '' }] }]) {
      expect(readInjectionPayload(data)).toBeUndefined()
    }
  })

  it('normalizes a missing or hostile tool count to zero', () => {
    const payload = readInjectionPayload({ servers: [{ name: 'a', toolCount: -1 }, { name: 'b', toolCount: Number.NaN }, { name: 'c' }] })
    expect(payload?.servers).toEqual([{ name: 'a', toolCount: 0 }, { name: 'b', toolCount: 0 }, { name: 'c', toolCount: 0 }])
    expect(payload?.total).toBe(0)
  })
})

describe('notice identity', () => {
  it('keeps the node kind stable and exposes the change signature', () => {
    expect(MCP_INJECTION_NODE_KIND).toBe('mcp-scope-injected')
    expect(injectionSignature([{ name: 'a', toolCount: 1 }, { name: 'b', toolCount: 2 }])).toBe('a:1,b:2')
    expect(injectionSignature([])).toBe('')
  })
})
