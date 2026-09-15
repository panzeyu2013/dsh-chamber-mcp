/**
 * Tool bridge (host half): derives the model-facing public name of an MCP
 * tool and builds the {@link ToolDefinition} generation for one MCP server.
 *
 * The naming contract and the definition/executor semantics MIRROR the
 * official `@deepseek-ai/dsh-mcp-client` plugin exactly (see
 * docs/recon/mcp-client-official.md §3): every MCP tool has the stable
 * identity `(serverName, rawName)`; the model-facing public name is
 * `mcp__<serverName>__<rawName>` normalized to the DeepSeek function-name
 * contract (≤64 chars of `[A-Za-z0-9_-]`), with a 12-hex SHA-256 identity
 * suffix appended whenever normalization is lossy. The raw name is the only
 * thing ever sent in `tools/call`; public names are never parsed back.
 *
 * Unlike the official plugin (which registers into the registry layer of its
 * own context), this plugin never registers globally: defs live in the
 * per-server supervisor's master state and are registered per-agent-scope by
 * {@link ./agents.ts} through each live agent's `agent.ctx`. The definition
 * BUILD step is therefore separated from any registration step.
 *
 * Intentional deviation (documented in docs/host-notes.md): the rc.1 image
 * bridge is skipped — image/audio/resource content degrades to text
 * placeholders, as in official rc.5.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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
 * Hard cap on one server's tool count. The official bridge mirrors
 * pagination unboundedly; this one bounds it so a misbehaving server cannot
 * drive unbounded per-agent registration fan-out (SEC-05). Crossing the cap
 * fails the sync like any fetch-phase failure: the previous generation stays.
 */
export const MAX_SYNC_TOOLS = 2000

/**
 * Hard cap on one sync's `tools/list` request count (SEC-05). The tool cap
 * above cannot bound a server that answers with EMPTY pages while minting a
 * fresh cursor each time — no name repeats and no tool accumulates, so the
 * loop would issue requests forever. One page per tool is already
 * pathological, so this caps no server the tool cap does not; it only closes
 * the unbounded case. Crossing it fails the sync like any fetch-phase failure.
 */
export const MAX_SYNC_PAGES = MAX_SYNC_TOOLS

/** Default timeout for individual MCP tool calls (ms) — official default. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = TIMEOUT_DEFAULT_MS

/** Canonical MCP result shape exposed by executors (same as official McpResult). */
export interface McpResult<Structured extends JsonValue = JsonValue> {
  content: JsonValue[]
  structuredContent?: Structured
}

/** Raw result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** Options shared by the definition build for one MCP server. */
export interface ToolBridgeOptions {
  /** Stable local namespace from the document (serverName). */
  serverName: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
}

/** The exact live definition generation owned by one server: publicName → definition. */
export type ToolDefinitions = ReadonlyMap<string, ToolDefinition>

/** Identity + copy line of one listed tool (for the runtime status tool list). */
export interface ListedToolInfo {
  publicName: string
  rawName: string
  description: string
}

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

