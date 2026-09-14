/**
 * MCP tool identity and row-content derivation (browser half, transcript lane).
 *
 * Everything here is pure: the browser half learns which MCP tools exist from
 * the session's own event window, which offers two independent sources —
 *
 * - `request/header` events, whose `header.tools` is the complete model-facing
 *   tool array, and
 * - `tool/call` events, which name the call they render.
 *
 * Both are needed. The window is a bounded tail page of the session log
 * (≈50 messages) while a header is appended at loop-instance boundaries and on
 * change — not on every turn — so a session that ran long enough can render
 * calls whose header sits outside the window. A `tool/call` event, by contrast,
 * is present exactly when the call it belongs to is rendered, so the lane
 * registers from the call events it can see and uses the header for the tools
 * that were offered but not (yet) called.
 *
 * No host API is involved, so a missing service degrades to "no custom row"
 * instead of an error.
 *
 * The naming contract itself lives in `src/shared/model.ts` so this module
 * never imports host code (`./tools.ts` pulls `node:crypto`, which must not
 * reach the client bundle).
 *
 * @module
 */

import {
  HASH_SUFFIX_PATTERN,
  MAX_PUBLIC_NAME_LENGTH,
  MCP_TOOL_PREFIX,
  type ServerDef,
} from '../../shared/model.js'

/** Transport of the server that exposes one tool. */
export type McpTransport = ServerDef['transport']

/** Display identity of one MCP tool, derived from a wire public name. */
export interface McpToolIdentity {
  /** Exact wire tool name — also the keyed `tool.call.toolview` dispatch key. */
  publicName: string
  /** Configured server that owns the tool (best effort when unconfigured). */
  serverName: string
  /**
   * Raw MCP tool name. Ends with the 12-hex identity suffix when the public
   * name was lossy-normalized (see {@link McpToolIdentity.normalized}).
   */
  toolName: string
  /** Transport of the owning server, when the settings document still has it. */
  transport: McpTransport | undefined
  /** True when `publicName` is a lossy-normalized (truncated/hashed) name. */
  normalized: boolean
}

/** Whether a public name carries the lossy-normalization identity suffix. */
function isLossyPublicName(publicName: string): boolean {
  return publicName.length === MAX_PUBLIC_NAME_LENGTH && HASH_SUFFIX_PATTERN.test(publicName)
}

/**
 * Derive the display identity of a public tool name against the configured
 * servers. The longest matching `serverName` wins, because the serverName
 * contract (`[A-Za-z0-9_-]{1,32}`) itself allows `_` and a shorter name could
 * otherwise shadow a longer one. A name whose server is no longer configured
 * still renders (the row exists in history), with the first `__` boundary as
 * the best-effort split and no transport badge.
 *
 * @param publicName - wire tool name from the request header.
 * @param servers - live configured server definitions.
 * @returns the identity, or undefined when the name is not an MCP tool name.
 */
export function identifyMcpTool(
  publicName: string,
  servers: readonly ServerDef[],
): McpToolIdentity | undefined {
  if (!publicName.startsWith(MCP_TOOL_PREFIX)) return undefined
  const rest = publicName.slice(MCP_TOOL_PREFIX.length)
  const normalized = isLossyPublicName(publicName)
  let owner: ServerDef | undefined
  let toolName = ''
  for (const candidate of servers) {
    const prefix = `${candidate.serverName}__`
    if (!rest.startsWith(prefix)) continue
    if (owner !== undefined && candidate.serverName.length <= owner.serverName.length) continue
    owner = candidate
    toolName = rest.slice(prefix.length)
  }
  if (owner !== undefined) {
    return { publicName, serverName: owner.serverName, toolName, transport: owner.transport, normalized }
  }
  const separator = rest.indexOf('__')
  if (separator <= 0) return undefined
  return {
    publicName,
    serverName: rest.slice(0, separator),
    toolName: rest.slice(separator + 2),
    transport: undefined,
    normalized,
  }
}

/** One client session-history entry, structurally narrowed (no package import). */
interface SessionEntryLike {
  readonly type?: unknown
  readonly event?: { readonly type?: unknown; readonly data?: unknown }
}

/** Every `request/header` in the window contributes one tool-name list. */
function headerToolNames(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const header = (data as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return []
  const tools = (header as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const name = (tool as { name?: unknown }).name
    if (typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)) names.push(name)
  }
  return names
}

