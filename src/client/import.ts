/**
 * Pure paste / import parsers for the staged server form.
 *
 * Deliberately React-free and host-free: the form calls these on clipboard
 * text, and the unit tests drive them directly. Nothing here writes a
 * document — the result only fills the staged draft, whose secret inputs are
 * write-only and reach the credentials domain on Save.
 *
 * Supported shapes (the first NAMED server wins, the rest are reported):
 *   - `{ "mcpServers": { "<name>": { command/url/... } } }` (Claude/Cursor)
 *   - `{ "servers": { "<name>": { type: 'stdio', ... } } }` (VS Code mcp.json)
 *   - `{ "mcp": { "<name>": { type: 'local'|'remote', ... } } }` (opencode)
 *   - a single flat `{ command, args, env, ... }` / `{ url, headers }` object
 *
 * Real-world pastes are read tolerantly: the enclosing braces may be missing
 * (a bare `"mcp": { ... }` section, a bare map of named servers, or a torn
 * section whose separators were left behind), the server map may sit behind a
 * wrapper key, the top level may be an array of servers, and `//` and block
 * comments, trailing commas, fenced blocks and surrounding prose are accepted —
 * including a paste that carries example snippets above the real config, since
 * the first NAMED server wins.
 * The text is parsed with `JSON.parse` only — pasted text is never evaluated.
 *
 * @module
 */

/** One imported server, in the staged-draft vocabulary. */
export interface ImportedServer {
  name?: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  env: { key: string; value: string }[]
  url?: string
  headers: { name: string; ref: string; value: string }[]
  enabled: boolean
  timeoutMs?: string
}

/** Outcome of one snippet parse (business failure, never a throw). */
export type ImportOutcome =
  | { ok: true; server: ImportedServer; others: string[] }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Strip one pair of matching single/double quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Quote-aware split of a pasted command line (single/double quotes, backslash
 * escape outside single quotes). Inside double quotes only \" and \\\\ are
 * escapes, so a quoted Windows path keeps its separators. Empty quoted
 * arguments are preserved.
 */
export function splitCommandLine(text: string): string[] {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== null) {
      if (char === '\\' && quote === '"' && index + 1 < text.length && /["\\]/.test(text[index + 1]!)) {
        current += text[index + 1]!
        index += 1
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }
    if (
      char === '\\' &&
      index + 1 < text.length &&
      /[\s"'\\]/.test(text[index + 1]!)
    ) {
      current += text[index + 1]!
      index += 1
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current !== '') {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') out.push(current)
  return out
}

/** Parse `.env`-style `KEY=VALUE` lines (comments and blanks skipped). */
export function parseKeyValueLines(text: string): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = unquote(line.slice(0, equals).trim())
    if (key === '') continue
    rows.push({ key, value: envValue(line.slice(equals + 1)) })
  }
  return rows
}

/**
 * `.env` value: surrounding quotes are dropped and an unquoted ` # comment`
 * tail is cut (a quoted value keeps its # verbatim).
 */
function envValue(raw: string): string {
  const trimmed = raw.trim()
  let quote: '"' | "'" | null = null
  let cut = -1
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && index > 0 && /\s/.test(trimmed[index - 1]!)) {
      cut = index
      break
    }
  }
  return unquote((cut >= 0 ? trimmed.slice(0, cut) : trimmed).trim())
}

/** Parse header lines (`Name: value` or `Name=value`) into name/value rows. */
export function parseHeaderLines(text: string): { name: string; value: string }[] {
  const rows: { name: string; value: string }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    const equals = line.indexOf('=')
    const splitAt = colon > 0 && (equals <= 0 || colon < equals) ? colon : equals
    if (splitAt <= 0) continue
    const name = line.slice(0, splitAt).trim()
    if (name === '') continue
    rows.push({ name, value: unquote(line.slice(splitAt + 1).trim()) })
  }
  return rows
}

