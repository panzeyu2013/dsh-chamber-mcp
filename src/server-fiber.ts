/**
 * Per-definition server seat (host half): ONE child fiber per configured server
 * definition that owns the isolated capture façades, the private upstream
 * `McpClientHost` and (through the host) every mounted instance.
 *
 * Why a seat and not one fiber per connection attempt (ADR-1/D1):
 * - the official instance registers its tools/sections/resources through the
 *   services of ITS context; isolating the five labels
 *   (`tools`/`systemPrompt`/`mcpResources`/`credentials`/`mcpClientHost`) and
 *   providing capture façades there is what makes every registration observable
 *   without ever reaching a real global layer;
 * - the host must be created under the SAME credentials isolate as the
 *   façades (S4: an OAuth owner resolves templates through the host's owner
 *   context, and the credentials façade is the single CR/LF/NUL authority);
 * - one host per definition lets `mount`/`probe`/`authorization` share ONE
 *   resolved config and survive an instance stop (manual stop, disable,
 *   remount, explicit authorization on a stopped server).
 *
 * Sequencing (measured in W1 exp-e): the seat plugin's `apply` builds the
 * isolation + façades + host and RETURNS. Mounting happens only after the fiber
 * is ACTIVE (`await fiber`), because a service of a still-loading provider is
 * not resolvable and awaiting `instance.ready` inside `apply` would deadlock
 * activation. The manager awaits the seat, mounts the instance, then observes
 * `instance.ready`.
 *
 * Nothing here fans out to agents: captures are handed to `onCaptureChanged`
 * (the manager coalesces and calls the applier), and scoped registration verbs
 * delegate admission to the applier through the hooks.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { SystemPrompt as SystemPromptService } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  Config,
  McpOAuthAuthorization,
  McpOAuthConfig,
  McpProbeOptions,
  McpProbeResult,
  McpServerInstance,
  StreamableHttpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import {
  createFacades,
  type CaptureSnapshot,
  type FacadeHooks,
  type FacadeSet,
} from './facade.js'
import {
  disposeServerInstance,
  mountServerInstance,
  type McpClientHostLike,
  type UpstreamMcpClient,
} from './upstream.js'
import { sanitizeLogText, type HostLogger } from './log.js'
// Side-effect type imports: ctx.fiber / ctx.systemPrompt declaration merges.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Facade hooks owned by the manager/applier (agent routing + admission). */
export interface SeatHooks {
  /** Resolve a live Agent from the calling scope key; undefined when stale. */
  agentOf(scope: ScopeKey): Agent | undefined
  /** Applier admission for one on-demand loaded definition. */
  admit(agent: Agent, definition: ToolDefinition): () => void
  /** Applier visibility predicate for the on-demand catalog. */
  isApplied(agent: Agent, serverName: string): boolean
  /** Capture-cap override (tests); defaults to the façade's DEFAULT_MAX_SYNC_TOOLS. */
  maxSyncTools?: number
}

/** Construction deps of one seat (the manager supplies all of them). */
export interface SeatDeps {
  /** Manager (plugin) context; captured un-isolated for lazy real-service reads. */
  readonly ctx: Context
  /** The loaded official peer surface. */
  readonly upstream: UpstreamMcpClient
  /** The REAL credential provider, captured by constructor injection (S4). */
  readonly credentials: CredentialProvider
  /** Manager logger (host-side diagnostics only). */
  readonly logger: HostLogger
  /** Configured server name (stable seat identity). */
  readonly serverName: string
  /** Manager epoch of this seat generation (registry key + diagnostics). */
  readonly epoch: number
  /**
   * Manager capture sink: called synchronously after every capture change.
   *
   * @param peek - lazy full-snapshot getter (copy only when a publish needs it).
   * @param version - cheap capture version of this notification (the
   *   manager compares it with its published version BEFORE copying `peek()`;
   *   tests/fakes may omit it, in which case the manager falls back to the
   *   snapshot version).
   */
  onCaptureChanged(peek: () => CaptureSnapshot, version?: number): void
  /** Agent routing + admission hooks (the applier). */
  readonly hooks: SeatHooks
}

