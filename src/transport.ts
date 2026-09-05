/**
 * Transport factory (host half): builds the MCP transport for one server
 * definition, mirroring the official `@deepseek-ai/dsh-mcp-client` transport
 * module — with one deliberate difference: env values and HTTP header values
 * are not plain config strings but are RESOLVED from the credentials domain
 * per (re)connect attempt through an async resolver (missing refs are
 * omitted with a warning, empty values count as absent — the official
 * credential rule).
 *
 * Stdio children never inherit credential-shaped or `DSH_*` ambient env:
 * `buildChildEnv` = `{ ...scrubbedParentEnv(), ...explicitEnv }`, spawn is
 * `shell:false` via the SDK. Streamable HTTP carries resolved headers on
 * every request (`requestInit.headers`). Resolved values containing CR/LF/NUL
 * are rejected per key/header (warn names the ref only) so they can neither
 * reach `Headers`/env nor leak into error text in host logs (SEC-02).
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ServerDef } from './shared/model.js'

/** One resolved credential value (or undefined when the ref is unconfigured/empty). */
export type CredentialResolver = (ref: string) => Promise<{ value: string; source: string } | undefined>

/** Diagnostic sink for resolution warnings (logger.warn-compatible). */
export type WarnSink = (message: string) => void

/**
 * Credential values that can corrupt a child env or HTTP header set and echo
 * verbatim into host logs via Node/SDK error strings: CR/LF (header/env
 * injection + log-line forgery) and NUL (invalid env values). Values
 * containing any of these are rejected at the transport boundary (SEC-02).
 */
const INVALID_VALUE_PATTERN = /[\r\n\0]/

/** Whether a resolved credential value must not reach env/headers. */
function invalidCredentialValue(value: string): boolean {
  return INVALID_VALUE_PATTERN.test(value)
}

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
export function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Resolve the child environment for a stdio server definition: every
 * `envKeys` ref resolved once per attempt through `resolve`. A missing ref or
 * an empty resolved value omits the key (empty stored value counts absent —
 * official rule); the omission is reported through `warn` when supplied.
 * Never cached: callers resolve once per (re)connect attempt.
 */
export async function resolveServerEnv(
  server: ServerDef,
  resolve: CredentialResolver,
  warn?: WarnSink,
): Promise<Record<string, string>> {
  if (server.transport !== 'stdio') return {}
  const extra: Record<string, string> = {}
  for (const key of server.envKeys ?? []) {
    const credential = await resolve(key)
    if (credential === undefined || credential.value === '') {
      if (warn) warn(`mcp-scope(${server.serverName}): credential ref "${key}" is not configured — omitting env key`)
      continue
    }
    // Reject values that would corrupt the child env or leak into log text;
    // the warning names the key only, never the value.
    if (invalidCredentialValue(credential.value)) {
      if (warn) warn(`mcp-scope(${server.serverName}): credential ref "${key}" resolved to an invalid value (contains CR/LF/NUL) — omitting env key`)
      continue
    }
    extra[key] = credential.value
  }
  return extra
}

/**
 * Resolve the HTTP headers for a streamable-http server definition: every
 * `headers[].ref` resolved once per attempt through `resolve`. Missing or
 * empty refs omit the header row with a warning. Never cached.
 */
export async function resolveServerHeaders(
  server: ServerDef,
  resolve: CredentialResolver,
  warn?: WarnSink,
): Promise<Record<string, string>> {
  if (server.transport !== 'streamable-http') return {}
  const headers: Record<string, string> = {}
  for (const header of server.headers ?? []) {
    const credential = await resolve(header.ref)
    if (credential === undefined || credential.value === '') {
      if (warn) warn(`mcp-scope(${server.serverName}): credential ref "${header.ref}" is not configured — omitting header "${header.name}"`)
      continue
    }
    // Reject values that would throw inside `new Headers(...)` with the raw
    // value embedded in the error text (SEC-02); the warning names the ref
    // and header only, never the value.
    if (invalidCredentialValue(credential.value)) {
      if (warn) warn(`mcp-scope(${server.serverName}): credential ref "${header.ref}" resolved to an invalid value (contains CR/LF/NUL) — omitting header "${header.name}"`)
      continue
    }
    headers[header.name] = credential.value
  }
  return headers
}

/**
 * Resolve env/headers and create the MCP transport for one server definition.
 * Both credential sets are resolved here — once per (re)connect attempt —
 * so a fresh value reaches the next attempt without any caching.
 *
 * @param server - Resolved server definition (stdio or streamable-http).
 * @param resolve - Per-ref credential resolver.
 * @param warn - Diagnostic sink for omitted keys/headers.
 * @returns a transport ready for `client.connect`.
 */
export async function createTransport(
  server: ServerDef,
  resolve: CredentialResolver,
  warn?: WarnSink,
): Promise<Transport> {
  switch (server.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: buildChildEnv(await resolveServerEnv(server, resolve, warn)),
        cwd: server.cwd ?? '',
      })
    case 'streamable-http': {
      // The SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening (official pattern).
      return new StreamableHTTPClientTransport(
        new URL(server.url),
        { requestInit: { headers: await resolveServerHeaders(server, resolve, warn) } },
      ) as Transport
    }
  }
}
