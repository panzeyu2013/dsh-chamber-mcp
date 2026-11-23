/**
 * Per-agent applier (host half): the ONLY fan-out owner of the capture-only
 * MCP façades. A mounted MCP client instance registers its tools, prompt
 * sections and resource provider through the façade services of its own seat
 * context; this module publishes the resulting CaptureSnapshot into the tool
 * scopes and prompt/resource consumers of the live agents whose session cwd
 * canonicalizes to a registered workspace that explicitly enables the server
 * (isEnabled on the document overrides — default off, so a session is exposed
 * to nothing until the pair is turned on). Workspace-less sessions and cwd
 * outside every registered workspace never receive MCP tools.
 *
 * GATE (A2): enablement is decided by WORKSPACE MEMBERSHIP + ENABLE RECORD +
 * GLOBAL OFF-SWITCH only — never by tool count. A server with zero tools still
 * publishes its sections/resources to enabled agents (upstream's
 * registerServerContext does that before ready), and a reconnect does not
 * revoke/re-publish them for a version-only capture change.
 *
 * IDEMPOTENCE (A1): syncServerState ignores a stale (epoch, capture.version)
 * pair with a monotonic per-serverName floor, so a late notification from a
 * superseded instance can never resurrect old definitions; the manager bumps
 * epoch on every mount, so a restarted instance's first publish always lands.
 *
 * CONTEXT LIFECYCLE (A4): a capture's sections/resources are replayed into an
 * agent scope ONCE PER EPOCH (applyContext when the epoch changed). A
 * same-epoch capture version change is a tool generation swap only: the
 * replayed context and the upstream-owned loaded tools survive, so a reconnect
 * never emits retirement/replacement notices for unchanged instructions.
 *
 * LOADED TOOLS (A3): on-demand tools enter an agent scope ONLY through
 * admit(), which the seat's tools façade calls for an agent-scoped register
 * (the upstream loader's load()). Records survive a gate close: the
 * registrations are revoked (model-visible revocation) but the names stay, and
 * a re-enable re-registers them iff the capture generation is unchanged; a
 * changed generation forgets them (upstream pruned its bookkeeping while the
 * gate was off). Generation swaps never revoke loaded tools — upstream owns
 * that lifecycle; our tokens are the disposers it holds.
 *
 * DELEGATION: a child's delegator narrowing (src/delegation.ts) is enforced on
 * the eager fan-out AND on admit(), the upstream bypass path. A server whose
 * whole capture is filtered out is withheld entirely (tools + context), and the
 * withheld decision is recorded as a generation so repeats are no-ops.
 *
 * Registration goes through agent.ctx.tools.register / agent.ctx.inject — the
 * agent's own scope — so entries are owned by the agent scope fiber and die
 * with it. Disposers are only invoked while the agent is alive (settings/sync
 * driven revocation, server removal, plugin teardown); agent/disposed drops
 * bookkeeping only. This module NEVER writes into a session log, and every
 * entry point is synchronous and total: contained failures go to the logger,
 * never into an upstream registration path (except admit's fixed refusals,
 * which the upstream loader surfaces as the model-visible tool error).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { replayCapturedContext, type CaptureSnapshot } from './facade.js'
import {
  admissionOf,
  readDelegationNarrowing,
  type DelegationNarrowing,
} from './delegation.js'
import { isEnabled, MCP_TOOL_PREFIX, type DisabledServers, type WorkspaceOverrides } from './shared/model.js'
import { createWorkspaceResolver, type WorkspaceLike } from './workspace.js'
import { sanitizeLogText, type HostLogger } from './log.js'
// Side-effect type imports: declaration-merge ctx.tools / ctx.agents / events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

/** The registry of live agents our scan + liveness checks use. */
export interface AgentRegistryLike {
  /** Every live agent, the only registry projection 0.2.x exposes (roots() is gone). */
  list(): readonly Agent[]
  /** Look up a live agent (liveness check: get(agent.id) === agent). */
  get(id: SessionId): Agent | undefined
}

/** The workspace registry projection used for canonical-cwd matching. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
}

/**
 * One server's latest capture generation, published by the manager seat.
 *
 * The epoch is manager-owned and bumped on every mount of that serverName, so
 * a restarted instance's first capture can never be absorbed by the previous
 * instance's last one. The capture version is façade-owned and increments on
 * every net change of the captured registration set.
 */
