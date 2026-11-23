# AGENTS.md — repository map & invariants

`dsh-chamber-mcp` is a standalone third-party dsh plugin: MCP servers are
managed from the dsh Settings UI and injected into the tool scopes of the
workspaces that explicitly enable them. **MCP is OFF by default** — a new
server, a new workspace and a fresh session register no tools until the pair is
turned on. Loader entry id (Settings form and legacy `settings.yaml` import):
`mcp-scope`.

Releases are GitHub Releases carrying the packed tgz + `.sha256` (npm publishing
is disabled). **Tagging, pushing and publishing are maintainer actions**: do
none of them unless explicitly asked in that turn; preparing a release (docs,
changelog, gate) is fine. Runbook: `docs/RELEASE.md`.

Upstream generation: the `@deepseek-ai/dsh-*` devDependencies pin **one
generation** — the compile-time surface and the CI guard — while the peer range
declares the ONE line that was verified; here both are **dsh `0.2.3-alpha.2`**
(cordis `4.2.0-alpha.1`, `cordis-plugin-loader` `1.2.0-alpha.1`, schemastery
`~3.20.0-alpha.1`). The multi-line window is closed: **0.2.5 is frozen as the
last release of the old line** and the tree carries no compatibility shims for
older generations. Do not mix generations in the dev tree, and do not pin the
umbrella's own version when its internals resolve past it. The live smoke boots
through an anchor CLI of the declared line — `DSH_ANCHOR_CLI` at run time, and
the CI smoke job requires `DSH_SMOKE_ANCHORS` (it hard-fails when unset).

## Where things live

