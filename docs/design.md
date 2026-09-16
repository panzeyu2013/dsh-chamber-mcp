# dsh-chamber-mcp — design

Architecture, contracts and deliberate deviations for the plugin. Compile and
verification target: the pinned `@deepseek-ai/*` devDependency generation (the
compile-time API surface and the CI guard); the peer ranges declare the
generations the plugin was verified against, and the live smoke installs and
boots through the chamber's current anchor CLI, reading its `dsh` version at
run time. Current release and verification state: `docs/status.md`; scope and
cuts: `docs/acceptance.md`; release process: `docs/RELEASE.md`.

## 1. Deliverable (package layout)

Single npm package **`dsh-chamber-mcp`** — dual-face + bundle (one loader row):

```
package.json           main lib/index.js; exports: "." | "./client" | "./cordis.patch.yml" | "./package.json"
                       "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
                                 "client": { "inject": [...], "platform": "web" } }
cordis.patch.yml       - insert: - id: mcp-scope, name: dsh-chamber-mcp
src/index.ts           HOST half: plugin entry (name/inject/Config/apply) — real logic
src/client/…           BROWSER half: settings section UI + the MCP transcript lane
                       (src/client/tool-card/), compiled to lib/client.js
src/shared/…           pure types + constants shared by both halves; the client
                       imports this module at RUNTIME (plain values and helpers,
                       no Node built-ins) and never a host-only module
lib/index.js           host ESM (tsc emit)          lib/types/**  declarations
lib/client.js          browser bundle (esbuild CJS + __ModuleLoader__.load wrapper)
```

Install (documented): `dsh plugin --profile web add <release-asset URL | local .tgz>`
(the bare npm name works only once npm publishing is re-enabled) → bundle appended
to `dsh.profile.bundles`, row inserted by patch, restart instance. Chamber: zero
code/seed involvement; the section is served through the ordinary `settings.section`
slot (in-GUI click-through still unverified — see `docs/status.md`).
Uninstall: `dsh plugin --profile web remove dsh-chamber-mcp` + restart stops the
servers and drops the section; leftovers (the `mcp-scope:` section and orphaned
credential refs) are removed by hand.

## 2. Identity & plugin entry (host)

- `export const name = 'mcp-scope'` (record scope, logs), `inject = ['settings','credentials','tools','workspaceRegistry','agents']`, `Config = z.object({})` (schemastery), `async apply(ctx, config)`.
- Namespace **`mcp-scope`** registered via `ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, EMPTY_DOC, { setSource, onChange, validate })`.
- Single-instance guard: a module-level `WeakSet<Context>` keyed on `ctx.root` (mirror official mcp-client serverName reservation) — duplicate plugin load fails loudly.
- `apply` returns fast (no boot gating on server connects); per-server connect runs async with official reconnect defaults.

## 3. Namespace document (settings domain)

```ts
// resolved: schema defaults ← composition base {} ← user layer (settings.yaml "mcp-scope:")
servers: ServerDef[]        // serverName is the stable identity; timeoutMs optional
disabled: { [serverName]: true }                       // presence = globally OFF (0.0.3)
overrides: { [workspaceId]: { [serverName]: true } }   // presence = explicitly ON
```
Deviations from the plan's shorthand (same semantics, documented in docs/acceptance.md):
(a) `overrides[w]` stored as dict-of-dicts so a toggle is one atomic path op
`set/unset ['overrides', w, s]`; (b) http headers stored as `{ name, ref }` pairs —
values always come from the credentials domain (a bare env-style name cannot be a
header name). Semantics: **enabled(w,s) = the override row has an OWN property `s`
(`Object.hasOwn`)** — prototype-member server names must keep working. The default
is OFF: a new server, a new workspace and a fresh session register no MCP tools
until the user enables the pair, so opening a session never silently exposes a
configured server to its agent.

```ts
ServerDef =
  | { serverName: string; transport: 'stdio'; command: string; args?: string[];
      cwd?: string; envKeys?: string[]; timeoutMs?: number }            // envKeys: credential refs
  | { serverName: string; transport: 'streamable-http'; url: string;
      headers?: { name: string; ref: string }[]; timeoutMs?: number }   // values from credentials
// serverName: /^[A-Za-z0-9_-]{1,32}$/ (official contract)
// ref: /^[A-Za-z_][A-Za-z0-9_]*$/ (CredentialRef = env-var name), value write-only via credentials domain
```
Schema `validate` hook: duplicate serverName across `servers`; duplicate env keys or
duplicate header names within one server → reject the write (the same credential
ref may be referenced by differently-named headers).

Cross-field rules (`src/shared/model.ts` `validateDoc`): unique `serverName`
(`[A-Za-z0-9_-]{1,32}`, never `__proto__` / `constructor` / `prototype`), a required
`command` (stdio) or `url` (http), no duplicate env keys or header names, credential
refs matching `[A-Za-z_][A-Za-z0-9_]*` (the `overrides` values of exactly `true`
are enforced by the schema, `src/schema.ts`, not by `validateDoc`).

**Hand-editing contract** (default file provider, `watch: true`, 100 ms settle): the
document is live-reloaded, so adding/removing a server or flipping an override with
any editor takes effect without an instance restart — the plugin reconciles on the
published change and starts/stops/restarts only the affected servers. An edit that
breaks a rule is **not published** (the running instance keeps the last good document
and warns while the file on disk holds the bad text); an unparsable document fails
the boot load loudly, and while running an unreadable/unparsable edit keeps the last
good sections. Deleting the file resets every namespace to defaults, and a section
whose plugin is not loaded is never dropped. UI writes are leaf-level YAML diffs, so
comments, anchors and formatting survive on untouched nodes.

## 4. Host behavior

- **Connect**: each server connects at plugin start (host activation lifecycle, official
  semantics) — stdio spawn (`shell:false`, env = `{...scrubbedParentEnv(), ...[resolved envKeys]}`
  via `ctx.credentials.resolve(ref)` per connect; missing ref → log + skip key), or
  StreamableHTTPClientTransport with headers resolved per request-setup. Crash → official
  reconnect policy (fixed defaults 500ms→30s, max 10 per outage, 5s close discipline,
  `tools/list_changed` → serialized re-sync). Master state per server:
  `{ generation, defs: Map<publicName, ToolDefinition>, ready }`.
- **Registration is per-agent-scope, never global** (the injection gate): only agents
  whose session is not a delegation child (`header.origin !== 'subagent'`) are adopted —
  children are governed by their preset scopes and never receive MCP tools;
  workspace membership is re-derived on every push/reconcile, and a
  durable `domain/changed` write for the workspace domain (`src/manager.ts`
  `mcp-scope.workspace-domain()`) triggers an applier reconcile, so a deleted
  workspace — or its directory — revokes its sessions' tools promptly.
  - `agent/created` (root listener) → `workspaceIdOf(session cwd, workspaceRegistry.list())` = canonical-cwd match against
    `workspaceRegistry.list()`; if a workspace W exists and `enabled(W, s)` → apply server's
    defs into `agent.ctx.tools` (each `register()` returns disposer; tracked per agent/server).
    Workspace-less sessions (or cwd outside registered workspaces): no MCP tools.
  - Settings commit / server re-sync / credential change → push to every live agent entry:
    revoke stale defs, register current defs for enabled servers only.
  - `agent/disposed` → entry dropped (ctx-scoped effects die with the agent ctx).
  - Bookkeeping map keyed by Agent; all listeners/disposers effect-wrapped (HMR-safe).
- **Tool semantics are the OFFICIAL adapter's** (pinned contract): the definition —
  canonical `{content, structuredContent?}` output schema, text projection,
  `taskRequired` refusal, `isError` → throw and durable image admission — is
  built by `createMcpToolDefinition`, the listing is capability-gated, and the
  caller-owned call is the 2.0 `callTool`. Public name
  `mcp__<serverName>__<rawName>` ≤64 chars `[A-Za-z0-9_-]` + 12-hex sha256 suffix on lossy
  normalization; raw MCP inputSchema passthrough; `output {schema, render}` shape; executor
  = `client.callTool({name, arguments}, {signal: exec.signal, timeout:
  <per-server timeoutMs, default 60000>, toolDefinition})`; generation swap on
  re-sync; registration conflict → rollback whole generation.
- Credentials events (`credentials/reference-updated` for a ref in use) → reconnect that
  server so new values take effect (a globally disabled or manually stopped
  server is skipped).
- **Global enable (0.0.3)**: reconcile never supervises a `disabled` server and
  stops+revokes one that is disabled while tracked; the applier reads the live
  `isServerDisabled` predicate per push/reconcile, so the model-visible tool set
  follows the switch.
- **Runtime status + manual control (0.0.3)**: three JSON routes on the
  Connection carrier (`/api/mcp-scope.status|action|tools`) are registered
  through a nested `ctx.inject(['connection'], …)` — headless hosts simply
  never mount them. The supervisor exposes a bounded snapshot (phase/attempts/
  nextRetryAt/connectedAt/syncedAt/toolCount/sanitized error). The RESPONSE
  carries only a fixed host-generated code + message (spawn-failed, timeout,
  forbidden, protocol, gave-up, reconnect-disabled, generation-stuck,
  connection-failed) — the raw transport text stays in the host log, because
  remote bodies can echo a credential in an encoding an in-process substring
  pass cannot catch. `disconnect` latches a manual stop keyed by the
  definition fingerprint that reconcile respects until the definition changes;
  `connect` clears it (and restarts a budget-exhausted handle); `test` probes
  on a throwaway connection unless the live generation is already connected, in
  which case it reports read-only. The status route also accepts
  `?server=NAME` and projects that single entry (a name outside
  `SERVER_NAME_PATTERN` keeps the shared `400 bad-request` envelope, an unknown
  name answers `ok:true` with an empty list, and an omitted or empty parameter
  keeps the untouched full view), so one card can refresh itself without
  re-reading the whole table.
