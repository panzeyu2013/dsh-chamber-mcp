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
declares what was verified. Do not mix generations in the dev tree, and do not
pin the umbrella's own version when its internals resolve past it. The live
smoke boots through the anchor CLI named by `DSH_ANCHOR_CLI` at run time, which
must be a CLI of a supported generation.

## Where things live

- `src/` — host half (`index.ts` entry, plus
  `manager/server/server-context/tools/transport/agents/workspace/schema/routes.ts`)
  and browser half (`src/client/`, including `tool-card/`: MCP tool identity,
  row, keyed `tool.call.toolview` registration). Shared pure model:
  `src/shared/model.ts` (edit only with its tests).
- `tests/` — vitest, host + client (jsdom render flows).
- `scripts/` — `build.mjs`; `verify-package.mjs` (pack, contents, consumer
  types, host entry, bundle purity, client artifact, determinism);
  `release-notes.mjs`; `verify-workflow-action-pins.mjs`; `smoke/` (live M0/M1
  drivers, transcripts under `.smoke/`).
- `docs/` — `design.md` (architecture, upstream contracts, deviations),
  `acceptance.md` (scope, cuts, known limitations), `RELEASE.md` (runbook),
  `README.md` index. Design, decisions and process only — no audit, review or
  status write-ups.

## Invariants (do not break)

- Registrations are effects returning disposers; MCP tools register per agent
  scope, NEVER globally; keys follow the official `mcp__` contract; override
  presence is OWN-property (`Object.hasOwn`, so prototype-member server names
  keep working).
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
  into a session or settings publish path.
- No custom session events. The host half never appends a private event type:
  only the envelope's `ignorable?: true` marker admits an unknown type, this
  plugin ships no writer for it (the pinned generation exposes none), and
  `validateStoredEvents` then refuses the WHOLE log — including for the harness
  that wrote it. The registered-tools notice is derived client-side from the
  harness's own events (`src/client/injection.ts`); anything needing session
  visibility rides known event types read back in the browser half.
- Locale discipline: every user-visible string lives in `src/client/locales.ts`
  (en/zh parity is compile-enforced + tested).
- Secrets never ride the settings document or any API response; credential
  values with CR/LF/NUL are rejected at the transport.
- Version identity: `package.json` == lock `packages[""]` == dated CHANGELOG
  section == release tag; no release without a changelog entry; never quote a
  released version from memory — read the tags.

## Before tagging

`npm run check`, `node scripts/release-notes.mjs <version>`,
`node scripts/verify-workflow-action-pins.mjs`, then the live smoke
(`npm run test:smoke`) **once per declared generation**, with `DSH_ANCHOR_CLI`
pointing at a CLI inside the declared peer range. Details: `docs/RELEASE.md`.
