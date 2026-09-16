/**
 * Per-server context publication (host half): contributes one server's live
 * connection-owned context to the OPTIONAL consumers of this composition —
 * literally mirroring the official `registerServerContext` in
 * `@deepseek-ai/dsh-mcp-client`:
 *
 * - the server's literal `instructions` become a scoped system-prompt section
 *   named `mcp:<serverName>` at the centrally allocated `MCP_SERVERS` order,
 *   with interpolation OFF (instructions are literal text, not a template);
 * - the server's resource operations are registered as an
 *   `mcpResources` provider, so the service-owned shared resource tools
 *   (`list_mcp_resources` / `list_mcp_resource_templates` /
 *   `read_mcp_resource`) can reach this server without this plugin owning them.
 *
 * Both registrations ride `ctx.inject`, so a composition that never mounts
 * `systemPrompt`/`mcpResources` degrades to no contribution (and never loads
 * the callback at all). The returned disposer tears both down and is the ONLY
 * thing the manager has to remember per server.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
// Side-effect type import: declares `ctx.systemPrompt` on the cordis Context.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Connection-owned values one server publishes to the optional consumers. */
export interface ServerContext {
  /** Resource access through the current connection generation. */
  resources: McpResourceProvider
  /** The last established generation's attributed instructions ('' when none). */
  instructions(): string
}

/** Diagnostic sink (ctx.logger-compatible); kept optional for headless mounts. */
export interface ServerContextLogger {
  warn(message: string): void
}

/**
 * Publish one server's context to the services this composition enables.
 *
 * @param ctx - the owning plugin context (registration scope + effect owner).
 * @param server - configured server name, unique among live servers.
 * @param connection - live resource operations and instruction snapshot.
 * @param logger - optional diagnostics sink for a failed contribution.
 * @returns disposer that unloads both contributions (safe to call twice).
 */
export function registerServerContext(
  ctx: Context,
  server: string,
  connection: ServerContext,
  logger?: ServerContextLogger,
): () => Promise<void> {
  const created: Array<{ dispose(): Promise<void> | void }> = []
  /** A failed contribution must never surface as an unhandled rejection: the
  * composition contains the fiber, we only report it. */
  const contain = (fiber: { dispose(): Promise<void> | void }): void => {
    void Promise.resolve(fiber).catch((error: unknown) => {
      logger?.warn(`mcp-scope(${server}): a context contribution failed to load: ${String(error)}`)
    })
    created.push(fiber)
  }
  try {
    contain(ctx.inject(['systemPrompt'], (inner) => {
      // The allocation key doubles as the capability probe. 0.1.5 has no
      // MCP_SERVERS slot AND no literal-section rendering: its renderer always
      // interpolates, so a server instruction containing "{{...}}" would either
      // abort prompt assembly for the whole turn or be substituted with a host
      // variable. Publishing nothing there is what 0.1.5 shipped, so the
      // compatibility path stays safe by construction.
      const order = inner.systemPrompt.getSectionOrder('MCP_SERVERS')
      if (order === undefined) return
      inner.systemPrompt.section({
        name: `mcp:${server}`,
        order,
        interpolate: false,
        text: () => connection.instructions(),
      })
    }))
  } catch (error) {
    logger?.warn(`mcp-scope(${server}): could not contribute server instructions to the system prompt: ${String(error)}`)
  }
  try {
    contain(ctx.inject(['mcpResources'], (inner) => {
      inner.mcpResources.register(server, connection.resources)
    }))
  } catch (error) {
    logger?.warn(`mcp-scope(${server}): could not register MCP resource operations: ${String(error)}`)
  }
  return async () => {
    for (const fiber of created.reverse()) {
      try {
        await fiber.dispose()
      } catch (error) {
        logger?.warn(`mcp-scope(${server}): failed to unload a context contribution: ${String(error)}`)
      }
    }
  }
}
