/**
 * dsh-chamber-mcp — host half plugin entry (also the package main).
 *
 * Manages MCP servers per workspace: the plugin's own Loader-entry Config is
 * the `mcp-scope` document — servers (stdio / streamable-http), per-workspace
 * explicit ENABLES (off by default) and global off-switches — and every field
 * is volatile, so a Settings write commits into the RUNNING fiber's references
 * instead of remounting the plugin. Each server is supervised by a per-server
 * supervisor ({@link ./manager.js}) mirroring the official mcp-client
 * reconnect semantics; tools are injected per-agent-scope (never globally)
 * into the tool scopes of live agents whose session cwd belongs to an enabled
 * workspace ({@link ./agents.js}).
 *
 * Namespace plugin shape: named exports `name` / `inject` / `Config` /
 * `apply`, no default export. `apply` returns fast — activation is NOT gated
 * on MCP connects; per-server connect runs asynchronously.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createManager, type ManagerHandle } from './manager.js'
import { registerMcpScopeRoutes } from './routes.js'
import { Config, readDocument, type McpScopeConfig } from './schema.js'

// The entry's Config export (also the settings form schema: every field is
// volatile, so form writes commit in place and never restart the plugin).
export { Config }
// Public type surface for typed consumers (FE-10 host side).
export type { ConfigField, McpScopeConfig } from './schema.js'
export type {
  McpScopeDoc,
  ServerDef,
  StdioServerDef,
  StreamableHttpServerDef,
  WorkspaceOverrides,
} from './shared/model.js'
// Side-effect type imports: ctx.tools / ctx.settings / ctx.credentials merges
// and the loader's Events merge ('loader/volatile-update').
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Cordis plugin name used by loader diagnostics (also the record scope). */
export const name = 'mcp-scope'

/** Services required by this plugin (Settings is an optional child below). */
export const inject = ['credentials', 'tools', 'workspaceRegistry', 'agents']

/**
 * Live single-instance reservations per app root: one mcp-scope instance per
 * `ctx.root`. A duplicate plugin activation is a configuration error surfaced
 * loudly at load, never silent shadowing.
 */
const activeRoots = new WeakSet<Context>()

/**
 * Apply the host half. Fast-returning: wires the config references, then
 * creates the bridge manager whose supervisors connect asynchronously.
 *
 * @param ctx - plugin context carrying credentials/tools/agents.
 * @param config - resolved plugin Config: the three document fields as live
 * volatile references (0.1.7) or plain values (tests).
 */
export async function apply(ctx: Context, config: McpScopeConfig): Promise<void> {
  // Fail loud at load: duplicate plugin activation is a configuration error.
  ctx.effect(() => {
    if (activeRoots.has(ctx.root)) {
      throw new Error('mcp-scope: already active for this application root — a second activation is a configuration error')
    }
    activeRoots.add(ctx.root)
    return () => void activeRoots.delete(ctx.root)
  }, 'mcp-scope.instance')

  // The bridge manager: per-server supervisors + per-agent applier. It reads
  // the LIVE Config references per operation (never a startup snapshot, and
  // never a stale thunk after a volatile commit). Its own effect owns the
  // credential listener and teardown; disposing it stops every supervisor and
  // revokes live registrations.
  const manager: ManagerHandle = createManager({
    ctx,
    logger: ctx.logger,
    getDoc: () => readDocument(config),
    credentials: ctx.credentials,
  })

  ctx.effect(() => {
    return () => manager.dispose()
  }, 'mcp-scope.manager')

  // Runtime status/actions ride the Connection carrier when one exists (web
  // deployments); headless hosts simply never mount the routes.
  registerMcpScopeRoutes(ctx, manager, ctx.logger)

  // The loader applies an entry's Config by CREATING its fiber, and
  // `loader/volatile-update` is emitted only for an in-place volatile commit —
  // so boot, a profile reload or an HMR restart with servers already configured
  // produces no event at all. This initial pass is what starts them; later
  // writes arrive through the listener below (or a fresh activation, when the
  // commit had to restart the entry).
  manager.reconcile()

  // 0.1.7 live settings: a volatile-only profile-config write commits the new
  // values into the running fiber's references IN PLACE and dispatches
  // `loader/volatile-update` to the owning fiber — reconciling here applies
  // the change without a remount, and untouched servers keep their connection.
  ctx.effect(
    () => ctx.on('loader/volatile-update', () => manager.reconcile()),
    'mcp-scope: live config',
  )

  // This entry's custom `settings.section` page is its only editor: suppress
  // the schema-derived automatic page (otherwise Settings would show a second,
  // redundant form). The dependency is optional — a composition without
  // Settings still runs the bridge.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
