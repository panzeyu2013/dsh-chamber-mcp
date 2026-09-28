/**
 * Tool bridge (host half): derives the model-facing public name of an MCP tool
 * and builds the {@link ToolDefinition} generation for one MCP server.
 *
 * The naming contract MIRRORS the official plugin exactly: every MCP tool has
 * the stable identity `(serverName, rawName)`; the model-facing public name is
 * `mcp__<serverName>__<rawName>` normalized to the DeepSeek function-name
 * contract (≤64 chars of `[A-Za-z0-9_-]`), with a 12-hex SHA-256 identity
 * suffix appended whenever normalization is lossy. The raw name is the only
 * thing ever sent in `tools/call`; public names are never parsed back.
 *
 * The definition BUILD is the OFFICIAL `createMcpToolDefinition` from
 * `@deepseek-ai/dsh-mcp-client` — the supported generations (dsh 0.1.7 / 0.2.0).
 * It owns canonical result validation, `taskRequired` refusal, `isError` →
 * throw and DURABLE IMAGE ADMISSION: an image block becomes an attachment when
 * the composition provides an attachment store and the current model route
 * declares image input, otherwise it projects a diagnostic text. On 0.1.7 the
 * projection hook it installs is `projectContent` (run before
 * `tools/post-execute` policies), not the 0.1.6-era `finalizeContent`.
 *
 * The package is imported DYNAMICALLY and memoized: a composition without
 * `@deepseek-ai/dsh-mcp-client` fails the server's tool sync with a reported
 * reason instead of failing the whole plugin load (a static named import of a
 * missing package/export would be a link-time error). There is deliberately no
 * local port of the adapter anymore — supporting the generation that lacked
 * the export was dropped together with the 0.1.5/0.1.6 peer range.
 *
 * Two deliberate differences from the official bridge:
 *
 * 1. Registration is NOT ours here. Unlike the official plugin (which registers
 *    into the registry layer of its own context), defs live in the per-server
 *    supervisor's master state and are registered per-agent-scope by
 *    {@link ./agents.ts} through each live agent's `agent.ctx`. The definition
 *    BUILD step is therefore separated from any registration step — which is
 *    exactly the split `createMcpToolDefinition` was extracted for (it returns
 *    an UNREGISTERED definition; registration, lifetime, deadlines and
 *    transport belong to the caller).
 * 2. A total tool cap ({@link MAX_SYNC_TOOLS}) bounds per-agent registration
 *    fan-out (SEC-05). Upstream has no equivalent: `listMaxPages` bounds
 *    pages, not listed tools.
 *
 * The 2.0 client aggregates `tools/list` itself (one call, no caller-owned
 * cursor loop). The old hand-rolled pagination, repeated-cursor guard and
 * legacy `toolResult` normalization are gone with the legacy SDK: the
 * non-converging-cursor defence is the client's `listMaxPages` (default 64)
 * and a 2025-era `toolResult` frame cannot reach this path any more.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client, Tool } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { HASH_LENGTH, MAX_PUBLIC_NAME_LENGTH, MCP_TOOL_PREFIX, TIMEOUT_DEFAULT_MS } from './shared/model.js'

/**
 * Re-exported naming-contract constants. They live in the shared pure model so
 * the browser half can derive tool identity from a public name without
 * importing this host module (`node:crypto` must never reach the client
 * bundle); the names stay exported here because host consumers and
 * `tests/tools.spec.ts` import them from this module.
 */
export { HASH_LENGTH, MAX_PUBLIC_NAME_LENGTH } from './shared/model.js'

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/**
 * Hard cap on one server's tool count. The 2.0 client aggregates every
 * `tools/list` page inside one call under its own page cap
 * (`listMaxPages`, default 64), but nothing bounds the TOTAL number of listed
 * tools — a server answering 64 pages of 1000 tools would drive unbounded
 * per-agent registration fan-out. Crossing the cap fails the sync like any
 * fetch-phase failure: the previous generation stays.
 */
export const MAX_SYNC_TOOLS = 2000

/** Default timeout for individual MCP tool calls (ms) — official default. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = TIMEOUT_DEFAULT_MS

/** Options shared by the definition build for one MCP server. */
export interface ToolBridgeOptions {
  /** Stable local namespace from the document (serverName). */
  serverName: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Diagnostics sink; used at most once per process for an unavailable adapter. */
  log?: (message: string) => void
}

/** The exact live definition generation owned by one server: publicName → definition. */
export type ToolDefinitions = ReadonlyMap<string, ToolDefinition>

/** Identity + copy line of one listed tool (for the runtime status tool list). */
export interface ListedToolInfo {
  publicName: string
  rawName: string
  description: string
}

/** Everything the definition builder needs for one listed tool. */
export interface DefinitionBuildInput {
  /** Plugin context the official adapter resolves attachments/llm from. */
  ctx: Context
  /** Connected client used for the caller-owned `tools/call` verb. */
  client: Client
  /** The model-facing public name already derived for this tool. */
  publicName: string
  /** The tool exactly as the 2.0 client listed it. */
  tool: Tool
  /** Server namespace and per-call timeout. */
  opts: ToolBridgeOptions
}

