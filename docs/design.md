# dsh-chamber-mcp — design

Architecture, contracts and deliberate deviations for the plugin. Compile and
verification target: the pinned `@deepseek-ai/*` devDependency generation, dsh
**0.2.3-alpha.2** (the compile-time API surface and the CI guard); the peer
range declares the ONE line the plugin supports and is verified against, and
the live smoke installs and boots through an anchor CLI of that line
(`DSH_ANCHOR_CLI`, read at run time; the CI smoke job requires
`DSH_SMOKE_ANCHORS`). Current release state: the GitHub Releases page; scope,
cuts and known limitations: `docs/acceptance.md`; release process:
`docs/RELEASE.md`. **Architecture A is LANDED at `0.2.6-alpha.0`:** the
plugin's own connection layer is retired into a mounted official
`@deepseek-ai/dsh-mcp-client` instance per configured server, with capture-only
façades and an applier-owned per-agent fan-out. §5(g) is the authoritative
description of that architecture, its behaviour-change ledger and the deferred
register; the limits the line carries are registered in §5(g), with the
user-facing copy collected in `docs/acceptance.md`.

## 1. Deliverable (package layout)

Single npm package **`dsh-chamber-mcp`** — dual-face + bundle (one loader row):

```
package.json           main lib/index.js; exports: "." | "./client" | "./cordis.patch.yml" | "./package.json"
                       "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
                                 "client": { "inject": [...], "platform": "web" } }
cordis.patch.yml       - insert: - id: mcp-scope, name: dsh-chamber-mcp
src/index.ts           HOST half entry: plugin shape + manager/routes/reconcile wiring
src/{manager,server-fiber,facade,host-config,upstream,oauth-authorization}.ts
                       HOST half runtime (see §5 files): bridge manager, per-
                       definition seat fibers + private upstream hosts, capture
                       façades, document adapter and OAuth registry
src/{agents,delegation,workspace,routes,schema}.ts  per-agent applier, delegation
                       narrowing, workspace cwd matching, runtime routes, Config
src/client/…           BROWSER half: settings section UI, its official sidebar-icon
                       seat and the MCP transcript lane (src/client/tool-card/),
                       compiled to lib/client.js
src/shared/…           pure types + constants shared by both halves — `model.ts`,
                       `defaults.ts`, `wire.ts` (frozen host↔browser contract),
                       `oauth.ts`; the client imports these at RUNTIME (plain
                       values and helpers, no Node built-ins) and never a
                       host-only module
lib/index.js           host ESM (tsc emit)          lib/types/**  declarations
lib/client.js          browser bundle (esbuild CJS + __ModuleLoader__.load wrapper)
```

Install (documented): `dsh plugin --profile web add <release-asset URL | local .tgz>`
(the bare npm name works only once npm publishing is re-enabled) → bundle appended
to `dsh.profile.bundles`, row inserted by patch, restart instance. Chamber: zero
code/seed involvement; the section is served through the ordinary `settings.section`
slot (in-GUI click-through still unverified — see `docs/acceptance.md`
§Known limitations).
Uninstall: `dsh plugin --profile web remove dsh-chamber-mcp` + restart stops the
servers and drops the section; leftovers (the `mcp-scope` row in the profile
patch and orphaned credential refs) are removed by hand.

## 2. Identity & plugin entry (host)

- `export const name = 'mcp-scope'` (record scope, logs), `inject = ['credentials','tools','workspaceRegistry','agents']`, `Config` = the `mcp-scope` document (`servers`/`overrides`/`disabled`, every field `.volatile()`; `src/schema.ts`), `async apply(ctx, config)`.
- Settings ride that Config: the loader serves the entry's form by profile entry id (`mcp-scope` in `cordis.patch.yml`) and commits volatile writes in place. `src/index.ts` reads the refs per operation and reconciles on `loader/volatile-update`; `settings.configure({ auto: false }, ctx.fiber)` suppresses the schema-derived auto page (Settings is an optional child, so a composition without it still runs the bridge).
- Single-instance guard: a module-level `WeakSet<Context>` keyed on `ctx[Context.root]` (`Context` is a VALUE import; dsh 0.2.3-alpha.2 removed the `ctx.root` property and the three reads are direct — no compatibility shim, because only one generation is supported; the key mirrors the official mcp-client serverName reservation) — duplicate plugin load fails loudly.
- `apply` returns fast: it reserves the instance, creates the bridge manager (`src/manager.ts`), probes the optional peers for boot diagnostics only, registers the runtime routes, runs ONE initial `reconcile()` (a boot/reload/HMR restart with servers already configured emits no `loader/volatile-update`), and subscribes to that event. Per-server seats mount asynchronously — activation is never gated on a connect.
- Boot diagnostics are non-fatal: a missing `@deepseek-ai/dsh-mcp-client` warns once and each server degrades to a fixed `failed{load}`; a configured OAuth row in a composition without the browser-authorization services warns once (`authorize` then answers `oauth-unavailable`).
- Same-name guard against the official plane: `managedPlaneNames(ctx)` reads `ctx.get('mcpManager')?.list()` structurally (no devDependency on `dsh-mcp-manager`; an absent/broken service degrades to no pre-check), and the manager treats a reserved name as `failed{conflict}` before mounting (plus a mount-race error-code fallback).

## 3. The Config document (settings domain)

```ts
// resolved: schema defaults ← composition base {} ← user layer (profile patch "mcp-scope")
servers: ServerDef[]        // serverName is the stable identity
disabled: { [serverName]: true }                       // presence = globally OFF (0.0.3)
overrides: { [workspaceId]: { [serverName]: true } }   // presence = explicitly ON
```
Document shape notes (same semantics, recorded in `docs/acceptance.md`):
(a) `overrides[w]` is a dict-of-dicts so a toggle is one atomic path op
`set/unset ['overrides', w, s]`; (b) the editor writes the upstream credential
forms — `env`/`headers` maps whose values are `${credential:REF}` templates —
while the legacy `envKeys`/`{ name, ref }` containers are READ-COMPAT only
(`src/host-config.ts` rewrites them at mount; the editor never emits them).
Semantics: **enabled(w,s) = the override row has an OWN property `s`
(`Object.hasOwn`)** — prototype-member server names must keep working. The default
is OFF: a new server, a new workspace and a fresh session register no MCP tools
until the user enables the pair, so opening a session never silently exposes a
configured server to its agent.

```ts
// shared knob surface: every field is optional and ABSENT means "upstream
// default" — a writer never materializes a default.
//   toolCallTimeoutMs (legacy timeoutMs alias, read-compat only),
//   startupTimeoutMs, closeTimeoutMs, toolLoading: 'eager' | 'on-demand',
//   reconnect (upstream policy object; schema/import pass-through only — not
//   exposed by the editor), maxInstructionBytes / catalogDescriptionMaxLength /
//   failOnStartupError (schema-carried for hand-edited documents; the editor
//   import strips + warns — not a pass-through)
ServerDef =
  | { serverName: string; transport: 'stdio'; command: string; args?: string[];
      cwd?: string; env?: Record<string, string>;   // values are ${credential:REF} templates
      envKeys?: string[];                           // legacy read-compat rows -> env templates
      …knobs }
  | { serverName: string; transport: 'streamable-http'; url: string;
      headers?: Record<string, string> | { name: string; ref: string }[];  // template map, or legacy rows
      oauth?: { credentialKey?: string; clientId?: string; scope?: string;
                requestTimeoutMs?: number; authorizationTimeoutMs?: number };
      …knobs }
// serverName: /^[A-Za-z0-9_-]{1,32}$/ (official contract); refs [A-Za-z_][A-Za-z0-9_]*
// credential template token: ${credential:REF}; values stay write-only in the credentials domain
// OAuth: streamable-http only, refused beside an Authorization header; the record key is
// derived (mcp-client/mcp-scope-<sha256(serverName)[:16]>) and never shown
```
The schema cannot express cross-field uniqueness: duplicate serverName across
`servers`, duplicate env keys or duplicate header names within one server are
rejected by the EDITOR before a write (`validateDoc`), not by the schema — and
the schema deliberately carries no transform, because a transform would not
rehydrate in the browser's `ConfigForm` default decode.

Cross-field rules (`src/shared/model.ts` `validateDoc`): unique `serverName`
(`[A-Za-z0-9_-]{1,32}`, never `__proto__` / `constructor` / `prototype` and never
a reserved override key), a required `command` (stdio) or `url` (http), no
duplicate env keys or header names, credential refs matching
`[A-Za-z_][A-Za-z0-9_]*` (the `overrides` values of exactly `true` are enforced by
the schema, `src/schema.ts`, not by `validateDoc`), valid reconnect/knob bounds,
and the two OAuth rules (http only; never beside an `Authorization` header).
The **template trap** is rejected at save time: once a row carries a credential
token the mounted host turns `${credential:…}` expansion on, so any OTHER
brace-delimited dollar expression in command/args/cwd/url is a configuration
error — `validateDoc` reports it before the write and `host.validate` refuses it
at mount (the mounted host's own schema is the mount-time authority).

**Hand-editing contract (0.1.7).** The document IS the profile-patch row
`{ id: mcp-scope, name: dsh-chamber-mcp, config: … }` in
`profiles/<profile>/cordis.patch.yml`. There is no watcher: the row is read and
validated when the Loader creates the entry (boot, profile reload, HMR), and UI
writes are the LIVE path — they commit volatile fields into the running fiber in
place and the plugin reconciles only the affected servers, without a restart. A
hand-edit that breaks the SCHEMA keeps its entry from activating at boot: the
instance log names the error and the settings section reports unavailable (there
is no in-place repair form). An edit the shape admits but the cross-field rules
forbid (duplicate serverNames/env keys/header names) is canonicalized by
`readDocument`/the editor's `validateDoc` gate rather than making the manager
throw. UI writes are leaf-level YAML diffs, so comments, anchors and formatting
survive on untouched nodes.

## 4. Host behavior

- **One seat per definition; the official instance owns the connection.** The
  manager gives every configured server a *seat*: one child fiber
  (`src/server-fiber.ts`) that isolates the five service labels
  (`tools`/`systemPrompt`/`mcpResources`/`credentials`/`mcpClientHost`),
  installs four capture-only façades (`src/facade.ts`) and constructs ONE
  private `McpClientHost`. The mounted `@deepseek-ai/dsh-mcp-client` instance
  then owns the transport (stdio spawn with scrubbed env, or Streamable HTTP),
  `${credential:…}` template resolution through the isolated credentials
  façade, reconnect/backoff, generation swap, instruction `replacement`/
  `retirement` semantics and the resource provider. The plugin never opens a
  transport, builds a tool definition or registers a tool globally.
- **Capture → applier split.** The instance registers its server-global tools,
  prompt sections and resource provider through the façade services of its own
  seat context; the façade turns them into one `CaptureSnapshot`
  (`{tools, sections, resources, truncated, version}`) and never fans out. The
  manager coalesces a whole generation swap into ONE microtask and pushes
  `{epoch, capture}` to the applier (`src/agents.ts`) — the only per-agent
  fan-out owner: tool registrations into `agent.ctx.tools`, section/resource
  replay once per epoch, idempotence `(epoch, capture.version)` with a
  monotonic floor. Enablement (workspace membership + enable record + global
  off-switch) is the ONLY gate, never tool count.
- **On-demand tool loading.** With `toolLoading: 'on-demand'` the mounted
  instance lists only the loader tool (`mcp__<serverName>__load_tools`) and
  renders the per-server catalog into the prompt. A loaded definition reaches
  an agent scope only through the tools façade, whose admission path is
  fail-closed: `get()` resolves a catalog name only for a live agent the
  applier publishes that server to, and `admit()` re-applies the workspace gate
  and the delegation narrowing and returns a revocable disposer. Loaded
  records survive a gate close (names stay, registrations revoke) and a
  same-epoch reconnect; a changed generation forgets them (upstream owns the
  loader lifecycle).
- **OAuth (O2; §5(g)).** An enabled http+OAuth row provisions its seat and a resolved
  config at reconcile time; a globally disabled row provisions them lazily when
  `authorize` runs (only the instance mount is gated), so `authorize`/`sign-out`
  work before the server is ever enabled without paying the seat cost up front.
  The authorization owner is `host.authorization(config, changed)` on the
  seat's private host: the flow's callback listener, PKCE/DCR and grant-commit
  effects live on the seat fiber, while the mounted instance keeps the grant
  read/refresh/CAS/redaction and retries itself on
  `credentials/record-updated`. The plugin keeps no grant listener.
- **Status + actions.** Three JSON routes on the Connection carrier
  (`/api/mcp-scope.status|action|tools`, §(d)) project the upstream
  `McpConnectionStatus` onto the frozen wire vocabulary: nine phases, fixed
  error codes, the token-free authorization attempt view, tool-list mode
  `definitions|catalog`, and seven actions. Upstream diagnostic text and
  credential material never cross the wire.
- **Credentials.** The seat's credentials façade wraps the REAL provider
  (captured by constructor injection, never `this.ctx.get('credentials')` which
  would recurse) and re-resolves on every attempt, rejecting CR/LF/NUL values
  (SEC-02). A missing ref surfaces as `waiting-credentials`; the mounted
  instance retries on `credentials/record-updated` (the OAuth grant commit).
- **Registration is per-agent-scope, never global** (the injection gate): every live
  agent whose session cwd canonicalizes to a registered workspace is adopted — workspace
  roots AND delegation children (`header.origin === 'subagent'`), which inherit the
  parent's cwd and therefore its workspace. A child's scope does NOT chain through its
  parent's agent scope (the harness joins it to the parent's PRESET mount,
  `dsh-agent-presets` `composeFrom` → `bindScopeParent(agentKey, standing.key)`), so
  injecting into the child itself is what makes the workspace's MCP capability reach
  it; the delegation's own narrowing is mirrored per name (`src/delegation.ts`, see
  the policy paragraph below). Workspace membership is re-derived on every
  push/reconcile, and a
  durable `domain/changed` write for the workspace domain (`src/manager.ts`
  `mcp-scope.workspace-domain()`) triggers an applier reconcile, so a deleted
  workspace — or its directory — revokes its sessions' tools promptly.
  - `agent/created` (root listener) → `workspaceIdOf(session cwd, workspaceRegistry.list())` = canonical-cwd match against
    `workspaceRegistry.list()`; if a workspace W exists and `enabled(W, s)` → apply server's
    defs into `agent.ctx.tools` (each `register()` returns disposer; tracked per agent/server).
    Workspace-less sessions (or cwd outside registered workspaces): no MCP tools.
  - Settings commit / server re-sync / credential change → a capture re-publish:
    the applier revokes stale defs and registers the current generation for
    enabled servers only.
  - `agent/disposed` → entry dropped (ctx-scoped effects die with the agent ctx).
  - Bookkeeping map keyed by Agent; all listeners/disposers effect-wrapped (HMR-safe).
  - Boot scan adopts `agents.list()` (every live agent — a running child during
    an HMR reload included; `list()` is the only registry projection the
    supported line exposes — the 0.2.2-rc.3 line removed `roots()` before it).

