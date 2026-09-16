/**
 * Delegation-narrowing tests (src/delegation.ts): folding the durable
 * `subagent/descriptor` a delegating agent left in a child's own log, and the
 * admission math that mirrors the harness's own `admits()` when a scope's masks
 * decide whether an INHERITED global name is visible.
 *
 * Pure and total by contract: every malformed shape yields `unreadable` (the
 * caller logs it and proceeds unnarrowed), never a throw — a bookkeeping read
 * must not be able to fail a child's creation.
 */

import { describe, expect, it } from 'vitest'
import { admissionOf, readDelegationNarrowing } from '../src/delegation.js'

/** One descriptor event, shaped like the harness's own durable record. */
const descriptor = (data: unknown): unknown => ({ type: 'subagent/descriptor', seq: 0, time: 0, data })

const continuable = (toolFilter?: unknown): unknown =>
  descriptor({ version: 3, mode: 'continuable', provider: 'in-process', label: 'child', ...(toolFilter === undefined ? {} : { toolFilter }) })

describe('readDelegationNarrowing', () => {
  it('reports absent when the child log carries no descriptor (normal for one-shot at adopt time)', () => {
    expect(readDelegationNarrowing([])).toEqual({ kind: 'absent' })
    expect(readDelegationNarrowing([{ type: 'request/header', data: {} }])).toEqual({ kind: 'absent' })
    // A snapshot that is not a list is not a log: reported, not guessed.
    const garbage = readDelegationNarrowing(undefined as unknown as readonly unknown[])
    expect(garbage.kind).toBe('unreadable')
  })

  it('reports none for a descriptor that declares no narrowing', () => {
    expect(readDelegationNarrowing([descriptor({ version: 3, mode: 'one-shot', provider: 'in-process' })])).toEqual({
      kind: 'none',
    })
    expect(readDelegationNarrowing([continuable()])).toEqual({ kind: 'none' })
  })

  it('honours a filter only on a continuable descriptor (the upstream contract)', () => {
    // Upstream persists `toolFilter` for continuable children only: a filter on a
    // one-shot descriptor is not this module's to mirror, and a descriptor whose
    // mode is missing or unknown is one it cannot read at all (upstream rejects
    // that payload) — fail open WITH a warning, never apply it.
    // A one-shot descriptor carrying a filter is a payload upstream never writes
    // (its schema has no such key), so it is reported rather than treated as
    // "nothing to mirror".
    expect(
      readDelegationNarrowing([
        descriptor({ version: 3, mode: 'one-shot', provider: 'in-process', toolFilter: { allow: ['fs_read'] } }),
      ]).kind,
    ).toBe('unreadable')
    expect(
      readDelegationNarrowing([
        descriptor({ version: 3, mode: 'one-shot', provider: 'in-process' }),
      ]),
    ).toEqual({ kind: 'none' })
    for (const mode of [undefined, 'garbage']) {
      const folded = readDelegationNarrowing([
        descriptor({ version: 3, mode, provider: 'in-process', toolFilter: { deny: ['bash'] } }),
      ])
      expect(folded.kind).toBe('unreadable')
    }
  })

  it('folds an allow list and a deny list', () => {
    expect(readDelegationNarrowing([continuable({ allow: ['fs_read', 'bash'] })])).toEqual({
      kind: 'narrowed',
      allow: ['fs_read', 'bash'],
    })
    expect(readDelegationNarrowing([continuable({ deny: ['bash'] })])).toEqual({ kind: 'narrowed', deny: ['bash'] })
    expect(readDelegationNarrowing([continuable({ allow: [], deny: [] })])).toEqual({
      kind: 'narrowed',
      allow: [],
      deny: [],
    })
  })

  it('takes the FIRST descriptor as authoritative, like the harness fold', () => {
    expect(
      readDelegationNarrowing([continuable({ allow: ['fs_read'] }), continuable({ deny: ['bash'] })]),
    ).toEqual({ kind: 'narrowed', allow: ['fs_read'] })
  })

  it.each([
    ['a non-object payload', descriptor('nope')],
    ['an unknown version', descriptor({ version: 2, mode: 'continuable' })],
    ['a newer version', descriptor({ version: 4, mode: 'continuable', toolFilter: { allow: [] } })],
    ['a non-object filter', continuable('nope')],
    ['a filter naming neither side', continuable({})],
    ['a non-array allow', continuable({ allow: 'fs_read' })],
    ['a non-string entry', continuable({ allow: [7] })],
  ])('reports unreadable for %s', (_label, event) => {
    const folded = readDelegationNarrowing([event as unknown])
    expect(folded.kind).toBe('unreadable')
    expect((folded as { reason: string }).reason.length).toBeGreaterThan(0)
  })
})

describe('admissionOf', () => {
  it('admits everything when there is nothing to enforce (fail open)', () => {
    for (const narrowing of [
      { kind: 'none' } as const,
      { kind: 'absent' } as const,
      { kind: 'unreadable', reason: 'x' } as const,
    ]) {
      const admitted = admissionOf(narrowing)
      expect(admitted('mcp__files__read_file')).toBe(true)
      expect(admitted('bash')).toBe(true)
    }
  })

  it('mirrors the harness admits() math per name', () => {
    // allow = keep only what it lists; deny = remove what it lists; both AND.
    expect(admissionOf({ kind: 'narrowed', allow: ['bash'] })('bash')).toBe(true)
    expect(admissionOf({ kind: 'narrowed', allow: ['bash'] })('mcp__files__read_file')).toBe(false)
    expect(admissionOf({ kind: 'narrowed', allow: [] })('bash')).toBe(false)
    expect(admissionOf({ kind: 'narrowed', deny: ['bash'] })('bash')).toBe(false)
    expect(admissionOf({ kind: 'narrowed', deny: ['bash'] })('mcp__files__read_file')).toBe(true)
    expect(admissionOf({ kind: 'narrowed', allow: ['bash'], deny: ['bash'] })('bash')).toBe(false)
    expect(admissionOf({ kind: 'narrowed', allow: ['bash', 'fs'], deny: ['fs'] })('fs')).toBe(false)
    expect(admissionOf({ kind: 'narrowed', allow: ['bash', 'fs'], deny: ['fs'] })('bash')).toBe(true)
  })
})
