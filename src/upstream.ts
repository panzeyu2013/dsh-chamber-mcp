/**
 * Upstream MCP client host acquisition (host half).
 *
 * The plugin no longer owns a connection layer: every configured server is
 * mounted as an official `@deepseek-ai/dsh-mcp-client` instance through ONE
 * private `McpClientHost` per seat (see `server-fiber.ts`). This module owns
 * the only dynamic import of that peer package:
 *
 * - it is loaded lazily so a headless/partial composition still activates this
 *   plugin (per-server mounts degrade to a fixed `failed{load}` code instead of
 *   failing plugin activation);
 * - the namespace is read structurally (`McpClientHostLike`) so the seam is
 *   testable with a fake host and the wire never exposes upstream internals;
 * - a rejected load is NEVER cached: the next call retries, so installing the
 *   peer and reloading the Host recovers without a plugin restart.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Config,
  ConfigInput,
  McpCloseResult,
  McpOAuthAuthorization,
  McpOAuthConfig,
  McpProbeOptions,
  McpProbeResult,
  McpServerInstance,
  StreamableHttpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import { sanitizeLogText } from './log.js'
import type { ServerDef } from './shared/model.js'
import {
  extractTemplateRefs,
  templatedStringsOf,
  toUpstreamConfig,
  type HostValidate,
} from './host-config.js'

/** Package name of the peer that owns the connection layer. */
const UPSTREAM_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Fixed diagnostic of an unavailable peer (never forwarded to the wire). */
export const UPSTREAM_UNAVAILABLE_MESSAGE =
  'mcp-scope: the official MCP client host is unavailable (peer dependency ' + UPSTREAM_PACKAGE + ')'

/**
 * The four verbs of the official host this plugin uses. Structural on purpose:
 * the seat is testable with a fake host, and a renamed/missing verb fails the
 * mount loudly instead of silently disabling the seam.
 */
export interface McpClientHostLike {
  /** Resolve a server configuration (the ONE validation step per definition). */
  validate(input: ConfigInput, path: readonly string[]): Config
  /** Mount one server instance below the host's owner fiber. */
  mount(config: Config): McpServerInstance
  /** Probe a server without mounting it. */
  probe(config: Config, options?: McpProbeOptions): Promise<McpProbeResult>
  /** Create the explicit OAuth authorization owner of one server. */
  authorization(
    config: StreamableHttpConfig & { oauth: McpOAuthConfig },
    changed: () => void,
  ): McpOAuthAuthorization
}

/** The resolved peer package surface this plugin consumes. */
export interface UpstreamMcpClient {
  /** The host class; one instance is constructed per server seat. */
  readonly McpClientHost: new (ctx: Context) => McpClientHostLike
}

/** Fingerprint one canonical definition for change detection (remount/latch). */
export function fingerprintDefinition(server: ServerDef): string {
  return JSON.stringify(server)
}

/** Credential refs named by one definition's templated transport strings. */
export function credentialRefsInDefinition(server: ServerDef): ReadonlySet<string> {
  const refs = new Set<string>()
  for (const [value] of templatedStringsOf(server)) {
    for (const ref of extractTemplateRefs(value)) refs.add(ref)
  }
  return refs
}

/**
 * Resolve ONE definition into the official `Config` through the seat host's
 * single validation step (S6). The caller caches the returned object per
 * definition fingerprint and reuses the SAME instance for mount, probe and
 * authorization — a second `validate` reopens the binding bug the single
 * resolution rule closed.
 *
 * @param def - canonical settings-document row.
 * @param host - the seat's `McpClientHost.validate` verb.
 * @param options - optional legacy-translation diagnostic sink (ref names only).
 * @returns the resolved upstream configuration.
 * @throws {HostConfigError} with a fixed code (cause stays host-side).
 */
export function resolveDefinitionConfig(
  def: ServerDef,
  host: HostValidate,
  options: { warn?: (message: string) => void } = {},
): Config {
  const refs = credentialRefsInDefinition(def)
  return options.warn === undefined
    ? toUpstreamConfig(def, refs, { host })
    : toUpstreamConfig(def, refs, { host, warn: options.warn })
}

/**
 * Mount one official instance on the seat host.
 *
 * @param host - the seat's private host (constructed under the isolated
 *   credentials/facades context).
 * @param config - the resolved config (see {@link resolveDefinitionConfig}).
 * @returns the instance handle (`ready` + `dispose`).
 */
export function mountServerInstance(host: McpClientHostLike, config: Config): McpServerInstance {
  return host.mount(config)
}

/**
 * Dispose one mounted instance and report its cleanup result. TOTAL: a throwing
 * dispose folds into an unconfirmed result, so the manager's cleanup guard is
 * always fed a value instead of an exception.
 *
 * @param instance - the instance to stop (undefined is a no-op).
 * @returns the cleanup result, or undefined when there was no instance.
 */
export async function disposeServerInstance(
  instance: McpServerInstance | undefined,
): Promise<McpCloseResult | undefined> {
  if (instance === undefined) return undefined
  try {
    return await instance.dispose()
  } catch (error) {
    return { closeConfirmed: false, cleanupError: sanitizeLogText(error) }
  }
}

/** Memoized load. A rejection clears the slot so the next caller retries. */
let pending: Promise<UpstreamMcpClient> | undefined

/** Read the host class out of the dynamically imported namespace. */
function readUpstream(namespace: unknown): UpstreamMcpClient {
  const candidate = (namespace as { McpClientHost?: unknown } | null | undefined)?.McpClientHost
  if (typeof candidate !== 'function') {
    throw new Error(UPSTREAM_UNAVAILABLE_MESSAGE + ': the package does not export McpClientHost')
  }
  return { McpClientHost: candidate as UpstreamMcpClient['McpClientHost'] }
}

/**
 * Load the official MCP client host, once per successful load.
 *
 * @returns the host class surface, shared by every seat.
 * @throws a fixed diagnostic when the peer is missing or exports no host; the
 *   rejection is not cached.
 */
export function loadUpstreamMcpClient(): Promise<UpstreamMcpClient> {
  if (pending !== undefined) return pending
  pending = import(UPSTREAM_PACKAGE)
    .then(readUpstream)
    .catch((error: unknown) => {
      // Never cache a failed load: the next mount retries the import.
      pending = undefined
      throw new Error(UPSTREAM_UNAVAILABLE_MESSAGE, { cause: error })
    })
  return pending
}

/** Reset the memoized load (tests that swap the installed peer). */
export function resetUpstreamMcpClientCache(): void {
  pending = undefined
}
