/**
 * Document -> upstream config parity: the settings document and the mounted
 * official host must agree about defaults, legacy translation, bounds and
 * credential references (S4/S6/S2, I11).
 *
 * The real McpClientHost.validate is the authority; the adapter must produce
 * exactly what it accepts and must refuse what the document refuses.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpClientHost } from '@deepseek-ai/dsh-mcp-client'
import {
  HostConfigError,
  expandTemplatesFor,
  extractTemplateRefs,
  resolveCredentialRefs,
  templateFor,
  templatedStringsOf,
  toUpstreamConfig,
  toUpstreamConfigInput,
} from '../../src/host-config.js'
import { credentialRefsInDefinition } from '../../src/upstream.js'
import {
  RECONNECT_DEFAULTS,
  SERVER_DEFAULTS,
  canonicalDoc,
  credentialRefsOf,
  hasCredentialTemplate,
  templatedValuesOf,
  validateDoc,
  type McpScopeDoc,
  type ServerDef,
  type StdioServerDef,
} from '../../src/shared/model.js'
import { normalizeServerDef } from '../../src/shared/defaults.js'

/** The real upstream validation surface, constructed on a throwaway context. */
const host = new McpClientHost(new Context())

/** Resolve one document row through the adapter + the real host. */
function resolve(def: ServerDef) {
  return toUpstreamConfig(def, credentialRefsInDefinition(def), { host })
}

const stdio = (extra: Partial<StdioServerDef> = {}): StdioServerDef => ({
  serverName: 'files',
  transport: 'stdio',
  command: '/usr/bin/mcp-files',
  ...extra,
})

const http = (extra: Partial<Extract<ServerDef, { transport: 'streamable-http' }>> = {}): ServerDef => ({
  serverName: 'github',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/github',
  ...extra,
})

/** One literal shell-brace expression (never a credential token). */
const LITERAL_BRACES = '/usr/bin/mcp-' + '${HOME}'
/** One literal credential-shaped but invalid occurrence. */
const INVALID_TOKEN = '${credential:1BAD}'