/** The lifecycle handle of one seat. */
export interface ServerSeat {
  readonly serverName: string
  /** The private upstream host reused by mount/probe/authorization. */
  readonly host: McpClientHostLike
  /** Mount one instance (only after the seat fiber is ACTIVE). */
  mount(config: Config): McpServerInstance
  /** Fresh capture snapshot of the current generation. */
  capture(): CaptureSnapshot
  /** Drop every capture (seat teardown / instance stop) without disposing the seat. */
  resetCapture(): void
  /** One explicit authorization owner on the seat host. */
  authorization(
    config: StreamableHttpConfig & { oauth: McpOAuthConfig },
    changed: () => void,
  ): McpOAuthAuthorization
  /** One-shot probe through the seat host (never touches the mounted instance). */
  probe(config: Config, options?: McpProbeOptions): Promise<McpProbeResult>
  /** Dispose the mounted instance and the seat fiber (all effects/host/façades). */
  disposeSeat(): Promise<void>
  /** Whether the seat fiber is still live. */
  readonly alive: boolean
}

/** Seat plugin config: everything the apply body needs (functions are fine — never loader-managed). */
interface SeatConfig {
  readonly deps: SeatDeps
}

/** Registry key of one seat generation. */
function seatKey(serverName: string, epoch: number): string {
  return serverName + '#' + epoch
}

/**
 * Module-local registry of live seats, keyed by `serverName#epoch`.
 *
 * The seat plugin's `apply` publishes its handles here; `createServerSeat`
 * reads them after `await fiber` (a handshake through the plugin config would
 * work too, but the registry keeps the config value-only and makes a missing
 * seat body a loud activation failure). Entries die with the fiber through a
 * fiber-owned effect.
 */
const SEATS = new Map<string, ServerSeat>()

/**
 * The seat plugin. Its `apply` is synchronous and side-effect only: isolate the
 * five service labels, install the capture façades, construct the one host, and
 * register the lifecycle handles. It NEVER mounts or awaits anything — mounting
 * happens after activation (see `createServerSeat`).
 */
