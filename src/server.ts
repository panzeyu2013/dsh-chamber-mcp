/**
 * Per-server supervisor (host half): owns the MCP client/transport
 * generations for ONE configured server and keeps the server's master
 * definition state in sync with the live generation — mirroring the official
 * `dsh-mcp-client` connection supervisor exactly:
 *
 * - one generation = a fresh SDK `Client` + one transport (built through an
 *   async factory so env/headers resolve per attempt);
 * - crash/close → bounded exponential backoff (500 ms doubling, cap 30 s),
 *   `maxAttempts` (10) consecutive failures per outage, uptime ≥ `maxDelayMs`
 *   resets the budget; exhaustion unregisters (commits an EMPTY defs map via
 *   `onDefsChanged`) and stops until reload;
 * - a failed generation must close within 5 s before the supervisor retries
 *   (no overlapping children);
 * - a 2.0 client generation: `versionNegotiation: { mode: 'auto' }` (probe the
 *   modern revision, fall back to the plain 2025 handshake) and a
 *   connection-owned `listChanged.tools` hook that enqueues a serialized
 *   re-sync; all syncs run on one chain so commits can never interleave;
 * - server `instructions` are captured once per established generation, bounded
 *   by {@link MAX_INSTRUCTION_BYTES}, and published through
 *   {@link ServerContext.instructions} (never registered here);
 * - {@link ServerContext.resources} runs `resources/*` through the CURRENT
 *   connection generation, or fails fast when the server is down;
 * - fetch-phase failures keep the previous generation committed.
 *
 * Registration happens NOWHERE here: the committed `defs` map is the master
 * state; {@link ./agents.ts} registers those defs into live agent scopes.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { McpResourceRequest } from '@deepseek-ai/dsh-mcp-resources'
import { fetchToolDefinitions, DEFAULT_TOOL_CALL_TIMEOUT_MS } from './tools.js'
import type { ToolDefinitions } from './tools.js'
import type { ServerContext } from './server-context.js'

// Re-exported for the supervisor's consumers and tests; the definition lives
// with the module that publishes it.
export type { ServerContext } from './server-context.js'

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

/**
 * Connection phase of one supervised server, as reported to the runtime-status
 * surface (wire vocabulary; additive, never a closed world).
 */
export type ServerConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped'

/**
 * Hard cap on one server's published instruction text, measured over the
 * COMPLETE attributed value (header line included). An oversized block fails
 * that connection attempt instead of injecting an unbounded prompt section.
 */
export const MAX_INSTRUCTION_BYTES = 32_768

/** One server's runtime status snapshot (no credential material). */
export interface ServerSnapshot {
  phase: ServerConnectionPhase
  /** Consecutive failed attempts in the current outage. */
  attempts: number
  /** Budget of the fixed official reconnect policy. */
  maxAttempts: number
  /** When the armed reconnect timer fires (phase 'reconnecting'). */
  nextRetryAt?: number
  /** When the current generation finished connect + initial sync. */
  connectedAt?: number
  /** When the last tool listing committed. */
  syncedAt?: number
  /** Committed tool count (0 while down / never synced). */
  toolCount: number
  /** Sanitized text of the latest connection/sync failure. */
  error?: string
}

/** Identity + copy line of one synced tool (runtime tool list, capped by the caller). */
export interface ToolSummary {
  publicName: string
  rawName: string
  description: string
}

/** Log-safe error text: control characters stripped, capped. Remote-reflected
 * payloads (e.g. an HTTP error body echoing a credential value) must never
 * reach the log verbatim. */
