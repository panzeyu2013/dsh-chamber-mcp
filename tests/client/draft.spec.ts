import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  draftFromImport,
  draftFromServer,
  draftToServer,
  evaluateDraft,
  hasProblems,
  isDraftDirty,
} from '../../src/client/draft.js'

const base = (patch: Partial<typeof EMPTY_DRAFT> = {}) => ({ ...EMPTY_DRAFT, ...patch })

describe('draft validation', () => {
  it('requires a name and a command for a stdio draft', () => {
    const problems = evaluateDraft(EMPTY_DRAFT, [])
    expect(problems.name).toBe('pattern')
    expect(problems.command).toBe('required')
    expect(hasProblems(problems)).toBe(true)
  })

  it('rejects duplicate, reserved and malformed names', () => {
    const valid = base({ name: 'alpha', command: 'node' })
    expect(evaluateDraft(valid, []).name).toBeUndefined()
    expect(evaluateDraft(valid, ['alpha']).name).toBe('duplicate')
    expect(evaluateDraft(base({ name: 'constructor', command: 'node' }), []).name).toBe('reserved')
    expect(evaluateDraft(base({ name: 'bad name', command: 'node' }), []).name).toBe('pattern')
  })

  it('validates env refs, duplicates and rows with a value but no key', () => {
    const draft = base({
      name: 'alpha',
      command: 'node',
      env: [
        { key: 'TOKEN', value: '' },
        { key: 'TOKEN', value: 'x' },
        { key: 'bad-key', value: '' },
        { key: '', value: 'orphan' },
      ],
    })
    const problems = evaluateDraft(draft, [])
    expect(problems.env).toEqual([
      undefined,
      'validation.envKeyDuplicate',
      'validation.refPattern',
      'validation.refPattern',
    ])
  })

  it('requires a valid http(s) URL and validates header names/refs', () => {
    const draft = base({
      name: 'remote',
      transport: 'streamable-http',
      url: 'ftp://example.test',
      headers: [
        { name: 'Authorization', ref: 'TOKEN', value: '' },
        { name: 'X-Key', ref: 'TOKEN', value: '' },
        { name: 'Bad Name', ref: 'R', value: '' },
      ],
    })
    const problems = evaluateDraft(draft, [])
    expect(problems.url).toBe('invalid')
    expect(problems.headers).toEqual([
      undefined,
      'validation.refDuplicate',
      'validation.headerNameToken',
    ])
    expect(evaluateDraft(base({ transport: 'streamable-http', url: '' }), []).url).toBe('required')
    expect(evaluateDraft(base({ transport: 'streamable-http', url: 'https://ok.test' }), []).url).toBeUndefined()
  })

  it('enforces timeout bounds and whole milliseconds', () => {
    for (const timeoutMs of ['999', '600001', '1.5', 'abc', '-1']) {
      expect(evaluateDraft(base({ name: 'a', command: 'node', timeoutMs }), []).timeout, timeoutMs).toBe('range')
    }
    for (const timeoutMs of ['1000', '600000', '']) {
      expect(evaluateDraft(base({ name: 'a', command: 'node', timeoutMs }), []).timeout, timeoutMs).toBeUndefined()
    }
  })
})

describe('draft materialization', () => {
  it('materializes a stdio draft and only non-empty secrets', () => {
    const draft = base({
      name: ' alpha ',
      command: ' npx ',
      args: [' -y ', 'pkg', ''],
      cwd: ' /srv ',
      env: [
        { key: 'TOKEN', value: 'secret' },
        { key: 'REGION', value: '' },
      ],
      timeoutMs: '5000',
      enabled: false,
    })
    const input = draftToServer(draft)
    expect(input.server).toEqual({
      serverName: 'alpha',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      cwd: '/srv',
      envKeys: ['TOKEN', 'REGION'],
      timeoutMs: 5000,
    })
    expect(input.secrets).toEqual([{ ref: 'TOKEN', value: 'secret' }])
    expect(input.enabled).toBe(false)
  })

  it('materializes an http draft with header refs and secrets', () => {
    const draft = base({
      name: 'remote',
      transport: 'streamable-http',
      url: ' https://example.test/mcp ',
      headers: [{ name: 'Authorization', ref: 'TOKEN', value: 'bearer' }],
    })
    const input = draftToServer(draft)
    expect(input.server).toEqual({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', ref: 'TOKEN' }],
    })
    expect(input.secrets).toEqual([{ ref: 'TOKEN', value: 'bearer' }])
  })

  it('prefills an edit draft from a disabled stdio server without secret values', () => {
    const draft = draftFromServer(
      { serverName: 'alpha', transport: 'stdio', command: 'node', args: ['a.js'], envKeys: ['TOKEN'], timeoutMs: 5000 },
      true,
    )
    expect(draft.enabled).toBe(false)
    expect(draft.timeoutMs).toBe('5000')
    expect(draft.env).toEqual([{ key: 'TOKEN', value: '' }])
    expect(draftToServer({ ...draft, enabled: true }).server).toEqual({
      serverName: 'alpha',
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      envKeys: ['TOKEN'],
      timeoutMs: 5000,
    })
  })

  it('prefills the http branch from an import', () => {
    const draft = draftFromImport(EMPTY_DRAFT, {
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      env: [],
      headers: [{ name: 'Authorization', ref: 'TOKEN', value: 'secret' }],
      enabled: true,
      timeoutMs: '5000',
    })
    expect(draft.name).toBe('remote')
    expect(draft.url).toBe('https://example.test/mcp')
    expect(draft.headers).toEqual([
      { name: 'Authorization', ref: 'TOKEN', value: 'secret' },
      { name: '', ref: '', value: '' },
    ])
    expect(draft.timeoutMs).toBe('5000')
  })

  it('detects draft changes structurally', () => {
    expect(isDraftDirty(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(false)
    expect(isDraftDirty({ ...EMPTY_DRAFT, name: 'x' }, EMPTY_DRAFT)).toBe(true)
  })
})
