/**
 * Registered-tools notice contract (browser half).
 *
 * The plugin registers MCP tools into an agent's scope and writes NOTHING into
 * a session, so nothing in the transcript said that those tools exist. The
 * notice closes that gap with ONE disclosure row in the conversation lane — and
 * it is DERIVED, never written.
 *
 * An earlier revision had the host append a private `mcp-scope/injected` session
 * event. That is the one thing a third-party plugin must not do: the persisted
 * envelope's `ignorable?: true` marker is the only way a reader may skip an
 * event type it does not know, and a private REQUIRED event therefore makes the
 * whole log unreadable — `validateStoredEvents` refuses any log carrying a type
 * outside the build-generated `KNOWN_SESSION_EVENT_TYPES` set unless the stored
 * envelope says `ignorable: true`, so even the harness that wrote the event can
 * no longer open that session (out-of-repo plugin types are outside that set by
 * construction). Upstream DOES expose a writer — `appendPluginRecord` (present
 * on 0.2.1-rc.5 and the 0.2.2 line, absent from 0.2.0-rc.1) — but this notice
 * deliberately stays derived: it needs no log entry, plugin records are
 * best-effort across format migrations (owners validate restored data), and a
 * write path would owe a per-generation feature-detect across the support
 * window (see upstream
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

import { MAX_PUBLIC_NAME_LENGTH, MCP_TOOL_PREFIX, SERVER_NAME_PATTERN, type ServerDef } from '../shared/model.js'
import { LOADER_RAW_NAME, identifyMcpTool } from './tool-card/names.js'

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
  /**
   * Public `mcp__…` names the request exposed for the server, sorted. A
   * projection this module produced carries at most `toolCount` of
   * them, and fewer only under the name cap — the body then reports the
   * difference as not listed. The on-demand LOADER tool is never counted.
   */
  tools: readonly string[]
  /** Public tool names the server contributed (LOADER excluded). */
  toolCount: number
  /**
   * On-demand servers only: how many distinct tools the server's catalog
   * offers. Definitions never cross the wire — only this size and a bounded
   * list of RAW catalog names.
   */
  catalog?: number
  /** On-demand servers only: bounded raw catalog names, in catalog order. */
  catalogNames?: readonly string[]
  /** Marks an on-demand catalog entry for the row's catalog rendering. */
  onDemand?: true
}