export function safeErrorText(error: unknown): string {
  // The 2.0 client keeps the HTTP status of a failed POST on `data.status`
  // (the message is only "Error POSTing to endpoint: <body>"), so carry it into
  // the sanitized text — otherwise a 401/403 with a neutral body classifies as
  // a generic connection failure instead of 'forbidden'.
  const status = (error as { data?: { status?: unknown }; status?: unknown } | null | undefined)
  const httpStatus = typeof status?.data?.status === 'number' ? status.data.status
    : typeof status?.status === 'number' ? status.status
      : undefined
  const suffix = httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`
  return `${String(error).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 300)}${suffix}`
}

/**
 * The transport the client actually attached to, or undefined for an attempt
 * that never bound one (a spawn failure, or a probe that never attached).
 * `Protocol` declares `get transport(): Transport | undefined`, so this is the
 * SDK's own attach signal — the official `dsh-mcp-client` supervisor reads the
 * same field to decide whether a close event is owed before a retry may start.
 */
function attachedTransport(client: Client): Transport | undefined {
  return client.transport
}

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
  /** Connection-owned prompt/resource context for this server's consumers. */
  readonly context: ServerContext
  /** Runtime status snapshot for the settings surface. */
  snapshot(): ServerSnapshot
  /** Identity + description of every tool in the committed generation. */
  tools(): readonly ToolSummary[]
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued syncs to quiesce. Committed defs stay readable; the OWNER
   * (manager) decides when to push a revocation to live agents.
   */
  dispose(): Promise<void>
}

/** One-shot probe result (manual "Test connection"). */
export interface ProbeResult {
  ok: boolean
  toolCount?: number
  /** Stable failure code when the probe failed (never remote text). */
  code?: string
  /** Host-generated message of {@link ProbeResult.code}. */
  error?: string
}

/**
 * Probe one server definition with a throwaway client: connect, list tools,
 * close. Never touches the supervised generation and never registers
 * anything; the caller owns rate/concurrency discipline.
 */
export async function probeServer(options: {
  /** Plugin context the official tool adapter resolves attachments/llm from. */
  ctx: Context
  serverName: string
  buildTransport: () => Promise<Transport>
  toolCallTimeoutMs?: number
}): Promise<ProbeResult> {
  const client = new Client(
    { name: pkgIdentity.name, version: pkgIdentity.version },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  const toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  try {
    const transport = await options.buildTransport()
    // The probe must not hang either: bound the handshake with the same
    // per-server timeout the supervised attempt passes to `connect` (the SDK
    // would otherwise stall on its silent 60 s DEFAULT_REQUEST_TIMEOUT_MSEC).
    await client.connect(transport, { timeout: toolCallTimeoutMs })
    const defs = await fetchToolDefinitions(options.ctx, client, { serverName: options.serverName, toolCallTimeoutMs })
    return { ok: true, toolCount: defs.size }
  } catch (error) {
    return { ok: false, error: safeErrorText(error) }
  } finally {
    try { await client.close() } catch { /* transport already gone */ }
  }
}

/** Supervisor construction options. */
export interface SupervisorOptions {
  /** Plugin context the official tool adapter resolves attachments/llm from. */
  ctx: Context
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
  const { serverName, ctx } = options
  const policy = resolveReconnectPolicy(options.reconnect, `mcp-scope(${serverName}): reconnect`)
  const label = `mcp-scope(${serverName})`
  const fmtError = safeErrorText
  const log = options.logger
  const toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS

  let disposed = false
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /**
   * Attach-aware closer for {@link client}: true when closure is confirmed.
   * Captured by dispose before current ownership is cleared.
   */
  let clientCloser: (() => Promise<boolean>) | undefined
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
  /** Latest sanitized failure text exposed through the runtime snapshot. */
  let lastError: string | undefined
  /** When the last listing committed (undefined = never). */
  let syncedAt: number | undefined
  /** When the armed reconnect timer fires (undefined while connected/connecting). */
  let nextRetryAt: number | undefined
  /** True after the reconnect budget is exhausted or reconnect is disabled. */
  let gaveUp = false
  /** Tool identity/copy of the committed generation. */
  let toolSummaries: readonly ToolSummary[] = []
  /** Published instructions of the last established generation ('' while none). */
  let serverInstructions = ''

  /** A generation may act only while it is the current one on a live supervisor. */
  const isCurrent = (generationClient: Client): boolean => !disposed && client === generationClient

  /**
   * Commit a real tool-generation swap: a listing succeeded for this
   * generation, so the "synced N tools" info line and both counters are
   * warranted.
   */
  function commit(next: ReadonlyMap<string, ToolDefinition>, listed?: readonly ToolSummary[]): void {
    master = next
    toolSummaries = listed ?? []
    syncedAt = Date.now()
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
    toolSummaries = []
    // The published instructions belong to a LIVE generation: retracting the
    // tools without retracting them would keep telling the model to use
    // `mcp__<server>__*` names that no longer exist (official discipline —
    // upstream clears the same field on budget exhaustion).
    serverInstructions = ''
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
      const listed: ToolSummary[] = []
      const next = await fetchToolDefinitions(
        ctx,
        generationClient,
        { serverName, toolCallTimeoutMs, log: (message) => log.info(message) },
        (info) => {
          listed.push({ publicName: info.publicName, rawName: info.rawName, description: info.description })
        },
      )
      if (!isCurrent(generationClient)) return
      // Phase 2: commit swap (the listed identity commits atomically with the
      // definitions, so a failed sync can never publish half a list).
      commit(Object.freeze(next) as ReadonlyMap<string, ToolDefinition>, listed)
    })
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /**
   * Notification-driven re-sync, wired as the 2.0 `listChanged.tools` hook and
   * serialized on the same chain as every other sync. A fetch-phase failure
   * keeps the previous committed generation serving.
   */
  async function refreshTools(generationClient: Client): Promise<void> {
    if (!isCurrent(generationClient)) return
    log.info(`${label}: tool list changed, re-syncing`)
    try {
      await enqueueSync(generationClient)
    } catch (error) {
      // Fetch-phase failure: the previous generation is still committed
      // — keep serving the last good list.
      if (!disposed) log.error(`${label}: tool re-sync failed: ${fmtError(error)}`)
    }
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generationClient: Client): void {
    if (!isCurrent(generationClient)) return
    client = undefined
    clientCloser = undefined
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
      gaveUp = true
      lastError = message
      log.error(`${label}: ${message}`)
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      gaveUp = true
      // Enqueue the give-up commit so it cannot race an in-flight sync's
      // phase-2 commit (which checks isCurrent inside the queue).
      syncChain = syncChain.then(() => {
        if (disposed) return
        lastError = `giving up after ${policy.maxAttempts} consecutive failed reconnect attempts`
        log.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
        unregister()
      }).catch((error) => {
        // `unregister` pushes through the caller's applier path; a throw there
        // must not become an UNHANDLED rejection (Node would take the whole
        // Host down). The committed state is already empty, so report and stay
        // consistent. Every other chain tail in this module is caught too.
        log.error(`${label}: unregister push after giving up failed: ${fmtError(error)}`)
      })
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    log.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    nextRetryAt = Date.now() + delayMs
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      nextRetryAt = undefined
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
      {
        capabilities: {},
        // 2.0 era negotiation: probe for the modern revision and fall back to
        // the plain 2025 handshake when the server only speaks legacy.
        versionNegotiation: { mode: 'auto' },
        // Tool-list invalidation is connection-owned: the SDK registers the
        // handler at the end of the handshake (before the caller's first
        // listing), so a post-connect change is queued behind the sync chain
        // and a change on a superseded generation is ignored.
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => { void refreshTools(generationClient) },
          },
        },
      },
    )
    gaveUp = false
    // `lastError` is deliberately NOT cleared at the top of an attempt. The
    // card renders `snapshot().error`, so clearing it here erased the failure
    // reason for the whole outage and left a bare "connecting…" while the
    // supervisor retried (with the SDK's silent 60 s handshake timeout, that is
    // minutes). A fresh attempt legitimately re-arms the loop (`gaveUp`), but
    // the reason is retired only once a generation is actually established —
    // see the `connected = true` path below.
    const closed = deferred<void>()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generationClient
    clientCloser = closeGeneration
    generationClient.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generationClient)
    }
    /**
     * Close this attempt's client/transport and report whether closure is
     * confirmed (official attach discipline). An UNATTACHED attempt — the
     * client never bound the transport, as in a spawn failure or a probe that
     * never attached — is closed through the transport itself and owes NO
     * client close event; demanding one burned the whole barrier and
     * permanently stopped reconnection after a plain "command not found". An
     * attached generation additionally waits for the close event (the stdio
     * transport's own termination grace can take ~2 s before it lands).
     */
    async function closeGeneration(): Promise<boolean> {
      const attached = attachedTransport(generationClient) !== undefined
      try {
        await (attached ? generationClient.close() : transport?.close())
      } catch {
        if (!attached) return hasClosed()
      }
      return !attached || hasClosed() || await waitForClose(closed.promise)
    }
    // Captured inside the attempt and published only once connect AND the
    // initial discovery both succeeded (see the success path below).
    let instructions: string
    let transport: Transport | undefined
    try {
      transport = await options.buildTransport()
      // Bound the MCP handshake with the operator's per-server timeout: a
      // server that spawns/accepts HTTP but never answers would otherwise hang
      // on the SDK's silent DEFAULT_REQUEST_TIMEOUT_MSEC (60 s) for every
      // attempt of the reconnect budget. The 2.0 client inherits this bound for
      // its `mode: 'auto'` era probe too, and both failures surface as a
      // timed-out SdkError — the manager's errorCodeOf maps that to the
      // localized 'timeout' copy.
      await generationClient.connect(transport, { timeout: toolCallTimeoutMs })
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generationClient)
        return
      }
      // Attributed instruction block, bounded over the COMPLETE value (header
      // line included): an oversized block fails THIS attempt instead of
      // injecting an unbounded prompt section.
      const serverText = generationClient.getInstructions()?.trimEnd() ?? ''
      instructions = serverText ? `### MCP server: ${serverName}\n\n${serverText}` : ''
      if (Buffer.byteLength(instructions) > MAX_INSTRUCTION_BYTES) {
        throw new Error(`${label}: server instructions exceed MAX_INSTRUCTION_BYTES (${MAX_INSTRUCTION_BYTES})`)
      }
      await enqueueSync(generationClient)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure.
      if (isCurrent(generationClient)) {
        lastError = fmtError(error)
        log.warn(`${label}: connection attempt failed: ${fmtError(error)}`)
      }
      const quiesced = await closeGeneration()
      attemptSettled = true
      if (!isCurrent(generationClient)) return
      if (!quiesced) {
        client = undefined
        clientCloser = undefined
        // Giving up here bypasses unregister(): retire the published
        // instructions too, or the prompt keeps advertising dead tool names.
        serverInstructions = ''
        // No timer is armed (an overlapping retry would be worse), so without
        // this the snapshot would report 'connecting' forever.
        gaveUp = true
        lastError = `failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms`
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
    if (!isCurrent(generationClient)) {
      // Disposal won the race while this attempt was connecting, so nobody else
      // owns the generation any more: close it here or a live child process is
      // orphaned (official discipline).
      if (!await closeGeneration()) {
        log.error(`${label}: generation superseded during connect did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — a server process may still be running`)
      }
      return
    }
    // Publication rule: instructions belong to an ESTABLISHED generation
    // (connect + initial discovery both committed). A failed attempt leaves the
    // previous value in place; disposal clears it.
    serverInstructions = instructions
    connected = true
    connectedAt = Date.now()
    // The generation is established (connect + initial sync committed): only
    // now is the retained failure text retired, so a healthy snapshot can never
    // carry a stale error while the reason stays visible for the whole outage
    // that preceded it.
    lastError = undefined
    // The budget is deliberately NOT reset here: a connect that immediately
    // crashes must still count against `maxAttempts`. Upstream mcp-client pins
    // this exact case ("a crash loop with briefly successful connects still
    // exhausts the cap", reconnect.spec.ts) — only a connection that stayed up
    // past the stability window ends the outage, and `scheduleReconnect` is the
    // single place that resets the counter. The WIRE view still reads 0 while
    // connected (see `snapshot`), so a healthy card never shows a stale count.
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

  const snapshot = (): ServerSnapshot => {
    const base = {
      // The wire counter describes the CURRENT outage: 0 while connected, the
      // live accrued count while down (the budget itself is never reset by a
      // successful connect — see connectGeneration).
      attempts: connected ? 0 : failedAttempts,
      maxAttempts: policy.maxAttempts,
      toolCount: master.size,
      ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
      ...(connectedAt !== undefined ? { connectedAt } : {}),
      ...(syncedAt !== undefined ? { syncedAt } : {}),
      ...(lastError !== undefined ? { error: lastError } : {}),
    }
    if (disposed) return { phase: 'stopped', ...base }
    if (connected) return { phase: 'connected', ...base }
    if (gaveUp) return { phase: 'failed', ...base }
    if (reconnectTimer !== undefined) return { phase: 'reconnecting', ...base }
    return { phase: 'connecting', ...base }
  }

  return {
    serverName,
    state,
    ready,
    context: {
      instructions: () => serverInstructions,
      resources: {
        // Resolve the live generation BEFORE any network operation: a
        // configured-but-down server fails the call instead of hanging.
        async request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue> {
          const generation = client
          if (generation === undefined || !connected) throw new Error(`${label}: server is disconnected`)
          const callOptions = { signal: exec.signal, timeout: toolCallTimeoutMs }
          switch (request.method) {
            case 'resources/list':
              return await generation.listResources(
                request.cursor === undefined ? undefined : { cursor: request.cursor },
                callOptions,
              ) as JsonValue
            case 'resources/templates/list':
              return await generation.listResourceTemplates(
                request.cursor === undefined ? undefined : { cursor: request.cursor },
                callOptions,
              ) as JsonValue
            case 'resources/read':
              return await generation.readResource({ uri: request.uri }, callOptions) as JsonValue
            default:
              // The operation union is closed; this only fires for an
              // untyped caller, and returning `undefined` typed as JsonValue
              // would be a silent failure (official code asserts never).
              throw new Error(`${label}: unsupported resource operation`)
          }
        },
      },
    },
    snapshot,
    tools: () => toolSummaries,
    async dispose(): Promise<void> {
      disposed = true
      serverInstructions = ''
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      nextRetryAt = undefined
      const close = clientCloser
      client = undefined
      clientCloser = undefined
      connected = false
      if (close !== undefined && !await close()) {
        log.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `master` final.
      await settling
      await syncChain
    },
  }
}
