# AGENTS.md — repository map & invariants

`dsh-chamber-mcp` is a standalone third-party dsh plugin (settings-namespace MCP
servers with per-workspace per-agent tool-scope injection). Releases: GitHub Releases carrying the packed tgz + `.sha256` (npm publish
temporarily disabled). **Published release: v0.0.2** — tag pushed and GitHub
Release published 2026-09-14 (asset: `dsh-chamber-mcp-0.0.2.tgz` + `.sha256`);
`v0.0.1` is the previous release. The working tree is the **0.0.3** line
(prepared on `main`, **not tagged**): its version is set in `package.json` plus
a dated CHANGELOG section before its tag exists (verify with
`git ls-remote --tags origin` before quoting a released version).
Tagging, pushing and publishing are **maintainer actions**: never create a tag,
push a ref, open or edit a GitHub Release, or run a publish, unless explicitly
asked to in that turn. Preparing a release (docs, changelog, gate) is fine;
shipping it is not.
Internal settings namespace/loader id: `mcp-scope`.

Upstream generation: devDependencies pin the **dsh 0.1.5-rc.2** package set —
the generation a `dsh@0.1.5-rc.1` install actually resolves to, the compile-time
API surface and the CI guard. The chamber anchor now runs that same generation
(gateway **0.3.0** → anchor dsh **0.1.5-rc.2**, measured 2026-09-14), and the
live smoke boots *and* installs through the anchor CLI, so installation and boot
are one generation. Peer ranges still accept the older **0.1.2-rc.1** generation
(the anchor's generation at recon / first release) —
`^0.1.2-rc.1 || ^0.1.5-rc.1`; the surface this plugin calls is byte-identical
across both and both were live-verified. Migrating the pin: `docs/RELEASE.md`.

## Where things live

- `src/` — host half (`index.ts` entry; `manager/server/tools/transport/
  agents/workspace/schema.ts`) and browser half (`src/client/`, incl. the
  `tool-card/` transcript lane: MCP tool identity, row, and keyed
  `tool.call.toolview` registration). Shared pure
  model: `src/shared/model.ts` (edit only with its tests).
- `tests/` — vitest suites (host + client incl. jsdom render flows).
- `scripts/` — `build.mjs` (tsc host + esbuild client bundle + d.ts),
  `verify-package.mjs` (pack → contents whitelist → consumer d.ts → built host
  entry import → client-bundle purity → `verify-client-artifact.mjs` →
  determinism), `verify-client-artifact.mjs` (drives the built browser half
  through the loader wrapper in jsdom: MCP tool-row registration, both states,
  click-to-expand), `release-notes.mjs` (CHANGELOG section → body),
  `verify-workflow-action-pins.mjs` (chamber norm), `smoke/` (live M0/M1
  drivers against a chamber-anchored dsh instance).
- `docs/` — `design.md` (architecture), `acceptance.md` (requirement/cut
  matrix), `recon/` (evidence reports), `milestones/` (M0/M1 + raw transcripts
  incl. the live R3 capture), `host-notes.md` / `ui-notes.md` (API findings &
  intentional deviations), `review/` (round-1, `round2/`, `prerelease/`,
  `deploy-issue/` audits — historical, point-in-time — plus `SUMMARY.md` and
  `STATUS.md`, the consolidated disposition at HEAD), `RELEASE.md` runbook,
  `README.md` index. Evidence pages may name authoring-machine paths
  (`/root/...`, `.smoke/`); that is recorded policy, not repo content.

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
  CHANGELOG section == the release tag. No release without a changelog entry.
  (All four hold for `0.0.2`: tag `v0.0.2` → commit `0ce2ea6`, Release published
  2026-09-14.)

## What must pass before tagging

`npm run check` (typecheck + tests + build + verify:package),
`node scripts/release-notes.mjs <version>`, `node
scripts/verify-workflow-action-pins.mjs`, then the live smoke
(`npm run test:smoke`) on the smoke machine. Full runbook: `docs/RELEASE.md`.
