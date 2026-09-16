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
 * The definition BUILD has TWO interchangeable implementations, selected once
 * per process from what the host generation provides:
 *
 * - **OFFICIAL** (preferred): `createMcpToolDefinition` from
 *   `@deepseek-ai/dsh-mcp-client` (0.1.6+). It owns canonical result
 *   validation, `taskRequired` refusal, `isError` → throw and DURABLE IMAGE
 *   ADMISSION — an image block becomes an attachment when the composition
 *   provides an attachment store and the current model route declares image
 *   input, otherwise it projects a diagnostic text.
 * - **LOCAL fallback** ({@link buildLocalToolDefinition}): the SAME behavior,
 *   implemented here because the host export does not exist. Its projection
 *   strings, empty-value semantics, result validation, image admission and
 *   `finalizeContent` hook are a verbatim port of the official adapter — the
 *   two builders differ only in which module's code executes, and
 *   `tests/tools.spec.ts` asserts that equivalence case by case.
 *
 * The adapter is reached through a NAMESPACE import on purpose. At 0.1.5 the
 * package exists but exports only `{Config, apply, inject, name}`, and a STATIC
 * named import of a missing export is an ESM link-time `SyntaxError` that fails
 * the whole cordis plugin tree (the host exits 1). Reading the property off the
 * namespace yields `undefined` and selects the fallback. The type-only import of
 * `McpToolDefinitionOptions` is erased at build time and therefore imposes no
 * runtime requirement either.
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
import { isDeepStrictEqual } from 'node:util'
import { specTypeSchemas } from '@modelcontextprotocol/client'
import type { Client, Tool } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-mcp-client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
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
  /**
   * Diagnostics sink. Used once per process to report that the host generation
   * does not provide the official adapter (a degraded content path is not
   * something an operator can otherwise diagnose).
   */
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

/** Everything either definition builder needs for one listed tool. */
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

/** Builds one UNREGISTERED definition; both implementations share this shape. */
export type DefinitionBuilder = (input: DefinitionBuildInput) => ToolDefinition

/** Whether the degraded-selection notice has already been reported in this process. */
let fallbackReported = false

/** The slice of `@deepseek-ai/dsh-mcp-client` this bridge looks for. */
export interface ToolAdapterNamespace {
  createMcpToolDefinition?: unknown
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

// ---- Local definition build (the pre-2.0 text projection) ----

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

/**
 * Build the canonical result schema and the text projection — byte-for-byte the
 * declaration the official adapter produces (schema, order of keys, presence
 * toggle and render), so a definition built here and one built by the adapter
 * are interchangeable to every consumer.
 */
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
      const result = value as unknown as { content: JsonValue[] }
      return [{ type: 'text', text: extractText(result.content ?? [], rawName) }]
    },
  }
}

/** One projected core-vocabulary block: text, or an admitted image attachment. */
interface ProjectedBlock {
  type: string
  text?: string
  attachment?: unknown
}

/** Raster formats supported by the durable attachment vocabulary (upstream list). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Attachment codes that mark a CORRECTABLE image refusal. Mirrors the upstream
 * `IMAGE_ADMISSION_ERROR_CODES` used by `dsh-attachment`'s own predicate when
 * that package cannot be reached; the deployed predicate is preferred (see
 * {@link isAdmissionRejection}).
 */
const IMAGE_ADMISSION_ERROR_CODES = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
])

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether an untrusted MCP content array contains a declared image block. */
function containsImage(content: unknown[]): boolean {
  return content.some((value) => isRecord(value) && value.type === 'image')
}

/** Narrow a declared MIME string to the durable image vocabulary. */
function isImageMediaType(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_MEDIA_TYPES.includes(value)
}

/** Stable diagnostic text for an image block that was not admitted. */
function imageDiagnostic(block: Record<string, unknown>, reason: string): string {
  const mediaType = (block.mimeType ?? 'unknown media type') as string
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}

/**
 * Whether a storage failure is a correctable image refusal. Prefers the
 * deployed `dsh-attachment` predicate (exact by construction); the local code
 * mirror above is only the unreachable fallback for a composition without it.
 */
