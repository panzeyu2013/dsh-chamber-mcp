/**
 * Runtime-status HTTP routes of the mcp-scope host half.
 *
 * The browser half reads live server state and drives manual actions through
 * three small routes on the SAME Connection carrier every official host feature
 * uses (`ctx.connection.fetch.register`, e.g. `/api/present.host`,
 * `/api/session.export`) — so the chamber gateway's reverse proxy, Host/Origin
 * fence and browser authentication all apply unchanged. Nothing else is added:
 * no new remote namespace, no new transport.
 *
 * Wire shape (versioned, additive; types frozen in {@link ./shared/wire.js}):
 *   GET  /api/mcp-scope.status            → { ok, value: RuntimeStatusView }
 *        [?server=NAME]                       (absent/empty = full view; NAME = that
 *                                             single entry; unknown = servers: [])
 *   POST /api/mcp-scope.action            → { ok, value: RuntimeActionResult |
 *                                              RuntimeTestResult }
 *                                              | { ok:false, error:{code,message} }
 *   GET  /api/mcp-scope.tools?server=NAME → { ok, value: ToolListView }
 *
 * The seven action kinds are all real: `connect`, `disconnect`, `restart`,
 * `test`, `authorize`, `cancel-authorization` and `sign-out`. `authorize`
 * answers the token-free attempt view (already at `waiting-browser` with the
 * page URL when the flow gets there within the manager's bounded wait), so the
 * browser opens it without polling.
 *
 * Failures are business results with HTTP status codes, never thrown into the
 * carrier. OAuth business failures answer 409 for not-configured/unavailable/
 * busy and 500 for failed/cleanup. Responses are `no-store` and never contain
 * credential material, upstream diagnostic text, attempt `lastError` or
 * tokens; an attempt id is never echoed back.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.connection` (HostConnectionHandle) into this program.
import type {} from '@deepseek-ai/dsh-client-connection'
import { RuntimeActionError, type ManagerHandle } from './manager.js'
import type { HostLogger } from './log.js'
import { SERVER_NAME_PATTERN } from './shared/model.js'
import {
  MCP_SCOPE_ACTION_PATH,
  MCP_SCOPE_STATUS_PATH,
  MCP_SCOPE_TOOLS_PATH,
  type RuntimeActionErrorCode,
  type RuntimeActionRequest,
  type ToolListView,
} from './shared/wire.js'

/** Exact Fetch routes this plugin owns below `/api` (re-exported wire constants). */
export { MCP_SCOPE_STATUS_PATH, MCP_SCOPE_ACTION_PATH, MCP_SCOPE_TOOLS_PATH }

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

const failure = (code: string, message: string, status: number): Response =>
  json({ ok: false, error: { code, message } }, status)

/** One shared wording for every out-of-contract server-name field (body or query). */
const SERVER_NAME_ERROR_MESSAGE = 'server must be 1-32 chars of [A-Za-z0-9_-]'

/** One shared wording for every out-of-contract attempt id (opaque; never echoed). */
const ATTEMPT_ID_ERROR_MESSAGE = 'attemptId must be 1-64 chars of [A-Za-z0-9-]'

/**
 * Accepted attempt-id grammar: the upstream ids are opaque UUIDs, so the route
 * only bounds the shape (never parses or echoes it). A value outside this
 * grammar is a bad request, never a business no-op.
 */
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/** The seven frozen action kinds accepted by the action route. */
const ACTION_KINDS = new Set<string>([
  'connect',
  'disconnect',
  'restart',
  'test',
  'authorize',
  'cancel-authorization',
  'sign-out',
])

/** Business failure of a server-name field outside the contract. */
const badServerName = (): Response => failure('bad-request', SERVER_NAME_ERROR_MESSAGE, 400)

