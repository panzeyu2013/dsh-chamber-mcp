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
                       imports the naming constants at RUNTIME (plain strings and a
                       regex), while every other import from here is type-only
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
- Namespace **`mcp-scope`** registered via `ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, {}, { setSource, onChange, validate })`.
- Single-instance guard: a module-level `WeakSet<Context>` keyed on `ctx.root` (mirror official mcp-client serverName reservation) — duplicate plugin load fails loudly.
- `apply` returns fast (no boot gating on server connects); per-server connect runs async with official reconnect defaults.

## 3. Namespace document (settings domain)

```ts
// resolved: schema defaults ← composition base {} ← user layer (settings.yaml "mcp-scope:")
servers: ServerDef[]        // serverName is the stable identity; timeoutMs optional
disabled: { [serverName]: true }                       // presence = globally OFF (0.0.3)
overrides: { [workspaceId]: { [serverName]: true } }   // presence = explicitly OFF
```
Deviations from the plan's shorthand (same semantics, documented in docs/acceptance.md):
(a) `overrides[w]` stored as dict-of-dicts so a toggle is one atomic path op
`set/unset ['overrides', w, s]`; (b) http headers stored as `{ name, ref }` pairs —
values always come from the credentials domain (a bare env-style name cannot be a
header name). Semantics preserved: **enabled(w,s) = the override row has no OWN
property `s` (`Object.hasOwn`)** — prototype-member server names must keep working;
new servers/workspaces default on; no record = default.

```ts
ServerDef =
  | { serverName: string; transport: 'stdio'; command: string; args?: string[];
      cwd?: string; envKeys?: string[]; timeoutMs?: number }            // envKeys: credential refs
  | { serverName: string; transport: 'streamable-http'; url: string;
      headers?: { name: string; ref: string }[]; timeoutMs?: number }   // values from credentials
// serverName: /^[A-Za-z0-9_-]{1,32}$/ (official contract)
// ref: /^[A-Za-z_][A-Za-z0-9_]*$/ (CredentialRef = env-var name), value write-only via credentials domain
```
Schema `validate` hook: duplicate serverName across `servers`; duplicate/conflicting
credential refs within one server → reject the write.

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
  - `agent/created` (root listener) → workspaceOf(session) = canonical-cwd match against
    `workspaceRegistry.list()`; if a workspace W exists and `enabled(W, s)` → apply server's
    defs into `agent.ctx.tools` (each `register()` returns disposer; tracked per agent/server).
    Workspace-less sessions (or cwd outside registered workspaces): no MCP tools.
  - Settings commit / server re-sync / credential change → push to every live agent entry:
    revoke stale defs, register current defs for enabled servers only.
  - `agent/disposed` → entry dropped (ctx-scoped effects die with the agent ctx).
  - Bookkeeping map keyed by Agent; all listeners/disposers effect-wrapped (HMR-safe).
- **Tool semantics mirror official mcp-client** (pinned contract, rc.5-style content
  rendering: image/audio/resource payloads degrade to placeholders — the rc.1
  attachments-based image bridge is a documented scope cut): public name
  `mcp__<serverName>__<rawName>` ≤64 chars `[A-Za-z0-9_-]` + 12-hex sha256 suffix on lossy
  normalization; raw MCP inputSchema passthrough; `output {schema, render}` shape; executor
  = raw SDK request `tools/call` + `RawCallToolResultSchema` with `{signal: exec.signal,
  timeout: 60000}`; `isError` → throw; generation swap on re-sync; registration conflict →
  rollback whole generation.
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
  which case it reports read-only.
- **`tools/list` pagination is bounded**: every followed continuation cursor is
  recorded and a repeat rejects the sync as an invalid tool list, and one sync is capped
  at `MAX_SYNC_PAGES` (= `MAX_SYNC_TOOLS` = 2000) requests. Either failure leaves the
  previous generation registered, so a hostile server can neither spin the fetch loop nor
  erase working tools.
- **Context footprint**: registered definitions are ordinary request tool schemas, so the
  host's context meter prices them under "Tool definitions" (the plugin injects no prose
  into the system prompt). See README §"What the model sees".

## 5. Host half — upstream contracts, mounting and deviations

### Files created