function isAdmissionRejection(error: unknown): boolean {
  const predicate = admissionPredicate as unknown
  if (typeof predicate === 'function') return (predicate as (value: unknown) => boolean)(error)
  if (!(error instanceof Error) || !('code' in error)) return false
  return typeof error.code === 'string' && IMAGE_ADMISSION_ERROR_CODES.has(error.code)
}

/**
 * Locate the deployed admission predicate without a static dependency on the
 * package: its absence only narrows a diagnostic string.
 */
const admissionModule = import('@deepseek-ai/dsh-attachment')
  .then((namespace) => (namespace as { isImageAdmissionError?: unknown }).isImageAdmissionError)
  .catch(() => undefined)

let admissionPredicate: unknown
void admissionModule.then((predicate) => { admissionPredicate = predicate })

/** Decode one projected image without accepting base64 aliases. */
function decodeImage(block: Record<string, unknown>): { data: Buffer; mediaType: string } {
  if (!isImageMediaType(block.mimeType)) throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64')
  return { data, mediaType: block.mimeType }
}

/** The slice of the attachment store image admission uses. */
interface AttachmentStore {
  saveImages(inputs: { data: Buffer; mediaType: string }[]): Promise<unknown[]>
}

/** The slice of the agent/route surface image admission reads. */
interface RouteBearingExecution {
  signal: AbortSignal
  agent?: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    options?: { provider?: string; model?: string }
  }
}

/** Host services are read by name; the composition decides whether they exist. */
function hostService(ctx: Context, name: string): unknown {
  const get = (ctx as unknown as { get?: (service: string) => unknown }).get
  return typeof get === 'function' ? get.call(ctx, name) : undefined
}

/**
 * Resolve the active model route and durable store for an image-bearing result —
 * a verbatim port of the official `resolveImageAdmission`.
 */
async function resolveImageAdmission(ctx: Context, execution: unknown): Promise<AttachmentStore> {
  const attachments = hostService(ctx, 'attachments') as AttachmentStore | undefined
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const exec = execution as RouteBearingExecution
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = hostService(ctx, 'llm') as {
    resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: string[] }>
  } | undefined
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: { inputModalities?: string[] }
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/**
 * Decode, preflight and durably save one result's ordered image batch — a
 * verbatim port of the official `prepareImageProjection`: any refusal projects
 * every image as text while the canonical raw value is retained.
 */
async function prepareImageProjection(
  ctx: Context,
  execution: unknown,
  content: unknown[],
  toolName: string,
): Promise<ProjectedBlock[]> {
  const decoded: { data: Buffer; mediaType: string }[] = []
  const validationErrors = new Map<number, string>()
  const imageIndexes: number[] = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImage(value))
    } catch (error) {
      validationErrors.set(index, (error as Error).message)
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(block, validationErrors.get(index) ?? 'another image in the same result was invalid'),
    }))
  }
  let attachments: AttachmentStore
  try {
    attachments = await resolveImageAdmission(ctx, execution)
  } catch (error) {
    const reason = (error as Error).message
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }))
  }
  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]))
    return projectContent(content, toolName, (_block, index) => ({ type: 'image', attachment: byIndex.get(index) }))
  } catch (error) {
    const reason = isAdmissionRejection(error)
      ? `image admission rejected the result: ${(error as Error).message}`
      : 'durable image storage rejected the result'
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }))
  }
}

/**
 * Project ordered MCP blocks into text — a verbatim port of the official
 * `projectContent`/`extractText` pair. Text-like runs are newline-coalesced;
 * an image splits a run at its original position; an empty projection (nothing
 * model-visible at all, including a `content: []`) reports the official
 * `(<tool> returned no model-visible content)` marker, while a text block that
 * is itself empty renders as an empty string.
 */