- **A tool listing is one bounded, capability-gated fetch**: the 2.0 client
  aggregates the `tools/list` pages itself (`listMaxPages`, 64 by default) for
  `listTools(undefined, { cacheMode: 'refresh', timeout: timeoutMs })`, and the bridge
  refuses the sync above `MAX_SYNC_TOOLS` (= 2000) items or on a duplicated public
  name. A refused sync leaves the previous generation registered, so a hostile server
  can neither erase working tools nor inflate the scope; the operator's per-server
  deadline still bounds the fetch. The 1.x page-by-page loop and its repeated-cursor
  rejection are gone with that client.
- **Context footprint**: registered definitions are ordinary request tool schemas, so the
  host's context meter prices them under "Tool definitions". On 0.1.6+ the plugin also
  publishes one literal `mcp:<serverName>` section per connected server (that server's
  `initialize` instructions, attributed and capped at 32 KiB, `interpolate:false`); on
  0.1.5 it publishes none, because that host renders every section through its
  interpolator. See README §"What the model sees".

## 5. Host half — upstream contracts, mounting and deviations

### Files created

| File | Role |
|---|---|
| `src/tools.ts` | public name + ONE capability-gated, client-aggregated tool listing; definitions built by the official `createMcpToolDefinition` adapter when the host provides it, else by a verbatim port of that adapter (projection, validation, image admission, `finalizeContent`; runtime selection in `selectDefinitionBuilder`, parity asserted case by case) |
| `src/transport.ts` | async transport factory: env/headers resolved from credentials per attempt |
| `src/workspace.ts` | canonical-cwd → workspace-id helper |
| `src/server.ts` | per-server supervisor (official reconnect semantics, defs master state) |
| `src/agents.ts` | per-agent scope injection gate (never registers globally) |
| `src/manager.ts` | bridge orchestrator: handle lifecycle, credential events, applier ownership |
| `src/schema.ts` | `DocumentSchema` (schemastery) — NEW module beyond the original list |
| `src/routes.ts` | 0.0.3 runtime routes on the Connection carrier: `status` / `action` / `tools` (fixed host codes only; §(d)) |
| `src/server-context.ts` | per-server publication of the `mcp:<serverName>` instructions section and the `mcpResources` provider (the official `registerServerContext` shape) |
| `src/index.ts` | plugin entry (value exports exactly `name`/`inject`/`Config`/`apply`, plus type-only re-exports of the public model surface) |
| `tests/fixture/mcp-fixture-server.mjs` | spawnable real MCP stdio fixture on the 2.0 server packages (add/greet/fail/image/crash/admin.reset/dyn_add/env_probe; publishes instructions, oversized under `FIXTURE_HUGE_INSTRUCTIONS=1`) |
| `tests/tools.spec.ts`, `tests/host/{model,transport,server,server-context,agents,settings,manager,index,routes}.spec.ts` | the 9 `tests/host/` suites plus `tests/tools.spec.ts`, all green (11 client suites under `tests/client/`, 5 acceptance suites under `tests/acceptance/`; repo total 514 tests / 26 files) |

Run: `npm run typecheck` (both tsconfigs) and
`node node_modules/vitest/vitest.mjs run` — both fully green (514 tests / 26 files).

### (a) API signatures and runtime assumptions

1. **Cordis 4.0.2 fiber/inject semantics are load-bearing** :
   a plugin function body does NOT run until every `inject` entry resolves
   (`ctx.plugin` stays pending), and service property reads are resolved per
   context through the context's *fiber parent chain*: a read of
   `someCtx.someService` throws `cannot get property "X" without inject`
   unless some fiber in `someCtx`'s parent chain (a plugin applied on an
   ancestor context) *declared `X` in its `inject`* — the activator snapshots
   the resolved implementation into that fiber's `store`. Consequences:
   - `agent.ctx.tools.register()` works in production only because agent
     scope ctxs are created by `createScope(loopCtx, agent)` where the
     agent-loop fiber injected `tools`. The citation originally given for this
     (`dsh-agent-loop` static
     `inject = ['agents','sessions','llm','tools','systemPrompt']`) is **not
     reproducible at HEAD** — `@deepseek-ai/dsh-agent-loop` is not in the pinned
     dependency set — so the surviving, reproducible evidence is the
     real-registry, real-`dsh-scope` chain in `tests/host/agents.spec.ts`.
   - Tests must reproduce that chain (see recipe below).
   - `ctx.on` from inside a plugin fiber DOES reach root `ctx.emit` (listeners
     live in the shared events hook map keyed by ctx; untagged listeners are
     admitted for scoped carriers too). Earlier confusion was caused by a
     plugin body that never ran (missing injects), not by event routing.
2. **ToolRuntime mount**: `ToolRuntime` has `static inject = ['systemPrompt']`
   and its constructor calls `ctx.systemPrompt.tools(...)` unconditionally —
   the real `@deepseek-ai/dsh-system-prompt` must be mounted first
   (added as a devDependency; the pin is the 0.1.5-rc.2 generation at HEAD;
   official recipe `ctx.plugin(SystemPrompt)` then
   `ctx.plugin(ToolRuntime)`). `ctx.tools` only exists after that.
3. **`SettingsProvider.installSection(owner, ns, schema, entry, hooks)`**
   (present in both supported generations — re-checked in the pinned 0.1.5-rc.2
   `dsh-settings` d.ts): `setSource` hands a **LIVE thunk** — `current: () => T`
   — that must be *stored*, not called once: it returns the authoritative
   value at every read. `onChange` fires after each committed change; the
   `validate` hook throwing refuses the write (SettingsConflictError-style,
   host-side). `installSection` attach fires `setSource` then `onChange`.
   `entry` is the composition `base` typed `T` — pass `EMPTY_DOC`.
4. **dsh-tools layering**: `register()` calls
   `this.layers.effect(this.ctx, …)` — the layer is derived from the context
   the service was REACHED THROUGH (`agent.ctx.tools.register` ⇒ agent scope
   layer) and the disposer is owned by that context's fiber (dies with the
   agent scope ctx). `get(name, scopeKey?)` takes the scope key object
   (identity-compared) — the live Agent is its own key; omitted = global view.
5. **dsh-settings-file mounting**: `FileSettingsProvider` needs
   `dsh-atomic-write` and `dsh-home-paths` at runtime (installed as
   devDependencies). A plain `npm install`/`npm ci` resolves the dev tree — no
   peer relaxation. That was NOT true before the 0.1.5 migration: the devDep
   matrix mixed version lines, first because `dsh-client-runtime@0.1.1-rc.2`
   peered on an older `dsh-agent`, and (after that package left the release
   train) because pinning the umbrella's `0.1.5-rc.1` while upstream's own
   rc.1 peers resolve to rc.2 artifacts is internally inconsistent. Every
   `@deepseek-ai/*` devDep is now pinned to the generation a `dsh@0.1.5-rc.1`
   install actually resolves to (`0.1.5-rc.2`), which closes the conflict at
   the source. `resolveSpec`/`Config` match the runtime.
6. **SDK 1.30 high-level McpServer**: `registerTool` input schemas must be
   zod schemas or raw zod shapes — plain JSON-Schema objects throw
   (`inputSchema must be a Zod schema or raw shape`). Runtime
   `registerTool`/dynamic registration auto-sends
   `notifications/tools/list_changed` when connected (`sendToolListChanged`
   is not gated on client capabilities in this SDK build).
7. **Events payload types** arrive from `@deepseek-ai/dsh-agent`
   (`agent/created`, `agent/disposed`) and `@deepseek-ai/dsh-credentials`
   (`credentials/reference-updated(ref: CredentialRef)`) via type-only module
   imports (declaration merging); there are no exported event-name constants.

### (b) Test-mounting recipe (reproduce)

Mounting a REAL ToolRuntime + REAL agent scopes (used by
`tests/host/agents.spec.ts`):

```ts
const ctx = new Context()
await ctx.plugin(SystemPrompt)              // @deepseek-ai/dsh-system-prompt
await ctx.plugin(ToolRuntime)               // @deepseek-ai/dsh-tools (default export)
// tools-injecting "factory" ctx — agent scopes derive from it (see (a)1):
const factoryPlugin = function (c: Context) { factoryCtx = c }
factoryPlugin.inject = ['tools']
await ctx.plugin(factoryPlugin)
// agent: the AGENT OBJECT IS THE SCOPE KEY:
const scope = createScope(factoryCtx, agent as never)   // agent.ctx = scope.ctx
// drive the applier inside a plugin fiber:
await ctx.plugin(function install(c: Context) {
  applier = createAgentApplier({ ctx: c, logger: c.logger, agents: {roots, get},
    workspaceRegistry: { list }, overrides: () => overrides })
})
// publish agents like the real registry:
ctx.emit('agent/created', { agent })        // ctx.on listeners fire from root emits
// assertions:
ctx.tools.get('mcp__files__read_file', agentA) // visible; agentB/outsiders undefined
ctx.tools.get('mcp__files__read_file')         // ALWAYS undefined (global never touched)
```

