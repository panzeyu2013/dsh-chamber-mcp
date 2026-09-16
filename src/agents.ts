/**
 * Per-agent injection gate (host half): the ONLY place MCP tools are ever
 * registered. Master definitions live in the per-server supervisors; this
 * module pushes them into the tool scopes of live agents whose session cwd
 * canonicalizes to a registered workspace that explicitly enables the server
 * (`isEnabled` on the document's overrides — default off, so a session is
 * exposed to nothing until the pair is turned on). Workspace-less
 * sessions and cwd outside every registered workspace never receive MCP
 * tools.
 *
 * Workspace membership is NOT frozen at adoption: every push/reconcile
 * re-resolves each entry's workspace against one live workspace-registry
 * snapshot, so deleting a workspace (or its directory) while an agent lives
 * revokes that agent's tools on the next event, and registering a workspace
 * after an agent was adopted applies them.
 *
 * Documented deviation (adoption policy): delegation children
 * (`session.header.origin === 'subagent'`) are never adopted — neither by
 * the `agent/created` listener nor by the boot `agents.roots()` scan. They
 * are governed by their preset scopes and never receive MCP tools from this
 * plugin; their `toolFilter`/persona narrowing cannot be bypassed here.
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
 * This module NEVER writes into a session log. The registered-tools notice is
 * derived client-side from the harness's own session events
 * (`src/client/injection.ts`): a third-party session event is
 * required-on-read — the envelope's `ignorable` marker has no write path in
 * this generation — so appending one would make the persisted session
 * unreadable to every reader, the harness that wrote it included.
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
  /**
   * Manager-owned per-server epoch, bumped on every `startServer` of that
   * serverName. A restarted supervisor is a fresh handle whose syncId starts
   * over at 1, so the idempotence guard below keys on (epoch, syncId): the
   * restart's first commit can never be absorbed by the previous handle's
   * last push (PERF-2).
   */
  epoch: number
  /** Monotonic supervisor swap counter; re-pushes of the same (epoch, syncId) are no-ops. */
  syncId: number
  /** Committed master defs (empty map = server currently has no tools). */
  defs: ReadonlyMap<string, ToolDefinition>
}

/** One agent's applied registrations for one server. */
interface AppliedServer {
  /** The server epoch this generation was registered under (see {@link ServerPushState}). */
  epoch: number
  syncId: number
  /** publicName → exact register disposer. */
  disposers: Map<string, () => void>
}

