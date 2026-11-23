/**
 * Bridge orchestrator (host half): owns one per-definition SEAT per configured
 * server and drives the official `@deepseek-ai/dsh-mcp-client` instance mounted
 * inside it — the connection layer (transport, supervisor, probe, reconnect,
 * instruction sections, credential reads) now belongs to that instance.
 *
 * Responsibilities kept here:
 * - **Document → lifecycle reconcile**: a server that vanishes is unmounted and
 *   its seat disposed; a changed definition is remounted on a fresh seat; a
 *   globally disabled server is never mounted; a manual `disconnect` latches
 *   the server off until `connect` or a definition change.
 * - **Capture publication**: every seat forwards its capture snapshot here; the
 *   manager coalesces a whole generation swap into ONE microtask and pushes
 *   `{epoch, capture}` to the applier ({@link ./agents.js}), which is the only
 *   per-agent fan-out owner.
 * - **Status projection**: the upstream `McpConnectionStatus` union is mapped
 *   onto the frozen wire phases/codes ({@link ./shared/wire.js}) by the pure
 *   projection/classifiers in {@link ./status.js}; upstream diagnostic text and
 *   credentials NEVER cross the wire.
 * - **Guards**: a same-name server on the official manager plane is a fixed
 *   `failed{conflict}` (pre-check + mount-race classification), and an
 *   unconfirmed instance cleanup blocks remounting (`failed{cleanup}`) until the
 *   plugin/Host restarts (D6).
 * - **Actions**: connect / disconnect / restart / test / authorize /
 *   cancel-authorization / sign-out (runtime actions are serialized on one
 *   mutation chain so a settings commit can never race a restart into
 *   overlapping instances; `test` probes through the seat host and never
 *   touches the live generation).
 * - **OAuth lifecycle**: the seat host is the one authorization owner of its
 *   server ({@link ./oauth-authorization.js}); this manager implements the
 *   lifecycle port (chain, fingerprint, mount/unmount). A globally disabled
 *   http+oauth row gets NO seat eagerly: the first authorization action
 *   provisions it lazily ({@link ensureOAuthBinding}), so `authorize`/sign-out
 *   work before a server is ever enabled without paying a child fiber + private
 *   host per disabled row. An already-provisioned disabled row keeps its seat
 *   (its attempt stays observable); a DISABLED row that stops being
 *   OAuth-capable retires that seat/owner on the next reconcile. Reconcile
 *   skips a NEVER-MOUNTED enabled row that carries an activation-failure marker
 *   (`loadError`), so a stale seat/owner on such a row retires on the next
 *   explicit action (connect / restart / removal) instead. No host-side grant
 *   listener exists: the mounted instance retries itself on
 *   `credentials/record-updated` and the browser refreshes through the
 *   forwarded event plus the action response.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Type merge: `domain/changed` event + storageDomain ctx (types only).
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  Config as McpClientConfig,
  McpCloseResult,
  McpConnectionStatus,
  McpConnectionStatusHandle,
  McpProbeResult,
  McpServerInstance,
} from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-workspace'
import { RECONNECT_DEFAULTS, SERVER_DEFAULTS } from './shared/defaults.js'
import { safeErrorText, type HostLogger } from './log.js'
import {
  capToolList,
  classifyActivationFailure,
  classifyProbeFailure,
  classifyTestFailure,
  definitionsByName,
  lastDefinitionOf,
  projectStatus,
  type StatusProjectionRecord,
} from './status.js'
import {
  type RuntimeActionResult,
  type RuntimeActionErrorCode,
  type RuntimeAuthorizeResult,
  type RuntimeErrorCode,
  type RuntimePhase,
  type RuntimeStatusView,
  type RuntimeTestResult,
  type ServerRuntimeView,
  type ToolListView,
} from './shared/wire.js'
import type { OAuthAttemptView } from './shared/oauth.js'
import { isServerDisabled, type McpScopeDoc, type ServerDef, type StreamableHttpServerDef } from './shared/model.js'
import {
  OAUTH_ACTION_MESSAGES,
  OAuthActionError,
  createOAuthRegistry,
  oauthDefinitionOf,
  type OAuthLifecyclePort,
  type OAuthRegistry,
  type ResolvedOAuthBinding,
} from './oauth-authorization.js'
import { createAgentApplier, type AgentApplier } from './agents.js'
import { type CaptureSnapshot } from './facade.js'
import {
  createServerSeat,
  type SeatDeps,
  type ServerSeat,
} from './server-fiber.js'
import {
  disposeServerInstance,
  fingerprintDefinition,
  loadUpstreamMcpClient,
  resolveDefinitionConfig,
  type UpstreamMcpClient,
} from './upstream.js'

/** Durable storage-domain identity of the workspace registry (dsh-workspace). */
const WORKSPACE_DOMAIN_NAME = 'workspace'

/** Construction options of the bridge manager. */
export interface ManagerOptions {
  /** Plugin context: the manager's effects and every seat fiber live below it. */
  ctx: Context
  /** Logger (host-side diagnostics only; no wire text). */
  logger: HostLogger
  /** Read the current resolved settings document (never cached). */
  getDoc(): McpScopeDoc
  /**
   * Loader of the official MCP client host; defaults to the real dynamic import.
   * Tests inject a fake through this thunk.
   */
  upstream?: () => Promise<UpstreamMcpClient>
  /**
   * Names reserved by the official MCP manager plane (read-only conflict
   * pre-check). Absent/throwing degrades to no check (never blocks a mount).
   */
  managedNames?: () => readonly string[]
  /** Seat factory override (tests); defaults to {@link createServerSeat}. */
  seatFactory?: (deps: SeatDeps) => Promise<ServerSeat>
  /** Applier override (tests); defaults to the production per-agent applier. */
  applier?: AgentApplier
}

/** The bridge manager handle owned by the plugin entry. */
export interface ManagerHandle {
  /**
   * Diff the current document against the tracked servers and reconcile:
   * unmount vanished/changed/disabled servers, mount new/enabled ones (a
   * cleanup-failed record is retained as an orphan guard row), then re-judge
   * every live agent's tool set through the applier.
   */
  reconcile(): void
  /** Stop every instance/seat, quiesce the mutation chain, revoke registrations. */
  dispose(): Promise<void>
  /**
   * Runtime status. Called with no argument: every server the document names
   * (plus tracked orphan records) — the unchanged full view. Called with a
   * `serverName`: the same shape filtered to that single entry; an unknown /
   * untracked name yields `servers: []` (a normal view, never an error).
   */
  runtimeStatus(serverName?: string): RuntimeStatusView
  /** Committed tool identity of one server, capped for the wire. */
  toolList(serverName: string): ToolListView | undefined
  /** Manual reconnect: clears the manual-stop latch and mounts a fresh instance. */
  connect(serverName: string): Promise<RuntimeActionResult>
  /** Manual stop: revokes the server's tools and latches it off until changed. */
  disconnect(serverName: string): Promise<RuntimeActionResult>
  /** Remount the live definition (guarded by the cleanup latch). */
  restart(serverName: string): Promise<RuntimeActionResult>
  /** One-shot probe through the seat host (read-only while connected). */
  test(serverName: string): Promise<RuntimeTestResult>
  /**
   * Start (or report) explicit browser authorization for one OAuth server.
   * Works for globally disabled and manually stopped servers (the seat/host is
   * provisioned LAZILY by this action, never eagerly by reconcile); the
   * response carries the attempt view already at `waiting-browser` when the flow
   * gets there within a bounded wait, so the UI never has to poll for the
   * authorization URL.
   */
  authorize(serverName: string): Promise<RuntimeAuthorizeResult>
  /** Cancel the selected attempt; a stale id is a successful no-op. */
  cancelAuthorization(serverName: string, attemptId: string): Promise<RuntimeActionResult>
  /** Delete the stored grant and restart the server without it (upstream ordering). */
  signOut(serverName: string): Promise<RuntimeActionResult>
}

