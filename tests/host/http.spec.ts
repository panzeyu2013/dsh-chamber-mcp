/**
 * Real Streamable HTTP MCP end-to-end coverage.
 *
 * The fixture is a real Node HTTP server around the official createMcpHandler
 * + McpServer. It records transport headers and can require/reject a bearer
 * token, so the client, the supervisor and the manager's probe path are all
 * exercised over the wire rather than through a fake fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/client'
import { createTransport, type CredentialResolver } from '../../src/transport.ts'
import { probeServer, startServerSupervisor, type ServerHandle } from '../../src/server.ts'
import type { ServerDef } from '../../src/shared/model.ts'
import { startHttpMcpFixture, type HttpFixture } from '../support/http-fixture.ts'

const TOKEN = 'fixture-token'
const resolver =
  (value: string): CredentialResolver =>
  async (ref) => (String(ref) === 'TOKEN' ? { value, source: 'test' } : undefined)

const httpDef = (url: string, timeoutMs = 5_000): Extract<ServerDef, { transport: 'streamable-http' }> => ({
  serverName: 'http',
  transport: 'streamable-http',
  url,
  headers: [{ name: 'Authorization', ref: 'TOKEN' }],
  timeoutMs,
})

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fixture: HttpFixture
beforeAll(async () => {
  fixture = await startHttpMcpFixture({ auth: 'required', token: TOKEN })
})
afterAll(async () => {
  await fixture.close()
})

describe('streamable HTTP transport over a real MCP server', () => {
  it('connects, lists and calls a tool while carrying the resolved headers', async () => {
    const transport = await createTransport(httpDef(fixture.url), resolver('Bearer ' + TOKEN))
    const client = new Client(
      { name: 'http-spec', version: '0.0.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    try {
      await client.connect(transport)
      const list = await client.listTools(undefined, { cacheMode: 'refresh' })
      expect(list.tools.map((tool) => tool.name)).toEqual(['echo'])
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hello over http' } })
      expect(result.content).toEqual([{ type: 'text', text: 'hello over http' }])
    } finally {
      await client.close()
    }
    expect(fixture.requests.length).toBeGreaterThanOrEqual(3)
    for (const request of fixture.requests) {
      expect(request.authorization, request.method + ' ' + request.url).toBe('Bearer ' + TOKEN)
      expect(request.accept, request.method + ' ' + request.url).toContain('text/event-stream')
    }
  })

  it('fails the supervisor attempt when the bearer token is wrong', async () => {
    const transport = await createTransport(httpDef(fixture.url), resolver('Bearer wrong'))
    const client = new Client(
      { name: 'http-spec-bad', version: '0.0.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    await expect(client.connect(transport, { timeout: 3_000 })).rejects.toThrow(/401|unauthorized/i)
    await client.close().catch(() => {})
  })

  it('connects the real supervisor and syncs the real tool list', async () => {
    const ctx = new Context()
    const lines: string[] = []
    const handle: ServerHandle = startServerSupervisor({
      ctx,
      serverName: 'http',
      buildTransport: () => createTransport(httpDef(fixture.url), resolver('Bearer ' + TOKEN)),
      logger: {
        info: (message) => void lines.push(message),
        warn: (message) => void lines.push(message),
        error: (message) => void lines.push(message),
      },
      onDefsChanged: () => {},
      reconnect: { enabled: false },
    })
    try {
      await waitFor(() => handle.snapshot().phase === 'connected', 'HTTP supervisor connected')
      expect(handle.snapshot().toolCount).toBe(1)
      expect(handle.tools().map((tool) => tool.publicName)).toEqual(['mcp__http__echo'])
      expect(handle.context.instructions()).toBe('')
    } finally {
      await handle.dispose()
    }
  })

  it('reports a 401/403 probe failure as forbidden and a refused connection as connection-failed', async () => {
    const ctx = new Context()
    const bad = await probeServer({
      ctx,
      serverName: 'http',
      buildTransport: () => createTransport(httpDef(fixture.url), resolver('Bearer wrong')),
      toolCallTimeoutMs: 3_000,
    })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('(HTTP 401)')

    const forbidden = await startHttpMcpFixture({ auth: 'forbid' })
    try {
      const denied = await probeServer({
        ctx,
        serverName: 'http',
        buildTransport: () => createTransport(httpDef(forbidden.url), resolver('Bearer ' + TOKEN)),
        toolCallTimeoutMs: 3_000,
      })
      expect(denied.ok).toBe(false)
      expect(denied.error).toContain('(HTTP 403)')
    } finally {
      await forbidden.close()
    }

    const refused = await probeServer({
      ctx,
      serverName: 'http',
      buildTransport: () => createTransport(httpDef('http://127.0.0.1:1/mcp', 1_500), resolver('Bearer ' + TOKEN)),
      toolCallTimeoutMs: 1_500,
    })
    expect(refused.ok).toBe(false)
    expect(refused.error).toBeTruthy()
  })

  it('keeps the manager probe code mapping for 401/403 and refused connections', async () => {
    const { createManager } = await import('../../src/manager.ts')
    const run = async (url: string, token: string): Promise<unknown> => {
      const ctx = new Context()
      ctx.provide('agents', { roots: () => [], list: () => [], get: () => undefined } as never)
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      let manager: ReturnType<typeof createManager> | undefined
      const host = function managerHost(c: Context) {
        manager = createManager({
          ctx: c,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          getDoc: () => ({ servers: [httpDef(url)], overrides: {} }),
          credentials: { resolve: resolver('Bearer ' + token) },
        })
      }
      host.inject = ['agents', 'workspaceRegistry']
      await ctx.plugin(host)
      try {
        return await manager!.test('http')
      } finally {
        await manager!.dispose()
      }
    }

    await expect(run(fixture.url, TOKEN)).resolves.toMatchObject({ ok: true, toolCount: 1 })
    await expect(run(fixture.url, 'wrong')).resolves.toMatchObject({ ok: false, code: 'forbidden' })
    await expect(run('http://127.0.0.1:1/mcp', TOKEN)).resolves.toMatchObject({
      ok: false,
      code: 'connection-failed',
    })
  })
})
