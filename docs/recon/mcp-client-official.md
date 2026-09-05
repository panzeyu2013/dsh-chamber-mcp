# Recon: the official `@deepseek-ai/dsh-mcp-client` plugin

Evidence-based report for re-implementing a compatible third-party MCP client plugin
for the DeepSeek Harness (DSH). All quotes are real code; every claim cites a file path.

## 0. Sources, versions, and method

| Source | Location | Version |
|---|---|---|
| Readable source (ref, primary) | `~/projects/dsh-chamber/ref-dsh/packages/mcp/mcp-client/{src,tests}/` | `0.1.0-rc.5` (package.json) |
| Installed compiled pkg (secondary) | `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/dsh-mcp-client/lib/{index.js,types/*.d.ts}` | `0.1.2-rc.1` (package.json) |
| Example plugin configs | `~/projects/dsh-chamber/ref-dsh/examples/mcp-memory/*.cordis.yml` (+ README) | n/a |
| Registry it registers into | ref: `~/projects/dsh-chamber/ref-dsh/packages/core/tools/src/index.ts`; installed: `…/node_modules/@deepseek-ai/dsh-tools/` | `0.1.0-rc.5` / `0.1.2-rc.1` |
| Supporting seams | `@deepseek-ai/dsh-scope`, `dsh-subprocess`, `dsh-attachment`, `dsh-llm`, `dsh-tools`, `dsh-util-values`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@modelcontextprotocol/sdk`, `zod` under the anchor `node_modules` | see §8 |
| Design notes (authoritative rationale) | `~/projects/dsh-chamber/ref-dsh/.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md`, `2026-08-06-mcp-client-auto-reconnect.md` | n/a |

The installed 0.1.2-rc.1 `lib/index.js` is a single tsdown bundle (transport + tools +
connection + index sections, `//#region` comments) — no separate lib files. `lib/types/*.d.ts`
are the authoritative API surface (4 files: `index.d.ts`, `connection.d.ts`, `tools.d.ts`,
`transport.d.ts`). The ref tree (0.1.0-rc.5) also ships `src/invariant.ts` + a `./invariant`
subpath; 0.1.2-rc.1 dropped the invariant companion entirely (see §9).

---

## 1. Plugin identity, side, lifecycle

### 1.1 Shape: namespace plugin (no default export), plain (non-service) plugin

`src/index.ts` (ref) and the installed `lib/index.js` agree:

```ts
// ref-dsh/packages/mcp/mcp-client/src/index.ts:27-37 (identical in 0.1.2-rc.1 lib/index.js:718-725)
/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
```

Runtime exports are exactly `{ name, inject, Config, apply }` (both bundles end with
`export { Config, apply, inject, name }`). Type-only exports additionally exist
(`McpResult` from `tools.ts`; `ReconnectConfig`, `ResolvedReconnectPolicy` from `connection.ts`)
— index.d.ts lines 18-19 in both versions. There is **no `export default`** — a dedicated
test guards this because a default export would collapse the namespace through the cordis
Loader's `unwrapExports` and drop `inject`
(`ref-dsh/packages/mcp/mcp-client/tests/load-path.spec.ts:1-29`). "Namespace plugin" is the
repo's term for this shape.

It is a *host-side* plugin: it runs in the harness Host composition, connects out to MCP
servers (child processes or remote HTTP), and registers tools into the shared `ctx.tools`
ToolRuntime registry that feeds model tool calls. It is **not** a client-GUI-side plugin and
not an MCP *server*. It does **not** register any service (`ctx.provide`): it is a plain
"load N instances with different configs" plugin — the Agent Note says explicitly: "Each MCP
server is one plugin instance in `cordis.yml` — the same package loaded N times with different
configs, like `dsh-tool-subagent`" (`2026-07-07-mcp-client-plugin.md`).

### 1.2 Cordis events hooked: none — work happens inside `apply` + `ctx.effect`

There is no `ctx.on('ready')`, no `session/created`, no start-event subscription anywhere
(grep of both source trees finds zero `ctx.on(`/`ctx.once(` in the package). Activation is
`apply()` itself, which is deliberately `async` and awaited by the loader before the fiber
activates:

```ts
// ref-dsh/packages/mcp/mcp-client/src/index.ts:140-181 (apply; 0.1.2-rc.1 identical logic)
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration … rejects THIS instance …
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance at load …
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) { names = new Set(); activeServerNames.set(ctx.root, names) }
    if (names.has(config.serverName)) {
      throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`)
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  const connection = startConnection(ctx, config, reconnect)

  ctx.effect(() => { return () => connection.dispose() }, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery …
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
```

So the lifecycle is: **plugin start (composition boot) → connect → discover → register tools →
activation completes**. One connection per plugin instance per process lifetime (per HMR
generation), not per session. The MCP-protocol event it *does* listen to is the server
notification `notifications/tools/list_changed`, via the MCP SDK's
`generation.setNotificationHandler(ToolListChangedNotificationSchema, …)` — not a Cordis
event (`src/connection.ts:257-270`).

**0.1.2-rc.1 drift (visible in the bundle, lib/index.js:765-784):** the namespace
reservation is keyed by registration scope instead of `ctx.root`:

```js
ctx.effect(() => {
  const owner = scopeOf(ctx) ?? ctx.root   // 0.1.2-rc.1; rc.5 used ctx.root only
  let names = activeServerNames.get(owner)
  …
}, "mcp-client.serverName");
```

Doc comment in the bundle (lib/index.js:726-731): "Live `serverName` reservations per
registration scope. Agent-scoped MCP servers may reuse a namespace in another Agent, while
global instances and duplicates inside one Agent remain mutually exclusive."

---

## 2. Config shape (exact zod schema)

Schemastery schema, discriminated on `transport`; the two versions are **byte-identical at
runtime** (ref `src/index.ts:100-128`; 0.1.2-rc.1 `lib/index.js:732-756`):

```ts
// ref-dsh/packages/mcp/mcp-client/src/index.ts:100-128
const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),                    // true
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs), // 500
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),          // 30_000
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts), // 10
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),   // /^[A-Za-z0-9_-]{1,32}$/
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),   // 60_000
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>
```

Field table (README `mcp-client/README.md` "Config" and both package READMEs):

| Field | Transport | Default | Notes |
|---|---|---|---|
| `transport` | both | required | `'stdio'` \| `'streamable-http'` |
| `serverName` | both | required | `[A-Za-z0-9_-]{1,32}`; unique per registration scope (§1.2) |
| `command` | stdio | required | executable |
| `args` | stdio | `[]` | passed verbatim, no shell (`shell:false` in SDK) |
| `env` | stdio | `{}` | extra env merged **on top of scrubbed ambient env** |
| `cwd` | stdio | `''` | passed through to SDK spawn |
| `url` | http | required | MCP endpoint |
| `headers` | http | `{}` | sent on every HTTP request (`requestInit.headers`) |
| `toolCallTimeoutMs` | both | `60000` | per `tools/call` request timeout (SDK request timeout) |
| `failOnStartupError` | both | `false` | true → failed initial connect/sync rejects plugin activation |
| `reconnect.*` | both | see defaults | enabled/initialDelayMs/maxDelayMs/maxAttempts (500/30000/10) |

Type-level drift: rc.5's d.ts declares `export declare const Config: z<Config>` where the
`StdioConfig`/`StreamableHttpConfig` interfaces mark `args/env/cwd/toolCallTimeoutMs/
failOnStartupError` as **required** (they are materialized output fields);
0.1.2-rc.1's d.ts declares `Config: z<ConfigInput, Config>` with a `ConfigInput` union whose
defaulted fields are `Partial` (rc.1 `lib/types/index.d.ts:72-75`). Same runtime schema,
better input typing in rc.1.

### How env/header *values* are sourced

Plain config strings. There is **no credentials-domain hookup and no env-var expansion inside
the plugin**. The official examples obtain secrets via the harness YAML dialect's `!!js`
expressions, evaluated by the cordis loader at config-parse time (arbitrary JS `eval` in a
`with (ctx)` scope; `vendor/loader/src/config/utils.ts:5-17` in ref-dsh), e.g.:

```yaml
# ref-dsh/packages/mcp/mcp-client/README.md:11-30 (identical example in the rc.1 README)
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

After evaluation the schema only ever sees concrete strings (`env: z.dict(String)`,
`headers: z.dict(String)`).

---

## 3. Tool registration semantics — the contract to mirror

### 3.1 Naming

