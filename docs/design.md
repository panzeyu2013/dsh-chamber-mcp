# dsh-chamber-mcp — design (final)

Locked after recon A–F (docs/recon/*). Version targets: compile & verify against
**dsh 0.1.2-rc.1** (npm dist-tag `next`; the version chamber runs; types under the
anchor install are authoritative). Reference sources: ref-dsh checkout (0.1.0-rc.5) for logic.

## 1. Deliverable (package layout)

Single npm package **`dsh-chamber-mcp`** — dual-face + bundle (one loader row):

```
package.json           main lib/index.js; exports: "." | "./client" | "./cordis.patch.yml" | "./package.json"
                       "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
                                 "client": { "inject": [...], "platform": "web" } }
cordis.patch.yml       - insert: - id: mcp-scope, name: dsh-chamber-mcp
src/index.ts           HOST half: plugin entry (name/inject/Config/apply) — real logic
src/client/…           BROWSER half: settings section UI (compiled to lib/client.js)
src/shared/…           pure types + constants shared by both halves (type-only for client)
lib/index.js           host ESM (tsc emit)          lib/types/**  declarations
lib/client.js          browser bundle (esbuild CJS + __ModuleLoader__.load wrapper)
```

Install (documented): `dsh plugin --profile web add dsh-chamber-mcp` (npm/git/file:) →
bundle appended to `dsh.profile.bundles`, row inserted by patch, restart instance.
Chamber: zero code/seed involvement (official dsh web SettingsRoot shows the section).

## 2. Identity & plugin entry (host)

- `export const name = 'mcp-scope'` (record scope, logs), `inject = ['settings','credentials','tools','workspaceRegistry','agents']`, `Config = z.object({})` (schemastery), `async apply(ctx, config)`.
- Namespace **`mcp-scope`** registered via `ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, {}, { setSource, onChange, validate })`.
- Single-instance guard: effect-reserved map keyed on `ctx.root` (mirror official mcp-client serverName reservation) — duplicate plugin load fails loudly.
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
header name). Semantics preserved: **enabled(w,s) = overrides[w]?.[s] === undefined**;
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
  decision, ARCH-3); workspace membership is re-derived on every push/reconcile, so a
  workspace deletion revokes on the next event (rc.1 exposes no workspace lifecycle
  events — the quiescent window is documented).
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

## 5. Client UI (settings section)

- Browser plugin exports `inject = ['slots','locale','remote','remote.credentials','settingsScope','workspaces']` + `apply(ctx)`; registers locale ns `mcp-scope.settings` ({en, zh}) then
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
  id:'mcp-scope', order: 25, label: t-thunk, locale: NS,
  inject: () => controller.face() }, McpScopeSection))` — no child slots (the
  framework's InjectFace maps `face.hooks.doc` → the `useDoc` prop; actions
  pass through verbatim; verified against the shipped renderer).
- Data: `ctx.settingsScope.bind<Doc>({ namespace:'mcp-scope' })` → snapshot
  {status, value, revision, writable}; workspaces via global `useWorkspaces`.
- Views: server cards (name, transport, "off in N workspaces", remove, per-workspace
  on/off rows with default-on note), staged Add form (serverName + transport toggle +
  command/args list/cwd/env key rows | url/header name+ref rows, secret inputs write-only),
  Save = credentials.set dirty secrets first → `scope.mutate([...ops], expectedRevision)`;
  removal cascades to refs no longer referenced (credentials.unset).
- Hand-written controls (official card-form pattern); no generic schema-form.
- Update cadence: scope.subscribe + `ctx.remote.$on('settings/document-updated')` +
  `credentials/reference-updated` for badge refresh.

## 6. Build & test tooling

- Deps: runtime `@modelcontextprotocol/sdk@^1.30.0`, `@deepseek-ai/schemastery@^3.18.2`,
  `zod@^4.4.3`; peers `@deepseek-ai/cordis@4.0.2` + `dsh-timeout` and the dsh-* type
  surfaces `@deepseek-ai/dsh-{tools,settings,credentials,workspace,session,agent,
  subprocess,scope,llm,brand,util-values}@0.1.2-rc.1`;
  client externals react 18.3.x etc. All pinned from installed anchor versions.
- Host half emitted by tsc (NodeNext ESM, explicit `.js` relative imports); client half
  bundled by esbuild (CJS; externals = official platform table + cordis) wrapped in the
  `__ModuleLoader__.load({ id, factory })` shape; d.ts emitted for both entries.
- vitest unit/integration tests: naming; document eval; per-server supervisor (mocked SDK);
  **agent-scope gating with a real ToolRuntime + real dsh-scope createScope contexts**
  (registry get(name, scope) assertions); transport/env/credential resolution.
- M0/M1 live smoke (scratch anchor 0.1.2-rc.1 instance, DSH_HOME under `.smoke/`, cookie
  driver per docs/recon/runtime-test-env.md §6): install tgz via `dsh plugin`, namespace
  describe/mutate, spawn evidence in boot log, workspace/session creation, tool-presence
  via mock-LLM capture; chamber GUI section appears in stock SettingsRoot after restart.

## 7. Milestones & acceptance

Acceptance matrix: docs/acceptance.md (R1–R4, C1–C6). M0 evidence under docs/milestones/.