**Delegation policy (0.1.1).** Two upstream facts decide this shape, both re-read from
the installed harness: (1) a delegation child is composed by `dsh-subagent`
`applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`, which binds
the child's scope to its parent's PRESET **mount** — a per-preset standing scope, not
the parent's agent scope — so a registration made through a parent's `agent.ctx` is
invisible to its children ("a child that joins no preset sees an empty tool registry");
(2) `dsh-tools` `view(scope)` filters only INHERITED names through each layer's
`admits()` and deliberately keeps own-scope registrations visible ("scoped
registrations remain visible"), which is what a `ptc` preset relies on to expose MCP
tools through `run_code`. Registering into the child's own scope therefore works but
would bypass the narrowing its delegator declared — which is why the applier mirrors
that narrowing itself: the child's durable, model-hidden `subagent/descriptor` event
(only a `continuable` child carries `toolFilter: {allow?, deny?}`) is folded from the
child's OWN event window (the fork-inherited prefix is skipped) into an admission
predicate, and a server whose names are all filtered out publishes neither tools nor
context. Malformed or newer descriptors fail open with a warning (the workspace's own
enablement stays the gate). Mounting into the preset layer instead is not available to
a host-layer plugin and would leak servers across workspaces that never enabled them.

**Two limits recorded here rather than discovered later.** (1) The mirror covers
`continuable` children only: upstream persists `toolFilter` for them alone and
appends a one-shot child's descriptor — which never carries one — at its first
`agent/pre-step`, i.e. AFTER our adoption, so a deployment that configures
`toolFilter` on a one-shot delegation gets the workspace's servers unmirrored (one
info line at adoption; the shipped presets configure no filter). (2) The read uses
`session.snapshotEvents()` (deprecated in the pinned generation, as is its
semantic equivalent `ownEvents()`, which is defined as exactly
`snapshotEvents(inheritedEventCount)`) plus the `inheritedEventCount` boundary.
The module feature-detects both and fails open with a warning when either is
missing, so a future removal degrades the mirror to "unnarrowed" instead of
breaking a child's creation.
- **Tool semantics are the OFFICIAL upstream instance's** (pinned contract): the
  definition — canonical `{content, structuredContent?}` output schema, text
  projection, `taskRequired` refusal, `isError` → throw and durable image
  admission — is built inside the mounted `dsh-mcp-client` instance from the
  official `createMcpToolDefinition` adapter; the plugin captures the built
  definition and never renames or re-projects it. The public name
  `mcp__<serverName>__<rawName>` (≤64 chars `[A-Za-z0-9_-]`, 12-hex sha256
  suffix on lossy normalization) and the raw MCP inputSchema passthrough are
  therefore upstream-owned; the plugin keeps the shared `mcp__` constants only
  for client-side wire-name recognition and on-demand attribution.
- **Listing and capture bounds.** The mounted instance aggregates the 2.0
  client's `tools/list` pages itself (`listMaxPages`, 64 by default) and swaps
  generations on `tools/list_changed`; its own per-server deadlines gate the
  fetch. One server's eager generation is captured up to
  `DEFAULT_MAX_SYNC_TOOLS` (2000): hitting the cap trims the remainder and sets
  `truncated` (the seam canary is exempt for a truncated generation) instead of
  refusing the sync, and on-demand servers are not forced through the cap.
- **Global enable (0.0.3)**: reconcile never mounts a `disabled` server and
  unmounts+revokes one that is disabled while tracked; the applier reads the
  live `isServerDisabled` predicate per push/reconcile, so the model-visible
  tool set follows the switch. (An enabled http+OAuth row keeps its seat/host while disabled; a
  disabled one is provisioned lazily on authorize — no instance and no tools.)
- **Cleanup guard.** Every teardown merges the official `McpCloseResult`
  (`closeConfirmed`/`cleanupError`). An unconfirmed cleanup projects
  `failed{cleanup}`, blocks remounting until the plugin/Host restarts, and keeps
  a removed row on the status wire as a `configured:false` orphan row until the
  teardown is confirmed.
- **Context footprint**: registered definitions are ordinary request tool
  schemas, so the host's context meter prices them under "Tool definitions".
  For an enabled server the applier also replays the captured literal
  `mcp:<serverName>` prompt section (that server's `initialize` instructions,
  attributed and capped by upstream at `maxInstructionBytes`, default 32 KiB,
  `interpolate:false`) and the captured `mcpResources` provider into each
  agent scope. See README §"What the model sees".

## 5. Host half — upstream contracts, mounting and deviations

### Files created

