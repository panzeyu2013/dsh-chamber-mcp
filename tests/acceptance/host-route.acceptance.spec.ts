/**
 * INDEPENDENT acceptance suite, C4 axis 1 (CORRECTNESS) for the host route
 * GET /api/mcp-scope.status?server=NAME (contract C1) plus its completeness
 * with the projection performed by the REAL manager (end-to-end, no server
 * process needed: a configured-but-untracked server still projects).
 *
 * Contract-first: expected to fail until src/routes.ts reads the query param.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createManager,
  type ManagerHandle,
  type ManagerLogger,
  type RuntimeStatusView,
  type ServerRuntimeView,
} from '../../src/manager.js'
import { MCP_SCOPE_STATUS_PATH, registerMcpScopeRoutes } from '../../src/routes.js'
import type { CredentialResolver } from '../../src/transport.js'
import type { McpScopeDoc } from '../../src/shared/model.js'

interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

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

function statusGet(routes: Map<string, RegisteredRoute>, url: string): Promise<Response> {
  const route = routes.get(MCP_SCOPE_STATUS_PATH)
  if (route === undefined) throw new Error('status route not registered')
  return route.fetch(new Request(url))
}

const entry = (name: string, state: ServerRuntimeView['state'] = 'connected'): ServerRuntimeView => ({
  name,
  state,
  attempts: 1,
  maxAttempts: 10,
  toolCount: 2,
})

const fullView: RuntimeStatusView = { v: 1, at: 77, servers: [entry('alpha'), entry('beta', 'failed')] }

describe('C4 correctness: host status route without a real manager', () => {
  it('[correctness] host route registers the status route as GET and answers the full view with no-store', async () => {
    const routes = await mount(fakeManager({ runtimeStatus: () => fullView }))
    expect(routes.get(MCP_SCOPE_STATUS_PATH)?.methods).toEqual(['GET'])
    const response = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value: fullView })
  })

  it('[correctness] host route without the param asks the manager for the full view', async () => {
    const args: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          args.push(serverName)
          return fullView
        },
      }),
    )
    await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH)
    expect(args).toEqual([undefined])
  })

  it('[correctness] host route ?server=NAME projects to exactly that entry', async () => {
    const args: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          args.push(serverName)
          return serverName === undefined
            ? fullView
            : { v: 1, at: fullView.at, servers: fullView.servers.filter((server) => server.name === serverName) }
        },
      }),
    )
    const full = ((await (await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH)).json()) as {
      value: RuntimeStatusView
    }).value
    const response = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=alpha')
    expect(response.status).toBe(200)
    const projected = ((await response.json()) as { ok: boolean; value: RuntimeStatusView }).value
    expect(projected.servers).toHaveLength(1)
    expect(projected.servers[0]).toEqual(entry('alpha'))
    expect(projected.servers[0]).toEqual(full.servers.find((server) => server.name === 'alpha'))
    expect(args).toEqual([undefined, 'alpha'])
  })

  it('[correctness] host route unknown name is an empty normal view, never an error', async () => {
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => ({
          v: 1,
          at: 77,
          servers: serverName === undefined ? fullView.servers : fullView.servers.filter((s) => s.name === serverName),
        }),
      }),
    )
    const response = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=ghost')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; value: RuntimeStatusView }
    expect(body.ok).toBe(true)
    expect(body.value.servers).toEqual([])
  })

  it('[correctness] host route empty server param stays the full view (backward compatible)', async () => {
    const routes = await mount(fakeManager({ runtimeStatus: () => fullView }))
    const response = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: fullView })
  })

  it('[correctness] host route rejects a bad server name with the 400 bad-request envelope and never asks the manager', async () => {
    let asked = 0
    const routes = await mount(
      fakeManager({
        runtimeStatus: () => {
          asked += 1
          return fullView
        },
      }),
    )
    const bad = ['has space', 'a'.repeat(33), 'é', 'a/b', 'a.b']
    for (const name of bad) {
      const response = await statusGet(
        routes,
        'http://local' + MCP_SCOPE_STATUS_PATH + '?server=' + encodeURIComponent(name),
      )
      expect(response.status, name).toBe(400)
      expect(await response.json(), name).toEqual({
        ok: false,
        error: { code: 'bad-request', message: 'server must be 1-32 chars of [A-Za-z0-9_-]' },
      })
      expect(asked, name).toBe(0)
    }
  })

  it('[correctness] host route repeated params are deterministic (first value wins)', async () => {
    const args: (string | undefined)[] = []
    const routes = await mount(
      fakeManager({
        runtimeStatus: (serverName?: string) => {
          args.push(serverName)
          return serverName === undefined
            ? fullView
            : { v: 1, at: fullView.at, servers: fullView.servers.filter((server) => server.name === serverName) }
        },
      }),
    )
    const url = 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=alpha&server=beta'
    const first = await (await statusGet(routes, url)).json()
    const second = await (await statusGet(routes, url)).json()
    expect(first).toEqual(second)
    expect((first as { value: RuntimeStatusView }).value.servers).toEqual([entry('alpha')])
    const reversed = await (
      await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=beta&server=alpha')
    ).json()
    expect((reversed as { value: RuntimeStatusView }).value.servers).toEqual([entry('beta', 'failed')])
    expect(args).toEqual(['alpha', 'alpha', 'beta'])

    // First value wins even when it is the bad one: deterministic 400.
    const badFirst = await statusGet(
      routes,
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=' + encodeURIComponent('has space') + '&server=alpha',
    )
    expect(badFirst.status).toBe(400)
    // and a trailing bad value is ignored entirely.
    const goodFirst = await statusGet(
      routes,
      'http://local' + MCP_SCOPE_STATUS_PATH + '?server=alpha&server=' + encodeURIComponent('has space'),
    )
    expect(goodFirst.status).toBe(200)
    expect(args).toEqual(['alpha', 'alpha', 'beta', 'alpha'])
  })
})

describe('C4 correctness: host status route end-to-end with the real manager', () => {
  function docOf(): McpScopeDoc {
    return {
      servers: [
        { serverName: 'alpha', transport: 'stdio', command: 'node', args: ['a.js'] },
        { serverName: 'beta', transport: 'stdio', command: 'node', args: ['b.js'] },
      ],
      overrides: {},
    }
  }

  async function bootReal(doc: McpScopeDoc): Promise<{ manager: ManagerHandle; dispose(): Promise<void> }> {
    const ctx = new Context()
    const logger: ManagerLogger = { info: () => {}, warn: () => {}, error: () => {} }
    const credentials = { resolve: (async () => undefined) as CredentialResolver }
    ctx.provide('agents', { roots: () => [], get: () => undefined })
    ctx.provide('workspaceRegistry', { list: () => [] })
    let manager: ManagerHandle | undefined
    const managerHost = function managerHost(c: Context) {
      manager = createManager({ ctx: c, logger, getDoc: () => doc, credentials })
    }
    managerHost.inject = ['agents', 'workspaceRegistry']
    await ctx.plugin(managerHost)
    return {
      manager: manager!,
      dispose: async () => {
        await manager!.dispose()
      },
    }
  }

  it('[correctness] host route (real manager) filters the same entries the full view carries', async () => {
    const booted = await bootReal(docOf())
    try {
      const routes = await mount(booted.manager)
      const fullResponse = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH)
      expect(fullResponse.headers.get('cache-control')).toBe('no-store')
      const full = ((await fullResponse.json()) as { value: RuntimeStatusView }).value
      expect(full.servers.map((server) => server.name).sort()).toEqual(['alpha', 'beta'])
      // Wire shape is closed: no credential material or internal fields.
      const allowed = new Set([
        'name',
        'state',
        'attempts',
        'maxAttempts',
        'nextRetryAt',
        'connectedAt',
        'syncedAt',
        'toolCount',
        'error',
      ])
      for (const server of full.servers) {
        for (const key of Object.keys(server)) {
          expect(allowed.has(key), server.name + ' exposes field ' + key).toBe(true)
        }
      }

      const projected = (await (
        await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=alpha')
      ).json()) as { ok: boolean; value: RuntimeStatusView }
      expect(projected.ok).toBe(true)
      expect(projected.value.servers).toHaveLength(1)
      expect(projected.value.servers[0]).toEqual(full.servers.find((server) => server.name === 'alpha'))
      expect(projected.value.v).toBe(full.v)

      const ghost = (await (
        await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=ghost')
      ).json()) as { ok: boolean; value: RuntimeStatusView }
      expect(ghost.ok).toBe(true)
      expect(ghost.value.servers).toEqual([])

      const bad = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=' + encodeURIComponent('a b'))
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad-request')
    } finally {
      await booted.dispose()
    }
  })
})
