/**
 * Acceptance suite for the host status route through the REAL manager.
 * Traceability: the status envelope, tool identity and the seven-action
 * dispatch are exercised over the production manager (deterministic fake seat),
 * while the route matrix itself lives in tests/host/routes.spec.ts. This file
 * keeps only the real-manager projection: wire-shape closure, per-server
 * filtering, the tools route's mode and a restart action that really remounts.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerMcpScopeRoutes, MCP_SCOPE_ACTION_PATH, MCP_SCOPE_STATUS_PATH, MCP_SCOPE_TOOLS_PATH } from '../../src/routes.js'
import type { ManagerHandle } from '../../src/manager.js'
import type { RuntimeStatusView } from '../../src/shared/wire.js'
import { bootManager, stdioRow, waitFor } from '../support/manager-kit.js'
import { captureOf, toolDef } from '../support/fixture-kit.js'

interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** Provide the Connection carrier, register the real routes and flush activation. */
async function mountRoutes(managerCtx: Context, manager: ManagerHandle): Promise<Map<string, RegisteredRoute>> {
  const routes = new Map<string, RegisteredRoute>()
  managerCtx.provide('connection', {
    fetch: {
      register: (route: RegisteredRoute) => {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  } as never)
  registerMcpScopeRoutes(managerCtx, manager)
  await flush()
  return routes
}

/** Wait for the routes to register (the inject child activates off-tick). */
async function waitRoutes(routes: Map<string, RegisteredRoute>): Promise<void> {
  await waitFor(() => routes.size === 3, 'the three runtime routes', 5_000)
}

const statusGet = (routes: Map<string, RegisteredRoute>, url: string): Promise<Response> => {
  const route = routes.get(MCP_SCOPE_STATUS_PATH)
  if (route === undefined) throw new Error('status route not registered')
  return route.fetch(new Request(url))
}

describe('acceptance correctness: host status route with the real manager', () => {
  it('projects the real runtime status with a closed wire shape and filters it per server', async () => {
    const b = await bootManager({
      doc: { servers: [stdioRow('alpha'), stdioRow('beta')], overrides: {} },
    })
    try {
      b.manager.reconcile()
      const alpha = await b.waitSeat('alpha')
      await waitFor(() => alpha.instances.length === 1, 'alpha mount')
      alpha.setCapture(captureOf([toolDef('mcp__alpha__add')], { version: 1 }))
      alpha.instances[0]!.resolveReady({ state: 'connected', toolCount: 1, connectedAt: 5 })
      await waitFor(() => b.manager.runtimeStatus('alpha').servers[0]?.phase === 'connected', 'alpha connected')

      const routes = await mountRoutes(b.ctx, b.manager)
      await waitRoutes(routes)

      const fullResponse = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH)
      expect(fullResponse.status).toBe(200)
      expect(fullResponse.headers.get('cache-control')).toBe('no-store')
      const full = ((await fullResponse.json()) as { value: RuntimeStatusView }).value
      expect(full.servers.map((server) => server.name).sort()).toEqual(['alpha', 'beta'])
      // Wire shape is closed: no credential material, upstream text or internal
      // fields. The v2 additions are explicit members.
      const allowed = new Set([
        'name',
        'phase',
        'configured',
        'attempts',
        'maxAttempts',
        'nextRetryAt',
        'connectedAt',
        'syncedAt',
        'toolCount',
        'authReason',
        'authorization',
        'error',
      ])
      for (const server of full.servers) {
        for (const key of Object.keys(server)) {
          expect(allowed.has(key), server.name + ' exposes field ' + key).toBe(true)
        }
        expect(server.configured).toBe(true)
      }
      const alphaView = full.servers.find((server) => server.name === 'alpha')!
      expect(alphaView.phase).toBe('connected')
      expect(alphaView.toolCount).toBe(1)
      expect(typeof alphaView.syncedAt).toBe('number')
      // Filtered view is byte-identical to the full-view entry.
      const projected = (await (
        await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=alpha')
      ).json()) as { ok: boolean; value: RuntimeStatusView }
      expect(projected.ok).toBe(true)
      expect(projected.value.v).toBe(full.v)
      expect(JSON.stringify(projected.value.servers)).toBe(JSON.stringify([alphaView]))
      // Unknown names are a normal empty view, not an error.
      const ghost = (await (
        await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=ghost')
      ).json()) as { ok: boolean; value: RuntimeStatusView }
      expect(ghost.ok).toBe(true)
      expect(ghost.value.servers).toEqual([])
      const bad = await statusGet(routes, 'http://local' + MCP_SCOPE_STATUS_PATH + '?server=' + encodeURIComponent('a b'))
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad-request')

      // The tools route serves the committed generation for the connected server
      // and the fixed not-connected refusal for the other one.
      const toolsRoute = routes.get(MCP_SCOPE_TOOLS_PATH)!
      const listed = await toolsRoute.fetch(new Request('http://local' + MCP_SCOPE_TOOLS_PATH + '?server=alpha'))
      expect(listed.status).toBe(200)
      const listValue = ((await listed.json()) as { value: { mode: string; total: number; tools: unknown[] } }).value
      expect(listValue.mode).toBe('definitions')
      expect(listValue.total).toBe(1)
      const notConnected = await toolsRoute.fetch(new Request('http://local' + MCP_SCOPE_TOOLS_PATH + '?server=beta'))
      expect(notConnected.status).toBe(409)
      expect(((await notConnected.json()) as { error: { code: string } }).error.code).toBe('not-connected')
    } finally {
      await b.dispose()
    }
  }, 30_000)

  it('dispatches a restart through the route and the real manager remounts the instance', async () => {
    const b = await bootManager({ doc: { servers: [stdioRow('alpha')], overrides: {} } })
    try {
      b.manager.reconcile()
      const seat = await b.waitSeat('alpha')
      await waitFor(() => seat.instances.length === 1, 'the first mount')
      seat.instances[0]!.resolveReady({ state: 'connected', toolCount: 0, connectedAt: 5 })
      await waitFor(() => b.manager.runtimeStatus('alpha').servers[0]?.phase === 'connected', 'connected')

      const routes = await mountRoutes(b.ctx, b.manager)
      await waitRoutes(routes)
      const actionRoute = routes.get(MCP_SCOPE_ACTION_PATH)!
      const response = await actionRoute.fetch(
        new Request('http://local' + MCP_SCOPE_ACTION_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'restart', server: 'alpha' }),
        }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as { ok: boolean; value: { name: string; phase: string } }
      expect(body.ok).toBe(true)
      expect(body.value.name).toBe('alpha')
      // The real manager remounted inside the same seat (same definition).
      await waitFor(() => seat.instances.length === 2, 'the restart instance')
      expect(seat.instances[0]!.disposed).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 30_000)
})