- `src/` — **host half** (`docs/design.md` §5(g) is its landed
  architecture): `index.ts` entry; `manager.ts` (lifecycle/actions/status
  projection + the serialized mutation chain), `server-fiber.ts` (one seat
  child fiber per definition: isolated service labels + capture façades + ONE
  private `McpClientHost`), `facade.ts` (capture-only
  `tools`/`systemPrompt`/`mcpResources`/`credentials` façades, fail-closed
  catalog visibility), `host-config.ts` (document row → upstream
  `ConfigInput`; the credential-template value space/parser lives in
  `src/shared/defaults.ts` and the derived OAuth key is this module's),
  `upstream.ts` (lazy official-host acquisition), `oauth-authorization.ts`
  (OAuth owner/registry), `status.ts` (pure status classifier/projection +
  wire mapping), `log.ts` (the one host logger surface + sanitizer),
  `agents.ts` + `delegation.ts` (the ONLY per-agent fan-out and the subagent
  narrowing), `routes.ts`, `schema.ts`, `workspace.ts`; shared pure contract `src/shared/{model,defaults,wire,oauth}.ts`
  (edit `model.ts`/`defaults.ts`/`wire.ts` only with their tests;
  `wire.ts`/`oauth.ts` must keep ZERO runtime imports for the browser bundle;
  `oauth.ts` may import TYPES from `wire.ts`).
  **Browser half** `src/client/`: the settings section, its official
  `settings.section.icon` seat, `tool-card/` (MCP tool identity + keyed
  `tool.call.toolview` rows) and `injection*.ts` (the derived
  registered-tools notice). The retired connection layer
  (`server/transport/server-context/tools.ts`) and `client/nav-icon.ts` must
  not come back: the mounted official instance owns transport and definitions.
- `tests/` — vitest, host + client (jsdom render flows); shared harnesses and
  fixtures live in `tests/support/` (the 0.2.3 real-service mount recipe
  `mount-real.ts`; `agent-kit`/`manager-kit`/`fake-seat`/`fixture-kit`;
  `http-fixture.ts`), the spawnable stdio server in
  `tests/fixture/mcp-fixture-server.mjs` and the fake OAuth authorization
  server in `tests/fixture/oauth-auth-server.mjs`. The production seam gate is
  `tests/host/upstream-mount-gate.spec.ts`.
- `scripts/` — `build.mjs`; `verify-package.mjs` (pack, contents, consumer
  types, host entry, bundle purity, client artifact, determinism);
  `verify-generation.mjs` (scratch-tree typecheck against the declared line —
  `node scripts/verify-generation.mjs 0.2.3-alpha.2`, no `--pin` while it is the
  dev pin); `release-notes.mjs`; `verify-workflow-action-pins.mjs`; `smoke/`
  (live M0/M1 drivers, transcripts under `.smoke/`).
- `docs/` — `design.md` (architecture incl. the landed architecture A §5(g),
  behaviour-change ledger, upstream contracts, deviations),
  `acceptance.md` (scope, cuts, shipped-line known limitations, gate evidence),
  `RELEASE.md` (runbook), `README.md` index. Design, decisions and process
  only — no audit, review or status write-ups.

## Invariants (do not break)

- Registrations are effects returning disposers; MCP tools register per agent
  scope, NEVER globally; keys follow the official `mcp__` contract; override
  presence is OWN-property (`Object.hasOwn`, so prototype-member server names
  keep working).
- Architecture A: one seat child fiber per configured server definition; the
  mounted official instance's registrations are CAPTURED by the isolated
  façades and never reach a real global layer; `src/agents.ts` is the ONLY
  per-agent fan-out. `ToolsFacade.get` stays fail-closed (a catalog name is
  visible only for a live agent the applier publishes that server to). Do not
  reintroduce a plugin-owned connection layer or global registration.
- Same-name guard: a `serverName` reserved by the official manager plane is a
  fixed `failed{conflict}` (read-only `ctx.get('mcpManager')?.list()` pre-check
  plus the mount-race code fallback), never shadowing and never a second
  process. The official host reserves `serverName` per application root.
- Wire contract: `src/shared/wire.ts` (and the browser-safe `src/shared/oauth.ts`)
  is the frozen, ZERO-import host↔browser boundary. Only fixed enums/codes and
  token-free views cross it — never upstream diagnostic text, credential
  values, tokens or attempt `lastError`. Additive evolution only: a new
  phase/code is an explicit union member so both halves stay exhaustive.
- OAuth (O2): the browser flow runs only through a seat's PRIVATE isolated
  `McpClientHost` (`host.authorization`); grants are read/refreshed/redacted by
  the mounted instance and are never read by the plugin (sign-out is the only
  write: `deleteRecord`). Sign-out ordering is retire → disposeOwner → unmount
  → delete → remount, and an unconfirmed cleanup keeps the grant and blocks
  remount (`failed{cleanup}`).
- Client bundle purity: the built `lib/client.js` may require ONLY
  react/react/jsx-runtime; every `@deepseek-ai/*` import is type-only.
  `verify:package` asserts this on the packed build.
- Transcript lane: one MCP row per EXACT wire name through the keyed
  `tool.call.toolview` slot (no wildcard exists), at shadowing rank 1, discovered
  client-side from the staged session's event window — `request/header` tools,
  `tool/call` names, and the inner names of `tool/ptc-dispatch-start` /
  `tool/ptc-dispatch` (under a `ptc` preset the header only says `run_code`) —
  under a 256-entry cap. Always degradable: an unregistered, over-cap or
  unresolvable name renders the shipped generic row, and nothing here may throw
  into a session or settings publish path. Two deliberate rules: the on-demand
  loader row is titled "Load tools" (never its raw name), and the row paints
  `interrupted`/`ABORTED`/`ABORTED_BEFORE_DISPATCH` all as the amber `stopped`
  state even though the shipped generic row paints the durable abort codes
  error-red — a user-cancelled MCP call is not a server failure.
- No custom session events. The host half never appends a private event type:
  only the envelope's `ignorable?: true` marker admits an unknown type, and a
  private REQUIRED event makes `validateStoredEvents` refuse the WHOLE log —
  including for the harness that wrote it. Upstream does expose a writer
  (`appendPluginRecord`: present on the 0.2.2 line and the current
  0.2.3-alpha.2 line; absent from 0.2.0-rc.1), but this plugin deliberately
  keeps the notice derived rather than persisted: it needs no log entry, plugin
  records are best-effort across format migrations (the owner validates restored
  data), and a write path would owe a feature-detect/format-migration story even
  on the single declared line. The
  registered-tools notice is derived client-side from the harness's own events
  (`src/client/injection.ts`); anything needing session visibility rides known
  event types read back in the browser half.
- Locale discipline: every user-visible string lives in `src/client/locales.ts`
  (en/zh parity is compile-enforced + tested).
- Secrets never ride the settings document or any API response; the isolated
  credentials façade is the single CR/LF/NUL authority (re-resolved on every
  connect attempt), and OAuth grants stay in the credentials domain under the
  derived `mcp-client/` key, never on the wire or in the settings document.
  The settings document may contain `${credential:REF}` templates, never
  values.
- Version identity: `package.json` == lock `packages[""]` == dated CHANGELOG
  section == release tag; no release without a changelog entry; never quote a
  released version from memory — read the tags.

## Before tagging

`npm run check`, `node scripts/release-notes.mjs <version>`,
`node scripts/verify-workflow-action-pins.mjs`, and
`node scripts/verify-generation.mjs 0.2.3-alpha.2` (no `--pin`), then the live
smoke (`npm run test:smoke`) **once per declared support line** — there is
exactly one, dsh `0.2.3-alpha.2` — with `DSH_ANCHOR_CLI` pointing at that line's
CLI (the CI smoke job requires `DSH_SMOKE_ANCHORS`). Details: `docs/RELEASE.md`.