const seatPlugin = {
  name: 'mcp-scope/server',
  inject: [] as string[],
  apply(ctx: Context, config: SeatConfig): void {
    const { deps } = config
    const key = seatKey(deps.serverName, deps.epoch)
    // A stale entry for the same key (retry/HMR) must never win.
    SEATS.delete(key)

    // Five fresh isolation labels: the official instance mounted below this
    // context resolves ONLY the façades, and the private host never collides with
    // a root mcpClientHost the official manager may provide.
    const iso = ctx
      .isolate('tools')
      .isolate('systemPrompt')
      .isolate('mcpResources')
      .isolate('mcpClientHost')
      .isolate('credentials')

    // The capture store bumps its version exactly once per sink notification, so
    // counting the notifications here yields the cheap version the manager
    // compares against its published version BEFORE copying a snapshot.
    let captureVersion = 0
    const hooks: FacadeHooks = {
      serverName: deps.serverName,
      // S4: the REAL provider, captured by constructor injection. Reading
      // this.ctx.get('credentials') inside the façade would resolve the façade
      // itself (recursion) and is forbidden.
      credentials: deps.credentials,
      onCaptureChanged: (peek) => {
        captureVersion += 1
        try {
          deps.onCaptureChanged(peek, captureVersion)
        } catch (error) {
          deps.logger.warn(
            'mcp-scope(' + deps.serverName + '): capture sink failed: ' + sanitizeLogText(error),
          )
        }
      },
      agentOf: (scope) => deps.hooks.agentOf(scope),
      admit: (agent, definition) => deps.hooks.admit(agent, definition),
      isApplied: (agent, serverName) => deps.hooks.isApplied(agent, serverName),
      getSectionOrder: (name) => {
        // Lazy real-service lookup on the UN-isolated manager context: a headless
        // composition mounts no system prompt and the façade falls back to a
        // finite order (FALLBACK_SECTION_ORDER).
        try {
          const prompt = deps.ctx.get('systemPrompt')
          if (prompt === undefined) return undefined
          const order = prompt.getSectionOrder(
            name as Parameters<SystemPromptService['getSectionOrder']>[0],
          )
          return typeof order === 'number' && Number.isFinite(order) ? order : undefined
        } catch (error) {
          deps.logger.warn(
            'mcp-scope(' + deps.serverName + '): prompt order lookup failed: ' + sanitizeLogText(error),
          )
          return undefined
        }
      },
      ...(deps.hooks.maxSyncTools === undefined ? {} : { maxSyncTools: deps.hooks.maxSyncTools }),
      warn: (message) => deps.logger.warn(message),
    }

    let facades: FacadeSet
    try {
      facades = createFacades(iso, hooks)
    } catch (error) {
      throw new Error(
        'mcp-scope(' + deps.serverName + '): the capture façades could not be installed',
        { cause: error },
      )
    }

    // The host MUST be constructed after the credentials façade and on the same
    // isolated context: its owner context is what OAuth template resolution and
    // mounted instances inherit (S4). ONE host per seat, reused by
    // mount/probe/authorization.
    let host: McpClientHostLike
    try {
      host = new deps.upstream.McpClientHost(iso)
    } catch (error) {
      throw new Error(
        'mcp-scope(' + deps.serverName + '): the private MCP client host could not be created',
        { cause: error },
      )
    }

    let instance: McpServerInstance | undefined
    let disposed = false

    const seat: ServerSeat = {
      serverName: deps.serverName,
      host,
      mount(config) {
        if (disposed) throw new Error('mcp-scope: the seat is disposed')
        const mounted = mountServerInstance(host, config)
        instance = mounted
        return mounted
      },
      capture: () => facades.snapshot(),
      resetCapture: () => facades.dispose(),
      authorization(config, changed) {
        return host.authorization(config, changed)
      },
      probe(config, options) {
        return host.probe(config, options)
      },
      async disposeSeat() {
        if (disposed) return
        disposed = true
        const current = instance
        instance = undefined
        const leftover = await disposeServerInstance(current)
        if (leftover !== undefined && (!leftover.closeConfirmed || leftover.cleanupError !== undefined)) {
          deps.logger.warn(
            'mcp-scope(' + deps.serverName + '): instance disposal during seat teardown was not confirmed',
          )
        }
        try {
          facades.dispose()
        } catch {
          // The capture store is state-only; its clear cannot fail meaningfully.
        }
        await ctx.fiber.dispose()
      },
      get alive() {
        return ctx.fiber.uid !== null && !disposed
      },
    }

    SEATS.set(key, seat)
    ctx.effect(() => () => {
      if (SEATS.get(key) === seat) SEATS.delete(key)
    }, 'mcp-scope: seat registry')
  },
}

/**
 * Create one seat: start the seat child fiber, wait until it is ACTIVE, then
 * hand the lifecycle handles back to the manager. Mounting is deliberately the
 * manager's next step (never inside the seat's apply).
 *
 * @param deps - manager-supplied deps (context, peer, real credentials, hooks).
 * @returns the live seat.
 * @throws when the peer/host/façades cannot be prepared (activation rejection);
 *   no half-built seat survives.
 */
export async function createServerSeat(deps: SeatDeps): Promise<ServerSeat> {
  const key = seatKey(deps.serverName, deps.epoch)
  const fiber = deps.ctx.plugin(seatPlugin, { deps })
  try {
    await fiber
  } catch (error) {
    SEATS.delete(key)
    throw error
  }
  const seat = SEATS.get(key)
  if (seat === undefined) {
    SEATS.delete(key)
    throw new Error(
      'mcp-scope(' + deps.serverName + '): the seat fiber activated without registering its lifecycle',
    )
  }
  return seat
}