/** Uppercase env-style credential ref; empty when nothing valid remains. */
export function normalizeRef(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+/, '')
  if (cleaned === '') return ''
  return /^[A-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`
}

/** Derive a credential ref from an HTTP header name (dashes become underscores). */
export function refFromHeaderName(name: string): string {
  return normalizeRef(name.replace(/-/g, '_'))
}

/** Drop a UTF-8 BOM before parsing (VS Code / Windows files carry one). */
function normalizeInput(text: string): string {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
}

/**
 * Remove `//` line and block comments that sit OUTSIDE string literals
 * (JSONC). String state is tracked, so `"https://host/x"` keeps its `//`.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      out += char
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1]!
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      out += ' '
      continue
    }
    out += char
  }
  return out
}

/** Drop `,` directly before a closing brace/bracket, outside strings. */
export function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      out += char
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1]!
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ',') {
      let cursor = index + 1
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1
      const next = text[cursor]
      if (next === '}' || next === ']') {
        index = cursor - 1
        continue
      }
    }
    out += char
  }
  return out
}

/** First fence body in the paste: a linear line scan (regex backtracked here). */
function fencedBody(text: string): string | undefined {
  let cursor = 0
  while (cursor < text.length) {
    const tick = text.indexOf('`', cursor)
    const tilde = text.indexOf('~', cursor)
    const start = tick < 0 ? tilde : tilde < 0 ? tick : Math.min(tick, tilde)
    if (start < 0) return undefined
    const marker = text[start]!
    let run = start
    while (run < text.length && text[run] === marker) run += 1
    if (run - start >= 3) {
      const openLength = run - start
      const newline = text.indexOf('\n', run)
      if (newline < 0) return undefined
      let scan = newline + 1
      while (scan <= text.length) {
        const lineEnd = text.indexOf('\n', scan)
        const end = lineEnd < 0 ? text.length : lineEnd
        let mark = scan
        while (mark < end && text[mark] === marker) mark += 1
        if (mark - scan >= openLength && text.slice(mark, end).trim() === '') return text.slice(newline + 1, scan)
        if (lineEnd < 0) break
        scan = lineEnd + 1
      }
      return undefined
    }
    cursor = run
  }
  return undefined
}

/** The balanced `{...}` / `[...]` starting at `start`, when it closes. */
function balancedFrom(text: string, start: number): string | undefined {
  const open = text[start]!
  if (open !== '{' && open !== '[') return undefined
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return text.slice(start, index + 1)
  }
  return undefined
}

/** Index of the next `{` / `[` at or after `from` (linear, no slicing). */
function nextOpener(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{' || char === '[') return index
  }
  return -1
}

/**
 * Balanced JSON regions of arbitrary text, in order. An unbalanced opener is
 * skipped rather than ending the scan (prose such as `Use {` used to abort it);
 * both the region count and the miss budget are bounded.
 */
function balancedRegions(text: string): string[] {
  const regions: string[] = []
  let cursor = 0
  let misses = 0
  while (cursor < text.length && regions.length < MAX_REGIONS && misses < MAX_REGION_MISSES) {
    const start = nextOpener(text, cursor)
    if (start < 0) break
    const region = balancedFrom(text, start)
    if (region === undefined) {
      misses += 1
      cursor = start + 1
      continue
    }
    regions.push(region)
    cursor = start + region.length
  }
  return regions
}

/** A leading `"key":` (quoted keys may hold spaces) or bare `key:` section. */
const FRAGMENT_KEY = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^"'\s:{}[\],]+)\s*:/

/** Net brace/bracket depth of a fragment (string-aware; prose adds none). */
function braceDepth(text: string): number {
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
  }
  return depth
}

/**
 * Body of a brace-less config *section* (`"mcp": { ... }` or a bare map of
 * named servers): a pasted section usually keeps its separator or the parent
 * map's closing brace, so both are trimmed until the fragment balances.
 */
function fragmentBody(text: string): string | undefined {
  let body = text.trim().replace(/^[\s,]+/, '')
  if (body === '' || body.startsWith('{') || body.startsWith('[')) return undefined
  if (!FRAGMENT_KEY.test(body)) return undefined
  for (let guard = 0; guard < 64; guard += 1) {
    const trimmed = body.replace(/[\s,]+$/, '')
    if (trimmed === '') return undefined
    const depth = braceDepth(trimmed)
    if (depth >= 0 || !/[}\]]$/.test(trimmed)) return trimmed
    body = trimmed.slice(0, -1)
  }
  return undefined
}

