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
  it('reports none when the child log carries no descriptor', () => {
    expect(readDelegationNarrowing([])).toEqual({ kind: 'none' })
    expect(readDelegationNarrowing([{ type: 'request/header', data: {} }])).toEqual({ kind: 'none' })
    // Defensive: a non-array input is not a log.
    expect(readDelegationNarrowing(undefined as unknown as readonly unknown[])).toEqual({ kind: 'none' })
  })

  it('reports none for a one-shot descriptor, which declares no narrowing', () => {
    expect(readDelegationNarrowing([descriptor({ version: 3, mode: 'one-shot', provider: 'in-process' })])).toEqual({
      kind: 'none',
    })
    expect(readDelegationNarrowing([continuable()])).toEqual({ kind: 'none' })
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
    for (const narrowing of [{ kind: 'none' } as const, { kind: 'unreadable', reason: 'x' } as const]) {
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
