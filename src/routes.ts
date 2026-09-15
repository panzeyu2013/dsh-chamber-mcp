/**
 * Runtime-status HTTP routes of the mcp-scope host half.
 *
 * The browser half reads live server state and drives manual connect /
 * disconnect / test through three small routes on the SAME Connection carrier
 * every official host feature uses (`ctx.connection.fetch.register`, e.g.
 * `/api/present.host`, `/api/session.export`) — so the chamber gateway's
 * reverse proxy, Host/Origin fence and browser authentication all apply
 * unchanged. Nothing else is added: no new remote namespace, no new transport.
 *
 * Wire shape (versioned, additive):
 *   GET  /api/mcp-scope.status            → { ok, value: { v: 1, at, servers } }
 *        [?server=NAME]                       (absent/empty = full view; NAME = that
 *                                             single entry; unknown = servers: [])
 *   POST /api/mcp-scope.action            → { ok, value: { name, state } }
 *                                              | { ok:false, error:{code,message} }
 *   GET  /api/mcp-scope.tools?server=NAME → { ok, value: { tools, truncated } }
 *
 * Failures are business results with HTTP status codes, never thrown into the
 * carrier. Responses are `no-store` and never contain credential material
 * (the manager redacts error text before it reaches here).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.connection` (HostConnectionHandle) into this program.
import type {} from '@deepseek-ai/dsh-client-connection'
import { RuntimeActionError, type ManagerHandle } from './manager.js'
import { SERVER_NAME_PATTERN } from './shared/model.js'

/** Exact Fetch routes this plugin owns below `/api`. */
export const MCP_SCOPE_STATUS_PATH = '/api/mcp-scope.status'
export const MCP_SCOPE_ACTION_PATH = '/api/mcp-scope.action'
export const MCP_SCOPE_TOOLS_PATH = '/api/mcp-scope.tools'

/** Logger surface used for route-registration diagnostics. */
export interface RouteLogger {
  info(message: string): void
  warn(message: string): void
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

const failure = (code: string, message: string, status: number): Response =>
  json({ ok: false, error: { code, message } }, status)

/** One shared wording for every out-of-contract server-name field (body or query). */
const SERVER_NAME_ERROR_MESSAGE = 'server must be 1-32 chars of [A-Za-z0-9_-]'

/** Business failure of a server-name field outside the contract. */
const badServerName = (): Response => failure('bad-request', SERVER_NAME_ERROR_MESSAGE, 400)

/** Status code of one business failure code (default 500). */
function statusOf(code: string): number {
  switch (code) {
    case 'not-found':
      return 404
    case 'not-connected':
      return 409
    case 'disabled':
      return 409
    case 'bad-request':
      return 400
    default:
      return 500
  }
}

/** Fold one thrown action failure into the wire's business result. */
function actionFailure(error: unknown): Response {
  if (error instanceof RuntimeActionError) return failure(error.code, error.message, statusOf(error.code))
  const message = error instanceof Error ? error.message : 'action failed'
  return failure('internal', message, 500)
}

/** Decode the JSON action body without letting a bad body reject the route. */
async function readActionBody(
  request: Request,
): Promise<{ action: 'connect' | 'disconnect' | 'test'; server: string } | Response> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return failure('bad-request', 'invalid JSON body', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('bad-request', 'body must be a JSON object', 400)
  }
  const body = parsed as { action?: unknown; server?: unknown }
  if (typeof body.server !== 'string' || !SERVER_NAME_PATTERN.test(body.server)) {
    return badServerName()
  }
  if (body.action !== 'connect' && body.action !== 'disconnect' && body.action !== 'test') {
    return failure('bad-request', 'unknown action', 400)
  }
  return { action: body.action, server: body.server }
}

/**
 * Register the three runtime routes when the Connection carrier is present.
 * The nested `ctx.inject` keeps headless hosts (no web carrier) fully
 * functional: the routes simply never mount and the browser UI degrades to
 * "runtime status unavailable". Disposers are fiber-owned (HMR-safe).
 */
export function registerMcpScopeRoutes(ctx: Context, manager: ManagerHandle, logger?: RouteLogger): void {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      const dispatchers = [
        scope.connection.fetch.register({
          path: MCP_SCOPE_STATUS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => {
            // A repeated param resolves to its first value (URLSearchParams.get)
            // deterministically. Absent or empty 'server' keeps the untouched
            // full-document view (backward compatible).
            const server = new URL(request.url).searchParams.get('server')
            if (server !== null && server !== '' && !SERVER_NAME_PATTERN.test(server)) {
              return Promise.resolve(badServerName())
            }
            try {
              const value =
                server === null || server === ''
                  ? manager.runtimeStatus()
                  : manager.runtimeStatus(server)
              return Promise.resolve(json({ ok: true, value }))
            } catch (error) {
              // Never throw into the carrier: a failed read folds into the
              // same business envelope every other route uses.
              return Promise.resolve(actionFailure(error))
            }
          },
        }),
        scope.connection.fetch.register({
          path: MCP_SCOPE_ACTION_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const body = await readActionBody(request)
            if (body instanceof Response) return body
            try {
              switch (body.action) {
                case 'connect':
                  return json({ ok: true, value: await manager.connect(body.server) })
                case 'disconnect':
                  return json({ ok: true, value: await manager.disconnect(body.server) })
                case 'test':
                  return json({ ok: true, value: await manager.test(body.server) })
              }
            } catch (error) {
              return actionFailure(error)
            }
          },
        }),
        scope.connection.fetch.register({
          path: MCP_SCOPE_TOOLS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => {
            const server = new URL(request.url).searchParams.get('server') ?? ''
            if (!SERVER_NAME_PATTERN.test(server)) {
              return Promise.resolve(badServerName())
            }
            try {
              const listed = manager.toolList(server)
              if (listed === undefined) {
                return Promise.resolve(failure('not-connected', 'no tool list synced for this server', 409))
              }
              return Promise.resolve(json({ ok: true, value: listed }))
            } catch (error) {
              return Promise.resolve(actionFailure(error))
            }
          },
        }),
      ]
      logger?.info('mcp-scope: runtime routes mounted (/api/mcp-scope.status|action|tools)')
      return () => {
        for (const dispose of dispatchers) void dispose()
      }
    }, 'mcp-scope: runtime routes')
  })
}