/** A brace-less config section wrapped back into a JSON object. */
function wrappedFragment(text: string): string | undefined {
  const body = fragmentBody(text)
  return body === undefined ? undefined : '{' + body + '}'
}

/** `"key"` / `'key'` at `index`; only quoted keys (unquoted stays YAML). */
function readSectionKey(text: string, index: number): { name: string; end: number } | undefined {
  const quote = text[index]
  if (quote !== '"' && quote !== "'") return undefined
  let cursor = index + 1
  while (cursor < text.length) {
    const char = text[cursor]!
    if (char === '\\' && quote === '"') {
      cursor += 2
      continue
    }
    if (char === quote) break
    cursor += 1
  }
  if (cursor >= text.length) return undefined
  return { name: text.slice(index + 1, cursor), end: cursor + 1 }
}

/** One JSON value at `index` (balanced container, string, or JSON scalar). */
function readSectionValue(text: string, index: number): { parsed: unknown; end: number } | undefined {
  const char = text[index]
  if (char === '{' || char === '[') {
    const region = balancedFrom(text, index)
    if (region === undefined) return undefined
    try {
      return { parsed: JSON.parse(stripTrailingCommas(region)) as unknown, end: index + region.length }
    } catch {
      return undefined
    }
  }
  if (char === '"') {
    let cursor = index + 1
    while (cursor < text.length) {
      const current = text[cursor]!
      if (current === '\\') {
        cursor += 2
        continue
      }
      if (current === '"') break
      cursor += 1
    }
    if (cursor >= text.length) return undefined
    try {
      return { parsed: JSON.parse(text.slice(index, cursor + 1)) as unknown, end: cursor + 1 }
    } catch {
      return undefined
    }
  }
  let cursor = index
  while (cursor < text.length && !/[\s,]/.test(text[cursor]!)) cursor += 1
  const token = text.slice(index, cursor)
  if (token === '') return undefined
  try {
    const parsed = JSON.parse(token) as unknown
    return parsed !== null && typeof parsed === 'object' ? undefined : { parsed, end: cursor }
  } catch {
    return undefined
  }
}

/**
 * Read a torn config section whose separators were left behind: a
 * `"a": { ... }` list with a missing or leading comma. Only reached after
 * every strict strategy failed, and values must still be valid JSON — so YAML
 * and JS object literals stay rejected. Returns assembled JSON text.
 */
function readLooseSection(text: string): string | undefined {
  const source = text.trim().replace(/^[\s,]+/, '')
  if (source === '') return undefined
  const section: Record<string, unknown> = {}
  let index = 0
  let count = 0
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index]!)) index += 1
    if (index >= source.length) break
    const key = readSectionKey(source, index)
    if (key === undefined) return undefined
    index = key.end
    while (index < source.length && /\s/.test(source[index]!)) index += 1
    if (source[index] !== ':') return undefined
    index += 1
    while (index < source.length && /\s/.test(source[index]!)) index += 1
    const value = readSectionValue(source, index)
    if (value === undefined) return undefined
    section[key.name] = value.parsed
    index = value.end
    count += 1
  }
  return count > 0 ? JSON.stringify(section) : undefined
}

/**
 * Ordered JSON/JSONC candidates extracted from pasted text — plain JSON, JSONC,
 * a fenced block, a brace-less section, a torn section, then the balanced
 * regions of a prose-wrapped paste. Nothing here evaluates the text.
 */