| File | Role |
|---|---|
| `src/index.ts` | plugin entry (value exports are `name`/`inject`/`Config`/`apply` plus the documented `managedPlaneNames` helper, and type-only re-exports of the public model surface); single-instance and managed-plane guards; manager/routes/reconcile wiring |
| `src/manager.ts` | bridge orchestrator: document→lifecycle reconcile, seat/instance ownership, capture coalescing + publication, status projection, conflict/cleanup guards, the seven actions and the OAuth lifecycle port |
| `src/server-fiber.ts` | per-definition seat: ONE child fiber per configured server that isolates the five service labels, installs the capture façades, constructs the private `McpClientHost`, and owns mount/probe/authorization/teardown sequencing |
| `src/facade.ts` | capture-only `tools`/`systemPrompt`/`mcpResources`/`credentials` façades + `CaptureStore`/`CaptureSnapshot`; fail-closed catalog visibility; `replayCapturedContext` (the applier's only context path) |
| `src/host-config.ts` | the ONE document-row → upstream `ConfigInput` adapter: credential-template parse/emit, derived OAuth credential key, legacy read-compat translation, the single `host.validate` resolution shared by mount/probe/authorization |
| `src/upstream.ts` | lazy, memoized `@deepseek-ai/dsh-mcp-client` acquisition (structural `McpClientHostLike`; a failed load is never cached), definition fingerprinting, config/mount/dispose helpers |
| `src/oauth-authorization.ts` | host-side OAuth (O2): credential-key helpers, token-free wire mapping, the owner wrapper over `host.authorization`, and the registry behind the three OAuth actions (sign-out ordering) |
| `src/status.ts` | pure status projection: the wire error-code classifier, probe-failure classifier and connection-status to `RuntimePhase` projector (no I/O; imported directly by the manager/routes — no re-export shims) |
| `src/log.ts` | the one host logger surface (`HostLogger`) and control-character sanitizer used by the manager, seat, applier, OAuth registry and entry |
| `src/agents.ts` | the ONLY per-agent fan-out owner: tool registrations, per-epoch section/resource replay, loaded-tool bookkeeping/admission, delegation narrowing, revoke-on-gate-flip |
| `src/delegation.ts` | subagent `toolFilter` descriptor narrowing (folded from the child's OWN event window) |
| `src/workspace.ts` | canonical-cwd → workspace-id helper |
| `src/schema.ts` | the entry's `Config` (schemastery, every field `.volatile()`; upstream-named knobs, the OAuth block, legacy read-compat fields) + `readDocument` |
| `src/routes.ts` | three runtime routes on the Connection carrier: `status` / `action` / `tools` (fixed host codes only; §(d)) |
| `src/shared/{model,defaults,wire,oauth}.ts` | pure shared model: canonical document + `validateDoc`, the ONE defaults table / field vocabulary / normalizer, the frozen host↔browser wire contract (zero imports), and the browser-safe OAuth vocabulary |
| `tests/support/{mount-real,agent-kit,fake-seat,manager-kit,fixture-kit,http-fixture}.ts`, `tests/support/{section-harness.tsx,section-kit,section-fixtures}.ts` | shared test harnesses: the 0.2.3 real-service mount recipe, the real-agent applier kit, a deterministic fake seat for manager matrices, the manager kit, host fixtures, the in-process real Streamable HTTP fixture and the section harnesses |
| `tests/fixture/{mcp-fixture-server.mjs,oauth-auth-server.mjs}` | spawnable real MCP stdio fixture (add/greet/fail/image/crash/admin.reset/dyn_add/env_probe; instructions, one resource and one URI TEMPLATE; the unused oversized/no-resources experiment switches were removed) and the in-process fake OAuth authorization server |
| `tests/tools.spec.ts`, `tests/host/*.spec.ts` | 17 host suites (17 files) + `tests/tools.spec.ts`; browser half 15 client suites; 3 acceptance suites; `tests/delegation.spec.ts` — repo total **812 tests / 37 files** |

Run: `npm run check` — typecheck (both tsconfigs), `vitest run --coverage`, build and `verify:package` (pack contents, consumer types, bundle purity, client artifact, determinism) — fully green at `0.2.6-alpha.0`: **37 spec files / 812 tests**, coverage statements/lines **93.27 %**, branches **87.27 %**, functions **89.22 %** (floors 93 / 85 / 86 / 93). Evidence: `.scratch/exec/check-ship5.log` (EXIT 0), `.scratch/exec/verify-gen-ship4.log` (`verify-generation 0.2.3-alpha.2` PASS, no `--pin`) and `.scratch/exec/m0-ship4.log` (alpha.2 M0 live smoke PASS). The branch ratio drifts by a few hundredths of a point between runs (v8 counts async paths as they are exercised), so the thresholds — not the second decimal — are the contract.

**Deleted by this line:** `src/server.ts`, `src/transport.ts`, `src/server-context.ts`, `src/tools.ts` (the plugin's own connection layer) and `src/client/nav-icon.ts` (the retired DOM patch). The host half no longer owns a transport, a definition builder or a resource-provider registrar of its own.

### (a) API signatures and runtime assumptions

1. **Cordis fiber/inject semantics are load-bearing** (measured on cordis 4.0.2; the pinned **4.2.0-alpha.1** keeps this recipe green):
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
2. **ToolRuntime mount**: the tools service (`ToolRuntime`, renamed
   `ToolsService` on the 0.2.2 line and re-exported under the old name, so the
   imports here are source-compatible) declares
   `static inject = ['systemPrompt']` and its constructor calls
   `ctx.systemPrompt.tools(...)` unconditionally — the real
   `@deepseek-ai/dsh-system-prompt` must be mounted first (a devDependency,
   pinned to the `0.2.3-alpha.2` generation at HEAD). On `0.2.3-alpha.2` the
   system-prompt plugin ALSO injects `sessionProjections`, so
   `@deepseek-ai/dsh-session-projection` must be mounted before it or the fiber
   stays PENDING and every downstream factory ctx is `undefined` — see (b).
   `ctx.tools` only exists after that. The seat isolation relies on the same
   semantics: `ctx.isolate('tools')` gives the mounted instance a fresh label,
   so the capture façade is what its registrations reach.
3. **`SettingsForms` replaced the namespace seam (0.1.7).** There is no
   `installSection`/`settingsScope` any more: a Loader entry's own exported
   `Config` IS its settings form. Fields marked `.volatile()` are committed by
   the loader into the RUNNING fiber's references in place (it emits
   `loader/volatile-update` on the owning fiber; `Fiber.update` restarts the
   plugin only for non-volatile paths), so the host half reads the resolved
   references per operation and reconciles on that event. The browser half
   binds `ctx.configForms.get('mcp-scope')`. `dsh-config-editor` persists a
   form write to the profile's `cordis.patch.yml`, and the legacy
   `settings.yaml` is imported once into the same-id entry.
4. **dsh-tools layering**: `register()` calls
   `this.layers.effect(this.ctx, …)` — the layer is derived from the context
   the service was REACHED THROUGH (`agent.ctx.tools.register` ⇒ agent scope
   layer) and the disposer is owned by that context's fiber (dies with the
   agent scope ctx). `get(name, scopeKey?)` takes the scope key object
   (identity-compared) — the live Agent is its own key; omitted = global view.
5. **Dev-tree consistency**: every `@deepseek-ai/*` devDependency is pinned to
   the one resolved generation — `0.2.3-alpha.2` at HEAD, with cordis
   `4.2.0-alpha.1` (the peer range is `~4.2.0-alpha.1`),
   `@deepseek-ai/cordis-plugin-loader` `1.2.0-alpha.1` (the
   `loader/volatile-update` Events merge) and schemastery
   `~3.20.0-alpha.1` — so a plain `npm install`/`npm ci` resolves the tree with
   no peer relaxation and no union range (the 0.2.2-line
   `^3.18.4 || ~3.18.6-alpha.2` union existed only to bridge the old lines and
   is gone with the single-line window). Pinning the umbrella's own version
   instead of the generation its internals resolve to is what previously made
   the tree self-inconsistent; `resolveSpec` matches the runtime. Historical:
   the `dsh-settings-file` devDependency was dropped when 0.1.7 moved the
   settings into the profile patch.
6. **MCP server SDK (fixtures only)**: the repo's test fixtures are built on
   `@modelcontextprotocol/server` 2.0. `registerTool` input schemas must be zod
   schemas or raw zod shapes — plain JSON-Schema objects throw
   (`inputSchema must be a Zod schema or raw shape`). Runtime
   `registerTool`/dynamic registration auto-sends
   `notifications/tools/list_changed` when connected (`sendToolListChanged` is
   not gated on client capabilities in this build).
7. **Events payload types** arrive through type-only module imports (declaration
   merging; there are no exported event-name constants): `@deepseek-ai/dsh-agent`
   (`agent/created`, `agent/disposed`), `@deepseek-ai/dsh-credentials`
   (`credentials/reference-updated(ref)`, `credentials/record-updated(key)`),
   `@deepseek-ai/cordis-plugin-loader` (`loader/volatile-update`),
   `@deepseek-ai/dsh-storage-domain` (`domain/changed`) and
   `@deepseek-ai/dsh-client-connection` (`connection/reset`, browser half).
8. **The official host contract the seam consumes** (structural
   `McpClientHostLike` in `src/upstream.ts`, so a fake host is testable and a
   renamed verb fails the mount loudly): one `new McpClientHost(ctx)` per seat;
   `validate(input, path)` is the ONE config resolution step (mount/probe/
   authorization reuse its result); `mount(config)` returns
   `McpServerInstance = { ready: Promise<McpConnectionStatusHandle>; dispose(): Promise<McpCloseResult> }`
   whose handle exposes `current()` / `onChange()` / `closure()` and whose
   dispose result is `{ closeConfirmed, cleanupError? }`; `probe(config,
   options)` mounts nothing; `authorization(httpConfigWithOAuth, changed)`
   returns the official `McpOAuthAuthorization` owner. The upstream
   `McpConnectionStatus` union is the input of the wire projection (§(d)).
9. **Browser-authorization services (OAuth).** A deployment that offers OAuth
   must mount `authorization` and `webServer`: the official owner registers its
   callback on the `webserver/request` waterfall at
   `webServer.getOrigin() + '/mcp/oauth/callback/<sha256(credentialKey)>'`, owns
   PKCE S256 and DCR, and requires HTTPS or loopback HTTP. Both services are
   looked up with the non-throwing `ctx.get(name)`; an absent service degrades
   `authorize` to the fixed `oauth-unavailable` code.

### (b) Test-mounting recipes (reproduce)

Every host suite builds on shared harnesses instead of hand-rolled mounts.

- **Real-service mount** (`tests/support/mount-real.ts`): the 0.2.3 recipe
  SessionProjections → SystemPrompt → ToolRuntime → the tools-injecting factory
  ctx. Mounting SystemPrompt alone leaves it PENDING (its inject now includes
  `sessionProjections`) and `fiber.await()` resolves for a pending fiber, so
  every downstream factory ctx would be `undefined`.

```ts
import { mountReal } from '../support/mount-real.js'

const ctx = new Context()
const { factoryCtx } = await mountReal(ctx)
// the AGENT OBJECT IS THE SCOPE KEY:
const scope = createScope(factoryCtx, agent as never)   // agent.ctx = scope.ctx
// assertions on the agent-scoped view:
ctx.tools.get('mcp__files__read_file', agentA) // visible; agentB/outsiders undefined
ctx.tools.get('mcp__files__read_file')         // ALWAYS undefined (global never touched)
```

- **Applier harness** (`tests/support/agent-kit.ts`): REAL ToolRuntime + real
  `dsh-scope` agent contexts over a stubbed workspace registry backed by real
  temp directories; shared by `tests/host/agents.spec.ts` (gating core) and
  `tests/host/applier-admission.spec.ts` (on-demand admission).
- **Seat seam** (`tests/host/upstream-mount-gate.spec.ts`): production modules
  end to end — real manager → real seat (façades + private official host) →
  mounted official instance → real applier → real agent contexts, with only the
  fixture MCP server doubled. Rows: global layer empty, enabled/disabled agent
  visibility, revocation + re-enable, post-mount agents, `toolCount` canary,
  truncated-generation exemption, per-agent prompt section + resource replay,
  capture-only negative, official naming contract, remount without stale
  capture, disposal. The stdio fixture is
  `tests/fixture/mcp-fixture-server.mjs` (spawned with `process.execPath`).
- **Manager matrix** (`tests/support/manager-kit.ts` + `fake-seat.ts`): the
  production manager with a deterministic fake seat, a recording applier and
  stub services (`tests/host/upstream-lifecycle.spec.ts`,
  `tests/host/status-mapping.spec.ts`, `tests/host/index.spec.ts`); the fake
  seat models activation settle/status/cleanup so the mount/publish/status/guard
  matrix is fast and race-free.
- **Facade paths** (`tests/host/facade.spec.ts`,
  `tests/host/facade-integration.spec.ts`): capture state, prompt/resource
  replay, credentials CR/LF/NUL, plus the real official instance over the
  in-process real Streamable HTTP fixture (`tests/support/http-fixture.ts`).
- **OAuth** (`tests/host/oauth-authorization.spec.ts`,
  `tests/host/oauth-acceptance.spec.ts`): credential keys, wire mapping, owner,
  registry, manager integration and routes; the acceptance suite drives the
  REAL official browser flow against `tests/fixture/oauth-auth-server.mjs` (the
  in-process fake authorization server) through the seat's private host.
- **Config/settings** (`tests/host/settings.spec.ts`, `index.spec.ts`):
  `Config` resolves from the legacy `mcp-scope:` section shape, volatile fields
  are live references, malformed input is refused, the entry id is pinned, and
  the entry-wiring cases (volatile-update reconcile, auto-page suppression,
  route mount) hold. The full profile-patch → volatile-commit → reconcile path
  is exercised by the M0 smoke on a real 0.2.3-alpha.2 anchor.

Typecheck note: `tsc -p tsconfig.json` compiles the whole `src/` tree — the
browser half under `src/client/` must stay error-free for the shared gate, and
it is.

### (c) Landed design, deviations and why

This list describes the `0.2.6-alpha.0` tree. Everything the pre-landing plan
listed as a target has landed; §5(g) owns the architecture summary, the
behaviour-change ledger and the deferred register.

1. **`src/schema.ts` owns the Config** (not in the original file list): the
   schema had to be importable by tests while `src/index.ts` keeps its exports
   exactly `name`/`inject`/`Config`/`apply` (namespace-plugin contract). The
   file exports `Config` (the entry's settings form: the three document fields,
   each `.volatile()`, plus the upstream-named knob fields, the OAuth block and
   the legacy read-compat containers), `readDocument` (the manager-facing read
   delegating to the shared `canonicalDoc`) and the `ConfigField` accessor.
   There is deliberately no second, non-volatile schema: the entry's Config IS
   the document, and a parallel node would only invite drift.
2. **The mounted instance registers server-global; the applier fans out per
   agent.** The official instance's `syncTools`/`registerServerContext` write
   into the services of its own seat context, and those services are the capture
   façades — so no definition ever reaches a real registry directly. The manager
   publishes the captured generation, and `src/agents.ts` is the ONLY code that
   calls `agent.ctx.tools.register`. Generation discipline (fetch-then-commit,
   serialized sync chain, failed fetches keep the previous generation) belongs
   to the upstream instance.
3. **Rich content takes the official path inside the instance.** Every
   definition is built by the upstream `createMcpToolDefinition` adapter and
   captured as built: canonical `{content, structuredContent?}` validation,
   `taskRequired` refusal, `isError` → throw, durable image admission and the
   naming contract (`mcp__<serverName>__<rawName>`, ≤64 chars, 12-hex sha
   suffix on lossy normalization) are upstream-owned now. The plugin keeps only
   the shared `mcp__` constants for client-side wire-name recognition and
   on-demand attribution; it installs no projection hook. An image block
   becomes a durable attachment when the composition provides an `attachments`
   store AND the current model route declares image input; every other case
   projects the diagnostic `[image unavailable: <mime>; <reason>; raw image
   data remains available to programmatic callers]` while the canonical value
   keeps the raw blocks — base64 never reaches model history.
4. **Same-name conflict is detected, not left to mount order.** The plugin
   reads the official manager plane structurally
   (`ctx.get('mcpManager')?.list()`) and refuses a reserved `serverName` with
   the fixed `failed{conflict}` before mounting; a mount-race rejection carrying
   the upstream "already in use by another mcp-client instance" text maps to
   the same code (the upstream host reserves `serverName` per application root
   and would otherwise throw). There is no shadowing and no second process.
5. **Document-driven connection policy.** Reconnect defaults are upstream's
   (`enabled`, 500→30 000 ms, 10 attempts); the document can carry an explicit
   `reconnect` object (import pass-through — the editor does not expose it
   yet), and the timeout/`toolLoading` knobs are document fields with upstream
   defaults (absent stays absent). `failOnStartupError` is forced `false` on
   mount: a failing first connect must not fail the seat fiber, so each server
   degrades to a fixed wire code instead.
6. **Enablement is read LIVE per push/reconcile** (never cached in the
   applier): workspace membership and the enable/off-switch maps are re-read
   per event (one `workspaceRegistry.list()` snapshot per push/reconcile; the
   canonical cwd is `realpathSync`-resolved once per session and memoized until
   agent disposal or a registry change); `reconcile()` is a plain diffed pass and
   the applier's idempotence is `(epoch, capture.version)` with a monotonic
   floor, where the manager-owned epoch bumps on every mount, so a restarted
   instance's first publish is never absorbed by the previous instance's last.
7. **Log prefixes.** Connection-layer lines are the upstream instance's
   `mcp-client(<server>):`; the plugin's own lifecycle/diagnostic lines use
   `mcp-scope(…)` (and `mcp-scope(<server>):` in seats), so smoke logs can
   assert both.
8. **Semantic choices validated by tests**: after `agent/disposed` only
   bookkeeping is dropped (scope-layer entries are owned by the agent ctx's
   fiber — verified by disposing the scope ctx); disposers are only invoked
   while the agent is still live (`agents.get(id) === agent`); capture
   notifications are contained and never throw into an upstream registration
   path.
9. **One declared peer line: dsh 0.2.3-alpha.2.** The compile anchor, every
   `@deepseek-ai/dsh-*` devDependency and the CI guard pin that ONE generation
   (cordis 4.2.0-alpha.1, `cordis-plugin-loader` 1.2.0-alpha.1, schemastery
   ~3.20.0-alpha.1); the peer range is the single line `^0.2.3-alpha.2` (cordis
   `~4.2.0-alpha.1`) and the live smoke runs one anchor of that line. The
   multi-line window (0.2.0/0.2.1/0.2.2) is closed: **0.2.5 is frozen as the
   last release of the old line**, and this tree carries no compatibility shims
   for older generations. Measured on 2026-11-23: `npm run check` green
   (37 files / 812 tests, coverage thresholds, packed artifact + determinism),
   `verify-generation 0.2.3-alpha.2` PASS with NO `--pin` (the dev pin IS the
   generation under test) and the alpha.2 M0 live smoke PASS. The mounted
   client layer is still the v2 SDK, owned by the official instance: this
   plugin imports no SDK itself and keeps `@modelcontextprotocol/server` and
   `zod` as test-fixture-only devDependencies (its only runtime dependency is
   `@deepseek-ai/schemastery`). `dsh-mcp-client`, `dsh-scope`,
   `dsh-client-ui-slots` and `dsh-api-workspace-controller` are REQUIRED
   peers now (the client peer was optional on the old line; the attachment,
   subprocess and timeout peers are gone) and the host is
   loaded through `src/upstream.ts`'s memoized dynamic import — a missing peer
   degrades each server to `failed{load}` instead of failing plugin activation,
   and a failed load is not cached. What the new line changed in this tree:

   - **`ctx.root` is gone.** dsh 0.2.3-alpha.2 removed the property, so the
     three reads in `src/index.ts` are written directly as
     `ctx[Context.root]` (with a VALUE import of `Context`). No shim or
     feature-detected accessor is kept: one line is supported, and a host
     outside the peer range is refused by the runtime preflight before it can
     load.
   - **Test-mount recipe.** `@deepseek-ai/dsh-system-prompt` now injects
     `sessionProjections`; a bare `ctx.plugin(SystemPrompt)` stays PENDING and
     `fiber.await()` resolves for a pending fiber, so the tools-injecting
     factory ctx came back `undefined` (25 suite failures in the unpatched
     derived tree). The shared recipe `tests/support/mount-real.ts` mounts
     `SessionProjectionRegistry` → `SystemPrompt` → `ToolRuntime` → the factory
     ctx; `tests/host/agents.spec.ts` and `tests/host/applier-admission.spec.ts`
     use it. The new devDep is
     `@deepseek-ai/dsh-session-projection@0.2.3-alpha.2`.
   - **Official manager.** The Web profile still mounts
     `@deepseek-ai/dsh-mcp-manager` on this line, and it still maps no
     Workspace, so the two planes coexist. A same-name configuration is now
     the hard `failed{conflict}` described in item 4 — not shadowing and not
     two registrations.
   - **Live smoke.** One anchor of the declared line per run
     (`DSH_ANCHOR_CLI`; in CI the smoke job requires `DSH_SMOKE_ANCHORS`). M1's
     model-facing capture has recorded `not-captured` on every headless 0.2.x
     anchor measured so far — transcript evidence, not a gate; the positive
     evidence on every anchor is M0's synced tool list. The old lines are
     retired with 0.2.5 and no longer run.

   `@deepseek-ai/dsh-mcp-resources` remains an optional peer: its absence only
   removes the shared resource tools (the capture/replay path degrades to no
   provider). The 2.0 client's hand-rolled `tools/list` pagination,
   repeated-cursor guards and legacy `toolResult` normalization are gone with
   that client; `listMaxPages` (default 64) is the non-converging-cursor
   defence, owned by the mounted instance.
10. **Two bounds kept.** `DEFAULT_MAX_SYNC_TOOLS` (2000) caps one server's
    captured eager generation because `listMaxPages` bounds PAGES and not
    items: 64 pages × 1000 tools would otherwise drive unbounded per-agent
    registration fan-out (SEC-05). Hitting the cap trims-and-flags instead of
    refusing the sync, and the on-demand mode is not forced through it. It is
    this plugin's own control, not SDK duplication.
11. **Cleanup guard replaces the plugin's old close discipline.** Upstream owns
    transport close semantics now (including the 2.0 client's `mode: 'auto'`
    era negotiation, which spawns a disposable sibling process per stdio
    connect and reaps it before the caller's transport starts — visible in the
    smoke transcripts). The plugin's own guard is the `McpCloseResult` merge:
    an unconfirmed instance/owner teardown reports `failed{cleanup}`, keeps a
    removed row as a `configured:false` orphan row, and blocks remounting until
    the plugin/Host restarts (D6).
12. **Two optional consumers, captured then replayed per agent.** The mounted
    instance contributes a literal `mcp:<serverName>` system-prompt section at
    the centrally allocated `MCP_SERVERS` order, and an `mcpResources`
    provider so the service-owned `list_mcp_resources` /
    `list_mcp_resource_templates` / `read_mcp_resource` tools can reach that
    server. The applier replays both into each ENABLED agent's own
    `systemPrompt`/`mcpResources` scope, once per epoch; a composition without
    those services degrades to a no-op. The section carries the server's
    `initialize` instructions (attributed, `interpolate:false`, capped by
    upstream at `maxInstructionBytes`, default 32 KiB) and is retracted on
    epoch change/gate close/teardown/give-up — revoking the tools while leaving
    the prose up would keep telling the model to call `mcp__<server>__*` names
    that no longer exist. The provider's declared-capability gate and error
    path are upstream's (an undeclared `resources` capability answers an empty
    page and never asks the client).

