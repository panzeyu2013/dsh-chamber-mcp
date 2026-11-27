# Acceptance matrix (locked scope + the extended line)

Source: the locked MVP requirements, extended on 2026-09-14 by the
runtime-visibility / configuration-completeness line (0.0.3); re-based on 0.1.0
by the default flip (**R2/R3**: MCP is OFF until a workspace enables the pair)
and the UI review that followed (E7); re-based again on 0.2.6 by the single-line
generation move to dsh **0.2.3-alpha.2** and the architecture-A landing
(connection layer retired into the official `McpClientHost` instance; §Known
limitations). Each row: requirement → how we prove it (smoke / unit / E2E) →
evidence location.

## Must (MVP)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| R1 | Settings → MCP section with server rows + add/edit/remove forms; management is UI-native (the settings document stays hand-editable by design) | jsdom render/flow tests of the real components + `scripts/verify-client-artifact.mjs`; an unscripted real-session pass happened in the 0.1.0 UI review (the maintainer drove the panel in the desktop app), but a scripted click-through harness is still open | tests/client/section-render.spec.tsx, scripts/verify-client-artifact.mjs, docs/design.md §9 |
| R2 | **Default OFF (0.1.0, supersedes the original):** after add, the server is configured but effective NOWHERE until a workspace explicitly enables it | unit (evaluation fn) + E2E two workspaces | tests/host/agents.spec.ts, tests/host/model.spec.ts |
| R3 | Explicit per-workspace ENABLE; a workspace without the enable record has the server's tools excluded from its session's model-visible tool set (injection gate, not mere exec denial) | E2E: session tool listing per workspace (remote-mux capture) | `npm run test:smoke` — historical: **`R3-live-capture: PASS`** on the 0.1.5-rc.2 chamber anchor with the 0.1.0 tarball (the enabled workspace's turn carries `mcp__fixture__echo` / `mcp__fixture__env_report`; the disabled one carries none), `not-captured` on every headless anchor measured since (no turn starts without a UI surface claim; see §Known limitations); the current line runs one 0.2.3-alpha.2 anchor. Unit/integration: tests/host/agents.spec.ts |
| R4 | Distribution: ordinary third-party dsh plugin, user-installed per dsh; chamber not seeded, not bundled, zero code involvement | install test on scratch instance; chamber untouched | `npm run test:smoke` (M0) |

## Extended (0.0.3 — supersedes the original cuts C3–C5; 0.2.6 adds E12–E13)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| E1 | Global enable switch: `disabled: { [serverName]: true }` (own-property presence = off); a disabled server is never mounted, its tools are revoked everywhere, and re-enabling starts it fresh (an http+OAuth row provisions its seat/host lazily when the authorize action runs, so authorization still works while disabled without paying the seat cost up front). ONE atomic path op per toggle; per-workspace toggles never touch the map. The UI exposes it only under detail **Availability**, never as an ambiguous list-row switch. | shared-model unit tests + manager reconcile tests + controller regression tests + detail render tests | tests/host/model.spec.ts, tests/host/upstream-lifecycle.spec.ts, tests/client/controller.spec.ts, tests/client/section-render.spec.tsx |
| E2 | Document-level connection/tool budgets: `toolCallTimeoutMs` (legacy `timeoutMs` read-compat alias) applies to each call/resource request, plus `startupTimeoutMs` and `closeTimeoutMs`; absent = the upstream defaults (60 s / 30 s / 5 s). The mounted host validates the resolved values | shared-model/validator tests + the document→upstream adapter tests + the definition contract suite | tests/host/model.spec.ts, tests/host/config-parity.spec.ts, tests/host/host-config.spec.ts, tests/tools.spec.ts |
| E3 | Runtime status over the Connection carrier: `GET /api/mcp-scope.status` returns the versioned bounded view (phase, configured, attempts/maxAttempts, retry, timestamps, tool count, token-free authorization attempt view, fixed host-generated error code — never remote text) for every document server; `?server=` projects one entry | route envelope tests + wire-projection tests + manager view tests incl. a raw-text-never-crosses assertion | tests/host/routes.spec.ts, tests/host/status-mapping.spec.ts, tests/host/upstream-lifecycle.spec.ts, tests/host/oauth-authorization.spec.ts |
| E4 | Manual connect/disconnect/restart: disconnect is a first-class `stopped` state that revokes tools and survives unrelated settings commits; Connect or Restart (or a definition change) clears the latch; reconnect-budget exhaustion reads `failed` | manager lifecycle tests + detail render tests | tests/host/upstream-lifecycle.spec.ts, tests/client/section-render.spec.tsx |
| E5 | Test connection: throwaway probe through the seat's private host when down; read-only live report when connected (no second process/connection); an OAuth-required refusal surfaces as the fixed `oauth-required` code | seat/probe tests + manager read-only test + route code mapping | tests/host/server-seat.spec.ts, tests/host/upstream-lifecycle.spec.ts, tests/host/routes.spec.ts |
| E6 | Tool identity on demand: `GET /api/mcp-scope.tools?server=NAME`, capped (200 entries, name 200 / description 500) with the true `total`, never schema bodies; unsynced/down → `not-connected`; an on-demand server answers `mode:'catalog'` with an empty entry list and the offered count; the entry carries `publicName` only (the raw MCP name is never on the wire) | route tests + status/tool-list projection tests + pure `capToolList` bounds test | tests/host/routes.spec.ts, tests/host/status-mapping.spec.ts |
| E7 | Configuration completeness: independent Add/Edit view with import-first quick start, per-server startup/close/tool-call timeouts, tool-loading mode, OAuth fields (http only), unsaved-changes guard, clipboard paste (command / `.env` / header lines), multi-server JSON candidate selection (tolerant JSONC read: brace-less section, comments, trailing commas, fences, wrapper keys, arrays), submitted validation summary + focus, import warning list for fields this line does not carry, show/hide secrets, advanced disclosure, non-secret draft persistence, server name/state filters and a workspace name filter | pure parser/draft tests, controller action tests, editor render/flow tests | tests/client/import.spec.ts, tests/client/draft.spec.ts, tests/client/controller.spec.ts, tests/client/section-editor.spec.tsx, tests/client/section-render.spec.tsx |
| E8 | Runtime status never breaks the document UI: a missing route, failed fetch or malformed envelope degrades to `unavailable`/`error`, a wire `unknown` state — or a server the snapshot has no row for yet — reads as "status unknown" (never as "not started" or a fabricated "stopped"), and Test stays reachable | runtime store tests + detail degradation test + status-word render test | tests/client/runtime.spec.ts, tests/client/section-render.spec.tsx, tests/acceptance/section.acceptance.spec.tsx |
| E9 | List → detail → editor information architecture: server rows carry status/scope/tool count only; detail owns scope, tools, configuration, availability and danger; a mirror Workspaces list/detail batches one workspace through ONE `toggleWorkspaceServers` mutation | view render tests + acceptance capability tests | tests/client/section-render.spec.tsx, tests/acceptance/section.acceptance.spec.tsx, tests/client/controller.spec.ts |
| E10 | Optimistic, serialized writes: scope/allow toggles show their new value before the write settles, roll back on failure, persist an inline error with Retry, and can be undone (a bulk Undo restores each row's pre-batch value — mixed sets included — in ONE revision-fenced mutation, never as two half-atomic writes); every document write shares one serial queue so two surfaces cannot race the revision fence | flow tests (deferred writes, rollback, queue order, unmount, cross-mount revision reuse) + acceptance optimality tests | tests/client/section-render.spec.tsx, tests/client/controller.spec.ts, tests/acceptance/section.acceptance.spec.tsx |
| E11 | Destructive actions are specific: remove names the server, enabled-workspace count and orphaned refs; clear-credential names every server sharing the ref (the unset is global); sign-out names the stored authorization it deletes; all use a focus-trapped confirmation and reversible switches never confirm | flow tests + controller cascade tests | tests/client/section-render.spec.tsx, tests/client/controller.spec.ts |
| E12 | **On-demand tool loading (0.2.6):** per-server `toolLoading: 'eager'` / `'on-demand'`; the mounted client lists only the loader tool (`mcp__<serverName>__load_tools`) and renders the per-server catalog; a loaded tool enters an agent scope only through the applier's admission (workspace gate + delegation `toolFilter` narrowing, revocable); loaded records survive gate flips and same-epoch reconnects, and a generation change forgets them. The UI shows the catalog count/hint, the transcript titles the loader row "Load tools", and the registered-tools notice parses the catalog with an anti-spoof loader-sentence signature | applier-admission tests + fail-closed visibility tests + production-seam gate + client tests | tests/host/applier-admission.spec.ts, tests/host/facade.spec.ts, tests/host/upstream-mount-gate.spec.ts, tests/client/section-render.spec.tsx, tests/client/tool-card.spec.tsx, tests/client/injection.spec.ts |
| E13 | **OAuth browser authorization (0.2.6, O2):** http-only `oauth` block (refused for stdio and beside an `Authorization` header), derived credential key `mcp-client/mcp-scope-<sha256[:16]>`, the official browser flow through the seat's private isolated host (PKCE S256/DCR/`webserver/request` callback), a token-free attempt view on the wire, the authorize/cancel/sign-out actions, the grant committed in the credentials domain and refreshed by the mounted instance, and the sign-out ordering with its cleanup guard; the UI renders reason lines, Authorize/Authorize again, Cancel, confirmed Sign out and a copyable URL fallback | owner/registry/wire tests + real-host acceptance against the fake authorization server + route tests + client section tests | tests/host/oauth-authorization.spec.ts, tests/host/oauth-acceptance.spec.ts, tests/host/routes.spec.ts, tests/client/section-render.spec.tsx |

## Cut (must NOT exist)

| # | Cut item | Guard |
|---|---|---|
| C1 | toolPolicy allow/ask/deny | not in config schema (test asserts schema shape) |
| C2 | custom naming | naming constant `mcp__<serverName>__<tool>` only |
| C3 | ~~server-status visualization~~ | **superseded by E1/E3** (0.0.3) |
| C4 | ~~on-demand connect/reconnect~~ | **superseded by E4** (0.0.3) |
| C5 | ~~server pause key~~ | **superseded by E1** (0.0.3) |
| C6 | CLI/command management surface (the settings document is hand-editable by design) | no CLI command added |

## Data model

- `servers: ServerDef[]` — stable identity `serverName`. A row carries the
  transport form plus optional upstream-named knobs (`toolCallTimeoutMs` with
  the legacy `timeoutMs` read-compat alias, `startupTimeoutMs`,
  `closeTimeoutMs`, `toolLoading`, `reconnect` import pass-through) and, for
  http rows, an explicit `oauth` block. The three hidden knobs
  (`maxInstructionBytes`/`catalogDescriptionMaxLength`/`failOnStartupError`)
  are NOT import pass-through: the schema keeps them so hand-edited documents
  survive, and the editor import strips them (with `expandTemplates`) and
  warns. Credential carriers are the editor-written `env`/`headers` **template
  maps**: the document stores the `${credential:REF}` template string, the
  mounted host resolves it to the credential value at connect time and never
  persists the value; the old `envKeys`/`{name,ref}` rows remain read-compat
  and are translated once by the host adapter.
- `disabled: Record<string, true>` — sparse global off-switch, OWN-property
  presence = OFF (it is a hard kill no workspace enable can override); flat so one
  toggle is one atomic path op.
- `overrides: WorkspaceOverrides` = `Record<string, Record<string, true>>` —
  recorded = explicitly ON; dict-of-dicts so a toggle is one atomic path op.
- Enablement is two predicates combined at the call sites (`src/agents.ts`,
  `src/manager.ts`, the client gate): `isEnabled(overrides, w, s)` (the override
  row HAS an OWN property `s`, `Object.hasOwn`) AND NOT
  `isServerDisabled(doc, s)`. The default is OFF — a new server, a new workspace
  and a fresh session register no tools until the pair is explicitly enabled —
  and prototype-member server names keep working.
- Decisions: subagent/delegation children ARE adopted — a child inherits its parent's
  cwd, so the same workspace enablement decides — and the narrowing a **continuable**
  child's delegator declared is mirrored per name from that child's OWN durable
  `subagent/descriptor` (`src/delegation.ts`; one-shot descriptors persist no filter
  and are logged, never guessed; a descriptor that cannot be folded fails open with a
  warning; both limits are recorded in `docs/design.md` §4);
  workspace membership is re-derived per push/reconcile;
  credential values with CR/LF/NUL are rejected at the transport.
- Storage: dsh settings domain (plugin namespace) + credentials domain
  (write-only values; OAuth grants live there under the derived
  `mcp-client/mcp-scope-<sha256[:16]>` key and are only ever deleted by this
  plugin); per-instance isolation via DSH_HOME.

## Known limitations

The architecture that produces the shipped-line limitations is
`docs/design.md` §5(g) — the authoritative description and the canonical
register of the limits the line carries; this page keeps the user-facing copy
plus the repo evidence/process limitations. The deferred register is canonical
there too (§5(g) "Deferred register"), not duplicated here.

- No SCRIPTED in-GUI `Settings → MCP servers` click-through exists. An
  unscripted real-session pass did happen during the 0.1.0 UI review (the panel
  was driven in the desktop app: workspace switches, the server/workspace
  filters, the notice row), and it is what filed the review findings that
  shipped in 0.1.0 —
  but the recorded evidence for the render paths remains the jsdom flows and the
  shipped-bundle preview harness.
- Close/cleanup semantics now belong to the mounted instance; what the plugin
  still proves itself is the CLEANUP GUARD: an unconfirmed `McpCloseResult`
  projects `failed{cleanup}`, retains a `configured:false` orphan row and
  blocks remounting (pinned by `tests/host/status-mapping.spec.ts` and
  `tests/host/upstream-lifecycle.spec.ts`; user-facing copy under **Cleanup
  guard until restart** below). The upstream attach-time close timing (~2 s on
  stdio) and its give-up branch are upstream behaviour and are no longer
  asserted here; the legacy `toolResult` branch and the hand-rolled pagination
  guards are gone with the 1.x client, so they need no test at all.
- `M1`'s live R3 capture (the model-facing `tools[]` array) needs an anchor that
  actually starts a turn: on the 0.1.5-rc.2 chamber anchor the 0.1.0/0.1.1 runs
  recorded **`R3-live-capture: PASS`**, while every headless anchor measured
  since records `not-captured` — those instances never start a turn, so the
  mock LLM receives no chat request. That held for the old-line final-tree runs
  on one anchor per then-declared line (`0.2.0-rc.1`, `0.2.1-rc.5`,
  `0.2.2-rc.3`) and the `0.2.2-rc.1` baseline, so the verdict is a property of
  the headless anchor, not of the generation. The current support window is the
  single `0.2.3-alpha.2` line, whose smoke runs one anchor of that line; the
  positive live evidence on every anchor is M0's synced tool list (the
  `/api/mcp-scope.tools` route listing both fixture tools before and after a
  restart). The capture is transcript evidence either way: the driver reports
  the verdict without failing on it.
- **The multi-line support window is closed as of 0.2.6.** The 0.2.0/0.2.1/
  0.2.2 generations are no longer declared or verified: **0.2.5 is frozen as the
  last release of that old line**. `0.2.6` declares exactly one peer
  line, `^0.2.3-alpha.2`, which is also its compile anchor and dev pin (cordis
  `~4.2.0-alpha.1`); the runtime preflight refuses an out-of-range host, so an
  old-line instance must upgrade dsh first. The 0.1.5/0.1.6 plugin generation —
  the verbatim adapter port, its parity suite and `npm run verify:low-generation`
  — was removed at 0.2.0, and 0.1.7 left the window before that. On the pinned
  generation `ctx.root` no longer exists: the three reads are
  `ctx[Context.root]` (direct, no shim). `AgentRegistry.roots()` — removed on
  the 0.2.2-rc.3 line before this move — is not read; the manager adapter and
  the applier's registry projection use `list()`.
- **The official global-plane MCP manager is a different plane; a same-name
  configuration is a hard mount error.** The Web profile mounts
  `@deepseek-ai/dsh-mcp-manager` through `dsh-web-app`'s `mcp-manager` row (the
  0.2.3-alpha.2 composition still carries it): it manages one Host-wide fleet
  (Settings, `${credential:…}` templates, status/restart/probe) and registers
  each enabled server's tools in the global layer. This plugin still owns the
  per-workspace gate, and the two planes coexist — but the plugin now mounts
  through the upstream `McpClientHost`, whose per-application-root
  `serverName` reservation makes a duplicate a hard mount error. The host half
  pre-checks the official plane read-only (`ctx.get('mcpManager')?.list()`,
  structural; an absent service means no pre-check), maps it to
  `failed{conflict}`, and also classifies the mount-race rejection text into
  the same fixed code — not shadowing and not two independent processes. Keep a
  given server name in one place. There is no official-plane panel — conflict
  detection only (the server row shows the localized "Name conflict" tag/notice). The plugin's keyed tool-card row keys
  on the exact wire name, so it still renders those official-manager calls. The
  M0 smoke boots with the official manager mounted and checks the plugin's own
  namespace/row stay healthy.
