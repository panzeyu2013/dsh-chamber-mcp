/**
 * The `mcp-scope` plugin Config — the settings document itself (host half).
 *
 * On dsh 0.1.7 each Loader entry's own exported `Config` IS its settings form:
 * there is no central namespace document anymore. This schema is therefore both
 * the document shape and the plugin's composition config, and every top-level
 * field carries `.volatile()`: `SettingsForms` projects volatile fields into
 * the editable form, and a form write commits the new values into the RUNNING
 * fiber's references in place (the loader emits `loader/volatile-update` on the
 * owning fiber) instead of restarting the plugin. The host half reads those
 * references per operation ({@link readDocument}).
 *
 * Schemastery mirrors the official `dsh-mcp-client` Config vocabulary:
 * serverName contract `[A-Za-z0-9_-]{1,32}`, credential-ref contract
 * `[A-Za-z_][A-Za-z0-9_]*`, and official defaults for args/cwd/envKeys/headers.
 *
 * The schema cannot express cross-field constraints (duplicate serverNames,
 * duplicate env keys/header names): the editor enforces those before a write
 * (`validateDoc` in src/shared/model.ts) and {@link readDocument} canonicalizes
 * what the schema shape still admits, so a hand-edited profile patch can never
 * make the manager throw.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import {
  CREDENTIAL_REF_PATTERN,
  HEADER_NAME_PATTERN,
  SERVER_NAME_PATTERN,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  canonicalDoc,
  type DisabledServers,
  type McpScopeDoc,
  type ServerDef,
  type WorkspaceOverrides,
} from './shared/model.js'

/** One credential-ref row of an HTTP header. */
const HeaderSchema = z.object({
  name: z.string().required().pattern(HEADER_NAME_PATTERN),
  ref: z.string().required().pattern(CREDENTIAL_REF_PATTERN),
})

/** One stdio or streamable-http server definition. */
const ServerSchema: z<ServerDef> = z.union([
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('stdio'),
    command: z.string().required(),
    args: z.array(String).default([]),
    cwd: z.string().default(''),
    envKeys: z.array(z.string().pattern(CREDENTIAL_REF_PATTERN)).default([]),
    timeoutMs: z.number().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS),
  }),
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('streamable-http'),
    url: z.string().required(),
    headers: z.array(HeaderSchema).default([]),
    timeoutMs: z.number().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS),
  }),
]) as unknown as z<ServerDef>

/**
 * One resolved Config field: a live `Volatile` reference on 0.1.7+, or the
 * plain value when a construction hands one in.
 */
export type ConfigField<T> = T | { readonly get: () => T }

/** The resolved plugin Config handed to `apply`: all three document fields live. */
export interface McpScopeConfig {
  readonly servers: ConfigField<readonly ServerDef[]>
  readonly overrides: ConfigField<WorkspaceOverrides>
  readonly disabled: ConfigField<DisabledServers>
}

/**
 * The plugin Config: the document itself, every field live-editable. A form
 * write touches only volatile paths, so the loader commits it into the running
 * fiber in place and `apply` never sees a remount for a settings change.
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
 * Read a resolved Config into the canonical document ({@link canonicalDoc}):
 * non-object server rows and duplicate serverNames are resolved, enable rows
 * and disabled keys are pruned to their own `true` entries.
 */
export function readDocument(config: McpScopeConfig): McpScopeDoc {
  return canonicalDoc({
    servers: fieldValue(config.servers),
    overrides: fieldValue(config.overrides),
    disabled: fieldValue(config.disabled),
  })
}
