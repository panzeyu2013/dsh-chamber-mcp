/**
 * Registered-tools notice contract (browser half).
 *
 * The plugin registers MCP tools into an agent's scope and writes NOTHING into
 * a session, so nothing in the transcript said that those tools exist. The
 * notice closes that gap with ONE disclosure row in the conversation lane — and
 * it is DERIVED, never written.
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
 * Source: the two model-facing shapes ONE request can carry MCP tools in, read
 * from the harness's own events:
 *
 *  - `request/header.tools` — the tool array of a NATIVE presentation, where
 *    the MCP schemas ride the request's own tools field;
 *  - the rendered system prompt (`system/message`, read through the Chat lane's
 *    own `system-message` Context) — the generated SDK section a `ptc`
 *    presentation declares the same tools in, because under `ptc` the header
 *    carries only `run_code`.
 *
 * The union of both is the set of MCP tools that request was given, whichever
 * presentation produced it: the row is truthful (it names what the request
 * exposed), durable (it survives a reload from the stored log), and harmless
 * (the plugin writes nothing into a session). A request that exposed none
 * yields no row.
 *
 * Public names are grouped by the server that owns them with the same
 * longest-configured-prefix rule the tool-row lane uses, because a serverName
 * contract that allows `_` and `-` cannot be split reliably, and a lossily
 * normalized name carries a hash suffix instead of its raw parts. Ownership is
 * STRICT here: a name is reported only when a configured server owns it (the
 * tool-row lane keeps its first-boundary fallback for historical calls), because
 * this notice reports registrations and an unowned name would claim a server this
 * deployment does not run.
 *
 * The projection carries the public NAMES of each server's tools, not just the
 * counts: the row's expanded body follows the shipped system-prompt and
 * injected-context rows into a bounded scrollport, and a count alone would say
 * nothing there. The list is capped per server (a server may legally list
 * thousands of tools) while the counts stay exact — the body reports what the
 * cap left out.
 *
 * @module
 */

import { MAX_PUBLIC_NAME_LENGTH, MCP_TOOL_PREFIX, type ServerDef } from '../shared/model.js'
import { identifyMcpTool } from './tool-card/names.js'

/** Chat-node kind the browser half renders the registered-tools notice under. */
export const MCP_INJECTION_NODE_KIND = 'mcp-scope-injected'

/**
 * Public names one server may contribute to the expanded body. A server may
 * legally list up to `MAX_SYNC_TOOLS` (2000) tools and the projection runs for
 * every header in the loaded window, so the carried list is bounded; the
 * server's `toolCount` stays exact and the body names the remainder.
 */
export const INJECTION_NAME_LIMIT = 256

/** One registered server and how many tools it contributed. */
export interface InjectionServer {
  name: string
  toolCount: number
  /**
   * Public `mcp__…` names the request exposed for the server, sorted. A
   * projection this module produced carries at most `toolCount` of
   * them, and fewer only under the name cap — the body then reports the
   * difference as not listed.
   */
  tools: readonly string[]
}

/** Normalized payload of one injection notice. */
export interface InjectionPayload {
  servers: readonly InjectionServer[]
}

/** The two model-facing shapes one request can carry MCP tools in. */
export interface InjectionRequestLike {
  /** `request/header` event data (untrusted). */
  header?: unknown
  /** Effective rendered system-prompt text, when the window has one. */
  prompt?: unknown
}

/**
 * A public tool name in the exact shape the `mcp__` contract emits:
 * `mcp__<serverName>__<rawName>`, alphabet `[A-Za-z0-9_-]` (a lossily
 * normalized name appends `_<12-hex hash>`, also inside it). The server part is
 * deliberately greedy because a `serverName` may itself contain `__`; the raw
 * part must be non-empty, which the naming contract guarantees.
 */
const PUBLIC_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/

/** One character the `mcp__` naming contract allows after the prefix. */
const NAME_CHAR = /[A-Za-z0-9_-]/

/**
 * Longest line prefix that can still declare: the generated renderers indent a
 * member by one level and a Python def by one block. A longer prefix is prose,
 * and refusing it keeps the per-candidate check constant-time.
 */
const MAX_DECLARATION_PREFIX = 64

/** Line-start shapes a generated SDK block DECLARES a tool name in. */
type DeclarationForm = 'member' | 'quoted-member' | 'def' | 'comment'