- **`npm run test:smoke` packs `lib/`, not `src/`.** Run `npm run build` (or
  the full `npm run check`) first, or the smoke silently exercises the PREVIOUS
  build — a stale `lib/tools.js` once kept the static adapter import and
  reproduced the fatal 0.1.5 failure after the fix had landed in `src/`.
- Delegation children (`origin: 'subagent'`) ARE adopted: a child inherits its
  parent's cwd, so the workspace's own enablement decides, and the narrowing its
  delegator declared — the durable `subagent/descriptor` a continuable child carries
  (`toolFilter: {allow?, deny?}`) — is mirrored per name, so a server whose names are
  all filtered out publishes neither tools nor its context. A descriptor that cannot
  be folded (newer version, malformed payload, a generation without the read API)
  fails open with a warning: the workspace enablement stays the gate.
- Delegation inheritance is covered by unit tests (`tests/delegation.spec.ts`, the
  `allow`/`deny` math) and integration tests over a REAL ToolRuntime + real dsh-scope
  agent scopes (`tests/host/agents.spec.ts`: adoption through the listener and the boot
  scan, per-name mirroring, whole-server withholding INCLUDING its context, fail-open on
  unreadable/malformed descriptors, and a seeded fork whose inherited prefix carries a
  parent's descriptor). The live smoke (`npm run test:smoke`) exercises the root-session
  lifecycle; it does not delegate, because the driver's mock LLM answers with fixed text —
  scripting a `subagent` tool call and asserting the child's `request/header` tool array
  is the open end-to-end item.
- Under a `ptc` agent preset the request header lists only `run_code`; the
  registered-tools notice still reports the set, because it also reads the names
  the rendered system prompt declares. A request whose system prompt page left
  the bounded window AND whose header carries no MCP names shows no notice
  (MCP names still render per call through the tool-row lane; see
  `docs/design.md` §5(f)).
- With MCP off by default, a session with no enabled (workspace, server) pair
  registers no tools and the registered-tools notice renders no row at all; the
  settings section is the only surface that reports why. A transcript-side
  "MCP is off" hint is deliberately not shipped yet (the notice cannot always
  distinguish "off" from "this window lost the page that names the tools").
- The notice only reports names a CONFIGURED server owns, and it reads the
  settings document once per assembled request header: while that document is
  still loading (the store reports an empty list), the header renders no row and
  the engine does not re-evaluate that Context when the document arrives — the
  next request assembles a new Context and emits it, so the gap lasts at most one
  request.
- **OAuth callback reachability; OAuth on this line only.** The browser flow's
  redirect URI is the host webserver's `getOrigin()` +
  `/mcp/oauth/callback/<sha256(credentialKey)>`, and the user's browser must be
  able to reach that origin directly. A proxied/reverse-proxied browser cannot
  finish the flow, a changed bind address/port re-registers the dynamic client,
  and authorization-server / MCP OAuth requests require HTTPS or loopback HTTP
  (redirects are rejected). OAuth also needs the composition to mount
  `authorization` + `webServer`: a headless/partial composition answers the
  fixed `oauth-unavailable` code (the host logs one boot warning when OAuth rows
  are configured). OAuth exists only on the declared `0.2.3-alpha.2` line — the
  old lines have no OAuth surface and are no longer supported. The in-repo
  acceptance suite drives the real official flow against an in-process fake
  authorization server; the actual popup/browser callback is a manual check.
- **On-demand tool loading outside the tool restrictions.** Loaded tools are
  admitted per agent (`admit()`: workspace gate + subagent `toolFilter`
  narrowing, revocable), but upstream's formatted catalog text may still name
  tools a subagent's filter excludes; eager fan-out is filtered. Rewriting the
  catalog would mean wrapping upstream prompt text (deferred). The tool-list
  route deliberately cannot list an on-demand server's definitions
  (`mode:'catalog'` carries the offered count only), so the UI shows the
  catalog hint instead of a table until the model loads tools.
- **Template support boundary.** The mounted host expands `${credential:REF}`
  in command/args/cwd/url and in the `env`/`headers` template maps; mixed
  env/header values (literal text + a token) are reject+warn on import
  (deferred), a literal `${...}` in a templated field is a configuration error
  at save time, and `expandTemplates` is DERIVED from the text (never stored).
- **Cleanup guard until restart.** An unconfirmed instance/owner teardown
  reports `failed{cleanup}` and blocks remounting; a removed row stays on the
  status wire as a `configured:false` orphan row. Recovery is a plugin/Host
  restart — this line does not retry teardown in place.
- **No settings-document downgrade promise.** Upgrading the document is
  supported; downgrading a document written by a newer plugin (removed fields,
  changed field names) is not promised or tested. Import strips the unexposed
  knob fields (`maxInstructionBytes`, `catalogDescriptionMaxLength`,
  `failOnStartupError`, `expandTemplates`) with a warning; `reconnect` is
  import pass-through only.
- **Deferred features (intentionally out of the 0.2.6 line):** the canonical
  register lives in `docs/design.md` §5(g), "Deferred register (out of the
  0.2.6 line)"; this page does not duplicate it.
