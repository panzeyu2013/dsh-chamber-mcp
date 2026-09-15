/**
 * Injected-tools notice contract (browser half).
 *
 * The plugin injects no PROSE into the model context, so nothing in the
 * transcript showed that MCP tools are part of a session's context. The notice
 * closes that gap with ONE line in the conversation lane — and it is DERIVED,
 * never written.
 *
 * An earlier revision had the host append a private `mcp-scope/injected` session
 * event. That is the one thing a third-party plugin must not do on this
 * generation: the persisted envelope's `ignorable?: true` marker is the only
 * way a reader may skip an event type it does not know, and 0.1.5-rc.2 has no
 * write path that can set it — `Session.append` composes `type`/`seq`/`time`/
 * `data` plus surface metadata and nothing else. A private REQUIRED event
 * therefore makes the whole log unreadable: `validateStoredEvents` refuses any
 * log carrying a type outside the build-generated `KNOWN_SESSION_EVENT_TYPES`
 * set unless the stored envelope says `ignorable: true`, so even the harness
 * that wrote the event can no longer open that session. Out-of-repo plugin
 * types are outside that set by construction (see upstream
 * `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`
 * and `SessionEvent.ignorable` in `@deepseek-ai/dsh-session/types`).
 *
 * The notice therefore reads the harness's own `request/header` events, whose
 * `header.tools` is the complete model-facing tool array of that request. The
 * row is truthful (it shows exactly the MCP tools the request carried), durable
 * (it survives a reload from the stored log), and harmless (the plugin writes
 * nothing into a session). Public names are grouped by the server that owns
 * them with the same longest-configured-prefix rule the tool-row lane uses,
 * because a serverName contract that allows `_` cannot be split reliably.
 *
 * @module
 */

import { MCP_TOOL_PREFIX, type ServerDef } from '../shared/model.js'
import { identifyMcpTool } from './tool-card/names.js'

/** Chat-node kind the browser half renders the notice under. */
export const MCP_INJECTION_NODE_KIND = 'mcp-scope-injected'

/** One injected server and how many tools it contributed. */
export interface InjectionServer {
  name: string
  toolCount: number
}

/** Normalized payload of one injection notice. */
export interface InjectionPayload {
  servers: readonly InjectionServer[]
  total: number
}

/**
 * Read a notice payload defensively: anything malformed yields `undefined`, and
 * the caller then renders nothing (the lane must never throw into a session).
 *
 * @param data - rendered node payload.
 * @returns the normalized payload, or undefined when it is unusable.
 */
export function readInjectionPayload(data: unknown): InjectionPayload | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const servers = (data as { servers?: unknown }).servers
  if (!Array.isArray(servers)) return undefined
  const entries: InjectionServer[] = []
  for (const raw of servers) {
    if (raw === null || typeof raw !== 'object') continue
    const name = (raw as { name?: unknown }).name
    if (typeof name !== 'string' || name === '') continue
    const count = (raw as { toolCount?: unknown }).toolCount
    entries.push({ name, toolCount: typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0 })
  }
  if (entries.length === 0) return undefined
  return { servers: entries, total: entries.reduce((sum, entry) => sum + entry.toolCount, 0) }
}

/**
 * Collect the MCP servers one `request/header` event offered the model.
 *
 * `header.tools` carries every model-facing tool schema, so the `mcp__…`
 * names in it are exactly the tools this plugin injected into that request.
 * Non-MCP names are ignored, hostile shapes are skipped, and the result is
 * sorted by server name so the rendered line never depends on list order.
 *
 * @param data - `request/header` event data (untrusted).
 * @param servers - live configured servers, for longest-prefix ownership.
 * @returns one entry per owning server, empty when the request carried none.
 */
export function injectionServersOfHeader(data: unknown, servers: readonly ServerDef[] = []): InjectionServer[] {
  if (data === null || typeof data !== 'object') return []
  const header = (data as { header?: unknown }).header
  if (header === null || typeof header !== 'object') return []
  const tools = (header as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  const counts = new Map<string, number>()
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const name = (tool as { name?: unknown }).name
    if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) continue
    const identity = identifyMcpTool(name, servers)
    if (identity === undefined) continue
    counts.set(identity.serverName, (counts.get(identity.serverName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, toolCount]) => ({ name, toolCount }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Signature of one injected set: the notice's change key. Two headers with the
 * same signature offered the same MCP tools, so the second one adds no row.
 *
 * @param servers - the servers one request carried.
 * @returns a stable, order-independent signature.
 */
export function injectionSignature(servers: readonly InjectionServer[]): string {
  return servers.map((server) => server.name + ':' + String(server.toolCount)).join(',')
}
