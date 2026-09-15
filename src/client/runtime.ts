/**
 * Browser-side runtime-status store of the mcp-scope settings section.
 *
 * Deliberately dependency-free (global `fetch`, no client package import — the
 * built bundle may require react only): the host routes are plain JSON on the
 * Connection carrier, so the chamber gateway proxy, Host/Origin fence and
 * browser authentication apply unchanged. The store never throws into a render
 * path: a missing route/host degrades the section to "runtime status
 * unavailable" while the document UI keeps working.
 *
 * The store owns no timer. The section orchestrates when to poll (visible
 * panel / after actions); this keeps unit tests deterministic.
 *
 * Wire paths mirror `src/routes.ts` (host half) — the two halves must move
 * together.
 *
 * @module
 */

/** Runtime phases the host reports (wire vocabulary; additive). */
export type RuntimePhase =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'failed'
  | 'stopped'
  | 'disabled'
  | 'unknown'

/** One server's runtime view as received from the host. */
export interface ServerRuntimeView {
  name: string
  state: RuntimePhase
  attempts: number
  maxAttempts: number
  nextRetryAt?: number
  connectedAt?: number
  syncedAt?: number
  toolCount: number
  error?: { code: string; message: string }
}

/** Store snapshot consumed by the section through the hooks seat. */
export interface RuntimeSnapshot {
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  at?: number
  servers: Readonly<Record<string, ServerRuntimeView>>
  /** Human-readable detail of the last refresh failure. */
  error?: string
}

/** One manual connect/disconnect outcome. */
export interface RuntimeActionResult {
  name: string
  state: RuntimePhase
}

/** One probe outcome (test connection). */
export interface RuntimeTestResult {
  ok: boolean
  toolCount?: number
  /** Stable failure code when the probe failed (localized by the card). */
  code?: string
  /** Host-generated fallback message for an unknown code. */
  error?: string
}

/** One synced tool entry of the tool list. */
export interface RuntimeToolEntry {
  publicName: string
  rawName: string
  description: string
}

/** Options for one refresh pass. */
export interface RuntimeRefreshOptions {
  /** Quiet poll: never flips the snapshot to `loading`. */
  silent?: boolean
  /**
   * Refresh only this server's view: the host projects that one entry and the
   * store MERGES it into the current map, leaving every other server entry
   * untouched. A failure rejects with its RuntimeCallError and leaves the
   * global snapshot exactly as it was (the card renders its own error).
   */
  server?: string
}

/** Observable runtime store + the actions the cards call. */
export interface RuntimeStore {
  getSnapshot(): RuntimeSnapshot
  subscribe(listener: () => void): () => void
  refresh(options?: RuntimeRefreshOptions): Promise<void>
  act(name: string, action: 'connect' | 'disconnect'): Promise<RuntimeActionResult>
  test(name: string): Promise<RuntimeTestResult>
  tools(name: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
}

/** Host route paths (mirror of `src/routes.ts`). */
export const RUNTIME_STATUS_PATH = '/api/mcp-scope.status'
export const RUNTIME_ACTION_PATH = '/api/mcp-scope.action'
export const RUNTIME_TOOLS_PATH = '/api/mcp-scope.tools'

/** Failure of one runtime call; carries the host's stable code when present. */
export class RuntimeCallError extends Error {
  readonly code: string
  /** HTTP status when the failure came from a response (undefined = transport). */
  readonly status?: number
  /**
   * True when the origin answered 404 WITHOUT this plugin's wire envelope —
   * i.e. the route is not mounted at that origin (the chamber desktop shell's
   * static layer answers such requests itself). Only this case is worth
   * retrying against another base candidate.
   */
  readonly routeMissing: boolean
  constructor(code: string, message: string, options: { status?: number; routeMissing?: boolean } = {}) {
    super(message)
    this.name = 'RuntimeCallError'
    this.code = code
    this.status = options.status
    this.routeMissing = options.routeMissing === true
  }
}

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

const EMPTY: RuntimeSnapshot = Object.freeze({ phase: 'loading', servers: Object.freeze({}) }) as RuntimeSnapshot

/** Store construction options (fetch is injectable for tests). */
export interface RuntimeStoreOptions {
  fetchLike?: typeof fetch
}

/**
 * Global some desktop shells publish for the per-instance proxy prefix. The
 * chamber build measured 2026-09-15 injects no such global (only
 * `__DSH_BOOT__`/`__DSH_CONNECTION_RECOVERY__`), so it is kept as a secondary
 * signal for other generations and the serving location is the primary one.
 */
const BASE_PATH_GLOBAL = '__DSH_BASE_PATH__'

/** Path shape of a document served through an instance proxy. */
const INSTANCE_PREFIX = /^\/api\/i\/[^/]+/

/** Cap of resource/DOM entries inspected per discovery (tail, newest last). */
const MAX_SCAN_ENTRIES = 64

/** Accept only a rooted, same-origin prefix; normalize away trailing slashes. */
function normalizeBasePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '/') return undefined
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined
  return trimmed.replace(/\/+$/, '')
}

