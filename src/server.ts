/**
 * Per-server supervisor (host half): owns the MCP client/transport
 * generations for ONE configured server and keeps the server's master
 * definition state in sync with the live generation — mirroring the official
 * `dsh-mcp-client` connection supervisor exactly (docs/recon/mcp-client-official.md §4):
 *
 * - one generation = a fresh SDK `Client` + one transport (built through an
 *   async factory so env/headers resolve per attempt);
 * - crash/close → bounded exponential backoff (500 ms doubling, cap 30 s),
 *   `maxAttempts` (10) consecutive failures per outage, uptime ≥ `maxDelayMs`
 *   resets the budget; exhaustion unregisters (commits an EMPTY defs map via
 *   `onDefsChanged`) and stops until reload;
 * - a failed generation must close within 5 s before the supervisor retries
 *   (no overlapping children);
 * - `notifications/tools/list_changed` enqueues a serialized re-sync; all
 *   syncs run on one chain so commits can never interleave;
 * - fetch-phase failures keep the previous generation committed.
 *
 * Registration happens NOWHERE here: the committed `defs` map is the master
 * state; {@link ./agents.ts} registers those defs into live agent scopes.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { fetchToolDefinitions, DEFAULT_TOOL_CALL_TIMEOUT_MS } from './tools.js'
import type { ToolDefinitions } from './tools.js'

// Package identity the MCP client announces (kept in sync with package.json).
const pkgIdentity = createRequire(import.meta.url)('../package.json') as { name: string; version: string }

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the schema and {@link resolveReconnectPolicy} (official). */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** Fully resolved reconnect policy captured at supervisor start. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Every default and bound is re-judged here so programmatic
 * construction cannot bypass validation (official discipline).
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Logger surface the supervisor needs (ctx.logger-compatible). */
export interface SupervisorLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The empty committed defs map shared by give-up/unregister states. */
export const EMPTY_DEFS: ToolDefinitions = Object.freeze(new Map()) as ToolDefinitions

/** Minimal deferred (repo lib target ES2023 lacks Promise.withResolvers). */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * Commit notification: called with the new master defs after every committed
 * swap (initial sync, notification re-sync, reconnect re-sync) and with an
 * empty map when the server is unregistered after budget exhaustion.
 * `syncId` is the supervisor's real-commit counter: it advances only when a
 * tool listing succeeded, so an unregister push reuses the previous value
 * (IMPL-4).
 */
export type DefsChangedListener = (
  serverName: string,
  syncId: number,
  defs: ReadonlyMap<string, ToolDefinition>,
) => void

/** Read-only master state view for one supervised server. */
export interface ServerState {
  /** The server's stable identity. */
  readonly serverName: string
  /** Current committed definitions (empty while down/never-synced/given-up). */
  readonly defs: ReadonlyMap<string, ToolDefinition>
  /** Number of committed real tool-generation swaps so far (0 = never synced). */
  readonly generation: number
  /**
   * Monotonic counter of committed real tool-generation swaps; give-up
   * unregister commits push an empty map WITHOUT advancing it (they are not
   * listings — IMPL-4).
   */
  readonly syncId: number
  /** Whether a live connected generation currently exists. */
  readonly connected: boolean
}

/** Handle for one supervised server. */
export interface ServerHandle {
  readonly serverName: string
  /** Live view of the master state (fields read through getters). */
  readonly state: ServerState
  /**
   * Settles when the first connection attempt completes (success or failure);
   * the supervisor enters its reconnect loop regardless.
   */
  readonly ready: Promise<void>
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued syncs to quiesce. Committed defs stay readable; the OWNER
   * (manager) decides when to push a revocation to live agents.
   */
  dispose(): Promise<void>
}

/** Supervisor construction options. */
export interface SupervisorOptions {
  /** Resolved server definition (transport selects the transport builder). */
  serverName: string
  /** Build ONE fresh transport for a connect attempt (resolver runs per attempt). */
  buildTransport: () => Promise<Transport>
  /** Logger sink; messages carry the `mcp-scope(<serverName>):` prefix. */
  logger: SupervisorLogger
  /** Called after every committed defs swap (see {@link DefsChangedListener}). */
  onDefsChanged: DefsChangedListener
  /** Reconnect policy; omission uses the official defaults. */
  reconnect?: ReconnectConfig
  /** Per-tool-call timeout for executor requests (official default 60 s). */
  toolCallTimeoutMs?: number
}

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy. Returns immediately (never blocks activation); the
 * first attempt runs asynchronously and its outcome settles `ready`.
 */
