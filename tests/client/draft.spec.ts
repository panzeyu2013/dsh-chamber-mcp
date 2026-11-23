import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  draftFromImport,
  draftFromServer,
  draftToServer,
  evaluateDraft,
  firstProblemField,
  hasProblems,
  isDraftDirty,
  type AddDraft,
  type DraftEnvRow,
  type DraftHeaderRow,
} from '../../src/client/draft.js'
import type { ImportedServer } from '../../src/client/import.js'
import { normalizeServerDef, type ServerDef } from '../../src/shared/model.js'

const base = (patch: Partial<AddDraft> = {}): AddDraft => ({ ...EMPTY_DRAFT, ...patch })

/** Read the http credential map a draft materialized (the frozen row type only declares legacy rows). */
const headerMapOf = (server: ServerDef): Record<string, string> | undefined =>
  (server as { headers?: unknown }).headers as Record<string, string> | undefined

const envRow = (key: string, patch: Partial<DraftEnvRow> = {}): DraftEnvRow => ({ key, ref: '', value: '', ...patch })
const headerRow = (name: string, patch: Partial<DraftHeaderRow> = {}): DraftHeaderRow => ({ name, ref: '', value: '', ...patch })

/** Build an in-memory document row (may carry the upstream map form the type does not declare yet). */
const httpDef = (value: Record<string, unknown>): ServerDef => value as unknown as ServerDef

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

  it('validates env keys, refs, duplicates and empty rows', () => {
    const draft = base({
      name: 'alpha',
      command: 'node',
      env: [
        envRow('TOKEN'),
        envRow('TOKEN', { ref: 'OTHER' }),
        envRow('bad-key'),
        envRow('', { ref: 'ORPHAN' }),
        envRow('', { ref: '', value: 'orphan-value' }),
        envRow('REGION', { ref: 'NOT VALID' }),
      ],
    })
    const problems = evaluateDraft(draft, [])
    expect(problems.env).toEqual([
      undefined,
      'validation.envKeyDuplicate',
      'validation.refPattern',
      'validation.refPattern',
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
        headerRow('Authorization', { ref: 'TOKEN' }),
        headerRow('X-Key', { ref: 'TOKEN' }),
        headerRow('Bad Name', { ref: 'R' }),
      ],
    })
    const problems = evaluateDraft(draft, [])
    expect(problems.url).toBe('invalid')
    expect(problems.headers).toEqual([undefined, 'validation.refDuplicate', 'validation.headerNameToken'])
    expect(evaluateDraft(base({ transport: 'streamable-http', url: '' }), []).url).toBe('required')
    expect(evaluateDraft(base({ transport: 'streamable-http', url: 'https://ok.test' }), []).url).toBeUndefined()
  })

  it('validates the timeouts against the upstream budget grammar (1..2147483647)', () => {
    const withTimeouts = (startupTimeoutMs: string, closeTimeoutMs = '', toolCallTimeoutMs = '') =>
      evaluateDraft(base({ name: 'a', command: 'node', startupTimeoutMs, closeTimeoutMs, toolCallTimeoutMs }), [])
    for (const value of ['0', '-1', '1.5', 'abc', '99999999999']) {
      expect(withTimeouts(value).startupTimeoutMs, value).toBe('range')
    }
    expect(withTimeouts('').startupTimeoutMs).toBeUndefined()
    // The OLD 1000..600000 window no longer applies: 1 ms and the timer maximum are legal.
    expect(withTimeouts('1').startupTimeoutMs).toBeUndefined()
    expect(withTimeouts('2147483647').startupTimeoutMs).toBeUndefined()
    expect(withTimeouts('', '600001').closeTimeoutMs).toBeUndefined()
    expect(withTimeouts('', '', '500').toolCallTimeoutMs).toBeUndefined()
    expect(withTimeouts('', '', 'x').toolCallTimeoutMs).toBe('range')
  })

  it('validates the reconnect group with defaults merged (initial <= max)', () => {
    const reconnect = (patch: Partial<AddDraft['reconnect']>) =>
      evaluateDraft(base({ name: 'a', command: 'node', reconnect: { ...EMPTY_DRAFT.reconnect, ...patch } }), []).reconnect
    expect(reconnect({ initialDelayMs: '500', maxDelayMs: '30000' })).toBeUndefined()
    expect(reconnect({ initialDelayMs: '30000', maxDelayMs: '500' })).toBe('order')
    expect(reconnect({ initialDelayMs: '0' })).toBe('initial')
    expect(reconnect({ maxDelayMs: 'x' })).toBe('max')
    expect(reconnect({ maxAttempts: '0' })).toBe('attempts')
    expect(reconnect({ maxAttempts: '1.5' })).toBe('attempts')
    expect(reconnect({ enabled: false })).toBeUndefined()
  })

  it('rejects a template trap only while expansion is enabled', () => {
    // No token anywhere -> the document keeps literal braces (documented deviation).
    expect(evaluateDraft(base({ name: 'a', command: 'node', args: ['${HOME}'] }), []).args).toEqual([undefined])
    // An env row emits a token -> expansion is on -> a literal brace expression fails.
    const trap = base({ name: 'a', command: 'node ${HOME}', args: ['ok', 'a ${credential:TOKEN}'], env: [envRow('TOKEN')] })
    const problems = evaluateDraft(trap, [])
    expect(problems.command).toBe('template')
    expect(problems.args).toEqual([undefined, undefined])
    // Exact tokens are legal everywhere in the template-capable fields.
    expect(evaluateDraft(base({ name: 'a', command: 'node', env: [envRow('TOKEN')], cwd: '${credential:ROOT}' }), []).cwd).toBeUndefined()
    // The same rules apply on the http branch (url + headers).
    expect(
      evaluateDraft(
        base({
          name: 'r',
          transport: 'streamable-http',
          url: 'https://x.test/${EVIL}',
          headers: [headerRow('Authorization', { ref: 'TOKEN' })],
        }),
        [],
      ).url,
    ).toBe('template')
  })

  it('validates oauth only on the http branch and never beside an Authorization header', () => {
    const httpOauth = (patch: Partial<AddDraft> = {}) =>
      evaluateDraft(
        base({ name: 'r', transport: 'streamable-http', url: 'https://x.test/mcp', oauthEnabled: true, ...patch }),
        [],
      )
    expect(httpOauth().oauth).toBeUndefined()
    expect(httpOauth({ oauthClientId: 'client' }).oauth).toBeUndefined()
    expect(httpOauth({ oauthClientId: '   ' }).oauth).toBe('clientId')
    expect(httpOauth({ headers: [headerRow('authorization', { ref: 'TOKEN' })] }).oauth).toBe('header')
    expect(
      evaluateDraft(base({ name: 's', command: 'node', oauthEnabled: true }), []).oauth,
    ).toBe('stdio')
  })

  it('reports the first problem in the visual focus order', () => {
    const nameProblem = evaluateDraft(EMPTY_DRAFT, [])
    expect(firstProblemField(nameProblem)).toBe('name')
    const order: [Partial<AddDraft>, unknown][] = [
      [{ name: 'a', command: '' }, 'command'],
      [{ name: 'a', command: 'node', env: [envRow('bad-key')] }, { env: 0 }],
      [{ name: 'a', command: 'node', startupTimeoutMs: 'x' }, 'startupTimeoutMs'],
      [{ name: 'a', command: 'node', reconnect: { ...EMPTY_DRAFT.reconnect, maxAttempts: '0' } }, 'reconnect'],
      [{ name: 'a', transport: 'streamable-http', url: 'https://x.test', oauthEnabled: true, oauthClientId: ' ' }, 'oauth'],
      [{ name: 'a', transport: 'streamable-http', url: 'https://x.test', headers: [headerRow('Bad Name', { ref: 'R' })] }, { header: 0 }],
      [{ name: 'a', transport: 'streamable-http', url: 'https://x.test', headers: [headerRow('X', { ref: 'R' })] }, undefined],
    ]
    for (const [patch, expected] of order) {
      const problems = evaluateDraft(base(patch), [])
      expect(firstProblemField(problems), JSON.stringify(patch)).toEqual(expected)
      if (expected !== undefined) expect(hasProblems(problems), JSON.stringify(patch)).toBe(true)
    }
  })
})

