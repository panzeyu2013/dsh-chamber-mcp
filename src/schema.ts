/**
 * The mcp-scope plugin Config — the settings document itself (host half).
 *
 * On dsh 0.1.7 each Loader entry's own exported Config IS its settings form:
 * there is no central namespace document anymore. This schema is therefore both
 * the document shape and the plugin's composition config, and every top-level
 * field carries .volatile(): SettingsForms projects volatile fields into the
 * editable form, and a form write commits the new values into the RUNNING
 * fiber's references in place (the loader emits loader/volatile-update on the
 * owning fiber) instead of restarting the plugin. The host half reads those
 * references per operation (readDocument).
 *
 * Schemastery mirrors the upstream dsh-mcp-client Config vocabulary: serverName
 * contract [A-Za-z0-9_-]{1,32}, credential-ref contract [A-Za-z_][A-Za-z0-9_]*,
 * upstream-named knob fields and the official defaults for the legacy
 * args/cwd/envKeys/header-row containers.
 *
 * Two decode rules matter for the document model:
 * - every new knob field is declared WITHOUT a default: absent must stay absent
 *   so the adapter omits it and the mounted host applies its own default, and
 *   the editor can tell "default" from an explicit value;
 * - the deprecated legacy timeoutMs alias is declared here because the schema
 *   decode runs BEFORE canonicalDoc — canonicalDoc is what translates it, so an
 *   undeclared legacy field would be lost for settings.yaml/volatile imports.
 *
 * The schema cannot express cross-field constraints (duplicate serverNames,
 * duplicate env keys/header names, the template trap, reconnect/oauth
 * consistency): the editor enforces those before a write (validateDoc in
 * src/shared/model.ts) and readDocument canonicalizes what the schema shape
 * still admits, so a hand-edited profile patch can never make the manager throw.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  SERVER_NAME_PATTERN,
  canonicalDoc,
  type DisabledServers,
  type McpScopeDoc,
  type OAuthServerDef,
  type ReconnectConfig,
  type ServerDef,
  type WorkspaceOverrides,
} from './shared/model.js'

/** One credential-ref row of an HTTP header (legacy read-compat form). */
const HeaderSchema = z.object({
  name: z.string().required().pattern(HEADER_NAME_PATTERN),
  ref: z.string().required().pattern(CREDENTIAL_REF_PATTERN),
})

/**
 * Automatic reconnect policy. Unknown keys are deliberately NOT rejected here:
 * schemastery preserves them on the decoded value, so validateDoc can report
 * them (and the host.validate step remains the mount-time authority). No
 * default block is materialized — a server without reconnect keeps it absent.
 */
const ReconnectSchema: z<ReconnectConfig> = z.object({
  enabled: z.boolean(),
  initialDelayMs: z.number(),
  maxDelayMs: z.number(),
  maxAttempts: z.number(),
}) as z<ReconnectConfig>

/**
 * Explicit OAuth block (data model only; the editor does not expose it yet).
 * Declared so a legacy/official import carrying it survives decode; bounds and
 * the Authorization-header conflict are validated by validateDoc.
 */
const OAuthSchema: z<OAuthServerDef> = z.object({
  credentialKey: z.string(),
  clientId: z.string(),
  scope: z.string(),
  requestTimeoutMs: z.number(),
  authorizationTimeoutMs: z.number(),
}) as z<OAuthServerDef>

/** Shared knob fields of both transport schemas (no defaults, no bounds). */
const knobFields = {
  toolCallTimeoutMs: z.number(),
  startupTimeoutMs: z.number(),
  closeTimeoutMs: z.number(),
  reconnect: z.union([z.const(undefined), ReconnectSchema]),
  toolLoading: z.union(['eager', 'on-demand']),
  // Deprecated read-compat alias: canonicalDoc translates it to
  // toolCallTimeoutMs; declared here so the schema decode does not lose it.
  timeoutMs: z.number(),
}

/** One stdio or streamable-http server definition. */
const ServerSchema: z<ServerDef> = z.union([
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('stdio'),
    command: z.string().required(),
    args: z.array(String).default([]),
    cwd: z.string().default(''),
    envKeys: z.array(z.string().pattern(CREDENTIAL_REF_PATTERN)).default([]),
    // Upstream-named env map; a union with const(undefined) keeps an absent map
    // absent (a bare dict would materialize {} and shadow legacy envKeys).
    env: z.union([z.const(undefined), z.dict(String)]),
    ...knobFields,
  }),
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('streamable-http'),
    url: z.string().required(),
    // Legacy {name,ref} rows and the upstream header map are both accepted;
    // canonicalDoc/validateDoc normalize the shape.
    headers: z.union([z.array(HeaderSchema), z.dict(String)]).default([]),
    oauth: z.union([z.const(undefined), OAuthSchema]),
    ...knobFields,
  }),
]) as unknown as z<ServerDef>

/**
 * One resolved Config field: a live Volatile reference on 0.1.7+, or the
 * plain value when a construction hands one in.
 */
export type ConfigField<T> = T | { readonly get: () => T }

/** The resolved plugin Config handed to apply: all three document fields live. */
export interface McpScopeConfig {
  readonly servers: ConfigField<readonly ServerDef[]>
  readonly overrides: ConfigField<WorkspaceOverrides>
  readonly disabled: ConfigField<DisabledServers>
}

/**
 * The plugin Config: the document itself, every field live-editable. A form
 * write touches only volatile paths, so the loader commits it into the running
 * fiber in place and apply never sees a remount for a settings change.
 */
export const Config: z<McpScopeDoc, McpScopeConfig> = z.object({
  servers: z.array(ServerSchema).default([]).volatile(),
  overrides: z.dict(z.dict(z.const(true))).default({}).volatile(),
  disabled: z.dict(z.const(true)).default({}).volatile(),
}) as unknown as z<McpScopeDoc, McpScopeConfig>

/** Read one resolved Config field, tolerating a plain value. */
export function fieldValue<T>(field: ConfigField<T>): T {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get(): T }).get()
  }
  return field as T
}

/**
 * Read a resolved Config into the canonical document (canonicalDoc):
 * non-object server rows and duplicate serverNames are resolved, legacy
 * timeoutMs is translated, enable rows and disabled keys are pruned to their
 * own true entries.
 */
export function readDocument(config: McpScopeConfig): McpScopeDoc {
  return canonicalDoc({
    servers: fieldValue(config.servers),
    overrides: fieldValue(config.overrides),
    disabled: fieldValue(config.disabled),
  })
}