/** List one `tools/list` page without mutating the SDK's validator cache. */
function listToolsUncached(client: Client, opts: ToolBridgeOptions, cursor?: string) {
  return client.request(
    { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListToolsResultSchema,
    { timeout: opts.toolCallTimeoutMs },
  )
}

/** Call one tool without the SDK pre-validating an output schema we may not support. */
function callToolUncached(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  exec: ToolRunContext,
  opts: ToolBridgeOptions,
) {
  return client.request(
    { method: 'tools/call', params: { name: rawName, arguments: args } },
    RawCallToolResultSchema,
    {
      signal: exec.signal,
      timeout: opts.toolCallTimeoutMs,
    },
  )
}

/**
 * Fetch the full tool list (paginated, uncached raw `tools/list`) and build
 * the complete next generation of {@link ToolDefinition}s under public names.
 * Pure build — nothing is registered anywhere. A duplicate raw name in the
 * server's list rejects the whole fetch, and so do a repeated continuation
 * cursor and a page count past {@link MAX_SYNC_PAGES} (either would otherwise
 * let an invalid list spin this loop forever); failures leave any previous
 * generation untouched (the supervisor owns that discipline).
 *
 * @param client - Connected MCP Client used to list tools (and later to call them).
 * @param opts - Server namespace and per-call timeout.
 * @returns publicName → definition for every listed tool, in list order.
 */
export async function fetchToolDefinitions(
  client: Client,
  opts: ToolBridgeOptions,
  /** Optional sink for one listed tool's identity; consulted only on success. */
  onListed?: (info: ListedToolInfo) => void,
): Promise<Map<string, ToolDefinition>> {
  const definitions = new Map<string, ToolDefinition>()
  // Every cursor already followed: a repeated one can never terminate the
  // loop, so it is a protocol violation rather than a page to fetch.
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    // The duplicate-cursor guard cannot bound a server that keeps minting
    // FRESH cursors over empty pages, so the request count is capped too. One
    // page per tool is already pathological, so this bounds no server the tool
    // cap does not — it only removes the unbounded case.
    if (++pages > MAX_SYNC_PAGES) {
      throw new Error(
        `mcp-scope(${opts.serverName}): server paginated past ${MAX_SYNC_PAGES} tools/list pages — refusing the sync`,
      )
    }
    const response = await listToolsUncached(client, opts, cursor)
    for (const tool of response.tools) {
      const publicName = publicToolName(opts.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(
          `mcp-scope(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
        )
      }
      onListed?.({ publicName, rawName: tool.name, description: tool.description ?? '' })
      if (definitions.size >= MAX_SYNC_TOOLS) {
        throw new Error(
          `mcp-scope(${opts.serverName}): server lists more than ${MAX_SYNC_TOOLS} tools — refusing the sync`,
        )
      }
      definitions.set(publicName, createDefinition(client, publicName, tool, opts))
    }
    cursor = response.nextCursor
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(
          `mcp-scope(${opts.serverName}): server repeated a tools/list continuation cursor — invalid tool list`,
        )
      }
      seenCursors.add(cursor)
    }
  } while (cursor)
  return definitions
}

/** The MCP `Tool` fields the bridge consumes; SDK-declared fields guarded at runtime. */
export interface ListedTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

/**
 * Build one {@link ToolDefinition} from a listed MCP tool. The MCP
 * `inputSchema` passes through unchanged (no conversion); `output` declares
 * the canonical `{content, structuredContent?}` result (structuredContent
 * only when the advertised `outputSchema` passes the registry's supported
 * JSON-schema check); the executor sends an uncached raw `tools/call` with
 * the raw MCP name, forwarding `exec.signal` and the per-call timeout.
 */
export function createDefinition(
  client: Client,
  publicName: string,
  tool: ListedTool,
  opts: ToolBridgeOptions,
): ToolDefinition {
  return {
    name: publicName,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
    output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
    execute: createExecutor(client, tool.name, tool.execution?.taskSupport === 'required', opts),
  }
}

/**
 * The shape we read from each MCP content block. Intentionally looser than
 * the SDK's `ContentBlock`: we are at a network trust boundary, so fields the
 * SDK declares required may be absent if the server is buggy.
 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  uri?: string
  name?: string
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to unconstrained. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate as JsonSchemaNode
  } catch {
    return undefined
  }
}

/** Build the canonical result schema and the Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/**
 * Create the execute function for one MCP tool. Closes over the raw MCP tool
 * name and sends an uncached `tools/call` request with it (never the public
 * name), with abort signal and timeout, then maps the result to the canonical
 * `{content, structuredContent?}` value. `isError: true` throws so the
 * ToolRuntime catch path produces a failed `isError` result for the model.
 */
function createExecutor(
  client: Client,
  rawName: string,
  taskRequired: boolean,
  opts: ToolBridgeOptions,
): ToolDefinition['execute'] {
  return async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // Non-object args (model misbehavior) → {} so the server produces the
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const result = await callToolUncached(client, rawName, argsObj, exec, opts)

    // Legacy `toolResult` shape → normalize to a single text block.
    if (!Array.isArray(result.content)) {
      const rendered: unknown = 'toolResult' in result
        ? JSON.stringify(result.toolResult)
        : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result.isError === true) throw new Error(text)
      return {
        content: [{ type: 'text', text }],
        ...result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as JsonValue }
          : {},
      }
    }

    // Trust boundary: validate every content element defensively.
    const content = result.content as unknown as JsonValue[]
    const text = extractText(content, rawName)
    if (result.isError === true) throw new Error(text)
    return {
      content,
      ...result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent as JsonValue }
        : {},
    }
  }
}

/**
 * Extract text from an MCP content array into a single string:
 * - `text` blocks join with `'\n'`;
 * - `image`/`audio`/`resource`/`resource_link` blocks are replaced with
 *   placeholders (the canonical value keeps the raw blocks; the rc.1 image
 *   bridge to attachments is intentionally not implemented);
 * - unknown/primitive blocks get a diagnostic line;
 * - an empty result falls back to `(<rawName> returned no text content)`.
 *
 * Defensive: fields the MCP spec declares required are guarded because this
 * is a network trust boundary.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const parts: string[] = []

  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
        parts.push('[resource: content discarded]')
        break
      case 'resource_link':
        parts.push(`Resource link: ${block.name ?? 'unnamed'} (${block.uri ?? 'no uri'})`)
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }

  return parts.join('\n') || `(${toolName} returned no text content)`
}

/**
 * Text projection shared by definition renders: exposed for unit tests.
 * Not part of the public plugin API beyond this module.
 */
export function renderResultText(content: JsonValue[], toolName: string): string {
  return extractText(content, toolName)
}