function projectContent(
  mcpContent: unknown[],
  toolName: string,
  image: (block: Record<string, unknown>, index: number) => ProjectedBlock = (block) => ({
    type: 'text',
    text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
  }),
): ProjectedBlock[] {
  const projected: ProjectedBlock[] = []
  const text: string[] = []
  const flushText = (): void => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }
  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) text.push(value.text as string)
        break
      case 'image':
        flushText()
        projected.push(image(value, index))
        break
      case 'resource_link':
        if (value.name === undefined || value.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]')
        } else {
          text.push(`Resource link: ${value.name} (${value.uri})`)
        }
        break
      case 'audio':
        text.push(`[audio result unsupported: ${(value.mimeType ?? 'unknown media type') as string}; raw audio data remains available to programmatic callers]`)
        break
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        text.push(`[unsupported MCP content type: ${value.type as string}]`)
    }
  }
  flushText()
  return projected.length > 0
    ? projected
    : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}

/** Text projection of one result's content array (official `extractText`). */
function extractText(mcpContent: unknown[], toolName: string): string {
  return projectContent(mcpContent, toolName).map((block) => block.text).join('\n')
}

/** The spec's `CallToolResult` validator — the same one the official adapter uses. */
const callToolResultSchema = (
  specTypeSchemas as unknown as {
    CallToolResult: {
      '~standard': { validate(value: unknown): { issues?: { message: string }[]; value?: unknown } }
    }
  }
).CallToolResult

/**
 * Text projection shared by the local definition build and its tests. Not part
 * of the public plugin API beyond this module.
 */
export function renderResultText(content: JsonValue[], toolName: string): string {
  return extractText(content, toolName)
}

/** One planned image projection, keyed by the exact execution that produced it. */
interface ImageProjection {
  /** Canonical value the definition returns to the runtime. */
  value: unknown
  /** The text projection the runtime renders unless the admitted image wins. */
  fallback: unknown
  /** Image-bearing content, applied only when the execution materializes. */
  content: ContentBlock[]
}

/**
 * The fallback definition builder: the SAME contract and the SAME observable
 * behavior as the official adapter, implemented here because the host export
 * does not exist on this generation. Used when the host provides no
 * `createMcpToolDefinition` (0.1.5) and when the package cannot be imported.
 *
 * Every step mirrors the official `createMcpToolDefinition`/`createExecutor`:
 * spec `CallToolResult` validation, `taskRequired` refusal, `isError` → throw,
 * canonical `{content, structuredContent?}` value, durable image admission with
 * the text fallback, and the `finalizeContent` weak-map swap that only fires
 * when the runtime materializes exactly the value this execution produced.
 * `tests/tools.spec.ts` asserts the equivalence against the adapter itself.
 */
