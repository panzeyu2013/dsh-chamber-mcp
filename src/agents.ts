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
 * Adoption policy: EVERY live agent whose session cwd canonicalizes to a
 * registered workspace is adopted, including delegation children
 * (`session.header.origin === 'subagent'`). A child inherits its parent's cwd,
 * so the same enablement decides for it — and its scope does NOT chain through
 * the parent's agent scope: the harness joins a child to its parent's PRESET
 * mount (`dsh-agent-presets` `composeFrom`), which is why injecting into the
 * child itself is what makes the workspace's MCP capability reach it.
 *
 * In exchange for that injection, a child's delegator narrowing is mirrored for
 * the names this module registers: a registration made into the child's OWN
 * scope is exempt from the harness's tool masks ("scoped registrations remain
 * visible"), so the durable `subagent/descriptor` in the child's own log is
 * folded into an admission predicate (`src/delegation.ts`) and names outside it
 * are simply never registered. A split between "the workspace enabled this
 * server" and "the delegator narrowed it away" is therefore decided once per
 * agent, and the server's context (section + resources) is withheld with its
 * tools when the whole server is filtered out.
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
import { registerServerContext, type ServerContext } from './server-context.js'
import {
  admissionOf,
  readDelegationNarrowing,
  type DelegationNarrowing,
} from './delegation.js'
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
  /**
   * Every live agent, when the generation exposes it (`ctx.agents.list()`).
   * Adopting from this list at boot is what covers an agent that predates this
   * plugin instance — a live delegation child during an HMR reload included;
   * the `roots()` fallback sees top-level agents only.
   */
  list?(): Agent[]
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
  /**
   * Connection-owned context that server publishes to the agents which ENABLE
   * it (its literal instructions section and its resource operations). It is
   * registered through each ENABLED agent's own ctx: the consumers scope their
   * entries by the registering fiber, so a host-level registration would put
   * the shared resource tools in the GLOBAL layer and hand them to agents whose
   * workspace never enabled MCP.
   */
  context?: ServerContext
}

/** One agent's applied registrations for one server. */
interface AppliedServer {
  /** The server epoch this generation was registered under (see {@link ServerPushState}). */
  epoch: number
  syncId: number
  /** publicName → exact register disposer. */
  disposers: Map<string, () => void>
  /** Unloads this agent's copy of the server context (section + provider). */
  disposeContext?: () => void
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
  /**
   * Admission for this agent's tool names; `undefined` admits every name. Set
   * only for a delegation child whose delegator declared a narrowing, folded
   * from the child's own durable descriptor (`src/delegation.ts`).
   */
  admitted?: (publicName: string) => boolean
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

  /**
   * Read one delegated child's OWN narrowing.
   *
   * Feature-detected and total: a generation without the read API, or a session
   * whose snapshot throws, yields `unreadable` (fail open) rather than failing
   * the child's publication. Only the child's own event window is folded — a
   * seeded fork carries its parent's prefix in the same log, and a nested
   * parent's descriptor must never be mistaken for this child's.
   */
  function readChildNarrowing(agent: Agent): DelegationNarrowing {
    const session = agent.session as unknown as {
      snapshotEvents?: (from?: number) => readonly unknown[]
      inheritedEventCount?: number
    }
    if (typeof session.snapshotEvents !== 'function') {
      return { kind: 'unreadable', reason: 'session.snapshotEvents is unavailable in this generation' }
    }
    const from = typeof session.inheritedEventCount === 'number' ? session.inheritedEventCount : 0
    let events: readonly unknown[]
    try {
      events = session.snapshotEvents(from)
    } catch (error) {
      return { kind: 'unreadable', reason: 'snapshotEvents threw: ' + fmtError(error) }
    }
    return readDelegationNarrowing(events)
  }

  function adopt(agent: Agent): void {
    if (disposed || entries.has(agent)) return
    const entry: AgentEntry = {
      agent,
      workspaceId: resolveWorkspace(agent),
      applied: new Map(),
    }
    // A child inherits its parent's cwd, so the workspace's own enablement
    // decides for it too; what it does NOT inherit is the parent's agent scope,
    // so mirror the narrowing its delegator declared for it.
    if (agent.session.header.origin === 'subagent') {
      const narrowing = readChildNarrowing(agent)
      if (narrowing.kind === 'narrowed') {
        entry.admitted = admissionOf(narrowing)
        logger.info(
          `${label}: delegation child ${agent.id} narrowed by its delegator (allow ${narrowing.allow?.length ?? 0}, deny ${narrowing.deny?.length ?? 0}) — only admitted tool names are registered`,
        )
      } else if (narrowing.kind === 'unreadable') {
        logger.warn(
          `${label}: delegation child ${agent.id} descriptor is unreadable (${narrowing.reason}) — its enabled servers are registered unnarrowed`,
        )
      }
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
    try {
      // Same rule for the context publication: unloading the three shared
      // resource tools happens inside the consumer once the last provider of
      // this scope leaves.
      applied.disposeContext?.()
    } catch (error) {
      logger.warn(`${label}: context disposer for ${serverName} on ${entry.agent.id} threw: ${fmtError(error)}`)
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
    // A narrowed child registers only the names its delegator's filter admits.
    // When it admits none of this server's names, nothing at all is published —
    // tools AND context — so "this server is on for this agent" keeps exactly
    // one meaning; the generation is still recorded so the decision is not
    // recomputed (or re-logged) on every push.
    const defs = entry.admitted === undefined
      ? state.defs
      : new Map([...state.defs].filter(([publicName]) => entry.admitted?.(publicName) === true))
    if (defs.size === 0) {
      entry.applied.set(serverName, { epoch: state.epoch, syncId: state.syncId, disposers: new Map() })
      logger.info(
        `${label}: server "${serverName}" withheld from agent ${entry.agent.id}: the delegation's tool filter admits none of its ${state.defs.size} tool(s)`,
      )
      return
    }
    const disposers = new Map<string, () => void>()
    try {
      for (const [publicName, definition] of defs) {
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
    // Publish the server's context LAST, through THIS agent's ctx, so the
    // consumer's own registration is owned by the same fiber as the tools: an
    // agent whose workspace never enables the pair registers nothing, and a
    // revocation unloads the section and the shared resource tools with it.
    let disposeContext: (() => void) | undefined
    if (state.context !== undefined) {
      try {
        disposeContext = registerServerContext(entry.agent.ctx, serverName, state.context, logger)
      } catch (error) {
        for (const dispose of disposers.values()) {
          try { dispose() } catch { /* partial rollback best effort */ }
        }
        logger.error(`${label}: context registration failed for agent ${entry.agent.id} server "${serverName}", no tools registered: ${fmtError(error)}`)
        return
      }
    }
    entry.applied.set(serverName, { epoch: state.epoch, syncId: state.syncId, disposers, disposeContext })
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
    // 0.1.6 types this listener as a veto protocol: it must settle to
    // `undefined` (no veto) rather than return void. Adoption failures are
    // already contained inside `adoptContained`, so this never vetoes.
    const offCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }): undefined => {
      if (!disposed) adoptContained(agent)
      return undefined
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      // Scope-layer registrations made through agent.ctx are owned by that
      // ctx's lifecycle — drop bookkeeping only, never call disposers.
      entries.delete(agent)
    })
    // Every live agent when the registry exposes it (a reload must not drop a
    // delegation child that is already running), roots only otherwise.
    for (const agent of agents.list?.() ?? agents.roots()) adoptContained(agent)
    return () => {
      offCreated()
      offDisposed()
      applier.dispose()
    }
  }, 'mcp-scope.agents()')

  return applier
}