export interface ServerStateInput {
  /** Manager-owned per-serverName mount epoch (strictly increasing while tracked). */
  readonly epoch: number
  /** The seat façade's current capture snapshot (tools + sections + resources). */
  readonly capture: CaptureSnapshot
}

/** The frozen per-agent applier owned by the manager. */
export interface AgentApplier {
  /** Publish one server's capture generation to every live agent (idempotent). */
  syncServerState(serverName: string, state: ServerStateInput): void
  /** Forget one server everywhere (removed from the document / plugin teardown). */
  removeServer(serverName: string): void
  /**
   * On-demand admission: register one loaded tool into one agent scope and
   * return its stable idempotent disposer. Synchronous; throws a fixed refusal
   * when the server is not enabled for that agent or the name is filtered.
   */
  admit(agent: Agent, definition: ToolDefinition): () => void
  /** Whether the applier currently publishes this server to this agent. */
  isApplied(agent: Agent, serverName: string): boolean
  /** Re-judge enablement for every tracked server x live agent (live doc sources). */
  reconcile(): void
  /** Revoke every live registration (plugin teardown; idempotent). */
  dispose(): void
}

/** Construction deps for the applier. */
export interface AgentApplierOptions {
  ctx: Context
  logger: HostLogger
  agents: AgentRegistryLike
  workspaceRegistry: WorkspaceRegistryLike
  /** Current document overrides (read live — never cached across passes). */
  overrides: () => WorkspaceOverrides
  /** Global off-switch snapshot (read live, ONE read per pass). */
  disabled: () => DisabledServers
}

/** One agent's applied registrations for one capture generation. */
interface AppliedServer {
  /** Capture epoch this generation was published under. */
  epoch: number
  /** Capture version this generation was published from. */
  version: number
  /** Whether the generation is model-visible (enabled and not withheld). */
  visible: boolean
  /** publicName -> exact agent.ctx.tools register disposer. */
  tools: Map<string, () => void>
  /** The replayed context publication, once per epoch. */
  context?: { epoch: number; dispose: () => Promise<void> | void }
}

/**
 * One on-demand tool this agent loaded from one server. Records survive a gate
 * close (registered=false) and are re-registered on re-enable when the capture
 * generation is unchanged.
 */
interface LoadedTool {
  /** The upstream-constructed definition that was registered. */
  definition: ToolDefinition
  /** Capture epoch/version the load belongs to (restore/prune keys). */
  epoch: number
  version: number
  /** Whether the exact registration below is currently live in the agent scope. */
  registered: boolean
  /** The exact agent.ctx.tools register disposer of the live registration. */
  dispose?: () => void
  /** Stable token handed to the upstream loader (kept across re-registration). */
  token: () => void
}

/** Per-agent bookkeeping; dropped (never disposed) on agent/disposed. */
interface AgentEntry {
  agent: Agent
  /**
   * Live workspace membership (canonical-cwd match). Resolved at adopt, then
   * re-resolved at the start of every sync/reconcile/admission from one fresh
   * registry snapshot through the memoized resolver — never treated as
   * immutable.
   */
  workspaceId: string | undefined
  /** serverName -> applied generation (absent = nothing published). */
  applied: Map<string, AppliedServer>
  /**
   * Admission for this agent's tool names; undefined admits every name. Set
   * only for a delegation child whose delegator declared a narrowing.
   */
  admitted?: (publicName: string) => boolean
  /** serverName -> publicName -> loaded-tool record (on-demand servers). */
  loaded: Map<string, Map<string, LoadedTool>>
}

/** Fixed admission refusal: its text is model-visible, so it never carries internals. */
class AdmissionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdmissionRefusal'
  }
}

/** One server's gate decision. */
interface Enablement {
  readonly enabled: boolean
  /** True when the delegation filter admits none of the server's tools. */
  readonly withheld: boolean
  /** Human reason for the log. */
  readonly reason: string
}

/** How a revocation treats the server's other facets. */
type RevokeMode = 'generation' | 'gate' | 'epoch' | 'removal'

/**
 * Create the per-agent applier: subscribes agent/created and agent/disposed on
 * the plugin context, adopts pre-existing live agents once, and owns the
 * per-agent publication bookkeeping. All subscription effects are scoped to the
 * calling fiber (HMR-safe); teardown revokes while agents are still alive.
 */
