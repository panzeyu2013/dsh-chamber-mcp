/**
 * Document-eval unit tests over the shared model (src/shared/model.ts) and
 * the workspace helper (src/workspace.ts).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DisabledServers,
  EMPTY_DOC,
  HASH_LENGTH,
  HASH_SUFFIX_PATTERN,
  MAX_PUBLIC_NAME_LENGTH,
  MAX_TIMER_DELAY_MS,
  MCP_TOOL_PREFIX,
  RECONNECT_DEFAULTS,
  RESERVED_OVERRIDE_KEYS,
  SERVER_DEFAULTS,
  TOOL_LOADING_MODES,
  canonicalDoc,
  credentialRefsIn,
  credentialRefsOf,
  hasCredentialTemplate,
  isEnabled,
  isServerDisabled,
  pruneDisabled,
  pruneEmptyOverrideRows,
  removeServerDisabled,
  removeServerOverrides,
  renameDisabledKey,
  setDisabledKey,
  setServerDisabled,
  templateFor,
  templatedValuesOf,
  validateDoc,
  type McpScopeDoc,
  type ServerDef,
  type WorkspaceOverrides,
} from '../../src/shared/model.js'
import { MAX_TIMER_DELAY_MS as UPSTREAM_MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { canonicalCwd, workspaceIdOf } from '../../src/workspace.js'

describe('canonicalDoc', () => {
  it('returns the frozen empty document for non-object input', () => {
    expect(canonicalDoc(undefined)).toEqual({ servers: [], overrides: {}, disabled: {} })
    expect(canonicalDoc('x')).toEqual({ servers: [], overrides: {}, disabled: {} })
    expect(canonicalDoc([1, 2])).toEqual({ servers: [], overrides: {}, disabled: {} })
    expect(canonicalDoc(EMPTY_DOC)).toEqual({ servers: [], overrides: {}, disabled: {} })
  })

  it('drops non-object server rows and keeps the LAST duplicate serverName', () => {
    const doc = canonicalDoc({
      servers: [
        { serverName: 'dup', transport: 'stdio', command: 'first' },
        null,
        'junk',
        { serverName: 'dup', transport: 'stdio', command: 'second' },
        { transport: 'stdio', command: 'nameless' },
      ],
    })
    expect(doc.servers.map((server) => (server as { command?: string }).command)).toEqual(['second', 'nameless'])
  })

  it('prunes empty/non-true enable rows and non-true disabled keys', () => {
    const doc = canonicalDoc({
      servers: [],
      overrides: { 'ws-a': { on: true, off: false }, 'ws-empty': {}, 'ws-bad': 'nope' },
      disabled: { off: true, stale: false },
    })
    expect(doc.overrides).toEqual({ 'ws-a': { on: true } })
    expect(doc.disabled).toEqual({ off: true })
  })

  it('keeps a __proto__ workspace/disabled key as an OWN property', () => {
    const overrides = pruneEmptyOverrideRows(JSON.parse('{"__proto__":{"a":true}}') as WorkspaceOverrides)
    expect(Object.hasOwn(overrides, '__proto__')).toBe(true)
    const doc = canonicalDoc({ servers: [], overrides, disabled: JSON.parse('{"__proto__":true}') })
    expect(Object.hasOwn(doc.disabled ?? {}, '__proto__')).toBe(true)
    expect(isServerDisabled(doc, '__proto__')).toBe(true)
  })
})

describe('isEnabled', () => {
  it('defaults off when no record exists (new servers and workspaces)', () => {
    expect(isEnabled({}, 'ws-a', 'files')).toBe(false)
    expect(isEnabled({ 'ws-other': { files: true } }, 'ws-a', 'files')).toBe(false)
    expect(isEnabled({ 'ws-a': {} }, 'ws-a', 'files')).toBe(false)
  })

  it('turns on only when overrides[w][s] has an own record', () => {
    expect(isEnabled({ 'ws-a': { files: true } }, 'ws-a', 'files')).toBe(true)
    // Another server in the same workspace stays off by default.
    expect(isEnabled({ 'ws-a': { files: true } }, 'ws-a', 'git')).toBe(false)
  })
})

describe('validateDoc', () => {
  it('accepts a valid mixed document', () => {
    const doc: McpScopeDoc = {
      servers: [
        {
          serverName: 'files',
          transport: 'stdio',
          command: '/usr/bin/mcp-files',
          args: ['/srv'],
          envKeys: ['FILES_TOKEN'],
        },
        {
          serverName: 'github',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/github',
          headers: [{ name: 'Authorization', ref: 'GITHUB_TOKEN' }],
        },
      ],
      overrides: { 'ws-b': { files: true } },
    }
    expect(validateDoc(doc)).toEqual([])
  })

  it('flags duplicate serverNames', () => {
    const errors = validateDoc({
      servers: [
        { serverName: 'dup', transport: 'stdio', command: 'a' },
        { serverName: 'dup', transport: 'stdio', command: 'b' },
      ],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/duplicate serverName/)
  })

  it('flags bad serverName patterns', () => {
    const errors = validateDoc({
      servers: [{ serverName: 'has space', transport: 'stdio', command: 'a' }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/name must match/)
  })

  it('flags empty stdio command and empty http url', () => {
    const errors = validateDoc({
      servers: [
        { serverName: 'a', transport: 'stdio', command: '' },
        { serverName: 'b', transport: 'streamable-http', url: '' },
      ],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/command is required/)
    expect(errors.join('; ')).toMatch(/url is required/)
  })

  it('flags duplicate env keys and invalid env refs', () => {
    const errors = validateDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', envKeys: ['TOKEN_A', 'TOKEN_A', '1BAD'] }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/env key "TOKEN_A" listed twice/)
    expect(errors.join('; ')).toMatch(/env key "1BAD"/)
  })

  it('accepts the four exposed fields within the upstream bounds', () => {
    const base = { serverName: 'a', transport: 'stdio' as const, command: 'x' }
    expect(validateDoc({ servers: [{ ...base, toolCallTimeoutMs: 1 }], overrides: {} })).toEqual([])
    expect(validateDoc({ servers: [{ ...base, toolCallTimeoutMs: MAX_TIMER_DELAY_MS }], overrides: {} })).toEqual([])
    expect(validateDoc({ servers: [{ ...base, startupTimeoutMs: 30_000, closeTimeoutMs: 5_000 }], overrides: {} })).toEqual([])
    for (const toolLoading of TOOL_LOADING_MODES) {
      expect(validateDoc({ servers: [{ ...base, toolLoading }], overrides: {} })).toEqual([])
    }
    expect(validateDoc({ servers: [{ ...base, reconnect: { enabled: false, maxAttempts: 2 } }], overrides: {} })).toEqual([])
    // The deprecated alias is still accepted (and translated on read).
    expect(validateDoc({ servers: [{ ...base, timeoutMs: 60_000 }], overrides: {} })).toEqual([])
  })

  it('refuses per-field values the mounted config would refuse', () => {
    const base = { serverName: 'a', transport: 'stdio' as const, command: 'x' }
    const errorsOf = (extra: Record<string, unknown>): string =>
      validateDoc({ servers: [{ ...base, ...extra } as never], overrides: {} }).join('; ')
    for (const bad of [0, -1, 1.5, MAX_TIMER_DELAY_MS + 1]) {
      expect(errorsOf({ toolCallTimeoutMs: bad })).toMatch(/toolCallTimeoutMs/)
    }
    expect(errorsOf({ startupTimeoutMs: 0 })).toMatch(/startupTimeoutMs/)
    expect(errorsOf({ closeTimeoutMs: 1.5 })).toMatch(/closeTimeoutMs/)
    expect(errorsOf({ timeoutMs: 0 })).toMatch(/timeoutMs/)
    expect(errorsOf({ toolLoading: 'sometimes' })).toMatch(/toolLoading must be one of/)
    expect(errorsOf({ reconnect: { notAnOption: true } })).toMatch(/not a reconnect option/)
    expect(errorsOf({ reconnect: { initialDelayMs: 0 } })).toMatch(/initialDelayMs/)
    expect(errorsOf({ reconnect: { initialDelayMs: 10_000, maxDelayMs: 500 } })).toMatch(/less than or equal/)
    expect(errorsOf({ reconnect: { maxAttempts: 0 } })).toMatch(/positive integer/)
    expect(errorsOf({ reconnect: 'nope' })).toMatch(/reconnect must be an object/)
  })

  it('refuses a malformed template in a ref-using server and allows literal braces without tokens', () => {
    // No credential token at all: a literal shell expression stays legal (the
    // documented deviation from the official manager's unconditional expansion).
    expect(validateDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: '/bin/mcp-\${HOME}' }],
      overrides: {},
    })).toEqual([])
    // One token forces expansion, so every other occurrence must be a token too.
    const trapped = validateDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: '/bin/mcp-\${HOME}', envKeys: ['TOKEN'] }],
      overrides: {},
    })
    expect(trapped.join('; ')).toMatch(/is not a template token/)
    expect(trapped.join('; ')).toMatch(/envKeys|command/)
    // A malformed occurrence in a server whose template mode is on is refused
    // with its field name.
    const badUrl = validateDoc({
      servers: [{
        serverName: 'b',
        transport: 'streamable-http',
        url: 'https://x/\${not-a-token}',
        headers: [{ name: 'Authorization', ref: 'TOKEN' }],
      }],
      overrides: {},
    })
    expect(badUrl.join('; ')).toMatch(/url contains/)
    // The trap walks the SAME value space the adapter emits, so an env/header
    // MAP value is covered too (it used to be a validation gap: the mount would
    // refuse it after save while validateDoc stayed silent).
    const envTrap = validateDoc({
      servers: [{
        serverName: 'c',
        transport: 'stdio',
        command: 'node',
        env: { LIT: '\${HOME}', TOKEN: '\${credential:TOKEN}' },
      }],
      overrides: {},
    })
    expect(envTrap.join('; ')).toMatch(/env\[LIT\] contains/)
  })

  it('flags duplicate header names and invalid header refs', () => {
    const errors = validateDoc({
      servers: [{
        serverName: 'a',
        transport: 'streamable-http',
        url: 'https://x',
        headers: [
          { name: 'X-Auth', ref: 'TOKEN' },
          { name: 'X-Auth', ref: 'OTHER' },
          { name: 'Y', ref: 'bad ref!' },
        ],
      }],
      overrides: {},
    })
    expect(errors.join('; ')).toMatch(/header "X-Auth" listed twice/)
    expect(errors.join('; ')).toMatch(/header ref "bad ref!"/)
  })
})

describe('removeServerOverrides', () => {
  it('removes the server from every row and prunes rows that become empty', () => {
    const overrides: WorkspaceOverrides = {
      'ws-a': { files: true, git: true },
      'ws-b': { files: true },
      'ws-c': { other: true },
    }
    const next = removeServerOverrides(overrides, 'files')
    expect(next).toEqual({
      'ws-a': { git: true },
      'ws-c': { other: true },
    })
    // Never mutates the input; rows for untouched servers survive.
    expect(overrides).toEqual({
      'ws-a': { files: true, git: true },
      'ws-b': { files: true },
      'ws-c': { other: true },
    })
  })

  it('returns the same object when nothing changed', () => {
    const overrides: WorkspaceOverrides = { 'ws-a': { git: true } }
    expect(removeServerOverrides(overrides, 'files')).toBe(overrides)
    const empty: WorkspaceOverrides = {}
    expect(removeServerOverrides(empty, 'files')).toBe(empty)
  })

  it('keeps a workspace literally named __proto__ as an OWN row', () => {
    // A plain next[workspaceId] = rest assignment would set the prototype and
    // silently drop the row, exactly like the F1 workspace-key discipline in
    // overrideDoc/pruneEmptyOverrideRows.
    const overrides = Object.fromEntries([
      ['__proto__', { files: true, git: true }],
      ['ws-a', { files: true }],
    ]) as WorkspaceOverrides
    const next = removeServerOverrides(overrides, 'files')
    expect(Object.hasOwn(next, '__proto__')).toBe(true)
    expect(Object.keys(next)).toEqual(['__proto__'])
    expect(next['__proto__']).toEqual({ git: true })
    expect(next['ws-a']).toBeUndefined()
  })
})

describe('credentialRefsOf', () => {
  it('collects legacy envKeys/header-row refs when the map forms are absent', () => {
    expect(credentialRefsOf({ serverName: 'a', transport: 'stdio', command: 'x', envKeys: ['A', 'B'] }))
      .toEqual(['A', 'B'])
    expect(credentialRefsOf({
      serverName: 'a',
      transport: 'streamable-http',
      url: 'https://x',
      headers: [{ name: 'X', ref: 'A' }, { name: 'Y', ref: 'B' }],
    })).toEqual(['A', 'B'])
  })

  it('reads the ONE adapter-emission value space in order', () => {
    const stdio: ServerDef = {
      serverName: 'a',
      transport: 'stdio',
      command: templateFor('CMD') + '/bin',
      args: ['-t', templateFor('ARG')],
      cwd: templateFor('CWD'),
      env: { TOKEN: templateFor('ENVREF') },
    }
    expect(credentialRefsOf(stdio)).toEqual(['CMD', 'ARG', 'CWD', 'ENVREF'])
    expect(templatedValuesOf(stdio).map((entry) => entry.field)).toEqual([
      'command',
      'args[0]',
      'args[1]',
      'cwd',
      'env[TOKEN]',
    ])
    const http: ServerDef = {
      serverName: 'b',
      transport: 'streamable-http',
      url: 'https://x/' + templateFor('URLREF'),
      headers: { Authorization: templateFor('HDR') },
    }
    expect(credentialRefsOf(http)).toEqual(['URLREF', 'HDR'])
    // Template parsing is the shared grammar, never a substring heuristic.
    expect(credentialRefsIn(templateFor('X') + templateFor('Y'))).toEqual(['X', 'Y'])
    expect(hasCredentialTemplate('\${HOME}')).toBe(false)
    expect(hasCredentialTemplate(templateFor('X'))).toBe(true)
  })

  it('lets the env/headers map win over a legacy container (no ghost refs)', () => {
    // Canonical documents never carry both (canonicalDoc drops the legacy
    // container when the map exists), but hand-edited/import input can: the
    // adapter IGNORES envKeys when env exists, so the ref/orphan walker must
    // read that same value space instead of reporting an ignored ref as used.
    const stdio: ServerDef = {
      serverName: 'a',
      transport: 'stdio',
      command: 'node',
      env: { TOKEN: templateFor('ENVREF') },
      envKeys: ['LEGACY_GHOST'],
    }
    expect(credentialRefsOf(stdio)).toEqual(['ENVREF'])
    // The EMITTED env token does enable expansion (so a literal command brace is
    // the usual trap), but the ignored container adds nothing to that decision.
    expect(validateDoc({
      servers: [{ ...stdio, command: '/bin/mcp-\${HOME}' }],
      overrides: {},
    }).join('; ')).toMatch(/command contains/)
    // With a token-free env map, the ignored envKeys list must not turn
    // expansion on: the literal brace stays legal.
    expect(validateDoc({
      servers: [{
        serverName: 'a',
        transport: 'stdio',
        command: '/bin/mcp-\${HOME}',
        env: { TOKEN: 'plain-value' },
        envKeys: ['LEGACY_GHOST'],
      }],
      overrides: {},
    })).toEqual([])
  })

  it('does not treat a literal \${NAME} as a credential ref', () => {
    expect(credentialRefsOf({ serverName: 'a', transport: 'stdio', command: '/bin/\${HOME}' })).toEqual([])
  })
})

describe('model defaults parity with the installed alpha.2 packages', () => {
  it('pins the single defaults table against the upstream constants', () => {
    expect(RECONNECT_DEFAULTS).toEqual({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })
    expect(MAX_TIMER_DELAY_MS).toBe(UPSTREAM_MAX_TIMER_DELAY_MS)
    // The tool-call deadline has exactly ONE exported name (the defaults table);
    // an extra TOOL_CALL_TIMEOUT_DEFAULT_MS duplicate used to shadow it.
    expect(SERVER_DEFAULTS.toolCallTimeoutMs).toBe(60_000)
    expect(SERVER_DEFAULTS.maxInstructionBytes).toBe(32_768)
    expect(SERVER_DEFAULTS.toolLoading).toBe('eager')
    expect(SERVER_DEFAULTS.catalogDescriptionMaxLength).toBe(160)
    expect(Object.isFrozen(RECONNECT_DEFAULTS)).toBe(true)
  })
})

describe('canonicalDoc read-compat rows', () => {
  it('translates a legacy timeoutMs to toolCallTimeoutMs, dropping the alias', () => {
    const doc = canonicalDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', timeoutMs: 5_000 }],
    })
    const row = doc.servers[0] as ServerDef & { timeoutMs?: number }
    expect(row.toolCallTimeoutMs).toBe(5_000)
    expect(row.timeoutMs).toBeUndefined()
  })

  it('prefers toolCallTimeoutMs when both names are present', () => {
    const doc = canonicalDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', timeoutMs: 5_000, toolCallTimeoutMs: 9_000 }],
    })
    expect((doc.servers[0] as ServerDef).toolCallTimeoutMs).toBe(9_000)
    expect((doc.servers[0] as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined()
  })

  it('is idempotent and keeps absent fields absent (no materialized defaults)', () => {
    const first = canonicalDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', envKeys: ['A'] }],
      overrides: { ws: { a: true } },
    })
    const second = canonicalDoc(first)
    expect(second).toEqual(first)
    const row = first.servers[0] as ServerDef
    expect(row.toolCallTimeoutMs).toBeUndefined()
    expect(row.startupTimeoutMs).toBeUndefined()
    expect(row.closeTimeoutMs).toBeUndefined()
    expect(row.reconnect).toBeUndefined()
    expect(row.toolLoading).toBeUndefined()
    expect((row as Extract<ServerDef, { transport: 'stdio' }>).envKeys).toEqual(['A'])
  })

  it('keeps an unrecognized transport row for validateDoc to report', () => {
    const doc = canonicalDoc({
      servers: [{ serverName: 'typo', transport: 'stdioo', command: 'x' }],
    })
    expect(doc.servers).toHaveLength(1)
    expect(validateDoc(doc).join('; ')).toMatch(/transport must be "stdio" or "streamable-http"/)
  })
})

const off = (...names: string[]): DisabledServers => {
  const map: DisabledServers = {}
  for (const name of names) map[name] = true
  return map
}

describe('global off-switches (disabled map)', () => {
  it('defaults on and judges strictly by own `true` entries', () => {
    const doc: McpScopeDoc = { servers: [], overrides: {} }
    expect(isServerDisabled(doc, 'a')).toBe(false)
    expect(isServerDisabled({ ...doc, disabled: off('a') }, 'a')).toBe(true)
    expect(isServerDisabled({ ...doc, disabled: off() }, 'a')).toBe(false)
    // Prototype-member names must not read as disabled through inheritance.
    expect(isServerDisabled({ ...doc, disabled: off() }, 'toString')).toBe(false)
    expect(isServerDisabled({ ...doc, disabled: off('valueOf') }, 'valueOf')).toBe(true)
  })

  it('prunes malformed entries and is immutable', () => {
    const raw = { a: true, b: false, c: 'x' } as unknown as Record<string, true>
    expect(pruneDisabled(raw)).toEqual({ a: true })
    const original: DisabledServers = { a: true }
    const next = setDisabledKey(original, 'b', true)
    expect(next).toEqual({ a: true, b: true })
    expect(original).toEqual({ a: true })
    // No-op paths return the same reference.
    expect(setDisabledKey(original, 'a', true)).toBe(original)
    expect(setDisabledKey(original, 'b', false)).toBe(original)
  })

  it('setServerDisabled returns the same doc reference when nothing changes', () => {
    const doc: McpScopeDoc = { servers: [], overrides: {} }
    expect(setServerDisabled(doc, 'a', false)).toBe(doc)
    const off = setServerDisabled(doc, 'a', true)
    expect(off.disabled).toEqual({ a: true })
    expect(setServerDisabled(off, 'a', false).disabled).toEqual({})
  })

  it('removeServerDisabled and renameDisabledKey carry or drop one key', () => {
    expect(removeServerDisabled({ a: true, b: true }, 'a')).toEqual({ b: true })
    expect(removeServerDisabled(undefined, 'a')).toEqual({})
    expect(renameDisabledKey({ old: true, keep: true }, 'old', 'new')).toEqual({ new: true, keep: true })
    expect(renameDisabledKey({ old: true }, 'old', 'old')).toEqual({ old: true })
    expect(renameDisabledKey({ keep: true }, 'missing', 'x')).toEqual({ keep: true })
  })
})

describe('shared naming constants (host + browser half)', () => {
  // These four values are the contract BOTH halves derive tool identity from:
  // the mounted official instance mints public names with them and the browser half
  // parses them back (src/client/tool-card/names.ts). They live in the shared
  // pure model precisely so the browser half never imports host code.
  it('pins the official contract values', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__')
    expect(MAX_PUBLIC_NAME_LENGTH).toBe(64)
    expect(HASH_LENGTH).toBe(12)
  })

  it('recognizes exactly one identity suffix shape', () => {
    expect(HASH_SUFFIX_PATTERN.test(`${'x'.repeat(50)}_0123456789ab`)).toBe(true)
    expect(HASH_SUFFIX_PATTERN.test(`${'x'.repeat(51)}_0123456789a`)).toBe(false) // 11 hex
    expect(HASH_SUFFIX_PATTERN.test(`${'x'.repeat(50)}_0123456789abc`)).toBe(false) // 13 hex
    expect(HASH_SUFFIX_PATTERN.test(`${'x'.repeat(50)}_0123456789AG`)).toBe(false) // not hex
    // No /g flag: repeated .test() calls must not carry lastIndex state.
    expect(HASH_SUFFIX_PATTERN.test(`${'x'.repeat(50)}_0123456789ab`)).toBe(true)
  })
})

describe('own-property override semantics (pre-release F1)', () => {
  const row = (...names: string[]): Record<string, true> => {
    const out: Record<string, true> = {}
    for (const name of names) out[name] = true
    return out
  }
  it('a serverName colliding with an Object.prototype member stays default-off until its own row exists', () => {
    expect(isEnabled({}, 'ws-a', 'toString')).toBe(false)
    expect(isEnabled({ 'ws-other': row('toString') }, 'ws-a', 'toString')).toBe(false)
    // Own record present => on; another member of the same row is unaffected.
    expect(isEnabled({ 'ws-a': row('toString') }, 'ws-a', 'toString')).toBe(true)
    expect(isEnabled({ 'ws-a': row('toString') }, 'ws-a', 'valueOf')).toBe(false)
    // valueOf must not read the inherited member either.
    expect(isEnabled({ 'ws-a': row('valueOf') }, 'ws-a', 'valueOf')).toBe(true)
    expect(isEnabled({ 'ws-a': row() }, 'ws-a', 'toString')).toBe(false)
  })
})

describe('workspace helpers', () => {
  it('EMPTY_DOC is a frozen empty document', () => {
    expect(EMPTY_DOC.servers).toEqual([])
    expect(EMPTY_DOC.overrides).toEqual({})
    expect(EMPTY_DOC.disabled).toEqual({})
    expect(Object.isFrozen(EMPTY_DOC)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOC.servers)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOC.overrides)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOC.disabled)).toBe(true)
  })

  it('validateDoc refuses reserved override-key serverNames', () => {
    for (const name of RESERVED_OVERRIDE_KEYS) {
      const doc: McpScopeDoc = { servers: [{ serverName: name, transport: 'stdio', command: 'x' }], overrides: {} }
      const errors = validateDoc(doc)
      expect(errors.join('\n')).toContain('reserved')
    }
  })

  it('canonicalCwd tolerates missing/empty cwd and unreadable paths', () => {
    expect(canonicalCwd(undefined)).toBeUndefined()
    expect(canonicalCwd('')).toBeUndefined()
    expect(canonicalCwd('/definitely/not/a/real/path-xyz')).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ws-'))
    try {
      expect(canonicalCwd(dir)).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches a session cwd to its workspace by canonical path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-ws-'))
    try {
      const wsA = join(root, 'a')
      const wsB = join(root, 'b')
      mkdirSync(wsA)
      mkdirSync(wsB)
      const workspaces = [
        { id: 'ws-b', path: realpathSync(wsB) },
        { id: 'ws-a', path: realpathSync(wsA) },
      ]
      expect(workspaceIdOf(wsA, workspaces)).toBe('ws-a')
      expect(workspaceIdOf(join(wsB, '..', 'b'), workspaces)).toBe('ws-b')
      // Non-member directory.
      expect(workspaceIdOf(root, workspaces)).toBeUndefined()
      // Unknown/missing path.
      expect(workspaceIdOf(join(root, 'missing'), workspaces)).toBeUndefined()
      expect(workspaceIdOf(undefined, workspaces)).toBeUndefined()
      // Symlinked spellings resolve through realpath.
      const link = join(root, 'link-a')
      symlinkSync(wsA, link)
      expect(workspaceIdOf(link, workspaces)).toBe('ws-a')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('workspaceIdOf honors an injected realpath (deterministic error path)', () => {
    const workspaces = [{ id: 'ws-a', path: '/canon/a' }]
    expect(workspaceIdOf('/alias/a', workspaces, () => '/canon/a')).toBe('ws-a')
    expect(workspaceIdOf('/alias/a', workspaces, () => { throw new Error('gone') })).toBeUndefined()
  })
})

describe('validateDoc oauth/header/reconnect branches', () => {
  it('validates the oauth block, the header map names and reconnect.enabled', () => {
    const base = { serverName: 'g', transport: 'streamable-http' as const, url: 'https://x' }
    expect(validateDoc({ servers: [{ ...base, oauth: { clientId: 'client', scope: 'read' } }], overrides: {} })).toEqual([])
    const errorsOf = (row: Record<string, unknown>): string =>
      validateDoc({ servers: [{ ...base, ...row } as never], overrides: {} }).join('; ')
    expect(errorsOf({ oauth: 'nope' })).toMatch(/oauth must be an object/)
    expect(errorsOf({ oauth: { clientId: '' } })).toMatch(/oauth.clientId must be a non-empty string/)
    expect(errorsOf({ oauth: { scope: 7 } })).toMatch(/oauth.scope must be a string/)
    expect(errorsOf({ oauth: { requestTimeoutMs: 0 } })).toMatch(/oauth.requestTimeoutMs/)
    expect(errorsOf({ oauth: { authorizationTimeoutMs: -1 } })).toMatch(/oauth.authorizationTimeoutMs/)
    // Header MAP form: keys must be legal HTTP field names (the transport refuses them).
    expect(errorsOf({ headers: { Authorization: 'x' } })).toEqual('')
    expect(errorsOf({ headers: { 'bad header': 'x' } })).toMatch(/not a valid HTTP field name/)
    // reconnect.enabled must be a boolean when present.
    expect(validateDoc({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'x', reconnect: { enabled: 'yes' } } as never],
      overrides: {},
    }).join('; ')).toMatch(/reconnect.enabled must be a boolean/)
  })

  it('keeps the OAuth credential-key grammar host-valid', () => {
    expect(validateDoc({
      servers: [{
        serverName: 'g',
        transport: 'streamable-http',
        url: 'https://x',
        oauth: { credentialKey: 'mcp-client/mcp-scope-abc123' },
      }],
      overrides: {},
    })).toEqual([])
    expect(validateDoc({
      servers: [{
        serverName: 'g',
        transport: 'streamable-http',
        url: 'https://x',
        oauth: { credentialKey: 'Bad Key' },
      }],
      overrides: {},
    }).join('; ')).toMatch(/oauth.credentialKey must match/)
  })
})
