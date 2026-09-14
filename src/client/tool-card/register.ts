/**
 * Registration lifecycle of the MCP tool views (browser half).
 *
 * The keyed `tool.call.toolview` slot dispatches by EXACT wire tool name, and
 * MCP names only exist once a server has listed its tools, so the view set has
 * to be reconciled rather than declared: this module keeps the live
 * registration set in step with the MCP tools a session actually offered the
 * model, and disposes what left.
 *
 * Two pieces, kept apart so each is testable without a browser:
 *
 * - {@link createToolCardRegistry} — the diff. Desired names in, keyed views
 *   registered/disposed out, under a hard cap (the keyed dispatch is a linear
 *   scan of the slot's entries, so an unbounded set would tax every tool row
 *   in the transcript);
 * - {@link startToolCardObserver} — the source. Watches the staged session's
 *   event window for `request/header` tools and feeds the diff. A missing
 *   session service is not an error: the feature simply stays off and the
 *   shipped generic row renders.
 *
 * @module
 */

import type { ServerDef } from '../../shared/model.js'
import { identifyMcpTool, mcpToolNamesOf, type McpToolIdentity } from './names.js'

/**
 * Registers one keyed tool view for an exact wire name. Returns its disposer,
 * or `undefined` when the registration could not be installed (the caller
 * reports it and retries later).
 */
export interface ToolViewHost {
  register(identity: McpToolIdentity): (() => void) | undefined
}

/**
 * Registered-view cap. One server may legally list up to `MAX_SYNC_TOOLS`
 * (2000) tools, and the keyed dispatch projects the slot's whole entry list on
 * every rendered row (`entriesOfSlot` is computed per call, not memoized), so
 * the row lane registers at most this many names and leaves the rest on the
 * shipped generic row.
 */
export const DEFAULT_TOOL_VIEW_LIMIT = 256

/** Construction deps of the registry. */
export interface ToolCardRegistryOptions {
  host: ToolViewHost
  /** Live configured servers (the settings document projection). */
  servers: () => readonly ServerDef[]
  /** Cap override (tests). */
  limit?: number
  /** Called once per refused name when the cap is hit. */
  onRefuse?: (publicName: string) => void
  /**
   * Called when one reconciliation could not run to completion. Reconciliation
   * happens inside framework publish paths (a session window mutation, a
   * settings commit), so a throw here would surface as a broken transcript or a
   * broken settings UI — the lane reports and degrades instead.
   */
  onError?: (error: unknown) => void
}

/** The diff between discovered MCP tools and registered views. */
export interface ToolCardRegistry {
  /** Reconcile the registered set against names seen in one session window. */
  sync(names: readonly string[]): void
  /**
   * Re-run the last reconciliation against the CURRENT server document, so a
   * transport switch (or a server leaving the document) is reflected without
   * waiting for the next discovery.
   */
  resync(): void
  /** Number of live registrations (diagnostics and tests). */
  size(): number
  /** Dispose every registration (plugin teardown). */
  dispose(): void
}

/** Whether a re-registration is needed (transport badge follows the document). */
function sameIdentity(left: McpToolIdentity, right: McpToolIdentity): boolean {
  return (
    left.publicName === right.publicName &&
    left.serverName === right.serverName &&
    left.toolName === right.toolName &&
    left.transport === right.transport
  )
}

/**
 * Create the registration diff.
 *
 * @param options - host registrar, live server source and cap.
 * @returns the registry.
 */
export function createToolCardRegistry(options: ToolCardRegistryOptions): ToolCardRegistry {
  const limit = options.limit ?? DEFAULT_TOOL_VIEW_LIMIT
  const applied = new Map<string, { identity: McpToolIdentity; dispose: () => void }>()
  let lastNames: readonly string[] = []
  let disposed = false

  const reconcile = (names: readonly string[]) => {
    if (disposed) return
    try {
      reconcileInner(names)
    } catch (error) {
      options.onError?.(error)
    }
  }

  const reconcileInner = (names: readonly string[]) => {
    const servers = options.servers()
    const desired = new Map<string, McpToolIdentity>()
    for (const name of names) {
      const identity = identifyMcpTool(name, servers)
      if (identity !== undefined) desired.set(name, identity)
    }
    // Drop what left, or what the document re-shaped (server renamed,
    // transport switched): the identity is captured by the view's closure.
    for (const [name, entry] of [...applied]) {
      const want = desired.get(name)
      if (want === undefined || !sameIdentity(entry.identity, want)) {
        applied.delete(name)
        entry.dispose()
      }
    }
    for (const [name, identity] of desired) {
      if (applied.has(name)) continue
      if (applied.size >= limit) {
        options.onRefuse?.(name)
        continue
      }
      const dispose = options.host.register(identity)
      // A refused registration stays OUT of the applied set, so the next
      // discovery or settings pass retries it instead of leaving the name
      // permanently half-registered.
      if (typeof dispose !== 'function') continue
      applied.set(name, { identity, dispose })
    }
  }

  return {
    sync(names) {
      lastNames = [...names]
      reconcile(lastNames)
    },
    resync() {
      reconcile(lastNames)
    },
    size: () => applied.size,
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of applied.values()) entry.dispose()
      applied.clear()
    },
  }
}

/** Minimal observable source (getSnapshot + subscribe), no package import. */
export interface SnapshotSource<Snapshot> {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
}

/** The slice of `ctx.sessions` this lane reads. */
export interface SessionsLike {
  list: SnapshotSource<{ current?: unknown }>
  binding(id: string): { eventSource: SnapshotSource<{ entries?: readonly unknown[] }> } | undefined
}

/** Construction deps of the observer. */
export interface ToolCardObserverOptions {
  /** The client session service, when the composition provides it. */
  sessions: SessionsLike | undefined
  registry: ToolCardRegistry
}

/**
 * Watch the staged session's event window and feed every MCP tool name the
 * model was offered to the registry. Names accumulate across sessions: a
 * registration stays valid for the whole page, and rows in a revisited session
 * keep their custom view even when that session's window no longer reaches the
 * request that first named the tool.
 *
 * @param options - the sessions slice and the registry to feed.
 * @returns disposer detaching every subscription (plugin teardown).
 */
export function startToolCardObserver(options: ToolCardObserverOptions): () => void {
  const { sessions, registry } = options
  if (sessions === undefined) return () => {}
  let offEvents: (() => void) | undefined
  let boundId: string | undefined
  // Names accumulate across sessions: a registration stays valid for the life
  // of the page, so rows in a revisited session keep their custom view even
  // when its window no longer reaches the request that first named the tool.
  const seen = new Set<string>()

  const syncBound = () => {
    if (boundId === undefined) return
    const binding = sessions.binding(boundId)
    if (binding === undefined) return
    const entries = binding.eventSource.getSnapshot().entries ?? []
    const names = mcpToolNamesOf(entries)
    if (names.length === 0) return
    let added = false
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      added = true
    }
    if (added) registry.sync([...seen])
  }

  const bindCurrent = () => {
    const current = sessions.list.getSnapshot().current
    const nextId = typeof current === 'string' ? current : undefined
    if (nextId === boundId) {
      syncBound()
      return
    }
    offEvents?.()
    offEvents = undefined
    boundId = nextId
    if (nextId === undefined) return
    const binding = sessions.binding(nextId)
    if (binding === undefined) return
    offEvents = binding.eventSource.subscribe(syncBound)
    syncBound()
  }

  const offList = sessions.list.subscribe(bindCurrent)
  bindCurrent()
  return () => {
    offList()
    offEvents?.()
    offEvents = undefined
  }
}