- **Headless runtime surface.** The three routes live on the Connection carrier;
  a host that mounts no carrier shows "status unavailable" while every document
  feature keeps working.
- **The on-demand loader is upstream-owned.** Its name, description and catalog
  formatting are the mounted client's; the plugin only titles the transcript row
  ("Load tools") and parses the catalog for the registered-tools notice.

## Gate evidence (0.2.6)

- **Real-browser pass: RECORDED on 2026-11-27.** A stock Chromium 131
  (Playwright build 1148) over CDP against a scratch `dsh@0.2.3-alpha.2`
  instance running the packed `0.2.6`: the Factory settings-section render, the
  same section reused from the shell's Plugins page, the
  `settings.section.icon` plug mark in the sidebar, an OAuth popup/callback
  round-trip (fake authorization server; the row flips to authorized, Sign out
  clears the grant and restarts the row as `waiting-authorization`), and an
  official-plane same-name server rendering `failed{conflict}` (`名称冲突`)
  instead of shadowing or a second process. Evidence:
  `.scratch/browser-pass/report.md` and its `shots/` (local, gitignored).
- `npm run check` — PASS: typecheck (both tsconfigs); **37 spec files / 812
  tests**; coverage statements/lines **93.27 %**, branches **87.27 %**,
  functions **89.22 %** against the floors 93 / 85 / 86 / 93; build;
  `verify:package` (65 tarball entries, consumer types, host entry,
  client-bundle purity, `verify-client-artifact`, determinism over 61 files).
  Log: `.scratch/exec/release-0.2.6-check.log` (EXIT 0).
