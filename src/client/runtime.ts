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
  /**
   * Forget every remembered/dead base and re-arm discovery. Called on
   * `connection/reset`: a fresh connection generation can mean a restarted host
   * or a different instance, and a base proven dead by the previous generation
   * must not keep the panel dark.
   */
  resetBases(): void
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
  /**
   * Authoritative per-instance proxy prefix supplied by the EMBEDDING shell — the
   * chamber desktop provides `chamberBasePath` to the client plugins it mounts,
   * which is the only signal its topology exposes (see `discoverShellBasePath`).
   * Read before every other signal; `undefined` leaves the other signals alone.
   */
  shellBasePath?: () => string | undefined
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

/** Same-origin projection the chamber shell answers with the instance on screen. */
const SHELL_CONNECTIONS_PATH = '/api/connections'

/** Instance ids are opaque tokens; anything else must never reach a URL. */
// The shell mints ids as `local` or `(dsh|gateway|ssh)-` + a token of up to 64
// `[A-Za-z0-9_-]` characters (its own pattern validates the token AFTER the
// prefix), so the total may reach 72: a plain total-length cap would silently
// refuse a legitimate long id and leave that instance's panel permanently
// unavailable. Dots, percent signs, backslashes and tildes are never minted.
const INSTANCE_ID = /^(?:[A-Za-z0-9_-]{1,64}|(?:dsh-|gateway-|ssh-)[A-Za-z0-9_-]{1,64})$/

/** Cap of resource/DOM entries inspected per discovery (tail, newest last). */
const MAX_SCAN_ENTRIES = 64

/**
 * Discoveries one store may attempt before an explicit refresh re-arms it. Two
 * covers "the shell answered late" without letting a page that never reaches the
 * shell issue a probe on every poll or per-server refresh.
 */
const MAX_DISCOVERY_ATTEMPTS = 2

/** Accept only a rooted, same-origin prefix; normalize away trailing slashes. */
function normalizeBasePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '/') return undefined
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined
  const normalized = trimmed.replace(/\/+$/, '')
  // A dotted segment is normalized by the browser into a DIFFERENT path than the
  // one intended (`/api/i/../api` → `/api/api`), and percent-encoding or a
  // backslash reaches the same place on some layers, so no signal may carry any
  // of them.
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return undefined
  if (/[%\\]/.test(normalized)) return undefined
  return normalized
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
/**
 * Instance id named by the shell's own connections projection.
 *
 * Accepted shapes: `{connection:{id}}` (the active one) or `{connections:[…]}`.
 * A `ready` row wins; otherwise the first row with a usable id. Anything else —
 * including an id that is not a plain token — yields nothing.
 */
function shellConnectionId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as { connection?: unknown; connections?: unknown }
  const rows: unknown[] = []
  if (record.connection !== undefined) rows.push(record.connection)
  if (Array.isArray(record.connections)) rows.push(...record.connections)
  const pick = (row: unknown): string | undefined => {
    if (row === null || typeof row !== 'object') return undefined
    const id = (row as { id?: unknown; connectionId?: unknown }).id ?? (row as { connectionId?: unknown }).connectionId
    return typeof id === 'string' && INSTANCE_ID.test(id) ? id : undefined
  }
  for (const row of rows) {
    const id = pick(row)
    const status = row !== null && typeof row === 'object' ? (row as { status?: unknown }).status : undefined
    if (id !== undefined && status === 'ready') return id
  }
  for (const row of rows) {
    const id = pick(row)
    if (id !== undefined) return id
  }
  return undefined
}

/**
 * Whether a shell-supplied prefix is one this store may act on.
 *
 * The shell's `chamberBasePath` is always `/api/i/<instanceId>` (the shell
 * validates exactly that shape before providing it), so anything else is not
 * trusted here — and a dotted id (`.`, `..`) is refused even though it matches
 * the loose pattern, because the browser would normalize
 * `/api/i/../api/…` into a DIFFERENT path than the one intended.
 */