/**
 * Same-origin path prefix this document is served under, when the deployment
 * uses one. Absolute URLs are refused (the shell's `connect-src 'self'` blocks
 * them), and any shape that is not a prefix must leave the plain `dsh web`
 * topology — where the routes are already same-origin — completely untouched.
 */
export function readBasePath(): string | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const explicit = normalizeBasePath((globalThis as Record<string, unknown>)[BASE_PATH_GLOBAL])
  if (explicit !== undefined) return explicit
  // The chamber desktop embeds the dsh UI as a document SERVED FROM
  // `/api/i/<instanceId>/…` and injects no base global, so the running location
  // is the only signal there. Its `<base href="/">` makes `document.baseURI`
  // useless, but `location.pathname` still carries the prefix. A plain
  // `dsh web` document is served at `/` and therefore stays unchanged.
  const pathname = (globalThis as { location?: { pathname?: unknown } }).location?.pathname
  if (typeof pathname === 'string') {
    const match = INSTANCE_PREFIX.exec(pathname)
    if (match !== null) return match[0]
  }
  return basePathFromResources()
}

/**
 * Discover the instance prefix from URLs this document has ALREADY loaded.
 *
 * The chamber desktop serves the dsh UI into the shell's own top-level document
 * (no iframe, no base global): the loader and every API call go through
 * `/api/i/<instanceId>/…`, and this plugin's own bundle is fetched from
 * `/api/i/<instanceId>/plugins/…` — so the prefix is observable in the resource
 * timeline and in the script/link tags, without importing any client package or
 * depending on a deployment-specific global.
 */
function basePathFromResources(): string | undefined {
  const urls: string[] = []
  const seen = new Set<string>()
  const add = (url: unknown): void => {
    if (typeof url !== 'string' || seen.has(url)) return
    seen.add(url)
    urls.push(url)
  }
  // Guarded for hosts without DOM/performance (unit tests, headless render).
  const scope = globalThis as {
    performance?: { getEntriesByType?(type: string): readonly { name?: unknown }[] }
    document?: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> }
  }
  // Bounded to the tail of the timeline: only the most recently loaded
  // resources can describe the instance this page is talking to NOW, and a
  // switch appends the new prefix there.
  try {
    const entries = Array.from(scope.performance?.getEntriesByType?.('resource') ?? [])
    for (const entry of entries.slice(-MAX_SCAN_ENTRIES)) add(entry.name)
  } catch {
    /* performance unavailable */
  }
  try {
    const elements = Array.from(scope.document?.querySelectorAll('script[src], link[href]') ?? [])
    for (const element of elements.slice(-MAX_SCAN_ENTRIES)) {
      add(element.getAttribute('src'))
      add(element.getAttribute('href'))
    }
  } catch {
    /* DOM unavailable */
  }
  // Resolve against the document so a cross-origin resource can never be
  // mistaken for this deployment's proxy: a cross-origin candidate would be
  // refused by the document policy and would abort the whole request instead of
  // falling through to the next base.
  const locationLike = (globalThis as { location?: { href?: unknown } }).location
  const baseHref = typeof locationLike?.href === 'string' ? locationLike.href : 'http://localhost'
  let origin: string
  try {
    origin = new URL(baseHref).origin
  } catch {
    origin = 'http://localhost'
  }
  for (let index = urls.length - 1; index >= 0; index -= 1) {
    const url = urls[index] as string
    let parsed: URL
    try {
      parsed = new URL(url, baseHref)
    } catch {
      continue
    }
    if (parsed.origin !== origin) continue
    const match = INSTANCE_PREFIX.exec(parsed.pathname)
    if (match !== null) return match[0]
  }
  return undefined
}