- `node scripts/verify-generation.mjs 0.2.3-alpha.2` — PASS: 28
  `@deepseek-ai/dsh-*` devDeps pinned, exact scratch install, `tsc` over src +
  tests. Log: `.scratch/exec/release-0.2.6-verify-gen.log`.
- Alpha.2 M0 live smoke — PASS: the packed tree installs and boots through an
  `0.2.3-alpha.2` anchor; settings write → volatile commit → reconcile →
  connect; `/api/mcp-scope.tools` lists both fixture tools before and after a
  restart; the workspace flips are driven and a stale-revision write is refused
  (per-workspace tool visibility itself is asserted by the real-mount seam spec
  `tests/host/upstream-mount-gate.spec.ts` and the applier integration suites,
  not by this headless smoke). Log: `.scratch/exec/release-0.2.6-smoke.log`
  (EXIT 0); transcript under `.smoke/logs/M0-raw.log` (gitignored). M1's
  model-facing capture remains `not-captured` headlessly — transcript evidence,
  not a gate.
- `node scripts/verify-workflow-action-pins.mjs` — PASS (CI/release action
  pins), and `node scripts/release-notes.mjs 0.2.6` composes the release body
  from the dated CHANGELOG section.
- **The shipped code is identical to `0.2.6-alpha.0`** — only the version
  identity, this evidence and the CHANGELOG differ (see the release commit's
  diff); the prerelease's acceptance status is superseded by the pass above.