/** Builds one UNREGISTERED definition. */
export type DefinitionBuilder = (input: DefinitionBuildInput) => ToolDefinition

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)` — verbatim mirror of
 * the official algorithm (pinned contract: changing it would break session
 * history and permission rules). The clean case is `mcp__<serverName>__<rawName>`
 * unchanged; when character replacement or truncation to the function-name
 * contract changes the name, a 12-hex-char SHA-256 hash of the identity
 * string `serverName\0rawName` is appended so distinct MCP identities never
 * collapse into one public name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `${MCP_TOOL_PREFIX}${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

// ---- Official adapter ----

/** Memoized process-wide resolution of the official definition builder. */
let resolvedBuilder: Promise<DefinitionBuilder> | undefined

/**
 * Resolve the OFFICIAL definition builder once per process. The import is
 * dynamic so a composition without `@deepseek-ai/dsh-mcp-client` (or on a
 * build that dropped the export) fails at TOOL SYNC with a reported reason
 * instead of failing the plugin load. A failed resolution is not memoized, so
 * a later sync retries it.
 */
export function definitionBuilder(): Promise<DefinitionBuilder> {
  resolvedBuilder ??= import('@deepseek-ai/dsh-mcp-client')
    .then((namespace) => {
      const adapter = (namespace as { createMcpToolDefinition?: unknown }).createMcpToolDefinition
      if (typeof adapter !== 'function') {
        throw new Error('@deepseek-ai/dsh-mcp-client does not export createMcpToolDefinition (dsh 0.1.7 or newer is required)')
      }
      const create = adapter as (ctx: Context, options: McpToolDefinitionOptions) => ToolDefinition
      return (input: DefinitionBuildInput): ToolDefinition => create(input.ctx, {
        name: input.publicName,
        rawName: input.tool.name,
        description: input.tool.description ?? '',
        inputSchema: input.tool.inputSchema,
        outputSchema: input.tool.outputSchema,
        taskRequired: input.tool.execution?.taskSupport === 'required',
        // The adapter owns canonical projection, output validation and durable
        // image admission; the caller owns the verb (2.0 `callTool`), the deadline
        // and the cancellation signal.
        call: (args, execution) => input.client.callTool(
          { name: input.tool.name, arguments: args },
          { signal: execution.signal, timeout: input.opts.toolCallTimeoutMs, toolDefinition: input.tool },
        ),
      })
    })
    .catch((error: unknown) => {
      resolvedBuilder = undefined
      throw error
    })
  return resolvedBuilder
}

/** Whether the adapter-unavailable notice has already been reported in this process. */
let adapterFailureReported = false

/**
 * List the server's tools and build the complete next generation of
 * {@link ToolDefinition}s under public names. Pure build — nothing is
 * registered anywhere.
 *
 * The listing is capability-gated (a server that does not advertise `tools`
 * contributes no tools) and aggregated by the client in ONE
 * `listTools` call; a duplicate public name rejects the whole fetch, and so
 * does a list longer than {@link MAX_SYNC_TOOLS}. Failures leave any previous
 * generation untouched (the supervisor owns that discipline). An unavailable
 * official adapter is reported once per process through `opts.log`, then the
 * error propagates to the supervisor's own sync-failure path.
 *
 * @param ctx - plugin context the official adapter resolves attachments/llm from.
 * @param client - Connected MCP client used to list tools (and later to call them).
 * @param opts - Server namespace and per-call timeout.
 * @param onListed - Optional sink for one listed tool's identity; consulted only on success.
 * @returns publicName → definition for every listed tool, in list order.
 */
export async function fetchToolDefinitions(
  ctx: Context,
  client: Client,
  opts: ToolBridgeOptions,
  onListed?: (info: ListedToolInfo) => void,
): Promise<Map<string, ToolDefinition>> {
  let build: DefinitionBuilder
  try {
    build = await definitionBuilder()
  } catch (error) {
    if (!adapterFailureReported && opts.log !== undefined) {
      adapterFailureReported = true
      opts.log(`mcp-scope(${opts.serverName}): the official MCP tool adapter is unavailable — no MCP tool can be built: ${String(error)}`)
    }
    throw error
  }
  return buildDefinitions(build, ctx, client, opts, onListed)
}

/**
 * Run ONE capability-gated, client-aggregated listing and build the next
 * definition generation with the given builder. Exported so the same
 * assertions can drive the official adapter through the REAL listing path (a
 * wiring that silently swapped builders would otherwise be invisible to the
 * suite).
 *
 * @param buildDefinition - The selected definition builder.
 * @param ctx - plugin context the official adapter resolves attachments/llm from.
 * @param client - Connected MCP client used to list tools.
 * @param opts - Server namespace, per-call timeout and optional log sink.
 * @param onListed - Optional sink for one listed tool's identity.
 * @returns publicName → definition for every listed tool, in list order.
 */
export async function buildDefinitions(
  buildDefinition: DefinitionBuilder,
  ctx: Context,
  client: Client,
  opts: ToolBridgeOptions,
  onListed?: (info: ListedToolInfo) => void,
): Promise<Map<string, ToolDefinition>> {
  const definitions = new Map<string, ToolDefinition>()
  const response = client.getServerCapabilities()?.tools === undefined
    ? { tools: [] }
    : await client.listTools(undefined, { cacheMode: 'refresh', timeout: opts.toolCallTimeoutMs })
  for (const tool of response.tools) {
    const publicName = publicToolName(opts.serverName, tool.name)
    if (definitions.has(publicName)) {
      throw new Error(
        `mcp-scope(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
      )
    }
    if (definitions.size >= MAX_SYNC_TOOLS) {
      throw new Error(
        `mcp-scope(${opts.serverName}): server lists more than ${MAX_SYNC_TOOLS} tools — refusing the sync`,
      )
    }
    onListed?.({ publicName, rawName: tool.name, description: tool.description ?? '' })
    definitions.set(publicName, buildDefinition({ ctx, client, publicName, tool, opts }))
  }
  return definitions
}
