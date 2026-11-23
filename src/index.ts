/**
 * dsh-chamber-mcp — host half plugin entry (also the package main).
 *
 * Manages MCP servers per workspace: the plugin's own Loader-entry Config is
 * the `mcp-scope` document — servers (stdio / streamable-http), per-workspace
 * explicit ENABLES (off by default), global off-switches and the exposed
 * client knobs — and every field is volatile, so a Settings write commits into
 * the RUNNING fiber's references instead of remounting the plugin.
 *
 * Every configured server is a per-definition SEAT: one child fiber owning the
 * capture façades + a private official `McpClientHost` ({@link ./server-fiber.js}),
 * driven by the bridge manager ({@link ./manager.js}). Tool definitions are
 * never registered globally: the applier ({@link ./agents.js}) fans a captured
 * generation into the tool scopes of live agents whose session cwd belongs to
 * an enabled workspace.
 *
 * Namespace plugin shape: named exports `name` / `inject` / `Config` /
 * `apply`, no default export. `apply` returns fast — activation is NOT gated
 * on MCP connects or on the upstream peer being installed; per-server seats fail
 * with a fixed `failed{load}` code instead.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { createManager, type ManagerHandle } from './manager.js'
import { registerMcpScopeRoutes } from './routes.js'
import { Config, readDocument, type McpScopeConfig } from './schema.js'
import { safeErrorText } from './log.js'
import { loadUpstreamMcpClient } from './upstream.js'

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
// Side-effect type imports: ctx.tools / ctx.settings / ctx.credentials /
// ctx.workspaceRegistry / ctx.agents merges and the loader's Events merge
// ('loader/volatile-update').
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Cordis plugin name used by loader diagnostics (also the record scope). */
export const name = 'mcp-scope'

/** Services required by this plugin (Settings is an optional child below). */
export const inject = ['credentials', 'tools', 'workspaceRegistry', 'agents']

/**
 * Live single-instance reservations per app root: one mcp-scope instance per
 * `ctx[Context.root]`. A duplicate plugin activation is a configuration error
 * surfaced loudly at load, never silent shadowing.
 */
const activeRoots = new WeakSet<Context>()

/** The structural shape of the official manager's read-only list projection. */
interface ManagedPlaneLike {
  list?(): unknown
}

/**
 * Names reserved by the official MCP manager plane (`ctx.mcpManager`), read
 * structurally so this plugin needs no devDependency on dsh-mcp-manager and a
 * composition without the official plane degrades to NO pre-check.
 *
 * @param ctx - plugin context.
 * @returns reserved server names (empty when the service is absent/broken).
 */
export function managedPlaneNames(ctx: Context): readonly string[] {
  try {
    const manager: unknown = ctx.get('mcpManager')
    if (manager === null || typeof manager !== 'object') return []
    const list = (manager as ManagedPlaneLike).list
    if (typeof list !== 'function') return []
    const entries: unknown = list.call(manager)
    if (!Array.isArray(entries)) return []
    const names: string[] = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const entryName = (entry as { name?: unknown }).name
      if (typeof entryName === 'string') names.push(entryName)
    }
    return names
  } catch {
    return []
  }
}



/**
 * Apply the host half. Fast-returning: wires the config references, the bridge
 * manager (whose seat mounts run asynchronously), the runtime routes and the
 * live-config listener.
 *
 * @param ctx - plugin context carrying credentials/tools/agents/workspaceRegistry.
 * @param config - resolved plugin Config: the document fields as live volatile
 *   references (0.1.7+) or plain values (tests).
 */
export async function apply(ctx: Context, config: McpScopeConfig): Promise<void> {
  // Fail loud at load: duplicate plugin activation is a configuration error.
  ctx.effect(() => {
    if (activeRoots.has(ctx[Context.root])) {
      throw new Error('mcp-scope: already active for this application root — a second activation is a configuration error')
    }
    activeRoots.add(ctx[Context.root])
    return () => void activeRoots.delete(ctx[Context.root])
  }, 'mcp-scope.instance')

  const getDoc = () => readDocument(config)

  // The bridge manager: per-definition seats (façades + one private official
  // host each) and the per-agent applier. It reads the LIVE Config references
  // per operation (never a startup snapshot). Its own effect owns the workspace
  // listener, the applier listeners and teardown; disposing it stops every
  // seat/instance and revokes live registrations.
  const manager: ManagerHandle = createManager({
    ctx,
    logger: ctx.logger,
    getDoc,
    upstream: loadUpstreamMcpClient,
    managedNames: () => managedPlaneNames(ctx),
  })

  ctx.effect(() => {
    return () => manager.dispose()
  }, 'mcp-scope.manager')

  // Boot diagnostic only: a missing peer must never fail plugin activation
  // (headless/partial compositions still serve the settings document); each
  // server mount then degrades with its own fixed code.
  void loadUpstreamMcpClient().catch((error: unknown) => {
    ctx.logger.warn('mcp-scope: the official MCP client host is unavailable at boot: ' + safeErrorText(error))
  })

  // Boot diagnostic only: an OAuth row needs the browser-authorization services
  // (the official flow resolves them through the seat host's owner context). A
  // headless composition still serves the settings document and the actions
  // degrade to a fixed `oauth-unavailable` business failure.
  try {
    const oauthConfigured = getDoc().servers.some(
      (def) => def.transport === 'streamable-http' && def.oauth !== undefined,
    )
    if (oauthConfigured && (ctx.get('authorization') === undefined || ctx.get('webServer') === undefined)) {
      ctx.logger.warn(
        'mcp-scope: OAuth is configured but browser authorization services are unavailable; authorize will answer oauth-unavailable',
      )
    }
  } catch (error) {
    ctx.logger.warn('mcp-scope: the OAuth availability probe failed: ' + safeErrorText(error))
  }

  // Runtime status/actions ride the Connection carrier when one exists (web
  // deployments); headless hosts simply never mount the routes.
  registerMcpScopeRoutes(ctx, manager, ctx.logger)

  // The loader applies an entry's Config by CREATING its fiber, and
  // `loader/volatile-update` is emitted only for an in-place volatile commit —
  // so boot, a profile reload or an HMR restart with servers already configured
  // produces no event at all. This initial pass is what starts them; later
  // writes arrive through the listener below (or a fresh activation).
  manager.reconcile()

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
