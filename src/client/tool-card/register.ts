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
 *   event window for `request/header` tools and feeds the diff. The staged
 *   session is selected through the session list — the legacy scalar on the
 *   0.1.5/0.1.6 line, or the 0.1.7 catalog row the main view retains
 *   (`retainedBy.mainView`) — so a generation that moves selection does not
 *   silently switch every MCP row back to the shipped generic one. A missing
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

/** One catalog row, narrowed to the ownership counts this lane reads. */
interface SessionListRowLike {
  /** Local reference counts by source; `mainView` marks the session on screen. */
  readonly retainedBy?: Readonly<Record<string, number>> | undefined
}

/**
 * The list snapshot across the supported generations.
 *
 * The 0.1.5/0.1.6 line published the staged session as `current`; the 0.1.7
 * line dropped that scalar and moved selection into each catalog row's
 * `retainedBy` counts (the conversation shell retains the session it shows
 * under `mainView`, and the shipped UI selects it the same way). A lane that
 * only reads `current` therefore discovers NOTHING on the pinned generation:
 * no registration, no custom row, every MCP call back on the shipped generic
 * row — silently, because this lane is degrades-by-design.
 */
export interface SessionListLike {
  /** Staged session id on the 0.1.5/0.1.6 line (absent on 0.1.7). */
  readonly current?: unknown
  /** Catalog rows keyed by session id (0.1.7). */
  readonly byId?: Readonly<Record<string, SessionListRowLike | undefined>> | undefined
  /** Catalog order; a last-resort scan when no row carries a main-view retain. */
  readonly ids?: readonly unknown[] | undefined
}

/** The slice of `ctx.sessions` this lane reads. */
export interface SessionsLike {
  list: SnapshotSource<SessionListLike>
  /**
   * Borrow the staged session's live event window. ABSENT on a generation whose
   * session service predates this shape (the 0.1.5/0.1.6 line has no such
   * accessor), so the lane probes for it instead of calling through: this lane
   * runs inside framework publish paths, and a call into a method that is not
   * there throws INTO them.
   */
  binding?(id: string): { eventSource: SnapshotSource<{ entries?: readonly unknown[] }> } | undefined
  /** Per-session retain observable (0.1.7); absent on older generations. */
  retainInfo?(id: string): SnapshotSource<unknown> | undefined
}

/** Construction deps of the observer. */
export interface ToolCardObserverOptions {
  /** The client session service, when the composition provides it. */
  sessions: SessionsLike | undefined
  registry: ToolCardRegistry
  /**
   * Called ONCE when the sessions service exists but its shape cannot be used
   * (a generation the lane does not know). The lane then stays off — every MCP
   * call keeps the shipped generic row — and this is the only signal that the
   * deployment and the lane disagree, so an unsupported runtime is diagnosable
   * instead of silently generic.
   */
  onUnsupported?: (reason: string) => void
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
  const noop = () => {}
  // This lane runs inside framework publish paths (a session-window mutation, a
  // settings commit) and degrades by design, so every seam of the service is
  // PROBED before it is called: an accessor a generation does not have would
  // otherwise throw into that publish path and take the transcript or the
  // settings UI with it. A shape the lane cannot use leaves every MCP call on
  // the shipped generic row and reports once.
  const list = sessions.list
  if (
    list === undefined ||
    list === null ||
    typeof list.getSnapshot !== 'function' ||
    typeof list.subscribe !== 'function'
  ) {
    options.onUnsupported?.('the sessions service exposes no observable list snapshot')
    return noop
  }
  if (typeof sessions.binding !== 'function') {
    options.onUnsupported?.('the sessions service exposes no binding(id) window accessor')
    return noop
  }
  let offEvents: (() => void) | undefined
  let offRetain: (() => void) | undefined
  let boundId: string | undefined
  let retainedId: string | undefined
  let disposed = false
  // Names accumulate across sessions: a registration stays valid for the life
  // of the page, so rows in a revisited session keep their custom view even
  // when its window no longer reaches the request that first named the tool.
  const seen = new Set<string>()

  /** Borrow one window; a throwing or absent accessor degrades to "no window". */
  const borrow = (id: string) => {
    try {
      return sessions.binding?.(id)
    } catch {
      return undefined
    }
  }

  const listSnapshot = (): SessionListLike | undefined => {
    try {
      return list.getSnapshot() as SessionListLike | undefined
    } catch {
      return undefined
    }
  }

  const readBound = (id: string) => {
    const binding = borrow(id)
    if (binding === undefined) return
    let window: { entries?: readonly unknown[] } | undefined
    try {
      window = binding.eventSource?.getSnapshot?.()
    } catch {
      return
    }
    const names = mcpToolNamesOf(window?.entries ?? [])
    if (names.length === 0) return
    let added = false
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      added = true
    }
    if (added) registry.sync([...seen])
  }

  /**
   * The staged session, resolved across the generations: the legacy scalar
   * (`current`) when the list still publishes it, else the catalog row the
   * main view retains (`retainedBy.mainView > 0` — the shipped UI's own
   * selector), else the first catalog id that already holds a live binding, so
   * a generation that renames the ownership source still finds the session the
   * shell holds.
   */
  const stagedId = (): string | undefined => {
    const snapshot = listSnapshot()
    if (snapshot === undefined || snapshot === null) return undefined
    if (typeof snapshot.current === 'string') return snapshot.current
    const rows = snapshot.byId
    if (rows !== undefined && rows !== null && typeof rows === 'object') {
      // Prefer the session already bound while it still carries the retain: a
      // handover can briefly leave two rows retained, and flapping between them
      // would detach/re-attach windows for no reason (the shipped UI keeps its
      // current id for the same reason).
      if (boundId !== undefined) {
        const held = rows[boundId]?.retainedBy?.['mainView']
        if (typeof held === 'number' && held > 0) return boundId
      }
      for (const [id, row] of Object.entries(rows)) {
        const retained = row?.retainedBy?.['mainView']
        if (typeof retained === 'number' && retained > 0) return id
      }
    }
    if (Array.isArray(snapshot.ids)) {
      for (const id of snapshot.ids) {
        if (typeof id !== 'string') continue
        if (borrow(id) !== undefined) return id
      }
    }
    return undefined
  }

  const bindStaged = () => {
    if (disposed) return
    const nextId = stagedId()
    if (nextId === boundId) {
      if (nextId !== undefined) readBound(nextId)
      return
    }
    offEvents?.()
    offEvents = undefined
    boundId = nextId
    if (nextId === undefined) {
      offRetain?.()
      offRetain = undefined
      retainedId = undefined
      return
    }
    // The main-view retain is released BEFORE the next session gains it, so
    // watching the bound session's retain is what makes a stage switch
    // observable even when the catalog snapshot itself does not republish.
    if (retainedId !== nextId) {
      offRetain?.()
      offRetain = undefined
      retainedId = nextId
      try {
        offRetain = sessions.retainInfo?.(nextId)?.subscribe(() => bindStaged())
      } catch {
        offRetain = undefined
      }
    }
    const binding = borrow(nextId)
    if (binding === undefined) return
    try {
      offEvents = binding.eventSource?.subscribe?.(() => readBound(nextId))
    } catch {
      offEvents = undefined
    }
    readBound(nextId)
  }

  let offList: (() => void) | undefined
  try {
    offList = list.subscribe(bindStaged)
    bindStaged()
  } catch (error) {
    options.onUnsupported?.(String(error))
    return noop
  }
  return () => {
    disposed = true
    offList?.()
    offEvents?.()
    offEvents = undefined
    offRetain?.()
    offRetain = undefined
  }
}