### Remaining risks

- The full plugin `apply` (Config + manager inside one real composition with
  the actual dsh-base service stack) is not exercised by the unit suites alone —
  its pieces are (settings spec resolves the Config schema and the live-field
  contract; `upstream-mount-gate` drives production modules end to end over the
  stdio fixture; the agents/applier specs drive the real gate). The M0/M1 smoke
  (a real 0.2.3-alpha.2 anchor instance) remains the true end-to-end gate, and
  M0 exercises the settings write → volatile commit → reconcile → connect path
  through the real settings RPC.
- `dsh-system-prompt` is a devDependency because the host suites mount the
  real service; the old cross-line matrix once added `dsh-atomic-write` /
  `dsh-home-paths` and required `--legacy-peer-deps`. The tree now pins the
  whole `@deepseek-ai/*` set to `0.2.3-alpha.2` and the flag is gone.
  `dsh-settings-file` was dropped with the 0.1.7 move.
- `tests/fixture/{mcp-fixture-server,oauth-auth-server}.mjs` child processes
  rely on repo `node_modules` resolution (spawned with `process.execPath` from
  the repo cwd); moving either fixture would break the mount/seam and OAuth
  acceptance specs.
- OAuth's real browser flow cannot be scripted in jsdom: the acceptance suite
  drives the official flow against an in-process fake authorization server, and
  the actual popup/browser callback is a manual/live check (same class as the
  unscripted UI click-through, `docs/acceptance.md` §Known limitations).

### (d) 0.0.3 — runtime status, manual control, timeouts (wire v2 at 0.2.6-alpha.0)

- **Carrier choice.** The status/actions ride `ctx.connection.fetch.register`
  (`/api/mcp-scope.status|action|tools`), the same seam the official
  `/api/present.host` (`dsh-client-ui-deliverables`) and `/api/session.export`
  (`dsh-session-log-export`) routes use, registered through a nested
  `ctx.inject(['connection'], …)` so a headless host never mounts them. A custom
  Remote namespace was rejected: the client assembly's namespaces are a
  compile-time selection this plugin cannot extend, and a custom RPC channel has
  no in-tree usage. Riding `/api` also means the chamber gateway's reverse
  proxy, Host/Origin fence and browser auth apply unchanged.
- **Frozen wire vocabulary** (`src/shared/wire.ts`, zero imports; the browser
  re-exports it): three routes; `v: 1`; nine phases (`connected`,
  `connecting`, `reconnecting`, `waiting-credentials`,
  `waiting-authorization`, `failed`, `stopped`, `disabled`, `unknown`);
  fourteen fixed `error.code` values (`gave-up`, `reconnect-disabled`,
  `generation-stuck`, `forbidden`, `timeout`, `spawn-failed`, `protocol`,
  `connection-failed`, `load`, `cleanup`, `conflict`, `config`, `seam`,
  `invalid-credential`); the token-free authorization attempt view (seven
  attempt phases, five `authReason` values); tool-list mode
  `definitions|catalog`. The host projects the upstream `McpConnectionStatus`
  onto this union and degrades an unknown future variant to a fixed
  `failed{load}` (never a healthy phase); a whitelist drops any upstream
  reason or attempt phase it does not know.
- **Snapshot shape.** Per server: `name`, `phase`, `configured`,
  `toolCount`, `attempts`, `maxAttempts`, `nextRetryAt?`, `connectedAt?`,
  `syncedAt?` (host-sourced: set when a capture generation is published),
  `authReason?`, `authorization?` and `error?: { code }`. `?server=NAME`
  projects exactly the same entry shape; a name outside
  `SERVER_NAME_PATTERN` keeps the shared `400 bad-request` envelope, an
  unknown name answers `ok:true` with an empty list, and an omitted/empty
  parameter keeps the untouched full view (so one card refreshes itself without
  re-reading the table). A removed row whose teardown is unconfirmed stays as a
  `configured:false` orphan row.
- **Error text never crosses the wire.** Routes carry ONLY a fixed
  host-generated `code` (plus a fixed message for business failures); the
  raw/sanitized transport text stays in the host log. The earlier
  `***`-redaction approach was removed: remote bodies (which the SDK embeds in
  errors) can echo a credential in an encoding the substring pass cannot catch,
  and "no secret in any response" is only enforceable by never sending the text.
