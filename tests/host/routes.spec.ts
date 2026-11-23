/**
 * Runtime-route tests (src/routes.ts): the three Connection fetch routes are
 * registered on the shared carrier when ctx.connection exists, and every handler
 * folds business failures into the JSON envelope with an HTTP status instead of
 * throwing into the carrier.
 *
 * Wire v2: seven actions (connect/disconnect/restart/test/authorize/
 * cancel-authorization/sign-out), the phase/configured status shape, the
 * attempt-id grammar, the definitions/catalog tool-list modes and a no-store
 * envelope on every path.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RuntimeActionError, type ManagerHandle } from '../../src/manager.js'
import {
  MCP_SCOPE_ACTION_PATH,
  MCP_SCOPE_STATUS_PATH,
  MCP_SCOPE_TOOLS_PATH,
  registerMcpScopeRoutes,
} from '../../src/routes.js'
import type {
  RuntimeActionResult,
  RuntimeAuthorizeResult,
  RuntimePhase,
  ServerRuntimeView,
  ToolListView,
} from '../../src/shared/wire.js'

interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

const action = (name: string, phase: RuntimePhase = 'connecting'): RuntimeActionResult => ({ name, phase })

const authorizeResult = (name: string): RuntimeAuthorizeResult => ({
  name,
  phase: 'waiting-authorization',
  authorization: { id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://as.example/auth' },
})

/** Full ManagerHandle stub; every method is overridable per test. */
function fakeManager(patch: Partial<ManagerHandle> = {}): ManagerHandle {
  return {
    reconcile: () => {},
    dispose: async () => {},
    runtimeStatus: () => ({ v: 1 as const, at: 42, servers: [] }),
    toolList: () => undefined,
    connect: async (name: string) => action(name),
    disconnect: async (name: string) => action(name, 'stopped'),
    restart: async (name: string) => action(name),
    test: async () => ({ ok: true, toolCount: 3 }),
    authorize: async (name: string) => authorizeResult(name),
    cancelAuthorization: async (name: string) => action(name, 'waiting-authorization'),
    signOut: async (name: string) => action(name, 'waiting-authorization'),
    ...patch,
  }
}

const serverView = (name: string, phase: RuntimePhase = 'connected'): ServerRuntimeView => ({
  name,
  phase,
  configured: true,
  attempts: 0,
  maxAttempts: 10,
  toolCount: phase === 'connected' ? 4 : 0,
})

const definitions = (): ToolListView => ({
  mode: 'definitions',
  tools: [{ publicName: 'mcp__x__t', description: 'd' }],
  truncated: false,
  total: 1,
})

interface Mounted {
  routes: Map<string, RegisteredRoute>
  ctx: Context
  /** Flush pending inject activations. */
  ready: Promise<void>
}