Public name = `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
contract (≤64 chars, `[A-Za-z0-9_-]`); any lossy normalization appends a deterministic
12-hex-char SHA-256 suffix over the identity `serverName\0rawName`:

```ts
// ref-dsh/packages/mcp/mcp-client/src/tools.ts:96-102 (identical in 0.1.2-rc.1 lib/index.js:120-126)
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
```

Constants: `MAX_PUBLIC_NAME_LENGTH = 64`, `INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g`,
`HASH_LENGTH = 12` (`tools.ts:45-51`). Pinned contract — "changing it after release would
break session history and permission rules" (rc.1 README Dev Note). The raw name is only ever
sent on the wire; the public name is never parsed back (`tools.ts:5-13` header).

### 3.2 Sync: two-phase generation swap

```ts
// ref-dsh/packages/mcp/mcp-client/src/tools.ts:128-174 (abridged)
export async function syncTools(client, ctx, opts, previous): Promise<ToolDisposers> {
  // Phase 1: fetch … without touching the registry.
  const definitions = new Map<string, ToolDefinition>()
  let cursor: string | undefined
  do {
    const response = await listToolsUncached(client, cursor)
    for (const tool of response.tools) {
      const publicName = publicToolName(opts.serverName, tool.name)
      if (definitions.has(publicName)) throw new Error(
        `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`)
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? '',
        parameters: tool.inputSchema,                    // MCP JSON Schema passes through unchanged
        output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
        execute: createExecutor(client, tool.name, tool.execution?.taskSupport === 'required', opts),
      })
    }
    cursor = response.nextCursor
  } while (cursor)

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))   // disposer per tool
    }
  } catch (error) {
    // foreign registration squats on the mcp__<serverName>__ namespace → roll back whole generation
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    return new Map()
  }
  return disposers
}
```

Key semantics:
- `tool.inputSchema` is registered **unchanged** (no conversion, no `defineTool` DSL) —
  `parameters` is raw MCP JSON Schema (`tools.ts:149`; Agent Note: "The MCP JSON Schema and
  description pass through unchanged … only the model-facing name is replaced").
- Duplicate raw name in one server's list → sync throws (previous generation stays).
- `registrationFailure: 'contain' | 'throw'` — 'contain' (re-syncs, reconnect syncs,
  `failOnStartupError:false`) logs and returns empty map; 'throw' (initial sync when
  `failOnStartupError:true`) propagates to the `apply` await (`src/connection.ts:125-135`).
- Returns `Map<publicName, disposer>` — the exact live registration set owned by this server.

### 3.3 ToolDefinition passed to `ctx.tools.register`

`ctx.tools.register(definition)` (`ToolRuntime`) returns the exact unregister disposer:
"Register globally or in the calling agent scope. Scoped tools shadow globals; duplicates
within one layer and the reserved `run_code` name fail." (docstring above the implementation,
ref `packages/core/tools/src/index.ts:1035-1037`; identical in installed dsh-tools
`lib/index.js` ~2774). It validates `output` (`{schema, render, presentationMeta?}`),
`assertSupportedJsonSchema(output.schema)`, `timeoutMs`, and rejects the reserved `run_code`
name. mcp-client sets **only** `name/description/parameters/output/execute`
(rc.1 additionally sets `finalizeContent`, below); no `presentCall`/`presentResult`
("UI consumers use the provider-neutral generic-card fallback", Agent Note).

`output` (both versions):

```ts
// ref-dsh/packages/mcp/mcp-client/src/tools.ts:200-216 (identical shape in rc.1)
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}
```

`structuredContent` is only declared/required when the server advertises an `outputSchema`
that passes `assertSupportedJsonSchema`; anything else falls back to unconstrained
`JsonValue` (`tools.ts:189-197`).

### 3.4 Executor: how `execute` is wrapped

```ts
// ref-dsh/packages/mcp/mcp-client/src/tools.ts:228-278 (abridged)
function createExecutor(client, rawName, taskRequired, opts): ToolDefinition['execute'] {
  return async (args: unknown, exec: ToolExecution) => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // non-object args (model misbehavior) → {} so the server produces the param error
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const result = await callToolUncached(client, rawName, argsObj, exec, opts)
    // …legacy `toolResult` shape → JSON.stringify into a single text block …
    // normalize/validate every content block at the trust boundary …
    if (result.isError === true) throw new Error(text)   // MCP isError → throw → registry error path
    return { content, ...(result.structuredContent !== undefined ? { structuredContent } : {}) }
  }
}
```

- Calls the SDK Client **by raw request**, not via `client.callTool()`:
  `client.request({ method: 'tools/call', params: { name: rawName, arguments: args } },
  RawCallToolResultSchema, { signal: exec.signal, timeout: opts.toolCallTimeoutMs })`
  (`tools.ts:64-80`) — reasons: the SDK's cached per-method output validators must not
  pre-validate a schema the bridge may not support (`listToolsUncached`/`callToolUncached`
  comments, `tools.ts:56-80`).
- **Abort forwarding**: `exec.signal` is passed as the SDK request signal (agent-loop
  cancellation → SDK `$/cancelRequest`). Timeout per call = `toolCallTimeoutMs` (60 s default).
- **Error mapping**: MCP `isError: true` → the executor **throws** (registry catch path then
  produces the failed `isError` tool result for the model). MCP `isError` on the legacy
  `toolResult` path → throw with the rendered text (`tools.ts:251-252`). Success returns the
  canonical `{ content: JsonValue[], structuredContent? }` value (`McpResult`).
- Content mapping for Native rendering (`extractText`, `tools.ts:288-317`): `text` blocks
  join with `'\n'`; `image`/`audio` → `[image: <mime>, content discarded]`-style placeholders;
  `resource`/`resource_link` → placeholders; unknown/primitive blocks → `[unsupported …]`;
  empty → `(<toolName> returned no text content)`. Everything is defensive against buggy
  servers (fields declared required by the spec are guarded).

**0.1.2-rc.1 executor drift** (installed `lib/index.js:198-447`): the same core plus an
image bridge:
- `createDefinition` builds the definition and a per-definition `WeakMap` projection store,
  and sets `finalizeContent(exec, result)` on the definition (lib/index.js:198-216) — the
  dsh-tools hook that replaces registry content only when the post-execute outcome is
  unchanged (`isDeepStrictEqual` guards; registry snapshots the finalizer at call start).
- After a successful call, if the content array contains an `image` block
  (`containsImage`), it decodes PNG/JPEG/WebP/GIF blocks (strict canonical-base64 check via
  `CANONICAL_BASE64`, `Buffer` round-trip), resolves the caller's model route from
  `exec.agent?.session.requestHeader()?.config ?? exec.agent?.options`, verifies image-input
  capability through `llm.resolveModelInfo(provider, model, exec.signal)`, then persists via
  `ctx.get('attachments').saveImages(decoded)` and returns a content projection with
  `{type:'image', attachment}` blocks at the original positions. Every refusal path projects
  diagnostic text (`[image unavailable: …]`) while the canonical value keeps raw blocks.
  Order: `isError` throws *before* any image persistence.
- `resource_link` blocks are rendered as text `Resource link: <name> (<uri>)`; audio /
  embedded resources keep explicit placeholders; unknown/primitive blocks get clearer
  diagnostics (lib/index.js:394-447).
- `syncTools` in rc.1 delegates definition construction to `createDefinition(client, ctx,
  …)` (lib/index.js:151-174).

### 3.5 Conflict/duplicate handling summary

| Situation | Behavior |
|---|---|
| Duplicate `serverName` (same registration scope) | later instance fails at load, first untouched (`index.ts:154-158`) |
| Same raw tool name from two different servers | coexists under namespaces (tests `mcp-client.spec.ts:126`) |
| Same name as a native harness tool | coexists — `mcp__` prefix keeps namespaces disjoint (test `:137`) |
| Server lists one tool name twice | whole sync rejects; previous generation stays (`tools.ts:141-145`) |
| Registry conflict during swap (foreign squatting on `mcp__<serverName>__*`) | roll back entire attempted generation; loud log; 'throw' only on strict startup |
| Normalization collision (e.g. `admin.reset` vs `admin_reset`) | SHA-256 suffix makes names unique (`tools.ts:96-102`, test `:94-101`) |
| MCP `execution.taskSupport === 'required'` | tool registered but **throws at call time** (`tools.ts:235-237`) |

---

## 4. Server lifecycle

### 4.1 When servers start

At plugin activation (`apply`), i.e. composition boot, per plugin instance; never per session
and there is no runtime-dynamic API ("No runtime-dynamic API for now", Agent Note §Lifecycle).
`apply` returns only after the *initial* connect + sync settles (activation gating, test
`apply.spec.ts:184` "keeps the Cordis plugin loading until initial discovery publishes its
tools"); with `failOnStartupError:false` a failure is logged and the supervisor enters its
reconnect loop with zero tools.

### 4.2 Connection class and transports

`src/connection.ts:237-272` — one generation = a fresh MCP SDK `Client` + one transport
("the MCP SDK binds a Protocol to one transport for life"):

```ts
const generation = new Client(
  { name: 'dsh-mcp-client', version: '0.0.1' },   // clientInfo sent in initialize
  { capabilities: {} },
)
…
await generation.connect(createTransport(config))
```

`src/transport.ts:21-49` (identical in rc.1):

```ts
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({ command, args, env: buildChildEnv(config.env), cwd })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
  }
}
```

### 4.3 Env discipline when spawning (which vars stripped)

`scrubbedParentEnv()` comes from `@deepseek-ai/dsh-subprocess` (a plain exported function,
shared because the SDK owns the actual spawn):

```js
// anchor node_modules/@deepseek-ai/dsh-subprocess/lib/index.js:31-50
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
function scrubbedParentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== void 0 && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith("DSH_"))
      env[key] = value;
  return env;
}
```

So: ambient vars whose *names* match `/KEY|PASSWORD|SECRET|TOKEN/i` **and** every `DSH_*`
(name prefix, case-insensitive) are dropped; `PATH/HOME/locale/proxy` survive. Explicit
`config.env` merges on top and therefore can deliberately forward secrets/DSH facts. Final
child env also gets the SDK's own safe-inherit defaults (`getDefaultEnvironment()` in
`@modelcontextprotocol/sdk/client/stdio.js`: POSIX `HOME, LOGNAME, PATH, SHELL, TERM, USER`,
Windows list differs; function-valued vars skipped) spread **under** the bridge env. Spawn is
`shell: false`, stderr default `inherit`.

### 4.4 Crash / retry behavior

`src/connection.ts` implements the whole supervisor:
- `generation.onclose` → `generationDown` → `scheduleReconnect()` (connection.ts:248-254,
  173-178, 192-225).
- Exponential backoff: `delay = min(maxDelayMs, initialDelayMs * 2**(failedAttempts-1))`;
  timers are `unref()`ed; a warn log prints attempt i/max.
- Per-outage budget: `maxAttempts` consecutive failures → dispose all tool disposers,
  log "giving up … tools unregistered; reload the plugin or restart the Host", stop.
  A connection that stays up ≥ `maxDelayMs` (stability window) resets the budget, so
  occasionally-crashing servers recover indefinitely while crash loops still exhaust the cap
  (connection.ts:203-215).
- `reconnect.enabled:false` → log-and-stop (tools stay registered but fail until HMR/restart).
- On reconnect success the new generation re-runs discovery; `disposers` is swapped by
  `syncTools` so tools neither duplicate nor leak.
- Failure close discipline: a failed generation must report close within
  `GENERATION_CLOSE_TIMEOUT_MS = 5_000` before the supervisor retries, to avoid overlapping
  server processes (connection.ts:47-50, 181-190, 285-294).
- Disposal: clears the reconnect timer, closes the live client, awaits the in-flight attempt
  (`settling`) and the whole sync queue (`syncChain`), then disposes every tool disposer
  (connection.ts:325-350).

### 4.5 Tool discovery flow

`connect()` success → `enqueueSync(generation, startup ? startupOpts : opts)` →
`syncTools` drains `tools/list` pagination (raw `client.request` with
`ListToolsResultSchema` + `nextCursor`), builds the generation, registers (see §3.2).
`notifications/tools/list_changed` → enqueued re-sync; all syncs (initial, notification,
reconnect) are serialized through one promise chain (`syncChain`, connection.ts:161-170) so
dispose-previous/register-next can never interleave. Fetch-phase failures keep the previous
generation registered. Discovered tools are kept in the supervisor's `disposers: Map<string,
() => void>` (connection.ts:142-143) and inside the ToolRuntime layers (see §5); the map is
the exact set the server owns.

---

## 5. Consumed/exposed ctx services; where tools land

**Consumed (required, `inject: ['tools']`)**: `ctx.tools` (ToolRuntime) and ambient Cordis
services `ctx.logger`, `ctx.effect`, `ctx.root` (rc.5) / `scopeOf(ctx)` (rc.1).
**Consumed optionally at execution time (rc.1 only, via `ctx.get(...)` — NOT injected)**:
`ctx.get('attachments')` and `ctx.get('llm')` inside the image path
(lib/index.js:317-334: "no attachment store is mounted" / "the current model route could not
be resolved" errors, i.e. images degrade to text when either service is absent).
**Not consumed**: `ctx.session`, `ctx.settings`, `ctx.credentials`, `ctx.scope`
(rc.5/rc.1 — env/header values are plain config, §2). `dsh-scope`'s `scopeOf(ctx)` only
returns the scope key the plugin's own context carries; the dsh-scope machinery
(`createScope`, `bindScopeParent`) lives elsewhere (the agent/composition layer, not this
package).
**Exposes**: nothing. rc.5 ships an optional *companion* module
`@deepseek-ai/dsh-mcp-client/invariant` (`name='mcp-client-invariant'`,
`inject=['invariants']`) whose `apply` registers a **no-op** invariant under the package
name — "No runtime invariant: MCP generations contribute through the tool registry, but the
bridge exposes no independent server-to-tool snapshot after an asynchronous resync"
(`src/invariant.ts:17-29`). Dropped in rc.1 (§9).

**Registry hierarchy / scoping** (dsh-tools, ref `packages/core/tools/src/index.ts`; the
installed 0.1.2 dsh-tools is equivalent):

```ts
// packages/core/tools/src/index.ts:1153-1178 (view derivation, abridged)
const layers = this.layers.chainLayers(scope)          // ancestors + the scope itself
const own = this.layers.peek(scope)                    // scope's OWN registrations
const inherited = new Map(this.layers.global.tools.entries())
for (const layer of layers) {
  if (layer === own) continue
  for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
}
// restrictions mask inherited names across the chain …
// The scope's own registrations last, shadowing an inherited name …
if (own !== undefined) { for (const [name, definition] of own.tools.entries()) { … visible.set(name, definition) } }
```

- A tool plugin loaded at host level registers into the **global layer** — visible to every
  agent/session. mcp-client does **no per-workspace or per-session registration** on its own:
  sessions never receive tools directly; the model's tool set is whatever
  `ToolRuntime.view(agentScope)` derives (global + agent-scope chain, minus restrictions,
  own-layer shadows).
- 0.1.2-rc.1 is explicitly compatible with being loaded **inside an Agent scope** (rc.1
  README: "Independent Agent scopes may reuse the same namespace because their tools and
  transports are isolated; a duplicate inside one scope fails at load") — `ctx.tools.register`
  then lands in that agent's own layer (`agent.ctx`), shadowing globals for that agent only.
  In ref 0.1.0-rc.5 the reservation map was keyed on `ctx.root`, so agent-scoped reuse of one
  serverName was *not* allowed even though the registry supported scoped registration; the
  docstring "register through that agent's `agent.ctx`" already existed in rc.5's tools
  (`packages/core/tools/src/index.ts:727`).

---

## 6. src/ inventory and tests/

### 6.1 `src/` (ref 0.1.0-rc.5; each module's role)

| File | Role (one line) |
|---|---|
| `src/index.ts` | Plugin entry: `name`/`inject`/`Config` (zod unions + defaults), `serverName` reservation effect, `apply()` that starts the supervisor and awaits initial connect+sync. |
| `src/connection.ts` | Connection supervisor `startConnection`: per-generation MCP `Client`, `RECONNECT_DEFAULTS`, `resolveReconnectPolicy`, reconnect/backoff/attempt-budget, `notifications/tools/list_changed` re-sync queue, disposal/quiescence. |
| `src/tools.ts` | Tool bridge: `publicToolName`, two-phase `syncTools`, output schema/render, per-tool executor (raw `tools/call`, abort+timeout, `isError`→throw, content extraction); type `McpResult`. |
| `src/transport.ts` | `createTransport` factory: `StdioClientTransport` with `scrubbedParentEnv()` + explicit env, or `StreamableHTTPClientTransport` with headers. |
| `src/invariant.ts` | rc.5-only no-op invariant companion (`mcp-client-invariant`, `inject:['invariants']`). |

0.1.2-rc.1 ships the same four runtime modules but **bundled** into one `lib/index.js`
(`//#region lib/types/{transport,tools,connection,index}.js`), with the tools module
extended by the image bridge (see §3.4) — and **no** invariant module.

