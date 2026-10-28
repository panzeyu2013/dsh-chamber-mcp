/**
 * Acceptance suite for the host status route through the REAL manager.
 * Traceability: E3 status envelope, E6 tool identity, E8 never breaking the
 * document UI on unavailable routes. The route matrix itself lives in
 * tests/host/routes.spec.ts; this file keeps only the real-manager projection.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createManager,
  type ManagerHandle,
  type ManagerLogger,
  type RuntimeStatusView,
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

describe('acceptance correctness: host status route with the real manager', () => {
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
