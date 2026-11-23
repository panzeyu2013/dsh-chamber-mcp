/**
 * The `mcp-scope` settings document after the 0.1.7 migration: it IS the
 * plugin's own Loader-entry Config — a profile-patch row
 * (`{ id: 'mcp-scope', name: 'dsh-chamber-mcp', config: … }`) — and every
 * field is volatile, so a form write commits into the running fiber's
 * references in place.
 *
 * These tests pin what this plugin owns: the schema resolves the legacy
 * `mcp-scope` section shape (what `SettingsForms` imports once from the old
 * `settings.yaml`) into the same canonical document, the resolved fields are
 * live references read per operation, malformed input is refused by the
 * schema, `readDocument` still yields a manager-safe document when a
 * hand-edited profile patch carries rows the schema shape admits but the
 * manager must not trust, and the entry id the browser form
 * (`ctx.configForms.get('mcp-scope')`) and the legacy import both address is
 * exactly `mcp-scope`.
 *
 * The end-to-end write path (form edit → profile patch → in-place volatile
 * commit → `loader/volatile-update` → reconcile) is upstream's machinery and
 * is verified live against a real 0.2.x anchor by the M0 smoke
 * (scripts/smoke/m0.mjs); the entry-side event wiring is pinned in
 * tests/host/index.spec.ts.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, fieldValue, readDocument, type McpScopeConfig } from '../../src/schema.js'
import { canonicalDoc } from '../../src/shared/model.js'
import { MCP_SCOPE_NAMESPACE, type ServerDef } from '../../src/shared/model.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The exact section an old `settings.yaml` carried (imported once by the host). */
const LEGACY_SECTION = {
  servers: [
    {
      serverName: 'byhand',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '',
      envKeys: ['HAND_TOKEN'],
    },
  ],
  overrides: { 'ws-b': { byhand: true } },
}

/** The legacy server with the official defaults the schema materializes. */
const RESOLVED_SERVER: ServerDef = {
  serverName: 'byhand',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  cwd: '',
  envKeys: ['HAND_TOKEN'],
}

const resolveConfig = (input: unknown): McpScopeConfig =>
  (Config as unknown as (value: unknown) => McpScopeConfig)(input)