### 6.2 `tests/` (ref tree; all vitest)

| File | Coverage |
|---|---|
| `tests/apply.spec.ts` (403 l.) | Module export shape; Config schema validation (missing/invalid serverName, reconnect defaults/partial overrides/invalid blocks); apply lifecycle with **mocked MCP SDK** (`vi.mock` + `vi.hoisted`): connects/syncs/notification registration, activation gating, duplicate serverName, per-app-root reservation scoping, failure logging w/o tools, `failOnStartupError` fatal path, strict-startup registration failure, list_changed before connect resolves, re-sync failure keeps previous generation, disposer unregister + close, streamable-http path. |
| `tests/mcp-client.spec.ts` (841 l.) | Unit tests of `publicToolName` (verbatim/replace+hash/truncate+hash/determinism), `syncTools` (server-qualified names, two servers same raw name, native-tool coexistence, duplicate raw name, fetch-fail keeps generation, squatting rollback, re-sync unregister, pagination, own output validation), execution mapping (raw name on wire, text join, full-JSON preservation vs placeholders, structuredContent supported/unsupported, isError→throw, task-required rejection, abort signal, legacy `toolResult` shape incl. isError), content edge cases (audio/resource/resource_link/unknown/missing mimeType/missing text/empty), `createTransport` (stdio + http ± headers, env scrub + explicit env merge), non-object args fallback. Registry = real `ToolRuntime` on a `Context` (`mountRegistry()`: `new Context()` + `ctx.plugin(SystemPrompt)` + `ctx.plugin(ToolRuntime)`), clients = hand-rolled mocks over `InMemoryTransport` from the SDK. |
| `tests/reconnect.spec.ts` (521 l.) | Supervisor behavior with mocked SDK: reconnect after transport close + re-sync + serve, failure cap + unregister, give-up behind in-flight sync, no replacement before failed generation closes, non-closing generation stops reconnect, disposal during backoff/in-flight connect/in-flight sync, post-dispose close no-op, `reconnect.enabled:false` both flavors, stability-window budget reset, crash-loop exhaustion, close-vs-connect races; `resolveReconnectPolicy` unit (defaults frozen, unknown keys, ranges, ceilings, apply-fails-loud). |
| `tests/mcp-client.e2e.ts` (523 l.) | **Real MCP protocol** e2e (no API keys): (1) self-written fixture server over stdio — discovery, dotted-name normalization + execution, add/greet/fail(`isError`)/image(placeholder), duplicate serverName, disposal, stdio crash → auto-reconnect + serve again, unload during outage; (2) official `@modelcontextprotocol/server-everything` (echo/get-sum/get-tiny-image); (3) `@modelcontextprotocol/server-filesystem` real fs round-trip; (4) in-process `StreamableHTTPServerTransport` over HTTP incl. asserting configured headers on requests. |
| `tests/fixture-server.ts` (76 l.) | Minimal stdio MCP server (`McpServer` + `StdioServerTransport`, `listChanged` capability): tools `add`, `greet`, `fail` (isError), `image` (png block), `crash` (exits after reply), `admin.reset` (dotted name). |
| `tests/load-path.spec.ts` (29 l.) | Real-load-path guard: module has no default export and survives `Loader.prototype.unwrapExports` with `name`/`inject`/`Config`/`apply` intact (postmortem 0001). |