async function mount(manager: ManagerHandle, options: { connection?: boolean } = {}): Promise<Mounted> {
  const routes = new Map<string, RegisteredRoute>()
  const disposers: Array<() => Promise<void>> = []
  const ctx = new Context()
  if (options.connection !== false) {
    ctx.provide('connection', {
      fetch: {
        register: (route: RegisteredRoute) => {
          routes.set(route.path, route)
          const off = async (): Promise<void> => {
            routes.delete(route.path)
          }
          disposers.push(off)
          return off
        },
      },
    } as never)
  }
  registerMcpScopeRoutes(ctx, manager)
  const ready = flush()
  return { routes, ctx, ready }
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

const statusUrl = (query = ''): string => 'http://local' + MCP_SCOPE_STATUS_PATH + query
const actionUrl = 'http://local' + MCP_SCOPE_ACTION_PATH
const toolsUrl = (query: string): string => 'http://local' + MCP_SCOPE_TOOLS_PATH + query

describe('mcp-scope runtime routes', () => {
  it('registers exactly the three routes on the connection carrier', async () => {
    const { routes, ready } = await mount(fakeManager())
    await ready
    expect([...routes.keys()].sort()).toEqual(
      [MCP_SCOPE_STATUS_PATH, MCP_SCOPE_ACTION_PATH, MCP_SCOPE_TOOLS_PATH].sort(),
    )
    expect(routes.get(MCP_SCOPE_STATUS_PATH)?.methods).toEqual(['GET'])
    expect(routes.get(MCP_SCOPE_ACTION_PATH)?.methods).toEqual(['POST'])
    expect(routes.get(MCP_SCOPE_TOOLS_PATH)?.methods).toEqual(['GET'])
    expect(routes.get(MCP_SCOPE_STATUS_PATH)?.requestBody).toBe('buffered')
  })

  it('degrades without a Connection carrier: no route, no throw', async () => {
    const mounted = await mount(fakeManager(), { connection: false })
    await mounted.ready
    expect(mounted.routes.size).toBe(0)
  })

  it('serves the versioned runtime status envelope with no-store', async () => {
    const view = { v: 1 as const, at: 7, servers: [serverView('github')] }
    const { routes, ready } = await mount(fakeManager({ runtimeStatus: () => view }))
    await ready
    const response = await get(routes.get(MCP_SCOPE_STATUS_PATH), statusUrl())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value: view })
  })

  it('dispatches all seven actions to the manager and returns their values', async () => {
    const calls: string[] = []
    const { routes, ready } = await mount(
      fakeManager({
        connect: async (name) => {
          calls.push('connect:' + name)
          return action(name)
        },
        disconnect: async (name) => {
          calls.push('disconnect:' + name)
          return action(name, 'stopped')
        },
        restart: async (name) => {
          calls.push('restart:' + name)
          return action(name)
        },
        test: async (name) => {
          calls.push('test:' + name)
          return { ok: true, toolCount: 9 }
        },
        authorize: async (name) => {
          calls.push('authorize:' + name)
          return authorizeResult(name)
        },
        cancelAuthorization: async (name, attemptId) => {
          calls.push('cancel:' + name + ':' + attemptId)
          return action(name, 'waiting-authorization')
        },
        signOut: async (name) => {
          calls.push('sign-out:' + name)
          return action(name, 'waiting-authorization')
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_ACTION_PATH)
    const results = [
      await (await post(route, actionUrl, { action: 'connect', server: 'x' })).json(),
      await (await post(route, actionUrl, { action: 'disconnect', server: 'x' })).json(),
      await (await post(route, actionUrl, { action: 'restart', server: 'x' })).json(),
      await (await post(route, actionUrl, { action: 'test', server: 'x' })).json(),
      await (await post(route, actionUrl, { action: 'authorize', server: 'x' })).json(),
      await (await post(route, actionUrl, { action: 'cancel-authorization', server: 'x', attemptId: 'attempt-1' })).json(),
      await (await post(route, actionUrl, { action: 'sign-out', server: 'x' })).json(),
    ]
    expect(results[0]).toEqual({ ok: true, value: action('x') })
    expect(results[1]).toEqual({ ok: true, value: action('x', 'stopped') })
    expect(results[2]).toEqual({ ok: true, value: action('x') })
    expect(results[3]).toEqual({ ok: true, value: { ok: true, toolCount: 9 } })
    expect(results[4]).toEqual({ ok: true, value: authorizeResult('x') })
    expect(results[5]).toEqual({ ok: true, value: action('x', 'waiting-authorization') })
    expect(results[6]).toEqual({ ok: true, value: action('x', 'waiting-authorization') })
    expect(calls).toEqual([
      'connect:x',
      'disconnect:x',
      'restart:x',
      'test:x',
      'authorize:x',
      'cancel:x:attempt-1',
      'sign-out:x',
    ])
  })

  it('rejects malformed action bodies with 400 and the business envelope', async () => {
    const { routes, ready } = await mount(fakeManager())
    await ready
    const route = routes.get(MCP_SCOPE_ACTION_PATH)
    for (const body of [{ action: 'nope', server: 'x' }, { action: 'connect' }, { server: 'x' }, {}, []]) {
      const response = await post(route, actionUrl, body)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    const invalid = await post(route, actionUrl, undefined)
    expect(invalid.status).toBe(400)
    // cancel-authorization requires the opaque attempt id.
    const missingId = await post(route, actionUrl, { action: 'cancel-authorization', server: 'x' })
    expect(missingId.status).toBe(400)
    expect(((await missingId.json()) as { error: { message: string } }).error.message).toMatch(/attemptId/)
  })

  it('validates the attempt-id grammar without ever echoing the id', async () => {
    const { routes, ready } = await mount(fakeManager())
    await ready
    const route = routes.get(MCP_SCOPE_ACTION_PATH)
    const bad = ['x y', 'a'.repeat(65), 'id"with-quote', '<script>', 'a/b']
    for (const attemptId of bad) {
      const response = await post(route, actionUrl, { action: 'cancel-authorization', server: 'x', attemptId })
      expect(response.status).toBe(400)
      expect(JSON.stringify(await response.json())).not.toContain(attemptId)
    }
  })

  it('rejects server names outside the contract without echoing them', async () => {
    const { routes, ready } = await mount(fakeManager())
    await ready
    const long = 'x'.repeat(2_000)
    for (const server of [long, 'has space', '', 'a'.repeat(33)]) {
      const response = await post(routes.get(MCP_SCOPE_ACTION_PATH), actionUrl, { action: 'connect', server })
      expect(response.status).toBe(400)
      const body = JSON.stringify(await response.json())
      if (server !== '') expect(body).not.toContain(server)
    }
    const toolsBad = await get(routes.get(MCP_SCOPE_TOOLS_PATH), toolsUrl('?server=' + encodeURIComponent(long)))
    expect(toolsBad.status).toBe(400)
    expect(JSON.stringify(await toolsBad.json())).not.toContain(long)
  })

  it('maps every business failure code to its HTTP status', async () => {
    const { routes, ready } = await mount(
      fakeManager({
        connect: async () => {
          throw new RuntimeActionError('not-found', 'server "x" is not configured')
        },
        disconnect: async () => {
          throw new RuntimeActionError('disabled', 'server is disabled')
        },
        restart: async () => {
          throw new RuntimeActionError('cleanup', 'server cleanup is incomplete; restart the Host to retry')
        },
        test: async () => {
          throw new Error('boom')
        },
        authorize: async () => {
          throw new RuntimeActionError('oauth-not-configured', 'OAuth is not configured for this server')
        },
        cancelAuthorization: async () => {
          throw new RuntimeActionError('oauth-failed', 'authorization failed')
        },
        signOut: async () => {
          throw new RuntimeActionError('oauth-cleanup', 'cleanup is incomplete')
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_ACTION_PATH)
    const expectStatus = async (body: unknown, status: number, code: string): Promise<void> => {
      const response = await post(route, actionUrl, body)
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(((await response.json()) as { ok: boolean; error: { code: string } })).toMatchObject({ ok: false, error: { code } })
    }
    await expectStatus({ action: 'connect', server: 'x' }, 404, 'not-found')
    await expectStatus({ action: 'disconnect', server: 'x' }, 409, 'disabled')
    await expectStatus({ action: 'restart', server: 'x' }, 409, 'cleanup')
    await expectStatus({ action: 'test', server: 'x' }, 500, 'internal')
    await expectStatus({ action: 'authorize', server: 'x' }, 409, 'oauth-not-configured')
    await expectStatus({ action: 'cancel-authorization', server: 'x', attemptId: 'a' }, 500, 'oauth-failed')
    await expectStatus({ action: 'sign-out', server: 'x' }, 500, 'oauth-cleanup')
  })

  it('serves tool identity, distinguishing not-connected from not-found and catalog from definitions', async () => {
    const { routes, ready } = await mount(
      fakeManager({
        toolList: (name: string) => {
          if (name === 'ghost') throw new RuntimeActionError('not-found', 'server "ghost" is not configured')
          if (name === 'catalog') return { mode: 'catalog', tools: [], truncated: false, total: 12 }
          if (name === 'x') return definitions()
          return undefined
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_TOOLS_PATH)
    const notConnected = await get(route, toolsUrl('?server=down'))
    expect(notConnected.status).toBe(409)
    expect(((await notConnected.json()) as { error: { code: string } }).error.code).toBe('not-connected')
    const missing = await get(route, toolsUrl('?server=ghost'))
    expect(missing.status).toBe(404)
    const noServer = await get(route, toolsUrl(''))
    expect(noServer.status).toBe(400)

    const ok = await get(route, toolsUrl('?server=x'))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, value: definitions() })
    const catalog = await get(route, toolsUrl('?server=catalog'))
    expect(await catalog.json()).toEqual({
      ok: true,
      value: { mode: 'catalog', tools: [], truncated: false, total: 12 },
    })
  })

  it('serves the full view for an absent or empty server param (backward compatible)', async () => {
    const seen: (string | undefined)[] = []
    const { routes, ready } = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          return { v: 1 as const, at: 7, servers: [serverView('github')] }
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    for (const url of [statusUrl(), statusUrl('?'), statusUrl('?server='), statusUrl('?other=1')]) {
      const response = await get(route, url)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        ok: true,
        value: { v: 1, at: 7, servers: [serverView('github')] },
      })
    }
    // Every full-view read is the untouched no-argument manager call.
    expect(seen).toEqual([undefined, undefined, undefined, undefined])
  })

  it('filters the runtime status to exactly one entry with ?server=NAME', async () => {
    const seen: (string | undefined)[] = []
    const { routes, ready } = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          const servers = [serverView('github'), serverView('linear', 'stopped')]
          return {
            v: 1 as const,
            at: 7,
            servers: servers.filter((entry) => serverName === undefined || entry.name === serverName),
          }
        },
      }),
    )
    await ready
    const response = await get(routes.get(MCP_SCOPE_STATUS_PATH), statusUrl('?server=linear'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('linear', 'stopped')] },
    })
    expect(seen).toEqual(['linear'])

    const ghost = await get(routes.get(MCP_SCOPE_STATUS_PATH), statusUrl('?server=ghost'))
    expect(await ghost.json()).toEqual({ ok: true, value: { v: 1, at: 7, servers: [] } })
  })

  it('resolves a repeated ?server param to its first value deterministically', async () => {
    const seen: (string | undefined)[] = []
    const { routes, ready } = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          seen.push(serverName)
          return {
            v: 1 as const,
            at: 7,
            servers: [serverView('github'), serverView('linear', 'stopped')].filter(
              (entry) => entry.name === serverName,
            ),
          }
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    expect(await (await get(route, statusUrl('?server=github&server=linear'))).json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('github')] },
    })
    expect(await (await get(route, statusUrl('?server=linear&server=github'))).json()).toEqual({
      ok: true,
      value: { v: 1, at: 7, servers: [serverView('linear', 'stopped')] },
    })
    expect(seen).toEqual(['github', 'linear'])
  })

  it('rejects an out-of-contract ?server with the shared 400 envelope, never reading the manager', async () => {
    let reads = 0
    const { routes, ready } = await mount(
      fakeManager({
        runtimeStatus: () => {
          reads += 1
          return { v: 1 as const, at: 7, servers: [] }
        },
      }),
    )
    await ready
    const route = routes.get(MCP_SCOPE_STATUS_PATH)
    for (const server of ['x'.repeat(2_000), 'has space', 'a'.repeat(33), 'x@y', 'a/b']) {
      const response = await get(route, statusUrl('?server=' + encodeURIComponent(server)))
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
    const actionBad = await post(routes.get(MCP_SCOPE_ACTION_PATH), actionUrl, {
      action: 'connect',
      server: 'has space',
    })
    expect(actionBad.status).toBe(400)
    expect(await actionBad.json()).toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'server must be 1-32 chars of [A-Za-z0-9_-]' },
    })
  })

  it('never throws a manager read failure into the carrier', async () => {
    const { routes, ready } = await mount(
      fakeManager({
        runtimeStatus: vi.fn(() => {
          throw new Error('status read exploded')
        }),
        toolList: () => {
          throw new Error('tool read exploded')
        },
      }),
    )
    await ready
    const status = await get(routes.get(MCP_SCOPE_STATUS_PATH), statusUrl())
    expect(status.status).toBe(500)
    expect(await status.json()).toEqual({ ok: false, error: { code: 'internal', message: 'action failed' } })
    const tools = await get(routes.get(MCP_SCOPE_TOOLS_PATH), toolsUrl('?server=x'))
    expect(tools.status).toBe(500)
    expect(((await tools.json()) as { error: { code: string } }).error.code).toBe('internal')
  })

  it('disposes its dispatchers with the owning fiber', async () => {
    const mounted = await mount(fakeManager())
    await mounted.ready
    expect(mounted.routes.size).toBe(3)
    await mounted.ctx.fiber.dispose()
    expect(mounted.routes.size).toBe(0)
  })
})

describe('oauth business codes map to 409', () => {
  it.each(['oauth-unavailable', 'oauth-busy', 'oauth-required', 'config', 'load', 'not-connected'] as const)(
    'maps %s',
    async (code) => {
      const { routes, ready } = await mount(
        fakeManager({
          authorize: async () => {
            throw new RuntimeActionError(code, 'fixed refusal')
          },
        }),
      )
      await ready
      const response = await post(routes.get(MCP_SCOPE_ACTION_PATH), actionUrl, { action: 'authorize', server: 'x' })
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
    },
  )
})