/**
 * Create the runtime store. Full refreshes dedupe concurrent runs (exactly one
 * trailing pass); per-server refreshes dedupe per server NAME and merge into
 * the current snapshot without ever joining a full pass. The action calls fold
 * business failures into thrown RuntimeCallErrors and refresh the snapshot
 * afterwards on success.
 */
export function createRuntimeStore(options: RuntimeStoreOptions = {}): RuntimeStore {
  const fetchLike = options.fetchLike ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  let snapshot: RuntimeSnapshot = EMPTY
  /** The full pass in flight, if any (deduped as before). */
  let fullInFlight: Promise<void> | undefined
  /** A full refresh asked for while one was in flight: one trailing pass. */
  let trailing = false
  /**
   * Per-server passes, deduped per server NAME only. They never join the full
   * pass and the full pass never joins them: a card's per-server retry must not
   * be answered with — or swallowed by — another pass's result.
   */
  const serverInFlight = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()

  const publish = (next: RuntimeSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  /** Remembered working base (`undefined` = root-relative, the plain topology). */
  let basePath: string | undefined
  let hasBase = false
  /** Bases that answered without this plugin's wire envelope: never retried. */
  const deadBases = new Set<string>()

  /**
   * Bases to try in order. The FRESHLY detected base goes first: a live page can
   * switch instance (the resource timeline then carries the new prefix) and a
   * remembered base that still answers would silently serve the OLD instance's
   * data. The remembered base is the second candidate, the root origin is always
   * last, and a base that already answered without our wire envelope is skipped
   * so a dead candidate costs one request instead of one per poll.
   */
  const candidateBases = (): string[] => {
    const bases: string[] = []
    const add = (value: string): void => {
      if (!bases.includes(value) && !deadBases.has(value)) bases.push(value)
    }
    add(readBasePath() ?? '')
    if (hasBase) add(basePath ?? '')
    add('')
    return bases
  }

  /** One attempt against one origin; never retried internally. */
  async function callOnce<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetchLike(url, init)
    } catch (error) {
      throw new RuntimeCallError('unavailable', error instanceof Error ? error.message : 'runtime route unreachable')
    }
    let payload: Envelope<T> | undefined
    try {
      payload = (await response.json()) as Envelope<T>
    } catch {
      payload = undefined
    }
    if (payload === null || typeof payload !== 'object' || typeof (payload as { ok?: unknown }).ok !== 'boolean') {
      // Not our wire: a static layer (or a proxy) answered. A 404 here means
      // the route is simply not mounted at THIS origin, so another base is
      // worth trying; anything else is reported as-is.
      const missing = response.status === 404
      const detail =
        (missing ? 'runtime route is not mounted at this origin' : 'runtime route returned no wire envelope') +
        ' (HTTP ' +
        String(response.status) +
        ')'
      throw new RuntimeCallError('unavailable', detail, { status: response.status, routeMissing: missing })
    }
    if (payload.ok !== true) {
      const code = payload.error?.code ?? 'error'
      const message = payload.error?.message ?? 'runtime route failed'
      throw new RuntimeCallError(code, message, { status: response.status })
    }
    return payload.value as T
  }

  /**
   * Call one route, trying the deployment bases in order. Only an
   * origin-level 404 falls through to the next candidate: a transport error, an
   * auth refusal or a business failure would repeat identically, and a POST is
   * never delivered twice by accident. The base that answered is remembered and
   * re-validated on every call, so a stale guess self-heals.
   */
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let last: RuntimeCallError | undefined
    for (const base of candidateBases()) {
      try {
        const value = await callOnce<T>(base + path, init)
        basePath = base === '' ? undefined : base
        hasBase = true
        return value
      } catch (error) {
        const failure = error instanceof RuntimeCallError ? error : new RuntimeCallError('error', String(error))
        last = failure
        if (!failure.routeMissing) throw failure
        deadBases.add(base)
      }
    }
    throw last ?? new RuntimeCallError('error', 'runtime route failed')
  }

  /**
   * One FULL pass: replaces the whole server map. Business/transport failures
   * are folded into the snapshot instead of thrown — stale-while-revalidate:
   * the previous views (and their `at`) stay readable — because polls and
   * post-action refreshes are fire-and-forget.
   */
  async function refreshAll(refreshOptions?: RuntimeRefreshOptions): Promise<void> {
    if (fullInFlight !== undefined) {
      // An action's post-write refresh must not be absorbed by a poll that was
      // already in flight when the click landed.
      trailing = true
      return fullInFlight
    }
    if (refreshOptions?.silent !== true && snapshot.phase !== 'ready') publish({ ...snapshot, phase: 'loading' })
    const run = (async () => {
      try {
        const value = await call<{ v: 1; at: number; servers: ServerRuntimeView[] }>(RUNTIME_STATUS_PATH)
        const servers: Record<string, ServerRuntimeView> = {}
        for (const server of value.servers) servers[server.name] = server
        publish({ phase: 'ready', at: value.at, servers })
      } catch (error) {
        const runtimeError =
          error instanceof RuntimeCallError ? error : new RuntimeCallError('error', String(error))
        publish({
          ...snapshot,
          phase: runtimeError.code === 'unavailable' ? 'unavailable' : 'error',
          error: runtimeError.message,
        })
      }
    })()
    fullInFlight = run
    try {
      await run
    } finally {
      if (fullInFlight === run) fullInFlight = undefined
      if (trailing) {
        trailing = false
        void refreshAll({ silent: true })
      }
    }
  }

  /**
   * One PER-SERVER pass: the host projects the requested server and the store
   * merges those entries into the current map (any other entry the host
   * returned is merged too, never dropped). No loading flip and no failure
   * snapshot: a failure rejects with its RuntimeCallError and leaves the global
   * snapshot exactly as it was, so the asking card can render its own error.
   */
  async function refreshServer(server: string): Promise<void> {
    const running = serverInFlight.get(server)
    if (running !== undefined) return running
    const run = (async () => {
      const value = await call<{ v: 1; at: number; servers: ServerRuntimeView[] }>(
        RUNTIME_STATUS_PATH + '?server=' + encodeURIComponent(server),
      )
      const servers: Record<string, ServerRuntimeView> = { ...snapshot.servers }
      for (const entry of value.servers) servers[entry.name] = entry
      // One server answering does not prove the OTHER entries are fresh: keep
      // the snapshot's phase/error (the section's stale banner depends on it)
      // unless the panel was still on its very first load.
      publish({
        ...snapshot,
        phase: snapshot.phase === 'loading' ? 'ready' : snapshot.phase,
        at: value.at,
        servers,
      })
    })()
    serverInFlight.set(server, run)
    try {
      await run
    } finally {
      if (serverInFlight.get(server) === run) serverInFlight.delete(server)
    }
  }

  /**
   * Refresh the runtime status. Without `server` the whole map is replaced and
   * failures degrade the section; with `server` only that view is re-pulled and
   * merged, and a failure rejects (the card owns the error).
   */
  async function refresh(refreshOptions?: RuntimeRefreshOptions): Promise<void> {
    const server = refreshOptions?.server
    if (typeof server === 'string') return refreshServer(server)
    return refreshAll(refreshOptions)
  }

  async function act(name: string, action: 'connect' | 'disconnect'): Promise<RuntimeActionResult> {
    const value = await call<RuntimeActionResult>(RUNTIME_ACTION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, server: name }),
    })
    void refresh({ silent: true })
    return value
  }

  async function test(name: string): Promise<RuntimeTestResult> {
    const value = await call<RuntimeTestResult>(RUNTIME_ACTION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'test', server: name }),
    })
    void refresh({ silent: true })
    return value
  }

  async function tools(name: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }> {
    const query = RUNTIME_TOOLS_PATH + '?server=' + encodeURIComponent(name)
    return call(query)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    act,
    test,
    tools,
  }
}