- **Seven actions** (POST `/api/mcp-scope.action`, all serialized on the
  manager's mutation chain): `connect` (clears the manual-stop latch),
  `disconnect` (latches by definition fingerprint and revokes first),
  `restart`, `test` (read-only on a connected generation; otherwise a
  throwaway seat-host probe; its fixed codes include `oauth-required`),
  `authorize`, `cancel-authorization` and `sign-out` (sign-out ordering is
  retire → disposeOwner → unmount → `deleteRecord` → mount; an unconfirmed
  cleanup keeps the grant and reports `failed{cleanup}`). Business failures map
  to 400/404/409/500 (`oauth-not-configured`/`oauth-unavailable`/`oauth-busy`
  and config/load: 409; `oauth-failed`/`oauth-cleanup`: 500).
- **Manual stop.** `manualStopped` is keyed by the definition fingerprint: a
  reconcile with an unchanged definition leaves the server off, while a changed
  definition or `connect()` clears the latch. Disconnect unmounts with the
  tools revoked immediately.
- **Capture/cleanup guards.** A stuck generation maps to `failed`
  (`generation-stuck`); an unconfirmed teardown maps to `failed{cleanup}` and
  blocks remounting until the plugin/Host restarts (`mergeCleanupFailure`);
  `toolList` answers `not-connected` unless the live generation is connected
  and the response carries `total` next to `truncated`; on-demand servers
  answer `mode:'catalog'` with an empty `tools` list and the offered count.
- **Prototype-safe sparse maps.** `pruneDisabled`/`renameDisabledKey` build
  their results with `Object.fromEntries`, so a literal `__proto__` key stays
  an own entry instead of mutating the prototype.
- **Test coverage.** `tests/host/routes.spec.ts` (three-route envelope, status
  codes, action union, no-store/no-token rules, 409 mapping),
  `tests/host/status-mapping.spec.ts` (every `McpConnectionStatus` row, filter
  byte-identity, catalog mode, unclosed-generation guard),
  `tests/host/upstream-lifecycle.spec.ts` (manual-stop latch, mount/unmount,
  cleanup guard rows), `tests/host/oauth-authorization.spec.ts` (routes +
  owner/registry) and the browser store's `tests/client/runtime.spec.ts`.

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

**Re-measured on 2026-09-16, and the document-derived signals are not enough in
the chamber** (the release-0.1.0 build shipped with this panel blind again: every
card `状态未知`, the header's Refresh doing nothing). In that shell the assets are
root-relative too — `/plugins/…` with `<base href="/">`, not
`/api/i/<id>/plugins/…` — so neither the pathname nor the resource timeline
names the instance, and the root-relative request is answered by the static layer
with `404 {"error":"not_found"}` again. Two further signals close it:

1. **The shell's own service.** The chamber's entry plugin `provide`s
   `chamberBasePath` (`/api/i/<instanceId>`) to the client plugins it mounts, so
   the store reads it through a `shellBasePath` accessor (absent in a plain
   `dsh web` context has no such service at all), read through cordis's
   non-throwing accessor: a bare PROPERTY read of a service no fiber provided — and
   that this fiber never declared in `inject` — THROWS
   (`cannot get property "X" without inject`, the semantics `src/client/index.ts`
   itself documents at §10), so it would have aborted the first refresh before a
   single request and left a plain `dsh web` deployment worse off than before the
   fix. `ctx.get(name)` returns the value or `undefined` and is what the shell's
   own plugins use; the value must also look like `/api/i/<token>` (a dotted id
   would be normalized by the browser into a different path). The live shell answer
   is put ahead of every sniffed value AND of any recovered prefix.
2. **One guarded recovery.** When NO candidate answered with this plugin's wire
   envelope, the store asks the shell's same-origin connections projection
   (`GET /api/connections`) which instance is on screen, validates the id as a
   plain token, and retries once with `/api/i/<id>`. It is bounded: at most two
   probes per store, and ONLY the caller that starts a probe spends budget (a
   concurrent caller joins the probe in flight). An explicit refresh re-arms the
   budget, and `connection/reset` drops the dead-base cache, the recovered prefix
   and the budget too, because a new connection generation means the previous
   answers prove nothing. It runs only
   after a route-missing 404 (so no request is ever delivered twice), concurrent
   callers join one probe, and a cross-origin or origin-less document is never
   probed. A plain `dsh web` deployment that serves the routes answers on its
   first candidate (one root-relative request); one that does not degrades through
   the same bounded probe, once per store unless a refresh re-arms it.

The store resolves that prefix per call and tries it in order: with a LIVE shell
answer, ONLY that base and the root origin (the shell names the instance on
screen, and any other prefix could be a different one); otherwise the FRESHLY
sniffed document base, then a recovered prefix, then the remembered base, then
the root origin; and once the shell has named an instance it stays PINNED for
that connection generation, so a shell that stops answering narrows the panel to
that instance plus root rather than letting a stale or sniffed prefix serve
another one (a live page can switch instance,
and a base that still answers would silently serve the OLD instance — a recovered
prefix is dropped the moment the shell reports a different one, and when it stops
answering route-missing it is dropped so the next attempt may re-discover). Only an **origin-level 404 that carries no
plugin wire envelope** falls through to the next candidate — a transport error,
an auth refusal or a business failure would repeat identically, and a POST must
never be delivered twice. The base that answered is remembered and re-validated
on every call, so a stale guess self-heals. A value is accepted only when it is
a rooted same-origin path (absolute URLs would violate the shell's
`connect-src 'self'`), and an absent/unsafe value leaves the plain topology on
its single root-relative request. Version skew is safe in both
directions: an older host ignores `?server=` and answers the full view, which
the per-server merge folds correctly.

### (f) Registered-tools notice (conversation lane)

The plugin registers MCP tools into an agent's scope as ordinary tool schemas
(priced under "Tool definitions"), and on a host that provides the allocation key
it publishes a server's own `instructions` as a literal prompt section — but
neither told the user, in the conversation, which MCP servers and tools the
session had been given. This notice closes that gap as a UI hint — derived, never
written — through the platform's own seams rather than a new channel:

- **Why nothing is written**: a private REQUIRED session event would be
  required-on-read. The persisted envelope's `ignorable?: true` marker is the
  only admission a reader honors for a type it does not know; an event appended
  WITHOUT that marker makes `validateStoredEvents` refuse the WHOLE log,
  including for the harness that wrote it (out-of-repo plugin types are outside
  the build-generated `KNOWN_SESSION_EVENT_TYPES` set by construction), which is
  why the earlier `mcp-scope/injected` revision made the session unreadable to
  every reader. Upstream DOES expose a writer — `appendPluginRecord` (present
  on the 0.2.2 line and the current 0.2.3-alpha.2 line; absent from 0.2.0-rc.1)
  — but this notice deliberately does not persist: it is a derived hint that
  needs no log entry, plugin records are best-effort across format migrations
  (the owner validates restored data, and a V3→V4 migration can re-home an
  unknown V3 event into the `plugin:` namespace), and a write path would owe a
  feature-detect and format-migration story even on the single declared line. Upstream
  rationale:
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
- **On-demand catalogs.** An on-demand server exposes only the loader tool
  (`mcp__<server>__load_tools`), not its tools' public names, so the notice also
  parses the catalog section the mounted client renders into the system prompt.
  SECURITY: tool DESCRIPTIONS render into the same prompt, so a section is
  accepted only when its heading starts a line, names a legal server name, and
  the first non-empty line below is the client's EXACT loader sentence naming
  THAT server; the catalog is then honored only for a configured server actually
  in `toolLoading: 'on-demand'` mode. The loader tool is never counted as a
  catalog tool; the entry carries the catalog size plus a bounded RAW-name list,
  and the row renders the catalog under its own disclosure.
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
  whose first line names every source and its count (`injection.entry`, or
  `injection.catalog` — "<name> · N catalog tools" — for an on-demand source)
  and whose remaining rows give each source its own disclosure over its public
  tool names (raw catalog names for a catalog source). No shipped component is imported — the
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

### (g) Landed architecture A (0.2.6 line)

**Status: LANDED at `0.2.6-alpha.0`.** This section is the authoritative
description of the shipped architecture; §4 and §5(c) describe its runtime
consequences, and §5 lists the module inventory. User-facing limitations:
`docs/acceptance.md` §"Known limitations".

**Decision.** The plugin no longer owns a connection layer. Every configured
server is a **seat child fiber** — one fiber per DEFINITION, not per connect —
which isolates `tools` / `systemPrompt` / `mcpResources` / `credentials` /
`mcpClientHost`, provides four **capture-only façades** over those isolates,
constructs ONE private `McpClientHost` (under the credentials isolate, so the
OAuth owner resolves through the façade) and mounts one official
`@deepseek-ai/dsh-mcp-client` instance through it. The mounted instance owns
transport, credential templates, reconnect/backoff, generation swap,
instruction `replacement`/`retirement` semantics, resource providers and the
OAuth grant read/refresh/redaction. The plugin keeps the document, the
per-workspace gate, the settings UI, status/actions, the OAuth *attempt* flow
and the transcript/notice lanes.

**Module responsibilities (host half).**
- `manager.ts` — orchestrator and lifecycle owner: document→records diff,
  seat/instance mount/unmount, capture coalescing/publication, status
  projection, conflict/cleanup guards, the seven actions, the OAuth lifecycle
  port and the serialized mutation chain.
- `server-fiber.ts` — the seat: isolation + façades + private-host creation
  inside one child fiber; exposes mount/capture/reset/disposeSeat/
  authorization/probe/disposeSeat. Its `apply` never mounts (activation order).
- `facade.ts` — capture-only services and `CaptureStore`; the snapshot is
  `{tools, sections, resources, truncated, version}`. The whole capture set is
  owned by ONE store-level seat effect installed in `createFacades` (upstream
  discards some registration disposers, so per-registration effects would
  accumulate): captures survive a registrar fiber ending, clear when the seat
  unloads, and notify the manager on change/removal. `ToolsFacade.get` is fail-closed;
  `replayCapturedContext` is the applier's only context path.
- `upstream.ts` — the only import of `dsh-mcp-client`: memoized dynamic load
  (a failed load is not cached), structural `McpClientHostLike`
  (`validate`/`mount`/`probe`/`authorization`), definition fingerprint,
  mount/dispose helpers. The old tree's adapter use is gone.
- `host-config.ts` — the ONLY document-row → upstream `ConfigInput` adapter:
  upstream-named fields, legacy `envKeys`/header-row/`timeoutMs` translation,
  the `${credential:REF}` template parser/emitter, the derived OAuth
  credential key, and the single `host.validate` call whose result
  mount/probe/authorization reuse until the definition changes.
- `oauth-authorization.ts` — O2: credential-key helpers, token-free wire
  mapping, the owner wrapper over `host.authorization(config, changed)` and the
  registry behind `authorize`/`cancel-authorization`/`sign-out`.
- `agents.ts` (+ `delegation.ts`) — the ONLY per-agent fan-out: tool
  registrations, per-epoch context replay, on-demand loaded-tool bookkeeping/
  admission, delegation narrowing, revoke-on-gate-flip.
- `routes.ts` + `shared/wire.ts` — the frozen status/action/tools contract.
- `index.ts` — activation: instance reservation, manager creation, boot
  diagnostics, route mount, initial reconcile, live-config listener and
  settings auto-page suppression.

**Seat lifecycle sequence (measured; `tests/host/upstream-mount-gate.spec.ts`
drives production modules end to end).**
1. `reconcile()` runs on the manager's serialized mutation chain and diffs the
   live document against the tracked records.
2. A new/enabled server: `ensureSeat` → `createServerSeat` starts the seat
   child fiber (`ctx.plugin(seatPlugin)`) and awaits it; the seat `apply`
   isolates the five labels, installs the façades, constructs the private
   `McpClientHost` and publishes its lifecycle handles — then RETURNS without
   mounting. (A service of a still-loading provider is not resolvable, and
   awaiting `instance.ready` inside `apply` would deadlock activation.)
3. The manager resolves the ONE upstream `Config` for the definition
   fingerprint (`host-config` → `host.validate`) and calls
   `seat.mount(config)`.
4. The instance's `ready` promise settles; the manager attaches the status
   observer and marks the record `attached`. Capture publications are held
   until then so a restart cannot publish a half-registered generation.
5. The instance registers tools/sections/resources through the façade services;
   each net change notifies the manager synchronously, which schedules ONE
   coalesced microtask publish of `{epoch, capture}` to the applier.
6. Status changes project onto the wire; on `connected` the seam canary
   compares the eager capture count with the instance's `toolCount` and
   degrades a mismatch to `failed{seam}`.
7. Stop/removal: the OAuth owner is retired/disposed while the seat fiber is
   still live, then the instance is disposed (its `McpCloseResult` merged),
   then the seat fiber. A confirmed teardown drops the record; an unconfirmed
   one keeps a `configured:false` orphan row and blocks remount
   (`failed{cleanup}`) until the plugin/Host restarts. A definition change
   remounts on a fresh seat (new epoch) and retires the previous OAuth owner.
8. Plugin teardown: `oauth.disposeAll()` → every instance unmount + seat
   disposal → `applier.dispose()` (revokes live registrations).

**Capture/applier split (the one-way data path).** upstream registration →
façade capture → `CaptureSnapshot` → manager coalescing → applier:
per-agent-scope tool registration, section/resource replay, idempotence
`(epoch, capture.version)` with a monotonic floor. The applier is synchronous
and total; failures are contained to the logger. Enablement is the only gate;
the capture is capped at `DEFAULT_MAX_SYNC_TOOLS` (2000, truncate-and-flag,
seam-exempt) and never fans out from the façade.

**OAuth O2 data flow.**
1. A configured http+OAuth row (the `oauth` block's presence enables
   authorization; refused for stdio and beside an `Authorization` header)
   gets its seat + one resolved config lazily — an enabled row at reconcile time,
   a globally disabled row only when the authorize action needs it — while
   manually stopped; only the instance mount is gated.
2. `authorize(name)` = action route → manager (serialized) → ensureOAuthBinding
   (provision the seat/config when missing) → registry `authorize` → a cached
   owner per (serverName, definition fingerprint) creates
   `host.authorization(config, changed)` lazily on the seat's private host.
3. The official flow owns PKCE/DCR, the `webserver/request` callback listener
   and the grant-commit effect on the seat fiber; the attempt view is projected
   token-free (id, phase, authorization URL only while `waiting-browser`).
4. The manager waits OUTSIDE the mutation chain (bounded ~5 s) for
   `waiting-browser`/a terminal phase and returns the view, so the browser
   opens the page from the action response without polling; the grant commit
   reaches the browser as `credentials/record-updated` and the store refreshes
   silently.
5. Grants live in the credentials domain under the derived key
   `mcp-client/mcp-scope-<sha256(serverName)[:16]>`; the mounted instance
   reads/refreshes/CAS/redacts them and retries itself on the update event. The
   plugin never reads a grant and only ever DELETES the record on sign-out.
6. `sign-out` = retire → disposeOwner (bounded, cleanup-confirmed) → unmount →
   `deleteRecord` → mount; an unconfirmed cleanup keeps the grant, reports
   `oauth-cleanup` and retains `failed{cleanup}`. The wire carries only the
   frozen attempt view + five reason enums; upstream text never crosses it.
7. Availability: `authorization` + `webServer` must be mounted (else the fixed
   `oauth-unavailable` code). OAuth requires HTTPS or loopback HTTP and a
   browser that can reach `webServer.getOrigin()`.

**Wire/status vocabulary (frozen; `src/shared/wire.ts`).**
- Phases (9): `connected`, `connecting`, `reconnecting`,
  `waiting-credentials`, `waiting-authorization`, `failed`, `stopped`,
  `disabled`, `unknown`.
- Error codes (14): `gave-up`, `reconnect-disabled`, `generation-stuck`,
  `forbidden`, `timeout`, `spawn-failed`, `protocol`, `connection-failed`,
  `load`, `cleanup`, `conflict`, `config`, `seam`, `invalid-credential`.
- Authorization reasons (5): `missing`, `expired`, `binding`, `rejected`,
  `scope`. Attempt phases (7): `starting`, `waiting-browser`, `exchanging`,
  `committing`, `authorized`, `cancelled`, `failed` (+ a fixed
  `failure` enum: `timeout`, `cleanup`, `rejected`, `failed`).
- Actions (7): `connect`, `disconnect`, `restart`, `test`, `authorize`,
  `cancel-authorization`, `sign-out`; action failure codes: `bad-request`,
  `not-found`, `not-connected`, `disabled`, `conflict`, `cleanup`,
  `load`, `config`, the six `oauth-*` codes, `internal`.
- Tool list: mode `definitions|catalog`; an entry has no `rawName` field at
  all — it carries `publicName` + the capped description, and the raw MCP name
  only ever goes to the server; `total` >= `tools.length` when truncated;
  on-demand servers answer `catalog` with an empty entry list.
- Response envelope: `{ ok, value }` / `{ ok:false, error:{ code, message } }`,
  `cache-control: no-store`, `v: 1` on the status view; routes are
  GET-status / POST-action / GET-tools, `?server=` supported on status and
  tools. Never an upstream message, credential value or token; an attempt id is
  never echoed.

**Behaviour-change ledger (0.2.6-alpha.0 vs 0.2.5).**
1. Connection-layer ownership retires into the mounted instance: the plugin's
   transports, reconnect policy, probe, instruction publishing and
   resource-provider registration are gone; client identity on the wire is the
   official `dsh-mcp-client`, and connection-layer log lines are upstream's
   `mcp-client(<server>):` (plugin lines stay `mcp-scope(…)`).
2. A missing credential ref reports `waiting-credentials` (no connection
   attempt) instead of silently skipping the key; values are re-resolved per
   attempt through the credentials façade, which rejects CR/LF/NUL.
3. The same `serverName` (official plane or another instance) is a hard
   `failed{conflict}` — read-only `ctx.get('mcpManager')?.list()` pre-check
   plus a mount-race error-code fallback — not shadowing and not two
   independent processes.
4. `DEFAULT_MAX_SYNC_TOOLS` (2000) is an eager-capture truncate-and-flag; it
   never refuses the sync, the seam canary is exempt for a truncated
   generation, and on-demand is not forced through it.
5. The tools route marks `mode:'catalog'` for on-demand servers, and a tool
   entry has no `rawName` field at all: `publicName` + the capped description
   only (the raw MCP name is never on the wire).
6. Listing details follow upstream: `cwd:''` when absent, `listMaxPages`(64),
   tool-call 60 s / startup 30 s / close 5 s defaults, and mount never blocks
   activation (`failOnStartupError` is forced `false`; every server degrades to
   a fixed wire code instead).
7. Reconnect becomes a document pass-through with upstream defaults
   (`enabled`, 500→30 000 ms, 10 attempts): the plugin's fixed-value
   maintenance surface is gone, while the editor still does not expose it.
8. A tool-less server's instruction section and resource provider ARE
   published (the gate is enablement-only, never tool count).
9. A gate flip no longer replays context sections (no replacement/retirement
   noise); only an epoch change replays them.
10. An unconfirmed instance/owner teardown reports `failed{cleanup}`, keeps a
    `configured:false` orphan row and blocks remounting until the plugin/Host
    restarts.
11. Status wire v2: nine phases, fixed error codes, the token-free attempt
    view and the catalog tool-list mode; seven actions replace the old
    three-verb action surface (restart/authorize/cancel-authorization/sign-out
    added), with fixed business codes and 400/404/409/500 mapping.
12. On-demand tool loading is a NEW capability: document field
    `toolLoading: 'eager'|'on-demand'`; the mounted instance lists only the
    loader tool and renders the catalog; a loaded tool reaches an agent scope
    only through the façade's fail-closed `get`/`admit` path (workspace gate +
    delegation narrowing, revocable); loaded records survive gate flips and
    same-epoch reconnects and are forgotten on a generation change.
13. OAuth browser authorization is a NEW capability (O2, above): grants live
    in the credentials domain under a derived key, flows run through the seat's
    private isolated host, and the plugin only deletes grants.
14. The browser half owns the official `settings.section.icon` seat (the
    `nav-icon.ts` DOM patch is retired), renders the OAuth panel
    (Authorize/Authorize again, Cancel, Sign out after confirmation, copyable
    URL fallback for a blocked popup) and the on-demand catalog hint; its MCP
    transcript row titles the loader tool "Load tools" and, deliberately,
    paints `ABORTED`/`ABORTED_BEFORE_DISPATCH` as `stopped` (amber) while the
    shipped generic row paints them error-red — a user-cancelled MCP call is
    not a server failure.
15. The editor writes the upstream credential forms (`env`/`headers` template
    maps) and exposes startup/close/tool-call timeouts and tool loading plus
    OAuth enable/clientId/scope; the legacy `envKeys`/`{name,ref}` rows and
    `timeoutMs` remain READ-COMPAT only, and an imported document is
    normalized once through `canonicalDoc`.
16. Settings-document downgrade remains NOT promised; import strips the
    unexposed knob fields with a warning.

**Deferred register (out of the 0.2.6 line).** Reconnect editor fields;
`maxInstructionBytes`/`catalogDescriptionMaxLength`/`failOnStartupError` as
editor fields (the schema carries them for hand-edited documents; the import
strips + warns only); mixed
env/header template values (command/args/cwd/url templates and bare token refs
are supported, mixed values reject + warn); probe caps / retained
`configured:false` rows beyond the cleanup guard (restart only); an
official-plane panel (conflict detection only); `watch()` streaming status
(status is pull-only: action response + `credentials/record-updated` + the
10 s visible poll); OAuth request/authorization budget / fast-poll / grant
editors; raw-MCP-name exposure restoration (this line carries `publicName`
only); finer error codes.

**Limits the line carries** (the canonical register; user-facing copy in
`docs/acceptance.md` §Known limitations): the same-name hard conflict; OAuth's
callback must be directly reachable by the browser (`webServer.getOrigin()`),
OAuth exists only
on the declared `0.2.3-alpha.2` line and only in compositions that mount
`authorization`+`webServer`; on-demand catalog text may name tools a
subagent's `toolFilter` excludes (eager fan-out is filtered and `admit()`
refuses the load, but the catalog is upstream-formatted); the template support
boundary above; no settings-document downgrade promise.

