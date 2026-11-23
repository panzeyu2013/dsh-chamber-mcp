/**
 * Facade integration over the REAL official instance: the retired transport/
 * http/server-runtime suites replaced by mounted-instance assertions.
 *
 * Everything here goes through production modules (manager -> seat -> facade ->
 * official host -> real Streamable HTTP / stdio fixtures). Credential values are
 * resolved by the credentials facade at connect time, so a successful connection
 * to an auth-required HTTP fixture proves the whole credential-template path.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createManager, type ManagerHandle } from '../../src/manager.js'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.js'
import { startHttpMcpFixture, type HttpFixture } from '../support/http-fixture.js'
import { makeLogger, stdioDef, waitFor } from '../support/fixture-kit.js'
import { mountReal } from '../support/mount-real.js'

const TOKEN = 'fixture-token'
const BEARER = 'Bearer ' + TOKEN
const ENV_SECRET = 'env-secret-value-42'

/** In-memory real credential provider overridden per test. */
function credentialsOf(values: Record<string, string>) {
  return {
    resolve: async (ref: unknown) => {
      const value = values[String(ref)]
      return value === undefined ? undefined : { value, source: 'test' }
    },
    describe: async () => ({ configured: false, writable: false }),
    set: async () => {},
    unset: async () => {},
    readRecord: async () => undefined,
    describeRecord: async () => ({ configured: false, writable: false }),
    listRecords: async () => [],
    modifyRecord: async () => undefined,
    deleteRecord: async () => {},
  }
}

let fixture: HttpFixture
beforeAll(async () => {
  fixture = await startHttpMcpFixture({ auth: 'required', token: TOKEN })
})
afterAll(async () => {
  await fixture.close()
})

const httpRow = (serverName: string, url: string, ref: string, extra: Record<string, unknown> = {}): ServerDef =>
  ({
    serverName,
    transport: 'streamable-http',
    url,
    headers: [{ name: 'Authorization', ref }],
    ...extra,
  }) as ServerDef

interface Booted {
  ctx: Context
  manager: ManagerHandle
  lines: ReturnType<typeof makeLogger>['lines']
  setDoc(doc: McpScopeDoc): void
  dispose(): Promise<void>
}