function* jsonCandidates(text: string): Generator<string> {
  const seen = new Set<string>()
  function* emit(candidate: string | undefined): Generator<string> {
    if (candidate === undefined) return
    const value = candidate.trim()
    if (value === '' || seen.has(value)) return
    seen.add(value)
    yield value
  }
  for (const source of [text, fencedBody(text)]) {
    if (source === undefined) continue
    // Whole-document strategies always run; extraction is skipped on huge pastes.
    yield* emit(source)
    if (source.length > MAX_CANDIDATE_LENGTH) continue
    const normalized = stripTrailingCommas(stripJsonComments(source))
    yield* emit(stripJsonComments(source))
    yield* emit(normalized)
    yield* emit(wrappedFragment(source))
    yield* emit(stripTrailingCommas(wrappedFragment(source) ?? ''))
    yield* emit(readLooseSection(source))
    yield* emit(readLooseSection(normalized))
    for (const region of balancedRegions(stripJsonComments(source))) {
      yield* emit(region)
      yield* emit(stripTrailingCommas(region))
    }
  }
}

/** Keys whose value is a named server map (Claude/Cursor, VS Code, opencode). */
const SERVER_MAP_KEYS = ['mcpServers', 'servers', 'mcp', 'mcp_servers'] as const
const MAX_WRAPPER_DEPTH = 8
const MAX_WRAPPER_NODES = 5000
const MAX_REGIONS = 32
const MAX_REGION_MISSES = 16
/** Pastes above this size skip the extraction strategies (bounds UI work). */
const MAX_CANDIDATE_LENGTH = 4 * 1024 * 1024

/** A raw entry rich enough to become a server definition. */
function isServerLike(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  return (
    typeof value.command === 'string' ||
    Array.isArray(value.command) ||
    typeof value.url === 'string' ||
    typeof value.transport === 'string'
  )
}

/** Object-valued entries of one map, in document order. */
function objectEntries(value: Record<string, unknown>): [string, Record<string, unknown>][] {
  const entries: [string, Record<string, unknown>][] = []
  for (const [name, entry] of Object.entries(value)) {
    if (isObject(entry)) entries.push([name, entry])
  }
  return entries
}

/** `name` field of a listed server entry, when it has one. */
function entryName(entry: Record<string, unknown>): string | undefined {
  return typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined
}

/**
 * Named servers reachable through the explicit map keys, including an array
 * value (`mcpServers: [ {...} ]`), across wrapper keys (bounded BFS with a
 * head index and a visited budget).
 */