/** One `mcp__…` name, when the value is a usable tool name. */
function mcpName(value: unknown): string[] {
  return typeof value === 'string' && value.startsWith(MCP_TOOL_PREFIX) ? [value] : []
}

/** Tool names one window event contributes (headers and call events). */
function eventToolNames(event: { readonly type?: unknown; readonly data?: unknown }): string[] {
  switch (event.type) {
    case 'request/header':
      return headerToolNames(event.data)
    case 'tool/call':
      // `{ turn, step, callId, name, arguments }` — the name of the call this
      // event renders. This is what makes discovery independent of whether the
      // describing header is still inside the paged window.
      return mcpName((event.data as { name?: unknown } | undefined)?.name)
    default:
      return []
  }
}

/**
 * Collect every distinct MCP public tool name visible in one session event
 * window, in first-seen order: the tools offered by each `request/header` plus
 * the tools actually called. A window with neither yields nothing (no
 * registration, no custom row).
 *
 * @param entries - `SessionEventWindow.entries` (structural: no package import).
 * @returns distinct `mcp__…` public names.
 */
export function mcpToolNamesOf(entries: readonly unknown[]): string[] {
  const names = new Set<string>()
  for (const raw of entries) {
    const entry = raw as SessionEntryLike
    if (entry === null || typeof entry !== 'object') continue
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event === undefined || typeof event !== 'object') continue
    for (const name of eventToolNames(event)) names.add(name)
  }
  return [...names]
}

/** Call state of one row, mirroring the official tool row's classification. */
export type McpToolRowState = 'running' | 'ok' | 'error' | 'stopped'

/** One tool-call block, structurally narrowed (running and settled forms). */
export interface McpToolBlockLike {
  /** Present on a settled node only; its absence marks the running form. */
  readonly kind?: unknown
  readonly callId?: unknown
  readonly argsRaw?: unknown
  /** Settled nodes backfill the call head, or null when it left the window. */
  readonly call?: { readonly argsRaw?: unknown } | null | undefined
  readonly content?: readonly unknown[] | undefined
  readonly isError?: unknown
  readonly error?: { readonly code?: unknown; readonly name?: unknown } | undefined
  /** Unix epoch ms of the settlement (settled nodes carry it). */
  readonly time?: unknown
  /** Unix epoch ms of the paired call, when it stayed in the window. */
  readonly callTime?: unknown
}

/** Whether the block is the settled (result) form. */
export function isSettledBlock(block: McpToolBlockLike): boolean {
  return 'kind' in block
}

/** Raw JSON argument text of one call (running or settled). */
export function argsRawOf(block: McpToolBlockLike): string {
  const raw = isSettledBlock(block) ? block.call?.argsRaw : block.argsRaw
  return typeof raw === 'string' ? raw : ''
}

/**
 * Row state of one call: `running` while the call streams, `stopped` for an
 * interrupted settlement, `error` for a failed one, `ok` otherwise — the same
 * classification the official rows use, so the two row kinds never disagree.
 */
export function rowStateOf(block: McpToolBlockLike): McpToolRowState {
  if (!isSettledBlock(block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError === true ? 'error' : 'ok'
}

/** One-line summary of the call arguments (first string value, else JSON head). */
export function summarizeArgs(argsRaw: string): string {
  const trimmed = argsRaw.trim()
  if (trimmed === '') return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value !== '') return firstLine(value)
      }
      return firstLine(JSON.stringify(parsed))
    }
    if (typeof parsed === 'string') return firstLine(parsed)
  } catch {
    /* not JSON (a partial stream) — fall through to the raw head */
  }
  return firstLine(trimmed)
}

/** Compact duration of a settled call, when both timestamps survived the window. */
export function durationOf(block: McpToolBlockLike): string {
  const { time, callTime } = block
  if (typeof time !== 'number' || typeof callTime !== 'number') return ''
  const ms = time - callTime
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)}s`
}

/** Result text of a settled call: text blocks joined, other shapes as JSON. */
export function resultTextOf(block: McpToolBlockLike): string {
  const content = block.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) {
      parts.push(String(raw))
      continue
    }
    const part = raw as { type?: unknown; text?: unknown }
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else parts.push(JSON.stringify(raw))
  }
  return parts.join('\n')
}

/** First line of a possibly multi-line string, capped for a row summary. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