/** One on-demand catalog section parsed from a rendered system prompt. */
export interface CatalogSection {
  /** Configured server the section claims to belong to (validated by the caller). */
  name: string
  /** Bounded raw catalog names carried for the expanded body. */
  tools: readonly string[]
  /** Exact number of distinct catalog tool names in the section. */
  total: number
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
 * Heading line that opens one on-demand catalog section (upstream verbatim,
 * `dsh-mcp-client/src/tool-loading.ts`).
 */
const CATALOG_HEADING = '### On-demand tools from MCP server '

/** Bound of one prompt scan: catalog sections beyond this many chars are not read. */
const CATALOG_SCAN_LIMIT = 256 * 1024

/** Maximum catalog sections carried per prompt (bounded work per request). */
export const CATALOG_SECTION_LIMIT = 64

/** Longest raw catalog name carried (a public name is capped at 64; gold-plate). */
const CATALOG_RAW_NAME_LIMIT = 256

/**
 * The exact sentence the upstream renderer puts directly under a catalog
 * heading. Used as the anti-spoof signature of one catalog section.
 *
 * @param name - server name from the heading line.
 * @returns the sentence the mounted client renders for that server.
 */
function catalogLoaderSentence(name: string): string {
  return 'These tools are not in your tool list. Before calling one, load it with mcp__' + name + '__' + LOADER_RAW_NAME + '.'
}

/**
 * Extract every on-demand catalog section DECLARED by one rendered system
 * prompt.
 *
 * The upstream renderer (`dsh-mcp-client/src/tool-loading.ts`) emits one
 * section per on-demand server:
 *
 * ```text
 * ### On-demand tools from MCP server <name>
 * These tools are not in your tool list. Before calling one, load it with mcp__<name>__load_tools.
 * - <raw tool name>: <summary>
 * ```
 *
 * SECURITY, not style: MCP tool DESCRIPTIONS are attacker-controlled text and
 * render into the SAME prompt, so a bare heading match would let one server
 * forge another configured server's catalog. A section is accepted only when
 * (a) the heading starts a line and names a legal server name, (b) the first
 * non-empty line below it is the EXACT loader sentence naming THAT server —
 * the mounted client's own wording, which a description rendered as a JSDoc /
 * catalog-summary line cannot reproduce at line start — and (c) the caller
 * additionally filters sections by configured-server ownership in
 * {@link injectionServersOfNames}. Catalog lines carry RAW names only, never
 * `mcp__` public names.
 *
 * Total/linear: the text is scanned once, sections and carried names are
 * bounded, and malformed input yields `[]` — this runs for every header
 * evaluation, inside the assembler, so it must never throw.
 *
 * @param text - rendered system-prompt text (untrusted).
 * @returns accepted catalog sections in prompt order, empty when there are none.
 */
export function catalogSectionsOfPrompt(text: unknown): CatalogSection[] {
  if (typeof text !== 'string' || text === '') return []
  const scanned = text.length > CATALOG_SCAN_LIMIT ? text.slice(0, CATALOG_SCAN_LIMIT) : text
  const lines = scanned.split('\n')
  const sections: CatalogSection[] = []
  const taken = new Set<string>()
  let index = 0
  while (index < lines.length) {
    const heading = (lines[index] as string).trim()
    if (!heading.startsWith(CATALOG_HEADING)) {
      index += 1
      continue
    }
    const name = heading.slice(CATALOG_HEADING.length).trim()
    if (!SERVER_NAME_PATTERN.test(name)) {
      index += 1
      continue
    }
    let cursor = index + 1
    while (cursor < lines.length && (lines[cursor] as string).trim() === '') cursor += 1
    if (cursor >= lines.length || (lines[cursor] as string).trim() !== catalogLoaderSentence(name)) {
      // A matching heading without the renderer's own loader sentence is prose
      // or a forgery attempt: never treat it as a catalog.
      index += 1
      continue
    }
    const names = new Set<string>()
    cursor += 1
    while (cursor < lines.length) {
      const entry = (lines[cursor] as string).trim()
      if (!entry.startsWith('- ')) break
      const body = entry.slice(2)
      const colon = body.indexOf(':')
      const raw = (colon === -1 ? body : body.slice(0, colon)).trim()
      if (raw !== '' && raw.length <= CATALOG_RAW_NAME_LIMIT) names.add(raw)
      cursor += 1
    }
    if (!taken.has(name) && sections.length < CATALOG_SECTION_LIMIT) {
      taken.add(name)
      sections.push({ name, tools: [...names].slice(0, INJECTION_NAME_LIMIT), total: names.size })
    }
    index = cursor
  }
  return sections
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
 * On-demand servers (document `toolLoading: 'on-demand'`) register ONE tool
 * besides the catalog: the loader `mcp__<server>__load_tools`. A public name
 * whose raw part is {@link LOADER_RAW_NAME} on such a server is the LOADER,
 * never a catalog tool — it is removed from the returned tool set (the tool
 * count then counts the catalog separately, see `catalog`).
 *
 * Catalog sections are attached only to a configured server that is actually
 * in on-demand mode; the definitions never cross the wire, so the entry carries
 * the catalog size and a bounded RAW-name list.
 *
 * @param names - public names one request exposed.
 * @param servers - live configured servers, for longest-prefix ownership.
 * @param catalogs - on-demand catalog sections parsed from the prompt.
 * @returns one entry per owning server, empty when none is configured for them.
 */
export function injectionServersOfNames(
  names: readonly string[],
  servers: readonly ServerDef[] = [],
  catalogs: readonly CatalogSection[] = [],
): InjectionServer[] {
  const configured = new Map(servers.map((server) => [server.serverName, server]))
  const sets = new Map<string, Set<string>>()
  for (const name of names) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue
    const identity = identifyMcpTool(name, servers)
    if (identity === undefined) continue
    const owner = configured.get(identity.serverName)
    // Strict ownership: a name no configured server owns is prose or a stale
    // header, not a registration.
    if (owner === undefined) continue
    // The on-demand loader is a tool of the list but not a tool of the catalog:
    // counting it would claim a catalog of N+1 and mislabel the loader as a
    // server tool in the expanded body.
    if (identity.loader === true) continue
    const owned = sets.get(identity.serverName) ?? new Set<string>()
    owned.add(name)
    sets.set(identity.serverName, owned)
  }
  const catalogOf = new Map<string, CatalogSection>()
  for (const section of catalogs) {
    const owner = configured.get(section.name)
    // A catalog section is honored only for a configured server that really is
    // in on-demand mode: the mounted client renders this section exactly for
    // such a server, so anything else is prose rendered into the prompt.
    if (owner === undefined || owner.toolLoading !== 'on-demand') continue
    if (catalogOf.has(section.name)) continue
    catalogOf.set(section.name, section)
  }
  const namesInOrder = new Set<string>([...sets.keys(), ...catalogOf.keys()])
  return [...namesInOrder]
    .map((name) => {
      const sorted = [...(sets.get(name) ?? [])].sort()
      const catalog = catalogOf.get(name)
      const entry: InjectionServer = {
        name,
        toolCount: sorted.length,
        tools: sorted.slice(0, INJECTION_NAME_LIMIT),
      }
      if (catalog !== undefined) {
        entry.catalog = catalog.total
        entry.catalogNames = catalog.tools.slice(0, INJECTION_NAME_LIMIT)
        entry.onDemand = true
      }
      return entry
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
    catalogSectionsOfPrompt(request.prompt),
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
    const entry: InjectionServer = {
      name,
      toolCount: typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0,
      tools,
    }
    // On-demand catalog: the size is exact, the names are bounded and RAW.
    const catalog = (raw as { catalog?: unknown }).catalog
    if (typeof catalog === 'number' && Number.isFinite(catalog) && catalog >= 0) {
      const catalogNames: string[] = []
      const carried = (raw as { catalogNames?: unknown }).catalogNames
      if (Array.isArray(carried)) {
        for (const tool of carried) if (typeof tool === 'string' && tool !== '') catalogNames.push(tool)
      }
      entry.catalog = Math.floor(catalog)
      entry.catalogNames = catalogNames.slice(0, INJECTION_NAME_LIMIT)
      entry.onDemand = true
    }
    entries.push(entry)
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
 * Catalog names one on-demand server could not list. Only the cap omits names,
 * so the number is non-zero exactly when the carried list was truncated; a
 * payload with no catalog claims nothing.
 *
 * @param server - one normalized server entry.
 * @returns how many catalog tools the expanded body does not name.
 */
export function catalogOmittedOf(server: InjectionServer): number {
  const total = server.catalog
  if (total === undefined) return 0
  const carried = server.catalogNames?.length ?? 0
  if (carried < INJECTION_NAME_LIMIT) return 0
  return Math.max(0, total - carried)
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
  return servers
    .map((server) => {
      const base = server.name + ':' + String(server.toolCount) + ':' + server.tools.join('\u0000')
      // The catalog size and its carried RAW names are part of the change key: a
      // catalog-only change (same loader, new catalogue) must still emit a row,
      // and the expanded body would differ even when the collapsed line's count
      // does not.
      if (server.catalog === undefined) return base
      return base + ':catalog=' + String(server.catalog) + ':' + (server.catalogNames ?? []).join('\u0000')
    })
    .join(',')
}