describe('document -> upstream config adapter', () => {
  it('host.validate accepts the adapted config; defaults are the single shared table', () => {
    const config = resolve(stdio())
    expect(config.transport).toBe('stdio')
    // The four exposed knobs + the upstream materialized defaults come from
    // SERVER_DEFAULTS, and the real host agrees with every value.
    expect(config.toolCallTimeoutMs).toBe(SERVER_DEFAULTS.toolCallTimeoutMs)
    expect(config.startupTimeoutMs).toBe(SERVER_DEFAULTS.startupTimeoutMs)
    expect(config.closeTimeoutMs).toBe(SERVER_DEFAULTS.closeTimeoutMs)
    expect(config.toolLoading).toBe(SERVER_DEFAULTS.toolLoading)
    expect(config.catalogDescriptionMaxLength).toBe(SERVER_DEFAULTS.catalogDescriptionMaxLength)
    expect(config.maxInstructionBytes).toBe(SERVER_DEFAULTS.maxInstructionBytes)
    expect(config.failOnStartupError).toBe(false)
    expect(config.expandTemplates).toBe(false)
    expect(config.reconnect).toEqual(RECONNECT_DEFAULTS)
    // expandTemplates is DERIVED from the content, never stored in the document.
    const templated = normalizeServerDef({
      serverName: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      env: { FILES_TOKEN: templateFor('FILES_TOKEN') },
    })!
    expect(resolve(templated).expandTemplates).toBe(true)
  })

  it('maps the four exposed fields and merges the reconnect defaults', () => {
    const config = resolve(
      stdio({
        toolCallTimeoutMs: 1_234,
        startupTimeoutMs: 2_500,
        closeTimeoutMs: 700,
        toolLoading: 'on-demand',
        reconnect: { maxAttempts: 2 },
      }),
    )
    expect(config.toolCallTimeoutMs).toBe(1_234)
    expect(config.startupTimeoutMs).toBe(2_500)
    expect(config.closeTimeoutMs).toBe(700)
    expect(config.toolLoading).toBe('on-demand')
    expect(config.reconnect).toEqual({ ...RECONNECT_DEFAULTS, maxAttempts: 2 })
  })

  it('translates legacy fields at read time without mutating the document', () => {
    const legacy = {
      serverName: 'legacy',
      transport: 'stdio',
      command: '/usr/bin/mcp-legacy',
      envKeys: ['LEGACY_TOKEN'],
      timeoutMs: 5_000,
    }
    const snapshot = JSON.stringify(legacy)
    const doc = canonicalDoc({ servers: [legacy], overrides: {} })
    const row = doc.servers[0] as StdioServerDef
    // Read-compat: the deprecated alias becomes the new name on the canonical row.
    expect(row.toolCallTimeoutMs).toBe(5_000)
    expect((row as unknown as Record<string, unknown>).timeoutMs).toBeUndefined()
    // envKeys stays a legacy container on the document row; the adapter rewrites it.
    expect(row.envKeys).toEqual(['LEGACY_TOKEN'])
    expect(JSON.stringify(legacy)).toBe(snapshot)
    // The adapter is ALSO callable on a raw legacy row (before canonicalDoc): it
    // then translates the same forms itself and warns exactly once per form,
    // naming fields/refs only (never values).
    const raw = legacy as unknown as ServerDef
    const warns: string[] = []
    const input = toUpstreamConfigInput(raw, credentialRefsInDefinition(raw), {
      warn: (message) => void warns.push(message),
    })
    expect(input.toolCallTimeoutMs).toBe(5_000)
    expect(input.transport === 'stdio' ? input.env : {}).toEqual({
      LEGACY_TOKEN: templateFor('LEGACY_TOKEN'),
    })
    expect(warns.filter((message) => message.includes('timeoutMs translated'))).toHaveLength(1)
    expect(warns.filter((message) => message.includes('legacy envKeys row translated'))).toHaveLength(1)
    // Both names present: the new one wins and the alias is not warned about.
    const both = normalizeServerDef({ ...legacy, toolCallTimeoutMs: 9_000 })!
    const bothWarns: string[] = []
    const bothInput = toUpstreamConfigInput(both, credentialRefsInDefinition(both), {
      warn: (message) => void bothWarns.push(message),
    })
    expect(bothInput.toolCallTimeoutMs).toBe(9_000)
    expect(bothWarns.some((message) => message.includes('timeoutMs'))).toBe(false)
  })

  it('refuses the same names, refs and bounds the document refuses', () => {
    const cases: Array<{ def: ServerDef; docError: RegExp; hostError: RegExp }> = [
      {
        def: stdio({ serverName: 'has space' }),
        docError: /name must match/,
        hostError: /server name must match/,
      },
      {
        def: stdio({ envKeys: ['1BAD'] }),
        docError: /env key "1BAD"/,
        hostError: /not a POSIX identifier/,
      },
      {
        def: stdio({ envKeys: ['TOKEN'], command: LITERAL_BRACES }),
        docError: /is not a template token/,
        hostError: /is not a template token/,
      },
      {
        def: stdio({ reconnect: { maxAttempts: 0 } }),
        docError: /maxAttempts must be a positive integer/,
        hostError: /reconnect|maxAttempts|positive|no less than 1/,
      },
      {
        def: stdio({ startupTimeoutMs: 0 }),
        docError: /startupTimeoutMs must be an integer/,
        hostError: /startupTimeoutMs|no less than 1/,
      },
      {
        def: stdio({ toolLoading: 'sometimes' as never }),
        docError: /toolLoading must be one of/,
        hostError: /toolLoading/,
      },
    ]
    for (const { def, docError, hostError } of cases) {
      const doc: McpScopeDoc = { servers: [def], overrides: {} }
      expect(validateDoc(doc).join('; '), 'document refusal for ' + def.serverName).toMatch(docError)
      // The mounted host is the mount-time authority and refuses the same input:
      // either the adapter throws first (HostConfigError) or validate does.
      let message = ''
      try {
        resolve(def)
        throw new Error('expected the adapter to refuse ' + def.serverName)
      } catch (error) {
        const cause = error instanceof Error ? String((error as { cause?: unknown }).cause ?? '') : ''
        message = error instanceof HostConfigError ? error.code + ' ' + error.message + ' ' + cause : String(error)
      }
      expect(message).toMatch(hostError)
      expect(message).not.toMatch(/expected the adapter/)
    }
  })

  it('refuses oauth beside an Authorization header and a malformed credential key', () => {
    const conflict = http({ oauth: {}, headers: [{ name: 'Authorization', ref: 'TOKEN' }] })
    expect(validateDoc({ servers: [conflict], overrides: {} }).join('; '))
      .toMatch(/oauth and an Authorization header cannot be configured together/)
    expect(() => resolve(conflict)).toThrow(/OAuth and an Authorization header|rejected the resolved configuration/)

    const malformed = http({ oauth: { credentialKey: 'Bad Key' } })
    expect(validateDoc({ servers: [malformed], overrides: {} }).join('; ')).toMatch(/oauth.credentialKey must match/)
    let error: unknown
    try {
      resolve(malformed)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HostConfigError)
    expect((error as HostConfigError).code).toBe('invalid-config')

    // OAuth on stdio is refused by both layers too.
    const stdioOauth = { ...stdio(), oauth: {} } as unknown as ServerDef
    expect(validateDoc({ servers: [stdioOauth], overrides: {} }).join('; '))
      .toMatch(/oauth is supported only on streamable-http/)
    expect(() => resolve(stdioOauth)).toThrow(/OAuth is supported only on streamable-http/)
  })

  it('keeps literal braces only when no credential token forces template expansion', () => {
    // Documented deviation from the official manager: a server with no token at
    // all keeps a literal brace expression (the official manager expands
    // unconditionally and would refuse it).
    const literal = stdio({ command: LITERAL_BRACES })
    expect(validateDoc({ servers: [literal], overrides: {} })).toEqual([])
    const config = resolve(literal)
    expect(config.expandTemplates).toBe(false)
    expect(config.transport === 'stdio' ? config.command : '').toBe(LITERAL_BRACES)
    // As soon as one token exists, the host refuses a non-token occurrence —
    // which is exactly the trap validateDoc rejects before a write.
    const trapped = stdio({ envKeys: ['TOKEN'], command: LITERAL_BRACES })
    expect(() => resolve(trapped)).toThrow(/is not a template token/)
    // A credential-shaped occurrence that is not a valid token is refused by the
    // parser once expansion is on (a valid token elsewhere in the row).
    const invalid = stdio({ env: { A: INVALID_TOKEN, B: templateFor('TOKEN') } })
    expect(() => resolve(invalid)).toThrow(/is not a template token/)
  })

  it('never materializes a credential VALUE into the config input', () => {
    const def = stdio({ env: { FILES_TOKEN: templateFor('FILES_TOKEN'), LITERAL: 'plain-value' } })
    const input = toUpstreamConfigInput(def, credentialRefsInDefinition(def))
    // The adapter is pure: it does not resolve credentials at all.
    expect(input.transport).toBe('stdio')
    const env = (input.transport === 'stdio' ? input.env : {}) ?? {}
    expect(env.FILES_TOKEN).toBe(templateFor('FILES_TOKEN'))
    // No resolved credential value can appear because the adapter never reads one.
    expect(JSON.stringify(input)).not.toContain('sk-live-')
    // And template parsing is the one shared grammar.
    expect(extractTemplateRefs(env.FILES_TOKEN!)).toEqual(['FILES_TOKEN'])
    expect(templatedStringsOf(def).some(([value]) => value === templateFor('FILES_TOKEN'))).toBe(true)
  })
})

