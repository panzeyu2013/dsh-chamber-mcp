/**
 * Per-agent injection gate (host half): the ONLY place MCP tools are ever
 * registered. Master definitions live in the per-server supervisors; this
 * module pushes them into the tool scopes of live agents whose session cwd
 * canonicalizes to a registered workspace in which the server is enabled
 * (`isEnabled` on the document's overrides — default on). Workspace-less
 * sessions and cwd outside every registered workspace never receive MCP
 * tools.
 *
 * Registration goes through `agent.ctx.tools.register(def)` — the ToolRuntime
 * layer of the agent's own scope (register-through-agent.ctx semantics, same
 * as the official schedule plugin) — so entries are owned by the agent scope
 * fiber: when the agent ctx is disposed, its scope-layer entries die with it.
 * We therefore NEVER call disposers from `agent/disposed` (bookkeeping drop
 * only); disposers are only invoked while the agent is alive, for
 * settings-driven or sync-driven revocation.
 *
 * Every listener and every push is effect-wrapped through the owning plugin
 * context so teardown (including HMR) is safe.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isEnabled, type WorkspaceOverrides } from './shared/model.js'
import { workspaceIdOf, type WorkspaceLike } from './workspace.js'
// Side-effect type imports: declaration-merge ctx.tools / ctx.agents / events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

/** Logger surface (ctx.logger-compatible). */
export interface ApplierLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The registry of live agents our scan + liveness checks use. */
export interface AgentRegistryLike {
  roots(): Agent[]
  get(id: string): Agent | undefined
}

/** The workspace registry projection used for canonical-cwd matching. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
}

/** Latest committed state of one server, as pushed by the manager. */
export interface ServerPushState {
  /** Monotonic supervisor swap counter; re-pushes of the same syncId are no-ops. */
  syncId: number
  /** Committed master defs (empty map = server currently has no tools). */
  defs: ReadonlyMap<string, ToolDefinition>
}

/** One agent's applied registrations for one server. */
interface AppliedServer {
  syncId: number
  /** publicName → exact register disposer. */
  disposers: Map<string, () => void>
}

/** Per-agent bookkeeping; dropped (never disposed) on agent/disposed. */
interface AgentEntry {
  agent: Agent
  /** Resolved once at adopt: canonical-cwd match, immutable afterwards. */
  workspaceId: string | undefined
  /** serverName → applied registrations (absent = nothing applied). */
  applied: Map<string, AppliedServer>
}

/** Construction deps for the applier. */
export interface AgentApplierOptions {
  ctx: Context
  logger: ApplierLogger
  agents: AgentRegistryLike
  workspaceRegistry: WorkspaceRegistryLike
  /** Current document overrides (read live — never cached across pushes). */
  overrides: () => WorkspaceOverrides
}

/** The per-agent applier owned by the manager. */
export interface AgentApplier {
  /**
   * Push one server's committed defs to every live agent entry that is
   * enabled for it (and drop stale per-agent generations). An empty defs map
   * revokes the server everywhere.
   */
  pushServerState(serverName: string, state: ServerPushState): void
  /** Revoke one server from every live agent (server removed from the doc). */
  revokeServer(serverName: string): void
  /**
   * The document changed (settings reconcile): re-judge enablement for every
   * tracked server and live agent (live overrides source) and re-apply where
   * the answer changed.
   */
  reconcile(): void
  /** Revoke every live registration (plugin teardown; HMR-safe). */
  dispose(): void
}

/**
 * Create the per-agent applier: subscribes `agent/created` / `agent/disposed`
 * on the plugin context, adopts pre-existing root agents once, and owns the
 * per-agent registration bookkeeping. All subscription effects are scoped to
 * the calling fiber (HMR-safe).
 */
