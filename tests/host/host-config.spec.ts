/**
 * Unit tests of src/host-config.ts (document row -> upstream ConfigInput,
 * credential-key derivation, the one template parser, ref resolution) and of
 * the pure src/shared/defaults.ts model (normalizeServerDef) plus the frozen
 * src/shared/wire.ts vocabulary. No upstream connection is needed: the real
 * McpClientHost is used only for its pure validate() step.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpClientHost, type Config } from '@deepseek-ai/dsh-mcp-client'
import { parseCredentialKey, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  HostConfigError,
  assertNoUnknownTemplate,
  deriveCredentialKey,
  expandTemplatesFor,
  extractTemplateRefs,
  resolveCredentialRefs,
  templateFor,
  templatedStringsOf,
  toUpstreamConfig,
  toUpstreamConfigInput,
  type HostValidate,
} from '../../src/host-config.ts'
import {
  CREDENTIAL_REF_PATTERN,
  RECONNECT_DEFAULTS,
  SERVER_DEFAULTS,
  SERVER_FIELD_NAMES,
  SERVER_NAME_PATTERN,
  TOOL_LOADING_MODES,
  isToolLoading,
  normalizeServerDef,
  type ServerDef,
  type StdioServerDef,
  type StreamableHttpServerDef,
} from '../../src/shared/defaults.ts'
import {
  MCP_CLIENT_KEY_PREFIX,
  MCP_SCOPE_ACTION_PATH,
  MCP_SCOPE_STATUS_PATH,
  MCP_SCOPE_TOOLS_PATH,
  type RuntimeActionKind,
  type RuntimeAuthorizationPhase,
  type RuntimeAuthorizationReason,
  type RuntimeErrorCode,
  type RuntimePhase,
} from '../../src/shared/wire.ts'

/** Credential token builder kept out of string literals (single source is templateFor). */
const token = (ref: string): string => templateFor(ref)

/** The real upstream host; only its pure validate() is exercised. */
const host = new McpClientHost(new Context())

/** A fresh ref set. */
function refs(...names: string[]): ReadonlySet<string> {
  return new Set(names)
}

/** A minimal stdio row. */
function stdio(overrides: Partial<StdioServerDef> = {}): StdioServerDef {
  return { serverName: 'alpha', transport: 'stdio', command: 'node', ...overrides }
}

/** A minimal http row. */
function http(overrides: Partial<StreamableHttpServerDef> = {}): StreamableHttpServerDef {
  return { serverName: 'beta', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', ...overrides }
}

/** Read the code of a thrown HostConfigError (or undefined). */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof HostConfigError ? error.code : 'unexpected'
  }
  return undefined
}

function expectStdio(input: ReturnType<typeof toUpstreamConfigInput>): asserts input is Extract<ReturnType<typeof toUpstreamConfigInput>, { transport: 'stdio' }> {
  if (input.transport !== 'stdio') throw new Error('expected a stdio input')
}