| File | Role |
|---|---|
| `src/tools.ts` | public name + definition build + executor (official mirror, rc.5 flavor: no image bridge) |
| `src/transport.ts` | async transport factory: env/headers resolved from credentials per attempt |
| `src/workspace.ts` | canonical-cwd → workspace-id helper |
| `src/server.ts` | per-server supervisor (official reconnect semantics, defs master state) |
| `src/agents.ts` | per-agent scope injection gate (never registers globally) |
| `src/manager.ts` | bridge orchestrator: handle lifecycle, credential events, applier ownership |
| `src/schema.ts` | `DocumentSchema` (schemastery) — NEW module beyond the original list |
| `src/routes.ts` | 0.0.3 runtime routes on the Connection carrier: `status` / `action` / `tools` (fixed host codes only; §(d)) |
| `src/index.ts` | plugin entry (value exports exactly `name`/`inject`/`Config`/`apply`, plus type-only re-exports of the public model surface) |
| `tests/fixture/mcp-fixture-server.mjs` | spawnable real MCP stdio fixture (add/greet/fail/image/crash/admin.reset/dyn_add/env_probe) |
| `tests/tools.spec.ts`, `tests/host/{model,transport,server,agents,settings,manager,index,routes}.spec.ts` | the 8 `tests/host/` suites plus `tests/tools.spec.ts`, all green (the 8 client suites live under `tests/client/; repo total 250 tests / 17 files) |

Run: `npm run typecheck` (both tsconfigs) and
`node node_modules/vitest/vitest.mjs run` — both fully green (250 tests / 17 files).

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
3. **rc.1 image bridging skipped** (acceptable per spec): image/audio/
   embedded-resource blocks degrade to placeholders in the text projection
   (`[image: <mime>, content discarded]`, `[audio: …]`, `[resource: …]`);
   `resource_link` renders as `Resource link: <name> (<uri>)` (rc.1 wording);
   the canonical `{content, structuredContent?}` value keeps raw blocks.
4. **Client identity** on the wire is `{name: 'dsh-chamber-mcp', version:
   <package.json version>}` — `src/server.ts` derives both from the package
   manifest (so it reads `0.0.2` at HEAD, not the `0.0.1` this note originally
   recorded); official sends `dsh-mcp-client`; server-facing semantics
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

## 6. Browser half — section, forms and lane (overview)

- Browser plugin exports `inject = ['slots','locale','remote','remote.credentials','settingsScope','workspaces','sessions']` + `apply(ctx)`; registers locale ns `mcp-scope.settings` ({en, zh}) then
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
  id:'mcp-scope', order: 25, label: t-thunk, locale: NS,
  inject: () => controller.face() }, McpScopeSection))` — no child slots (the
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
  name keeps the shipped generic row. `dsh.client.inject` gains exactly one
  module, `@deepseek-ai/dsh-client-ui-tool` (the slot owner, present in every
  supported generation); the provider of `ctx.sessions` is NOT named there
  because its module id is generation-dependent (see §11).
  Detail and evidence: §11.
- Data: `ctx.settingsScope.bind<Doc>({ namespace:'mcp-scope' })` → snapshot
  {status, value, revision, writable}; workspaces via global `useWorkspaces`.
- Views: server cards (name, transport, "off in N workspaces", edit, remove, per-workspace
  on/off rows with default-on note), staged Add/Edit form (serverName + transport toggle +
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
| `src/client/import.ts` | 0.0.3 single-server JSON import (`mcpServers`, opencode and flat shapes → draft; secret values land write-only) |
| `src/client/runtime.ts` | 0.0.3 runtime store over the three host routes: status/action/tool-list reads, pending-action state (§12) |
| `src/client/styles.ts` | style seat: the plugin's stylesheet, its class-name map, and the `data-plugin-css` tag mount (§9) |
| `src/client/workspaces.ts` | minimal workspace-row narrowing (typed items) |
| `src/client/tool-card/{names,icon,row,view,register}.ts(x)` | transcript lane: MCP tool identity from the session's request header, the keyed tool view, and its registration lifecycle (§11) |
| `tests/client/controller.spec.ts`, `tests/client/locales.spec.ts`, `tests/client/styles.spec.tsx`, `tests/client/section-render.spec.tsx`, `tests/client/tool-card.spec.tsx`, `tests/client/tool-register.spec.ts`, `tests/client/import.spec.ts`, `tests/client/runtime.spec.ts` | vitest suites (8 files; the repo-wide suite is 17 files) |

Also edited (build-gate fixes, see §13): `tsconfig.json` (added `DOM` lib),
`tsconfig.tests.json` (override the inherited `tests` exclude).

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
  hooks `useDoc` + `useWorkspaces`, and the four injected actions, re-stated
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
  transcript lane (`src/client/index.ts:124`; without it the lane stays off) (`connection` was dropped —
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
  transcript (`.smoke/logs/M0-raw.log`); (3) whether
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
working across the peer range (`^0.1.2-rc.1 || ^0.1.5-rc.1`) without a
compile-time dependency on the primitives' JS API — the geometry is copied
from the pinned generation, which §9.3 pins property by property.

### 9.2 What was replaced

| before | now |
|---|---|
| inline styles with literal colours/heights | classes off one token-only stylesheet |
| `border: 1px dashed rgba(127,127,127,.5)` form box | the panel's editing surface (`bg-module-platform`, r12, 14/16 padding) |
| raw `<button>` (OS default chrome) | `ui-primitives` Button capsules: `size="sm"` (h28/r14) for row and header actions, the figma `md` capsule (h36/r18) for the form footer; `outline` for dismiss/secondary, `primary` for commit, danger tint for destructive actions |
| raw `<input>` (OS default chrome) | official field vocabulary: h34/r8, `border-l4` hairline, `bg-layer-1`, 13px, `brand-primary` focus border, `label-dimmed` placeholder, dimmed when disabled, error border when invalid |
| raw `<input type="checkbox" role="switch">` | the Switch primitive's look (36×20 track, `brand-primary` when on, 16px thumb, 120ms slide) driven by the same controlled checkbox through `:checked` |
| native radios | the Pill primitive's pill (24px/r12, ghost-active fill + inset ring when selected) over the same real radios |
| literal-colour banners (`#c0392b` / green box) | token notices: failures on the danger tint with `state-error` text, the saved note as `state-success` text |
| opaque spans for transport/summary/credentials | the Tag pill (999px + `corner-shape: round`, 11/17) with the Tag tone palette: `outline` for the transport, `success`/`warning` (10%/12% `color-mix`) for configured/unconfigured refs, neutral for unknown |

### 9.3 Alignment table (checked, not asserted)

Every value below was read from the pinned dsh sheets (vendored upstream
packages at the authoring machine's
`/root/projects/dsh-chamber/vendor/harness-packages/@deepseek-ai` — not a path
inside this repo) and then verified against the
rendered surface: a Chromium audit of `getComputedStyle` in both themes
(`.smoke/ui-preview/audit.mjs`) and a source-level property diff
(`.smoke/ui-preview/align.py`). "same" = byte-equal declaration.

| surface | reference (official) | result |
|---|---|---|
| section column | `ui-settings-models` `.section` | same (flex column, gap 12, max-width 720, `label-primary`) |
| section title | `.title` | same (16px/24px, 500) |
| header action / row actions | `ui-primitives` Button `.sm` + `outline` (what the official `settings.action` seat renders) | same (h28, r14, 0 10px, 12/18, `border-l3`) |
| form footer buttons | Button `.md`/`.primary`/`.outline` + `EditorFooter` order | same (h36, r18, 0 14px, 14/22; dismiss left, commit right) |
| card | `ui-settings-plugins` `.card`/`.header`/`.body` | same fill/radius/hairline (`border-l4`, r16, `bg-layer-3`), 16px inset; `ui-settings-models` `.rowCard` is the 14px variant (not used) |
| staged form | `ui-settings-models` `.editor`/`.addCard` | same (r12, `bg-module-platform`, 14/16, gap 14) |
| field label | `ui-settings-plugins` fields `.label` | same size/weight/colour (13px, 500, `label-primary`; line-height written 20px vs `1.5` = 19.5px) |
| input | fields `.input` (h34, 0 12px, 13px, `border-l4`, r8) + `.input` of `ui-settings-models` (`bg-layer-1`, focus `brand-primary`, placeholder `label-dimmed`) | same; `bg-layer-1` (not the card fill) so the field reads as a box on the module fill in DARK, where `bg-layer-3` == `bg-module-platform` |
| invalid input / problem text | fields `.inputInvalid` / `.invalid` | same geometry and 12/18; colour `state-error-primary`. Upstream reads `--dsw-alias-label-error`, which NO sheet declares (the declaration is silently dropped) — see §9.4 |
| transport tag | `ui-primitives` Tag `.tag` + `data-tone='outline'` | same (999px, `corner-shape: round`, 1px 8px, 11/17, `border-l4`, `label-tertiary`) |
| credential badges | Tag tones `success`/`warning` | same `color-mix` fills and colours |
| switch | `ui-primitives` Switch `.switch`/`.thumb` | same (36×20, pad 2, r10, `corner-shape: round`, `border-l3` → `brand-primary`, 16px thumb, `translateX(16px)`, 120ms) |
| transport choice | `ui-primitives` Pill `.pill`/`.active`/`.interactive:hover` | same (including the hover fill on the unselected pill, guarded by `:not(:checked)` so the selected fill survives); horizontal padding 10px (Button `.sm`) instead of 8px, because this pill is a button-like choice holding translated copy |
| hints / problems / notices | fields `.hint`, `ui-settings-models` `.error`/`.savedNotice` | same (12/18, `label-tertiary` / `state-error-primary` / `state-success-primary`) |
| card list | `ui-settings-plugins` `.cards` | same gap 10px, no list markers (`ui-settings-models` `.rows` uses 8px) |
| error banner | chamber `.pluginRisk` vocabulary (danger tint + `state-error` text) | same tokens (no literals) |
| focus rings | `.button:focus-visible` → `box-shadow: 0 0 0 2px border-l3` (settings sections); `brand-primary` outline on the invisible-behind-paint controls (switch, pill, link, icon) | as referenced |

### 9.4 Checked by a gate, not by eye

`tests/client/styles.spec.tsx` applies the dsh-chamber style rules
(`dsh-chamber/scripts/dev/verify-style-tokens.mjs`, S1–S7) to this one sheet:
every `--dsw-*`/`--ds-*` reference must be a token the pinned theme declares
(S1 — this is what rejects upstream's undeclared `--dsw-alias-label-error`),
no literal colours and no colour fallback on a token (S4), every neutral
border 0.5px and no 1px filled divider (S3), every full-round radius paired
with `corner-shape: round` (S7), no custom properties of our own (S2/S6). It
also asserts that the class map and the stylesheet cover each other exactly
(no dead rule, no unstyled class) and that the tag mount is idempotent and
disposed, then renders the card and the form to check the components actually
consume the seat.

Rendered evidence (gitignored harness under `.smoke/ui-preview/`, not part of
the package): `make.mjs` builds a page that mounts the REAL section inside a
replica of the official settings panel chrome; `shoot.mjs` screenshots it in
both themes under real interaction (list, staged form, remove confirm, failed
toggle, save) — plus a hostile-content page (`long.html`, see §9.6) — and
`audit.mjs` records `getComputedStyle` + geometry for the same five states:
0 horizontal overflow, 540px content column, card actions flush to the card's
inner edge, switch thumb at `translateX(16px)` only when on. Run:
`node .smoke/ui-preview/make.mjs && PAGE=… OUT=… PREFIX=light xvfb-run -a electron .smoke/ui-preview/shoot.mjs`.

`ax.mjs` dumps Chromium's accessibility tree for both states, which is how the
structural changes were checked where assistive tech reads them: the transport
choice is still `radiogroup 传输方式` + two named `radio` nodes with correct
`checked`, each workspace row is a named `switch` with the right state and
disables with the staged form, the section/form titles stay `h2`/`h3`, and
every button keeps its name.

`artifact.mjs` drives the **shipped** `lib/client.js` (the wrapped loader
factory, not the sources) in a real browser through the lifecycle the initial reconnaissance
could not observe. Result of the recorded run (`.smoke/ui-preview/artifact.json`,
2026-09-11): the loader registers `dsh-chamber-mcp`; the factory requires
**only** `react` and `react/jsx-runtime`; `apply` registers three labeled
effects with `mcp-scope: styles` first, then the dictionary and controller
wiring, and one `settings.section` registration (`mcp-scope`, order 25, label
from the namespace); the style effect puts the sheet in the document with the
right tag attributes — **14,020 B in that run**, against **14,247 B** before the
§11 transcript lane and **22,710 B** at the current working tree (the §11 lane
block is 8,463 B); the
registered component renders the styled markup; and the effect's disposer
removes the tag.

### 9.5 Contrast, measured (and why nothing was "fixed")

Contrast ratios computed from the rendered colours (WCAG 2.1, relative
luminance), light / dark:

| pair | light | dark |
|---|---|---|
| card name on card | 18.9 | 11.6 |
| code line (`label-secondary`) | 5.8 | 8.0 |
| input text on field | 18.9 | 15.0 |
| field label on the form fill | 17.5 | 11.6 |
| badge ref (`label-secondary`) on the tone fill | 5.3 | 6.8 |
| primary button label on fill | 18.9 | 18.1 |
| quiet copy (`label-tertiary`: card meta, row state, hints) | 3.7 | 5.7 |
| error notice on the danger tint | 4.2 | 3.1 |
| success tones (saved note, configured badge) | 2.3 / 2.1 | 5.3 / 4.5 |
| transport tag (`label-tertiary` on the card) | 3.7 | 5.7 |

The two sub-AA rows are the design system's own values, not this sheet's:
`label-tertiary` is what every official settings section uses for secondary
copy (PluginCard `.description`, ModelsSection `.modelCatalogMeta`), and the
success tone is the `state-success-primary` green that `ModelsSection
.savedNotice` and the `Tag` `success` tone paint as text. Nothing here
deviates: a darker green does not exist in the token set, and colour is never
the only signal (every toned badge also renders its state word, so WCAG 1.4.1
holds). Recorded so the next reader sees the measurement rather than
re-deriving it.

### 9.6 Hostile-content hardening (overlong values, tag ownership)

The restyle was exercised against content the schema does not cap, which the
friendly fixtures do not cover:

1. **Horizontal overflow.** `HEADER_NAME_PATTERN` and
   `CREDENTIAL_REF_PATTERN` bound the character set, not the length, so a
   46-character header name plus a 45-character ref made one credential pill
   718px wide inside a 506px card content box — the card, the section and the
   settings column all overflowed (measured: section +195px, card +196px). The
   pill is now capped (`max-width: 100%`), its two code parts absorb the shrink
   and ellipsize (`min-width: 0` + `text-overflow`), and both carry a `title`
   with the full value — the same guard upstream applies to overlong badge
   cells. A working directory is an arbitrary host path, so the quiet-copy rule
   gained `overflow-wrap: anywhere` as well. Re-measured with the hostile
   fixture (`?long=1`): 0 overflow on every container.
2. **Stylesheet ownership.** The first implementation removed the tag
   on dispose and no-op'd when one already existed. That loses the sheet when
   two copies of the plugin are mounted in one document and the first to unload
   is not the one that created the tag (the chamber shell can host several
   instances per page), and it would keep painting a stale revision when an HMR
   apply runs before the outgoing fiber's disposer. The tag now carries the
   live-mount count and is re-filled when its text is no longer current; the
   last disposer removes it (§9.1, both orderings covered in
   `tests/client/styles.spec.tsx`).
3. **Checked, no change needed.** Every JSX attribute, role and behavior
   survives the restyle (attribute-set diff before/after: only `style=` became
   `className=`, and the one moved `key` is the card's, now on its `<li>`); no
   user-controlled value reaches a style or class context (classes are static,
   there are no inline styles), so the new `title` fallbacks on truncated
   badges are the only place a server-supplied string meets an attribute and
   React escapes it; the staged form's footer is Cancel-then-Save as the
   official `EditorFooter` orders it, with the same `<form>`/Enter-submission
   semantics as before.

Not changed, and why: the pill/notice tone contrast (§9.5), the 16px card
inset and 8px internal gap (PluginCard's values; `ui-settings-models` uses
14px/12px — both official, one had to be chosen), the pill padding of 10px
(Button `.sm`, not Pill's 8px), and the bundle growth. Measured in a scratch
build of the pre-transcript-lane tree: `lib/client.js` 75,485 → 93,286 B
(+17.8 KB), of which 14.4 KB is the stylesheet text and 3.4 KB the class
plumbing and the invalid-state markup; the sheet stays unminified on purpose (it is read in devtools far
more often than it is transferred, and a minifying step in `build.mjs` would
hide the CSS text from the diff (the built file is not tracked).

### 9.7 State matrix, engine scan and harness checks

Beyond the static checks above, these surfaces were exercised directly:

1. **State coverage.** Read-only,
   empty, in-flight (hanging save/toggle), invalid draft, workspace
   load/error/empty, English copy and a 252px column were all rendered for the
   first time. Clean everywhere (0 overflow, controls wrap instead of
   squeezing), with one real gap: a row-level problem was reported only in the
   text list, so nothing said *which* input was wrong. Row inputs now carry the
   official invalid treatment (`inputInvalid` border + `aria-invalid`), mapped
   precisely — an env-row problem marks its key input, a header problem marks
   the name input unless it is the ref that is wrong.
2. **Transport pill hover.** The official interactive
   Pill answers the pointer; the unselected choice now takes
   `interactive-bg-hover` while the selected one keeps its fill (the
   `:not(:checked)` guard is what keeps the newer rule from out-shouting the
   selected state — verified by hovering both pills in a real browser).
3. **Engine-level scan (new, `.smoke/ui-preview/scan-engine.mjs`).** Against
   the preview page (as of the recorded run): 88 scoped rules and 25 referenced
   tokens — the sheet is now 136 rules / 27 tokens — every token resolving in
   BOTH themes; no unsupported property and no dropped declaration;
   `prefers-reduced-motion: reduce` turns the form's mount animation off and
   every transition to 0s; real Tab presses paint a ring on capsules
   (`box-shadow`), and on the radio pill / switch track through their sibling
   rules (`outline: 2px brand-primary`); the focused input shows the official
   border-colour change instead of a ring. The 24 selectors "dead" in that run
   are the hover/focus/disabled/placeholder states plus the states the run did
   not drive (alert, saved note, empty, read-only), each of which is exercised
   by the comparison table above.
4. **The tests can fail.** The style spec was mutation-tested: dropping
   `corner-shape: round`, widening a hairline to 1px, writing a literal colour,
   referencing the undeclared `label-error`, removing the badge width cap, and
   breaking the tag's ownership count each turn the suite red (7/7).

## 10. Settings UI layout reference

Structural reference for the shipped browser half, derived from the components and the style seat — open *Settings → MCP servers* in a live GUI for the rendered result. Wireframe: [`mcp-desktop-layout.svg`](mcp-desktop-layout.svg). Chinese labels below follow the zh locale; the en locale is key-for-key identical (`src/client/locales.ts`).

### Where it lives

The section is registered into the official settings shell through the
`settings.section` slot (`id: mcp-scope`, `order: 25`). It renders as a single
**column, max-width 720 px, gap 12 px**, inside the settings panel; it declares
no child slots and never replaces the shell.

```
┌──────────────────────── dsh Web GUI / chamber desktop ────────────────────────┐
│ ┌──────────┐ ┌──────────────────── Settings ────────────────────────────────┐ │
│ │ sidebar  │ │ ┌───────────┐ ┌──────────── MCP 服务器 ──────────────────┐ │ │
│ │          │ │ │ settings  │ │  标题      [刷新状态]  [+ 添加服务器]      │ │ │
│ │ …        │ │ │ nav       │ │  [筛选服务器]                             │ │ │
│ │ 设置 ◀   │ │ │ 通用      │ │  ── 卡片列表 / 表单（本文档以下部分）──   │ │ │
│ │          │ │ │ 模型      │ │                                           │ │ │
│ │          │ │ │ 插件      │ │                                           │ │ │
│ │          │ │ │ MCP 服务器◀│ │                                           │ │ │
│ └──────────┘ │ └───────────┘ └───────────────────────────────────────────┘ │ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Section surface (list state)

Order of elements exactly as rendered:

```
MCP 服务器                                          [刷新状态]  [+ 添加服务器]
┌─ 筛选服务器 ────────────────────────────────────────────────────────────┐
└─────────────────────────────────────────────────────────────────────────┘
✓ 已添加 github                                                  (role=status)

╔═ 卡片（article, aria-busy） ════════════════════════════════════════════╗
║ (◉) github   [Streamable HTTP]   1 header · Off in 2 workspaces  [移除][编辑] ║  ← 卡头
║ ● 已连接 · 12 个工具                        [断开] [测试] [工具 (12)]   ║  ← 状态行
║ ┌ 工具 ──────────────────────────────────────────────────────────────┐ ║
║ │ search_issues — Search issues       (code 11px, 悬停显示描述)      │ ║
║ │ 共 120 个工具，显示前 2 个。                                        │ ║
║ └────────────────────────────────────────────────────────────────────┘ ║
║ ┌ 删除确认（按下“移除”后替换操作行） ────────────────────────────────┐ ║
║ │ 移除服务器？ 服务器将全面停止，配置被删除。        [确认] [取消]      │ ║
║ └────────────────────────────────────────────────────────────────────┘ ║
║ npx -y @modelcontextprotocol/server-github        (definition code)     ║
║ 工作目录：/srv/github                                                   ║
║ Authorization  AUTH_TOKEN  已配置  [清除]            ← 凭据徽标行       ║
║ 默认开启，除非在此关闭                                                  ║
║  ● alpha  (switch) 开启        ● beta  (switch) 关闭                    ║
║                     [全部开启] [全部关闭]        ← ≥2 个 workspace 时   ║
║ 新建 workspace 默认开启                                                 ║
╚═════════════════════════════════════════════════════════════════════════╝

（卡片按文档顺序纵向排列；表单打开时渲染在列表上方，列表保留，删除类操作禁用）
```

#### Card anatomy — vertical order (top → bottom)

| # | Element | States / notes |
|---|---|---|
| 1 | **Card header** `styles.cardHead` | enable switch (writable only) · server name (focus target after save) · transport tag (`stdio` / `Streamable HTTP`) · summary `N env keys / N headers · 已停用 · Off in N workspaces` · **移除**(danger) / **编辑**(outline), hidden while the remove confirm is open |
| 2 | **Status row** `styles.statusRow` | 8 px dot (state tone) · phase label (`已连接/连接中…/重连中…/失败/已停止/已停用/状态未知`) · `N 个工具` (connected) · `第 i/max 次尝试` (reconnecting) · spacer · **断开|连接** (pending 文案) · **测试** · **工具 (N)** — runtime actions only when a runtime view exists; disabled-server actions hidden |
| 3 | Runtime failure line | localized fixed code (never remote text) |
| 4 | No-channel hint | `运行时状态不可用` / `运行时状态刷新失败` |
| 5 | Test note (role=status) | transient `测试通过 · N 个工具` |
| 6 | Runtime action alert (role=alert) | transient, dismissible |
| 7 | Tools disclosure | loading / empty / rows (`rawName — description`, true total when truncated) |
| 8 | Save failure alert (role=alert) | transient, dismissible |
| 9 | Remove confirmation `styles.confirm` | danger-tinted block, Esc cancels, focus returns to 移除 |
| 10 | Definition details | command line **or** URL in `code`, plus cwd hint |
| 11 | Credential badges | configured (ok) / unset (warn) / unknown (neutral); **清除** only when configured |
| 12 | Workspace block `styles.wsBlock` | `默认开启…` hint · lifecycle states (loading / error / no workspaces) · per-workspace switch rows (`开启` / `关闭`) · all-on/all-off (≥2 workspaces) · `新建 workspace 默认开启` |

### Add / Edit form (rendered above the list)

```
┌─ 添加 MCP 服务器 / 编辑 MCP 服务器（form, bg-module-platform, r12） ─────┐
│ [导入 JSON…]                                                            │
│ ┌ 导入 MCP 服务器 JSON（role=dialog） ────────────────────────────────┐ │
│ │ 粘贴 mcpServers / opencode 片段中的单个服务器。                     │ │
│ │ ┌ textarea（code 字体, min-height 96） ──────────────────────────┐  │ │
│ │ └────────────────────────────────────────────────────────────────┘  │ │
│ │ [从剪贴板粘贴]                       [填入表单]                     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ 服务器名称 *                                                            │
│ [__________________________]  工具将以 mcp__<名称>__* 命名              │
│ (◉) 启用     停用的服务器保留配置，但不会运行，也不会暴露任何工具。      │
│ 传输方式    ( stdio )  ( Streamable HTTP )        ← Pill 单选           │
│                                                                         │
│ ── stdio 分支 ───────────────────────────────────────────────────────  │
│ 命令 *                                                                  │
│ [____________________________________]  该命令以此实例用户身份执行     │
│ [粘贴命令]                                                              │
│ 参数                                                                    │
│ [  参数 1  ] [移除]                                                     │
│ [  参数 2  ] [移除]        [+ 添加参数]                                 │
│ 工作目录（可选）    [_______________________________]                   │
│ 环境变量 / 凭据键                                                       │
│ 这些条目会注入服务器进程的环境。                                        │
│ [粘贴 .env]                                                             │
│ [KEY 1] [值（仅写入）] [移除]                                           │
│ [+ 添加环境变量]                                                        │
│                                                                         │
│ ── Streamable HTTP 分支 ─────────────────────────────────────────────  │
│ URL（端点） *                                                           │
│ [____________________________________]                                  │
│ 请求头                                                                  │
│ 每次 MCP 请求都会带上这些请求头。                                       │
│ [粘贴请求头]                                                            │
│ [Authorization] [AUTH_TOKEN] [值（仅写入）] [移除]                      │
│ [+ 添加请求头]                                                          │
│                                                                         │
│ ── 两个分支共用 ─────────────────────────────────────────────────────  │
│ 超时（毫秒）    [__________]  留空使用默认 60 秒。                       │
│                                                                         │
│ ┌ 放弃未保存的修改？（仅 dirty 时，点关闭后出现） ────────────────────┐ │
│ │                               [放弃修改] [继续编辑]                  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                        [取消]            [保存]         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Runtime state matrix

| Host phase | Dot | Label (zh) | Actions shown (runtime available) |
|---|---|---|---|
| `connected` | 绿 `state-success-primary` | 已连接 + `N 个工具` | 断开 · 测试 · 工具 (N) |
| `connecting` | 黄 `state-warn-primary` | 连接中… | 断开 · 测试 |
| `reconnecting` | 黄 | 重连中… + `第 i/max 次尝试` | 断开 · 测试 |
| `failed` | 红 `state-error-primary` | 失败 | 连接 · 测试 |
| `stopped` | 灰 `border-l3` | 已停止 | 连接 · 测试 |
| `disabled` | 灰 + 卡片 60% 不透明 | 已停用 | （无运行时动作；用卡头开关启用） |
| `unknown` | 灰 | 状态未知 | 连接 · 测试 |
| no runtime view | 灰 + hint | 状态未知 + `运行时状态不可用`/`刷新失败` | （无运行时动作） |

### Metrics (source of truth: `src/client/styles.ts`)

| Part | Metric |
|---|---|
| Section column | max-width 720 px · gap 12 px · label-primary text |
| Title | 16/24 px, weight 500 |
| Header actions | `Button size=sm` capsule: 28 px high, radius 14 px, 0 10 px padding, 12/18 text |
| Card | padding 12 16 14 · 0.5 px `border-l4` hairline · radius 16 · `bg-layer-3` · hover border `label-dimmed` · disabled opacity .6 |
| Status dot | 8 × 8 px · radius 50% · `corner-shape: round` · `state-*-primary` / `border-l3` |
| Form | padding 14/16 · radius 12 · `bg-module-platform` |
| Field label | 13/20 px, weight 500 |
| Input | height 34 px · radius 8 · 0.5 px `border-l4` · `bg-layer-1` · 13/20; focus border `brand-primary`; disabled opacity .5 |
| Textarea | min-height 96 px · radius 8 · code font 12/18 · resize vertical |
| Import dialog | padding 10/12 · radius 10 · 0.5 px `border-l4` · `bg-layer-2` |
| Switch | track 36 × 20, radius 10, thumb 16, `brand-primary` when on |
| Tag / badge | 999 px pill · 11/17 · `corner-shape: round` |
| Tool rows | code font 11/17 · raw name label-primary · description label-secondary |

### Interactions worth knowing

- **Form placement**: Add/Edit renders *above* the card list; the list stays visible and
  destructive card actions are disabled while a form is open.
- **Dirty guard**: 取消 (footer), the header `取消`, and unmount-adjacent paths all route
  through the same close request; a dirty form shows the inline discard confirm.
- **Search**: filters by server name when no form is open; a zero-match query shows
  `没有匹配“…”的服务器` instead of the empty-state copy.
- **Polling**: the runtime snapshot is fetched once per document revision, on
  `connection/reset`, and every 5 s while the panel is visible; with zero servers
  configured the poll is skipped entirely (the header refresh action still works).
- **Degradation**: no runtime channel (headless host / missing route) hides the runtime
  actions and shows the unavailable hint; all document features keep working.

### Evidence

- Components: `src/client/section.tsx`, `src/client/server-card.tsx`,
  `src/client/add-form.tsx`; style seat: `src/client/styles.ts`.
- Render/flow tests: `tests/client/section-render.spec.tsx`; style-token gate:
  `tests/client/styles.spec.tsx` (S1–S7 + class map/CSS coverage).

## 11. Transcript lane — the MCP tool row

The browser half also owns how MCP calls render in the conversation. The lane
was deliberately built to need **no host API and no new runtime dependency**:
the tool names come from the session's own event stream, and both glyphs are
inline SVG.

- **Slot contract.** `tool.call.toolview` is a *keyed, session-scoped* slot
  dispatched by the EXACT wire tool name (`dsh-client-ui-tool`
  `contract/slots.d.ts`): an unclaimed key falls back to the shipped generic
  row, and reusing a key replaces that row — so registering is additive for our
  own names and never touches the shipped ones. Registration goes through
  `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key,
  locale: NS, priority: 1 }, View))`, the same seam `dsh-client-ui-skill` uses
  for `skill` (plus the shadowing rank — see *Declaration choices*); the
  disposer removes the row on teardown or HMR.
- **Discovery — two sources, both required.** `ctx.sessions.list` names the
  staged session (the framework's own doc: *"Staging IS the open signal — the
  window opens ⟺ the session is on stage"*), whose binding's `eventSource`
  window supplies MCP names from
  - every `request/header` — `event.data.header.tools[]` (`.name`), the complete
    model-facing tool array (`EpochHeader.tools` is an optional direct child of
    `header`; the client-connection token fixture and
    `ui-conversation`'s request inspector read the same path), and
  - every `tool/call` — `event.data.name`, the call the event renders.

  The second source is not redundant. The window is a **bounded, paginated tail
  page** of the session log (`events.open({ maxMessages: 50 })`, host cut
  `DEFAULT_MAX_MESSAGES = 50` over `user/message` + `assistant/message`), while
  `request/header` is appended at loop-instance boundaries and *on change* — not
  per turn — so a session that ran long enough can render MCP calls whose
  describing header sits before `entries[0]`. A `tool/call` event is present
  exactly when its row renders, so registering from the call events the window
  actually carries makes the lane independent of that pagination; scrolling up
  (`events.prepend`) re-publishes and heals the boundary call. Names accumulate
  across sessions so a revisited session keeps its rows. The header remains the
  only source for tools that were offered but never called — those register
  ahead of their first call. Without the sessions service the lane stays off and
  every MCP call keeps the shipped row.
- **Identity.** A public name cannot be decomposed on the client (it may carry
  the 12-hex lossy-normalization suffix), so the owning server is matched by the
  **longest configured `serverName` prefix** from the settings document — which
  also keeps a serverName containing `_` unambiguous. A tool whose server left
  the document still renders, without a transport tag.
- **Cap.** The keyed dispatch projects the slot's WHOLE entry list per rendered
  row (`entriesOfSlot` is computed on every call — no memo, verified in
  `dsh-client-ui-slots`), so the lane registers at most
  `DEFAULT_TOOL_VIEW_LIMIT` (256) names; names past the cap keep the shipped row
  and the client context's logger (when present) records one warning.
- **States.** `running` / `ok` / `error` / `stopped` are classified by the same
  expression the shipped rows use (`!done` ⇒ running, else
  `block.error?.code === 'interrupted'` ⇒ stopped, else `isError` ⇒ error, else
  ok — `dsh-client-ui-tool` `ToolRow`). Running carries the shipped sweep
  (`300px`, `2.6s ease-out infinite`, same gradient and keyframes) plus
  `aria-busy` and a primary title; settled rows drop the animation and show
  `time - callTime`. **Terminal states yield the LEADING SLOT to the shipped
  status dot** — error red, interrupted amber (`--dsw-alias-state-error-primary`
  / `--dsw-alias-state-warn-primary`, the same anatomy as `StateDot`: a 10px box
  whose `::after` core is 6px (`inset: 20%`) under a 10%-opacity halo) — so, exactly like upstream, the title keeps its normal colour and
  only the failure's summary line takes the error token. The row's own metrics
  and layout mirror the shipped ones (24px row, 16px leading box with 14px
  glyphs, 6px gap, 13px/24px title, the shipped 2x2 caption-dot separator, a
  14px/24px ellipsizing summary, then the suffix items) and the disclosure
  behaviour is `DisclosureRow`'s: `role=button`/`tabIndex`/`aria-expanded` only
  when expandable, Enter/Space toggle, glyph→chevron on hover, chevron while
  open. Assistive technology gets the shipped treatment as well: the dot and the
  sweep are colour-only, so running/error/interrupted rows carry a visually
  hidden state word (`stateStatus`'s rule — a settled-ok row needs none) and the
  row's own visible text stays the accessible name. Every number and token here
  was read out of the shipped stylesheets
  (`ToolRow`/`DisclosureRow`/`StateDot` module CSS); the pinned generation's
  theme DECLARES `--dsh-content-font-size-secondary` and
  `--dsh-content-font-delta` (and the shipped rows read them), so this sheet
  reads them too with the shipped defaults as fallbacks — the row follows the
  Settings font-size axis exactly like the shipped rows. (Only the older
  0.1.1-rc.2 profile theme lacks both, where the fallbacks apply.)
- **Styling.** Same style seat as the settings section: shipped row metrics
  (24px row, 16px leading box with 14px glyphs, 6px gap, 13px/24px title,
  14px/24px summary, 0.5px hairlines), `--dsw-*` alias tokens only (plus the
  theme's caption token for the separator dot), inline 24-unit glyphs rendered
  at 14px, and the reduced-motion block disables the sweep. The built bundle
  still requires only `react` / `react/jsx-runtime`.
- **Declaration choices (verified against both generations).**
  - `dsh.client.inject` gains exactly ONE module: `dsh-client-ui-tool`, the
    package that declares the `tool.call.toolview` slot (its
    `conversation.chat.node` entry carries the `children` table) and is present
    in the 0.1.1-rc.2 anchor set *and* the 0.1.5-rc.2 pin. The **provider of
    `ctx.sessions` is deliberately NOT named**: it is `dsh-client-runtime` in
    the anchor generation and `dsh-api-session-controller` in 0.1.5 — a module
    id that only exists in one of them would be a dangling edge in the other.
    The cordis `inject: ['sessions']` service requirement already orders us
    after whichever package provides it (both generations expose the service
    under that exact name: `rootCtx.reflect.provide("sessions", …)` in the
    anchor's `dsh-client-runtime`, and the same name in the 0.1.5
    `dsh-api-session-controller`), and the shipped `dsh-client-ui-conversation`
    injects `"sessions"` the same way.
  - Rows register at `priority: 1`. Keyed dispatch is exact-key and the
    shadowing rank is ascending ("lowest renders"), while a same-key pair at
    the SAME priority **throws** in the slot core — and the throw would hit
    whichever package registers second. Rank 1 makes a future official row for
    the same wire name win and makes that collision impossible; the generic
    fallback is not an entry, so rank 1 still renders today.
  - Registration is per exact wire name through
    `ctx.slots.inject(key, () => ctx.slots.register(...))`, the same seam
    `dsh-client-ui-skill` uses for `skill`. `inject` is a fiber effect
    (`ctx.effect`) that runs its callback immediately when the declaration
    exists and later when it lands, so calling it from a session subscription is
    legal; the callback must not throw (a deferred throw would surface as an
    uncaught microtask error), which is why the lane installs rows behind a
    try/catch and leaves a failed name un-registered for a later retry.
  - The row reuses the existing `mcp-scope.settings` locale namespace instead of
    declaring a second one: the namespace id is just a dictionary handle, the
    dictionaries already carry en/zh parity under the compile-enforced key
    union, and a second namespace would add a second declaration site for no
    user-visible benefit.
- **Evidence.** `tests/client/tool-card.spec.tsx` (identity incl. longest-prefix
  and hashed names, the four states, expand/collapse, keyboard, aria) and
  `tests/client/tool-register.spec.ts` (diff, cap, teardown, observer
  lifecycle); `tests/client/styles.spec.tsx` gates the new classes with the rest
  of the sheet; and `scripts/verify-client-artifact.mjs` (run by
  `verify:package`) drives the BUILT `lib/client.js` through the loader wrapper
  in jsdom — it registers one view per discovered name, renders the running and
  settled forms, and expands on a real click.

## 12. Runtime status + configuration surface (0.0.3)

- **`src/client/runtime.ts`** is a dependency-free store over the three host
  routes: global `fetch`, injectable for tests, in-flight dedupe, no timer of
  its own. A failed/unreachable call publishes `unavailable`/`error` and the
  section keeps rendering the document; the client bundle still requires only
  react/react/jsx-runtime.
- **Wiring.** `apply()` composes the runtime store into the same
  `settings.section` inject face (`useRuntime` hook seat + action callbacks),
  refreshes on `settings/document-updated` and `connection/reset`, and the
  section polls every 5 s while visible and once per document revision.
- **Cards** render the status dot/label, a localized failure line derived from
  the host's fixed error code (remote text never crosses the wire; unknown codes
  fall back to the host message), Connect/Disconnect/Test and a `Tools (N)`
  disclosure; the enable switch starts the header, Test is gated on a runtime
  view, and runtime action failures surface in the card's own role=alert banner
  (separate from document save failures).
- **Form** additions: enable switch, `timeoutMs`, an inline unsaved-changes
  guard (header and footer route through the same `requestClose`), clipboard
  paste for command / `.env` / header lines, and a single-server JSON import
  (`src/client/import.ts`, pure + unit-tested). `section` adds a name filter
  and per-card all-on/all-off switches (one batched mutation).
- **Style acceptance (0.0.3 additions).** The status dot uses chamber's dot
  geometry verbatim (`8px`, `border-radius: 50%`, `corner-shape: round`, state
  tokens); dialog/textarea/enable-row reuse the sheet's existing field
  vocabulary. S1 was re-verified authoritatively against the vendored pinned
  theme (368 declared tokens, 29 referenced, 0 undeclared); S2–S7 and the class
  map/CSS coverage gate are green.
- **Retained trade-off.** `draftToServer` trims and drops empty argument rows:
  the form's blank argument row is a placeholder, so preserving it would add a
  phantom empty argument to every save. A pasted explicit empty argument is
  therefore not persisted (retained by design).
- **Layout reference.** The shipped desktop layout (section surface, card
  anatomy, add/edit form, state matrix, metrics) is documented in §10
  (wireframe: `docs/mcp-desktop-layout.svg`).
- **Evidence.** `tests/client/runtime.spec.ts`, `tests/client/import.spec.ts`,
  the extended `controller.spec.ts` / `section-render.spec.tsx`, and the
  style-token gate. `scripts/verify-client-artifact.mjs` gained the `ctx.on`
  seat now that the client half subscribes to `connection/reset`.

## 13. Build & test tooling

- Deps: runtime `@modelcontextprotocol/sdk@^1.30.0`, `@deepseek-ai/schemastery@^3.18.2`,
  `zod@^4.4.3`; peers `@deepseek-ai/cordis@^4.0.2` and the eight dsh surfaces
  `@deepseek-ai/dsh-{tools,settings,credentials,workspace,session,agent,subprocess,timeout}`
  at `^0.1.2-rc.1 || ^0.1.5-rc.1` (the supported window); devDependencies pin the whole
  `@deepseek-ai/*` set to **0.1.5-rc.2** — the resolved generation, the compile-time API
  surface and the CI guard. Client externals = the official frozen platform table
  (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, cordis,
  `dsh-client-{store,ui-slots,ui-primitives,ui-dockkit}`), mirrored verbatim in
  `scripts/build.mjs`.
- Host half emitted by tsc (NodeNext ESM, explicit `.js` relative imports); client half
  bundled by esbuild (CJS; externals = official platform table + cordis) wrapped in the
  `__ModuleLoader__.load({ id, factory })` shape; d.ts emitted for both entries.
- vitest unit/integration tests: naming; document eval; per-server supervisor (the
  REAL `@modelcontextprotocol/sdk` client over stdio against the in-repo fixture — no
  SDK mock exists in the suite);
  **agent-scope gating with a real ToolRuntime + real dsh-scope createScope contexts**
  (registry get(name, scope) assertions); transport/env/credential resolution.
- M0/M1 live smoke (scratch instance from the gateway anchor CLI — dsh 0.1.5-rc.2
  measured 2026-09-14 — installing a freshly packed working-tree tarball, DSH_HOME under `.smoke/`, cookie
  driver): install tgz via `dsh plugin`, namespace
  describe/mutate, spawn evidence in boot log, workspace/session creation, tool-presence
  via mock-LLM capture; the bundle and its `settings.section` registration are served in
  the boot graph (M0). An in-GUI click-through in a real desktop session is still
  unverified — M1 records that gap; the client half is covered by jsdom render flows and
  the shipped-bundle preview harness (§9).
### Build-gate config fixes (and why)
- `tsconfig.json`: `lib` gained `"DOM"`. The tsconfig previously shipped
  `lib: ["ES2023"]` only, but the browser half (React JSX handlers,
  `HTMLInputElement`, `URL`) requires DOM typings; without it every
  `event.target.value`/`checked` access fails (`EventTarget & HTMLInputElement`
  has no `value`). Host half doesn't use DOM and is unaffected.
- `tsconfig.tests.json`: the base config excludes `tests`, which the derived
  config inherited — `tsc -p tsconfig.tests.json` could never see any test
  file (TS18003). Added an explicit `"exclude": ["node_modules", "lib"]`
  override so the mandated `npm run typecheck` gate actually checks the
  suites.

## 14. Acceptance

Acceptance matrix: docs/acceptance.md (R1–R4, E1–E8, C1–C6).