/** Per-agent bookkeeping; dropped (never disposed) on agent/disposed. */
interface AgentEntry {
  agent: Agent
  /**
   * Live workspace membership (canonical-cwd match). Resolved at adopt, then
   * re-resolved at the start of every push/reconcile from one fresh registry
   * snapshot — never treated as immutable (workspaces can be deleted or
   * created while the agent lives).
   */
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
  /**
   * Global off-switch lookup (read live). Optional so existing test mounts
   * keep their shape; absent ⇒ never globally disabled.
   */
  isDisabled?: (serverName: string) => boolean
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
/** Log-safe error text: control characters stripped, capped. Remote-reflected
 * payloads (e.g. an HTTP error body echoing a credential value) must never
 * reach the log verbatim. */
const fmtError = (error: unknown): string =>
  String(error).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 300)

  /** Liveness: the agent is still the live registry entry for its id. */
  const isAlive = (agent: Agent): boolean => agents.get(agent.id) === agent

  /** Live enablement sources — never cached across pushes (settings reads are per-op). */
  const overrides = options.overrides
  const isDisabled = options.isDisabled ?? ((): boolean => false)

  const resolveWorkspace = (agent: Agent): string | undefined =>
    workspaceIdOf(agent.session.header.cwd, workspaceRegistry.list())

  /**
   * Re-resolve every live entry's workspace from ONE fresh registry snapshot.
   * Runs at the start of each push/reconcile so membership is never judged
   * off a stale adopt-time id (IMPL-1/ARCH-2).
   */
  function refreshEntryWorkspaces(): void {
    const workspaces = workspaceRegistry.list()
    for (const entry of entries.values()) {
      entry.workspaceId = workspaceIdOf(entry.agent.session.header.cwd, workspaces)
    }
  }

  function adopt(agent: Agent): void {
    if (disposed || entries.has(agent)) return
    // Delegation children are governed by their preset scopes and never
    // receive MCP tools from this plugin. Skipping here covers BOTH
    // adoption paths (the agent/created listener and the boot roots() scan,
    // which both funnel through adopt), keeping them symmetric.
    if (agent.session.header.origin === 'subagent') return
    const entry: AgentEntry = {
      agent,
      workspaceId: resolveWorkspace(agent),
      applied: new Map(),
    }
    entries.set(agent, entry)
    logger.info(`${label}: tracking agent ${agent.id}${entry.workspaceId === undefined ? ' (no workspace — MCP tools withheld)' : ` workspace=${entry.workspaceId}`}`)
    const docOverrides = overrides()
    for (const serverName of serverState.keys()) applyToEntry(entry, serverName, docOverrides)
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
        logger.warn(`${label}: disposer for ${serverName} on ${entry.agent.id} threw: ${fmtError(error)}`)
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
   * Enablement is judged LIVE (per call) from the caller's doc snapshot;
   * the (epoch, syncId) guard turns an unchanged (state, enablement) pair
   * into a no-op. `docOverrides` is one snapshot per event so reconcile
   * loops never re-read the settings doc per (entry × server) pair.
   */
  function applyToEntry(entry: AgentEntry, serverName: string, docOverrides: WorkspaceOverrides): void {
    const state = serverState.get(serverName)
    const applied = entry.applied.get(serverName)
    if (state === undefined) {
      if (applied !== undefined) revokeApplied(entry, serverName, 'server no longer tracked')
      return
    }
    const { workspaceId } = entry
    const globallyOff = isDisabled(serverName)
    const enabled =
      workspaceId !== undefined &&
      !globallyOff &&
      isEnabled(docOverrides, workspaceId, serverName) &&
      state.defs.size > 0
    if (!enabled) {
      if (applied !== undefined) {
        const reason = globallyOff
          ? 'server is disabled globally'
          : workspaceId === undefined
            ? 'agent has no workspace'
            : !isEnabled(docOverrides, workspaceId, serverName)
              ? 'disabled for this workspace'
              : 'server has no tools'
        revokeApplied(entry, serverName, reason)
      }
      return
    }
    // Idempotent (epoch, syncId) push: the generation and the enablement
    // answer are both unchanged — nothing to do. The epoch half makes a
    // restarted handle's first commit (syncId restarts at 1) re-apply even
    // when the previous handle pushed the same syncId (PERF-2).
    if (applied !== undefined && applied.epoch === state.epoch && applied.syncId === state.syncId) return
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
      logger.error(`${label}: tool registration failed for agent ${entry.agent.id} server "${serverName}", no tools registered: ${fmtError(error)}`)
      return
    }
    entry.applied.set(serverName, { epoch: state.epoch, syncId: state.syncId, disposers })
    logger.info(`${label}: applied ${disposers.size} tool${disposers.size === 1 ? '' : 's'} of server "${serverName}" to agent ${entry.agent.id} (sync ${state.syncId})`)
  }

  const applier: AgentApplier = {
    pushServerState(serverName, state) {
      if (disposed) return
      serverState.set(serverName, state)
      // Workspace membership can change between events (create/delete while
      // agents live) — refresh every entry before judging this push.
      refreshEntryWorkspaces()
      const docOverrides = overrides()
      for (const entry of entries.values()) applyToEntry(entry, serverName, docOverrides)
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
      // Re-judge enablement for every tracked server × live agent from ONE
      // fresh workspace snapshot and ONE doc snapshot. There is deliberately
      // no blanket force pass: applyToEntry computes `enabled` live (and
      // revokes when disabled), so real OFF⇄ON flips land while unchanged
      // (epoch, syncId, enablement) pairs stay no-ops (PERF-1/IMPL-2).
      refreshEntryWorkspaces()
      const docOverrides = overrides()
      for (const entry of entries.values()) {
        for (const serverName of serverState.keys()) applyToEntry(entry, serverName, docOverrides)
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
  /**
   * Contain one adoption: a synchronous listener failure VETOES the emitting
   * operation upstream (the agent's own publication), and one bad agent must
   * never fail the user's session creation or the boot scan. The tools of a
   * failed adoption simply stay unregistered for that agent.
   */
  const adoptContained = (agent: Agent): void => {
    try {
      adopt(agent)
    } catch (error) {
      logger.error(`${label}: could not adopt agent ${agent.id} — its MCP tools stay unregistered: ${fmtError(error)}`)
    }
  }

  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
      if (disposed) return
      adoptContained(agent)
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      // Scope-layer registrations made through agent.ctx are owned by that
      // ctx's lifecycle — drop bookkeeping only, never call disposers.
      entries.delete(agent)
    })
    for (const agent of agents.roots()) adoptContained(agent)
    return () => {
      offCreated()
      offDisposed()
      applier.dispose()
    }
  }, 'mcp-scope.agents()')

  return applier
}