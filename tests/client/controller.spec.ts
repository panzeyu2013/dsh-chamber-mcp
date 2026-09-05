import { describe, expect, it } from 'vitest'
import {
  buildSaveOps,
  classifySaveError,
  credentialRefsOfDoc,
  decodeDoc,
  normalizeDoc,
  toggleOp,
} from '../../src/client/controller.js'
import { isEnabled, removeServerOverrides, type McpScopeDoc, type ServerDef } from '../../src/shared/model.js'

const stdioServer = (serverName: string, envKeys: string[] = []): ServerDef => ({
  serverName,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@some/mcp'],
  envKeys,
})

const httpServer = (serverName: string, headers: { name: string; ref: string }[] = []): ServerDef => ({
  serverName,
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8080/mcp',
  headers,
})

const doc = (servers: ServerDef[], overrides: McpScopeDoc['overrides'] = {}): McpScopeDoc => ({
  servers,
  overrides,
})

describe('decodeDoc (malformed-snapshot hardening)', () => {
  it('defaults null / non-objects to the empty document', () => {
    expect(decodeDoc(undefined)).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc(null)).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc('nope')).toEqual({ servers: [], overrides: {} })
  })

  it('guards missing arrays', () => {
    expect(decodeDoc({})).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc({ servers: 'x', overrides: undefined })).toEqual({ servers: [], overrides: {} })
  })

  it('prunes empty override rows and non-true entries', () => {
    const raw = {
      servers: [],
      overrides: {
        wsA: { s1: true },
        wsB: {}, // empty → dropped
        wsC: { s1: false, s2: 'x' }, // only literal true counts → row dropped
      },
    }
    const decoded = decodeDoc(raw)
    expect(decoded.overrides).toEqual({ wsA: { s1: true } })
  })

  it('drops non-object servers but keeps valid ones', () => {
    const decoded = decodeDoc({ servers: [stdioServer('ok'), null, 'junk'] })
    expect(decoded.servers.map((s) => s.serverName)).toEqual(['ok'])
  })
})

describe('buildSaveOps', () => {
  it('returns an empty plan for identical documents', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    const plan = buildSaveOps(d, d)
    expect(plan.ops).toEqual([])
    expect(plan.unsetRefs).toEqual([])
  })

  it('adds a server with one whole-array servers op and no orphaned refs', () => {
    const prev = doc([])
    const next = doc([stdioServer('git')])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual([])
  })

  it('edits env keys: appending a key only rewrites servers', () => {
    const prev = doc([stdioServer('a', ['A'])])
    const next = doc([stdioServer('a', ['A', 'B'])])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual([])
  })

  it('edits env keys: removing a key orphans the removed credential ref', () => {
    const prev = doc([stdioServer('a', ['A', 'B'])])
    const next = doc([stdioServer('a', ['B'])])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual(['A'])
  })

  it('remove-server cascade: unsets refs no remaining server references', () => {
    const shared = 'SHARED_TOKEN'
    const prev = doc([stdioServer('one', [shared, 'ONE_ONLY']), httpServer('two', [{ name: 'X-Token', ref: shared }])])
    const next = doc([prev.servers[0]!]) // server "two" removed
    const plan = buildSaveOps(prev, next)
    // 'two' referenced only the shared ref, which 'one' still uses → nothing orphaned.
    expect(plan.unsetRefs).toEqual([])
    // now remove 'one' too from the same starting doc: ONE_ONLY is orphaned,
    // while SHARED_TOKEN stays referenced by 'two'.
    const onlyTwo = doc([httpServer('two', [{ name: 'X-Token', ref: shared }])])
    const plan2 = buildSaveOps(prev, onlyTwo)
    expect(plan2.unsetRefs).toEqual(['ONE_ONLY'])
  })

  it('remove-server cascade: prunes per-workspace override rows of the removed server', () => {
    const prev = doc([stdioServer('a'), stdioServer('b')], {
      ws1: { a: true },
      ws2: { a: true, b: true },
      ws3: { b: true }, // only b off → untouched by removing a
    })
    const next = doc(prev.servers.filter((s) => s.serverName !== 'a'), removeServerOverrides(prev.overrides, 'a'))
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([
      { op: 'set', path: ['servers'], value: next.servers },
      { op: 'unset', path: ['overrides', 'ws1', 'a'] },
      { op: 'unset', path: ['overrides', 'ws1'] }, // row emptied by the removal
      { op: 'unset', path: ['overrides', 'ws2', 'a'] }, // ws2 keeps b off
    ])
  })

  it('keep-overrides rows untouched when the doc does not change them', () => {
    const prev = doc([stdioServer('a')], { ws1: { a: true } })
    const next = doc([stdioServer('a', ['NEW_ENV'])], { ws1: { a: true } })
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
  })
})

describe('toggleOp', () => {
  it('returns no ops when the requested state already holds', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    expect(toggleOp(d, 'ws1', 'a', true)).toEqual([]) // already off
    expect(toggleOp(d, 'ws2', 'a', false)).toEqual([]) // default on
  })

  it('turning off sets one presence op', () => {
    const d = doc([stdioServer('a')])
    expect(toggleOp(d, 'ws1', 'a', true)).toEqual([
      { op: 'set', path: ['overrides', 'ws1', 'a'], value: true },
    ])
  })

  it('turning on unsets the record and prunes the emptied row', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    expect(toggleOp(d, 'ws1', 'a', false)).toEqual([
      { op: 'unset', path: ['overrides', 'ws1', 'a'] },
      { op: 'unset', path: ['overrides', 'ws1'] },
    ])
  })

  it('turning on keeps the row when other servers stay off in it', () => {
    const d = doc([stdioServer('a'), stdioServer('b')], { ws1: { a: true, b: true } })
    expect(toggleOp(d, 'ws1', 'a', false)).toEqual([{ op: 'unset', path: ['overrides', 'ws1', 'a'] }])
  })
})

describe('shared semantics alignment', () => {
  it('credentialRefsOfDoc collects env keys and header refs across servers', () => {
    const d = doc([
      stdioServer('a', ['A', 'B']),
      httpServer('b', [{ name: 'X', ref: 'A' }, { name: 'Y', ref: 'C' }]),
    ])
    expect(credentialRefsOfDoc(d)).toEqual(['A', 'B', 'C'])
  })

  it('normalizeDoc keeps semantics of isEnabled', () => {
    const d = normalizeDoc(doc([stdioServer('a')], { ws1: { a: true }, ws2: {} }))
    expect(isEnabled(d.overrides, 'ws1', 'a')).toBe(false)
    expect(isEnabled(d.overrides, 'ws2', 'a')).toBe(true)
    expect(d.overrides).toEqual({ ws1: { a: true } })
  })
})

describe('classifySaveError', () => {
  it('maps revision/conflict wording to conflict', () => {
    expect(classifySaveError(new Error('settings conflict: expected revision 3, got 5'))).toBe('conflict')
    expect(classifySaveError({ message: 'stale revision' })).toBe('conflict')
    expect(classifySaveError(new Error('boom'))).toBe('save-failed')
    expect(classifySaveError('network down')).toBe('save-failed')
  })
})