function collectMapEntries(root: Record<string, unknown>): [string, Record<string, unknown>][] {
  const found: [string, Record<string, unknown>][] = []
  const queue: { node: Record<string, unknown>; depth: number }[] = [{ node: root, depth: 0 }]
  let head = 0
  while (head < queue.length && head < MAX_WRAPPER_NODES) {
    const { node, depth } = queue[head]!
    head += 1
    const consumed = new Set<string>()
    for (const key of SERVER_MAP_KEYS) {
      const candidate = node[key]
      if (isObject(candidate)) {
        const entries = objectEntries(candidate).filter(([, entry]) => isServerLike(entry))
        if (entries.length === 0) continue
        for (const [name, entry] of entries) found.push([name, entry])
        consumed.add(key)
      } else if (Array.isArray(candidate)) {
        const listed = candidate.filter(isServerLike)
        if (listed.length === 0) continue
        for (const entry of listed) {
          const name = entryName(entry)
          if (name !== undefined) found.push([name, entry])
        }
        consumed.add(key)
      }
    }
    if (depth >= MAX_WRAPPER_DEPTH) continue
    // Walk on through wrapper keys only: a collected map holds servers, not maps.
    for (const [key, entry] of Object.entries(node)) {
      if (isObject(entry) && !consumed.has(key) && !isServerLike(entry)) queue.push({ node: entry, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Named servers of one parsed snippet, found by a bounded, iterative walk: a
 * deeply nested paste must never overflow the stack. Explicit maps win and are
 * MERGED in discovery order, then a bare map of named servers, then the first
 * server behind a wrapper key.
 */
function findServerEntries(parsed: unknown): [string | undefined, Record<string, unknown>][] {
  if (isServerLike(parsed)) return [[entryName(parsed), parsed]]

  const roots: Record<string, unknown>[] = []
  if (Array.isArray(parsed)) {
    const listed: [string | undefined, Record<string, unknown>][] = []
    for (const entry of parsed) {
      if (isServerLike(entry)) listed.push([entryName(entry), entry])
    }
    if (listed.length > 0) return listed
    for (const entry of parsed) if (isObject(entry)) roots.push(entry)
  } else if (isObject(parsed)) {
    roots.push(parsed)
  }
  if (roots.length === 0) return []

  const found: [string | undefined, Record<string, unknown>][] = []
  const names = new Set<string>()
  const add = (key: string, entry: Record<string, unknown>): void => {
    const name = key.trim()
    if (name === '' || names.has(name)) return
    names.add(name)
    found.push([name, entry])
  }
  for (const root of roots) {
    for (const [key, entry] of collectMapEntries(root)) add(key, entry)
  }
  if (found.length > 0) return found
  for (const root of roots) {
    for (const [key, entry] of objectEntries(root)) {
      if (isServerLike(entry)) add(key, entry)
    }
  }
  if (found.length > 0) return found
  const queue: { node: unknown; wrapper?: string }[] = roots.map((node) => ({ node }))
  let head = 0
  while (head < queue.length && head < MAX_WRAPPER_NODES) {
    const { node, wrapper } = queue[head]!
    head += 1
    if (isServerLike(node)) return [[wrapper, node]]
    if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        const label = key.trim()
        if (isObject(child) || Array.isArray(child)) queue.push({ node: child, wrapper: label === '' ? wrapper : label })
      }
    } else if (Array.isArray(node)) {
      for (const child of node) if (isObject(child) || Array.isArray(child)) queue.push({ node: child, wrapper })
    }
  }
  return []
}

/**
 * Scalar list from a JSON array: numbers/booleans are coerced, null-ish and
 * structurally nested entries are skipped (one bad token no longer voids the
 * whole list).
 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') out.push(entry)
    else if (typeof entry === 'number' || typeof entry === 'boolean') out.push(String(entry))
  }
  return out
}

const TRUE_FLAGS = new Set(['true', '1', 'yes', 'on', 'enabled'])
const FALSE_FLAGS = new Set(['false', '0', 'no', 'off', 'disabled'])

/** Boolean flag from a boolean, a number (`0`/`1`) or a `"true"`-style string. */
function flagValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (TRUE_FLAGS.has(normalized)) return true
  if (FALSE_FLAGS.has(normalized)) return false
  const numeric = /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : undefined
  return numeric === undefined ? undefined : numeric !== 0
}

/** Text form of a config value: null-ish is empty, structures serialize. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Secret rows from `env` / `environment`: an object map, a `{name,value}` list
 * or a list of `KEY=value` strings.
 */
function envRows(raw: Record<string, unknown>): { key: string; value: string }[] {
  for (const key of ['env', 'environment'] as const) {
    const value = raw[key]
    const rows: { key: string; value: string }[] = []
    if (isObject(value)) {
      for (const [name, entry] of Object.entries(value)) {
        if (name === '') continue
        rows.push({ key: name, value: scalarText(entry) })
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          for (const pair of parseKeyValueLines(entry)) rows.push({ key: pair.key, value: pair.value })
          continue
        }
        if (!isObject(entry)) continue
        const name = typeof entry.name === 'string' ? entry.name : typeof entry.key === 'string' ? entry.key : ''
        if (name === '') continue
        rows.push({ key: name, value: scalarText(entry.value) })
      }
    }
    if (rows.length > 0) return rows
  }
  return []
}

/**
 * Secret rows from `headers`: an object map, a `{name,ref,value}` list or a list
 * of `Name: value` strings.
 */
function headerRows(raw: Record<string, unknown>): { name: string; ref: string; value: string }[] {
  const value = raw.headers
  const rows: { name: string; ref: string; value: string }[] = []
  if (isObject(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (name === '') continue
      rows.push({ name, ref: refFromHeaderName(name), value: scalarText(entry) })
    }
    return rows
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        for (const row of parseHeaderLines(entry)) {
          rows.push({ name: row.name, ref: refFromHeaderName(row.name), value: row.value })
        }
        continue
      }
      if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '') continue
      const ref = typeof entry.ref === 'string' && entry.ref !== '' ? entry.ref : refFromHeaderName(entry.name)
      rows.push({ name: entry.name, ref, value: scalarText(entry.value) })
    }
  }
  return rows
}