export function createAgentApplier(options: AgentApplierOptions): AgentApplier {
  const { ctx, logger, agents, workspaceRegistry } = options
  const entries = new Map<Agent, AgentEntry>()
  /** Latest committed server state (syncId + defs), keyed by serverName. */
  const serverState = new Map<string, ServerPushState>()
  let disposed = false

  const label = 'mcp-scope(agents)'

  /** Liveness: the agent is still the live registry entry for its id. */
  const isAlive = (agent: Agent): boolean => agents.get(agent.id) === agent

  /** Live enablement source — never cached across pushes (settings reads are per-op). */
  const overrides = options.overrides

  const resolveWorkspace = (agent: Agent): string | undefined =>
    workspaceIdOf(agent.session.header.cwd, workspaceRegistry.list())

  function adopt(agent: Agent): void {
    if (disposed || entries.has(agent)) return
    const entry: AgentEntry = {
      agent,
      workspaceId: resolveWorkspace(agent),
      applied: new Map(),
    }
    entries.set(agent, entry)
    logger.info(`${label}: tracking agent ${agent.id}${entry.workspaceId === undefined ? ' (no workspace — MCP tools withheld)' : ` workspace=${entry.workspaceId}`}`)
    for (const serverName of serverState.keys()) applyToEntry(entry, serverName, false)
  }

  /** Revoke one applied server generation; disposers run only while the agent is alive. */
  function revokeApplied(entry: AgentEntry, serverName: string, reason: string): void {
    const applied = entry.applied.get(serverName)
    if (applied === undefined) return
    entry.applied.delete(serverName)
    if (!isAlive(entry.agent)) return // entries die with the agent ctx — never dispose after teardown
    for (const dispose of applied.disposers.values()) {
      try {
        dispose()
      } catch (error) {
        // A disposer must be idempotent; a throw here must not wedge revocation.
        logger.warn(`${label}: disposer for ${serverName} on ${entry.agent.id} threw: ${String(error)}`)
      }
    }
    logger.info(`${label}: revoked server "${serverName}" from agent ${entry.agent.id} (${reason})`)
  }

  /**
   * Register one full server generation into one agent scope: dispose the
   * previous generation first, then register def-by-def; a registry conflict
   * mid-swap rolls the partial generation back (zero tools from this server
   * for that agent) and logs.
   *
   * Enablement is judged LIVE (per call) from the current overrides source.
   * `force` bypasses the same-syncId idempotence guard so a reconcile can
   * re-judge enablement even when the generation did not change.
   */
  function applyToEntry(entry: AgentEntry, serverName: string, force: boolean): void {
    const state = serverState.get(serverName)
    const applied = entry.applied.get(serverName)
    if (state === undefined) {
      if (applied !== undefined) revokeApplied(entry, serverName, 'server no longer tracked')
      return
    }
    const { workspaceId } = entry
    const enabled = workspaceId !== undefined && isEnabled(overrides(), workspaceId, serverName) && state.defs.size > 0
    if (!enabled) {
      if (applied !== undefined) {
        const reason = workspaceId === undefined
          ? 'agent has no workspace'
          : !isEnabled(overrides(), workspaceId, serverName)
            ? 'disabled for this workspace'
            : 'server has no tools'
        revokeApplied(entry, serverName, reason)
      }
      return
    }
    if (!force && applied !== undefined && applied.syncId === state.syncId) return // idempotent push
    // Swap: dispose the previous generation only after the new one is decided.
    if (applied !== undefined) revokeApplied(entry, serverName, 'generation swap')
    const disposers = new Map<string, () => void>()
    try {
      for (const [publicName, definition] of state.defs) {
        disposers.set(publicName, entry.agent.ctx.tools.register(definition))
      }
    } catch (error) {
      // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
      // registration occupies this server's namespace inside this agent's
      // scope. Roll back so the agent sees either the full generation or none.
      for (const dispose of disposers.values()) {
        try { dispose() } catch { /* partial rollback best effort */ }
      }
      logger.error(`${label}: tool registration failed for agent ${entry.agent.id} server "${serverName}", no tools registered: ${String(error)}`)
      return
    }
    entry.applied.set(serverName, { syncId: state.syncId, disposers })
    logger.info(`${label}: applied ${disposers.size} tool${disposers.size === 1 ? '' : 's'} of server "${serverName}" to agent ${entry.agent.id} (sync ${state.syncId})`)
  }

  const applier: AgentApplier = {
    pushServerState(serverName, state) {
      if (disposed) return
      serverState.set(serverName, state)
      for (const entry of entries.values()) applyToEntry(entry, serverName, false)
    },
    revokeServer(serverName) {
      if (disposed) return
      serverState.delete(serverName)
      for (const entry of entries.values()) {
        if (entry.applied.has(serverName)) revokeApplied(entry, serverName, 'server removed from document')
      }
    },
    reconcile() {
      if (disposed) return
      // Re-judge enablement for every tracked server × live agent from the
      // LIVE overrides source; force bypasses the same-syncId idempotence so
      // a flip OFF (or ON) always lands.
      for (const entry of entries.values()) {
        for (const serverName of serverState.keys()) applyToEntry(entry, serverName, true)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Plugin teardown: revoke while agents are still alive. Entries whose
      // agent ctx already died keep nothing to dispose (scope entries die
      // with the ctx).
      for (const entry of entries.values()) {
        for (const serverName of [...entry.applied.keys()]) {
          if (isAlive(entry.agent)) revokeApplied(entry, serverName, 'plugin teardown')
        }
      }
      entries.clear()
    },
  }

  // Effect-scoped subscriptions; teardown runs on HMR/unload. Also adopt
  // agents that predate this plugin (roots scan happens after listeners are
  // armed so a racing create cannot be double-adopted).
  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
      if (disposed) return
      adopt(agent)
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      // Scope-layer registrations made through agent.ctx are owned by that
      // ctx's lifecycle — drop bookkeeping only, never call disposers.
      entries.delete(agent)
    })
    for (const agent of agents.roots()) adopt(agent)
    return () => {
      offCreated()
      offDisposed()
      applier.dispose()
    }
  }, 'mcp-scope.agents()')

  return applier
}