/**
 * The declaration form the text before a name spells out, or undefined when the
 * name is not in declaring position.
 *
 * Both renderers `dsh-tools` ships put a declaration's name where a prose
 * mention never is: the TypeScript block writes `  mcp__server__tool: { … };`
 * (indentation only before the name, then `:`) and the Python block writes
 * `    async def mcp__server__tool(self, …)` (then `(`) or
 * `# tools["mcp__server__tool"](…)` (then `"`). Requiring one of those prefixes
 * keeps a tool DESCRIPTION that merely mentions another tool's name out of the
 * reported set — every description renders into the same block as a JSDoc line,
 * whose text (or `*` marker) sits before the name.
 */
function declarationFormAt(text: string, lineStart: number, start: number): DeclarationForm | undefined {
  // A declaration's line prefix is indentation plus one short keyword
  // ("async def ", "# tools[\""), so anything longer is prose. Bounding it keeps
  // the check O(1) per candidate: scanning back to the line start for every
  // `mcp__` occurrence made a single long line quadratic (a 1 MB line took
  // seconds), and generated prompt text can be one huge line.
  if (start - lineStart > MAX_DECLARATION_PREFIX) return undefined
  const prefix = text.slice(lineStart, start)
  if (/^[ \t]*$/.test(prefix)) return 'member'
  if (/^[ \t]*"$/.test(prefix)) return 'quoted-member'
  if (/^[ \t]*(?:async[ \t]+def|def)[ \t]+$/.test(prefix)) return 'def'
  if (/^[ \t]*#[ \t]*tools\["$/.test(prefix)) return 'comment'
  return undefined
}

/** The delimiter each declaration form must put after the name. */
const DECLARATION_DELIMITER: Record<DeclarationForm, string> = {
  member: ':',
  'quoted-member': '"',
  def: '(',
  comment: '"',
}

/**
 * Whether one string is a well-formed public tool name.
 *
 * @param name - candidate name (untrusted).
 * @returns true when it matches the `mcp__<server>__<tool>` contract.
 */
export function isPublicToolName(name: unknown): name is string {
  return typeof name === 'string' && PUBLIC_TOOL_NAME.test(name)
}

/**
 * Extract the MCP public names DECLARED by one rendered system prompt.
 *
 * Only declaration positions count (see {@link declarationFormAt}): the alphabet
 * and the maximal run after the prefix are the `mcp__` contract's own, and a
 * public name is never split into server/tool parts — the upstream naming
 * contract forbids parsing it back.
 *
 * @param text - rendered prompt text (untrusted).
 * @returns distinct names in first-seen order, empty when there are none.
 */
export function injectionNamesOfPrompt(text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return []
  const seen = new Set<string>()
  // One monotone line cursor: every candidate advances it past the newlines
  // before it, so the walk never rescans text (each newline is visited once).
  let lineStart = 0
  let newline = text.indexOf('\n')
  let index = text.indexOf(MCP_TOOL_PREFIX)
  while (index !== -1) {
    while (newline !== -1 && newline < index) {
      lineStart = newline + 1
      newline = text.indexOf('\n', lineStart)
    }
    // The maximal run of contract characters IS the candidate name: it ends at
    // the first character a public name may not contain, so the delimiter after
    // it is already in place. Consuming the run keeps the walk linear — a
    // backtracking pattern over the same text was quadratic (a 180 KB prompt
    // took seconds on the UI thread) and accepted a name of any length.
    let end = index + MCP_TOOL_PREFIX.length
    while (end < text.length && NAME_CHAR.test(text[end] as string)) end += 1
    const start = index
    const name = text.slice(start, end)
    index = text.indexOf(MCP_TOOL_PREFIX, Math.max(end, start + 1))
    if (name.length > MAX_PUBLIC_NAME_LENGTH || !isPublicToolName(name)) continue
    const form = declarationFormAt(text, lineStart, start)
    if (form === undefined) continue
    // The delimiter belongs to the form: a TypeScript member is followed by
    // ':', the Python def by '(', and both quoted forms by '"'. Spaces between
    // the name and its delimiter are legal; a newline is not — a name at the end
    // of a line is prose, not a declaration.
    let after = end
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1
    if (text[after] !== DECLARATION_DELIMITER[form]) continue
    seen.add(name)
  }
  return [...seen]
}

/**
 * Extract the MCP public names one `request/header` exposed.
 *
 * @param data - `request/header` event data (untrusted).
 * @returns distinct names in tool-array order, empty when it carried none.
 */
export function injectionNamesOfHeader(data: unknown): string[] {
  if (data === null || typeof data !== 'object') return []
  const header = (data as { header?: unknown }).header
  if (header === null || typeof header !== 'object') return []
  const tools = (header as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const name = (tool as { name?: unknown }).name
    if (!isPublicToolName(name)) continue
    seen.add(name)
  }
  return [...seen]
}

/**
 * Group one request's MCP names by the server that owns them, sorted by server
 * name. The input is treated as a SET: a name exposed by both sources (a `both`
 * presentation) counts once.
 *
 * A name is kept only when a CONFIGURED server owns it. The tool-row lane
 * deliberately falls back to the first `__` boundary so a historical call whose
 * server left the settings still renders; this notice reports what is REGISTERED,
 * so a name with no configured owner is not a registration — it is prose (a tool
 * description or an instruction that happens to mention one) or a stale header,
 * and reporting it would claim a server that does not exist.
 *
 * @param names - public names one request exposed.
 * @param servers - live configured servers, for longest-prefix ownership.
 * @returns one entry per owning server, empty when none is configured for them.
 */
export function injectionServersOfNames(names: readonly string[], servers: readonly ServerDef[] = []): InjectionServer[] {
  const sets = new Map<string, Set<string>>()
  for (const name of names) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue
    const identity = identifyMcpTool(name, servers)
    if (identity === undefined) continue
    if (!servers.some((candidate) => candidate.serverName === identity.serverName)) continue
    const owned = sets.get(identity.serverName) ?? new Set<string>()
    owned.add(name)
    sets.set(identity.serverName, owned)
  }
  return [...sets.entries()]
    .map(([name, owned]) => {
      const sorted = [...owned].sort()
      return {
        name,
        toolCount: sorted.length,
        tools: sorted.slice(0, INJECTION_NAME_LIMIT),
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Project one request's registered-tools set: the union of its header tools and
 * the names its rendered system prompt declares.
 *
 * @param request - the header event data and effective prompt text.
 * @param servers - live configured servers, for longest-prefix ownership.
 * @returns one entry per owning server, empty when the request exposed none.
 */
export function injectionServersOfRequest(
  request: InjectionRequestLike,
  servers: readonly ServerDef[] = [],
): InjectionServer[] {
  return injectionServersOfNames(
    [...injectionNamesOfHeader(request.header), ...injectionNamesOfPrompt(request.prompt)],
    servers,
  )
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
    const tools: string[] = []
    const listed = (raw as { tools?: unknown }).tools
    if (Array.isArray(listed)) {
      for (const tool of listed) if (typeof tool === 'string' && tool !== '') tools.push(tool)
    }
    entries.push({ name, toolCount: typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0, tools })
  }
  if (entries.length === 0) return undefined
  return { servers: entries }
}

/**
 * Names one carried server could not list. Only the cap omits names, so the
 * number is non-zero exactly when the list was truncated; a payload that
 * carries no names at all (an older or hostile node) claims nothing.
 *
 * @param server - one normalized server entry.
 * @returns how many of its tools the expanded body does not name.
 */
export function injectionOmittedOf(server: InjectionServer): number {
  if (server.tools.length < INJECTION_NAME_LIMIT) return 0
  return Math.max(0, server.toolCount - server.tools.length)
}

/**
 * Signature of one registered set: the notice's change key. Two requests that
 * exposed the same MCP tools share it, so the second one adds no row.
 *
 * The carried NAMES are part of the key, not just the counts, so a server that
 * swaps one tool for another of the same count is still a change. A server whose
 * list exceeds the cap is the one blind spot: two sets that share the same first
 * `INJECTION_NAME_LIMIT` sorted names and the same count key identically even
 * though they differ beyond the cap — the row would then render the same body
 * either way, and the expanded list reports the remainder as not listed.
 *
 * @param servers - the servers one request exposed.
 * @returns a stable, order-independent signature.
 */
export function injectionSignature(servers: readonly InjectionServer[]): string {
  return servers.map((server) => server.name + ':' + String(server.toolCount) + ':' + server.tools.join('\u0000')).join(',')
}