Supervisor integration (`tests/host/server.spec.ts`) spawns the in-repo
fixture: `command: process.execPath`, `args: [tests/fixture/mcp-fixture-server.mjs]`
via `createTransport(def, resolver, warn)`; assertions poll `handle.state`
(syncId/generation/connected) with a 20–25 ms waitFor; reconnect delays are
shrunk via `reconnect: { initialDelayMs: 20–100, maxDelayMs: 60–500,
maxAttempts: 3–5 }` for speed. Settings spec mounts the REAL
`FileSettingsProvider({ path, watch: false })` on a temp `settings.yaml`
(`ctx.plugin(FileSettingsProvider, cfg)` awaited), then
`ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, EMPTY_DOC,
hooks)` and writes through `ctx.settings.update/mutate`.

Typecheck note: `tsc -p tsconfig.json` compiles the whole `src/` tree — the
parallel client-half work under `src/client/` must stay error-free for the
shared gate; my modules were developed against equivalent per-file `tsc`
flags and the full config is green at the time of writing.

### (c) Design deviations (and why)

1. **`src/schema.ts` added** (not in the original file list): the document
   schema needed to be importable by tests AND keep `src/index.ts` exports
   exactly `name`/`inject`/`Config`/`apply` (namespace-plugin contract). The
   entry imports `DocumentSchema` from it; no other export moved.
2. **Definitions are never registered by tools.ts/server.ts** — official
   `syncTools` registers into the registry of its own ctx; here defs live in
   the supervisor's master state and `src/agents.ts` registers them
   per-agent-scope only. Generation-swap discipline (fetch-then-commit,
   serialized chain, fetch failures keep the previous generation, commit =
   bump `syncId`/`generation` + notify manager) is otherwise the official
   algorithm, including the 5 s failure-close discipline and the stability
   window reset (uptime ≥ `maxDelayMs`).
3. **Rich content takes the same path on both generations.** 0.1.6+ runs the
   official adapter; 0.1.5 runs this plugin's verbatim port of it (the export does
   not exist there, but every service that path needs does — an `attachments`
   store, `llm.resolveModelInfo`, the execution's agent route, and the
   `finalizeContent` hook the 0.1.5 runtime invokes).
   A definition's text projection, canonical `{content, structuredContent?}`
   validation, `taskRequired` refusal and `isError` → throw are identical on both
   paths (asserted case by case in `tests/tools.spec.ts`). An image block becomes a
   durable attachment when the composition provides an `attachments` store AND
   the current model route declares image input; every other case projects the
   diagnostic `[image unavailable: <mime>; <reason>; raw image data remains
   available to programmatic callers]` while the canonical value keeps the raw
   blocks — base64 never reaches model history.
4. **Client identity** on the wire is `{name: 'dsh-chamber-mcp', version:
   <package.json version>}` — `src/server.ts` derives both from the package
   manifest (it reads `0.0.3` at HEAD); official sends `dsh-mcp-client`;
   server-facing semantics
   unchanged.
5. **Reconnect policy is fixed at official defaults** (`500→30_000 ms`,
   `maxAttempts: 10`) — the document schema has no reconnect fields
   (`Config = z.object({})`); `resolveReconnectPolicy` still exists for
   programmatic/test construction and mirrors official validation.
6. **Enablement is read LIVE per push/reconcile** (never cached in the
   applier): the first implementation snapshotted `overrides` at attach and
   only refreshed on `reconcile()`, which made defs pushes judge stale
   settings (caught by the gating tests). Design semantics: workspace
   membership is re-derived per event (one `workspaceRegistry.list()`
   snapshot per push/reconcile, one `realpathSync` per tracked agent);
   `reconcile()` is a plain diffed pass (no blanket force — the
   (epoch, syncId) idempotence guard plus live enablement make unchanged
   pairs no-ops and flips land); the dedupe key is (epoch, syncId) where the
   manager-owned per-server epoch bumps on every `startServer`, so a
   restarted handle's first commit (syncId restarts at 1) is never absorbed
   by the previous handle's last push.
7. **`mcp-scope(…):` log prefix** is used for every structured line
   (`server started/stopped`, `synced N tools (generation G)`, connection
   attempts, `agent … apply/revoke`, credential reconnects) so smoke logs can
   assert lifecycle; the manager/supervisor/applier all share one logger
   surface `{info, warn, error}` (ctx.logger-compatible).
8. **Semantic choices validated by tests**: after `agent/disposed` only
   bookkeeping is dropped (scope-layer entries are owned by the agent ctx's
   fiber and die with it — verified by disposing the scope ctx in tests);
   disposers are only invoked while the agent is still live in the registry
   (`agents.get(id) === agent`).
9. **Two host generations, selected at runtime.** The client layer is v2 on
   every host (`@modelcontextprotocol/client@2.0.0` is this plugin's OWN
   dependency, not a host surface), and the definition builder is chosen once per
   process from what the host provides: 0.1.6+ → the official
   `createMcpToolDefinition` (canonical validation, durable image admission),
   0.1.5 → the local text projection this plugin always shipped. Peers are
   `^0.1.5-rc.2 || ^0.1.6-alpha.1`.

   The adapter MUST be read off a namespace import. At 0.1.5 the package exists
   but exports only `{Config, apply, inject, name}`; a STATIC named import of a
   missing export is an ESM link-time `SyntaxError` that fails the whole cordis
   plugin tree — measured on the shipped 0.1.5-rc.2 anchor, where the dsh
   instance exited 1 with `plugin tree failed to load ... does not provide an
   export named 'createMcpToolDefinition'`. `@deepseek-ai/dsh-mcp-resources`
   (absent before 0.1.6) is an optional peer: its absence only removes the shared
   resource tools. The 2.0 client also deletes the hand-rolled `tools/list`
   pagination, its repeated-cursor/page caps and the legacy `toolResult`
   normalization — `listMaxPages` (default 64) is the non-converging-cursor
   defence and a 2025-era frame cannot reach this path.

   The two builders are INTERCHANGEABLE. The fallback is a verbatim port of the
   official implementation: same projection strings, same empty-value semantics
   (an entirely empty result reports `(<tool> returned no model-visible content)`
   while a text block that is itself empty stays empty), same `CallToolResult`
   validation and failure text, same `taskRequired` refusal and `isError` →
   throw, same canonical `{content, structuredContent?}` value, and the same
   durable image admission with its `finalizeContent` weak-map swap — 0.1.5's
   runtime invokes that hook too (`dsh-tools` reads `finalizeContent` from the
   definition). The two differ only in which module's code executes.
   `tests/tools.spec.ts` drives both builders through the same case matrix and
   asserts each against the other AND against literal strings, so neither the
   fallback nor a future adapter can drift unnoticed.
10. **One bound was kept, not deleted.** `MAX_SYNC_TOOLS` (2000) caps the TOTAL
    listed tools per server, because `listMaxPages` bounds PAGES and not items:
    64 pages × 1000 tools would otherwise drive unbounded per-agent registration
    fan-out (SEC-05). It is this plugin's own control, not SDK duplication.