export function createAgentApplier(options: AgentApplierOptions): AgentApplier {
  const { ctx, logger, agents, workspaceRegistry } = options
  const entries = new Map<Agent, AgentEntry>()
  /** Latest accepted capture generation per serverName. */
  const captures = new Map<string, ServerStateInput>()
  /** Monotonic (epoch, version) floor per serverName (kept across removal). */
  const floors = new Map<string, { epoch: number; version: number }>()
  /** serverNames removed since their last publish (allows a re-add to reset the epoch). */
  const removed = new Set<string>()
  let disposed = false

  const label = 'mcp-scope(agents)'

  /** Log-safe error text (one host sanitizer: src/log.ts). */
  const fmtError = (error: unknown): string => sanitizeLogText(error)

  /** Liveness: the agent is still the live registry entry for its id. */
  const isAlive = (agent: Agent): boolean => agents.get(agent.id) === agent

  /** Live enablement sources — never cached across passes (settings reads are per-op). */
  const overrides = options.overrides
  const disabled = options.disabled

  /**
   * Memoized canonical-workspace resolver (H4): a session cwd is immutable, so
   * the realpath + membership result is cached by session id; the membership is
   * re-decided only when the effective workspace registry snapshot changes (a
   * registry change or a workspace root vanishing from disk, R2I-7). One
   * `list()` + one existence check per workspace per pass replaces one realpath
   * syscall per (agent, pass).
   */
  const workspaceResolver = createWorkspaceResolver()

  /** Re-resolve one agent's workspace from a fresh registry snapshot (adopt/admit). */
  const resolveWorkspace = (agent: Agent): string | undefined => {
    workspaceResolver.refresh(workspaceRegistry.list())
    return workspaceResolver.workspaceOf(agent.id, agent.session.header.cwd)
  }

  /**
   * Re-resolve every live entry's workspace from ONE fresh registry snapshot.
   * Runs at the start of each sync/reconcile so membership is never judged off a
   * stale adopt-time id; only a changed registry list re-runs the membership
   * (the canonical cwd itself stays memoized per session).
   */
  function refreshEntryWorkspaces(): void {
    workspaceResolver.refresh(workspaceRegistry.list())
    for (const entry of entries.values()) {
      entry.workspaceId = workspaceResolver.workspaceOf(entry.agent.id, entry.agent.session.header.cwd)
    }
  }

  /**
   * Read one delegated child's OWN narrowing. Total: a malformed snapshot, a
   * missing read API or a malformed descriptor yields 'unreadable' (fail open)
   * rather than failing the child's publication. Only the child's own event
   * window is folded — a seeded fork inherits its parent's prefix in the same
   * log, and a nested parent's descriptor must never be mistaken for its own.
   */
  function readChildNarrowing(agent: Agent): DelegationNarrowing {
    const session = agent.session as unknown as {
      snapshotEvents?: (from?: number) => readonly unknown[]
      inheritedEventCount?: number
    }
    if (typeof session.snapshotEvents !== 'function') {
      return { kind: 'unreadable', reason: 'session.snapshotEvents is unavailable in this generation' }
    }
    // The boundary separates a seeded fork's OWN events from the prefix it
    // inherited: guessing 0 would fold the PARENT's descriptor as if it were this
    // child's and withhold tools the child was never denied.
    if (typeof session.inheritedEventCount !== 'number') {
      return { kind: 'unreadable', reason: 'session.inheritedEventCount is unavailable' }
    }
    const from = session.inheritedEventCount
    let events: readonly unknown[]
    try {
      events = session.snapshotEvents(from)
    } catch (error) {
      return { kind: 'unreadable', reason: 'snapshotEvents threw: ' + fmtError(error) }
    }
    return readDelegationNarrowing(events)
  }

  /** The captured definitions this agent is allowed to register (delegation narrowing folded). */
  function admittedDefs(entry: AgentEntry, capture: CaptureSnapshot): ReadonlyMap<string, ToolDefinition> {
    if (entry.admitted === undefined) return capture.tools
    const admitted = new Map<string, ToolDefinition>()
    for (const [publicName, definition] of capture.tools) {
      if (entry.admitted(publicName)) admitted.set(publicName, definition)
    }
    return admitted
  }

  /**
   * The ONE gate decision (I1): workspace membership + own enable record + no
   * global off-switch, plus the delegation withholding rule (a narrowed child
   * whose filter admits none of a server's tools receives nothing from it —
   * tools AND context together). Deliberately independent of tool count (A2).
   */
  function enablementOf(
    entry: AgentEntry,
    serverName: string,
    capture: CaptureSnapshot,
    docOverrides: WorkspaceOverrides,
    docDisabled: DisabledServers,
  ): Enablement {
    const workspaceId = entry.workspaceId
    if (workspaceId === undefined) return { enabled: false, withheld: false, reason: 'agent has no workspace' }
    if (Object.hasOwn(docDisabled, serverName)) {
      return { enabled: false, withheld: false, reason: 'server is disabled globally' }
    }
    if (!isEnabled(docOverrides, workspaceId, serverName)) {
      return { enabled: false, withheld: false, reason: 'disabled for this workspace' }
    }
    if (entry.admitted !== undefined && capture.tools.size > 0) {
      let admitted = 0
      for (const publicName of capture.tools.keys()) {
        if (entry.admitted(publicName)) {
          admitted += 1
          break
        }
      }
      if (admitted === 0) {
        return {
          enabled: false,
          withheld: true,
          reason: 'the delegation tool filter admits none of its ' + capture.tools.size + ' tool(s)',
        }
      }
    }
    return { enabled: true, withheld: false, reason: '' }
  }

  function adopt(agent: Agent): void {
    if (disposed || entries.has(agent)) return
    const entry: AgentEntry = {
      agent,
      workspaceId: resolveWorkspace(agent),
      applied: new Map(),
      loaded: new Map(),
    }
    // A child inherits its parent's cwd, so the workspace's own enablement
    // decides for it too; what it does NOT inherit is the parent's agent scope,
    // so mirror the narrowing its delegator declared for it.
    if (agent.session.header.origin === 'subagent') {
      const narrowing = readChildNarrowing(agent)
      if (narrowing.kind === 'narrowed') {
        entry.admitted = admissionOf(narrowing)
        logger.info(
          label + ': delegation child ' + agent.id + ' narrowed by its delegator (allow ' +
            (narrowing.allow?.length ?? 0) + ', deny ' + (narrowing.deny?.length ?? 0) +
            ') — only admitted tool names are registered',
        )
      } else if (narrowing.kind === 'unreadable') {
        logger.warn(
          label + ': delegation child ' + agent.id + ' descriptor is unreadable (' + narrowing.reason +
            ') — its enabled servers are registered unnarrowed',
        )
      } else if (narrowing.kind === 'absent') {
        // Expected for a one-shot child: upstream appends its descriptor at the
        // first agent/pre-step, i.e. AFTER this event, and that descriptor never
        // carries a filter — so a delegator-configured toolFilter is not
        // observable for it (documented limitation).
        logger.info(
          label + ': delegation child ' + agent.id + ' carries no descriptor yet — a delegator tool filter cannot be mirrored for it',
        )
      }
    }
    entries.set(agent, entry)
    logger.info(
      label + ': tracking agent ' + agent.id +
        (entry.workspaceId === undefined ? ' (no workspace — MCP tools withheld)' : ' workspace=' + entry.workspaceId),
    )
    const docOverrides = overrides()
    const docDisabled = disabled()
    for (const serverName of captures.keys()) applyToEntryContained(entry, serverName, docOverrides, docDisabled)
  }

  /** Run one entry's publication, containing any unexpected failure to the logger. */
  function applyToEntryContained(
    entry: AgentEntry,
    serverName: string,
    docOverrides: WorkspaceOverrides,
    docDisabled: DisabledServers,
  ): void {
    try {
      applyToEntry(entry, serverName, docOverrides, docDisabled)
    } catch (error) {
      logger.error(
        label + ': could not publish server "' + serverName + '" to agent ' + entry.agent.id + ': ' + fmtError(error),
      )
    }
  }

  /** Revoke one server generation from one agent, per the given facet mode. */
  function revokeApplied(entry: AgentEntry, serverName: string, reason: string, mode: RevokeMode): void {
    const applied = entry.applied.get(serverName)
    const alive = isAlive(entry.agent)
    if (applied !== undefined) {
      entry.applied.delete(serverName)
      if (alive) {
        for (const dispose of applied.tools.values()) {
          try {
            dispose()
          } catch (error) {
            logger.warn(label + ': disposer for ' + serverName + ' on ' + entry.agent.id + ' threw: ' + fmtError(error))
          }
        }
        if (mode !== 'generation' && applied.context !== undefined) {
          try {
            const disposal = applied.context.dispose()
            if (disposal !== undefined) {
              void Promise.resolve(disposal).catch((error: unknown) => {
                logger.warn(label + ': context disposer for ' + serverName + ' on ' + entry.agent.id + ' failed: ' + fmtError(error))
              })
            }
          } catch (error) {
            logger.warn(label + ': context disposer for ' + serverName + ' on ' + entry.agent.id + ' threw: ' + fmtError(error))
          }
        }
      }
    }
    // Loaded registrations are revoked with a gate close and with any instance
    // change; a same-epoch generation swap keeps them (upstream owns that swap).
    if (mode !== 'generation') revokeLoaded(entry, serverName, mode === 'gate')
    if (applied !== undefined) {
      logger.info(label + ': revoked server "' + serverName + '" from agent ' + entry.agent.id + ' (' + reason + ')')
    }
  }

  /** Revoke the exact registration of one loaded record (record kept unless forgotten). */
  function unregisterLoaded(record: LoadedTool): void {
    if (!record.registered) return
    record.registered = false
    const disposal = record.dispose
    record.dispose = undefined
    if (disposal === undefined) return
    try {
      disposal()
    } catch (error) {
      logger.warn(label + ': loaded-tool disposer threw: ' + fmtError(error))
    }
  }

  /** Forget one loaded record (revoke + drop from the per-server map when still present). */
  function forgetLoaded(entry: AgentEntry, serverName: string, record: LoadedTool): void {
    unregisterLoaded(record)
    const perServer = entry.loaded.get(serverName)
    if (perServer === undefined) return
    const key = record.definition.name
    if (perServer.get(key) === record) perServer.delete(key)
    if (perServer.size === 0) entry.loaded.delete(serverName)
  }

  /** Revoke every loaded registration of one server; keep the records for a gate flip. */
  function revokeLoaded(entry: AgentEntry, serverName: string, keepRecords: boolean): void {
    const perServer = entry.loaded.get(serverName)
    if (perServer === undefined) return
    for (const record of perServer.values()) unregisterLoaded(record)
    if (!keepRecords) entry.loaded.delete(serverName)
  }

  /** The stable token handed to the upstream loader: unregister exactly this name and forget it. */
  function loadedToken(entry: AgentEntry, serverName: string, record: LoadedTool): () => void {
    return () => {
      forgetLoaded(entry, serverName, record)
    }
  }

  /**
   * Register the capture's (optionally filtered) definitions into one agent
   * scope. Partial failures roll the whole generation back so a foreign
   * registration conflict can never leave a half server visible.
   */
  function applyTools(
    entry: AgentEntry,
    serverName: string,
    defs: ReadonlyMap<string, ToolDefinition>,
  ): Map<string, () => void> | undefined {
    const disposers = new Map<string, () => void>()
    try {
      for (const [publicName, definition] of defs) {
        disposers.set(publicName, entry.agent.ctx.tools.register(definition))
      }
      return disposers
    } catch (error) {
      for (const dispose of disposers.values()) {
        try {
          dispose()
        } catch {
          // partial rollback best effort
        }
      }
      logger.error(
        label + ': tool registration failed for agent ' + entry.agent.id + ' server "' + serverName +
          '", no tools registered: ' + fmtError(error),
      )
      return undefined
    }
  }

  /** Replay the capture's sections/resources into one agent scope (once per epoch). */
  function applyContext(
    entry: AgentEntry,
    capture: CaptureSnapshot,
    epoch: number,
  ): { epoch: number; dispose: () => Promise<void> | void } {
    const dispose = replayCapturedContext(entry.agent.ctx, capture, logger)
    return { epoch, dispose }
  }

  /**
   * Restore a re-enabled server's loaded tools from their records: only a
   * generation-unchanged record survives (upstream prunes across generations
   * while the gate is off). Registration conflicts drop only that one name.
   */
  function restoreLoaded(entry: AgentEntry, serverName: string, state: ServerStateInput): void {
    const perServer = entry.loaded.get(serverName)
    if (perServer === undefined) return
    for (const [publicName, record] of [...perServer]) {
      if (record.epoch !== state.epoch) {
        // Instance replaced: upstream's fresh loader starts empty, so a stale
        // record (already disposed by the old instance) is forgotten.
        unregisterLoaded(record)
        if (perServer.get(publicName) === record) perServer.delete(publicName)
        continue
      }
      if (record.version !== state.capture.version) {
        // Upstream owns the generation swap: it disposed and re-registered every
        // offered loaded tool BEFORE this publish landed, so a still-registered
        // record belongs to the NEW generation and its bookkeeping version is
        // refreshed. An unregistered record was pruned while the gate was off
        // (or by the loader) and is forgotten.
        if (record.registered) {
          record.version = state.capture.version
          continue
        }
        unregisterLoaded(record)
        if (perServer.get(publicName) === record) perServer.delete(publicName)
        continue
      }
      if (record.registered) continue
      try {
        record.dispose = entry.agent.ctx.tools.register(record.definition)
        record.registered = true
      } catch (error) {
        if (perServer.get(publicName) === record) perServer.delete(publicName)
        logger.error(
          label + ': could not restore loaded tool "' + publicName + '" for agent ' + entry.agent.id +
            ' server "' + serverName + '": ' + fmtError(error),
        )
      }
    }
    if (perServer.size === 0) entry.loaded.delete(serverName)
  }

  /**
   * Publish one server's current capture to one agent: gate decision, then
   * (a) tool generation swap, (b) once-per-epoch context replay, (c) loaded-tool
   * restore. Records a visible generation for exactly the (epoch, version)
   * published, so an unchanged capture is a no-op.
   */
  function applyToEntry(
    entry: AgentEntry,
    serverName: string,
    docOverrides: WorkspaceOverrides,
    docDisabled: DisabledServers,
  ): void {
    const state = captures.get(serverName)
    const applied = entry.applied.get(serverName)
    if (state === undefined) {
      if (applied !== undefined) revokeApplied(entry, serverName, 'server no longer tracked', 'removal')
      return
    }
    const enablement = enablementOf(entry, serverName, state.capture, docOverrides, docDisabled)
    if (!enablement.enabled) {
      if (applied !== undefined) {
        // A repeated suppressed decision is itself a generation: no-op.
        if (!applied.visible && applied.epoch === state.epoch && applied.version === state.capture.version) return
        if (!applied.visible) entry.applied.delete(serverName)
        else revokeApplied(entry, serverName, enablement.reason, 'gate')
      }
      if (enablement.withheld) {
        entry.applied.set(serverName, {
          epoch: state.epoch,
          version: state.capture.version,
          visible: false,
          tools: new Map(),
        })
        logger.info(
          label + ': server "' + serverName + '" withheld from agent ' + entry.agent.id + ': ' + enablement.reason,
        )
      }
      return
    }
    // Idempotent publish: this exact generation is already model-visible.
    if (
      applied !== undefined && applied.visible &&
      applied.epoch === state.epoch && applied.version === state.capture.version
    ) {
      return
    }
    const previous = applied
    if (previous !== undefined) {
      if (previous.epoch !== state.epoch) {
        // New instance activation: tools + context + loaded registrations are
        // re-published from this capture (upstream's new loader starts empty).
        revokeApplied(entry, serverName, 'instance changed (epoch ' + previous.epoch + ' -> ' + state.epoch + ')', 'epoch')
      } else {
        // Same instance, new tool generation: tools only (A3/A4).
        revokeApplied(entry, serverName, 'tool generation changed', 'generation')
      }
    }
    const defs = admittedDefs(entry, state.capture)
    const tools = applyTools(entry, serverName, defs)
    if (tools === undefined) return
    // Publish the context LAST (through THIS agent's ctx), once per epoch.
    let context = previous?.context
    if (context === undefined || context.epoch !== state.epoch) {
      try {
        context = applyContext(entry, state.capture, state.epoch)
      } catch (error) {
        for (const dispose of tools.values()) {
          try {
            dispose()
          } catch {
            // partial rollback best effort
          }
        }
        logger.error(
          label + ': context registration failed for agent ' + entry.agent.id + ' server "' + serverName +
            '", no tools registered: ' + fmtError(error),
        )
        return
      }
    }
    restoreLoaded(entry, serverName, state)
    entry.applied.set(serverName, {
      epoch: state.epoch,
      version: state.capture.version,
      visible: true,
      tools,
      ...(context === undefined ? {} : { context }),
    })
    logger.info(
      label + ': applied ' + tools.size + ' tool' + (tools.size === 1 ? '' : 's') + ' of server "' + serverName +
        '" to agent ' + entry.agent.id + ' (epoch ' + state.epoch + ', capture ' + state.capture.version + ')',
    )
  }

  /**
   * Attribute an upstream-built on-demand definition to its configured server:
   * captured definitions match by identity; the loader constructs its catalog
   * definitions itself (they never enter the capture), so the official
   * mcp__<serverName>__ namespace prefix is the fallback, longest name first.
   */
  function serverOfDefinition(definition: ToolDefinition): string | undefined {
    for (const [serverName, state] of captures) {
      if (state.capture.tools.get(definition.name) === definition) return serverName
    }
    let best: string | undefined
    for (const serverName of captures.keys()) {
      if (!definition.name.startsWith(MCP_TOOL_PREFIX + serverName + '__')) continue
      if (best === undefined || serverName.length > best.length) best = serverName
    }
    return best
  }

  /** On-demand admission implementation (fixed refusals; see AgentApplier.admit). */
  function admit(agent: Agent, definition: ToolDefinition): () => void {
    try {
      if (disposed) throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
      const entry = entries.get(agent)
      if (entry === undefined || !isAlive(agent)) {
        throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
      }
      const serverName = serverOfDefinition(definition)
      if (serverName === undefined) {
        throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
      }
      const state = captures.get(serverName)
      if (state === undefined) {
        throw new AdmissionRefusal('MCP server "' + serverName + '" is not enabled for this agent')
      }
      // Live gate: workspace membership is re-resolved here (workspaces can be
      // removed while an agent lives) and the doc is read fresh.
      entry.workspaceId = resolveWorkspace(agent)
      const enablement = enablementOf(entry, serverName, state.capture, overrides(), disabled())
      if (!enablement.enabled) {
        throw new AdmissionRefusal('MCP server "' + serverName + '" is not enabled for this agent')
      }
      const applied = entry.applied.get(serverName)
      if (applied === undefined || !applied.visible) {
        throw new AdmissionRefusal('MCP server "' + serverName + '" is not enabled for this agent')
      }
      if (entry.admitted !== undefined && !entry.admitted(definition.name)) {
        throw new AdmissionRefusal('Tool "' + definition.name + '" is not permitted for this agent')
      }
      let perServer = entry.loaded.get(serverName)
      if (perServer === undefined) {
        perServer = new Map()
        entry.loaded.set(serverName, perServer)
      }
      let record = perServer.get(definition.name)
      let dispose: () => void
      try {
        dispose = agent.ctx.tools.register(definition)
      } catch (conflict) {
        // A duplicate name is a re-load race: revoke the previous live
        // registration of this exact name and retry once.
        if (record === undefined) {
          throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
        }
        void conflict
        unregisterLoaded(record)
        try {
          dispose = agent.ctx.tools.register(definition)
        } catch (retryError) {
          logger.error(
            label + ': loaded tool "' + definition.name + '" for agent ' + agent.id + ' could not be registered: ' + fmtError(retryError),
          )
          throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
        }
      }
      if (record === undefined) {
        const created: LoadedTool = {
          definition,
          epoch: state.epoch,
          version: state.capture.version,
          registered: false,
          token: () => {},
        }
        record = created
        created.token = loadedToken(entry, serverName, created)
        perServer.set(definition.name, created)
      }
      record.definition = definition
      record.epoch = state.epoch
      record.version = state.capture.version
      record.dispose = dispose
      record.registered = true
      return record.token
    } catch (error) {
      if (error instanceof AdmissionRefusal) throw error
      logger.error(label + ': admission failed for tool "' + definition.name + '": ' + fmtError(error))
      throw new AdmissionRefusal('MCP tool "' + definition.name + '" could not be loaded')
    }
  }

  const applier: AgentApplier = {
    syncServerState(serverName: string, state: ServerStateInput): void {
      if (disposed) return
      try {
        const floor = floors.get(serverName)
        // Stale generation from a superseded instance: ignore. A server that was
        // removed may be re-added with a fresh epoch counter, so its floor is
        // bypassed once (a removed record is no longer competing for the name).
        if (floor !== undefined && !removed.has(serverName)) {
          if (state.epoch < floor.epoch) return
          if (state.epoch === floor.epoch && state.capture.version <= floor.version) return
        }
        removed.delete(serverName)
        floors.set(serverName, { epoch: state.epoch, version: state.capture.version })
        captures.set(serverName, state)
        refreshEntryWorkspaces()
        // ONE doc snapshot per pass (settings reads are per-op; reconcile loops
        // must never re-read per entry x server pair).
        const docOverrides = overrides()
        const docDisabled = disabled()
        for (const entry of entries.values()) applyToEntryContained(entry, serverName, docOverrides, docDisabled)
      } catch (error) {
        logger.error(label + ': could not publish server "' + serverName + '" to live agents: ' + fmtError(error))
      }
    },

    removeServer(serverName: string): void {
      if (disposed) return
      try {
        captures.delete(serverName)
        removed.add(serverName)
        for (const entry of entries.values()) {
          if (!entry.applied.has(serverName) && !entry.loaded.has(serverName)) continue
          revokeApplied(entry, serverName, 'server removed from document', 'removal')
        }
      } catch (error) {
        logger.error(label + ': could not remove server "' + serverName + '": ' + fmtError(error))
      }
    },

    admit(agent: Agent, definition: ToolDefinition): () => void {
      return admit(agent, definition)
    },

    isApplied(agent: Agent, serverName: string): boolean {
      try {
        return entries.get(agent)?.applied.get(serverName)?.visible === true
      } catch {
        return false
      }
    },

    reconcile(): void {
      if (disposed) return
      try {
        refreshEntryWorkspaces()
        const docOverrides = overrides()
        const docDisabled = disabled()
        for (const entry of entries.values()) {
          for (const serverName of captures.keys()) applyToEntryContained(entry, serverName, docOverrides, docDisabled)
        }
      } catch (error) {
        logger.error(label + ': reconcile failed: ' + fmtError(error))
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        // Plugin teardown: revoke while agents are still alive. Entries whose
        // agent ctx already died keep nothing to dispose (scope entries die with
        // the ctx). The epoch floor is kept (a late notification must stay
        // ignored while this applier object still exists).
        for (const entry of entries.values()) {
          const names = new Set<string>([...entry.applied.keys(), ...entry.loaded.keys()])
          for (const serverName of names) {
            revokeApplied(entry, serverName, 'plugin teardown', 'removal')
          }
          entry.applied.clear()
          entry.loaded.clear()
        }
        entries.clear()
        captures.clear()
      } catch (error) {
        logger.error(label + ': dispose failed: ' + fmtError(error))
      }
    },
  }

  // Effect-scoped subscriptions; teardown runs on HMR/unload. Also adopt agents
  // that predate this plugin (the boot scan happens after listeners are armed so
  // a racing create cannot be double-adopted).
  /**
   * Contain one adoption: a synchronous listener failure VETOES the emitting
   * operation upstream (the agent's own publication), and one bad agent must
   * never fail the user's session creation or the boot scan.
   */
  const adoptContained = (agent: Agent): void => {
    try {
      adopt(agent)
    } catch (error) {
      logger.error(label + ': could not adopt agent ' + agent.id + ' — its MCP tools stay unregistered: ' + fmtError(error))
    }
  }

  ctx.effect(() => {
    // The host types this listener as a veto protocol: it must settle to
    // undefined (no veto) rather than return void. Adoption failures are already
    // contained inside adoptContained, so this never vetoes.
    const offCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }): undefined => {
      if (!disposed) adoptContained(agent)
      return undefined
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      // Scope-layer registrations made through agent.ctx are owned by that ctx's
      // lifecycle — drop bookkeeping only, never call disposers. The workspace
      // memo is per SESSION and must not outlive the agent (H4: sessions are
      // unbounded over a long-lived Host).
      entries.delete(agent)
      workspaceResolver.forget(agent.id)
    })
    // Every live agent (a reload must not drop a delegation child that is
    // already running). A registry that throws must not take the pre-existing
    // agent scan down with it.
    try {
      for (const agent of agents.list()) adoptContained(agent)
    } catch (error) {
      logger.error(label + ': agent scan failed — pre-existing agents stay unregistered: ' + fmtError(error))
    }
    return () => {
      offCreated()
      offDisposed()
      applier.dispose()
    }
  }, 'mcp-scope.agents()')

  return applier
}