### 6.3 Harness / runner

**Vitest.** Root scripts in `~/projects/dsh-chamber/ref-dsh/package.json`: `"test": "vitest run"` (unit + integration specs, includes `packages/*/*/tests/**/*.spec.{ts,tsx}`) and
`"test:e2e": "vitest run --config vitest.e2e.config.ts"` (includes `packages/*/*/tests/**/*.e2e.ts`).
The package itself has **no `scripts` field** (ref `packages/mcp/mcp-client/package.json`) —
everything runs from the monorepo root; a per-file 100% coverage gate applies to all
`src/` files. Tests import the package both by name
(`import type { Config } from '@deepseek-ai/dsh-mcp-client'`) and through the internal
`./src/*` export map (`import { syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'`,
`apply` from `…/src/index.ts`). rc.1 keeps the `./src/*` export entry but does **not ship**
`src/` on npm (files whitelist), so those imports work only in-repo.

---

## 7. TODO / unsupported / naming rules

No literal `TODO`/`FIXME` markers exist in either source. Unsupported / deferred (code +
rc.1 README "Known Limitations and Deferred Work"):

- **Tools are the only bridged MCP capability**; Resources and Prompts deferred.
- **Task-based execution extension unsupported**: tools advertising
  `execution.taskSupport: 'required'` are registered but every call throws
  ("requires task-based execution, which this bridge does not support", tools.ts:235-237).