export function buildLocalToolDefinition(input: DefinitionBuildInput): ToolDefinition {
  const { ctx, client, publicName, tool, opts } = input
  const rawName = tool.name
  const taskRequired = tool.execution?.taskSupport === 'required'
  const projections = new WeakMap<object, ImageProjection>()
  return {
    name: publicName,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
    output: createOutput(rawName, supportedOutputSchema(tool.outputSchema)),
    async execute(args: unknown, exec): Promise<unknown> {
      if (taskRequired) {
        throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
      }
      // Non-object args (model misbehavior) → {} so the server produces the
      // specific "missing required param" error the model can learn from.
      const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      // Validated exactly like the official adapter (the 2.0 client already
      // validates the wire result; this keeps both builders' failure text the
      // same for a mock or a future client that relaxes that).
      const parsed = callToolResultSchema['~standard'].validate(
        await client.callTool(
          { name: rawName, arguments: argsObj },
          { signal: exec.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool },
        ),
      )
      if (parsed.issues !== undefined) {
        throw new Error(
          `Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
        )
      }
      const result = parsed.value as { content: unknown[]; structuredContent?: unknown; isError?: boolean }
      const content = result.content
      const text = extractText(content, rawName)
      if (result.isError === true) throw new Error(text)
      const value = {
        content,
        ...result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
      }
      if (containsImage(content)) {
        const fallback = [{ type: 'text', text: extractText(content, rawName) }]
        const projected = await prepareImageProjection(ctx, exec, content, rawName)
        projections.set(exec as unknown as object, { value, fallback, content: projected as ContentBlock[] })
      }
      return value
    },
    finalizeContent(
      exec: Readonly<ToolExecution>,
      result: Readonly<ToolExecutionResult>,
    ): ContentBlock[] | undefined {
      const projection = projections.get(exec as unknown as object)
      if (projection === undefined) return undefined
      projections.delete(exec as unknown as object)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
      return projection.content
    },
  }
}

// ---- Selection ----

/**
 * Pick the definition builder the host generation supports: the official
 * adapter when the namespace actually carries it, else the local fallback.
 * Pure, so the selection is unit-testable without a generation swap.
 */
export function selectDefinitionBuilder(namespace: ToolAdapterNamespace): DefinitionBuilder {
  const adapter = namespace.createMcpToolDefinition
  if (typeof adapter !== 'function') return buildLocalToolDefinition
  const create = adapter as (ctx: Context, options: McpToolDefinitionOptions) => ToolDefinition
  return (input) => create(input.ctx, {
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
}

/** The resolved builder plus whether the host actually provided the official adapter. */
export interface DefinitionSelection {
  /** The builder to use. */
  build: DefinitionBuilder
  /** True when the host namespace carried `createMcpToolDefinition`. */
  official: boolean
}

/** Memoized process-wide answer; a generation swap means a new host process. */
let resolvedBuilder: Promise<DefinitionSelection> | undefined

/**
 * Resolve the definition builder once per process. The import is dynamic and
 * its failure is contained: a host without the package (or without the export)
 * simply gets the local fallback — which is why the selection reports WHICH
 * path won instead of degrading silently.
 */
export function definitionBuilder(): Promise<DefinitionSelection> {
  resolvedBuilder ??= import('@deepseek-ai/dsh-mcp-client')
    .then((namespace) => {
      const build = selectDefinitionBuilder(namespace)
      return { build, official: build !== buildLocalToolDefinition }
    })
    .catch(() => ({ build: buildLocalToolDefinition, official: false }))
  return resolvedBuilder
}

/**
 * List the server's tools and build the complete next generation of
 * {@link ToolDefinition}s under public names. Pure build — nothing is
 * registered anywhere.
 *
 * The listing is capability-gated (a server that does not advertise `tools`
 * contributes no tools) and aggregated by the client in ONE
 * `listTools` call; a duplicate public name rejects the whole fetch, and so
 * does a list longer than {@link MAX_SYNC_TOOLS}. Failures leave any previous
 * generation untouched (the supervisor owns that discipline).
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
  const selection = await definitionBuilder()
  reportSelection(selection, opts.serverName, opts.log, {
    attachments: hostService(ctx, 'attachments') !== undefined,
    llm: hostService(ctx, 'llm') !== undefined,
  })
  return buildDefinitions(selection.build, ctx, client, opts, onListed)
}

/**
 * Report a degraded selection once per process. Silent degradation is the kind
 * of thing an operator cannot diagnose; the notice is process-global because the
 * selection is.
 *
 * @param selection - The resolved builder and its provenance.
 * @param serverName - Server the first notice is attributed to.
 * @param log - Optional diagnostics sink.
 */
export function reportSelection(
  selection: DefinitionSelection,
  serverName: string,
  log?: (message: string) => void,
  services?: { attachments: boolean; llm: boolean },
): void {
  if (selection.official || fallbackReported || log === undefined) return
  fallbackReported = true
  const admission = services === undefined
    ? ''
    : services.attachments && services.llm
      ? '; image admission is available (attachment store and llm service mounted)'
      : '; image admission is unavailable (no attachment store or llm service on this composition)'
  log(`mcp-scope(${serverName}): this host generation does not provide createMcpToolDefinition — using the built-in port of it (identical projection, validation, image admission and finalizeContent)${admission}`)
}

/**
 * Run ONE capability-gated, client-aggregated listing and build the next
 * definition generation with the given builder. Exported so the same
 * assertions can drive the official adapter and the local fallback through the
 * REAL listing path (a wiring that silently swapped builders would otherwise
 * be invisible to the suite).
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