/** Status code of one business failure code (default 500). */
function statusOf(code: RuntimeActionErrorCode): number {
  switch (code) {
    case 'bad-request':
      return 400
    case 'not-found':
      return 404
    case 'not-connected':
      return 409
    case 'disabled':
      return 409
    case 'conflict':
      return 409
    case 'cleanup':
      return 409
    case 'config':
      return 409
    case 'load':
      return 409
    case 'oauth-not-configured':
      return 409
    case 'oauth-unavailable':
      return 409
    case 'oauth-busy':
      return 409
    case 'oauth-required':
      return 409
    // A failed attempt and an unsettled cleanup are server-side failures (the
    // browser only gets the fixed code), matching the official manager.
    case 'oauth-failed':
    case 'oauth-cleanup':
    default:
      return 500
  }
}

/** Fold one thrown action failure into the wire's business result. */
function actionFailure(error: unknown): Response {
  if (error instanceof RuntimeActionError) return failure(error.code, error.message, statusOf(error.code))
  return failure('internal', 'action failed', 500)
}

/**
 * Validate one action id against {@link ATTEMPT_ID_PATTERN}: opaque, bounded and
 * never echoed back (upstream attempt ids are branded opaque values).
 */
function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value)
}

/** Decode the JSON action body without letting a bad body reject the route. */
async function readActionBody(request: Request): Promise<RuntimeActionRequest | Response> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return failure('bad-request', 'invalid JSON body', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('bad-request', 'body must be a JSON object', 400)
  }
  const body = parsed as { action?: unknown; server?: unknown; attemptId?: unknown }
  if (typeof body.server !== 'string' || !SERVER_NAME_PATTERN.test(body.server)) {
    return badServerName()
  }
  if (typeof body.action !== 'string' || !ACTION_KINDS.has(body.action)) {
    return failure('bad-request', 'unknown action', 400)
  }
  const action = body.action as RuntimeActionRequest['action']
  if (body.attemptId !== undefined && !isAttemptId(body.attemptId)) {
    return failure('bad-request', ATTEMPT_ID_ERROR_MESSAGE, 400)
  }
  if (action === 'cancel-authorization' && body.attemptId === undefined) {
    return failure('bad-request', 'cancel-authorization requires an attemptId', 400)
  }
  return {
    action,
    server: body.server,
    ...(body.attemptId === undefined ? {} : { attemptId: body.attemptId }),
  }
}

/**
 * Register the three runtime routes when the Connection carrier is present.
 * The nested `ctx.inject` keeps headless hosts (no web carrier) fully
 * functional: the routes simply never mount and the browser UI degrades to
 * "runtime status unavailable". Disposers are fiber-owned (HMR-safe).
 */
export function registerMcpScopeRoutes(ctx: Context, manager: ManagerHandle, logger?: HostLogger): void {
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
            // full-document view.
            const server = new URL(request.url).searchParams.get('server')
            if (server !== null && server !== '' && !SERVER_NAME_PATTERN.test(server)) {
              return Promise.resolve(badServerName())
            }
            try {
              const value = server === null || server === ''
                ? manager.runtimeStatus()
                : manager.runtimeStatus(server)
              return Promise.resolve(json({ ok: true, value }))
            } catch (error) {
              // Never throw into the carrier: a failed read folds into the same
              // business envelope every other route uses.
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
                case 'restart':
                  return json({ ok: true, value: await manager.restart(body.server) })
                case 'test':
                  return json({ ok: true, value: await manager.test(body.server) })
                case 'authorize':
                  // The manager performs a bounded wait (outside its mutation
                  // chain) for the attempt to reach waiting-browser, so the
                  // response carries the page URL the browser must open.
                  return json({ ok: true, value: await manager.authorize(body.server) })
                case 'cancel-authorization':
                  // The body validation guarantees the id for this action.
                  return json({ ok: true, value: await manager.cancelAuthorization(body.server, body.attemptId as string) })
                case 'sign-out':
                  return json({ ok: true, value: await manager.signOut(body.server) })
                default:
                  return failure('bad-request', 'unknown action', 400)
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
              const listed: ToolListView | undefined = manager.toolList(server)
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