describe('mcp-scope Config (the entry document, every field volatile)', () => {
  it('resolves the legacy settings.yaml section into the canonical document', () => {
    const doc = readDocument(resolveConfig(LEGACY_SECTION))
    expect(doc.servers).toEqual([RESOLVED_SERVER])
    expect(doc.overrides).toEqual({ 'ws-b': { byhand: true } })
    expect(doc.disabled).toEqual({})
  })

  it('hands apply live volatile references, not startup snapshots', () => {
    const resolved = resolveConfig(LEGACY_SECTION)
    for (const field of [resolved.servers, resolved.overrides, resolved.disabled]) {
      expect(typeof (field as { get?: unknown }).get).toBe('function')
    }
    // readDocument reads whatever the reference holds at call time.
    let servers: readonly ServerDef[] = []
    const live: McpScopeConfig = {
      servers: { get: () => servers },
      overrides: { get: () => ({}) },
      disabled: { get: () => ({}) },
    }
    expect(readDocument(live).servers).toEqual([])
    servers = [RESOLVED_SERVER]
    expect(readDocument(live).servers).toEqual([RESOLVED_SERVER])
  })

  it('defaults every field on an empty Config (a fresh install has MCP off)', () => {
    const resolved = resolveConfig({})
    expect(readDocument(resolved)).toEqual({ servers: [], overrides: {}, disabled: {} })
    expect(fieldValue(resolved.servers)).toEqual([])
  })

  it('refuses documents the schema can check (shape and name/ref contracts)', () => {
    expect(() => resolveConfig({ servers: [{ serverName: 'bad name', transport: 'stdio', command: 'node' }] })).toThrow()
    expect(() => resolveConfig({ servers: [{ serverName: 'ok', transport: 'stdio' }] })).toThrow()
    expect(() => resolveConfig({ overrides: { ws: { ok: false } } })).toThrow()
  })

  it('canonicalizes rows a hand-edited profile patch can smuggle past the schema', () => {
    const config = {
      servers: [null, 3, RESOLVED_SERVER, { ...RESOLVED_SERVER, command: 'last-wins' }],
      overrides: 'nope',
      disabled: { keep: true, drop: 1 },
    } as unknown as McpScopeConfig
    const doc = readDocument(config)
    // Non-object rows are dropped; a duplicate serverName keeps the LAST
    // definition — the same one the supervisor ends up running (canonicalDoc).
    expect(doc.servers).toEqual([{ ...RESOLVED_SERVER, command: 'last-wins' }])
    expect(doc.overrides).toEqual({})
    expect(doc.disabled).toEqual({ keep: true })
  })

  it('decodes a legacy document (timeoutMs, envKeys, headers[].ref) without losing the timeout', () => {
    const doc = readDocument(
      resolveConfig({
        servers: [
          {
            serverName: 'legacy',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            envKeys: ['LEGACY_TOKEN'],
            timeoutMs: 5_000,
          },
          {
            serverName: 'http',
            transport: 'streamable-http',
            url: 'https://mcp.example/x',
            headers: [{ name: 'Authorization', ref: 'TOKEN' }],
            timeoutMs: 2_000,
          },
        ],
      }),
    )
    const stdio = doc.servers[0] as Extract<ServerDef, { transport: 'stdio' }> & { timeoutMs?: number }
    expect(stdio.toolCallTimeoutMs).toBe(5_000)
    expect(stdio.timeoutMs).toBeUndefined()
    expect(stdio.envKeys).toEqual(['LEGACY_TOKEN'])
    const http = doc.servers[1] as ServerDef & { timeoutMs?: number }
    expect(http.toolCallTimeoutMs).toBe(2_000)
    expect((http as unknown as { headers?: unknown }).headers).toEqual([{ name: 'Authorization', ref: 'TOKEN' }])
  })

  it('does not materialize defaults for the new fields (absent stays absent)', () => {
    const doc = readDocument(resolveConfig({ servers: [RESOLVED_SERVER] }))
    const row = doc.servers[0] as ServerDef & Record<string, unknown>
    for (const field of ['toolCallTimeoutMs', 'startupTimeoutMs', 'closeTimeoutMs', 'toolLoading', 'reconnect']) {
      expect(row[field], field + ' must stay absent').toBeUndefined()
    }
  })

  it('round-trips a document carrying all four exposed fields and the reconnect policy', () => {
    const input = {
      servers: [
        {
          serverName: 'tuned',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          toolCallTimeoutMs: 1_234,
          startupTimeoutMs: 2_500,
          closeTimeoutMs: 700,
          toolLoading: 'on-demand',
          reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 3 },
        },
      ],
    }
    const doc = readDocument(resolveConfig(input))
    const row = doc.servers[0] as ServerDef
    expect(row.toolCallTimeoutMs).toBe(1_234)
    expect(row.startupTimeoutMs).toBe(2_500)
    expect(row.closeTimeoutMs).toBe(700)
    expect(row.toolLoading).toBe('on-demand')
    expect(row.reconnect).toEqual({ enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 3 })
    // A second decode of the canonical document is a no-op (round-trip stable).
    expect(canonicalDoc(doc)).toEqual(doc)
  })

  it('refuses new-field values the schema can check', () => {
    expect(() => resolveConfig({ servers: [{ serverName: 'a', transport: 'stdio', command: 'node', toolLoading: 'sometimes' }] })).toThrow()
    expect(() => resolveConfig({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'node', reconnect: { initialDelayMs: 'soon' } }],
    })).toThrow()
    expect(() => resolveConfig({ servers: [{ serverName: 'a', transport: 'stdio', command: 'node', timeoutMs: 'later' }] })).toThrow()
  })

  it('pins the entry id the browser form and the legacy import both address', () => {
    expect(MCP_SCOPE_NAMESPACE).toBe('mcp-scope')
    const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^\s*-\s*id:\s*mcp-scope\s*$/m)
    expect(patch).toMatch(/^\s*name:\s*dsh-chamber-mcp\s*$/m)
  })
})