function isUsableShellBase(value: string): boolean {
  if (!INSTANCE_PREFIX.test(value)) return false
  return INSTANCE_ID.test(value.slice('/api/i/'.length))
}

/**
 * Read the embedding shell's per-instance proxy prefix (`/api/i/<instanceId>`).
 *
 * `ctx.get` is the contract: it answers value-or-undefined, and a plain property
 * read must NOT be consulted when it returns `undefined` (a service this fiber
 * provided and disposed still answers the property read with a ghost). The
 * property form exists only for a context whose `get` itself is unusable.
 *
 * TOTAL by construction, because both halves of this contract are hostile:
 * cordis answers a PROPERTY read of a service that no fiber provided — and that
 * this fiber never declared in `inject` — with a THROW
 * (`cannot get property "X" without inject`), and a plain `dsh web` deployment
 * has no shell service at all. Aborting the first refresh there would leave the
 * panel dead exactly as before the fix. The documented non-throwing accessor is
 * `ctx.get(name)`, which returns the value or `undefined`; the property read is
 * kept only as a last resort inside a try/catch, for a generation that exposes
 * the value without registering it as a service.
 *
 * @param ctx - the plugin context (typed loosely: the shell's service is outside
 *   this plugin's typed context surface).
 * @returns the prefix string, or `undefined` when no shell signal is available.
 */
export function readShellBasePath(ctx: unknown): string | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const scope = ctx as { get?: unknown; chamberBasePath?: unknown }
  // Every step is guarded, including the probe for `get` itself: a proxied
  // context is allowed to throw on ANY property access, and this accessor's one
  // contract is that it never throws.
  let getter: unknown
  try {
    getter = scope.get
  } catch {
    // A proxied context is allowed to throw on ANY property access.
    return undefined
  }
  if (typeof getter === 'function') {
    // The documented accessor answers value-or-undefined: trust it COMPLETELY.
    // Falling back to the property form on a legitimate `undefined` would read a
    // ghost (a service this fiber provided and disposed still answers the
    // property read), i.e. a stale instance prefix.
    try {
      const value = (getter as (name: string) => unknown).call(ctx, 'chamberBasePath')
      return typeof value === 'string' ? value : undefined
    } catch {
      /* this composition's service store misbehaved: try the property form */
    }
  }
  try {
    const value = scope.chamberBasePath
    if (typeof value === 'string') return value
  } catch {
    /* cordis throws for an unprovided service this fiber never declared */
  }
  return undefined
}

/**
 * LAST-RESORT discovery for the chamber desktop topology.
 *
 * There the dsh UI is mounted into the shell's OWN document, every asset URL it
 * loads is root-relative and no base global is injected — so neither
 * `location.pathname`, nor the resource timeline, nor `__DSH_BASE_PATH__` can
 * name the instance, and a root-relative plugin request is answered by the
 * shell's static layer with `404 {"error":"not_found"}` (which is why the whole
 * runtime panel reads "unknown" there). The prefix still exists on the wire: the
 * shell serves each instance under `/api/i/<instanceId>/…` and answers its own
 * same-origin connections projection with the instance that is on screen. One
 * guarded request recovers it.
 *
 * A plain `dsh web` document has no such route (404) and is left untouched, and
 * a cross-origin document is never queried at all.
 */