describe('draft materialization', () => {
  it('materializes a stdio draft as env credential templates and only non-empty secrets', () => {
    const draft = base({
      name: ' alpha ',
      command: ' npx ',
      args: [' -y ', 'pkg', ''],
      cwd: ' /srv ',
      env: [envRow('TOKEN', { value: 'secret' }), envRow('REGION'), envRow('ALIAS', { ref: 'REAL_TOKEN' })],
      startupTimeoutMs: '30000',
      closeTimeoutMs: '5000',
      toolCallTimeoutMs: '5000',
      toolLoading: 'on-demand',
      enabled: false,
    })
    const input = draftToServer(draft)
    expect(input.server).toEqual({
      serverName: 'alpha',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      cwd: '/srv',
      env: { TOKEN: '${credential:TOKEN}', REGION: '${credential:REGION}', ALIAS: '${credential:REAL_TOKEN}' },
      startupTimeoutMs: 30000,
      closeTimeoutMs: 5000,
      toolCallTimeoutMs: 5000,
      toolLoading: 'on-demand',
    })
    expect(input.secrets).toEqual([{ ref: 'TOKEN', value: 'secret' }])
    expect(input.enabled).toBe(false)
    // The written row must be canonical (defaults are never materialized).
    expect(normalizeServerDef(input.server)?.transport).toBe('stdio')
  })

  it('omits knobs that are left at their defaults', () => {
    const server = draftToServer(base({ name: 'a', command: 'node' })).server
    expect(server).toEqual({ serverName: 'a', transport: 'stdio', command: 'node' })
    expect((server as { toolLoading?: string }).toolLoading).toBeUndefined()
    expect((server as { reconnect?: unknown }).reconnect).toBeUndefined()
  })

  it('materializes an http draft as header credential templates and oauth config', () => {
    const draft = base({
      name: 'remote',
      transport: 'streamable-http',
      url: ' https://example.test/mcp ',
      headers: [headerRow('Authorization', { ref: 'TOKEN', value: 'bearer' }), headerRow('X-Trace', { ref: 'TRACE' })],
      oauthEnabled: true,
      oauthClientId: 'client-1',
      oauthScope: 'read write',
    })
    const input = draftToServer(draft)
    expect(headerMapOf(input.server)).toEqual({
      Authorization: '${credential:TOKEN}',
      'X-Trace': '${credential:TRACE}',
    })
    expect(input.secrets).toEqual([{ ref: 'TOKEN', value: 'bearer' }])
    expect((input.server as { oauth?: unknown }).oauth).toEqual({ clientId: 'client-1', scope: 'read write' })
  })

  it('enables oauth with defaults through the documented presence sentinel and never a credentialKey', () => {
    const input = draftToServer(
      base({ name: 'remote', transport: 'streamable-http', url: 'https://x.test/mcp', oauthEnabled: true }),
    )
    const oauth = (input.server as { oauth?: Record<string, unknown> }).oauth
    expect(oauth).toBeDefined()
    // The document normalizer reads an empty oauth block as absent, so presence
    // needs one field; the request budget equals the upstream default.
    expect(Object.keys(oauth!)).toEqual(['requestTimeoutMs'])
    expect(oauth!.requestTimeoutMs).toBe(10_000)
    expect(() => normalizeServerDef(input.server)).not.toThrow()
    expect(normalizeServerDef(input.server)?.transport).toBe('streamable-http')
    expect((normalizeServerDef(input.server) as { oauth?: unknown }).oauth).toBeDefined()
    // Disabling oauth writes no block at all.
    const off = draftToServer(
      base({ name: 'remote', transport: 'streamable-http', url: 'https://x.test/mcp', oauthEnabled: false }),
    )
    expect((off.server as { oauth?: unknown }).oauth).toBeUndefined()
  })

  it('materializes the reconnect group only when it differs from the upstream defaults', () => {
    const defaulted = draftToServer(base({ name: 'a', command: 'node' })).server
    expect((defaulted as { reconnect?: unknown }).reconnect).toBeUndefined()
    const custom = draftToServer(
      base({
        name: 'a',
        command: 'node',
        reconnect: { enabled: false, initialDelayMs: '1000', maxDelayMs: '60000', maxAttempts: '3' },
      }),
    ).server
    expect((custom as { reconnect?: unknown }).reconnect).toEqual({
      enabled: false,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 3,
    })
  })

  it('prefills an edit draft from a disabled stdio server without secret values', () => {
    const draft = draftFromServer(
      {
        serverName: 'alpha',
        transport: 'stdio',
        command: 'node',
        args: ['a.js'],
        env: { TOKEN: '${credential:TOKEN}' },
        startupTimeoutMs: 30_000,
        closeTimeoutMs: 5_000,
        toolCallTimeoutMs: 5_000,
        toolLoading: 'on-demand',
        reconnect: { enabled: true, maxAttempts: 3 },
      },
      true,
    )
    expect(draft.enabled).toBe(false)
    expect(draft.startupTimeoutMs).toBe('30000')
    expect(draft.closeTimeoutMs).toBe('5000')
    expect(draft.toolCallTimeoutMs).toBe('5000')
    expect(draft.toolLoading).toBe('on-demand')
    expect(draft.reconnect.maxAttempts).toBe('3')
    expect(draft.env).toEqual([
      { key: 'TOKEN', ref: 'TOKEN', value: '' },
      { key: '', ref: '', value: '' },
    ])
    expect(draftToServer({ ...draft, enabled: true }).server).toEqual({
      serverName: 'alpha',
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      env: { TOKEN: '${credential:TOKEN}' },
      startupTimeoutMs: 30_000,
      closeTimeoutMs: 5_000,
      toolCallTimeoutMs: 5_000,
      toolLoading: 'on-demand',
      reconnect: { enabled: true, maxAttempts: 3 },
    })
  })

  it('prefills the http branch from saved knobs, map headers and oauth', () => {
    const draft = draftFromServer(
      httpDef({
        serverName: 'remote',
        transport: 'streamable-http',
        url: 'https://example.test/mcp',
        headers: { Authorization: '${credential:TOKEN}' },
        startupTimeoutMs: 1000,
        oauth: { clientId: 'c', scope: 's' },
      }),
    )
    expect(draft.headers).toEqual([
      { name: 'Authorization', ref: 'TOKEN', value: '' },
      { name: '', ref: '', value: '' },
    ])
    expect(draft.oauthEnabled).toBe(true)
    expect(draft.oauthClientId).toBe('c')
    expect(draft.oauthScope).toBe('s')
    const input = draftToServer(draft)
    expect(headerMapOf(input.server)).toEqual({ Authorization: '${credential:TOKEN}' })
  })

  it('prefills the http branch from an import and carries the staged fields', () => {
    const imported: ImportedServer = {
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      env: [],
      headers: [{ name: 'Authorization', ref: 'TOKEN', value: 'secret' }],
      enabled: true,
      toolCallTimeoutMs: '5000',
      toolLoading: 'on-demand',
      oauth: { clientId: 'client' },
      reconnect: { enabled: true, maxAttempts: '4' },
      warnings: [],
    }
    const draft = draftFromImport(EMPTY_DRAFT, imported)
    expect(draft.name).toBe('remote')
    expect(draft.url).toBe('https://example.test/mcp')
    expect(draft.headers).toEqual([
      { name: 'Authorization', ref: 'TOKEN', value: 'secret' },
      { name: '', ref: '', value: '' },
    ])
    expect(draft.toolCallTimeoutMs).toBe('5000')
    expect(draft.toolLoading).toBe('on-demand')
    expect(draft.oauthEnabled).toBe(true)
    expect(draft.oauthClientId).toBe('client')
    expect(draft.reconnect.maxAttempts).toBe('4')
  })

  it('detects draft changes structurally', () => {
    expect(isDraftDirty(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(false)
    expect(isDraftDirty({ ...EMPTY_DRAFT, name: 'x' }, EMPTY_DRAFT)).toBe(true)
    expect(isDraftDirty({ ...EMPTY_DRAFT, toolLoading: 'on-demand' }, EMPTY_DRAFT)).toBe(true)
  })
})
