/**
 * dsh-chamber-mcp — host half plugin entry (also the package main).
 *
 * Manages MCP servers per workspace: a settings namespace document
 * (`mcp-scope`) defines servers (stdio / streamable-http) and per-workspace
 * explicit off-switches; each server is supervised by a per-server supervisor
 * ({@link ./manager.js}) mirroring the official mcp-client reconnect
 * semantics; tools are injected per-agent-scope (never globally) into the
 * tool scopes of live agents whose session cwd belongs to an enabled
 * workspace ({@link ./agents.js}).
 *
 * Namespace plugin shape: named exports `name` / `inject` / `Config` /
 * `apply`, no default export. `apply` returns fast — activation is NOT gated
 * on MCP connects; per-server connect runs asynchronously.
 *
 * @module dsh-chamber-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createManager, type ManagerHandle } from './manager.js'
import { DocumentSchema } from './schema.js'
import { EMPTY_DOC, validateDoc, type McpScopeDoc } from './shared/model.js'
// Public type surface for typed consumers (FE-10 host side).
export type {
  McpScopeDoc,
  ServerDef,
  StdioServerDef,
  StreamableHttpServerDef,
  WorkspaceOverrides,
  WorkspaceOverrides as WorkspaceOverridesAlias,
} from './shared/model.js'
// Side-effect type imports: ctx.tools / ctx.settings / ctx.credentials merge.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name used by loader diagnostics (also the record scope). */
export const name = 'mcp-scope'

/** Services required by this plugin. */
export const inject = ['settings', 'credentials', 'tools', 'workspaceRegistry', 'agents']

/** Composition config: none — the whole surface is the settings namespace. */
export const Config = z.object({})

/**
 * Live single-instance reservations per app root: one mcp-scope instance per
 * `ctx.root`. A duplicate plugin activation is a configuration error surfaced
 * loudly at load, never silent shadowing.
 */
const activeRoots = new WeakSet<Context>()

/**
 * Apply the host half. Fast-returning: registers the settings namespace, then
 * creates the bridge manager whose supervisors connect asynchronously.
 *
 * @param ctx - plugin context carrying settings/credentials/tools/agents.
 * @param config - composition config (empty by schema).
 */
export async function apply(ctx: Context, _config: unknown): Promise<void> {
  // Fail loud at load: duplicate plugin activation is a configuration error.
  ctx.effect(() => {
    if (activeRoots.has(ctx.root)) {
      throw new Error('mcp-scope: already active for this application root — a second activation is a configuration error')
    }
    activeRoots.add(ctx.root)
    return () => void activeRoots.delete(ctx.root)
  }, 'mcp-scope.instance')

  // The settings source of truth: the LIVE thunk handed by setSource (read
  // per operation, never snapshotted — settings reads are per-op).
  let currentSource: () => McpScopeDoc = () => EMPTY_DOC

  // The bridge manager: per-server supervisors + per-agent applier. Its own
  // effect owns the credential listener and teardown; disposing it stops
  // every supervisor and revokes live registrations.
  const manager: ManagerHandle = createManager({
    ctx,
    logger: ctx.logger,
    getDoc: () => currentSource(),
    credentials: ctx.credentials,
  })

  ctx.effect(() => {
    return () => manager.dispose()
  }, 'mcp-scope.manager')

  ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, EMPTY_DOC, {
    setSource: (source) => {
      currentSource = source
    },
    onChange: () => {
      manager.reconcile()
    },
    validate: (doc) => {
      const errors = validateDoc(doc)
      if (errors.length > 0) {
        throw new Error(`mcp-scope: refusing document write: ${errors.join('; ')}`)
      }
    },
  })
}