- **No plugin-owned connection/discovery timeout**; each `initialize`/`tools/list` uses the
  MCP SDK's 60 s request default (startup and teardown can stall on unresponsive servers).
- **Streamable HTTP reconnection is SDK-side** — the supervisor's reconnect fires on
  transport close (a crashed stdio child); an unreachable HTTP server is retried per request
  by the SDK's own recovery, not respawned by the supervisor (rc.1 README: "Reconnect
  ownership for Streamable HTTP is open").
- rc.5: images/audio/resources are discarded to placeholders in model context (full JSON
  preserved in the canonical value); rc.1: PNG/JPEG/WebP/GIF bridged via attachments under
  exact capability proof; audio/embedded-resource payloads stay execution-local with
  diagnostics; resource links keep name+URI as text.
- Unsupported MCP `outputSchema` vocabulary → `structuredContent` falls back to
  unconstrained `JsonValue` (not enforced).
- rc.5 README notes the tool-registration/description pass-through; nothing else marked.

**Naming rules**: `serverName` = `/^[A-Za-z0-9_-]{1,32}$/` (Schemastery `.pattern`, §2);
public tool name contract = ≤64 chars of `[A-Za-z0-9_-]`, prefix `mcp__<serverName>__`
(§3.1); MCP raw names are never validated by the bridge (up to the MCP spec's 128 chars,
dots legal) — normalization handles them.

---

## 8. Dependencies (exact)

### ref package.json (`packages/mcp/mcp-client/package.json`, v0.1.0-rc.5)

```json
"peerDependencies": {
  "@deepseek-ai/dsh-invariants": "workspace:^",
  "@deepseek-ai/dsh-llm": "workspace:^",
  "@deepseek-ai/dsh-subprocess": "workspace:^",
  "@deepseek-ai/dsh-timeout": "workspace:^",
  "@deepseek-ai/dsh-tools": "workspace:^",
  "@deepseek-ai/cordis": "workspace:^"
},
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.12.0",
  "@deepseek-ai/schemastery": "workspace:^",
  "zod": "^4.4.3"
},
"devDependencies": { …same dsh peers…, "@modelcontextprotocol/server-everything": "^2026.7.4",
  "@modelcontextprotocol/server-filesystem": "^2026.7.4" }
```

### Installed package.json (`…/@deepseek-ai/dsh-mcp-client/package.json`, v0.1.2-rc.1)