/** Whole-probe budget of the manual test action (upstream default). */
const TEST_PROBE_TIMEOUT_MS = 10_000

/**
 * Bounded wait of the authorize action for the attempt to reach
 * `waiting-browser` (or a terminal phase), so the browser opens the page from
 * the action response itself. The wait runs OUTSIDE the mutation chain: a slow
 * authorization server must never block a settings write or a restart.
 */
const AUTHORIZE_WAIT_MS = 5_000

/** Poll period of the bounded authorize wait. */
const AUTHORIZE_POLL_MS = 25

/** Fixed message of the conflict business failure (host-generated English). */
const CONFLICT_MESSAGE = 'a server with this name is already managed by the official MCP manager'

/** Fixed message of the cleanup business failure (host-generated English). */
const CLEANUP_MESSAGE = 'server cleanup is incomplete; restart the Host to retry'

/** Business failure of a runtime action, carrying a stable wire code. */
export class RuntimeActionError extends Error {
  readonly code: RuntimeActionErrorCode

  constructor(code: RuntimeActionErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeActionError'
    this.code = code
  }
}

/** One tracked server's seat, instance and lifecycle bookkeeping. */
interface ServerRecord {
  readonly serverName: string
  /** Fingerprint of the definition the live instance was started with. */
  defFingerprint: string
  /** Monotonic mount epoch (the applier's generation token). */
  epoch: number
  /** Seat creation in flight (never resolves to a disposed seat). */
  seat?: Promise<ServerSeat>
  seatRef?: ServerSeat
  /** Fingerprint of the definition the current seat was created for. */
  seatFingerprint?: string
  instance?: McpServerInstance
  handle?: McpConnectionStatusHandle
  detachStatus?: () => void
  status?: McpConnectionStatus
  /** The ONE resolved config per definition (mount/probe/authorization reuse). */
  config?: { fingerprint: string; value: McpClientConfig }
  publishedVersion?: number
  /**
   * Cheap capture version forwarded with the last capture notification (the
   * seat's notification counter). Compared with {@link publishedVersion}
   * BEFORE copying a snapshot: a status-only notification must not copy an
   * up-to-2000-entry capture. Undefined for a seat fake that cannot supply it.
   */
  captureVersion?: number
  captureCount: number
  truncated: boolean
  syncedAt?: number
  cleanupFailure?: McpCloseResult
  cleanupWarned?: boolean
  loadError?: RuntimeErrorCode
  seam?: { captured: number; reported: number }
  /** Instance is being torn down: late capture/status notifications must be ignored. */
  retired: boolean
  /**
   * The current instance finished activation and its status observer is
   * attached. Capture publications are held until then so a restart cannot
   * publish a half-registered generation (sections registered before the tool
   * sync) and revoke the previous generation prematurely.
   */
  attached: boolean
  /** In-flight probes (aborted on unmount/dispose). */
  probes: Set<AbortController>
  /** A capture publish is already queued for this record. */
  publishQueued?: boolean
}

/**
 * Create the bridge manager. It owns its effects on `ctx` (workspace listener,
 * applier listeners, seat child fibers) and one per-definition seat per
 * configured server; disposing it stops every instance and seat.
 */
