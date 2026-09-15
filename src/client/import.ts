/**
 * Pure paste / import parsers for the staged server form.
 *
 * Deliberately React-free and host-free: the form calls these on clipboard
 * text, and the unit tests drive them directly. Nothing here writes a
 * document — the result only fills the staged draft, whose secret inputs are
 * write-only and reach the credentials domain on Save.
 *
 * Supported snippets (first server wins, the rest are reported):
 *   - `{ "mcpServers": { "<name>": { command/url/... } } }` (Claude/Cursor)
 *   - `{ "mcp": { "<name>": { type: 'local'|'remote', ... } } }` (opencode)
 *   - a single flat `{ command, args, env, ... }` / `{ url, headers }` object
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
 * escape outside single quotes). Empty quoted arguments are preserved.
 */
export function splitCommandLine(text: string): string[] {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== null) {
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
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
    rows.push({ key, value: unquote(line.slice(equals + 1).trim()) })
  }
  return rows
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

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined
}

function envRows(raw: Record<string, unknown>): { key: string; value: string }[] {
  for (const key of ['env', 'environment'] as const) {
    const value = raw[key]
    if (!isObject(value)) continue
    const rows: { key: string; value: string }[] = []
    for (const [name, entry] of Object.entries(value)) {
      if (name === '') continue
      rows.push({ key: name, value: typeof entry === 'string' ? entry : String(entry ?? '') })
    }
    if (rows.length > 0) return rows
  }
  return []
}

function headerRows(raw: Record<string, unknown>): { name: string; ref: string; value: string }[] {
  const value = raw.headers
  const rows: { name: string; ref: string; value: string }[] = []
  if (isObject(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (name === '') continue
      rows.push({ name, ref: refFromHeaderName(name), value: typeof entry === 'string' ? entry : String(entry ?? '') })
    }
    return rows
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '') continue
      const ref = typeof entry.ref === 'string' && entry.ref !== '' ? entry.ref : refFromHeaderName(entry.name)
      rows.push({ name: entry.name, ref, value: typeof entry.value === 'string' ? entry.value : '' })
    }
  }
  return rows
}

function convert(name: string | undefined, raw: Record<string, unknown>): ImportedServer {
  const type = typeof raw.type === 'string' ? raw.type : undefined
  const commandList = stringArray(raw.command)
  const args = stringArray(raw.args) ?? []
  const commandTokens = commandList ?? (typeof raw.command === 'string' && raw.command.trim() !== '' ? splitCommandLine(raw.command) : [])
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const isRemote = type === 'remote' || type === 'streamable-http' || type === 'http' || (commandTokens.length === 0 && url !== '')
  const timeoutRaw = raw.timeoutMs ?? raw.timeout
  const timeout =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? String(Math.round(timeoutRaw)) : undefined
  const base = {
    ...(name !== undefined && name !== '' ? { name } : {}),
    env: envRows(raw),
    enabled: raw.enabled !== false && raw.disabled !== true,
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
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
 * the first server found wins and the other names are reported.
 */
export function parseMcpSnippet(text: string): ImportOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!isObject(parsed)) return { ok: false, reason: 'invalid' }

  const maps = [parsed.mcpServers, parsed.mcp].filter(isObject)
  const entries: [string, Record<string, unknown>][] = []
  for (const map of maps) {
    for (const [name, entry] of Object.entries(map)) {
      if (isObject(entry)) entries.push([name, entry])
    }
  }
  if (entries.length === 0) {
    // Flat single-server object: either a server shape directly, or exactly one
    // named entry at the top level.
    if ('command' in parsed || 'url' in parsed || 'transport' in parsed) {
      return { ok: true, server: convert(undefined, parsed), others: [] }
    }
    for (const [name, entry] of Object.entries(parsed)) {
      if (isObject(entry) && ('command' in entry || 'url' in entry)) entries.push([name, entry])
    }
  }
  if (entries.length === 0) return { ok: false, reason: 'unsupported' }
  const [firstName, firstEntry] = entries[0]!
  return {
    ok: true,
    server: convert(firstName, firstEntry),
    others: entries.slice(1).map(([name]) => name),
  }
}
