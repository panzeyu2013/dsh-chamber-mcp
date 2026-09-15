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

/** Observable runtime store + the actions the cards call. */
export interface RuntimeStore {
  getSnapshot(): RuntimeSnapshot
  subscribe(listener: () => void): () => void
  refresh(options?: { silent?: boolean }): Promise<void>
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
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RuntimeCallError'
    this.code = code
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
 * Create the runtime store. Refresh dedupes concurrent runs; the action calls
 * fold business failures into thrown RuntimeCallErrors and refresh the
 * snapshot afterwards on success.
 */
export function createRuntimeStore(options: RuntimeStoreOptions = {}): RuntimeStore {
  const fetchLike = options.fetchLike ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  let snapshot: RuntimeSnapshot = EMPTY
  let inFlight: Promise<void> | undefined
  /** A refresh asked for while one was in flight: run exactly one trailing pass. */
  let trailing = false
  const listeners = new Set<() => void>()

  const publish = (next: RuntimeSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetchLike(path, init)
    } catch (error) {
      throw new RuntimeCallError('unavailable', error instanceof Error ? error.message : 'runtime route unreachable')
    }
    let payload: Envelope<T>
    try {
      payload = (await response.json()) as Envelope<T>
    } catch {
      throw new RuntimeCallError('unavailable', 'runtime route returned no JSON')
    }
    if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
      const code = payload?.error?.code ?? 'error'
      const message = payload?.error?.message ?? 'runtime route failed'
      throw new RuntimeCallError(code, message)
    }
    return payload.value as T
  }

  async function refresh(refreshOptions?: { silent?: boolean }): Promise<void> {
    if (inFlight !== undefined) {
      // An action's post-write refresh must not be absorbed by a poll that was
      // already in flight when the click landed.
      trailing = true
      return inFlight
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
          phase: runtimeError.code === 'unavailable' ? 'unavailable' : 'error',
          servers: {},
          error: runtimeError.message,
        })
      }
    })()
    inFlight = run
    try {
      await run
    } finally {
      if (inFlight === run) inFlight = undefined
      if (trailing) {
        trailing = false
        void refresh({ silent: true })
      }
    }
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