```json
"peerDependencies": {
  "@deepseek-ai/dsh-attachment": "^0.1.2-rc.1",
  "@deepseek-ai/dsh-llm": "^0.1.2-rc.1",
  "@deepseek-ai/dsh-scope": "^0.1.2-rc.1",
  "@deepseek-ai/dsh-subprocess": "^0.1.2-rc.1",
  "@deepseek-ai/dsh-timeout": "^0.1.2-rc.1",
  "@deepseek-ai/dsh-tools": "^0.1.2-rc.1",
  "@deepseek-ai/cordis": "^4.0.2"
},
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.12.0",
  "zod": "^4.4.3",
  "@deepseek-ai/schemastery": "^3.18.2"
},
"devDependencies": { "@modelcontextprotocol/server-everything": "^2026.7.4",
  "@modelcontextprotocol/server-filesystem": "^2026.7.4", …dsh peers incl. dsh-attachment-local… }
```

Resolved versions in the anchor install: `@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`,
`@deepseek-ai/schemastery@3.18.2`, `@deepseek-ai/cordis@4.0.2`, and every
`@deepseek-ai/dsh-*@0.1.2-rc.1` (dsh-attachment, dsh-attachment-local, dsh-llm, dsh-scope,
dsh-subprocess, dsh-timeout, dsh-tools, dsh-util-values). Ref-workspace resolved versions:
cordis 4.0.1, schemastery 3.18.1 (vendored), dsh-* 0.1.0-rc.5.

Exports map drift: rc.5 has `"./invariant": {types…, default: "./lib/invariant.js"}`
plus `"./src/*"`, `"./package.json"`, and `files: ["lib/index.js","lib/invariant.js",
"lib/types/**/*.d.ts"]`; rc.1 dropped `./invariant`/`lib/invariant.js`, kept the rest
(and `src/` is still not shipped). Runtime `dependencies` in the mcp-client bundle are
`@deepseek-ai/schemastery` (z), `zod` (raw zod for the call-result schema), MCP SDK, and —
at runtime — imports of dsh-timeout (max-timer bound), dsh-subprocess (`scrubbedParentEnv`),
dsh-scope (`scopeOf`), dsh-attachment + dsh-llm (rc.1 image path), dsh-tools
(`assertSupportedJsonSchema`) — all resolved as peers by the Host.

---

## 9. Drift list: ref 0.1.0-rc.5 → installed 0.1.2-rc.1

1. **Invariant companion removed**: rc.5 ships `src/invariant.ts` + `./invariant` subpath
   (`mcp-client-invariant`, no-op); rc.1 has no invariant.d.ts, no `./invariant` export, no
   `lib/invariant.js`; peer `@deepseek-ai/dsh-invariants` dropped from the manifest.
2. **Image bridging added** (rc.1): `attachments.saveImages` + model image-capability
   proof via `llm.resolveModelInfo`; `finalizeContent` on ToolDefinition; strict base64/MIME
   validation; ordered projections; only when `ctx.get('attachments')` and `ctx.get('llm')`
   resolve and `exec.agent` route info exists — every refusal degrades to diagnostic text.
   rc.5 dropped image content outright (placeholders only).
3. **`resource_link` rendering**: placeholder in rc.5 → `Resource link: <name> (<uri>)`
   text in rc.1; audio/embedded-resource placeholders reworded to keep "raw … data remains
   available to programmatic callers".
4. **`serverName` reservation keying**: `ctx.root` (rc.5) → `scopeOf(ctx) ?? ctx.root` (rc.1);
   rc.1 README documents per-Agent-scope reuse and the registration-scope vocabulary.
5. **Terminology**: "Code Mode" → "PTC mode" (McpResult doc, `run_code` reserved-name error,
   READMEs); registry terms unchanged.