export function startServerSupervisor(options: SupervisorOptions): ServerHandle {
  const { serverName } = options
  const policy = resolveReconnectPolicy(options.reconnect, `mcp-scope(${serverName}): reconnect`)
  const label = `mcp-scope(${serverName})`
/** Log-safe error text: control characters stripped, capped. Remote-reflected
 * payloads (e.g. an HTTP error body echoing a credential value) must never
 * reach the log verbatim. */
const fmtError = (error: unknown): string =>
  String(error).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 300)
  const log = options.logger
  const toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS

  let disposed = false
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /** Close signal paired with {@link client}; captured by dispose before current ownership is cleared. */
  let clientClosed: Promise<void> | undefined
  /** Committed master definitions (never mutated after commit). */
  let master: ReadonlyMap<string, ToolDefinition> = EMPTY_DEFS
  let generation = 0
  let syncId = 0
  let connected = false
  let reconnectTimer: NodeJS.Timeout | undefined
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  /** The real error from the first connection attempt, for startup diagnostics. */
  let firstAttemptError: unknown

  /** A generation may act only while it is the current one on a live supervisor. */
  const isCurrent = (generationClient: Client): boolean => !disposed && client === generationClient

  /**
   * Commit a real tool-generation swap: a listing succeeded for this
   * generation, so the "synced N tools" info line and both counters are
   * warranted.
   */
  function commit(next: ReadonlyMap<string, ToolDefinition>): void {
    master = next
    generation += 1
    syncId += 1
    log.info(`${label}: synced ${next.size} tool${next.size === 1 ? '' : 's'} (generation ${generation})`)
    options.onDefsChanged(serverName, syncId, master)
  }

  /**
   * Unregister after reconnect-budget exhaustion: push an empty defs map to
   * the manager (so live agents revoke) WITHOUT reporting a sync or
   * advancing generation/syncId — no listing ever succeeded for this commit,
   * so it must not read as one (IMPL-4). The give-up error line is the only
   * line this path emits.
   */
  function unregister(): void {
    master = EMPTY_DEFS
    options.onDefsChanged(serverName, syncId, master)
  }

  /**
   * Serializes every fetch-and-commit — initial syncs and notification
   * re-syncs across all generations — so two commits can never interleave
   * (which would double-notify one generation and leak another).
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generationClient: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generationClient)) return
      // Phase 1: fetch the full next generation WITHOUT touching master state.
      const next = await fetchToolDefinitions(generationClient, { serverName, toolCallTimeoutMs })
      if (!isCurrent(generationClient)) return
      // Phase 2: commit swap.
      commit(Object.freeze(next) as ReadonlyMap<string, ToolDefinition>)
    })
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generationClient: Client): void {
    if (!isCurrent(generationClient)) return
    client = undefined
    clientClosed = undefined
    connected = false
    scheduleReconnect()
  }

  /** Wait for the transport-owned close signal without letting a broken transport wedge teardown forever. */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      log.error(`${label}: ${message}`)
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // Enqueue the give-up commit so it cannot race an in-flight sync's
      // phase-2 commit (which checks isCurrent inside the queue).
      syncChain = syncChain.then(() => {
        if (disposed) return
        log.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
        unregister()
      })
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    log.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration()
    }, delayMs)
    // An armed reconnect timer must never hold the process open on its own.
    reconnectTimer.unref()
  }

  /**
   * One connection attempt: fresh transport (credential resolution runs here,
   * per attempt, never cached) + client, connect, then queue the initial tool
   * sync. Every failure funnels through {@link generationDown}; success arms
   * the onclose-driven disconnect path. Never rejects.
   */
  async function connectGeneration(): Promise<void> {
    const generationClient = new Client(
      { name: pkgIdentity.name, version: pkgIdentity.version },
      { capabilities: {} },
    )
    const closed = deferred<void>()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generationClient
    clientClosed = closed.promise
    generationClient.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generationClient)
    }
    // Registered before connect so a list change during the initial sync is
    // queued behind it rather than dropped.
    generationClient.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generationClient)) return
        log.info(`${label}: tool list changed, re-syncing`)
        try {
          await enqueueSync(generationClient)
        } catch (error) {
          // Fetch-phase failure: the previous generation is still committed
          // — keep serving the last good list.
          if (!disposed) log.error(`${label}: tool re-sync failed: ${fmtError(error)}`)
        }
      },
    )
    try {
      const transport = await options.buildTransport()
      await generationClient.connect(transport)
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generationClient)
        return
      }
      await enqueueSync(generationClient)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure.
      if (isCurrent(generationClient)) log.warn(`${label}: connection attempt failed: ${fmtError(error)}`)
      try { await generationClient.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed.promise)
      attemptSettled = true
      if (!isCurrent(generationClient)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        log.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
        return
      }
      generationDown(generationClient)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generationClient)
      return
    }
    if (!isCurrent(generationClient)) return
    connected = true
    connectedAt = Date.now()
    if (failedAttempts > 0) log.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** The in-flight (or last settled) connection attempt; dispose awaits it for quiescence. */
  let settling = connectGeneration()

  const ready: Promise<void> = settling.then(() => {
    if (connected) return
    /* v8 ignore next -- defensive: firstAttemptError is always set when connect/sync fails */
    const error = firstAttemptError ?? new Error(`${label}: initial connection failed`)
    log.warn(`${label}: initial connection or tool synchronization failed: ${fmtError(error)}`)
  })

  const state: ServerState = {
    get serverName() { return serverName },
    get defs() { return master },
    get generation() { return generation },
    get syncId() { return syncId },
    get connected() { return connected },
  }

  return {
    serverName,
    state,
    ready,
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      connected = false
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          log.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `master` final.
      await settling
      await syncChain
    },
  }
}