describe('credentials diagnostics SEC-02 parity', () => {
  const badValue = 'token-with\r\n-injection'

  it('rejects CR/LF/NUL credential values by ref only and never echoes the value', async () => {
    await expect(
      resolveCredentialRefs(['TOKEN'], { resolve: async () => ({ value: badValue, source: 'test' }) }),
    ).rejects.toMatchObject({ name: 'HostConfigError', code: 'invalid-ref' })
    let message = ''
    try {
      await resolveCredentialRefs(['TOKEN'], { resolve: async () => ({ value: badValue, source: 'test' }) })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('TOKEN')
    expect(message).not.toContain(badValue)
    // A missing ref is refused the same way.
    await expect(
      resolveCredentialRefs(['MISSING'], { resolve: async () => undefined }),
    ).rejects.toThrow(/is not configured/)
  })

  it('rejects a rotated bad value on the next resolution (no preflight TOCTOU cache)', async () => {
    let calls = 0
    const provider = {
      resolve: async () => {
        calls += 1
        return calls === 1 ? { value: 'good-value', source: 'test' } : { value: badValue, source: 'test' }
      },
    }
    const first = await resolveCredentialRefs(['TOKEN'], provider)
    expect(first.get('TOKEN')).toBe('good-value')
    await expect(resolveCredentialRefs(['TOKEN'], provider)).rejects.toMatchObject({ code: 'invalid-ref' })
    expect(calls).toBe(2)
  })

  it('bounds the credential-ref grammar the document and the adapter share', () => {
    expect(() => credentialRefsInDefinition(stdio({ envKeys: ['1BAD'] }))).toThrow(HostConfigError)
    expect(() => templateFor('1BAD')).toThrow(HostConfigError)
    expect(templateFor('TOKEN')).toBe('${credential:TOKEN}')
  })
})

describe('ONE credential-template value space (model <-> host adapter parity)', () => {
  /**
   * Representative rows covering EVERY templated field and both container
   * forms: stdio command/args/cwd/env map + legacy envKeys, and http url/header
   * map + legacy {name,ref} header rows.
   */
  const rows: ServerDef[] = [
    {
      serverName: 'stdio-modern',
      transport: 'stdio',
      command: '/usr/bin/' + templateFor('CMD_TOKEN'),
      args: ['--flag', templateFor('ARG_TOKEN')],
      cwd: templateFor('CWD_TOKEN'),
      env: { TOKEN: templateFor('ENV_TOKEN'), PLAIN: 'plain-value' },
    },
    {
      serverName: 'stdio-legacy',
      transport: 'stdio',
      command: 'node',
      envKeys: ['LEGACY_A', 'LEGACY_B'],
    },
    {
      serverName: 'http-modern',
      transport: 'streamable-http',
      url: 'https://x/' + templateFor('URL_TOKEN'),
      headers: { Authorization: 'Bearer ' + templateFor('HDR_TOKEN') },
    },
    {
      serverName: 'http-legacy',
      transport: 'streamable-http',
      url: 'https://x',
      headers: [{ name: 'Authorization', ref: 'HDR_ROW' }],
    },
    {
      // Non-canonical drift probe: BOTH containers on one row. The adapter (and
      // so the browser walker) must agree that the map wins and the legacy list
      // is ignored — the old walkers disagreed here (the latent drift).
      serverName: 'stdio-both',
      transport: 'stdio',
      command: 'node',
      env: { KEPT: templateFor('MAP_REF') },
      envKeys: ['IGNORED_REF'],
    },
  ]

  it('enumerates every templated field identically from both entry points', () => {
    for (const def of rows) {
      // model.ts re-exports the shared walker under the document-model names.
      const modelValues = templatedValuesOf(def).map(({ field, value }) => ({ field, value }))
      const hostValues = templatedStringsOf(def).map(([value, field]) => ({ field, value }))
      expect(hostValues, def.serverName).toEqual(modelValues)
    }
  })

  it('derives identical refs and identical expansion from both entry points', () => {
    for (const def of rows) {
      const modelRefs = credentialRefsOf(def)
      const hostRefs = [...new Set(templatedStringsOf(def).flatMap(([value]) => extractTemplateRefs(value)))]
      expect(hostRefs, def.serverName).toEqual(modelRefs)
      // The adapter's own pre-mount ref set (upstream.ts) reads the same walk.
      expect([...credentialRefsInDefinition(def)], def.serverName).toEqual(modelRefs)
      // Expansion detection: model-side (over the shared value space) == the
      // host wrapper == "a token exists in the emitted refs".
      const modelExpanded = templatedValuesOf(def).some(({ value }) => hasCredentialTemplate(value))
      expect(expandTemplatesFor(def), def.serverName).toBe(modelExpanded)
      expect(expandTemplatesFor(def), def.serverName).toBe(credentialRefsInDefinition(def).size > 0)
    }
  })

  it('never counts the ignored legacy container from either side', () => {
    const drift = rows.find((def) => def.serverName === 'stdio-both') as StdioServerDef
    expect(credentialRefsOf(drift)).toEqual(['MAP_REF'])
    expect([...credentialRefsInDefinition(drift)]).toEqual(['MAP_REF'])
    expect(expandTemplatesFor(drift)).toBe(true)
    // Same row without a token in the EMITTED space: neither side may let the
    // ignored envKeys list turn expansion on or invent a ref.
    const noToken: StdioServerDef = { ...drift, env: { KEPT: 'plain' } }
    expect(expandTemplatesFor(noToken)).toBe(false)
    expect(credentialRefsOf(noToken)).toEqual([])
    expect([...credentialRefsInDefinition(noToken)]).toEqual([])
  })
})
