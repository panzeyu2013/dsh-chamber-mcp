/**
 * Bridge orchestrator (host half): owns one per-server supervisor
 * (`ServerHandle`) per defined server, keyed by serverName — the stable
 * identity. A serverName that vanished disposes its handle; one that appeared
 * starts a handle; one whose definition fields changed disposes and restarts.
 * It subscribes credential-reference updates and restarts every server whose
 * resolved env/headers draw on the changed ref, and owns the per-agent
 * applier ({@link ./agents.js}) that pushes committed defs into live agent
 * scopes under the enabled() rule.
 *
 * All handle mutations (reconcile diffs, credential restarts) serialize on
 * one mutation chain so a settings commit can never race a credential
 * restart into overlapping server processes. Per-serverName epochs
 * (incremented on every start) keep the applier able to tell restarted
 * handles apart, and same-tick restart requests are coalesced per serverName.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Type merge: `domain/changed` event + storageDomain ctx (types only).
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { CredentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { createAgentApplier, type AgentApplier, type ApplierLogger } from './agents.js'
import { createTransport } from './transport.js'
import {
  probeServer,
  startServerSupervisor,
  RECONNECT_DEFAULTS,
  type ProbeResult,
  type ReconnectConfig,
  type ServerHandle,
  type ToolSummary,
} from './server.js'
import { credentialRefsOf, isServerDisabled, type McpScopeDoc, type ServerDef } from './shared/model.js'
// Side-effect type imports: ctx.tools / ctx.agents / ctx.settings / ctx.credentials merge.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'

/** Durable storage-domain identity of the workspace registry (dsh-workspace). */
export const WORKSPACE_DOMAIN_NAME = 'workspace'
export const WORKSPACE_TABLE_NAME = 'workspaces'

/** Logger surface for manager + supervisor + applier (ctx.logger-compatible). */
export type ManagerLogger = ApplierLogger

/** One supervised handle plus the definition snapshot it was started from. */
interface TrackedServer {
  handle: ServerHandle
  /** Serialized definition the handle was started with (change detection). */
  defFingerprint: string
}

/** Manager construction options. */
export interface ManagerOptions {
  ctx: Context
  logger: ManagerLogger
  /** Read the current resolved settings document (never cached). */
  getDoc(): McpScopeDoc
  /** The credentials service used to resolve env keys / header refs per attempt. */
  credentials: Pick<CredentialProvider, 'resolve'>
  /**
   * Reconnect policy handed to every supervisor. Production omits it (official
   * defaults 500ms→30s/10 attempts); tests and the smoke shrink it.
   */
  reconnect?: ReconnectConfig
}

/**
 * Fixed, host-generated message per runtime error code. Remote/transport text
 * NEVER crosses the status/action wire (the SDK embeds HTTP response bodies in
 * its errors, which can echo a credential value in any encoding); the raw text
 * stays in the host log, where it is sanitized but not part of a response.
 */
const RUNTIME_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'gave-up': 'Reconnect attempts exhausted',
  'reconnect-disabled': 'Connection lost and reconnect is disabled',
  'generation-stuck': 'Previous connection generation did not close',
  forbidden: 'The server rejected the credentials (HTTP 401/403)',
  timeout: 'The connection or request timed out',
  'spawn-failed': 'The server command could not be started',
  protocol: 'The server returned an invalid response',
  'connection-failed': 'Connection failed',
})

/** Message of one runtime error code (always host-generated). */
export function runtimeErrorMessage(code: string): string {
  return RUNTIME_ERROR_MESSAGES[code] ?? 'Connection failed'
}

/** The bridge manager handle owned by the plugin entry. */
export interface ManagerHandle {
  /**
   * Diff the current document against the tracked servers and reconcile:
   * dispose vanished/changed servers, start new ones, then re-judge every
   * live agent's tool set against the new overrides.
   */
  reconcile(): void
  /** Stop every supervisor, quiesce the mutation chain, revoke live registrations. */
  dispose(): Promise<void>
  /** Runtime status of every server the document names (plus tracked orphans). */
  runtimeStatus(): RuntimeStatusView
  /** Committed tool identity of one server, capped for the wire. */
  toolList(serverName: string): ToolListView | undefined
  /** Manual reconnect: clears the manual-stop latch and starts the server. */
  connect(serverName: string): Promise<RuntimeActionResult>
  /** Manual stop: revokes the server's tools and latches it off until changed. */
  disconnect(serverName: string): Promise<RuntimeActionResult>
  /** One-shot probe on a throwaway connection (never touches the live one). */
  test(serverName: string): Promise<ProbeResult>
}