/** `type` values that mean "remote transport" in the common clients. */
const REMOTE_TYPES = new Set(['remote', 'http', 'https', 'sse', 'streamable-http', 'streamable_http'])

/** Remote when only a URL is present; the `type` hint breaks command+url ties. */
function remoteTransport(hasCommand: boolean, hasUrl: boolean, remoteTyped: boolean): boolean {
  if (hasCommand) return hasUrl && remoteTyped
  return hasUrl ? true : remoteTyped
}

/** First timeout candidate that reads as a finite positive number of ms. */
function pickTimeout(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const numeric = Number(candidate.trim())
      if (Number.isFinite(numeric) && numeric > 0) return numeric
    }
  }
  return undefined
}

function convert(name: string | undefined, raw: Record<string, unknown>): ImportedServer {
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : undefined
  const remoteTyped = type !== undefined && REMOTE_TYPES.has(type)
  const commandList = stringArray(raw.command)
  const args =
    stringArray(raw.args) ?? (typeof raw.args === 'string' && raw.args.trim() !== '' ? splitCommandLine(raw.args) : [])
  const commandTokens = commandList ?? (typeof raw.command === 'string' && raw.command.trim() !== '' ? splitCommandLine(raw.command) : [])
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const isRemote = remoteTransport(commandTokens.length > 0, url !== '', remoteTyped)
  const timeout = pickTimeout([raw.timeoutMs, raw.timeout])
  const serverName = typeof name === 'string' ? name.trim() : name
  const base = {
    ...(serverName !== undefined && serverName !== '' ? { name: serverName } : {}),
    env: envRows(raw),
    enabled: flagValue(raw.disabled) === true ? false : flagValue(raw.enabled) ?? true,
    ...(timeout !== undefined ? { timeoutMs: String(Math.round(timeout)) } : {}),
  }
  if (isRemote) {
    return { ...base, transport: 'streamable-http', url, headers: headerRows(raw) }
  }
  const [command, ...rest] = commandTokens
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() !== '' ? raw.cwd.trim() : undefined
  return {
    ...base,
    transport: 'stdio',
    command: command ?? '',
    args: [...rest, ...args],
    ...(cwd !== undefined ? { cwd } : {}),
    headers: [],
  }
}

/**
 * Parse one MCP JSON snippet. Business failures are returned, never thrown;
 * the first NAMED server found wins (an example snippet pasted above the real
 * config must not shadow it) and the other names are reported. The snippet is
 * read as JSON/JSONC only — pasted text is never evaluated.
 */
export function parseMcpSnippet(text: string): ImportOutcome {
  const trimmed = normalizeInput(text).trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  try {
    let parsedAny = false
    let unnamed: [string | undefined, Record<string, unknown>][] | undefined
    for (const candidate of jsonCandidates(trimmed)) {
      let value: unknown
      try {
        value = JSON.parse(candidate) as unknown
      } catch {
        continue
      }
      parsedAny = true
      const entries = findServerEntries(value)
      if (entries.length === 0) continue
      if (entries.some(([name]) => name !== undefined)) {
        const [firstName, firstEntry] = entries[0]!
        return {
          ok: true,
          server: convert(firstName, firstEntry),
          others: entries.slice(1).map(([name]) => name).filter((name): name is string => name !== undefined),
        }
      }
      unnamed ??= entries
    }
    if (unnamed !== undefined) {
      const [firstName, firstEntry] = unnamed[0]!
      return {
        ok: true,
        server: convert(firstName, firstEntry),
        others: unnamed.slice(1).map(([name]) => name).filter((name): name is string => name !== undefined),
      }
    }
    return { ok: false, reason: parsedAny ? 'unsupported' : 'invalid' }
  } catch {
    // Contract: nothing a clipboard can hold may throw into the settings UI.
    return { ok: false, reason: 'invalid' }
  }
}