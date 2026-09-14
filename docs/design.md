# dsh-chamber-mcp — design (final)

Locked after recon A–F (docs/recon/*). Version targets: compile & verify against
**dsh 0.1.5-rc.2** (the generation a `dsh@0.1.5-rc.1` install resolves to; the
pinned devDependency set and the CI guard) — which is also what the chamber
anchor runs today (gateway **0.3.0**, measured 2026-09-14; the smoke's
`ANCHOR_CLI` resolves there and each transcript records the version it used).
**dsh 0.1.2-rc.1**, the anchor's generation at recon and first release, remains
inside the peer window and was live-verified then — see CHANGELOG 0.0.2.
Reference sources: the 0.1.0-rc.5 harness checkout for logic (originally the
sibling `dsh-chamber/ref-dsh`; that tree now lives at
`/root/projects/deepseek-harness`, and the 0.1.5 line is vendored at
`/root/projects/dsh-chamber/vendor/harness-packages/@deepseek-ai` — paths of the
authoring machine, not this repo).

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
slot (in-GUI click-through still unverified — see §6 and `docs/milestones/M1.md`).
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
servers: ServerDef[]        // serverName is the stable identity
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
      cwd?: string; envKeys?: string[] }                              // envKeys: credential refs
  | { serverName: string; transport: 'streamable-http'; url: string;
      headers?: { name: string; ref: string }[] }                     // values from credentials
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
  children are governed by their preset scopes and never receive MCP tools (round-2
  decision, ARCH-3); workspace membership is re-derived on every push/reconcile, and a
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
  server so new values take effect.
- **`tools/list` pagination is bounded** (SEC-05): every followed continuation cursor is
  recorded and a repeat rejects the sync as an invalid tool list, and one sync is capped
  at `MAX_SYNC_PAGES` (= `MAX_SYNC_TOOLS` = 2000) requests. Either failure leaves the
  previous generation registered, so a hostile server can neither spin the fetch loop nor
  erase working tools.
- **Context footprint**: registered definitions are ordinary request tool schemas, so the
  host's context meter prices them under "Tool definitions" (the plugin injects no prose
  into the system prompt). See README §"What the model sees".

## 5. Client UI (settings section + transcript lane)

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
  because its module id is generation-dependent (see `docs/ui-notes.md` §7).
  Detail and evidence: `docs/ui-notes.md` §7.
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
  `credentials/reference-updated` for badge refresh.

## 6. Build & test tooling

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
  driver per docs/recon/runtime-test-env.md §6): install tgz via `dsh plugin`, namespace
  describe/mutate, spawn evidence in boot log, workspace/session creation, tool-presence
  via mock-LLM capture; the bundle and its `settings.section` registration are served in
  the boot graph (M0). An in-GUI click-through in a real desktop session is still
  unverified — M1 records that gap; the client half is covered by jsdom render flows and
  the shipped-bundle preview harness (`docs/ui-notes.md` §6).

## 7. Milestones & acceptance

Acceptance matrix: docs/acceptance.md (R1–R4, C1–C6). M0 evidence under docs/milestones/.
