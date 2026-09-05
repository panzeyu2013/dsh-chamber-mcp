/**
 * The `mcp-scope` settings-namespace document schema (host half).
 *
 * Kept out of src/index.ts so the entry exports stay exactly
 * `name`/`inject`/`Config`/`apply` while tests (and the settings spec) can
 * register the very schema the entry registers. Schemastery mirrors the
 * official `dsh-mcp-client` Config vocabulary: serverName contract
 * `[A-Za-z0-9_-]{1,32}`, credential-ref contract `[A-Za-z_][A-Za-z0-9_]*`,
 * and official defaults for args/cwd/envKeys/headers.
 *
 * The schema cannot express cross-field constraints (duplicate serverNames,
 * duplicate env keys/header names) — those are enforced by the document
 * validate hook (src/shared/model.ts `validateDoc`).
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import {
  CREDENTIAL_REF_PATTERN,
  SERVER_NAME_PATTERN,
  type McpScopeDoc,
  type ServerDef,
} from './shared/model.js'

/** One credential-ref row of an HTTP header. */
export const HeaderSchema = z.object({
  name: z.string().required(),
  ref: z.string().required().pattern(CREDENTIAL_REF_PATTERN),
})

/** One stdio or streamable-http server definition. */
export const ServerSchema: z<ServerDef> = z.union([
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('stdio'),
    command: z.string().required(),
    args: z.array(String).default([]),
    cwd: z.string().default(''),
    envKeys: z.array(String).default([]),
  }),
  z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    transport: z.const('streamable-http'),
    url: z.string().required(),
    headers: z.array(HeaderSchema).default([]),
  }),
]) as unknown as z<ServerDef>

/**
 * The settings namespace document schema: `servers` (stable identity =
 * serverName) plus `overrides` — dict-of-dicts of `true`, presence meaning an
 * explicit per-workspace OFF switch (default on).
 */
export const DocumentSchema: z<McpScopeDoc> = z.object({
  servers: z.array(ServerSchema).default([]),
  overrides: z.dict(z.dict(z.const(true))).default({}),
}) as unknown as z<McpScopeDoc>
