/**
 * Transport tests (src/transport.ts): env scrub + explicit merge, per-attempt
 * credential resolution incl. missing-ref omission, and an end-to-end proof
 * that a resolved env key actually reaches a spawned stdio MCP child.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import type { ServerDef } from '../../src/shared/model.js'
import {
  buildChildEnv,
  createTransport,
  resolveServerEnv,
  resolveServerHeaders,
  type CredentialResolver,
} from '../../src/transport.js'

const fixtureServer = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', 'mcp-fixture-server.mjs')

function stdioDef(overrides: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {}): Extract<ServerDef, { transport: 'stdio' }> {
  return {
    serverName: 'srv',
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: '',
    envKeys: [],
    ...overrides,
  }
}

function resolver(table: Record<string, string | undefined>): CredentialResolver {
  return async (ref) => {
    const value = table[ref]
    return value === undefined || value === '' ? undefined : { value, source: 'test' }
  }
}

/** Resolver that returns stored values verbatim (used for invalid-value tests). */
function rawResolver(table: Record<string, string | undefined>): CredentialResolver {
  return async (ref) => {
    const value = table[ref]
    return value === undefined ? undefined : { value, source: 'test' }
  }
}

describe('buildChildEnv', () => {
  const SENSITIVE = ['MCP_SECRET_TOKEN', 'API_KEY', 'PASSWORD_1']
  const DSHISH = ['DSH_HOME', 'dsh_token', 'Dsh_Whatever']
  const SAVED = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const key of [...SENSITIVE, ...DSHISH, 'PLAIN_VAR']) {
      SAVED.set(key, process.env[key])
    }
    process.env.MCP_SECRET_TOKEN = 'ambient-secret'
    process.env.API_KEY = 'ambient-key'
    process.env.PASSWORD_1 = 'ambient-pass'
    process.env.DSH_HOME = '/ambient/home'
    process.env.dsh_token = 'ambient-dsh'
    process.env.Dsh_Whatever = 'ambient-dsh2'
    process.env.PLAIN_VAR = 'ambient-plain'
  })

  afterAll(() => {
    for (const [key, value] of SAVED) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('drops credential-shaped and DSH_* ambient names, then merges explicit env', () => {
    const env = buildChildEnv({ MCP_SECRET_TOKEN: 'explicit-wins', EXPLICIT: 'yes' })
    expect(env.MCP_SECRET_TOKEN).toBe('explicit-wins')
    expect(env.EXPLICIT).toBe('yes')
    expect(env.PLAIN_VAR).toBe('ambient-plain')
    expect(env.API_KEY).toBeUndefined()
    expect(env.PASSWORD_1).toBeUndefined()
    expect(env.DSH_HOME).toBeUndefined()
    expect(env.dsh_token).toBeUndefined()
    expect(env.Dsh_Whatever).toBeUndefined()
  })
})

describe('resolveServerEnv / resolveServerHeaders', () => {
  it('resolves envKeys and omits missing or empty refs with a warning', async () => {
    const warnings: string[] = []
    const env = await resolveServerEnv(
      stdioDef({ envKeys: ['PRESENT', 'MISSING', 'EMPTY'] }),
      resolver({ PRESENT: 'v1', MISSING: undefined, EMPTY: '' }),
      (m) => void warnings.push(m),
    )
    expect(env).toEqual({ PRESENT: 'v1' })
    expect(warnings.length).toBe(2)
    expect(warnings[0]).toMatch(/MISSING/)
    expect(warnings[1]).toMatch(/EMPTY/)
  })

  it('resolves headers and omits missing refs; warns without a logger too', async () => {
    const headers = await resolveServerHeaders(
      { serverName: 'srv', transport: 'streamable-http', url: 'https://x', headers: [{ name: 'X-Auth', ref: 'OK' }, { name: 'Y', ref: 'NOPE' }] },
      resolver({ OK: 'tok' }),
    )
    expect(headers).toEqual({ 'X-Auth': 'tok' })
  })

  it('returns empty maps for the wrong transport shape', async () => {
    expect(await resolveServerEnv({ serverName: 'srv', transport: 'streamable-http', url: 'https://x' }, resolver({}))).toEqual({})
    expect(await resolveServerHeaders(stdioDef(), resolver({}))).toEqual({})
  })

  it('rejects env values containing CR/LF/NUL and warns by key only (SEC-02)', async () => {
    const warnings: string[] = []
    const env = await resolveServerEnv(
      stdioDef({ envKeys: ['CRLF', 'NUL', 'OK'] }),
      rawResolver({ CRLF: 'a\r\nb', NUL: 'x\0y', OK: 'fine' }),
      (m) => void warnings.push(m),
    )
    expect(env).toEqual({ OK: 'fine' })
    expect(warnings.length).toBe(2)
    // Each warning names the key and never the value.
    for (const warning of warnings) {
      expect(warning).toMatch(/^mcp-scope\(srv\): credential ref "/)
      expect(warning).toMatch(/omitting env key/)
      // A leaked value would embed a raw newline or NUL.
      expect(warning).not.toContain('\r')
      expect(warning).not.toContain('\n')
      expect(warning).not.toContain('\0')
    }
    expect(warnings[0]).toContain('CRLF')
    expect(warnings[1]).toContain('NUL')
    expect(warnings.join('')).not.toContain('a\r\nb')
    expect(warnings.join('')).not.toContain('x\0y')
  })

  it('rejects header values containing CR/LF/NUL and warns by ref/name only (SEC-02)', async () => {
    const warnings: string[] = []
    const headers = await resolveServerHeaders(
      { serverName: 'srv', transport: 'streamable-http', url: 'https://x', headers: [{ name: 'X-Auth', ref: 'BAD' }, { name: 'X-Other', ref: 'OK2' }] },
      rawResolver({ BAD: 'line1\nline2', OK2: 'ok-value' }),
      (m) => void warnings.push(m),
    )
    expect(headers).toEqual({ 'X-Other': 'ok-value' })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/^mcp-scope\(srv\): credential ref "BAD"/)
    expect(warnings[0]).toContain('omitting header "X-Auth"')
    expect(warnings[0]).not.toContain('\r')
    expect(warnings[0]).not.toContain('\n')
    expect(warnings[0]).not.toContain('\0')
    expect(warnings[0]).not.toContain('line1')
  })
})

describe('createTransport', () => {
  it('builds a stdio transport whose resolved env reaches the real child', async () => {
    const def = stdioDef({ envKeys: ['PROBE_TOKEN'] })
    const transport = await createTransport(def, resolver({ PROBE_TOKEN: 'from-credentials' }))
    const client = new Client(
      { name: 'transport-spec', version: '0.0.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    try {
      await client.connect(transport)
      const list = await client.listTools(undefined, { cacheMode: 'refresh' })
      expect(list.tools.some((tool) => tool.name === 'env_probe')).toBe(true)
      const call = await client.callTool({ name: 'env_probe', arguments: {} })
      const content = call.content as { type: string; text?: string }[]
      expect(content[0]).toMatchObject({ type: 'text', text: 'from-credentials' })
    } finally {
      await client.close()
    }
  })

  it('builds a streamable-http transport with resolved headers', async () => {
    const transport = await createTransport(
      { serverName: 'srv', transport: 'streamable-http', url: 'http://127.0.0.1:9/nope', headers: [{ name: 'Authorization', ref: 'TOK' }] },
      resolver({ TOK: 'abc' }),
    )
    expect(transport).toBeDefined()
  })
})
