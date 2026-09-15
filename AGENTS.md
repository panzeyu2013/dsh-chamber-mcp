# AGENTS.md — repository map & invariants

`dsh-chamber-mcp` is a standalone third-party dsh plugin: MCP servers managed
from the dsh Settings UI, with tools injected into the tool scopes of the
enabled workspaces only. Internal settings namespace / loader row id:
`mcp-scope`.

Releases are GitHub Releases carrying the packed tgz + `.sha256` (npm publishing
temporarily disabled). **Tagging, pushing and publishing are maintainer
actions**: never create a tag, push a ref, open or edit a GitHub Release, or run
a publish, unless explicitly asked to in that turn. Preparing a release (docs,
changelog, gate) is fine; shipping it is not. Current release and verification
state: `docs/status.md`.

Upstream generation: the `@deepseek-ai/dsh-*` devDependencies pin **one resolved
generation** — the compile-time API surface and the CI guard — and the peer
ranges declare the generations this plugin was verified against. Do not mix
generations in the dev tree, and do not pin the umbrella's own version when its
internals resolve past it. The live smoke installs and boots through the
chamber's current anchor CLI, read at run time. Migration recipe:
`docs/RELEASE.md`.

## Where things live

- `src/` — host half (`index.ts` entry; `manager/server/tools/transport/
  agents/workspace/schema/routes.ts`) and browser half (`src/client/`, incl. the
  `tool-card/` transcript lane: MCP tool identity, row, and keyed
  `tool.call.toolview` registration). Shared pure model:
  `src/shared/model.ts` (edit only with its tests).
- `tests/` — vitest suites (host + client incl. jsdom render flows).
- `scripts/` — `build.mjs` (tsc host + esbuild client bundle + d.ts),
  `verify-package.mjs` (pack → contents whitelist → consumer d.ts → built host
  entry import → client-bundle purity → `verify-client-artifact.mjs` →
  determinism), `verify-client-artifact.mjs` (drives the built browser half
  through the loader wrapper in jsdom: MCP tool-row registration, both states,
  click-to-expand), `release-notes.mjs` (CHANGELOG section → body),
  `verify-workflow-action-pins.mjs` (chamber norm), `smoke/` (live M0/M1
  drivers against a chamber-anchored dsh instance; transcripts under
  `.smoke/`).
- `docs/` — `design.md` (architecture, upstream contracts, deliberate
  deviations, style seat and UI layout reference), `acceptance.md` (scope +
  cuts), `status.md` (release/verification state), `RELEASE.md` (runbook),
  `README.md` index, plus `mcp-desktop-layout.svg` (the layout wireframe
  `design.md` links). Keep these to design, status, decisions and process —
  no audit or review write-ups.

## Invariants (do not break)

- Registrations are effects returning disposers; MCP tools are registered per
  agent scope, NEVER globally; keys follow the official `mcp__` contract;
  override presence is OWN-property (Object.hasOwn) — prototype-member server
  names must keep working.
- Client bundle purity: the built `lib/client.js` may require ONLY
  react/react/jsx-runtime; all `@deepseek-ai/*` imports are type-only.
  `verify:package` asserts this on the packed build.
- Transcript lane: MCP tool rows are registered per EXACT wire name through the
  keyed `tool.call.toolview` slot (never a wildcard — none exists), at shadowing
  rank 1 (an official row for the same name wins; a same-key/same-priority pair
  throws in the slot core), discovered client-side from the staged session's
  event window — `request/header` tools AND `tool/call` names, because the window
  is a bounded tail page while headers are emitted at loop boundaries rather
  than per turn — under a 256-entry cap. Always degradable: an unregistered,
  over-cap or unresolvable name must keep rendering the shipped generic row, and
  nothing in this lane may throw into a session or settings publish path.
- Locale discipline: every user-visible string lives in
  `src/client/locales.ts` (en/zh parity is compile-enforced + tested).
- Secrets never ride the settings document or any API response; credential
  values with CR/LF/NUL are rejected at the transport.
- Version identity: package.json == package-lock `packages[""]` == the dated
  CHANGELOG section == the release tag. No release without a changelog entry,
  and never quote a released version from memory — read the tags.

## What must pass before tagging

`npm run check` (typecheck + tests + build + verify:package),
`node scripts/release-notes.mjs <version>`, `node
scripts/verify-workflow-action-pins.mjs`, then the live smoke
(`npm run test:smoke`) on the smoke machine. Full runbook: `docs/RELEASE.md`.