6. **Type layout**: `JsonValue` (and friends) moved from `@deepseek-ai/dsh-tools` to
   `@deepseek-ai/dsh-util-values`; rc.1 `tools.d.ts` imports it from there. (Runtime bundles
   both versions use `zod`'s own values for the call-result schema.)
7. **Config typing**: rc.1 d.ts declares `Config: z<ConfigInput, Config>` with optionalized
   defaulted fields; rc.5 declared `z<Config>` only. Runtime schemas identical.
8. **Packaging**: rc.1 is a single `lib/index.js` bundle (4 `//#region` modules), no
   invariant entry; package.json peer/dev list swaps (dsh-invariants out; dsh-attachment,
   dsh-scope, dsh-attachment-local in); versions/cordis/schemastery bumps (§8).
9. **Docs**: rc.1 README rewritten (registry-scope language, image behavior, config-catalog
   and Agent-Note pointers); identical config defaults/example YAML.
10. **Unchanged core contract** (verified line-by-line): name/inject/Config/apply values,
   zod schema fields/defaults, `publicToolName` algorithm + constants, sync two-phase swap,
   `registrationFailure` semantics, reconnect policy/defaults/backoff math, supervisor
   structure, transport construction + env scrub, clientInfo `{name:'dsh-mcp-client',
   version:'0.0.1'}`.

### Official example-plugin shape (mcp-memory)

`~/projects/dsh-chamber/ref-dsh/examples/mcp-memory/` contains only README (i18n) + three
**default-off Cordis overlay patches** (`memorix.cordis.yml`, `mcp-reference-memory.cordis.yml`,
`engram.cordis.yml`); no plugin source. Shape: `- insert: - id: <unique>, name:
'@deepseek-ai/dsh-mcp-client', config: {serverName, transport: stdio, command, args, env,
cwd: !!js process.cwd()}`; applied with `dsh web --patch <file>` or merged into
`$DSH_HOME/cordis.patch.yml`/profile patches (README.md). Real-world rows: memorix
`command: memorix, args: [serve]`; server-memory `command: mcp-server-memory` with env
`MEMORY_FILE_PATH` computed from `process.env` via `!!js`; engram `command: engram, args:
[mcp]`. Note: the example README still says "the current generic client does not
auto-reconnect" after a crash — stale text predating the 2026-08-06 auto-reconnect feature
(cf. `.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.md`).

---

## Facts an implementer must not get wrong

1. **Plugin identity**: namespace module with **no default export**; named exports exactly
   `name='mcp-client'`, `inject=['tools']`, `Config` (Schemastery), `apply(ctx, config)`
   async. A default export would silently drop `inject` through Loader `unwrapExports`.
2. **No Cordis event hooks** — connect/discover/register all run inside `apply` before
   activation completes; lifecycle is effect-scoped (`ctx.effect` for reservation and
   disposal), not `ctx.on('ready')`/`session/created`.
3. **One plugin instance per MCP server**; config is a `transport`-discriminated union
   (`stdio` vs `streamable-http`) with defaults `args/env/headers:{}`, `cwd:''`,
   `toolCallTimeoutMs:60000`, `failOnStartupError:false`, `reconnect{true,500,30000,10}`.
4. **Public tool names are a pinned contract**: `mcp__<serverName>__<rawName>`, ≤64 chars
   `[A-Za-z0-9_-]`, lossy normalization appends 12 hex chars of
   `sha256(serverName + '\0' + rawName)`; the raw name (not the public name) is the only
   thing ever sent in `tools/call`, and public names are never parsed back.
5. **Register through `ctx.tools.register(definition)`** with the raw MCP `inputSchema`
   passed through untouched, `output` = `{schema: object{content[], structuredContent?},
   render: text}` (structuredContent only when the advertised `outputSchema` passes
   `assertSupportedJsonSchema`), and an `execute(args, exec)` that calls the SDK Client by
   **raw `request`** (`tools/call` + `RawCallToolResultSchema`, `{signal: exec.signal,
   timeout}`), not `client.callTool()`; `isError:true` → **throw** so the registry's error
   path fires; non-object args → `{}`.
6. **Generation-swap discipline**: sync = fetch-then-swap; fetch failures keep the previous
   generation; register conflicts roll back the whole attempted generation; every register
   disposer is tracked and unregistered on re-sync/dispose/give-up; all syncs serialize on
   one chain. A duplicate `serverName` in the same scope must fail the *later* instance at
   load (error, never silent shadowing) — reservation keyed per registration scope
   (`scopeOf(ctx) ?? ctx.root`) in rc.1.
7. **Child env**: scrub ambient env by `/KEY|PASSWORD|SECRET|TOKEN/i` and case-insensitive
   `DSH_*` prefix, then merge explicit `env` on top; spawn `shell:false` (SDK adds a small
   safe-inherit default env underneath). Secrets for `env`/`headers` come from **config
   values only** — the official pattern is loader-evaluated `!!js` expressions like
   `process.env.X`; there is no credentials-domain hookup in the plugin.
8. **Reconnect**: per-outage budget of `maxAttempts` (10) with doubling backoff 500→30000 ms;
   uptime ≥ maxDelayMs resets the budget; budget exhaustion unregisters tools and stops until
   reload; `enabled:false` keeps tools but stops; reconnect timers `unref()`ed; a failed
   generation must close within 5 s before retry (no overlapping children). Streamable HTTP
   outages are *not* supervised the same way (SDK-side per-request recovery).
9. **Where tools land**: into the ToolRuntime layer of the plugin's own context — global
   layer when composed at host level (all agents see them); an Agent-scope layer when composed
   under an agent (`agent.ctx`), shadowing globals for that agent. Nothing is per-session or
   per-workspace in the plugin; tool visibility per session is the registry's derived view
   (global + scope chain − restrictions).
10. **Version-sensitive details**: rc.1 (installed) is ESM-only, exports `{Config, apply,
    inject, name}` from one bundle; `./src/*` is in the exports map but `src/` is **not
    published**; `./invariant` exists only in rc.5; image bridging requires optional
    `attachments`/`llm` services and per-call model-route proof; `exec.agent` is only present
    when the agent loop set it — a compatible re-implementation can safely degrade images to
    text when unavailable.

## Still unknown / needs verification

- Whether the running Host loads mcp-client instances at host level or under agent scopes in
  real deployments (composition files live outside the anchor's node_modules-only tree;
  nothing in the package itself decides this) — rc.1 explicitly supports agent-scoped rows.
- Exact `dsh-tools` duplicate-registration error inside one layer (message + code) when a
  squatting name collides — the bridge only observes it as a thrown register and rolls back;
  the precise registry error text wasn't traced in the compiled anchor bundle.
- SDK 1.30.0's timeout semantics for `client.request({timeout})` (per-request deadline
  behavior vs. connect-time budget) and whether `exec.signal` aborts map to `$/cancelRequest`
  in every transport.
- The rc.1 image-path contract details of `attachments.saveImages` (store admission policy,
  error class `isImageAdmissionError`, returned attachment ref shape) beyond the call sites.
- Whether `cwd: ''` (schema default) is passed to the SDK spawn and how SDK/Node resolves an
  empty-string cwd (SDK passes `cwd` straight to `spawn`; unverified end-to-end).
- Test-harness parity for rc.1: the anchor package ships no tests; rc.1's own suite would
  need the newer (image/scope) behaviors asserted, which the ref 0.1.0-rc.5 tests do not
  cover.
