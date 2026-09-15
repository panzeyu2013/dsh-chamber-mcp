/**
 * Runtime-route tests (src/routes.ts): the three Connection fetch routes are
 * registered on the shared carrier when `ctx.connection` exists, and every
 * handler folds business failures into the JSON envelope with an HTTP status
 * instead of throwing into the carrier.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RuntimeActionError, type ManagerHandle } from '../../src/manager.js'
import {
  MCP_SCOPE_ACTION_PATH,
  MCP_SCOPE_STATUS_PATH,
  MCP_SCOPE_TOOLS_PATH,
  registerMcpScopeRoutes,
} from '../../src/routes.js'

interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

function fakeManager(patch: Partial<ManagerHandle> = {}): ManagerHandle {
  return {
    reconcile: () => {},
    dispose: async () => {},
    runtimeStatus: () => ({ v: 1 as const, at: 42, servers: [] }),
    toolList: () => undefined,
    connect: async (name: string) => ({ name, state: 'connecting' as const }),
    disconnect: async (name: string) => ({ name, state: 'stopped' as const }),
    test: async () => ({ ok: true, toolCount: 3 }),
    ...patch,
  }
}

async function mount(manager: ManagerHandle): Promise<Map<string, RegisteredRoute>> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register: (route: RegisteredRoute) => {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  } as never)
  registerMcpScopeRoutes(ctx, manager)
  await flush()
  return routes
}

const get = (route: RegisteredRoute | undefined, url: string): Promise<Response> => {
  if (route === undefined) throw new Error('route not registered')
  return route.fetch(new Request(url))
}

const post = (route: RegisteredRoute | undefined, url: string, body: unknown): Promise<Response> => {
  if (route === undefined) throw new Error('route not registered')
  const init: RequestInit =
    body === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  return route.fetch(new Request(url, init))
}

describe('mcp-scope runtime routes', () => {
  it('registers exactly the three routes on the connection carrier', async () => {
    const routes = await mount(fakeManager())
    expect([...routes.keys()].sort()).toEqual(
      [MCP_SCOPE_STATUS_PATH, MCP_SCOPE_ACTION_PATH, MCP_SCOPE_TOOLS_PATH].sort(),
    )
    expect(routes.get(MCP_SCOPE_STATUS_PATH)?.methods).toEqual(['GET'])
    expect(routes.get(MCP_SCOPE_ACTION_PATH)?.methods).toEqual(['POST'])
    expect(routes.get(MCP_SCOPE_TOOLS_PATH)?.methods).toEqual(['GET'])
    expect(routes.get(MCP_SCOPE_STATUS_PATH)?.requestBody).toBe('buffered')
  })

  it('serves the versioned runtime status envelope with no-store', async () => {
    const routes = await mount(
      fakeManager({
        runtimeStatus: () => ({
          v: 1 as const,
          at: 7,
          servers: [
            { name: 'github', state: 'connected', attempts: 0, maxAttempts: 10, toolCount: 4 },
          ],
        }),
      }),
    )
    const response = await get(routes.get(MCP_SCOPE_STATUS_PATH), 'http://local' + MCP_SCOPE_STATUS_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      value: {
        v: 1,
        at: 7,
        servers: [{ name: 'github', state: 'connected', attempts: 0, maxAttempts: 10, toolCount: 4 }],
      },
    })
  })

  it('drives connect/disconnect/test and returns their values', async () => {
    const calls: string[] = []
    const routes = await mount(
      fakeManager({
        connect: async (name) => {
          calls.push('connect:' + name)
          return { name, state: 'connecting' }
        },
        disconnect: async (name) => {
          calls.push('disconnect:' + name)
          return { name, state: 'stopped' }
        },
        test: async (name) => {
          calls.push('test:' + name)
          return { ok: true, toolCount: 9 }
        },
      }),
    )
    const url = 'http://local' + MCP_SCOPE_ACTION_PATH
    expect(await (await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'connect', server: 'x' })).json())
      .toEqual({ ok: true, value: { name: 'x', state: 'connecting' } })
    expect(await (await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'disconnect', server: 'x' })).json())
      .toEqual({ ok: true, value: { name: 'x', state: 'stopped' } })
    expect(await (await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'test', server: 'x' })).json())
      .toEqual({ ok: true, value: { ok: true, toolCount: 9 } })
    expect(calls).toEqual(['connect:x', 'disconnect:x', 'test:x'])
  })

  it('rejects malformed action bodies with 400 and the business envelope', async () => {
    const routes = await mount(fakeManager())
    const route = routes.get(MCP_SCOPE_ACTION_PATH)
    const url = 'http://local' + MCP_SCOPE_ACTION_PATH
    for (const body of [{ action: 'nope', server: 'x' }, { action: 'connect' }, { server: 'x' }, {}]) {
      const response = await post(route, url, body)
      expect(response.status).toBe(400)
      expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    const invalid = await post(route, url, undefined)
    expect(invalid.status).toBe(400)
  })

  it('rejects server names outside the contract without echoing them', async () => {
    const routes = await mount(fakeManager())
    const url = 'http://local' + MCP_SCOPE_ACTION_PATH
    const long = 'x'.repeat(2_000)
    for (const server of [long, 'has space', '', 'a'.repeat(33)]) {
      const response = await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'connect', server })
      expect(response.status).toBe(400)
      const body = JSON.stringify(await response.json())
      if (server !== '') expect(body).not.toContain(server)
    }
    const toolsBad = await get(
      routes.get(MCP_SCOPE_TOOLS_PATH),
      'http://local' + MCP_SCOPE_TOOLS_PATH + '?server=' + encodeURIComponent(long),
    )
    expect(toolsBad.status).toBe(400)
    expect(JSON.stringify(await toolsBad.json())).not.toContain(long)
  })

  it('maps action business failures onto codes and statuses', async () => {
    const routes = await mount(
      fakeManager({
        connect: async () => {
          throw new RuntimeActionError('not-found', 'server "x" is not configured')
        },
        test: async () => {
          throw new Error('boom')
        },
      }),
    )
    const url = 'http://local' + MCP_SCOPE_ACTION_PATH
    const missing = await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'connect', server: 'x' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'server "x" is not configured' },
    })
    const internal = await post(routes.get(MCP_SCOPE_ACTION_PATH), url, { action: 'test', server: 'x' })
    expect(internal.status).toBe(500)
    expect(((await internal.json()) as { error: { code: string } }).error.code).toBe('internal')
  })

  it('serves tool identity, distinguishing not-connected from not-found', async () => {
    const routes = await mount(
      fakeManager({
        toolList: (name: string) => {
          if (name === 'ghost') throw new RuntimeActionError('not-found', 'server "ghost" is not configured')
          return undefined
        },
      }),
    )
    const route = routes.get(MCP_SCOPE_TOOLS_PATH)
    const notConnected = await get(route, 'http://local' + MCP_SCOPE_TOOLS_PATH + '?server=x')
    expect(notConnected.status).toBe(409)
    expect(((await notConnected.json()) as { error: { code: string } }).error.code).toBe('not-connected')
    const missing = await get(route, 'http://local' + MCP_SCOPE_TOOLS_PATH + '?server=ghost')
    expect(missing.status).toBe(404)
    const noServer = await get(route, 'http://local' + MCP_SCOPE_TOOLS_PATH)
    expect(noServer.status).toBe(400)

    const listed = await mount(
      fakeManager({
        toolList: () => ({
          tools: [{ publicName: 'mcp__x__t', rawName: 't', description: 'd' }],
          truncated: false,
          total: 1,
        }),
      }),
    )
    const ok = await get(listed.get(MCP_SCOPE_TOOLS_PATH), 'http://local' + MCP_SCOPE_TOOLS_PATH + '?server=x')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({
      ok: true,
      value: { tools: [{ publicName: 'mcp__x__t', rawName: 't', description: 'd' }], truncated: false, total: 1 },
    })
  })
})