11. **Attach-aware close discipline.** A failed attempt closes through its
    transport and owes NO client close event when the client never bound it (a
    spawn failure, or a negotiation probe that never attached); only an ATTACHED
    generation additionally holds the 5 s close barrier. Demanding a close event
    unconditionally turned a plain "command not found" into a permanent give-up
    (`failed generation did not close within 5000ms`). Measured on the 2.0
    client: `client.transport` is the attach signal (`Protocol` declares
    `get transport(): Transport | undefined`, so this is the SDK's own surface),
    an attached handshake failure lands its close event
    after ~2 s, and an unattached one never does. Note the 2.0 `mode: 'auto'`
    negotiation itself spawns a disposable SIBLING process per stdio connect to
    probe the era (visible in the smoke transcript: every connect starts two
    children); the SDK reaps that sibling before it starts the caller's transport,
    so it never overlaps the next generation.
12. **Two optional consumers, published per server.** Every supervised server
    contributes a literal `mcp:<serverName>` system-prompt section at the
    centrally allocated `MCP_SERVERS` order — but ONLY where the host allocates
    that order and honours `interpolate:false`, i.e. 0.1.6+. 0.1.5 has neither
    the key nor literal-section rendering: its renderer interpolates every
    section, so a server instruction containing `{{...}}` would either abort
    prompt assembly for the whole turn or be substituted with a host variable.
    The allocation key is therefore the capability probe, and publishing nothing
    there is exactly what 0.1.5 shipped. The section text is a LIVE read of the
    connection's established-generation instruction snapshot.
    Every server also contributes an `mcpResources` provider, so the
    service-owned `list_mcp_resources` / `list_mcp_resource_templates` /
    `read_mcp_resource` tools can reach it. Both ride `ctx.inject` and are
    disposed with the server handle; a composition that mounts neither degrades
    to no contribution. Instructions are published only by an ESTABLISHED
    generation (connect + initial discovery), bounded by `MAX_INSTRUCTION_BYTES`
    (32768) over the complete attributed value, and retracted on disposal AND on
    give-up — revoking the tools while leaving the prose up would keep telling
    the model to call `mcp__<server>__*` names that no longer exist.

### Remaining risks

- The full plugin `apply` (settings ns + manager inside one real composition
  with the actual dsh-base service stack) is not exercised end-to-end here —
  its pieces are (settings spec mounts the real provider + schema + hooks;
  manager spec drives reconcile with real fixture servers; agents spec drives
  the real gate). The M0/M1 smoke (anchor instance) remains the true
  end-to-end gate.
- `dsh-settings-file`/`dsh-atomic-write`/`dsh-home-paths`/`dsh-system-prompt`
  were added to devDependencies under the old cross-line matrix, which is what
  once required `--legacy-peer-deps`; the 0.1.5 migration pins the whole
  `@deepseek-ai/*` set to one generation and the flag is gone.
- `tests/fixture/mcp-fixture-server.mjs` child processes rely on repo
  `node_modules` resolution (spawned with `process.execPath` from the repo
  cwd); moving the fixture would break the supervisor/manager specs.

### (d) 0.0.3 — runtime status, manual control, timeouts

- **Carrier choice.** The status/actions ride `ctx.connection.fetch.register`
  (`/api/mcp-scope.status|action|tools`), the same seam the official
  `/api/present.host` (`dsh-client-ui-deliverables`) and `/api/session.export`
  (`dsh-session-log-export`) routes use, registered through a nested
  `ctx.inject(['connection'], …)` so a headless host never mounts them. A custom
  Remote namespace was rejected: the client assembly's namespaces are a
  compile-time selection this plugin cannot extend, and a custom RPC channel
  has no in-tree usage. Riding `/api` also means the chamber gateway's
  reverse proxy, Host/Origin fence and browser auth apply unchanged.
- **Snapshots.** `ServerHandle.snapshot()` maps the existing supervisor
  bookkeeping (connected/failedAttempts/reconnectTimer/connectedAt/syncedAt)
  onto the wire's phase vocabulary plus a sanitized `error`; `handle.tools()`
  returns the committed generation's identity (publicName/rawName/description)
  collected through the new optional `onListed` sink of `fetchToolDefinitions`
  and committed atomically with the definitions.
- **Error text never crosses the wire.** The status/action/tools routes carry
  ONLY a fixed host-generated code + message per failure (spawn-failed,
  timeout, forbidden, protocol, gave-up, reconnect-disabled, generation-stuck,
  connection-failed); the raw/sanitized transport text stays in the host log.
  The earlier `***`-redaction approach was removed: remote bodies
  (which the SDK embeds in errors) can echo a credential in an encoding the
  substring pass cannot catch, and "no secret in any response" is only
  enforceable by never sending the text.
- **Extra supervisor bookkeeping.** A generation that fails to
  close within 5 s now reports `failed` (`generation-stuck`) instead of
  `connecting` forever; `dispose()` clears the armed retry timestamp; a
  successful reconnect resets the consecutive-failure counter; `connect()` on a
  budget-exhausted (still tracked) handle disposes and restarts it;
  `toolList` answers not-connected unless the handle is currently connected;
  tool-list responses carry `total` next to `truncated`.
- **Prototype-safe sparse maps.** `pruneDisabled`/`renameDisabledKey` build
  their results with `Object.fromEntries`, so a literal `__proto__` key stays
  an own entry instead of mutating the prototype.
- **Manual stop.** `manualStopped` is keyed by the definition fingerprint: a
  reconcile with an unchanged definition leaves the server off, while a changed
  definition or `connect()` clears the latch. Disconnect stops with
  `revokeFirst=true`, so the model-visible tools disappear immediately.
- **Test semantics.** Connected → read-only report of the live generation (no
  second process/connection); otherwise a throwaway `probeServer` connect+sync.
- **Test additions.** `tests/host/server.spec.ts` (snapshot phases, tool
  identity, probe) and `tests/host/routes.spec.ts` (envelope + status codes);
  `tests/host/manager.spec.ts` grew the latch and runtime-control cases.

### (e) Deployment base path (browser half)

The three runtime routes are same-origin in a plain `dsh web` document, and the
store used root-relative paths on that assumption. The chamber desktop breaks
it: the shell serves the UI document from its own origin while the dsh server
listens on another port and is reachable only through the per-instance proxy
prefix (`/api/i/<instanceId>`). A root-relative request therefore hit the
shell's static layer, which answered `404 {"error":"not_found"}`, and every card
degraded to an unknown state.

Measured on the running chamber build (2026-09-15): the document injects NO base
global (only `__DSH_BOOT__` / `__DSH_CONNECTION_RECOVERY__`) and the UI runs in
the shell's own top-level document at `/` — there is no iframe. The prefix is
therefore derived from the SERVING DOCUMENT: its pathname when it is itself
served under the proxy, otherwise the newest same-origin resource URL in the
performance timeline (this plugin's own bundle is fetched from
`/api/i/<id>/plugins/…`). `window.__DSH_BASE_PATH__` is still honoured first
when a deployment publishes it.

The store resolves that prefix per call and tries it in order: the FRESHLY
detected base first (a live page can switch instance, and a remembered base that
still answers would silently serve the OLD instance), the remembered base, then
the root origin. Only an **origin-level 404 that carries no
plugin wire envelope** falls through to the next candidate — a transport error,
an auth refusal or a business failure would repeat identically, and a POST must
never be delivered twice. The base that answered is remembered and re-validated
on every call, so a stale guess self-heals. A value is accepted only when it is
a rooted same-origin path (absolute URLs would violate the shell's
`connect-src 'self'`), and an absent/unsafe value leaves the plain topology
byte-identical (one root-relative request). Version skew is safe in both
directions: an older host ignores `?server=` and answers the full view, which
the per-server merge folds correctly.

### (f) Registered-tools notice (conversation lane)

The plugin registers MCP tools into an agent's scope as ordinary tool schemas
(priced under "Tool definitions"), and on a host that provides the allocation key
it publishes a server's own `instructions` as a literal prompt section — but
neither told the user, in the conversation, which MCP servers and tools the
session had been given. This notice closes that gap as a UI hint — derived, never
written — through the platform's own seams rather than a new channel:

- **Why nothing is written**: a private session event is required-on-read. The
  persisted envelope's `ignorable?: true` marker is the only admission a reader
  honors for a type it does not know, and this generation has no write path that
  can set it (`Session.append` composes `type`/`seq`/`time`/`data` plus surface
  metadata only). `validateStoredEvents` refuses the WHOLE log when any stored
  event type is outside the build-generated `KNOWN_SESSION_EVENT_TYPES` set
  unless that envelope says `ignorable: true` — and out-of-repo plugin types are
  outside that set by construction. A host-appended `mcp-scope/injected` event
  therefore made the session unreadable to every reader, the writing harness
  included. Upstream rationale:
  `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`.
- **Source**: the two model-facing shapes ONE request can carry MCP tools in,
  both read from the harness's own events — the union is the registered set,
  whichever presentation produced it. `request/header.tools` is the tool array
  of a NATIVE presentation, so its `mcp__…` names are what that request's tools
  field carried; the rendered system prompt (via the Chat lane's own
  `system-message` Context, the same lookup its `request-prompt` definition
  performs) is where a `ptc` presentation declares the same tools, because under
  `ptc` the header lists only `run_code`. The row is therefore truthful (it
  names every MCP tool the request exposed), durable (it survives a reload from
  the stored log), and costs the session log nothing.
  `src/client/injection.ts` owns the extraction (the `mcp__` contract's own
  `[A-Za-z0-9_-]` alphabet, maximal run after the prefix — a public name is never
  split), the projection (grouped by longest-configured-prefix ownership, the
  same rule the tool-row lane uses, treated as a SET so a `both` presentation
  cannot double count) and the defensive payload reader; it carries the public
  NAMES each server contributed, not only the counts, bounded per server by
  `INJECTION_NAME_LIMIT` (256 — the transcript lane's own cap) with the
  remainder reported in the expanded body.
  With MCP OFF by default (§3), a session whose workspaces enable nothing
  exposes no MCP names, so the notice renders NO row there by design: the
  settings section is the surface that reports the off state, and the row appears
  the first time a request carries registered tools.
- **One row per CHANGED set**: `src/client/injection-row.tsx` registers a
  `ConversationNodeDefinition` on `ctx.uiConversation.events` — the same seam the
  Chat lane's own `request-prompt` definition uses for `request/header`. Every
  header owns a Context whose id is its own seq, so a bounded window can never
  produce a second `start` for one id; `start` compares its set against the
  nearest predecessor Context of this kind, so a re-sync with the same tools
  renders no node while a real change adds one line where it took effect.
- **Render**: one disclosure row in the shipped conversation-row chrome — the
  form the system-prompt card and the injected-context rows use: a 24px head
  with the plugin's own plug glyph, a hover/open chevron swap and the localized
  title ALONE (no source, no count: that is bookkeeping until asked for),
  expanding (click, or Enter/Space) into the shipped 141px code-block scrollport
  whose first line names every source and its count and whose remaining rows give
  each source its own disclosure over its public tool names. No shipped component is imported — the
  built client bundle may require nothing but react — so the geometry is
  reproduced in `src/client/styles.ts` against the same `--dsw-*` tokens, and it
  scales like the shipped rows do: the head, leading box and glyph add
  `--dsh-content-font-delta` and the labels defer to
  `--dsh-content-font-size-secondary`, so a non-default content-font setting
  cannot knock the row out of line with the cards next to it. The
  row is positioned as a header for the model-facing input that follows it: a
  hair BEFORE the system-prompt card that opens the request's step (mirroring the
  anchor the Chat lane's own `request-prompt` definition gives that card — the
  turn start for a first step, the step start afterwards). The card, the user
  message and every auto-injected context row follow it, and the header event
  that names the tools is the LAST event of that assembly; a window with no
  resolved step location falls back to the header's own neighborhood.
  Registration is behind a nested `ctx.inject(['uiConversation'])`, so a host
  without that service stays fully functional; malformed payloads render
  nothing instead of an error.
- Two client modules join `dsh.client.inject` for this
  (`dsh-client-ui-chat`, `dsh-client-ui-conversation`).

## 6. Browser half — section, forms and lane (overview)

- Browser plugin exports `inject = ['slots','locale','remote','remote.credentials','settingsScope','workspaces','sessions']` + `apply(ctx)`; registers locale ns `mcp-scope.settings` ({en, zh}) then
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
  id:'mcp-scope', order: 25, label: t-thunk, locale: NS,
  inject: () => ({ ...face, hooks: { ...face.hooks, runtime }, refreshRuntime,
  connectServer, disconnectServer, testServer, loadTools }) }, McpScopeSection))` — no child slots (the
  framework's InjectFace maps `face.hooks.doc` → the `useDoc` prop; actions
  pass through verbatim; verified against the shipped renderer).
- **Transcript lane (0.0.2 line)**: the same half owns how MCP calls render, by
  registering one keyed `tool.call.toolview` entry per discovered exact wire name
  (`mcp__<server>__<tool>`). Names are discovered client-side from the staged
  session's event window — every `request/header` (`header.tools[]`, the full
  model-facing array) **and** every `tool/call` (`data.name`), because the window
  is a bounded tail page while headers are emitted at loop boundaries rather
  than per turn, so the call events are what guarantee a rendered row is known.
  The lane therefore needs
  **no host API and no new bundle dependency**; server identity comes from the
  settings document (longest configured `serverName` prefix), the view set is
  reconciled under a 256-entry cap, rows register at shadowing rank 1 (an
  official row for the same wire name wins, and a same-key/same-priority pair —
  which throws in the slot core — is impossible), and an unregistered/over-cap
  name keeps the shipped generic row. `dsh.client.inject` names the eight
  modules the browser half actually calls (`dsh-client-locale`,
  `dsh-client-ui-renderer`, `dsh-client-ui-settings`, `dsh-client-ui-tool`,
  `dsh-client-ui-chat`, `dsh-client-ui-conversation`, `dsh-api-remotes`,
  `dsh-api-workspace-controller`); the provider of `ctx.sessions` is NOT named
  there because its module id is generation-dependent. Detail and evidence: §6.
- Data: `ctx.settingsScope.bind<Doc>({ namespace:'mcp-scope', decode: decodeDoc })` → snapshot
  {status, value, revision, writable}; workspaces via global `useWorkspaces`.
- Views: server cards (name, transport, "on in N workspaces" / "not on in any
  workspace", edit, remove, per-workspace enable rows with a default-off note),
  staged Add/Edit form (serverName + transport toggle +
  command/args list/cwd/env key rows | url/header name+ref rows, secret inputs write-only),
  Save = credentials.set dirty secrets first → `scope.mutate([...ops], expectedRevision)`;
  removal cascades to refs no longer referenced (credentials.unset). Edit reopens the same
  staged form with the existing definition and writes the same op shape.
- Hand-written controls (official card-form pattern); no generic schema-form.
- Update cadence: scope.subscribe + `ctx.remote.$on('settings/document-updated')` +
  `credentials/reference-updated` for badge refresh; `connection/reset` and
  each document revision re-pull the runtime snapshot.
- **Runtime store (0.0.3)**: `src/client/runtime.ts` reads the three routes
  with global `fetch` (no client package import, keeping the react-only
  bundle), dedupes refreshes and owns no timer; the section polls it every 5 s
  while visible. Missing routes / failed calls degrade the cards to "runtime
  status unavailable" while every document feature keeps working. Cards show
  the status dot/label, a localized failure line derived from the host code,
  Connect/Disconnect/Test (Test gated on a runtime view) and a `Tools (N)`
  disclosure whose table refetches per sync generation.
- **Per-server refresh and stale views.** `refresh({ server })` asks the
  status route for one entry, merges it and publishes once; a failure rejects
  to the calling card and leaves the snapshot untouched. A failed FULL refresh
  keeps the last good views (stale-while-revalidate) and the section shows a
  compact stale banner with a retry instead of blanking every card. Each card
  owns a refresh/retry button (busy while in flight, the failed card promotes
  its Connect action to the accent-filled retry), so one flapping server no
  longer costs a full-table re-read.
- **Enabled workspaces instead of a row per workspace.** Workspace rows
  collapse to the ENABLED set; with none enabled the card shows one summary line
  ("all N workspaces are off by default"), and a manage toggle reveals every row
  with bulk on/off (the bulk pair appears once more than one workspace exists, §6).
  This is purely local UI state — no settings write — and the default-off
  sentence appears exactly once per locale.
- The staged form gained the enable switch, `timeoutMs`, an unsaved-changes
  guard on every dismissal path, clipboard paste helpers and a single-server
  JSON import (`src/client/import.ts`, pure and unit-tested); the section adds
  a name filter and per-card bulk workspace switches (one mutation per action).
### Files (browser half)

| file | role |
|---|---|
| `src/client/index.ts` | browser entry: `inject` + `apply` (locale, controller wiring, `settings.section` registration) |
| `src/client/locales.ts` | flat `SettingsKey` union + `en`/`zh` dictionaries + `NS = 'mcp-scope.settings'` |
| `src/client/controller.ts` | framework-free domain core: scope store, credentials badge state, save pipelines, pure plan helpers |
| `src/client/section.tsx` | `McpScopeSection` page component (+ composed-props interface, outcome→text mapping) |
| `src/client/server-card.tsx` | one server card: badges, per-workspace on/off rows, remove cascade confirm |
| `src/client/add-form.tsx` | staged add form (transport switch, stdio/http fields, write-only secret rows, draft validation) |
| `src/client/import.ts` | 0.0.3 single-server JSON import (`mcpServers` / VS Code `servers` / opencode `mcp`, flat and array shapes → draft; tolerant of a brace-less or torn section (with or without the `mcp` wrapper, dangling separators/closers included), comments, trailing commas, fences and prose; candidates are tried until one resolves a server, so an example snippet above the real config cannot shadow it; discovery is iterative and bounded, so a deeply nested paste cannot throw; `env` takes a map or a `{name,value}` list; secrets land write-only) |
| `src/client/runtime.ts` | 0.0.3 runtime store over the three host routes: status/action/tool-list reads (`refresh`/`act`/`test`/`tools`); pending-action state lives in the card (§6) |
| `src/client/styles.ts` | style seat: the plugin's stylesheet, its class-name map, and the `data-plugin-css` tag mount (§9) |
| `src/client/nav-icon.ts` | settings sidebar glyph: paints the plugin's plug mark into OUR nav row (§9.4), because the shell picks the mark from a hardcoded map by section id and the registration carries no icon option |
| `src/client/workspaces.ts` | minimal workspace-row narrowing (typed items) |
| `src/client/tool-card/{names,icon,row,view,register}.ts(x)` | transcript lane: MCP tool identity from the session's request header, the keyed tool view, and its registration lifecycle (§6, §5(f)) |
| `tests/client/{controller,locales,styles,section-render,tool-card,tool-register,import,runtime,injection,injection-row}.spec.ts(x)` | browser-half vitest suites (10 files) |
| `tests/acceptance/{copy,store,host-route,styles,section}.acceptance.spec.ts(x)` | independent acceptance suites (contract C1–C4) driven through the real components/manager |
| `tests/client/injection.ts` lane contract | see §5(f) for the notice and §6 for the lane |

Also edited (build-gate fixes, see `docs/RELEASE.md`): `tsconfig.json` (added `DOM` lib),
`tsconfig.tests.json` (override the inherited `tests` exclude).

### The two lanes at a glance

Two conversation-lane surfaces are easy to conflate: the per-call **MCP tool row**
(registered per exact wire name through the keyed `tool.call.toolview` slot) and
the **registered-tools notice** (§5(f), derived from the request's tool array
and the rendered system prompt). The first renders one node per call, the second
one line per non-empty change — an unchanged or emptied set adds none; neither
writes anything into a session.

One tool call — `src/client/tool-card/row.tsx`, styles in `styles.ts` (`toolHead`
is a 24px row, `toolLeading` the 16px slot):

```
● | ⌄ | plug   github · search_issues   ·   acme   [Streamable HTTP]   412ms
└── 16px ──┘   └── server · tool ──┘    sep   └ summary ┘   └ transport tag ┘   └ dur ┘
  │ Input
  │ {"owner": "acme"}
  │ Output
  │ {"total_count": 3, "items": [ … ]}