## 6. Browser half — section, forms and lane (overview)

- Browser plugin exports `inject = ['slots','locale','remote','remote.credentials','configForms','workspaces','sessions']` + `apply(ctx)`; registers locale ns `mcp-scope.settings` ({en, zh}) then
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
  id:'mcp-scope', order: 25, label: t-thunk, locale: NS,
  inject: () => ({ ...face, hooks: { ...face.hooks, runtime }, refreshRuntime,
  connectServer, disconnectServer, restartServer, testServer, loadTools,
  authorizeServer, cancelAuthorization, signOutServer }) }, McpScopeSection))` — no child slots (the
  framework's InjectFace maps `face.hooks.doc` → the `useDoc` prop; actions
  pass through verbatim; verified against the shipped renderer). Each block is
  wrapped in the entry's registration containment: a throwing slot registration
  degrades to the shipped fallback (no section, no icon, generic row) with one
  warning instead of killing the browser half. In the shell's Plugins page the
  section is claimed by the plugin's Loader **row** page (`moduleName` match,
  the Configure control), not by the bundle page.
- **Sidebar icon.** A second registration on the official
  `settings.section.icon` list seat (`{name:'settings.section.icon',
  id:'mcp-scope', locale:NS}` → `McpSectionGlyph`) paints the plug mark. The
  shell renders every nav row through that slot with `only: row.id` and the
  shipped `navIcon(row.id)` fallback; the glyph inherits the row's
  `currentColor` and takes the owner-provided size, so `active` needs no
  handling. The retired `nav-icon.ts` DOM patch is gone (§9.4).
- **Transcript lane (0.0.2 line)**: the same half owns how MCP calls render, by
  registering one keyed `tool.call.toolview` entry per discovered exact wire name
  (`mcp__<server>__<tool>`). Names are discovered client-side from the staged
  session's event window — every `request/header` (`header.tools[]`, the full
  model-facing array) **and** every `tool/call` (`data.name`), because the window
  is a bounded tail page while headers are emitted at loop boundaries rather
  than per turn, so the call events are what guarantee a rendered row is known.
  The staged session itself is resolved through the session LIST across
  generations: the 0.1.5/0.1.6 line published it as the list's `current` scalar,
  while the 0.1.7 line dropped that field and leaves selection to the view
  owners — the catalog row whose `retainedBy.mainView > 0`, exactly the
  selector the shipped `UiSession` uses, with that session's `retainInfo`
  subscription as the switch signal (the legacy scalar and a catalog id with a
  live binding remain as fallbacks). A lane that reads only `current` discovers
  NOTHING on the pinned generation and silently returns every MCP call to the
  shipped generic row — v0.2.0 shipped exactly that way. Every seam of that
  service is PROBED rather than called through (`list.getSnapshot`,
  `list.subscribe`, `binding(id)`, `retainInfo`, `eventSource`): the lane's
  subscriptions run inside framework publish paths, so an accessor a runtime
  does not have would throw there instead of degrading, and a service shape the
  lane cannot use reports once through the observer's `onUnsupported` hook
  rather than rendering every MCP call as the generic row without a word.
  Detail and evidence: §6.
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
- Data: `ctx.configForms.get<Doc>('mcp-scope')` — the Loader entry's own
  Config form, whose snapshot carries {status, value, revision, writable};
  workspaces via global `useWorkspaces`.
- **Views (the browser-half UI).** The section is a small navigation stack,
  not one card per server:
  - **Servers list** — one row per server with status, "N of M workspaces"
    scope and tool count; name and state filters; the row is the only
    interactive target and opens the detail.
  - **Server detail** — overview status/actions, Workspaces (per-workspace
    switches, search and bulk), Tools (lazy disclosure with search/copy),
    Configuration (definition, credential refs, copy JSON), Availability
    (the global "Allow to run" switch) and a Danger zone.
  - **Workspaces list / detail** — the mirror view: one row per workspace,
    then one switch per server for that workspace, including a one-mutation
    batch through `controller.toggleWorkspaceServers`.
  - **Editor** — an independent Add/Edit view (import-first quick start,
    stdio/http fields, write-only secret rows, advanced disclosure, sticky
    footer, submitted validation, draft persistence without secret values).
    It no longer freezes the list: leaving the list for the editor means the
    other views are not mounted.
- **Scope and availability are separate controls.** Workspace switches write
  immediately (single `toggleWorkspace`; bulk server→workspaces
  `toggleWorkspaces`; bulk workspace→servers `toggleWorkspaceServers`), while
  the global allow flag lives only in Availability. The list never carries an
  ambiguous switch; its row summary is the scan surface.
- **Optimistic scope / allow writes.** The section keeps tokenized pending
  entries per (workspace, server) and per server; the committed document
  clears an entry once it reflects the intended value. Failures roll the
  switch back, persist an inline error with Retry, and never auto-dismiss.
  Successful toggles raise a `role="status"` toast with Undo. A single-row
  Undo writes the inverse; a BULK Undo restores each row's pre-batch value in
  ONE mutation (`restoreScopeValues`) — never as two half-atomic writes — and
  a failed batch reports only while it still owns a row, so a batch superseded
  by newer clicks cannot leave a banner whose Retry replays the stale target.
- **One write queue, two levels.** Every user-triggered document mutation
  (scope, allow, add/edit, remove, credential clear) runs through the section's
  serial queue (`src/client/hooks/use-write-queue.ts`) for ordering and the
  saving state; the controller additionally keeps a `writeTail` so writes from
  a previous mount and a newly mounted section cannot reuse one revision.
  Runtime actions (connect/disconnect/test/tools/refresh) are separate
  read/probe paths and are not queued.
- **Hand-written controls** remain the official card-form pattern; no generic
  schema-form. The views are split into `src/client/views/*` and
  `src/client/components/ui.tsx`; the pure draft model lives in
  `src/client/draft.ts` and pure status/scope mappings in
  `src/client/view-model.ts`.
- **OAuth UI (wire v2).** The detail renders the token-free attempt view: a
  status pill (Not authorized / Waiting for authorization / Authorizing /
  Authorized / Authorization failed), the passive reason line (the five fixed
  reasons), an Authorize / Authorize again button, Cancel authorization while
  an attempt is active, and Sign out behind a confirmation. The popup opens
  SYNCHRONOUSLY in the click handler (a `window.open` after an `await` is
  blocked); a blocked popup is a normal outcome and the URL stays as a
  copyable fallback. Completion arrives from the action response and the
  forwarded `credentials/record-updated` event — never a fast poll.
- **On-demand catalog.** When the tool-list route answers `mode:'catalog'` (or
  the row says `toolLoading: 'on-demand'`) the Tools section renders the
  offered count plus the localized catalog hint ("These tools are not in the
  model tool list…") instead of a tool table; the transcript row titles the
  loader tool by what it does ("Load tools") rather than by its raw name.
- Update cadence: scope.subscribe + `ctx.remote.$on('settings/document-updated')` +
  `credentials/reference-updated` for badge refresh + `credentials/record-updated`
  for a silent OAuth-grant refresh (the store filters the `mcp-client/`
  namespace); `connection/reset` and each document revision re-pull the runtime
  snapshot.
- **Runtime store**: `src/client/runtime.ts` speaks wire v2 with global
  `fetch` (no client package import, keeping the react-only bundle), dedupes
  refreshes and owns no timer; the section polls it every 10 s while visible
  and backs off to 30 s after a failed pass. It merges the per-server view,
  the token-free attempt view and the catalog marker exactly as the frozen
  contract types them; missing routes / failed calls degrade rows/detail to
  "status unavailable" while every document feature keeps working. The detail
  shows the phase pill (9 phases), the localized failure line derived from the
  fixed host code, Connect/Disconnect, Restart, Test (available even without a
  current runtime view), Refresh and a `Tools` disclosure whose table
  refetches per sync generation (or the catalog hint for on-demand).
- **Per-server refresh and stale views.** `refresh({ server })` asks the
  status route for one entry, merges it and publishes once; a failure rejects
  to the calling detail and leaves the snapshot untouched. A failed FULL
  refresh keeps the last good views (stale-while-revalidate) and the section
  shows a compact stale banner with a retry instead of blanking the list.
- **Removal and credential clearing are explicit.** Remove opens a dialog that
  names the server, its enabled-workspace count and the orphaned credential
  refs the controller will clear; clear-credential names every server sharing
  the ref (the unset is global). Reversible scope/allow switches never confirm.
- **Feedback model.** Success is transient (a role=status toast/note); errors
  are persistent inline notices with Retry and a dismiss action; no failure
  auto-retires. The editor's submitted validation lists every problem and
  focuses the first invalid field instead of disabling Save silently.
- Clipboard paste helpers and multi-server JSON import remain
  (`src/client/import.ts`, pure and unit-tested); the editor offers a
  candidate list when the snippet names more than one server.

### Files (browser half)

| file | role |
|---|---|
| `src/client/index.ts` | browser entry: `inject` + `apply` (locale, controller wiring, `settings.section` registration, the `settings.section.icon` seat, registration containment) |
| `src/client/locales.ts` | flat `SettingsKey` union + `en`/`zh` dictionaries + `NS = 'mcp-scope.settings'` |
| `src/client/controller.ts` | framework-free domain core: scope store, credentials badge state, save pipelines, cross-mount write tail, pure plan helpers |
| `src/client/section.tsx` | `McpScopeSection` shell: view stack, tabs, write queue, optimistic pending map, toast/failure/confirm dialogs, the OAuth click handlers (synchronous popup + copyable fallback) |
| `src/client/views/server-list.tsx` | scannable server rows, name/state filters, empty states |
| `src/client/views/server-detail.tsx` | overview status/actions (Connect/Disconnect/Restart/Test/Refresh), Authorization section (attempt view, reasons, Authorize/Cancel/Sign out), scope switches, tools (eager table or on-demand catalog), configuration/credentials, availability, danger zone |
| `src/client/views/workspace-list.tsx` | workspace list with enabled-server counts |
| `src/client/views/workspace-detail.tsx` | one workspace's server switches + one-mutation batch |
| `src/client/views/server-editor.tsx` | independent Add/Edit view: import quick start, grouped fields, advanced disclosure (startup/close/tool-call timeouts, tool loading, OAuth http-only clientId/scope), sticky footer, submitted validation, draft persistence |
| `src/client/components/ui.tsx` | local Switch/status pill/notice/empty state/section/tabs/modal/confirm primitives |
| `src/client/hooks/use-write-queue.ts` | section-level serial UI write queue (ordering/pending state; the controller tail survives mounts) |
| `src/client/draft.ts` | pure staged-draft model (validation, import prefill, wire materialization) |
| `src/client/view-model.ts` | pure runtime-status, credential-sharing, scope and time helpers |
| `src/client/import.ts` | tolerant JSON import with multi-server candidate selection and one shared scanner (`parseMcpSnippet` is the single-server derivation) (`mcpServers` / VS Code `servers` / opencode `mcp`, flat and array shapes → draft; tolerant of a brace-less or torn section (with or without the `mcp` wrapper, dangling separators/closers included), comments, trailing commas, fences and prose; candidates are tried until one resolves a server, so an example snippet above the real config cannot shadow it; discovery is iterative and bounded, so a deeply nested paste cannot throw; `env` takes a map or a `{name,value}` list; secrets land write-only) |
| `src/client/runtime.ts` | wire-v2 runtime store over the three host routes: status/action/tool-list reads (`refresh`/`act`/`test`/`tools`), `authorize`/`cancelAuthorization`/`signOut`, the catalog marker and the silent `credentials/record-updated` refresh; pending-action state lives in the detail view (§6) |
| `src/client/styles.ts` | style seat: the plugin's stylesheet, its class-name map, and the `data-plugin-css` tag mount (§9) |
| `src/client/workspaces.ts` | minimal workspace-row narrowing (typed items) |
| `src/client/tool-card/{names,icon,row,view,register}.ts(x)` | transcript lane: MCP tool identity from the session's request header (including the on-demand loader marker and lossy-name detection), the keyed tool view and its registration lifecycle, plus the official icon-seat glyph (§6, §5(f), §9.4) |
| `tests/client/{controller,locales,styles,section-render,section-editor,section-repaint,tool-card,tool-register,import,runtime,injection,injection-row,draft,view-model,apply}.spec.ts(x)` | browser-half vitest suites (15 files; the section suites cover list/detail/workspaces/editor, document-status transitions, optimistic rollback, queue ordering, draft restore, focus, the OAuth/catalog wire-v2 views, and the real browser-entry registration incl. the icon seat) |
| `tests/acceptance/{store,host-route,section}.acceptance.spec.ts(x)` | component/route acceptance suites; `host-route` keeps only the real-manager projection (the route matrix is in `routes.spec.ts`), and copy/style invariants live in their owner suites (`locales.spec.ts` / `styles.spec.tsx`) |
| `src/client/injection.ts` (contract) + `tests/client/injection.spec.ts` | see §5(f) for the notice and §6 for the lane |

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

An on-demand server's loader call is titled `server · Load tools` (the raw
loader name is bookkeeping, not a tool name) and its result is text. The row
classifies settlements deliberately: `interrupted`, `ABORTED` and
`ABORTED_BEFORE_DISPATCH` all render the amber `stopped` state — the shipped
generic row paints only `interrupted` that way and lets the durable abort codes
fall through to error-red, but a user-cancelled MCP call is not a server
failure. `tests/client/tool-card.spec.tsx` pins the divergence and
`verify-client-artifact` renders a stopped row from the packed bundle.

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
summary line and used per source disclosure, `injection.catalog` =
`{name} · {count} catalog tools` for an on-demand source, `injection.catalogTitle`
for its disclosure and `injection.omitted` for names past the cap); the
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
  hooks `useDoc` + `useWorkspaces`, the nine document actions (`addServer`,
  `replaceServer`, `removeServer`, `toggleWorkspace`, `toggleWorkspaces`,
  `toggleWorkspaceServers`, `restoreScopeValues`, `setServerEnabled`,
  `unsetCredential`) plus the runtime members, re-stated with
  locally-resolvable types. Reason: the official composed type
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
- `inject = ['slots','locale','remote','remote.credentials','configForms',
  'workspaces','sessions']` exactly as assigned — `sessions` was added by the 0.0.2
  transcript lane (`src/client/index.ts`; without it the lane stays off) (`connection` was dropped —
  grep-proven unused; `remote.credentials` is the real credentials gateway,
  see §7.3).

### 7.2 Forwarded remote events (verified)
`dsh-api-remotes/lib/types/remote-events.d.ts` is the one allowlist:
`'settings/document-updated'` (emit, listener `(ns, revision) => void` —
payload from `@deepseek-ai/dsh-settings/types` cordis `Events` merge:
`(ns: SettingsNamespace, revision: number)`),
`'credentials/reference-updated'` (emit, `(ref: CredentialRef) => void`
from `@deepseek-ai/dsh-credentials/types`) and — new on this line —
`'credentials/record-updated'` (emit, `(key: CredentialKey) => void`): the
OAuth grant commit lands there, which is what makes the authorization pill
flip without a fast poll. We subscribe to all three via `ctx.remote.$on`,
filter the document event by `MCP_SCOPE_NAMESPACE` ('mcp-scope'), and re-read
through the controller (scope mirror already refreshes itself inside the
ui-settings provider; our handler re-publishes the store and re-describes
credential badges). The record event is filtered to this plugin's
`mcp-client/` credential namespace and triggers one silent runtime refresh.

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
working on the single declared peer line
(`^0.2.3-alpha.2`; cordis `~4.2.0-alpha.1`) without a
compile-time dependency on the primitives' JS API — the geometry is copied from
the pinned generation, which §9.3 pins property by property.

One sheet moved on the 0.2.0 line and is deliberately NOT followed: the official
switch paints the OFF-state thumb with `--dsw-alias-switch-thumb` (absent from
the 0.1.7 theme; light `neutral-bluish-00`, dark `neutral-bluish-400`), while
this sheet keeps the pre-0.2.0 `--dsw-alias-label-primary-foreground`. A
`var(--new, var(--old))` fallback would follow the 0.2.0 theme automatically,
but the style gate's S4 forbids colour fallbacks on tokens (a fallback silently
defeats the token when it goes missing). The token was kept while 0.1.7 was
declared; that line is gone, so switching it outright is now a free follow-up —
NOT part of the generation move (the CSS and its style gate are unchanged).

### 9.2 What was replaced

| before | now |
|---|---|
| inline styles with literal colours/heights | classes off one token-only stylesheet |
| `border: 1px dashed rgba(127,127,127,.5)` form box | the panel's editing surface (`bg-module-platform`, r12, 14/16 padding) |
| raw `<button>` (OS default chrome) | `ui-primitives` Button capsules: `size="sm"` (h28/r14) for row and header actions, the figma `md` capsule (h36/r18) for the form footer; `outline` for dismiss/secondary, `primary` for commit, danger tint for destructive actions |
| raw `<input>` (OS default chrome) | official field vocabulary: h34/r8, `border-l4` hairline, `bg-layer-1`, 13px, `brand-primary` focus border, `label-dimmed` placeholder, dimmed when disabled, error border when invalid |
| raw `<input type="checkbox" role="switch">` | the Switch primitive's look (36×20 track, `brand-primary` when on, 16px thumb, 120ms slide) driven by the same controlled checkbox through `:checked`. The invisible input fills its box, so the box carries a 4px slop (with a cancelling negative margin) — a 44×28 target around the unchanged track, and the workspace row keeps a 30px minimum height so that whole target stays inside its own row: at a 20px row two neighbours' hit boxes overlapped by 6px and the lower input, painting later, stole the band (the bottom ~2px of a switch toggled the row below). The keyboard ring draws that same box (`outline-offset: 2px` plus the ring's own 2px, so the ring's outer edge IS the hit box), the switch box carries that slop through `padding: 4px; margin: -4px` (the 44×28 target lands on the row's 30px band without moving the track), the label is a plain `flex: 1` ellipsis element, and the track/thumb are `pointer-events: none`: the checked thumb's `transform` promotes it into the positioned paint layer AFTER the absolutely positioned input in DOM order, so without that line a real browser hit-tests the knob to the thumb and the click does nothing (the input must stay the topmost target; the decoration must not be hit-testable). In a workspace row the label spans the WHOLE text run and NO per-row state word is rendered at all — the switch carries on/off by itself (`role="switch"` + `checked`; a column of identical labels is noise, and the word used to swallow clicks as an inert sibling of the label). The detail block leads with the bulk pair in its header actions so a long list cannot push it past the fold, and from five workspaces it grows a name filter whose narrowing scopes that pair (`All on (N shown)`, and the pair is inert when nothing matches); the field stays on screen while a query is active (the threshold check ORs the query in), so deleting workspaces down past the threshold cannot strand hidden rows behind a control that is no longer there. That inline filter keeps the field GEOMETRY but not the official field fill: `bg-layer-1` reads as a white slab against the settings page, so it takes a transparent fill with the `border-l3` hairline our outline buttons use (the brand focus border stays). The rows are a responsive `auto-fill / minmax(220px, 1fr)` grid (a truncated workspace title keeps the workspace PATH in `title`), and they keep the workspace list's order — no state sorting — so a toggle never moves a row out from under the pointer. Row toggles are QUEUED behind one another rather than blocking: the controller judges a save against the document it read, so overlapping writes would report a spurious conflict — but making every row inert for the duration dimmed all switches on each toggle and read as the panel blinking. The queue keeps the writes serial and only the row whose write is running carries `data-pending`/`aria-busy` |
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

### 9.4 Settings sidebar glyph (the official icon seat)

By default the settings nav row's mark is shell-owned: `navIcon(id)` hardcodes
one per known section id and falls back to the shipped settings gear for every
other id. The supported way for a third-party section to own its mark is the
official `settings.section.icon` list seat (a child of `sidebar.settings`): the
shell renders every row through
`renderSlot('settings.section.icon', { size, active }, { only: row.id,
fallback: navIcon(row.id) })`, so a contribution whose `id` equals our section
id paints that row.

`src/client/index.ts` registers `{ name:'settings.section.icon', id:'mcp-scope',
locale: NS }` with `McpSectionGlyph` (`src/client/tool-card/icon.tsx`) through a
nested `ctx.slots.inject`. The component is pure React, draws the shared plug
mark at the owner-provided `size`, inherits the row's `currentColor` and
ignores `active` (the row already tints the glyph). Registration containment is
the same as the section's: a throw or a missing seat degrades to the shipped
gear for that row, never to a broken browser half. `verify-client-artifact`
mounts a fake `settings.section.icon` seat and fails unless the registration
exists and the component renders the plug SVG at the owner's size.

The former `src/client/nav-icon.ts` DOM patch and its `verify-client-artifact`
nav seed are DELETED. Measured on the real shell, the row is
`button > span.navIcon > svg` + `span.navLabel` while the patch required a
first-child svg, so the patch was a no-op — the official seat is what actually
paints the plug.

## 10. Settings UI layout reference

Structural reference for the shipped browser half, derived from the views and
the style seat — open *Settings → MCP servers* in a live GUI for the rendered
result. The labels below follow the zh locale (the en locale is key-for-key
identical, `src/client/locales.ts`). `docs/mcp-desktop-layout.svg` is the
0.1-era card sketch and is deliberately NOT updated here: the code superseded
that shape with the list → detail → editor stack below.

### Where it lives

Registered into the official settings shell through the `settings.section` slot
(`id: mcp-scope`, `order: 25`): one column, max-width 720 px, gap 12 px, no child
slots, never replacing the shell.

```
┌──────────────────────── dsh Web GUI / chamber desktop ────────────────────────┐
│ ┌──────────┐ ┌──────────────────── Settings ────────────────────────────────┐ │
│ │ sidebar  │ │ ┌───────────┐ ┌──────────── MCP 服务器 ──────────────────┐ │ │
│ │          │ │ │ settings  │ │ MCP 服务器                  [+ 添加服务器] │ │ │
│ │ …        │ │ │ nav       │ │ MCP 只会在启用了它的 workspace 中运行。    │ │ │
│ │ 设置 ◀   │ │ │ 通用      │ │ [ 服务器 ] [ Workspaces ]  4 个 · 2 已连接 │ │ │
│ │          │ │ │ 模型      │ │ ── 列表 / 详情 / 编辑器（见下）──────────  │ │ │
│ │          │ │ │ 插件      │ │                                           │ │ │
│ │          │ │ │ MCP 服务器◀│ │                                           │ │ │
│ │          │ │ └───────────┘ └───────────────────────────────────────────┘ │ │
│ └──────────┘ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Servers list

```
[搜索服务器…]  [全部] [已连接] [需关注] [未使用]
┌──────────────────────────────────────────────────────────────┐
│ ● github        流式 HTTP   2/3 已启用         12 个工具   › │
│   已连接 · 同步于 14:03                                      │
├──────────────────────────────────────────────────────────────┤
│ ○ filesystem    stdio       未在任何 workspace 使用         › │
│   状态未知 · 未在任何 workspace 使用                         │
└──────────────────────────────────────────────────────────────┘
```

The row is the ONLY interactive target. It reports status, scope and tool count
and opens the detail; it carries no switch and no destructive action.

### Server detail

```
← 所有服务器
github  [已连接]  流式 HTTP        [断开] [测试] [重启] [刷新状态]
12 个工具 · 3/5 已启用

授权                                        [授权] [取消授权] [退出登录]
[已授权]  授权绑定此服务器的 URL 与客户端；任一变更都需要重新授权。

Workspaces (3/5)                          [全部开启] [全部关闭]
[搜索 workspace…]
alpha [switch]   beta [switch]   gamma [switch]   delta [switch]

Tools ▸   [搜索工具…] [复制列表]
  search_issues — Search issues

Configuration                              [编辑] [复制 JSON]
URL  https://api.github.com/mcp
AUTH_TOKEN  已配置  [清除]          同时被 gitlab 使用
工具调用超时 60 秒 · 启动超时 30 秒 · 关闭超时 5 秒

Availability
[switch] 允许运行
允许运行不等于启用：每个 workspace 仍需单独开启。

危险操作
[移除服务器]
```

An OAuth server in a waiting/failed state renders the same block with the
localized reason line and (while `waiting-browser`) the authorization URL plus
**打开授权页** / **复制链接**; a blocked popup shows the copyable URL inline.
An on-demand server renders the Tools section as the catalog card instead:
`按需目录 · N 个工具可用` and the hint that the model loads one tool first.

**Workspaces** is the first section because scope is the core model. A pending
optimistic switch keeps its new value; a failed write rolls back and leaves a
persistent inline error with Retry. **Availability** is the only global switch;
it is separate from scope on purpose. Test remains reachable even when the
runtime channel cannot produce a view. Credential clearing names every server
sharing the ref because the unset is global. Removal names the server, its
enabled-workspace count and the orphaned credential refs.

### Workspaces view

```
[ 服务器 ] [ Workspaces ]

alpha  · 3/5 已启用  ›
beta   · 0/5 已启用  ›
```

Selecting one workspace opens its server switches:

```
← 所有 Workspaces
alpha
3/5 已启用                             [全部开启] [全部关闭]
[搜索服务器…]
● github      [switch]   已连接
● filesystem  [switch]   已停止
```

The bulk pair writes ONE revision-fenced mutation through
`toggleWorkspaceServers` (one path op per server), mirroring the server→
workspaces batch. Globally disabled servers stay visible but cannot be enabled
here.

### Editor

```
← 所有服务器
添加 MCP 服务器
[ 从 JSON 导入 ] [ 粘贴命令 ]       ← 快速开始
名称 [github]          传输方式 [stdio] [HTTP]
命令 / URL
Workspaces 范围在这里不编辑：保存后进入详情开启。
环境变量 / 请求头（值只写，留空保留已存值；可显示/隐藏）
高级设置 ▸（工作目录、启动/关闭/工具调用超时、工具加载：全量/按需）
OAuth ▸（仅 HTTP：启用浏览器授权、可选 clientId / scope）
[取消]  [保存并测试]                 ← sticky footer
```

Validation is submitted, not hidden behind a disabled Save: the summary lists
every problem and focuses the first invalid field. A multi-server JSON paste
offers a candidate list. Non-secret draft fields persist in sessionStorage;
secret values are deliberately never persisted. The editor is a separate view,
so it no longer freezes the list.

### Interactions worth knowing

- The runtime snapshot refreshes once per settings-document revision, then on a
  10 s visible interval (30 s after a failed pass). The detail also has a
  per-server **刷新状态** action. A failed full refresh keeps the last good
  views and shows the compact stale banner whose **重试** re-runs the full pass.
- **Connect / Disconnect / Restart** are real lifecycle actions (a manual stop
  latches until the definition changes or Connect is pressed); **Test** probes
  on a throwaway connection unless the live generation is already connected.
- **Authorize / Cancel authorization / Sign out.** The authorize click opens
  the popup synchronously and navigates it to the URL from the action's
  attempt view; a blocked popup keeps the URL as a copyable fallback. Sign out
  asks for confirmation and the host performs retire → dispose → unmount →
  delete grant → remount. Completion is picked up from the action response and
  the forwarded `credentials/record-updated` event, not a tight timer.
- Scope and allow writes are immediate, optimistic and undoable. All document
  writes (scope, allow, add/edit, remove, clear) share the section queue; the
  controller's write tail also serializes across mounts, so overlapping
  surfaces (including a reopen) cannot produce spurious revision conflicts.
- Save order for the editor: dirty credential values first
  (`credentials.set`), then ONE revision-fenced `mutate` of the settings
  document; a conflict re-reads and reports instead of retrying blindly.
- Success is transient (a `role="status"` toast/note). Errors are persistent
  inline notices with Retry and a dismiss action; no failure auto-retires.

The two session lanes (the MCP tool-call transcript and the registered-tools
notice) are not part of this page; their contract lives in §5(f) and §6.