/** Wire vocabulary of one server's runtime phase (additive). */
export type RuntimePhase =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'failed'
  | 'stopped'
  | 'disabled'
  | 'unknown'

/** Capped runtime view of one server (never carries credential material). */
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

/** Whole-document runtime status response (`v` is the wire version). */
export interface RuntimeStatusView {
  v: 1
  at: number
  servers: ServerRuntimeView[]
}

/** Capped tool identity response for one server. */
export interface ToolListView {
  tools: { publicName: string; rawName: string; description: string }[]
  truncated: boolean
  /** Total committed tool count (>= tools.length when truncated). */
  total: number
}

/** Result of one manual connect/disconnect. */
export interface RuntimeActionResult {
  name: string
  state: RuntimePhase
}

/** Caps of the tool-list wire shape (SEC: bounded response, no schema bodies). */
export const TOOL_LIST_MAX = 200
const TOOL_NAME_MAX = 200
const TOOL_DESCRIPTION_MAX = 500

/**
 * Cap one committed tool generation for the wire: at most {@link TOOL_LIST_MAX}
 * entries, each name/description capped, no schema bodies. Pure so the bounds
 * are unit-testable without a live server.
 */
export function capToolList(listed: readonly ToolSummary[]): ToolListView {
  return {
    tools: listed.slice(0, TOOL_LIST_MAX).map((tool) => ({
      publicName: tool.publicName,
      rawName: tool.rawName.slice(0, TOOL_NAME_MAX),
      description: tool.description.slice(0, TOOL_DESCRIPTION_MAX),
    })),
    truncated: listed.length > TOOL_LIST_MAX,
    total: listed.length,
  }
}

/** Business failure of a runtime action, carrying a stable code. */
export class RuntimeActionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RuntimeActionError'
    this.code = code
  }
}

/** Fingerprint one server definition for change detection. */
function fingerprint(server: ServerDef): string {
  return JSON.stringify(server)
}

/**
 * Create the bridge manager. The manager wires its own effect on `ctx`
 * (applier + credential listener + teardown), so plugin HMR disposes it.
 */