export async function discoverShellBasePath(fetchLike: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<string | undefined> {
  if (typeof globalThis === 'undefined') return undefined
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return undefined
  let payload: unknown
  try {
    const response = await fetchLike(origin + SHELL_CONNECTIONS_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    payload = await response.json()
  } catch {
    return undefined
  }
  const id = shellConnectionId(payload)
  return id === undefined ? undefined : normalizeBasePath('/api/i/' + id)
}

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
   * Prefix recovered by `discoverShellBasePath` (chamber topology), if any, and
   * the in-flight probe: concurrent callers JOIN one discovery instead of one of
   * them failing while the other is still awaiting.
   */
  let recoveredBase: string | undefined
  /**
   * The instance the shell itself named the last time it answered. Once the
   * shell has spoken, it PINS the candidate set for the rest of the connection
   * generation: if its service disappears (an older shell unloads, a route
   * clears) the panel may serve that instance or nothing — never a sniffed or
   * recovered prefix that could be a DIFFERENT one.
   */
  let pinnedBase: string | undefined
  let discoveryInFlight: Promise<string | undefined> | undefined
  /** Discoveries attempted for this store; bounded so a dead shell costs two. */
  let discoveryAttempts = 0
  /**
   * Bumped by {@link resetBases}. A call that awaited a probe (or a full pass
   * that awaited a route) across a reset must discard its answer: the previous
   * connection generation's instance may no longer be the one on screen, and
   * adopting it would show — and act on — the wrong one.
   */
  let baseGeneration = 0
  const candidateBases = (): string[] => {
    const bases: string[] = []
    const add = (value: string): void => {
      if (!bases.includes(value) && !deadBases.has(value)) bases.push(value)
    }
    // A LIVE shell answer PINS the instance this page is showing. Only it and the
    // root origin (same origin, no instance at all) stay candidates: a sniffed,
    // recovered or remembered prefix that disagrees with the shell could be
    // ANOTHER instance, and serving it would show — and ACT on — the wrong one
    // (connect/disconnect POSTs included). A live base that stops answering
    // leaves the panel on root/unavailable until it answers again or the shell
    // publishes a new value; showing nothing beats showing someone else's state.
    //
    // Without a live answer: the freshly sniffed document base first, then a
    // recovered prefix, then the remembered one, then the root origin. A base
    // that already answered without this plugin's wire envelope is skipped, so a
    // dead candidate costs one request instead of one per poll.
    const live = liveInstanceBase()
    if (live !== undefined) {
      pinnedBase = live
      if (recoveredBase !== undefined && recoveredBase !== live) recoveredBase = undefined
      add(live)
      add('')
      return bases
    }
    if (pinnedBase !== undefined) {
      // The shell already named the instance on this page and has now stopped
      // answering: falling back to a sniffed/recovered/remembered prefix would
      // risk another instance's data (and its connect/disconnect POSTs).
      add(pinnedBase)
      add('')
      return bases
    }
    add(readBasePath() ?? '')
    if (recoveredBase !== undefined) add(recoveredBase)
    if (hasBase) add(basePath ?? '')
    add('')
    return bases
  }

  /** The shell's own answer for the instance on screen, when it is usable. */
  function liveInstanceBase(): string | undefined {
    const candidate = normalizeBasePath(options.shellBasePath?.())
    return candidate !== undefined && isUsableShellBase(candidate) ? candidate : undefined
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
    let answered: T | undefined
    let delivered = false
    /**
     * The connection generation this attempt belongs to. Everything the awaits
     * below learn describes THAT generation: after a `connection/reset` the
     * remembered base, the dead-base cache and the recovered prefix must keep the
     * new generation's meaning, or a stale answer could re-arm a base the reset
     * dropped — or mark the NEW live base dead forever, which is exactly the
     * "panel stays dark" failure the reset exists to prevent.
     */
    const generation = baseGeneration
    /** Bases this call itself proved dead: never re-adopted by its own probe. */
    const killedHere = new Set<string>()
    for (const base of candidateBases()) {
      try {
        answered = await callOnce<T>(base + path, init)
        if (generation === baseGeneration) {
          basePath = base === '' ? undefined : base
          hasBase = true
        }
        delivered = true
        break
      } catch (error) {
        const failure = error instanceof RuntimeCallError ? error : new RuntimeCallError('error', String(error))
        last = failure
        if (!failure.routeMissing) throw failure
        killedHere.add(base)
        if (generation !== baseGeneration) continue
        deadBases.add(base)
        // A recovered prefix that stops answering is not evidence that the
        // instance is gone: the shell may simply have moved on, so drop it and
        // let the next attempt re-discover (bounded below).
        if (base === recoveredBase) recoveredBase = undefined
      }
    }
    if (delivered) return answered as T
    // Every candidate was answered by something that is not this plugin. In the
    // chamber topology the instance prefix is invisible in the document, so ask
    // the shell and retry with the recovered candidate; only route-missing
    // failures reach here, so no request was ever delivered twice. The budget is
    // bounded (a page that never reaches the shell cannot spin) and concurrent
    // callers JOIN the probe in flight. An explicit refresh re-arms it.
    // A pinned instance never guesses: the shell already named it, and a probe
    // could only produce a DIFFERENT one.
    if (
      liveInstanceBase() === undefined &&
      pinnedBase === undefined &&
      (discoveryInFlight !== undefined || discoveryAttempts < MAX_DISCOVERY_ATTEMPTS)
    ) {
      // Only the caller that actually starts a probe spends budget; callers that
      // JOIN one must not exhaust it before the shell had a chance to answer —
      // and a probe already in flight is joined even when the budget is spent.
      if (discoveryInFlight === undefined) discoveryAttempts += 1
      const probe = discoveryInFlight ?? discoverShellBasePath(options.fetchLike ?? ((...args) => globalThis.fetch(...args)))
      discoveryInFlight = probe
      const found = await probe
      if (discoveryInFlight === probe) discoveryInFlight = undefined
      // Discard an answer that crossed a reset, and never resurrect a base this
      // very call proved dead (that would break the one-request-per-dead-base
      // contract, and a middle layer could turn it into a real double delivery).
      if (generation !== baseGeneration) return call<T>(path, init)
      if (found !== undefined && !killedHere.has(found)) {
        recoveredBase = found
        deadBases.delete(found)
        return call<T>(path, init)
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
    // A pass that crosses a `connection/reset` describes the PREVIOUS connection
    // generation: its answer must not be published (the instance on screen may
    // have changed with it).
    const generation = baseGeneration
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
        if (generation !== baseGeneration) return
        const servers: Record<string, ServerRuntimeView> = {}
        for (const server of value.servers) servers[server.name] = server
        publish({ phase: 'ready', at: value.at, servers })
      } catch (error) {
        // A failure learned against the PREVIOUS connection generation must not
        // paint the new one (its bases may be fine).
        if (generation !== baseGeneration) return
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
    // Same rule as a full pass: an answer that crossed a `connection/reset`
    // describes the instance that was on screen BEFORE it.
    const generation = baseGeneration
    const run = (async () => {
      const value = await call<{ v: 1; at: number; servers: ServerRuntimeView[] }>(
        RUNTIME_STATUS_PATH + '?server=' + encodeURIComponent(server),
      )
      if (generation !== baseGeneration) return
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
    // An EXPLICIT refresh re-arms DISCOVERY — a shell that answered late deserves
    // another chance — but never the dead-base cache: "a base that answered
    // without this plugin's wire envelope costs one request, not one per poll" is
    // a documented contract of the cheap poll path. The full reset (dead bases
    // included) belongs to `connection/reset`, where a new connection generation
    // means the old answers prove nothing.
    if (refreshOptions?.silent !== true) discoveryAttempts = 0
    const server = refreshOptions?.server
    if (typeof server === 'string') return refreshServer(server)
    return refreshAll(refreshOptions)
  }

  /**
   * Drop every remembered base and re-arm discovery (see {@link RuntimeStore.resetBases}).
   */
  function resetBases(): void {
    baseGeneration += 1
    discoveryInFlight = undefined
    // A pass from the previous generation would return without publishing, so a
    // caller joining it would see neither a request nor a fresh snapshot (and a
    // request that never settles would hold the panel on `loading` forever).
    // The passes' own `finally` blocks use identity checks, so they cannot clear
    // the fresh ones.
    serverInFlight.clear()
    fullInFlight = undefined
    deadBases.clear()
    recoveredBase = undefined
    pinnedBase = undefined
    discoveryAttempts = 0
    hasBase = false
    basePath = undefined
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
    resetBases,
    act,
    test,
    tools,
  }
}