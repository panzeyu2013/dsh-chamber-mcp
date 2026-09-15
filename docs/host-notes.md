# Host-half implementation notes (dsh-chamber-mcp)

> **As of 2026-09-14 (working tree, package 0.0.2, suite 185/14).** These notes were
> written during implementation against the **0.1.2-rc.1** anchor; the pinned
> devDependency generation is now **0.1.5-rc.2** (peers accept both). API claims
> below were re-checked against the pinned generation where they are load-bearing
> and are labelled where a generation matters.

Evidence for the coordinator: exact service/API signatures relied on that
differ from the recon docs, the test-mounting recipe (reproducible), and the
design deviations made and why.

## Files created (host half)

| File | Role |
|---|---|
| `src/tools.ts` | public name + definition build + executor (official mirror, rc.5 flavor: no image bridge) |
| `src/transport.ts` | async transport factory: env/headers resolved from credentials per attempt |
| `src/workspace.ts` | canonical-cwd → workspace-id helper |
| `src/server.ts` | per-server supervisor (official reconnect semantics, defs master state) |
| `src/agents.ts` | per-agent scope injection gate (never registers globally) |
| `src/manager.ts` | bridge orchestrator: handle lifecycle, credential events, applier ownership |
| `src/schema.ts` | `DocumentSchema` (schemastery) — NEW module beyond the original list |
| `src/index.ts` | plugin entry (value exports exactly `name`/`inject`/`Config`/`apply`, plus type-only re-exports of the public model surface — FE-10) |
| `tests/fixture/mcp-fixture-server.mjs` | spawnable real MCP stdio fixture (add/greet/fail/image/crash/admin.reset/dyn_add/env_probe) |
| `tests/tools.spec.ts`, `tests/host/{model,transport,server,agents,settings,manager,index}.spec.ts` | the 8 host suites, all green (the 6 client suites are listed in `docs/ui-notes.md` §1; repo total 185 tests / 14 files) |

Run: `npm run typecheck` (both tsconfigs) and
`node node_modules/vitest/vitest.mjs run` — both fully green (185 tests / 14 files).

## (a) API signatures that differ from recon docs

1. **Cordis 4.0.2 fiber/inject semantics are load-bearing** (recon docs only hint):
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
   the source; `docs/review/compliance.md` §(e) recommended exactly this once
   the matrix settled on one line. `resolveSpec`/`Config` match recon.
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

## (b) Test-mounting recipe (reproduce)

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

## (c) Design deviations (and why)

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
   settings (caught by the gating tests). Round-2 semantics: workspace
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

## Remaining risks

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

## (d) 0.0.3 — runtime status, manual control, timeouts

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
  The earlier `***`-redaction approach was removed after review: remote bodies
  (which the SDK embeds in errors) can echo a credential in an encoding the
  substring pass cannot catch, and "no secret in any response" is only
  enforceable by never sending the text.
- **Extra supervisor bookkeeping (review-driven).** A generation that fails to
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