describe('host config: document -> upstream mapping', () => {
  it('materializes every resolved default for a minimal stdio row', () => {
    const input = toUpstreamConfigInput(stdio(), refs())
    expectStdio(input)
    expect(input.serverName).toBe('alpha')
    expect(input.command).toBe('node')
    expect(input.args).toEqual([])
    expect(input.cwd).toBe('')
    expect(input.env).toEqual({})
    expect(input.toolCallTimeoutMs).toBe(60_000)
    expect(input.startupTimeoutMs).toBe(30_000)
    expect(input.closeTimeoutMs).toBe(5_000)
    expect(input.reconnect).toEqual(RECONNECT_DEFAULTS)
    expect(input.toolLoading).toBe('eager')
    expect(input.catalogDescriptionMaxLength).toBe(160)
    expect(input.maxInstructionBytes).toBe(32_768)
    expect(input.failOnStartupError).toBe(false)
    expect(input.expandTemplates).toBe(false)
  })

  it('materializes the http fields including a derived OAuth block', () => {
    const input = toUpstreamConfigInput(
      http({ headers: { Authorization: 'Bearer ' + token('TOKEN') }, oauth: { clientId: 'cid', scope: 'read' } }),
      refs('TOKEN'),
    )
    if (input.transport !== 'streamable-http') throw new Error('expected an http input')
    expect(input.url).toBe('https://mcp.example.test/mcp')
    expect(input.headers).toEqual({ Authorization: 'Bearer ' + token('TOKEN') })
    expect(input.expandTemplates).toBe(true)
    expect(input.oauth).toBeDefined()
    expect(input.oauth?.credentialKey).toBe(String(deriveCredentialKey('beta')))
    expect(input.oauth?.clientId).toBe('cid')
    expect(input.oauth?.scope).toBe('read')
  })

  it('keeps an explicit OAuth credential key and its budgets', () => {
    const input = toUpstreamConfigInput(
      http({ oauth: { credentialKey: 'mcp-client/explicit', requestTimeoutMs: 1_234, authorizationTimeoutMs: 5_678 } }),
      refs(),
    )
    if (input.transport !== 'streamable-http') throw new Error('expected an http input')
    expect(input.oauth).toEqual({
      credentialKey: 'mcp-client/explicit',
      requestTimeoutMs: 1_234,
      authorizationTimeoutMs: 5_678,
    })
  })

  it('passes explicit knobs through and merges the reconnect defaults', () => {
    const input = toUpstreamConfigInput(
      stdio({
        startupTimeoutMs: 1_000,
        closeTimeoutMs: 2_000,
        toolCallTimeoutMs: 3_000,
        toolLoading: 'on-demand',
        reconnect: { enabled: false },
      }),
      refs(),
    )
    expectStdio(input)
    expect(input.startupTimeoutMs).toBe(1_000)
    expect(input.closeTimeoutMs).toBe(2_000)
    expect(input.toolCallTimeoutMs).toBe(3_000)
    expect(input.toolLoading).toBe('on-demand')
    expect(input.reconnect).toEqual({ ...RECONNECT_DEFAULTS, enabled: false })
  })

  it('always mounts with failOnStartupError:false (ready must settle on a failed attempt)', () => {
    const input = toUpstreamConfigInput(stdio({ failOnStartupError: true }), refs())
    expectStdio(input)
    expect(input.failOnStartupError).toBe(false)
  })

  it('translates the legacy timeoutMs alias and warns once', () => {
    const warn = vi.fn()
    const input = toUpstreamConfigInput(stdio({ timeoutMs: 1_234 }), refs(), { warn })
    expectStdio(input)
    expect(input.toolCallTimeoutMs).toBe(1_234)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('timeoutMs')
  })

  it('translates legacy envKeys rows to credential templates', () => {
    const warn = vi.fn()
    const input = toUpstreamConfigInput(stdio({ envKeys: ['TOKEN'] }), refs('TOKEN'), { warn })
    expectStdio(input)
    expect(input.env).toEqual({ TOKEN: token('TOKEN') })
    expect(input.expandTemplates).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('prefers the env map over legacy envKeys and warns', () => {
    const warn = vi.fn()
    const input = toUpstreamConfigInput(stdio({ env: { A: token('A') }, envKeys: ['B'] }), refs('A'), { warn })
    expectStdio(input)
    expect(input.env).toEqual({ A: token('A') })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('envKeys ignored'))
  })

  it('translates legacy header rows to header templates', () => {
    const input = toUpstreamConfigInput(
      http({ headers: [{ name: 'Authorization', ref: 'TOKEN' }] }),
      refs('TOKEN'),
    )
    if (input.transport !== 'streamable-http') throw new Error('expected an http input')
    expect(input.headers).toEqual({ Authorization: token('TOKEN') })
    expect(input.expandTemplates).toBe(true)
  })

  it('refuses duplicate legacy header names case-insensitively', () => {
    expect(codeOf(() => toUpstreamConfigInput(
      http({ headers: [{ name: 'Authorization', ref: 'A' }, { name: 'authorization', ref: 'B' }] }),
      refs('A', 'B'),
    ))).toBe('duplicate-header')
  })

  it('refuses malformed legacy refs and header names', () => {
    expect(codeOf(() => toUpstreamConfigInput(stdio({ envKeys: ['1BAD'] }), refs('1BAD')))).toBe('invalid-ref')
    expect(codeOf(() => toUpstreamConfigInput(
      http({ headers: [{ name: 'Bad Header', ref: 'A' }] }),
      refs('A'),
    ))).toBe('invalid-ref')
    expect(codeOf(() => toUpstreamConfigInput(
      http({ headers: [{ name: 'X-A', ref: 'BAD REF' }] }),
      refs('BAD REF'),
    ))).toBe('invalid-ref')
  })

  it('refuses a malformed template occurrence when expansion is enabled', () => {
    const error = (() => {
      try {
        toUpstreamConfigInput(stdio({ command: 'node', args: [token('OK'), 'literal ' + '${HOME}'] }), refs('OK'))
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(HostConfigError)
    expect((error as HostConfigError).code).toBe('invalid-template')
    expect((error as HostConfigError).message).toContain('args[1]')
  })

  it('keeps literal brace text when no token exists (documented deviation)', () => {
    const def = stdio({ command: 'echo ' + '${HOME}' })
    const input = toUpstreamConfigInput(def, refs())
    expectStdio(input)
    expect(input.expandTemplates).toBe(false)
    expect(input.command).toBe('echo ' + '${HOME}')
    // The real host accepts the resolved input too (it only parses templates when enabled).
    const resolved = toUpstreamConfig(def, refs(), { host })
    if (resolved.transport !== 'stdio') throw new Error('expected a stdio config')
    expect(resolved.expandTemplates).toBe(false)
    expect(resolved.command).toBe('echo ' + '${HOME}')
  })

  it('asserts the caller-supplied ref set equals the token-derived set', () => {
    const def = stdio({ command: 'node ' + token('MISSING') })
    expect(codeOf(() => toUpstreamConfigInput(def, refs()))).toBe('invalid-template')
    expect(codeOf(() => toUpstreamConfigInput(stdio(), refs('EXTRA')))).toBe('invalid-template')
    expect(codeOf(() => toUpstreamConfigInput(def, refs('MISSING')))).toBeUndefined()
  })

  it('uses exactly ONE host.validate call and returns its resolved object', () => {
    const resolved = { transport: 'stdio', serverName: 'alpha' } as unknown as Config
    const validate = vi.fn<HostValidate['validate']>(() => resolved)
    const result = toUpstreamConfig(stdio(), refs(), { host: { validate } })
    expect(result).toBe(resolved)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]?.[1]).toEqual(['servers', 'alpha'])
  })

  it('wraps a host rejection into a fixed invalid-config code with the cause retained', () => {
    const cause = new TypeError('upstream detail')
    let caught: unknown
    try {
      toUpstreamConfig(stdio(), refs(), { host: { validate: () => { throw cause } } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HostConfigError)
    expect((caught as HostConfigError).code).toBe('invalid-config')
    expect((caught as HostConfigError).cause).toBe(cause)
  })

  it('resolves a row through the real host with the same single-source defaults', () => {
    const resolved = toUpstreamConfig(stdio(), refs(), { host })
    if (resolved.transport !== 'stdio') throw new Error('expected a stdio config')
    expect(resolved.toolCallTimeoutMs).toBe(SERVER_DEFAULTS.toolCallTimeoutMs)
    expect(resolved.startupTimeoutMs).toBe(SERVER_DEFAULTS.startupTimeoutMs)
    expect(resolved.closeTimeoutMs).toBe(SERVER_DEFAULTS.closeTimeoutMs)
    expect(resolved.toolLoading).toBe(SERVER_DEFAULTS.toolLoading)
    expect(resolved.catalogDescriptionMaxLength).toBe(SERVER_DEFAULTS.catalogDescriptionMaxLength)
    expect(resolved.maxInstructionBytes).toBe(SERVER_DEFAULTS.maxInstructionBytes)
    expect(resolved.failOnStartupError).toBe(SERVER_DEFAULTS.failOnStartupError)
    expect(resolved.expandTemplates).toBe(SERVER_DEFAULTS.expandTemplates)
    expect(resolved.reconnect).toEqual(RECONNECT_DEFAULTS)
    expect(resolved.args).toEqual([...SERVER_DEFAULTS.args])
    expect(resolved.cwd).toBe(SERVER_DEFAULTS.cwd)
    expect(resolved.env).toEqual({ ...SERVER_DEFAULTS.env })
  })

  it('pins the reconnect defaults against the installed alpha.2 host', () => {
    const validated = host.validate({ transport: 'stdio', serverName: 'pinned', command: 'node' }, ['servers', 'pinned'])
    expect(validated.reconnect).toEqual(RECONNECT_DEFAULTS)
    expect(validated.toolCallTimeoutMs).toBe(SERVER_DEFAULTS.toolCallTimeoutMs)
    expect(validated.closeTimeoutMs).toBe(SERVER_DEFAULTS.closeTimeoutMs)
    expect(validated.toolLoading).toBe(SERVER_DEFAULTS.toolLoading)
    expect(validated.catalogDescriptionMaxLength).toBe(SERVER_DEFAULTS.catalogDescriptionMaxLength)
    expect(validated.maxInstructionBytes).toBe(SERVER_DEFAULTS.maxInstructionBytes)
  })

  it('refuses OAuth beside an Authorization header through the real host', () => {
    let caught: unknown
    try {
      toUpstreamConfig(
        http({ headers: { authorization: token('TOKEN') }, oauth: { clientId: 'cid' } }),
        refs('TOKEN'),
        { host },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HostConfigError)
    expect((caught as HostConfigError).code).toBe('invalid-config')
    expect(String((caught as HostConfigError).cause)).toContain('Authorization header')
  })

  it('refuses OAuth on a stdio row and an invalid explicit key', () => {
    expect(codeOf(() => toUpstreamConfigInput(
      { ...stdio(), oauth: { clientId: 'cid' } } as unknown as ServerDef,
      refs(),
    ))).toBe('unsupported-oauth')
    expect(codeOf(() => toUpstreamConfigInput(http({ oauth: { credentialKey: 'not-a-key' } }), refs()))).toBe('invalid-config')
    expect(codeOf(() => toUpstreamConfigInput(http({ oauth: { credentialKey: 'mcp-client/Bad' } }), refs()))).toBe('invalid-config')
  })

  it('preserves unknown reconnect keys for validateDoc and lets the host refuse them', () => {
    const row = stdio()
    row.reconnect = { bogus: 1 } as never
    const input = toUpstreamConfigInput(row, refs())
    expect((input.reconnect as Record<string, unknown>).bogus).toBe(1)
    let caught: unknown
    try {
      toUpstreamConfig(row, refs(), { host })
    } catch (error) {
      caught = error
    }
    expect((caught as HostConfigError).code).toBe('invalid-config')
    expect(String((caught as HostConfigError).cause)).toContain('reconnect option')
  })

  it('reports templated fields in a stable order', () => {
    expect(templatedStringsOf(stdio({
      command: 'node',
      args: [token('A')],
      cwd: token('C'),
      env: { K: token('E') },
    }))).toEqual([
      ['node', 'command'],
      [token('A'), 'args[0]'],
      [token('C'), 'cwd'],
      [token('E'), 'env[K]'],
    ])
    expect(templatedStringsOf(stdio({ envKeys: ['LEGACY'] }))).toEqual([
      [token('LEGACY'), 'envKeys'],
      ['node', 'command'],
    ])
    expect(templatedStringsOf(http({ url: 'https://x/' + token('U'), headers: { 'X-A': token('H') } })))
      .toEqual([['https://x/' + token('U'), 'url'], [token('H'), 'headers[X-A]']])
    expect(templatedStringsOf(http({ headers: [{ name: 'X-A', ref: 'R' }] })))
      .toEqual([['https://mcp.example.test/mcp', 'url'], [token('R'), 'headers[X-A]']])
    // A row carrying BOTH the env map and a legacy envKeys list serializes only
    // the emitted map (the adapter ignores the legacy container); the old second
    // walker kept the ignored envKeys entry — that drift is gone.
    expect(templatedStringsOf(stdio({ env: { K: token('E') }, envKeys: ['LEGACY'] })))
      .toEqual([['node', 'command'], [token('E'), 'env[K]']])
  })

  it('derives expandTemplates from the emitted value space only', () => {
    expect(expandTemplatesFor(stdio())).toBe(false)
    expect(expandTemplatesFor(stdio({ command: 'echo ' + '${HOME}' }))).toBe(false)
    expect(expandTemplatesFor(stdio({ args: [token('A')] }))).toBe(true)
    expect(expandTemplatesFor(stdio({ envKeys: ['A'] }))).toBe(true)
    expect(expandTemplatesFor(http({ headers: [{ name: 'X-A', ref: 'A' }] }))).toBe(true)
    // The ignored legacy container cannot force expansion either.
    expect(expandTemplatesFor(stdio({ env: { K: 'plain' }, envKeys: ['A'] }))).toBe(false)
  })
})

describe('host config: credential keys', () => {
  it('derives the namespaced key and pins the reviewed examples', () => {
    expect(String(deriveCredentialKey('alpha'))).toBe('mcp-client/mcp-scope-8ed3f6ad685b959e')
    expect(String(deriveCredentialKey('GitHub'))).toBe('mcp-client/mcp-scope-f911e414cf6bdfc5')
    expect(String(deriveCredentialKey('My_Server'))).toBe('mcp-client/mcp-scope-7115d58347ed501b')
    expect(String(deriveCredentialKey('alpha')).startsWith(MCP_CLIENT_KEY_PREFIX)).toBe(true)
  })

  it('is deterministic, distinct and parseable for every legal server name', () => {
    const names = ['a', 'A_b-C', 'x'.repeat(32), 'alpha', 'GitHub']
    const keys = names.map((name) => String(deriveCredentialKey(name)))
    expect(new Set(keys).size).toBe(names.length)
    expect(String(deriveCredentialKey('alpha'))).toBe(String(deriveCredentialKey('alpha')))
    for (const key of keys) {
      expect(() => parseCredentialKey(key)).not.toThrow()
      expect(key.startsWith('mcp-client/mcp-scope-')).toBe(true)
    }
  })
})

describe('host config: the single template parser', () => {
  it('formats one credential token and refuses a malformed ref', () => {
    expect(templateFor('TOKEN')).toBe('${credential:TOKEN}')
    expect(codeOf(() => templateFor('1BAD'))).toBe('invalid-ref')
  })

  it('extracts refs in template order and ignores literal text', () => {
    expect(extractTemplateRefs('${credential:A}/x/${credential:B}')).toEqual(['A', 'B'])
    expect(extractTemplateRefs('plain ${HOME} text')).toEqual([])
    expect(extractTemplateRefs('${credential:1BAD}')).toEqual([])
  })

  it('rejects non-token occurrences and accepts exact tokens', () => {
    expect(() => assertNoUnknownTemplate('${credential:OK}', 'where')).not.toThrow()
    expect(codeOf(() => assertNoUnknownTemplate('${HOME}', 'where'))).toBe('invalid-template')
    expect(codeOf(() => assertNoUnknownTemplate('${credential:OK}${HOME}', 'where'))).toBe('invalid-template')
    expect(codeOf(() => assertNoUnknownTemplate('${x${credential:A}', 'where'))).toBe('invalid-template')
  })

  it('resolves refs through a provider and refuses missing/control-character values', async () => {
    const values = new Map<string, string>([['GOOD', 's3cret'], ['BLANK', ''], ['BAD', 'line1\nline2']])
    const credentials = {
      resolve: async (ref: CredentialRef) => {
        const value = values.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' }
      },
    }
    const resolved = await resolveCredentialRefs(['GOOD'], credentials)
    expect(resolved.get('GOOD')).toBe('s3cret')
    await expect(resolveCredentialRefs(['MISSING'], credentials)).rejects.toMatchObject({ code: 'invalid-ref' })
    await expect(resolveCredentialRefs(['BLANK'], credentials)).rejects.toMatchObject({ code: 'invalid-ref' })
    await expect(resolveCredentialRefs(['BAD'], credentials)).rejects.toMatchObject({ code: 'invalid-ref' })
    await expect(resolveCredentialRefs(['1BAD'], credentials)).rejects.toMatchObject({ code: 'invalid-ref' })
    // The rejection never carries the resolved value.
    await resolveCredentialRefs(['BAD'], credentials).catch((error: unknown) => {
      expect((error as Error).message).not.toContain('line1')
    })
  })
})

describe('defaults: normalizeServerDef', () => {
  it('ignores non-objects and structurally unusable rows', () => {
    expect(normalizeServerDef(null)).toBeUndefined()
    expect(normalizeServerDef('x')).toBeUndefined()
    expect(normalizeServerDef({ transport: 'stdio' })).toBeUndefined()
    expect(normalizeServerDef({ serverName: 's', transport: 'websocket' })).toBeUndefined()
    expect(normalizeServerDef({ serverName: 's', transport: 'stdio' })).toBeUndefined()
    expect(normalizeServerDef({ serverName: 's', transport: 'streamable-http' })).toBeUndefined()
  })

  it('translates the legacy timeout only when the new field is absent', () => {
    const translated = normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', timeoutMs: 1_500 })
    expect(translated).toMatchObject({ toolCallTimeoutMs: 1_500 })
    expect(translated && 'timeoutMs' in translated).toBe(false)
    const preferred = normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', timeoutMs: 1_500, toolCallTimeoutMs: 2_500 })
    expect(preferred).toMatchObject({ toolCallTimeoutMs: 2_500 })
    expect(preferred && 'timeoutMs' in preferred).toBe(false)
  })

  it('materializes no defaults and drops unknown keys', () => {
    const row = normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', surprise: true })
    expect(row).not.toBeUndefined()
    expect(row && 'toolCallTimeoutMs' in row).toBe(false)
    expect(row && 'startupTimeoutMs' in row).toBe(false)
    expect(row && 'connectTimeoutMs' in row).toBe(false)
    expect(row && 'surprise' in row).toBe(false)
  })

  it('prefers the env map over legacy envKeys and filters non-strings', () => {
    const withEnv = normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', env: { A: 'x', B: 3 }, envKeys: ['OLD'], args: ['a', 3] })
    expect(withEnv).toMatchObject({ env: { A: 'x' }, args: ['a'] })
    expect(withEnv && 'envKeys' in withEnv).toBe(false)
    const legacy = normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', envKeys: ['TOKEN', 2] })
    expect(legacy).toMatchObject({ envKeys: ['TOKEN'] })
  })

  it('normalizes the http row including headers and OAuth', () => {
    const map = normalizeServerDef({ serverName: 'h', transport: 'streamable-http', url: 'https://x', headers: { A: 'b' }, oauth: { clientId: 'cid', scope: 'read' } })
    expect(map).toMatchObject({ headers: { A: 'b' }, oauth: { clientId: 'cid', scope: 'read' } })
    const rows = normalizeServerDef({ serverName: 'h', transport: 'streamable-http', url: 'https://x', headers: [{ name: 'A', ref: 'R' }, { name: 1 }] })
    expect(rows).toMatchObject({ headers: [{ name: 'A', ref: 'R' }] })
    const emptyOauth = normalizeServerDef({ serverName: 'h', transport: 'streamable-http', url: 'https://x', oauth: {} })
    expect(emptyOauth && 'oauth' in emptyOauth).toBe(false)
  })

  it('keeps the known knob fields and drops the derived expandTemplates', () => {
    const row = normalizeServerDef({
      serverName: 's',
      transport: 'stdio',
      command: 'node',
      startupTimeoutMs: 1_000,
      closeTimeoutMs: 2_000,
      maxInstructionBytes: 4_096,
      catalogDescriptionMaxLength: 80,
      toolLoading: 'on-demand',
      failOnStartupError: false,
      expandTemplates: true,
    })
    expect(row).toMatchObject({
      startupTimeoutMs: 1_000,
      closeTimeoutMs: 2_000,
      maxInstructionBytes: 4_096,
      catalogDescriptionMaxLength: 80,
      toolLoading: 'on-demand',
      failOnStartupError: false,
    })
    expect(row && 'expandTemplates' in row).toBe(false)
    // A typo'd enum value survives for validateDoc to report.
    expect(normalizeServerDef({ serverName: 's', transport: 'stdio', command: 'node', toolLoading: 'lazy' }))
      .toMatchObject({ toolLoading: 'lazy' })
  })

  it('is idempotent', () => {
    const raw = { serverName: 's', transport: 'stdio', command: 'node', timeoutMs: 1000, envKeys: ['A'], reconnect: { enabled: false } }
    const once = normalizeServerDef(raw)
    const twice = normalizeServerDef(once)
    expect(twice).toEqual(once)
    expect(once).not.toBe(raw)
  })

  it('exposes the frozen identifier contracts', () => {
    expect(SERVER_NAME_PATTERN.test('A_b-1')).toBe(true)
    expect(SERVER_NAME_PATTERN.test('bad name')).toBe(false)
    expect(CREDENTIAL_REF_PATTERN.test('TOKEN_1')).toBe(true)
    expect(SERVER_FIELD_NAMES.toolCallTimeoutMs).toBe('toolCallTimeoutMs')
    expect(TOOL_LOADING_MODES).toEqual(['eager', 'on-demand'])
    expect(isToolLoading('eager')).toBe(true)
    expect(isToolLoading('lazy')).toBe(false)
  })
})

describe('wire contract: frozen paths and enums', () => {
  it('pins the three Fetch paths and the credential namespace prefix', () => {
    expect(MCP_SCOPE_STATUS_PATH).toBe('/api/mcp-scope.status')
    expect(MCP_SCOPE_ACTION_PATH).toBe('/api/mcp-scope.action')
    expect(MCP_SCOPE_TOOLS_PATH).toBe('/api/mcp-scope.tools')
    expect(MCP_CLIENT_KEY_PREFIX).toBe('mcp-client/')
  })

  it('lists every wire union member exactly once', () => {
    const phases: RuntimePhase[] = [
      'connected', 'connecting', 'reconnecting', 'waiting-credentials',
      'waiting-authorization', 'failed', 'stopped', 'disabled', 'unknown',
    ]
    const codes: RuntimeErrorCode[] = [
      'gave-up', 'reconnect-disabled', 'generation-stuck', 'forbidden', 'timeout',
      'spawn-failed', 'protocol', 'connection-failed', 'load', 'cleanup', 'conflict',
      'config', 'seam', 'invalid-credential',
    ]
    const reasons: RuntimeAuthorizationReason[] = ['missing', 'expired', 'binding', 'rejected', 'scope']
    const attemptPhases: RuntimeAuthorizationPhase[] = [
      'starting', 'waiting-browser', 'exchanging', 'committing', 'authorized', 'cancelled', 'failed',
    ]
    const actions: RuntimeActionKind[] = [
      'connect', 'disconnect', 'restart', 'test', 'authorize', 'cancel-authorization', 'sign-out',
    ]
    for (const list of [phases, codes, reasons, attemptPhases, actions]) {
      expect(new Set(list).size).toBe(list.length)
    }
    expect(phases).toHaveLength(9)
    expect(actions).toHaveLength(7)
  })
})