```

Exactly one leading mark is drawn — the terminal-state dot (`●`,
`data-state='error'` red / `data-state='warning'` amber), the chevron once the
row is open or, on an expandable row that has not reached a terminal state,
while hovered (`⌄`), else the plug glyph; a terminal row therefore keeps its dot
on hover. The title is
`serverName · toolName`; the gap before the summary is the shipped 2×2
caption-dot separator (`toolSep`, `aria-hidden`), not a punctuation character;
the transport tag appears whenever the identity carries a transport — a running
row shows it too — and only the duration waits for the call to settle. The
expanded body is a left-ruled block (`toolBody`): the Input block appears when
the call carried arguments, and the Output label is always present — a running
call says Running…, a settled call with no text says No output.

One notice row — `src/client/injection-row.tsx`, styles in `styles.ts`
(`injectionRoot`/`injectionHead`/`injectionBody`: the shipped disclosure-row
chrome, no pill and no card of its own):

```
[plug]   MCP registered

         expanded (click), which leads with ONE line of every source + count:
           zotero (43) · email (18)
         then one disclosure per source, each closed, each opening its own names:
           › zotero (43)
           ⌄ email (18)
             mcp__email__send
             mcp__email__list_emails_metadata
             …
```

The collapsed row carries NO source and NO count: a transcript line that lists
what a session registered is noise until asked, and the counts are one click
away. The expanded body leads with the summary line and gives every source its
own disclosure, so a long server list never buries a single server's names.

The row sits immediately BEFORE the system-prompt card of the request it
describes: it is a UI hint about what that request registered, not a row of the
prompt, the request, or the conversation.

A server that listed more than `INJECTION_NAME_LIMIT` (256) tools ends its
block with the localized `injection.omitted` line naming the remainder; a
server whose list fits omits nothing.

The strings are the en dictionary (`src/client/locales.ts`: `injection.title` =
`MCP registered`, `injection.entry` = `{name} ({count})` joined with `·` for the
summary line and used per source disclosure, `injection.omitted` for names past
the cap); the
plug and chevron are the plugin's own inline glyphs (`tool-card/icon.tsx`, the
chevron is the shipped `IconChevronDownOutline14` geometry). Rules lane
derives, each traceable to source:

- **One Context per `request/header`.** `match()` answers every `request/header`
  with `{ id: String(seq), role: 'start' }` (the registered Definition's `match()`
  in `injection-row.tsx`), so a
  bounded window can never produce a second `start` for one id and every header
  keeps its own row position.
- **An identical signature is not rendered again.** The signature is the
  `name:count:names` key over the name-sorted server list (the names are part of
  the key, so a same-count tool swap is still a change); `start()` compares it
  against the nearest predecessor Context of this kind and an unchanged set
  renders no node (`buildViewNode()` returns null until the list changes again);
  an empty set has nothing to announce either.
- **Position.** `anchorSeq = cardAnchor + INJECTION_CARD_OFFSET` where the card
  anchor mirrors the official `requestPromptAnchor` (`dsh-client-ui-chat`,
  `request-prompt.js`) rule for rule, four guards included: an unresolved
  location, a series whose predecessor left the loaded window (no predecessor AND
  a reason other than `initial`), and a header repeating its predecessor's
  turn/step all put the card on the header event itself — the row then follows at
  `header.seq - 0.1`; otherwise the card sits at `turn.start.seq` for the first
  step of a turn and at `step.start.seq` afterwards. Copying the whole rule
  rather than its common branch keeps the row on the card's left in every window
  shape, ahead of the user message and every auto-injected context row that
  follow it in seq order.
- **The node declares a SESSION location, not the request's step.** The Chat lane
  re-anchors any turn/step-located node sitting before the turn's opening human
  input onto that input at rank 2 (rendering it after the user message and the
  collapsed process control) and folds process-window members away in the compact
  view; a location that is neither turn nor step short-circuits both rules to
  `{ anchor: anchorSeq, rank: 0 }`. The row is session-scoped by nature, so this
  is the honest location as well as the one that keeps the hint immediately
  before the system-prompt card.
- **Dual source.** `start()` projects the union of the request's tool array
  (`header.tools`) and the names its effective system prompt declares
  (`reader.previous('system-message')?.state.effective.text`, the lookup the Chat
  lane's `request-prompt` definition itself performs). Under a `ptc` preset the
  header carries only `run_code` and the SDK section carries the names; under
  `native` the prompt declares none. Extraction uses the `mcp__` contract's own
  `[A-Za-z0-9_-]` alphabet, never splits a name into server/tool parts, and takes
  only DECLARATION positions — the `name:` member the TypeScript renderer emits
  and the `async def name(` / `# tools["name"](…)` forms the Python one does — so
  a tool description (rendered into the same block as a JSDoc line) that merely
  mentions another tool's name is not read as a registration. A name is reported
  only when a CONFIGURED server owns it: the tool-row lane deliberately falls
  back to the first `__` boundary for historical calls, but a registration with
  no configured owner would claim a server that does not exist.
- **Materialised rows are only hidden, never withdrawn.** A later evaluation can
  flip a Context to unchanged or empty (a prepended history page supplies the
  predecessor, or a live settings edit re-shapes server ownership); it then
  re-emits the same key with `visibility: 'hidden'` instead of returning null,
  because the engine rejects a definition that withdraws a materialized target
  (the materialized check and the hidden re-emission in `buildViewNode()`,
  `injection-row.tsx`, `buildViewNode()`).

## 7. Browser half — type and runtime contracts

### 7.1 `settings.section` registration & component typing (slots)
- Registration options on rc.1 `ctx.slots.register` are `{ name, children?,
  store?, locale?, inject?, ...kindOptions }` where list-kind requires `id`,
  optional `order`/`label` (`SlotLabel = string | (() => string)`); the
  component is checked at the call site against the composed props computed
  from the inject factory return + locale namespace (`SlotCore.register` in
  `dsh-client-ui-slots/lib/types/index.d.ts`). We declare **no children**
  (page-internal rows, no nested slot seats) — `children` declarations are
  optional and claiming them obliges consuming `renderSlot`.
- The section's own props are declared explicitly in
  `McpScopeSectionProps` (section.tsx): owner `close`, locale `t`, framework
  hooks `useDoc` + `useWorkspaces`, the seven document actions (`addServer`,
  `replaceServer`, `removeServer`, `toggleWorkspace`, `toggleWorkspaces`,
  `setServerEnabled`, `unsetCredential`) plus the runtime members, re-stated
  with locally-resolvable types. Reason: the official composed type
  (`PropsRuntime`/`InjectFace`/`SnapshotSelectorHook`) rides
  `@deepseek-ai/dsh-client-store` re-exports that are **not installed in this
  dev tree**, so every hook member collapses to `any` there; the register
  site still validates our interface structurally (contravariant params,
  `any` assignable both ways). If `dsh-client-store` types ever land in the
  tree, prefer the official `PropsRuntime<'settings.section'> & PropsLocale<NS>
  & InjectFace<McpScopeFace>` intersection again.
- The `hooks: { doc: source }` inject compartment binds the component prop
  `useDoc` (renderer converts `name` → `use<Capitalized>`). Our source is a
  plain `{ getSnapshot, subscribe }` observable (uSES-safe stable snapshot
  between publishes) — no `dsh-client-store` value dependency.
- `inject = ['slots','locale','remote','remote.credentials','settingsScope',
  'workspaces','sessions']` exactly as assigned — `sessions` was added by the 0.0.2
  transcript lane (`src/client/index.ts`; without it the lane stays off) (`connection` was dropped —
  grep-proven unused; `remote.credentials` is the real credentials gateway,
  see §7.3).

### 7.2 Forwarded remote events (verified)
`dsh-api-remotes/lib/types/remote-events.d.ts` (installed 0.1.2-rc.1) is the
one allowlist: `'settings/document-updated'` (emit, listener `(ns, revision)
=> void` — payload from `@deepseek-ai/dsh-settings/types` cordis `Events`
merge: `(ns: SettingsNamespace, revision: number)`) and
`'credentials/reference-updated'` (emit, `(ref: CredentialRef) => void` from
`@deepseek-ai/dsh-credentials/types`). We subscribe to both via
`ctx.remote.$on`, filter the document event by `MCP_SCOPE_NAMESPACE`
('mcp-scope'), and re-read through the controller (scope mirror already
refreshes itself inside the ui-settings provider; our handler re-publishes
the store and re-describes credential badges).

### 7.3 `connection.api` does not exist — the credentials face is `ctx.remote.credentials`
On the supported runtime:
- `dsh-client-connection`'s `ConnectionHandle` has no `.api` member at all
  (`lib/types/client/index.d.ts` — only `rpc`/`generation`/`state`…).
- The settings+credentials RPC groups were generated into the Remote
  assembly: anchor `dsh-api-settings-controller/lib/typert.remote-client.d.ts`
  declares `TypertRemoteNamespaceMap { 'credentials': { describe(refs:
  string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>; set(ref,
  value: string): Promise<RemoteResult<void>>; unset(ref: string):
  Promise<RemoteResult<void>> } … }`, mounted by `dsh-api-remotes/client`
  next to `settings`. Official rc.1 settings cards document exactly this:
  "whose `remote.credentials` namespace answers for the credential the
  section references" (web-search-card-controller.d.ts).
- So `apply` wraps `ctx.remote.credentials` into a `CredentialsGateway` that
  folds the Typert `RemoteResult` union (`{ok:true,value} | {ok:false,error}`)
  into thrown errors (remote failures never throw on their own). The local
  `McpRemoteWire` interface in `src/client/index.ts` re-states that surface
  because `@deepseek-ai/dsh-api-settings-controller` (which generates the
  settings/credentials remote namespaces) is still absent from the dev tree, so
  those d.ts imports are unresolvable there and `skipLibCheck` collapses
  `ctx.remote`; the anchor's generated d.ts remain authoritative for the runtime
  shape. (`@deepseek-ai/dsh-api-gateway`, named in the original rationale, **is**
  present in `node_modules` at HEAD as a transitive dependency — that half of the
  reason no longer holds.)

### 7.4 `ctx.effect` typing (no local patch remains)
cordis augments its own `Context` with `effect` via a RELATIVE module
augmentation (`declare module './context.ts'` in `fiber.d.ts`), which against a
shipped d.ts-only package resolves to no file under NodeNext and silently never
merges. The original mitigation was a localized structural `FiberAwareContext`
intersection in `src/client/index.ts`; the 0.1.5 client-contract re-point made
that unnecessary, and **that symbol no longer exists anywhere in `src/`** —
`src/client/index.ts` now records that no local structural patch is needed and
calls `ctx.effect(...)` directly. Runtime was never affected (effect is mixed
onto the proxied context).

### 7.5 Settings path-op contract (mutate)
`SettingsPathOpView = {op:'set', path: string[], value: JsonValue} |
{op:'unset', path: string[]}` (`@deepseek-ai/dsh-settings/types`,
"set creates intermediate objects, unset removes"). We did NOT confirm host
array-index path semantics, so per the brief the safe default is used: the
servers array is written as ONE `set ['servers']` whole-array op per save,
and per-workspace switches are atomic `set`/`unset` ops at
`['overrides', <workspaceId>, <serverName>]` (+ row-level `unset` when the
row empties). `scope.mutate(ops, expectedRevision?)` with the revision
captured before the write; on rejection the scope already performs its
recovery re-read, and the controller additionally re-publishes (conflict
text shown; snapshot stays fresh).

### 7.6 Workspace enumeration
Global standard hook `useWorkspaces` is present on every root-slot component.
At HEAD the merge comes from
`@deepseek-ai/dsh-api-workspace-controller/client` (0.1.5 — the package that also
declares the `ctx.workspaces` service this plugin injects); the 0.1.2-era
`dsh-client-runtime` is off the upstream release train and is no longer a
dependency or a cast site. `src/client/workspaces.ts` narrows each row to the
fields it renders through its own `WorkspaceItem` interface, which
`WorkspaceView` structurally satisfies — **no cast is needed**. `workspaceId` is
a branded string on the wire; treat as string for path ops (the shared model
indexes plain strings).

## 8. Browser half — semantics and risk notes
- Save order is secrets-first-then-document per the brief: dirty literal
  secrets are `credentials.set` sequentially BEFORE `scope.mutate`; a
  per-ref failure aborts with `secret-write-failed` + the failing refs
  (partial secret writes may have landed — the doc is untouched; no
  rollback exists in the credentials domain). On document success, refs
  orphaned by the removal diff are `credentials.unset` best-effort (refusals
  — e.g. inherited-env shadowing — do not fail the committed removal).
- Failures are classified by the typed `code`
  (`settings/conflict` / `SETTINGS_CONFLICT`) and the `isDSHRemoteError`
  marker first, with the message scan demoted to a non-platform fallback
  (`classifySaveError`, controller.ts). Business refusals on this runtime do
  not throw at all: the scope client recovers and RESOLVES, so the pipeline
  verifies the write LANDED by re-reading and comparing the document
  (`docsEqual`) — a refused write surfaces as `conflict`, never as success.
- `addServer` guards `validateDoc(next)` again before writing (belt against
  UI-only validation drift); UI also validates name pattern/duplicates,
  required command/url, URL format (http(s) parse), env-key/header-name
  duplicates, header name non-empty, and env-style refs.
- `decodeDoc` canonicalizes: missing/non-object sections → empty doc; empty
  override rows and non-`true` literals pruned (schema-valid docs only carry
  literal `true`; the model's presence semantics stay consistent).
- The workspace rows show real workspaces only (`useWorkspaces` items) — no
  "all workspaces" pseudo-row — with the empty state text when none exist.
- Locale: both built-in locales registered in ONE call under namespace
  `mcp-scope.settings` with the `LocaleNamespaceMap` augmentation; every
  rendered string (labels, hints, validation, error banners, confirm copy)
  comes from the dictionaries — no hardcoded UI English. Namespace key union
  is compile-checked at both the register site and every `t()` call.
- Remaining runtime unknowns: (1) whether the settings scope's decode
  hook sees `{servers:[], overrides:{}}` defaults when the host registered no
  user layer (we treat `value === undefined` as empty doc, fine either way);
  (2) ~~exact settings-conflict remote error shape~~ — **RESOLVED**: the host
  refuses the write and the controller reports it as a conflict, never as
  success (`applyOps` read-back), and the captured error is in the M0 smoke
  transcript (`.smoke/logs/M0-raw.log`, a gitignored scratch path); (3) whether
  HMR/unload ordering ever races the remote `$on` disposers with
  `controller.start()` (all disposers are fiber-owned through one effect).

## 9. Browser half — style seat

The first pass rendered the section as "non-native in both themes": raw `<button>`/`<input>`
with inline styles and literal colours (`rgba(192,57,43,…)`, `#c0392b`,
`rgba(127,127,127,…)`), nothing reading the theme. `src/client/styles.ts` now
owns the surface's chrome.

### 9.1 Why a stylesheet string, not CSS modules or the primitives

The purity invariant (AGENTS.md) allows `lib/client.js` to require only
`react`/`react/jsx-runtime`, so all `@deepseek-ai/*` imports stay type-only —
which rules out the official CSS-module bundles (built for their own packages)
and also the `ui-primitives` components. The plugin therefore does what the
official bundles do internally: ship the CSS as text and append one
`style[data-plugin="dsh-chamber-mcp"][data-plugin-css="dsh-chamber-mcp/client.styles.css"]`
tag. `mountStyles()` runs in `apply` through `ctx.effect`.

Two things go beyond the official guard-and-append, because a bare "does the
tag exist?" check has two failure modes that matter here:

- **refresh** — a tag left by an earlier revision is re-filled with the current
  sheet, because an HMR cycle may apply the new code *before* the outgoing
  fiber's disposer runs; without it the page would keep painting the previous
  revision;
- **ownership count** — the number of live mounts lives on the tag
  (`data-refs`), so a second copy of this plugin in the same document (the
  chamber shell can host more than one instance per page) shares the one
  stylesheet, and whichever unloads first cannot strip it from under the other.
  The last disposer removes the tag.

Mirroring the primitive CSS rather than importing it also keeps the plugin
working across the peer range (`^0.1.5-rc.2 || ^0.1.6-alpha.1`) without a
compile-time dependency on the primitives' JS API — the geometry is copied
from the pinned generation, which §9.3 pins property by property.

### 9.2 What was replaced

| before | now |
|---|---|
| inline styles with literal colours/heights | classes off one token-only stylesheet |
| `border: 1px dashed rgba(127,127,127,.5)` form box | the panel's editing surface (`bg-module-platform`, r12, 14/16 padding) |
| raw `<button>` (OS default chrome) | `ui-primitives` Button capsules: `size="sm"` (h28/r14) for row and header actions, the figma `md` capsule (h36/r18) for the form footer; `outline` for dismiss/secondary, `primary` for commit, danger tint for destructive actions |
| raw `<input>` (OS default chrome) | official field vocabulary: h34/r8, `border-l4` hairline, `bg-layer-1`, 13px, `brand-primary` focus border, `label-dimmed` placeholder, dimmed when disabled, error border when invalid |
| raw `<input type="checkbox" role="switch">` | the Switch primitive's look (36×20 track, `brand-primary` when on, 16px thumb, 120ms slide) driven by the same controlled checkbox through `:checked`. The invisible input fills its box, so the box carries a 4px slop (with a cancelling negative margin) — a 44×28 target around the unchanged track. In a workspace row the label spans the WHOLE text run and only the ON state is spelled out (that word is `aria-hidden`, since `role="switch"` + `checked` already say it — a column of "Off" beside a switch that reads off is noise). The expanded block LEADS with the bulk pair so a long list cannot push it past the fold, and past five workspaces it grows a name filter whose narrowing scopes that pair (`All on (N shown)`, and the pair is inert when nothing matches); the query is dropped when its input goes away, so deleting workspaces down past the threshold cannot strand hidden rows behind a control that is no longer there. The rows are a responsive `auto-fill / minmax(200px, 1fr)` grid (a truncated name keeps its full text in `title`), and the row order is frozen when the list opens (enabled first) so a toggle never moves a row out from under the pointer |
| native radios | the Pill primitive's pill (24px/r12, ghost-active fill + inset ring when selected) over the same real radios |
| literal-colour banners (`#c0392b` / green box) | token notices: failures on the danger tint with `state-error` text, the saved note as `state-success` text |
| opaque spans for transport/summary/credentials | the Tag pill (999px + `corner-shape: round`, 11/17) with the Tag tone palette: `outline` for the transport, `success`/`warning` (10%/12% `color-mix`) for configured/unconfigured refs, neutral for unknown |

### 9.3 Alignment table (checked, not asserted)

Every value below was read from the pinned dsh sheets (vendored upstream
packages at the authoring machine's
`/root/projects/dsh-chamber/vendor/harness-packages/@deepseek-ai` — not a path
inside this repo) and then verified against the
rendered surface with the local UI-preview harness — a Chromium audit of
`getComputedStyle` in both themes plus a source-level property diff. That harness
needs a running chamber build and therefore lives in the gitignored `.smoke/`
scratch tree: the table records the run, not a committed artifact. "same" =
byte-equal declaration.

| surface | reference (official) | result |
|---|---|---|
| section column | `ui-settings-models` `.section` | same (flex column, gap 12, max-width 720, `label-primary`) |
| section title | `.title` | same (16px/24px, 500) |
| header action / row actions | `ui-primitives` Button `.sm` + `outline` (what the official `settings.action` seat renders) | same (h28, r14, 0 10px, 12/18, `border-l3`); Edit / Remove / Disconnect / Test share that one capsule — one neutral frame — and the destructive action differs only by the error token on its LABEL |

### 9.4 Settings sidebar glyph (the one patch the shell forces)

The settings nav row's mark is shell-owned: `navIcon(id)` hardcodes one per known
section id (`models`, `agent-presets`, `plugins`, and `archived-sessions` on
0.1.6) and falls back to the shipped settings gear for every other id — true in
BOTH supported generations, which also give a registrant no `icon` option and no
icon seat. Our row would therefore keep the gear, so `src/client/nav-icon.ts`
paints the plugin's own plug mark into it: the row is matched by the one fact the
shell renders from our registration (the localized `nav` label) and accepted only
in the shell's own shape (a button whose two element children are the glyph svg
and the label span), the replacement carries the shell glyph's class so sizing
and colour stay shell-owned, and a marker attribute makes re-application
idempotent. The sweep is scoped to the panel (`[role="dialog"]`, both
generations) and to `button > span`, so it never walks the chat DOM and a
same-labelled control elsewhere cannot match. Repaints ride a capture-phase click
(opening the panel renders the rows), a childList observer scoped to the row's own
list, and the locale feed; a document observer covers a panel opened WITHOUT a
click, and it is disconnected the moment the row is found (and its callback only
fires while a panel is on the page, so a streaming chat costs one selector probe
per mutation batch, never a scan). A renamed DOM shape, a composition without the
settings panel or a different label all degrade to the shipped gear, and nothing
in the patch throws. `verify-client-artifact` seeds a shell-shaped row before the
mount and fails if the wiring stops painting it.

## 10. Settings UI layout reference

Structural reference for the shipped browser half, derived from the components and
the style seat — open *Settings → MCP servers* in a live GUI for the rendered
result. Wireframe: [`mcp-desktop-layout.svg`](mcp-desktop-layout.svg); the labels
below follow the zh locale (the en locale is key-for-key identical,
`src/client/locales.ts`).

### Where it lives

Registered into the official settings shell through the `settings.section` slot
(`id: mcp-scope`, `order: 25`): one column, max-width 720 px, gap 12 px, no child
slots, never replacing the shell.

```
┌──────────────────────── dsh Web GUI / chamber desktop ────────────────────────┐
│ ┌──────────┐ ┌──────────────────── Settings ────────────────────────────────┐ │
│ │ sidebar  │ │ ┌───────────┐ ┌──────────── MCP 服务器 ──────────────────┐ │ │
│ │          │ │ │ settings  │ │  标题                  [+ 添加服务器]      │ │ │
│ │ …        │ │ │ nav       │ │  ── 卡片列表（见下）─────────────────────  │ │ │
│ │ 设置 ◀   │ │ │ 通用      │ │                                           │ │ │
│ │          │ │ │ 模型      │ │                                           │ │ │
│ │          │ │ │ 插件      │ │                                           │ │ │
│ │          │ │ │ MCP 服务器◀│ │                                           │ │ │
│ │          │ │ └───────────┘ └───────────────────────────────────────────┘ │ │
│ └──────────┘ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Card anatomy (top → bottom)

```
(◉) github   [流式 HTTP]   [移除] [编辑]                     ← 卡头
● 已连接 · 12 个工具                    [断开] [测试] [工具 (12)]
┌ 工具（展开后） ────────────────────────────────────────────┐
│ search_issues — Search issues                              │
│ 共 120 个工具，显示前 2 个。                                │
└────────────────────────────────────────────────────────────┘
管理 workspace：[管理 workspace（已开启 1）]                  ← 折叠态
  · alpha (switch) 开启            ← 只列显式开启的 workspace
  · 全部 3 个 workspace 默认关闭   ← 无显式开启时的单行摘要
npx -y @modelcontextprotocol/server-github                   ← 定义
工作目录：/srv/github
Authorization  AUTH_TOKEN  已配置  [清除]                    ← 凭据徽标
```

**管理 workspace（N）** is local UI state and never writes the settings document:
expanding it replaces the enabled block with every workspace row plus
**全部开启 / 全部关闭** (only when more than one workspace exists) and the
"默认关闭：仅在下面显式开启的 workspace 中注入工具" note. A single-workspace dsh
reaches its only row the same way — a collapsed view would otherwise hide the only
switch, and MCP is off until it is flipped. Cards are
listed in document order; an open add/edit form renders above the list; removing
a server replaces the action row with the confirmation until it is confirmed or
cancelled.

### Interactions worth knowing

- There is no global **刷新状态** control in the section header. The runtime
  snapshot refreshes by itself: once per settings-document revision, then on a
  5 s interval while the panel is visible, and per card through that card's own
  **刷新状态** button (only that server re-reads). A failed full refresh keeps
  the last good views (stale-while-revalidate), stores the failure (HTTP status
  included) on the snapshot, and shows the stale banner instead of blanking the
  panel; the stale banner's **重试** button is the only whole-table manual
  refresh left.
- **Connect / Disconnect** are real stop/start actions (a manual stop latches
  until the definition changes or Connect is pressed); **Test** probes on a
  throwaway connection unless the live generation is already connected.
- Save order: dirty credential values first (`credentials.set`), then ONE
  revision-fenced `mutate` of the settings document; a conflict re-reads and
  reports instead of retrying blindly.

### Differences from the wireframe

`docs/mcp-desktop-layout.svg` is a structural sketch, not a pixel contract.
Where it and the code disagree, the code wins; the known gaps are recorded here
so the figure is read for shape, not detail.

| Difference | Resolution |
|---|---|
| Per-card refresh, the per-card refresh-failure row, the stale-while-revalidate banner and the collapsed workspace block (the figure draws every workspace row; §6 collapses them to the ENABLED set, and to one off-by-default line when nothing is enabled) are not drawn — all 0.0.4 additions. | The figure lags; the version note on the figure says so. The controls stay as shipped (§6). |
| The figure gives `stopped`/`unknown` no runtime action, while the code renders **Connect** for every **enabled** server the host reports a runtime view for — the `stopped` and `unknown` phases included, and `unknown` is what a configured server with no live handle reports (`manager.ts:452-461`) — with the accent-filled primary reserved for `failed`. | Keep the code; the figure's `disabled` clause is the one that holds: a disabled server also reports a view (`manager.ts:434-441`), but `server-card.tsx:598-601` gates Connect/Disconnect (and `:628` Test) on `!globallyDisabled` (the Tools control at `:638` is gated on a loaded view with `runtime.toolCount > 0` instead). A genuinely missing runtime view drops only those three runtime controls (`runtime !== undefined`); the card keeps its head switch, per-card refresh and Edit/Remove. |
| The figure draws a dot inside the credential badge; the code uses a tone plus text. | Keep the code — the badge is a Tag pill, not a status row. |
| The figure puts a check mark on the success notice; the code uses plain `role=status` text. | Keep the code. |
| Card radius r14 and padding `12px 14px` (`.mcpScope_card` in `styles.ts`; §9.3's r14 is the Button capsule, not the card) versus the figure's drawn max r12 — and the figure's own metric caption names r16 / `12 16 14`. | Keep the code; the figure is indicative. |
| The tool panel in the figure carries a "first 2 of 120" label (`共 120 个工具，显示前 2 个。`), which reads as always-on. | The label is illustrative: the code renders exactly the host's list and adds the same hint (`tools.truncated`) only when the HOST truncates — `manager.ts` caps the list at 200 (`capToolList`), and `server-card.tsx` renders the hint. Keep the code. |
| The figure draws the import dialog in a side panel beside the staged form (annotated `role=dialog`). | Keep the code — the import opens inline inside the staged form, between the import button and the fields; the panel is a side rail in the figure only for legibility. |
| The figure draws a global **刷新状态** button in both of its section-header views; the code removed it — each card refreshes its own server, the section re-reads the runtime snapshot per document revision and polls every 5 s while visible, and a failed full refresh surfaces the stale banner whose **重试** re-runs it. | Keep the code. |
| The figure labels the workspace rows **默认开启，除非在此关闭** / **新建 workspace 默认开启** and its summary reads **Off in 2 workspaces** (the 0.0.3 baseline, where every workspace had MCP on until it was switched off). The 0.0.4 line inverts that contract: MCP is OFF until a workspace explicitly enables the pair, the collapsed card lists the ENABLED workspaces, the manage button reads **Manage workspaces (N on)** — and keeps the count while the list is open (**Hide workspaces (N on)**), because the expanded list is exactly when the count would otherwise disappear — and the summary line reads **全部 N 个 workspace 默认关闭**. | Keep the code — the figure keeps its 0.0.3-baseline caption, and this row is the recorded decision. The figure's geometry (a card head, a workspace block and a manage toggle) is unchanged. |

The two session lanes (the MCP tool-call transcript and the registered-tools
notice) are not part of that wireframe; their contract lives in §5(f) and §6.