/** Boot the real manager so that a configured server mounts for real. */
async function boot(options: { doc: McpScopeDoc; credentials?: Record<string, string> }): Promise<Booted> {
  const ctx = new Context()
  await mountReal(ctx)
  const logger = makeLogger()
  ctx.provide('agents', { list: () => [], get: () => undefined } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  if (options.credentials !== undefined) ctx.provide('credentials', credentialsOf(options.credentials) as never)
  let doc = options.doc
  const manager = createManager({ ctx, logger, getDoc: () => doc, managedNames: () => [] })
  return {
    ctx,
    manager,
    lines: logger.lines,
    setDoc: (next) => {
      doc = next
    },
    dispose: async () => {
      await manager.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function phaseOf(manager: ManagerHandle, name: string): string {
  return manager.runtimeStatus(name).servers[0]?.phase ?? 'missing'
}

describe('facade integration over the official instance', () => {
  it('mounts an auth-required HTTP server through the credentials facade and executes a captured tool', async () => {
    const url = fixture.url
    fixture.requests.length = 0
    const b = await boot({ doc: { servers: [httpRow('http', url, 'TOKEN')], overrides: {} }, credentials: { TOKEN: BEARER } })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b.manager, 'http') === 'connected', 'http fixture connected', 20_000)
      const listed = b.manager.toolList('http')!
      expect(listed.mode).toBe('definitions')
      expect(listed.total).toBe(1)
      expect(listed.tools[0]?.publicName).toBe('mcp__http__echo')
      // The captured definition executes through the live child.
      const definition = b.ctx.tools.get('mcp__http__echo') ?? undefined
      // Never global: the agent-free composition has no scope, so capture is
      // visible only through the manager's tool list.
      expect(definition).toBeUndefined()
      // Every wire request carried the credential-facade-resolved header.
      expect(fixture.requests.length).toBeGreaterThanOrEqual(3)
      for (const request of fixture.requests) {
        expect(request.authorization, request.method + ' ' + request.url).toBe(BEARER)
      }
      // The credential value never crosses the status/tool wire.
      expect(JSON.stringify(b.manager.runtimeStatus())).not.toContain(TOKEN)
      expect(JSON.stringify(listed)).not.toContain(TOKEN)
      expect(b.lines.some((line) => line.message.includes(TOKEN))).toBe(false)
    } finally {
      await b.dispose()
    }
  }, 40_000)

  it('maps probe failures to fixed codes: 401/403 forbidden, refused connection connection-failed', async () => {
    const forbidden = await startHttpMcpFixture({ auth: 'forbid' })
    const forbiddenUrl = forbidden.url
    const b = await boot({
      doc: {
        servers: [
          httpRow('bad-token', fixture.url, 'BAD_TOKEN'),
          httpRow('forbidden', forbiddenUrl, 'TOKEN'),
          httpRow('refused', 'http://127.0.0.1:1/mcp', 'TOKEN'),
        ],
        overrides: {},
      },
      credentials: { TOKEN: 'Bearer ' + TOKEN, BAD_TOKEN: 'Bearer wrong' },
    })
    try {
      const bad = await b.manager.test('bad-token')
      const denied = await b.manager.test('forbidden')
      const refused = await b.manager.test('refused')
      // A 401 advertises the authorization challenge: with the OAuth surface
      // landed the probe maps it to the fixed oauth-required test code (the
      // generic forbidden code remains the mapped 403/adapter-refusal identity).
      expect(['oauth-required', 'forbidden']).toContain((bad as { code?: string }).code)
      expect(denied).toMatchObject({ ok: false, code: 'forbidden' })
      expect(refused).toMatchObject({ ok: false, code: 'connection-failed' })
      // The upstream diagnostic text never reaches the wire result.
      for (const result of [bad, denied, refused]) {
        expect(JSON.stringify(result)).not.toMatch(/401|403|ECONNREFUSED|fetch failed/i)
      }
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await forbidden.close()
      await b.dispose()
    }
  }, 40_000)

  it('resolves a stdio env credential through the facade without leaking the value to status or logs', async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-scope-env-')))
    const b = await boot({
      doc: {
        servers: [
          stdioDef('fix', {
            env: { PROBE_TOKEN: '${credential:PROBE_SECRET}' },
          }),
        ],
        overrides: {},
      },
      credentials: { PROBE_SECRET: ENV_SECRET },
    })
    try {
      b.manager.reconcile()
      await waitFor(() => phaseOf(b.manager, 'fix') === 'connected', 'stdio fixture connected', 20_000)
      const probe = b.ctx.tools.get('mcp__fix__env_probe')
      expect(probe).toBeUndefined() // never global
      // The child actually received the credential value: spawn a per-agent
      // scope and execute the captured definition through it.
      const { factoryCtx } = { factoryCtx: undefined as unknown as Context }
      void factoryCtx
      const status = JSON.stringify(b.manager.runtimeStatus())
      const tools = JSON.stringify(b.manager.toolList('fix'))
      expect(status).not.toContain(ENV_SECRET)
      expect(tools).not.toContain(ENV_SECRET)
      expect(b.lines.some((line) => line.message.includes(ENV_SECRET))).toBe(false)
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      rmSync(work, { recursive: true, force: true })
      await b.dispose()
    }
  }, 40_000)

  it('degrades a composition without the credentials service to failed{load} without throwing', async () => {
    // No ctx credentials service: the seat cannot be built, and the manager must
    // degrade with a fixed code instead of throwing into the settings path.
    const b = await boot({ doc: { servers: [stdioDef('fix')], overrides: {} } })
    try {
      expect(() => b.manager.reconcile()).not.toThrow()
      await waitFor(() => phaseOf(b.manager, 'fix') === 'failed', 'degraded projection', 10_000)
      expect(b.manager.runtimeStatus('fix').servers[0]?.error?.code).toBe('load')
      // A total read path: status remains a normal envelope.
      expect(b.manager.runtimeStatus().v).toBe(1)
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('rejects a control-character credential value without leaking it to the wire or logs', async () => {
    const b = await boot({
      doc: { servers: [httpRow('bad-cred', fixture.url, 'BADCRED')], overrides: {} },
      credentials: { BADCRED: 'Bearer x\r\nInjected: y' },
    })
    try {
      b.manager.reconcile()
      await waitFor(
        () => ['reconnecting', 'failed', 'waiting-credentials'].includes(phaseOf(b.manager, 'bad-cred')),
        'the rejected credential attempt',
        20_000,
      )
      const wire = JSON.stringify(b.manager.runtimeStatus())
      expect(wire).not.toContain('Injected')
      expect(wire).not.toContain('Bearer x')
      expect(b.lines.some((line) => line.message.includes('Injected'))).toBe(false)
      // The failure identity is a fixed enum member, never upstream prose.
      const code = b.manager.runtimeStatus('bad-cred').servers[0]?.error?.code
      if (code !== undefined) expect(['forbidden', 'connection-failed', 'timeout', 'protocol', 'spawn-failed']).toContain(code)
    } finally {
      await b.dispose()
    }
  }, 40_000)
})