export function createManager(options: ManagerOptions): ManagerHandle {
  const { ctx, logger } = options
  let disposed = false
  const tracked = new Map<string, TrackedServer>()
  /** Serialized mutation chain: reconcile diffs and credential restarts. */
  let mutations: Promise<void> = Promise.resolve()
  /**
   * Per-serverName epoch, bumped on every `startServer`. The applier keys its
   * idempotence guard on (epoch, syncId), so a restarted handle's first
   * commit — syncId restarts at 1 — can never be absorbed by the previous
   * handle's last push (PERF-2).
   */
  const epochs = new Map<string, number>()
  /** serverNames with a queued `restartServer` mutation (restart coalescing, IMPL-3). */
  const pendingRestarts = new Set<string>()
  /**
   * Manual-stop latch: serverName → definition fingerprint it was stopped at.
   * A reconcile with the SAME fingerprint leaves the server off (a settings
   * commit must not silently revive it); a fingerprint change clears the
   * latch and starts the new definition.
   */
  const manualStopped = new Map<string, string>()
  /**
   * Stable error codes derived from the (host-only) sanitized failure text.
   * The wire carries ONLY these codes plus {@link RUNTIME_ERROR_MESSAGES};
   * remote text is never reflected into a response.
   */
  const errorCodeOf = (text: string): string => {
    if (/giving up/.test(text)) return 'gave-up'
    if (/reconnect is disabled/.test(text)) return 'reconnect-disabled'
    if (/did not close|overlapping/.test(text)) return 'generation-stuck'
    if (/\b(401|403)\b|unauthorized|forbidden/i.test(text)) return 'forbidden'
    if (/timed? out|timeout|ETIMEDOUT|aborted/i.test(text)) return 'timeout'
    if (/ENOENT|EACCES|EPERM|spawn/i.test(text)) return 'spawn-failed'
    if (/unexpected token|invalid json|parse error/i.test(text)) return 'protocol'
    return 'connection-failed'
  }

  const nextEpoch = (serverName: string): number => {
    const epoch = (epochs.get(serverName) ?? 0) + 1
    epochs.set(serverName, epoch)
    return epoch
  }

  /** Adapter narrowing the live services to the applier's needs. */
  const applier: AgentApplier = createAgentApplier({
    ctx,
    logger,
    agents: {
      roots: () => [...ctx.agents.roots()],
      get: (id: string) => ctx.agents.get(id as SessionId),
    },
    workspaceRegistry: {
      list: () => [...ctx.workspaceRegistry.list()] as Workspace[],
    },
    overrides: () => options.getDoc().overrides,
    isDisabled: (serverName) => isServerDisabled(options.getDoc(), serverName),
  })

  const enqueue = (work: () => Promise<void>): void => {
    const run = mutations.then(work)
    // The chain tail must survive a failed mutation; the worker owns reporting.
    mutations = run.catch(() => {})
  }

  /** Same chain, but the caller can await this mutation's settlement. */
  const enqueueAwait = (work: () => Promise<void>): Promise<void> => {
    const run = mutations.then(work)
    mutations = run.catch(() => {})
    return run
  }

  /** Resolver used by every transport build — resolve() is per-call, never cached. */
  const resolveCredential = async (ref: string): Promise<{ value: string; source: string } | undefined> =>
    options.credentials.resolve(credentialRef(ref))

  /** Start one supervisor for a definition (caller holds the mutation chain). */
  async function startServer(server: ServerDef): Promise<void> {
    if (disposed) return
    const { serverName } = server
    // Capture this start's epoch so every commit of THIS handle (including a
    // give-up empty commit) pushes under the new generation token.
    const epoch = nextEpoch(serverName)
    const handle = startServerSupervisor({
      serverName,
      // Document timeout (tools/call + one tools/list page); absent = official default.
      toolCallTimeoutMs: server.timeoutMs,
      buildTransport: () => createTransport(server, resolveCredential, (message) => logger.warn(message)),
      logger,
      reconnect: options.reconnect,
      onDefsChanged: (name, syncId, defs) => {
        if (disposed) return
        applier.pushServerState(name, { epoch, syncId, defs })
      },
    })
    tracked.set(serverName, { handle, defFingerprint: fingerprint(server) })
    logger.info(`mcp-scope(${serverName}): server started (${server.transport === 'stdio' ? 'stdio' : 'streamable-http'})`)
  }

  /** Stop one tracked server (caller holds the mutation chain). */
  async function stopServer(serverName: string, revokeFirst: boolean): Promise<void> {
    const current = tracked.get(serverName)
    if (current === undefined) return
    tracked.delete(serverName)
    if (revokeFirst) applier.revokeServer(serverName)
    try {
      await current.handle.dispose()
    } finally {
      logger.info(`mcp-scope(${serverName}): server stopped`)
    }
  }

  /**
   * Restart one server (document change or credential update). Returns true
   * when the restart was queued; false when one for the same serverName is
   * already pending and this request was absorbed (IMPL-3).
   */
  function restartServer(serverName: string, next?: ServerDef): boolean {
    // Coalesce same-tick restart requests per serverName: while a restart is
    // queued, further requests for the same name (e.g. a burst of
    // credential events) are absorbed — the running restart's next connect
    // attempt resolves credentials per attempt anyway. The queued mutation
    // clears the marker when it runs, so a later, genuinely new request
    // still restarts.
    if (pendingRestarts.has(serverName)) return false
    pendingRestarts.add(serverName)
    enqueue(async () => {
      pendingRestarts.delete(serverName)
      if (disposed) return
      // Presence is judged LIVE at run time (never from the stale snapshot the
      // caller captured): a server removed from the document while this
      // restart was queued must be stopped with revocation, or its tools
      // would outlive it (the queued removal reconcile finds nothing tracked).
      // A globally disabled server is "not present" for supervision: a
      // credential update must not silently bring it back up.
      const doc = options.getDoc()
      const present =
        next !== undefined &&
        doc.servers.some((s) => s.serverName === next.serverName) &&
        !isServerDisabled(doc, next.serverName) &&
        !manualStopped.has(next.serverName)
      const current = tracked.get(serverName)
      if (current === undefined) {
        if (present) await startServer(next as ServerDef)
        return
      }
      if (!present) {
        await stopServer(serverName, true)
        return
      }
      // Stop first (its defs stay committed and visible — same semantics as a
      // crash: tools keep failing calls until the fresh generation re-syncs),
      // then start the replacement definition.
      await stopServer(serverName, false)
      if (disposed) return
      await startServer(next as ServerDef)
    })
    return true
  }

  /** Refs currently referenced by the document (for credential filtering). */
  function refsInUse(): ReadonlySet<string> {
    const refs = new Set<string>()
    for (const server of options.getDoc().servers) {
      for (const ref of credentialRefsOf(server)) refs.add(ref)
    }
    return refs
  }

  // Workspace registry changes (create/delete/rename/session membership):
  // rc.1 exposes no workspace-domain events of its own, but every durable
  // workspace write emits `domain/changed` for domain "workspace" /
  // table "workspaces". Re-judge live agent membership on any such write so
  // a deleted workspace revokes its sessions' tools promptly instead of
  // waiting for the next settings/server event (the applier refresh is
  // diffed: unchanged pairs are no-ops).
  ctx.effect(() => {
    const off = ctx.on('domain/changed', (change) => {
      if (disposed) return
      if (change.domain !== WORKSPACE_DOMAIN_NAME || change.table !== 'workspaces') return
      enqueue(async () => {
        if (disposed) return
        applier.reconcile()
      })
    })
    return () => off()
  }, 'mcp-scope.workspace-domain()')

  // Credential updates: restart every server drawing on the changed ref so
  // the new value reaches the next connect attempt.
  ctx.effect(() => {
    const off = ctx.on('credentials/reference-updated', (ref: CredentialRef) => {
      if (disposed) return
      if (!refsInUse().has(ref)) return
      // Note: a reconcile-triggered restart and a credential restart for the
      // same server can still both cycle in one tick (reconcile bypasses the
      // coalescing set by design). The chain serializes them and the later
      // start resolves credentials per attempt, so the double cycle always
      // converges — accepted as documented in docs/review/SUMMARY.md.
      const affected = options.getDoc().servers.filter(
        (server) => !isServerDisabled(options.getDoc(), server.serverName) && credentialRefsOf(server).includes(ref),
      )
      for (const server of affected) {
        // Log only when the restart is actually queued (a same-tick second
        // event for this server is absorbed by the coalescing gate).
        if (restartServer(server.serverName, server)) {
          logger.info(`mcp-scope(${server.serverName}): credential ref "${ref}" updated — reconnecting`)
        }
      }
    })
    return () => off()
  }, 'mcp-scope.credentials()')

  /** Wire view of one server (redacted; no secret values ever leave here). */
  const viewOf = (serverName: string, disabled: boolean): ServerRuntimeView => {
    if (disabled) {
      return {
        name: serverName,
        state: 'disabled',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
        toolCount: 0,
      }
    }
    if (manualStopped.has(serverName)) {
      return {
        name: serverName,
        state: 'stopped',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
        toolCount: 0,
      }
    }
    const trackedServer = tracked.get(serverName)
    if (trackedServer === undefined) {
      return {
        name: serverName,
        state: 'unknown',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
        toolCount: 0,
      }
    }
    const snap = trackedServer.handle.snapshot()
    const code = snap.error !== undefined ? errorCodeOf(snap.error) : undefined
    const error = code !== undefined ? { code, message: runtimeErrorMessage(code) } : undefined
    return {
      name: serverName,
      state: snap.phase,
      attempts: snap.attempts,
      maxAttempts: snap.maxAttempts,
      toolCount: snap.toolCount,
      ...(snap.nextRetryAt !== undefined ? { nextRetryAt: snap.nextRetryAt } : {}),
      ...(snap.connectedAt !== undefined ? { connectedAt: snap.connectedAt } : {}),
      ...(snap.syncedAt !== undefined ? { syncedAt: snap.syncedAt } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  }

  const manager: ManagerHandle = {
    runtimeStatus(): RuntimeStatusView {
      const doc = options.getDoc()
      const servers: ServerRuntimeView[] = []
      const inDoc = new Set<string>()
      for (const server of doc.servers) {
        inDoc.add(server.serverName)
        servers.push(viewOf(server.serverName, isServerDisabled(doc, server.serverName)))
      }
      // Tracked handles the document no longer names (transient orphan).
      for (const serverName of tracked.keys()) {
        if (!inDoc.has(serverName)) servers.push(viewOf(serverName, false))
      }
      return { v: 1, at: Date.now(), servers }
    },

    toolList(serverName: string): ToolListView | undefined {
      if (!options.getDoc().servers.some((server) => server.serverName === serverName)) {
        throw new RuntimeActionError('not-found', 'server is not configured')
      }
      const trackedServer = tracked.get(serverName)
      if (trackedServer === undefined) return undefined
      // Never synced (connecting / gave up) or currently down is NOT an empty
      // list: the route answers not-connected; an actually synced empty list
      // (a server with zero tools) stays a 200.
      if (trackedServer.handle.snapshot().phase !== 'connected') return undefined
      return capToolList(trackedServer.handle.tools())
    },

    async connect(serverName: string): Promise<RuntimeActionResult> {
      const def = options.getDoc().servers.find((server) => server.serverName === serverName)
      if (def === undefined) {
        throw new RuntimeActionError('not-found', 'server is not configured')
      }
      if (isServerDisabled(options.getDoc(), serverName)) {
        throw new RuntimeActionError('disabled', 'server is disabled')
      }
      manualStopped.delete(serverName)
      await enqueueAwait(async () => {
        if (disposed) return
        const trackedServer = tracked.get(serverName)
        if (trackedServer !== undefined) {
          // Give-up keeps the handle tracked with no live generation: a manual
          // Connect must dispose it and start fresh instead of short-circuiting
          // (the failed card only offers Connect).
          if (trackedServer.handle.snapshot().phase !== 'failed') return
          await stopServer(serverName, false)
        }
        const current = options.getDoc().servers.find((server) => server.serverName === serverName)
        if (current === undefined || isServerDisabled(options.getDoc(), serverName)) return
        if (manualStopped.has(serverName)) return // a racing disconnect won
        await startServer(current)
      })
      return { name: serverName, state: 'connecting' }
    },

    async disconnect(serverName: string): Promise<RuntimeActionResult> {
      const def = options.getDoc().servers.find((server) => server.serverName === serverName)
      if (def === undefined) {
        throw new RuntimeActionError('not-found', 'server is not configured')
      }
      if (isServerDisabled(options.getDoc(), serverName)) {
        throw new RuntimeActionError('disabled', 'server is disabled')
      }
      manualStopped.set(serverName, fingerprint(def))
      await enqueueAwait(async () => {
        if (disposed) return
        await stopServer(serverName, true)
      })
      return { name: serverName, state: 'stopped' }
    },

    async test(serverName: string): Promise<ProbeResult> {
      const def = options.getDoc().servers.find((server) => server.serverName === serverName)
      if (def === undefined) {
        throw new RuntimeActionError('not-found', 'server is not configured')
      }
      if (isServerDisabled(options.getDoc(), serverName)) {
        throw new RuntimeActionError('disabled', 'server is disabled')
      }
      const live = tracked.get(serverName)
      if (live !== undefined && live.handle.snapshot().phase === 'connected') {
        // Connected servers are tested read-only: no second process/connection.
        return { ok: true, toolCount: live.handle.snapshot().toolCount }
      }
      const result = await probeServer({
        serverName,
        buildTransport: () => createTransport(def, resolveCredential, (message) => logger.warn(message)),
        toolCallTimeoutMs: def.timeoutMs,
      })
      if (result.ok) return result
      const code = errorCodeOf(result.error ?? '')
      return { ok: false, code, error: runtimeErrorMessage(code) }
    },

    reconcile() {
      enqueue(async () => {
        if (disposed) return
        const doc = options.getDoc()
        const nextNames = new Set(doc.servers.map((server) => server.serverName))
        // Vanished servers: revoke their tools everywhere, then stop.
        // Note: `doc` is a snapshot taken before any await below; a commit
        // landing mid-reconcile is served by the NEXT reconcile queued after
        // this one (mutations serialize), so a transient stale pass can only
        // briefly start/keep a server that a later pass removes.
        for (const serverName of [...tracked.keys()]) {
          if (!nextNames.has(serverName)) {
            await stopServer(serverName, true)
            epochs.delete(serverName)
            manualStopped.delete(serverName)
          }
        }
        // Appeared or changed servers: start or dispose+start. Globally
        // disabled servers are never supervised; one that is tracked (the
        // disable just landed) stops with revocation so its tools disappear.
        for (const server of doc.servers) {
          const current = tracked.get(server.serverName)
          if (isServerDisabled(doc, server.serverName)) {
            manualStopped.delete(server.serverName)
            if (current !== undefined) {
              await stopServer(server.serverName, true)
              epochs.delete(server.serverName)
            }
            continue
          }
          // A manual stop latches until the definition itself changes: a
          // settings commit that does not touch this server must not revive it.
          const stoppedAt = manualStopped.get(server.serverName)
          if (stoppedAt !== undefined) {
            if (stoppedAt === fingerprint(server)) continue
            manualStopped.delete(server.serverName)
          }
          if (current === undefined) {
            await startServer(server)
          } else if (current.defFingerprint !== fingerprint(server)) {
            await stopServer(server.serverName, false)
            await startServer(server)
          }
        }
        // Re-judge enablement for every live agent against the new overrides.
        applier.reconcile()
      })
    },
    async dispose() {
      disposed = true
      await mutations.catch(() => {})
      // stopServer deletes the tracked entry itself — deleting first here
      // would make the lookup no-op and leak every live supervisor + its
      // per-agent tool registrations (R2P-1).
      const pending: Promise<void>[] = []
      for (const serverName of [...tracked.keys()]) {
        pending.push(stopServer(serverName, true).catch(() => {}))
      }
      await Promise.allSettled(pending)
      epochs.clear()
      await mutations.catch(() => {})
    },
  }

  return manager
}