export function createManager(options: ManagerOptions): ManagerHandle {
  const { ctx, logger } = options
  let disposed = false
  const records = new Map<string, ServerRecord>()
  /** Serialized mutation chain: reconcile diffs, remounts, actions. */
  let mutations: Promise<void> = Promise.resolve()
  /**
   * Manual-stop latch: serverName → definition fingerprint it was stopped at.
   * A reconcile with the SAME fingerprint leaves the server off (a settings
   * commit must not silently revive it); a fingerprint change clears the latch.
   */
  const manualStopped = new Map<string, string>()
  /**
   * Per-serverName monotonic epoch allocator, kept across record removal so a
   * re-added server can never reuse an epoch the applier has already floored.
   */
  const epochs = new Map<string, number>()
  /** Seat-generation sequence (registry keys only; never crosses the wire). */
  const seatEpochs = new Map<string, number>()

  const nextEpoch = (serverName: string): number => {
    const epoch = (epochs.get(serverName) ?? 0) + 1
    epochs.set(serverName, epoch)
    return epoch
  }

  const nextSeatEpoch = (serverName: string): number => {
    const epoch = (seatEpochs.get(serverName) ?? 0) + 1
    seatEpochs.set(serverName, epoch)
    return epoch
  }

  /** Live agent lookup from a scope key (the Agent object IS the scope key). */
  const agentOf = (scope: ScopeKey): Agent | undefined => {
    try {
      const candidate = scope as unknown as { id?: unknown }
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.id !== 'string') return undefined
      const live = ctx.agents.get(candidate.id as SessionId)
      return live !== undefined && (live as unknown) === (scope as unknown) ? live : undefined
    } catch {
      return undefined
    }
  }

  /** Adapter narrowing the live services to the applier's needs. */
  const applier: AgentApplier = options.applier ?? createAgentApplier({
    ctx,
    logger,
    agents: {
      list: () => [...ctx.agents.list()],
      get: (id: SessionId) => ctx.agents.get(id),
    },
    workspaceRegistry: {
      list: () => [...ctx.workspaceRegistry.list()],
    },
    overrides: () => options.getDoc().overrides,
    disabled: () => options.getDoc().disabled ?? {},
  })

  /** The REAL credential provider, captured by constructor injection into a seat (S4). */
  const realCredentials = (): CredentialProvider => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('mcp-scope: the credentials service is unavailable')
    return credentials
  }

  /** Serialize one mutation on the chain; its failure is logged, never swallowed silently. */
  const enqueue = (work: () => Promise<void>): void => {
    const run = mutations.then(work)
    mutations = run.catch((error: unknown) => {
      logger.error('mcp-scope: queued mutation failed: ' + safeErrorText(error))
    })
  }

  /**
   * Same chain, but the caller can await this mutation's settlement and receive
   * its value (the OAuth lifecycle port's exclusive `work` runs here).
   */
  const enqueueAwait = <T>(work: () => Promise<T>): Promise<T> => {
    const run = mutations.then(work)
    mutations = run.then(() => undefined, () => undefined)
    return run
  }

  /** Deferred, contained capture publication (D2: never re-enters upstream sync). */
  const schedulePublish = (rec: ServerRecord): void => {
    if (rec.publishQueued === true) return
    rec.publishQueued = true
    queueMicrotask(() => {
      rec.publishQueued = false
      publishCaptures(rec)
    })
  }

  /** Publish the current capture generation to the applier (idempotent by version). */
  function publishCaptures(rec: ServerRecord): void {
    if (disposed || rec.retired || !rec.attached) return
    // A failed seam canary keeps the server degraded until a connected status
    // agrees again; re-publishing a generation would re-arm the inconsistent
    // table behind the failure phase.
    if (rec.seam !== undefined) return
    const seat = rec.seatRef
    if (seat === undefined || !seat.alive) return
    // Cheap version FIRST: the seat forwards its notification counter with every
    // capture change, so an unchanged generation (status-only wake-up, duplicate
    // notification) is a no-op without copying the snapshot map. A seat without
    // the counter (test fakes) falls back to the snapshot version below.
    if (rec.captureVersion !== undefined && rec.captureVersion === rec.publishedVersion) return
    let capture: CaptureSnapshot
    try {
      capture = seat.capture()
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): capture snapshot failed: ' + safeErrorText(error))
      return
    }
    if (capture.version === rec.publishedVersion) return
    rec.publishedVersion = capture.version
    rec.captureCount = capture.tools.size
    rec.truncated = capture.truncated
    rec.syncedAt = Date.now()
    try {
      applier.syncServerState(rec.serverName, { epoch: rec.epoch, capture })
    } catch (error) {
      // The applier is synchronous and total; a throw must not escape into a
      // façade (upstream) path or a status observer.
      logger.error('mcp-scope(' + rec.serverName + '): could not publish the captured generation: ' + safeErrorText(error))
    }
  }

  /** Merge one cleanup result into the record; false when cleanup is unconfirmed. */
  function mergeCleanupFailure(rec: ServerRecord, result: McpCloseResult | undefined): boolean {
    if (result === undefined) return rec.cleanupFailure === undefined
    const confirmed = result.closeConfirmed && result.cleanupError === undefined
    if (confirmed) return rec.cleanupFailure === undefined
    const previous = rec.cleanupFailure
    const closeConfirmed = result.closeConfirmed && (previous === undefined || previous.closeConfirmed)
    const cleanupError = previous?.cleanupError ?? result.cleanupError
    rec.cleanupFailure = { closeConfirmed, ...(cleanupError === undefined ? {} : { cleanupError }) }
    return false
  }

  /** Warn once about a record whose teardown is unconfirmed (D6 guard row). */
  function warnCleanup(rec: ServerRecord): void {
    if (rec.cleanupWarned === true) return
    rec.cleanupWarned = true
    logger.warn('mcp-scope(' + rec.serverName + '): cleanup is incomplete; the server is blocked from remounting until the plugin or Host restarts')
  }

  /** Current tool-loading mode of a record (resolved config first). */
  function toolLoadingOf(rec: ServerRecord, def?: ServerDef): 'eager' | 'on-demand' {
    return rec.config?.value.toolLoading ?? def?.toolLoading ?? SERVER_DEFAULTS.toolLoading
  }

  /** Resolved reconnect policy of a record (for attempts/maxAttempts projection). */
  function maxAttemptsOf(rec: ServerRecord): number {
    return rec.config?.value.reconnect?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  }

  /** The ONE resolved config per definition: mount/probe/authorization reuse it (S6). */
  function resolveClientConfig(rec: ServerRecord, def: ServerDef, seat: ServerSeat): McpClientConfig {
    const fp = fingerprintDefinition(def)
    const cached = rec.config
    if (cached !== undefined && cached.fingerprint === fp) return cached.value
    const value = resolveDefinitionConfig(def, seat.host, { warn: (message) => logger.warn(message) })
    rec.config = { fingerprint: fp, value }
    return value
  }

  /** Create (once) and return the live seat of one record. */
  async function ensureSeat(rec: ServerRecord): Promise<ServerSeat> {
    if (rec.seatRef !== undefined && rec.seatRef.alive) return rec.seatRef
    if (rec.seat !== undefined) {
      try {
        const seat = await rec.seat
        if (seat.alive) {
          rec.seatRef = seat
          return seat
        }
      } catch {
        // The failed promise is dropped so the next action retries.
      }
      rec.seat = undefined
      rec.seatRef = undefined
    }
    if (disposed) throw new Error('mcp-scope: the manager is disposed')
    const upstream = await (options.upstream ?? loadUpstreamMcpClient)()
    if (disposed) throw new Error('mcp-scope: the manager is disposed')
    const seatEpoch = nextSeatEpoch(rec.serverName)
    const deps: SeatDeps = {
      ctx,
      upstream,
      credentials: realCredentials(),
      logger,
      serverName: rec.serverName,
      epoch: seatEpoch,
      onCaptureChanged: (_peek, version) => {
        // The cheap version travels with the notification; publishCaptures
        // compares it before copying the snapshot (H5).
        if (version !== undefined) rec.captureVersion = version
        schedulePublish(rec)
      },
      hooks: {
        agentOf: (scope) => agentOf(scope),
        admit: (agent, definition) => applier.admit(agent, definition),
        isApplied: (agent, serverName) => applier.isApplied(agent, serverName),
      },
    }
    const factory = options.seatFactory ?? createServerSeat
    rec.seat = factory(deps)
    try {
      const seat = await rec.seat
      if (!seat.alive) {
        rec.seat = undefined
        throw new Error('mcp-scope: the server seat was disposed before it became usable')
      }
      rec.seatRef = seat
      return seat
    } catch (error) {
      rec.seat = undefined
      throw error
    }
  }

  /** Dispose the current seat (all capture/instance/host effects die with its fiber). */
  async function dropSeat(rec: ServerRecord): Promise<void> {
    // The OAuth owner's attempt effects (callback listener, flow registration)
    // live on the seat fiber: retire and dispose it while the fiber is still
    // live, otherwise its effect disposers abort the attempt but lose the
    // bounded cleanup result the lifecycle owes the manager.
    try {
      const cleanup = await oauth.disposeOwner(rec.serverName)
      if (cleanup !== undefined && (!cleanup.closeConfirmed || cleanup.cleanupError !== undefined)) {
        logger.warn('mcp-scope(' + rec.serverName + '): the OAuth owner cleanup was not confirmed during seat teardown')
      }
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): the OAuth owner could not be disposed: ' + safeErrorText(error))
    }
    const pendingSeat = rec.seat
    const seat = rec.seatRef
    rec.seat = undefined
    rec.seatRef = undefined
    rec.seatFingerprint = undefined
    rec.publishedVersion = undefined
    let target = seat
    if (target === undefined && pendingSeat !== undefined) {
      target = await pendingSeat.catch((): undefined => undefined)
    }
    if (target === undefined) return
    try {
      await target.disposeSeat()
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): seat disposal failed: ' + safeErrorText(error))
    }
  }

  /** Read the live document row of one server (last duplicate wins). */
  function liveDefinition(serverName: string): ServerDef | undefined {
    return lastDefinitionOf(options.getDoc().servers, serverName)
  }

  /**
   * The live OAuth row of one server, or a fixed business failure. The three
   * OAuth actions validate against the DOCUMENT (not a runtime record): a
   * globally disabled or never-mounted server must still be authorizable.
   */
  function requireOAuthDefinition(serverName: string): StreamableHttpServerDef {
    const def = liveDefinition(serverName)
    if (def === undefined) throw new RuntimeActionError('not-found', 'server is not configured')
    const oauthDef = oauthDefinitionOf(def)
    if (oauthDef === undefined) {
      throw new RuntimeActionError('oauth-not-configured', OAUTH_ACTION_MESSAGES['oauth-not-configured'])
    }
    const rec = records.get(serverName)
    if (rec?.cleanupFailure !== undefined) {
      warnCleanup(rec)
      throw new RuntimeActionError('cleanup', CLEANUP_MESSAGE)
    }
    return oauthDef
  }

  /**
   * The live OAuth binding of one server: the SEAT's own host reference (never a
   * second host), the ONE resolved config shared with mount/probe (S6), and the
   * definition fingerprint the binding is valid for. Any mismatch reads as "no
   * binding" so a stale owner can never serve a view.
   */
  function oauthBinding(serverName: string): ResolvedOAuthBinding | undefined {
    if (disposed) return undefined
    const rec = records.get(serverName)
    const seat = rec?.seatRef
    if (rec === undefined || seat === undefined || !seat.alive) return undefined
    const def = oauthDefinitionOf(liveDefinition(serverName))
    if (def === undefined) return undefined
    const fingerprint = fingerprintDefinition(def)
    const cached = rec.config
    if (cached === undefined || cached.fingerprint !== fingerprint) return undefined
    const config = cached.value
    if (config.transport !== 'streamable-http' || config.oauth === undefined) return undefined
    // The SAME resolved config object mount/probe use (S6); the narrowing above
    // is what establishes the OAuth block, the assertion only carries it.
    return { serverName, host: seat.host, config: config as ResolvedOAuthBinding['config'], fingerprint }
  }

  /**
   * Ensure the seat and its ONE resolved configuration for a definition without
   * mounting an instance. This is the LAZY provisioning path of the authorize
   * action (a globally disabled or never-mounted OAuth row): reconcile never
   * creates a seat for a disabled row.
   */
  async function provisionSeat(rec: ServerRecord, def: ServerDef): Promise<ServerSeat> {
    if (disposed) throw new Error('mcp-scope: the manager is disposed')
    const fingerprint = fingerprintDefinition(def)
    if (rec.seatRef !== undefined && rec.seatFingerprint !== undefined && rec.seatFingerprint !== fingerprint) {
      // A changed definition replaces the seat (which retires its OAuth owner).
      await dropSeat(rec)
    }
    const seat = await ensureSeat(rec)
    resolveClientConfig(rec, def, seat)
    rec.seatFingerprint = fingerprint
    return seat
  }

  /**
   * The lazy authorize provisioning: make sure a live binding exists before the
   * registry starts a flow (the ONLY place a globally disabled OAuth row gets a
   * seat + private host). A provisioning failure degrades to a fixed code (the
   * cause stays host-side) — the route never sees an activation message.
   */
  async function ensureOAuthBinding(serverName: string, def: StreamableHttpServerDef): Promise<void> {
    if (oauthBinding(serverName) !== undefined) return
    const rec = ensureRecord(serverName)
    if (rec.cleanupFailure !== undefined) {
      warnCleanup(rec)
      throw new RuntimeActionError('cleanup', CLEANUP_MESSAGE)
    }
    try {
      await provisionSeat(rec, def)
    } catch (error) {
      rec.loadError = classifyActivationFailure(error)
      logger.error('mcp-scope(' + serverName + '): the OAuth seat could not be provisioned: ' + safeErrorText(error))
      throw new RuntimeActionError('oauth-unavailable', OAUTH_ACTION_MESSAGES['oauth-unavailable'])
    }
    if (oauthBinding(serverName) === undefined) {
      throw new RuntimeActionError('oauth-unavailable', OAUTH_ACTION_MESSAGES['oauth-unavailable'])
    }
    // F1: a FAILED lazy provision leaves the activation-failure marker that makes
    // reconcile skip a never-mounted row. A later SUCCESSFUL authorize must clear
    // it, or the row stays failed{load} forever and an enable never auto-mounts
    // (only an explicit connect would recover). beginMount clears it again on an
    // activated mount.
    rec.loadError = undefined
  }

  /** Mount a fresh instance when the server should hold one (the lifecycle port's mount verb). */
  async function mountLive(serverName: string): Promise<void> {
    if (disposed) return
    const doc = options.getDoc()
    const def = liveDefinition(serverName)
    if (def === undefined || isServerDisabled(doc, serverName) || manualStopped.has(serverName)) return
    const rec = records.get(serverName)
    if (rec === undefined || rec.cleanupFailure !== undefined || rec.instance !== undefined) return
    await beginMount(rec, def)
  }

  /** Terminal-enough phases of an authorization attempt (the bounded wait stops here). */
  function authorizationSettled(phase: OAuthAttemptView['phase']): boolean {
    return phase === 'waiting-browser' || phase === 'authorized' || phase === 'cancelled' || phase === 'failed'
  }

  /**
   * Bounded wait for the attempt to leave `starting` (the UI opens the page from
   * the action response; ADR-8 forbids a fast browser poll). Runs outside the
   * mutation chain and never waits past {@link AUTHORIZE_WAIT_MS}.
   */
  async function awaitAuthorizationView(serverName: string, initial: OAuthAttemptView): Promise<OAuthAttemptView> {
    let view = initial
    const deadline = Date.now() + AUTHORIZE_WAIT_MS
    while (!authorizationSettled(view.phase) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AUTHORIZE_POLL_MS)
      })
      if (disposed) break
      const next = oauth.attemptView(serverName)
      if (next === undefined) break
      view = next
    }
    return view
  }

  /** Update the seam canary on a connected status (eager generations only). */
  function checkSeam(rec: ServerRecord, status: Extract<McpConnectionStatus, { state: 'connected' }>): void {
    const seat = rec.seatRef
    if (seat === undefined || !seat.alive) return
    let capture: CaptureSnapshot
    try {
      capture = seat.capture()
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): seam canary could not read the capture: ' + safeErrorText(error))
      return
    }
    if (toolLoadingOf(rec) !== 'eager') {
      // On-demand counts the loader plus the catalog, so a count mismatch is not
      // a capture defect (invariant 7 exemption).
      if (rec.seam !== undefined) rec.seam = undefined
      return
    }
    const captured = capture.tools.size
    if (!capture.truncated && status.toolCount !== captured) {
      const firstMismatch = rec.seam === undefined
      rec.seam = { captured, reported: status.toolCount }
      if (firstMismatch) {
        logger.error('mcp-scope(' + rec.serverName + '): the captured tool generation (' + captured + ') disagrees with the instance (' + status.toolCount + '); degrading to failed/seam')
        // Explicit degradation (invariant 7): never serve a silent empty table.
        try {
          applier.removeServer(rec.serverName)
        } catch (error) {
          logger.error('mcp-scope(' + rec.serverName + '): could not revoke the mismatched generation: ' + safeErrorText(error))
        }
      }
      return
    }
    if (rec.seam !== undefined) {
      rec.seam = undefined
      // Force one re-publish even if the capture version did not move.
      rec.publishedVersion = undefined
      logger.info('mcp-scope(' + rec.serverName + '): the captured tool generation agrees with the instance again')
      schedulePublish(rec)
    }
  }

  /** Store one upstream status and react to the transitions that own guards/canaries. */
  function onUpstreamStatus(rec: ServerRecord, status: McpConnectionStatus): void {
    if (disposed || rec.retired) return
    rec.status = status
    if (status.state === 'failed' && status.reason === 'unclosed-generation') {
      mergeCleanupFailure(rec, rec.handle?.closure())
    }
    if (status.state === 'connected') checkSeam(rec, status)
    schedulePublish(rec)
  }

  /** Attach the status observer of a settled instance (ready continuation). */
  function attachStatus(rec: ServerRecord, instance: McpServerInstance, handle: McpConnectionStatusHandle): void {
    if (disposed || rec.retired || rec.instance !== instance) return
    rec.attached = true
    rec.handle = handle
    try {
      rec.detachStatus = handle.onChange((status) => onUpstreamStatus(rec, status))
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): status observer could not be attached: ' + safeErrorText(error))
    }
    onUpstreamStatus(rec, handle.current())
    schedulePublish(rec)
  }

  /** Record an activation rejection: fixed code, capture reset, cleanup result drained. */
  function onActivationFailure(rec: ServerRecord, instance: McpServerInstance, error: unknown): void {
    if (disposed || rec.retired || rec.instance !== instance) return
    rec.attached = false
    rec.instance = undefined
    rec.handle = undefined
    rec.detachStatus?.()
    rec.detachStatus = undefined
    rec.status = undefined
    rec.loadError = classifyActivationFailure(error)
    // The resolved config is kept: it is defined by the definition alone, and
    // mount/probe/authorization must keep sharing ONE validation result until
    // the definition changes (S6).
    rec.captureCount = 0
    rec.truncated = false
    rec.publishedVersion = undefined
    rec.seam = undefined
    try {
      rec.seatRef?.resetCapture()
    } catch (resetError) {
      logger.warn('mcp-scope(' + rec.serverName + '): capture reset after activation failure failed: ' + safeErrorText(resetError))
    }
    logger.error('mcp-scope(' + rec.serverName + '): server activation failed (' + rec.loadError + '): ' + safeErrorText(error))
    void instance.dispose().then(
      (result) => {
        enqueue(async () => {
          if (disposed || rec.retired) return
          mergeCleanupFailure(rec, result)
        })
      },
      (disposeError: unknown) => {
        logger.warn('mcp-scope(' + rec.serverName + '): instance disposal after activation failure failed: ' + safeErrorText(disposeError))
      },
    )
  }

  /** Ready continuation: attach the status observer or record the classified failure. */
  function observeReady(rec: ServerRecord, instance: McpServerInstance): void {
    void instance.ready.then(
      (handle) => {
        enqueue(async () => {
          attachStatus(rec, instance, handle)
        })
      },
      (error: unknown) => {
        enqueue(async () => {
          onActivationFailure(rec, instance, error)
        })
      },
    )
  }

  /**
   * Mount one fresh instance of `def` (caller holds the mutation chain).
   * Definition changes replace the seat; a same-name official-plane server is a
   * fixed conflict (pre-check + mount-race classification).
   */
  async function beginMount(rec: ServerRecord, def: ServerDef): Promise<void> {
    if (disposed) return
    if (rec.cleanupFailure !== undefined) {
      warnCleanup(rec)
      return
    }
    const fp = fingerprintDefinition(def)
    if (rec.seatRef !== undefined && rec.seatFingerprint !== undefined && rec.seatFingerprint !== fp) {
      await dropSeat(rec)
    }
    let seat: ServerSeat
    try {
      seat = await ensureSeat(rec)
    } catch (error) {
      rec.loadError = classifyActivationFailure(error)
      logger.error('mcp-scope(' + rec.serverName + '): the server seat failed to activate: ' + safeErrorText(error))
      return
    }
    // NOTE: rec.retired is intentionally true here on a remount (the previous
    // instance was just unmounted); only a manager dispose aborts the mount.
    if (disposed) return
    const conflict = assertNoManagedConflict(rec.serverName)
    if (conflict !== undefined) {
      rec.loadError = 'conflict'
      throw conflict
    }
    let config: McpClientConfig
    try {
      config = resolveClientConfig(rec, def, seat)
    } catch (error) {
      rec.loadError = classifyActivationFailure(error)
      logger.error('mcp-scope(' + rec.serverName + '): the server configuration was refused: ' + safeErrorText(error))
      return
    }
    rec.retired = false
    rec.attached = false
    rec.seatFingerprint = fp
    rec.defFingerprint = fp
    rec.loadError = undefined
    rec.seam = undefined
    rec.cleanupWarned = undefined
    rec.epoch = nextEpoch(rec.serverName)
    let instance: McpServerInstance
    try {
      instance = seat.mount(config)
    } catch (error) {
      rec.loadError = classifyActivationFailure(error)
      logger.error('mcp-scope(' + rec.serverName + '): the server could not be mounted: ' + safeErrorText(error))
      return
    }
    rec.instance = instance
    // Optimistic seed: the card shows `connecting` while the handshake settles.
    rec.status = { state: 'connecting', attempt: 0 }
    logger.info('mcp-scope(' + rec.serverName + '): server started (' + (def.transport === 'stdio' ? 'stdio' : 'streamable-http') + ')')
    observeReady(rec, instance)
  }

  /**
   * Stop one instance and revoke (optionally) its published generation.
   * Idempotent and total: it never throws, merges cleanup failures, and returns
   * whether cleanup is confirmed (unconfirmed blocks remounting until restart).
   */
  async function unmount(rec: ServerRecord, revokeFirst: boolean): Promise<boolean> {
    rec.retired = true
    rec.attached = false
    for (const controller of rec.probes) controller.abort()
    rec.probes.clear()
    rec.detachStatus?.()
    rec.detachStatus = undefined
    const instance = rec.instance
    rec.instance = undefined
    rec.handle = undefined
    mergeCleanupFailure(rec, await disposeServerInstance(instance))
    try {
      rec.seatRef?.resetCapture()
    } catch (error) {
      logger.warn('mcp-scope(' + rec.serverName + '): capture reset during stop failed: ' + safeErrorText(error))
    }
    rec.status = undefined
    rec.publishedVersion = undefined
    rec.captureCount = 0
    rec.truncated = false
    rec.syncedAt = undefined
    rec.seam = undefined
    if (revokeFirst) {
      try {
        applier.removeServer(rec.serverName)
      } catch (error) {
        logger.error('mcp-scope(' + rec.serverName + '): could not revoke the server: ' + safeErrorText(error))
      }
    }
    if (instance !== undefined) logger.info('mcp-scope(' + rec.serverName + '): server stopped')
    return rec.cleanupFailure === undefined
  }

  /** Unmount then mount the live definition (manual restart / definition change). */
  async function remount(rec: ServerRecord): Promise<void> {
    const clean = await unmount(rec, false)
    if (!clean) {
      warnCleanup(rec)
      return
    }
    if (disposed) return
    const doc = options.getDoc()
    const live = doc.servers.find((entry) => entry.serverName === rec.serverName)
    if (live === undefined || isServerDisabled(doc, rec.serverName)) return
    await beginMount(rec, live)
  }

  /** Manual-latch clearing rule: only a definition change revives a stopped server. */
  function latchBlocks(serverName: string, fp: string): boolean {
    const stoppedAt = manualStopped.get(serverName)
    if (stoppedAt === undefined) return false
    if (stoppedAt === fp) return true
    manualStopped.delete(serverName)
    return false
  }

  /** Conflict pre-check against the read-only official manager plane (ADR-6). */
  function assertNoManagedConflict(serverName: string): RuntimeActionError | undefined {
    if (options.managedNames === undefined) return undefined
    try {
      const names = options.managedNames()
      return names.includes(serverName) ? new RuntimeActionError('conflict', CONFLICT_MESSAGE) : undefined
    } catch (error) {
      // Absent/broken official manager degrades to no pre-check; the mount-race
      // classification still catches a real collision.
      logger.warn('mcp-scope: the official manager plane could not be read: ' + safeErrorText(error))
      return undefined
    }
  }

  /** Create or return the tracked record of one serverName. */
  function ensureRecord(serverName: string): ServerRecord {
    let rec = records.get(serverName)
    if (rec === undefined) {
      rec = {
        serverName,
        defFingerprint: '',
        epoch: 0,
        retired: false,
        attached: false,
        captureCount: 0,
        truncated: false,
        probes: new Set<AbortController>(),
      }
      records.set(serverName, rec)
    }
    return rec
  }

  /** Guard shared by every action: configured, not globally disabled, cleanup confirmed. */
  function assertActionable(serverName: string): ServerDef {
    const def = liveDefinition(serverName)
    if (def === undefined) throw new RuntimeActionError('not-found', 'server is not configured')
    const doc = options.getDoc()
    if (isServerDisabled(doc, serverName)) throw new RuntimeActionError('disabled', 'server is disabled')
    const rec = records.get(serverName)
    if (rec?.cleanupFailure !== undefined) {
      warnCleanup(rec)
      throw new RuntimeActionError('cleanup', CLEANUP_MESSAGE)
    }
    return def
  }

  /** Fold one thrown action failure into the wire's business failure. */
  function asActionError(error: unknown): RuntimeActionError {
    if (error instanceof RuntimeActionError) return error
    // The OAuth registry reports fixed business codes only; its cause is a
    // host-side diagnostic that never crosses the wire.
    if (error instanceof OAuthActionError) return new RuntimeActionError(error.code, error.message)
    // Fixed wire message: the cause (host/upstream text) stays host-side.
    void error
    return new RuntimeActionError('internal', 'action failed')
  }

  /** Projected phase of one server (used as the action result). */
  function projectedPhase(serverName: string): RuntimePhase {
    const view = runtimeStatus(serverName)
    return view.servers[0]?.phase ?? 'unknown'
  }

  /** Plain-value projection of one tracked record (the pure projector's input). */
  function statusRecordOf(rec: ServerRecord | undefined): StatusProjectionRecord | undefined {
    if (rec === undefined) return undefined
    return {
      maxAttempts: maxAttemptsOf(rec),
      cleanupFailure: rec.cleanupFailure !== undefined,
      loadError: rec.loadError,
      seam: rec.seam,
      status: rec.status,
      syncedAt: rec.syncedAt,
      captureCount: rec.captureCount,
    }
  }

  /** Project one live document row (or tracked orphan) onto the frozen wire view. */
  function projectRow(serverName: string, oauthConfigured: boolean, disabled: boolean, configured: boolean): ServerRuntimeView {
    return projectStatus({
      serverName,
      record: statusRecordOf(records.get(serverName)),
      oauthConfigured,
      disabled,
      configured,
      manualStopped: manualStopped.has(serverName),
      authorization: oauthConfigured ? oauth.attemptView(serverName) : undefined,
    })
  }

  /** Whole-document status projection (pure read of live doc + tracked records). */
  function runtimeStatus(serverName?: string): RuntimeStatusView {
    const doc = options.getDoc()
    const servers: ServerRuntimeView[] = []
    const inDoc = new Set<string>()
    for (const def of doc.servers) {
      inDoc.add(def.serverName)
      const oauthConfigured = def.transport === 'streamable-http' && def.oauth !== undefined
      servers.push(projectRow(def.serverName, oauthConfigured, isServerDisabled(doc, def.serverName), true))
    }
    for (const rec of records.values()) {
      if (inDoc.has(rec.serverName)) continue
      // Retained orphan row: no longer named by the document, kept only while
      // its teardown is unconfirmed (E7/D6).
      servers.push(projectRow(rec.serverName, false, false, false))
    }
    return {
      v: 1,
      at: Date.now(),
      servers: serverName === undefined ? servers : servers.filter((entry) => entry.name === serverName),
    }
  }

  /** One reconcile pass (caller holds the mutation chain). */
  async function reconcileOnce(): Promise<void> {
    if (disposed) return
    const doc = options.getDoc()
    const byName = definitionsByName(doc.servers)
    // 1. Removals. A cleanup-failed record is retained as an orphan guard row
    // (D6): it must never be remounted until the plugin/Host restarts.
    for (const [name, rec] of [...records]) {
      if (byName.has(name)) continue
      manualStopped.delete(name)
      if (rec.instance === undefined && rec.cleanupFailure !== undefined) {
        // The row is gone but its teardown never confirmed: retire the OAuth
        // owner now (its effects must not outlive the row) and keep the guard.
        await oauth.disposeOwner(name)
        warnCleanup(rec)
        continue
      }
      const clean = await unmount(rec, true)
      if (clean) {
        await dropSeat(rec)
        records.delete(name)
      } else {
        warnCleanup(rec)
      }
    }
    // 2. Per configured server: enable/disable, latch, definition change, mount.
    for (const def of doc.servers) {
      const name = def.serverName
      if (isServerDisabled(doc, name)) {
        manualStopped.delete(name)
        // Lazy OAuth provisioning (H1): a globally disabled row gets NO seat or
        // private host here — the authorize action provisions it on demand
        // (ensureOAuthBinding) and sign-out works off the document alone. A seat
        // an earlier action DID create is kept until the row stops being
        // OAuth-capable, so an in-flight attempt stays observable.
        const rec = records.get(name)
        if (rec === undefined) continue
        if (rec.instance !== undefined || rec.status !== undefined) await unmount(rec, true)
        const oauthDef = oauthDefinitionOf(def)
        if (oauthDef === undefined) {
          // H2: the definition switched to stdio (or dropped its OAuth block):
          // retire the stale OAuth owner and dispose the seat/host it used. The
          // record itself is kept (removal + cleanup guards still apply).
          if (rec.seatRef !== undefined || rec.seat !== undefined || rec.seatFingerprint !== undefined) {
            await dropSeat(rec)
          }
          continue
        }
        if (rec.seatRef !== undefined && (!rec.seatRef.alive || rec.seatFingerprint !== fingerprintDefinition(oauthDef))) {
          // A disabled row's existing seat no longer matches its OAuth
          // definition: retire it now; the next authorize re-provisions lazily.
          await dropSeat(rec)
        }
        continue
      }
      const fp = fingerprintDefinition(def)
      if (latchBlocks(name, fp)) continue
      const rec = records.get(name)
      if (rec !== undefined && rec.cleanupFailure !== undefined) {
        warnCleanup(rec)
        continue
      }
      if (rec === undefined) {
        const fresh = ensureRecord(name)
        try {
          await beginMount(fresh, def)
        } catch (error) {
          reportContained(error)
        }
        continue
      }
      if (rec.instance !== undefined) {
        if (rec.defFingerprint !== fp) {
          try {
            await remount(rec)
          } catch (error) {
            reportContained(error)
          }
        }
        continue
      }
      // No instance: a failed activation waits for an explicit connect, while a
      // never-mounted / re-enabled record mounts on this pass.
      if (rec.loadError !== undefined) continue
      try {
        await beginMount(rec, def)
      } catch (error) {
        reportContained(error)
      }
    }
  }

  /** Log one contained reconcile failure (business conflicts included, not thrown). */
  function reportContained(error: unknown): void {
    if (error instanceof RuntimeActionError) {
      logger.warn('mcp-scope: ' + error.message)
      return
    }
    logger.error('mcp-scope: a queued server operation failed: ' + safeErrorText(error))
  }

  // Workspace registry changes (create/delete/rename/membership): re-judge live
  // agent membership so a deleted workspace revokes its sessions' tools promptly
  // instead of waiting for the next settings event. No server mutation.
  ctx.effect(() => {
    const off = ctx.on('domain/changed', (change) => {
      if (disposed) return
      if (change.domain !== WORKSPACE_DOMAIN_NAME || change.table !== 'workspaces') return
      enqueue(async () => {
        if (disposed) return
        try {
          applier.reconcile()
        } catch (error) {
          logger.error('mcp-scope: applier reconcile failed: ' + safeErrorText(error))
        }
      })
    })
    return () => off()
  }, 'mcp-scope.workspace-domain()')

  /**
   * The OAuth lifecycle port — the ONLY seam between the registry and this
   * manager. It exposes the mutation chain (exclusive), the serialized
   * definition fingerprint, and instance unmount/mount; the registry never
   * touches records, seats or hosts itself.
   */
  const oauthLifecycle: OAuthLifecyclePort = {
    exclusive: enqueueAwait,
    fingerprint(serverName: string): string | undefined {
      const def = liveDefinition(serverName)
      return def === undefined ? undefined : fingerprintDefinition(def)
    },
    wantsInstance(serverName: string): boolean {
      const doc = options.getDoc()
      return liveDefinition(serverName) !== undefined
        && !isServerDisabled(doc, serverName)
        && !manualStopped.has(serverName)
    },
    async unmount(serverName: string): Promise<boolean> {
      const rec = records.get(serverName)
      if (rec === undefined) return true
      const clean = await unmount(rec, true)
      if (!clean) warnCleanup(rec)
      return clean
    },
    mount(serverName: string): void {
      enqueue(async () => {
        try {
          await mountLive(serverName)
        } catch (error) {
          reportContained(error)
        }
      })
    },
  }

  /**
   * The plugin-level authorization registry. Its owners are cached per live
   * binding fingerprint; the credentials verb is the manager's real provider
   * (never the seat's capture façade) for the sign-out record deletion.
   */
  const oauth: OAuthRegistry = createOAuthRegistry({
    ctx,
    logger,
    credentials: {
      deleteRecord: async (key) => {
        await realCredentials().deleteRecord(key)
      },
    },
    getDoc: () => options.getDoc(),
    bindings: { get: (serverName) => oauthBinding(serverName) },
    lifecycle: oauthLifecycle,
  })

  const manager: ManagerHandle = {
    reconcile(): void {
      enqueue(async () => {
        if (disposed) return
        try {
          await reconcileOnce()
        } catch (error) {
          logger.error('mcp-scope: reconcile failed: ' + safeErrorText(error))
        }
        try {
          applier.reconcile()
        } catch (error) {
          logger.error('mcp-scope: applier reconcile failed: ' + safeErrorText(error))
        }
      })
    },

    async connect(serverName: string): Promise<RuntimeActionResult> {
      assertActionable(serverName)
      manualStopped.delete(serverName)
      try {
        await enqueueAwait(async () => {
          if (disposed) return
          const rec = ensureRecord(serverName)
          const status = rec.status
          const running = rec.instance !== undefined && (status === undefined || status.state !== 'failed') && rec.loadError === undefined
          if (running) return
          if (rec.instance !== undefined) {
            const clean = await unmount(rec, false)
            if (!clean) {
              warnCleanup(rec)
              return
            }
          }
          if (disposed || manualStopped.has(serverName)) return // a racing disconnect won
          const doc = options.getDoc()
          const def = doc.servers.find((entry) => entry.serverName === serverName)
          if (def === undefined || isServerDisabled(doc, serverName)) return
          await beginMount(rec, def)
        })
      } catch (error) {
        throw asActionError(error)
      }
      return { name: serverName, phase: projectedPhase(serverName) }
    },

    async disconnect(serverName: string): Promise<RuntimeActionResult> {
      const def = assertActionable(serverName)
      manualStopped.set(serverName, fingerprintDefinition(def))
      try {
        await enqueueAwait(async () => {
          if (disposed) return
          const rec = records.get(serverName)
          if (rec === undefined) return
          const clean = await unmount(rec, true)
          if (!clean) warnCleanup(rec)
        })
      } catch (error) {
        throw asActionError(error)
      }
      return { name: serverName, phase: projectedPhase(serverName) }
    },

    async restart(serverName: string): Promise<RuntimeActionResult> {
      assertActionable(serverName)
      manualStopped.delete(serverName)
      try {
        await enqueueAwait(async () => {
          if (disposed) return
          const doc = options.getDoc()
          const live = doc.servers.find((entry) => entry.serverName === serverName)
          if (live === undefined || isServerDisabled(doc, serverName)) return
          const rec = ensureRecord(serverName)
          if (rec.cleanupFailure !== undefined) {
            warnCleanup(rec)
            return
          }
          await remount(rec)
        })
      } catch (error) {
        throw asActionError(error)
      }
      return { name: serverName, phase: projectedPhase(serverName) }
    },

    async test(serverName: string): Promise<RuntimeTestResult> {
      const def = assertActionable(serverName)
      const rec = ensureRecord(serverName)
      const status = rec.status
      // A live generation is tested read-only: never open a second connection.
      if (rec.instance !== undefined && status?.state === 'connected') {
        return { ok: true, toolCount: status.toolCount }
      }
      let seat: ServerSeat
      let config: McpClientConfig
      try {
        seat = await ensureSeat(rec)
        // The record may have been removed while the seat was starting (test is
        // not serialized on the mutation chain): never leak a seat for a name the
        // manager no longer tracks.
        if (records.get(serverName) !== rec) {
          void seat.disposeSeat()
          return { ok: false, stage: 'connect', code: 'internal' }
        }
        config = resolveClientConfig(rec, def, seat)
      } catch (error) {
        return { ok: false, stage: 'connect', code: classifyTestFailure(error) }
      }
      const controller = new AbortController()
      rec.probes.add(controller)
      let result: McpProbeResult
      try {
        result = await seat.probe(config, { timeoutMs: TEST_PROBE_TIMEOUT_MS, signal: controller.signal })
      } catch (error) {
        return { ok: false, stage: 'connect', code: classifyTestFailure(error) }
      } finally {
        rec.probes.delete(controller)
      }
      const clean = result.closeConfirmed && result.cleanupError === undefined
      if (!clean) {
        mergeCleanupFailure(rec, result)
        warnCleanup(rec)
      }
      if (result.ok) {
        return { ok: true, toolCount: result.toolNames.length, truncated: result.truncated }
      }
      return {
        ok: false,
        stage: result.stage,
        code: clean ? classifyProbeFailure(result.message) : 'cleanup',
      }
    },

    async authorize(serverName: string): Promise<RuntimeAuthorizeResult> {
      requireOAuthDefinition(serverName)
      let attempt: OAuthAttemptView
      try {
        attempt = await enqueueAwait(async () => {
          if (disposed) throw new RuntimeActionError('internal', 'the manager is disposed')
          // Re-read on the chain: a settings commit may have landed while this
          // action queued, and only the live row may authorize.
          const def = requireOAuthDefinition(serverName)
          // A deployment without the browser-authorization services can never
          // start a flow: fail with the fixed code BEFORE lazily provisioning a
          // seat for a disabled row (the eager path used to hide this cost).
          if (!oauth.available()) {
            throw new RuntimeActionError('oauth-unavailable', OAUTH_ACTION_MESSAGES['oauth-unavailable'])
          }
          await ensureOAuthBinding(serverName, def)
          return await oauth.authorize(serverName)
        })
      } catch (error) {
        throw asActionError(error)
      }
      // Bounded wait OUTSIDE the chain: the browser opens the page from the
      // action response, and a slow authorization server must never block a
      // settings write or a restart (ADR-8: no fast browser poll).
      const view = await awaitAuthorizationView(serverName, attempt)
      return { name: serverName, phase: projectedPhase(serverName), authorization: view }
    },

    async cancelAuthorization(serverName: string, attemptId: string): Promise<RuntimeActionResult> {
      requireOAuthDefinition(serverName)
      try {
        await enqueueAwait(async () => {
          if (disposed) return
          await oauth.cancel(serverName, attemptId)
        })
      } catch (error) {
        throw asActionError(error)
      }
      return { name: serverName, phase: projectedPhase(serverName) }
    },

    async signOut(serverName: string): Promise<RuntimeActionResult> {
      requireOAuthDefinition(serverName)
      try {
        // The registry owns the exclusive section AND the remount scheduling; a
        // second enqueue here would deadlock on the mutation chain.
        await oauth.signOut(serverName)
        // Flush the queued remount so the result reports the fresh phase.
        await enqueueAwait(async () => undefined)
      } catch (error) {
        const failure = asActionError(error)
        if (failure.code === 'oauth-cleanup') {
          // Grant kept, remount blocked: retain the unconfirmed cleanup so the
          // row reports failed{cleanup} until the plugin/Host restarts (D6).
          const rec = records.get(serverName)
          if (rec !== undefined) {
            mergeCleanupFailure(rec, { closeConfirmed: false })
            warnCleanup(rec)
          }
        }
        throw failure
      }
      return { name: serverName, phase: projectedPhase(serverName) }
    },

    runtimeStatus(serverName?: string): RuntimeStatusView {
      return runtimeStatus(serverName)
    },

    toolList(serverName: string): ToolListView | undefined {
      const def = liveDefinition(serverName)
      if (def === undefined) throw new RuntimeActionError('not-found', 'server is not configured')
      const rec = records.get(serverName)
      if (rec === undefined) return undefined
      const status = rec.status
      // Never synced (connecting / down) or currently failed is NOT an empty
      // list: the route answers not-connected; a connected empty list stays 200.
      if (status === undefined || status.state !== 'connected') return undefined
      if (toolLoadingOf(rec, def) === 'on-demand') {
        // On-demand definitions live behind the upstream loader: the wire marks
        // the mode and carries the offered count only.
        return { mode: 'catalog', tools: [], truncated: false, total: status.toolCount }
      }
      let capture: CaptureSnapshot | undefined
      try {
        capture = rec.seatRef?.capture()
      } catch (error) {
        logger.warn('mcp-scope(' + serverName + '): tool list could not read the capture: ' + safeErrorText(error))
      }
      return capToolList(capture?.tools ?? new Map<string, ToolDefinition>())
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await mutations.catch(() => {})
      // OAuth owners first: their attempt effects live on the seat fibers, so
      // retire/dispose them while those fibers are still live (a fiber unload
      // would abort the attempt but lose the bounded cleanup result).
      try {
        await oauth.disposeAll()
      } catch (error) {
        logger.warn('mcp-scope: OAuth authorization owners failed to dispose: ' + safeErrorText(error))
      }
      const pending: Promise<void>[] = []
      for (const rec of [...records.values()]) {
        pending.push((async () => {
          await unmount(rec, true)
          await dropSeat(rec)
        })().catch(() => {}))
      }
      await Promise.allSettled(pending)
      try {
        applier.dispose()
      } catch (error) {
        logger.warn('mcp-scope: the applier failed to dispose: ' + safeErrorText(error))
      }
      records.clear()
      manualStopped.clear()
      epochs.clear()
      seatEpochs.clear()
      await mutations.catch(() => {})
    },
  }

  return manager
}
