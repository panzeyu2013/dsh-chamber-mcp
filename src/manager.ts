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
import type { CredentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { createAgentApplier, type AgentApplier, type ApplierLogger } from './agents.js'
import { createTransport } from './transport.js'
import { startServerSupervisor, type ServerHandle } from './server.js'
import { credentialRefsOf, type McpScopeDoc, type ServerDef } from './shared/model.js'
// Side-effect type imports: ctx.tools / ctx.agents / ctx.settings / ctx.credentials merge.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'

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
  })

  const enqueue = (work: () => Promise<void>): void => {
    const run = mutations.then(work)
    // The chain tail must survive a failed mutation; the worker owns reporting.
    mutations = run.catch(() => {})
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
      buildTransport: () => createTransport(server, resolveCredential, (message) => logger.warn(message)),
      logger,
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
      const present = next !== undefined && options.getDoc().servers.some((s) => s.serverName === next.serverName)
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

  // Credential updates: restart every server drawing on the changed ref so
  // the new value reaches the next connect attempt.
  ctx.effect(() => {
    const off = ctx.on('credentials/reference-updated', (ref: CredentialRef) => {
      if (disposed) return
      if (!refsInUse().has(ref)) return
      const affected = options.getDoc().servers.filter((server) => credentialRefsOf(server).includes(ref))
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

  const manager: ManagerHandle = {
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
          }
        }
        // Appeared or changed servers: start or dispose+start.
        for (const server of doc.servers) {
          const current = tracked.get(server.serverName)
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
