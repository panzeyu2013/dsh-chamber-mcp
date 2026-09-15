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

type FakePhase = 'connected' | 'stopped' | 'disabled' | 'unknown'

/** One server entry of the fake runtime view (shape mirrors ServerRuntimeView). */
const serverView = (
  name: string,
  state: FakePhase,
): { name: string; state: FakePhase; attempts: number; maxAttempts: number; toolCount: number } => ({
  name,
  state,
  attempts: 0,
  maxAttempts: 10,
  toolCount: state === 'connected' ? 4 : 0,
})

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

  it('serves the full view for an absent or empty server param (backward compatible)', async () => {
    const seen: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          return { v: 1 as const, at: 7, servers: [serverView('github', 'connected')] }
        },
      }),
    )
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    for (const url of [
      'http://local' + MCP_SCOPE_STATUS_PATH,
      'http://local' + MCP_SCOPE_STATUS_PATH + '?',
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=',
      'http://local' + MCP_SCOPE_STATUS_PATH + '?other=1',
    ]) {
      const response = await get(route, url)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        ok: true,
        value: { v: 1, at: 7, servers: [serverView('github', 'connected')] },
      })
    }
    // Every full-view read is the untouched no-argument manager call.
    expect(seen).toEqual([undefined, undefined, undefined, undefined])
  })

  it('filters the runtime status to exactly one entry with ?server=NAME', async () => {
    const seen: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          const servers = [serverView('github', 'connected'), serverView('linear', 'stopped')]
          return {
            v: 1 as const,
            at: 7,
            servers: servers.filter((entry) => serverName === undefined || entry.name === serverName),
          }
        },
      }),
    )
    const response = await get(
      routes.get(MCP_SCOPE_STATUS_PATH),
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=linear',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('linear', 'stopped')] },
    })
    expect(seen).toEqual(['linear'])
  })

  it('returns a normal ok view with servers: [] for an unknown ?server name', async () => {
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => ({
          v: 1 as const,
          at: 7,
          servers: [serverView('github', 'connected')].filter(
            (entry) => serverName === undefined || entry.name === serverName,
          ),
        }),
      }),
    )
    const response = await get(
      routes.get(MCP_SCOPE_STATUS_PATH),
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=ghost',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value: { v: 1, at: 7, servers: [] } })
  })

  it('resolves a repeated ?server param to its first value deterministically', async () => {
    const seen: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          return {
            v: 1 as const,
            at: 7,
            servers: [serverView('github', 'connected'), serverView('linear', 'stopped')].filter(
              (entry) => entry.name === serverName,
            ),
          }
        },
      }),
    )
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    const first = await get(route, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=github&server=linear')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('github', 'connected')] },
    })
    const reversed = await get(route, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=linear&server=github')
    expect(await reversed.json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('linear', 'stopped')] },
    })
    expect(seen).toEqual(['github', 'linear'])
  })

  it('rejects an out-of-contract ?server with the shared 400 envelope, never reading the manager', async () => {
    let reads = 0
    const routes = await mount(
      fakeManager({
        runtimeStatus: () => {
          reads += 1
          return { v: 1 as const, at: 7, servers: [] }
        },
      }),
    )
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    for (const server of ['x'.repeat(2_000), 'has space', 'a'.repeat(33), 'x@y', 'a/b']) {
      const response = await get(
        route,
        'http://local' + MCP_SCOPE_STATUS_PATH + '?server=' + encodeURIComponent(server),
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('bad-request')
      expect(body.error.message).toBe('server must be 1-32 chars of [A-Za-z0-9_-]')
      expect(JSON.stringify(body)).not.toContain(server)
    }
    expect(reads).toBe(0)
    // The status route reuses the action route's exact server-name wording.
    const actionBad = await post(routes.get(MCP_SCOPE_ACTION_PATH), 'http://local' + MCP_SCOPE_ACTION_PATH, {
      action: 'connect',
      server: 'has space',
    })
    expect(actionBad.status).toBe(400)
    expect(await actionBad.json()).toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'server must be 1-32 chars of [A-Za-z0-9_-]' },
    })
  })

  it('keeps the action and tools routes unchanged while the status filter is in use', async () => {
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => ({
          v: 1 as const,
          at: 7,
          servers: serverName === undefined ? [serverView('x', 'connected')] : [],
        }),
        toolList: (serverName: string) =>
          serverName === 'x' ? { tools: [], truncated: false, total: 0 } : undefined,
      }),
    )
    const status = await get(
      routes.get(MCP_SCOPE_STATUS_PATH),
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=x',
    )
    expect(await status.json()).toEqual({ ok: true, value: { v: 1, at: 7, servers: [] } })
    const action = await post(routes.get(MCP_SCOPE_ACTION_PATH), 'http://local' + MCP_SCOPE_ACTION_PATH, {
      action: 'test',
      server: 'x',
    })
    expect(await action.json()).toEqual({ ok: true, value: { ok: true, toolCount: 3 } })
    const tools = await get(routes.get(MCP_SCOPE_TOOLS_PATH), 'http://local' + MCP_SCOPE_TOOLS_PATH + '?server=x')
    expect(tools.status).toBe(200)
    expect(await tools.json()).toEqual({ ok: true, value: { tools: [], truncated: false, total: 0 } })
    const toolsBad = await get(routes.get(MCP_SCOPE_TOOLS_PATH), 'http://local' + MCP_SCOPE_TOOLS_PATH)
    expect(toolsBad.status).toBe(400)
  })
})
