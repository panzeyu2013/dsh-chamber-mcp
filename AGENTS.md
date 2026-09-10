# AGENTS.md — repository map & invariants

`dsh-chamber-mcp` is a standalone third-party dsh plugin (settings-namespace MCP
servers with per-workspace per-agent tool-scope injection). Releases: GitHub Releases carrying the packed tgz + `.sha256` (npm publish
temporarily disabled). Current release: v0.0.2 of `dsh-chamber-mcp` (internal
settings namespace/loader id: `mcp-scope`).

Upstream generation: devDependencies pin the **dsh 0.1.5-rc.2** package set —
the generation a `dsh@0.1.5-rc.1` install actually resolves to, and now the
compile-time API surface and the CI guard. Peer ranges additionally accept the
**0.1.2-rc.1** generation the chamber anchor runs
(`^0.1.2-rc.1 || ^0.1.5-rc.1`); the surface this plugin calls is byte-identical
across both and both are live-verified. Migrating the pin: `docs/RELEASE.md`.

## Where things live

- `src/` — host half (`index.ts` entry; `manager/server/tools/transport/
  agents/workspace/schema.ts`) and browser half (`src/client/`). Shared pure
  model: `src/shared/model.ts` (edit only with its tests).
- `tests/` — vitest suites (host + client incl. jsdom render flows).
- `scripts/` — `build.mjs` (tsc host + esbuild client bundle + d.ts),
  `verify-package.mjs` (pack → contents whitelist → consumer d.ts → built
  entry import → determinism), `release-notes.mjs` (CHANGELOG section → body),
  `verify-workflow-action-pins.mjs` (chamber norm), `smoke/` (live M0/M1
  drivers against a chamber-anchored dsh instance).
- `docs/` — design, recon evidence, milestones (M0/M1 incl. live R3 capture),
  review rounds, RELEASE runbook, README index.

## Invariants (do not break)

- Registrations are effects returning disposers; MCP tools are registered per
  agent scope, NEVER globally; keys follow the official `mcp__` contract;
  override presence is OWN-property (Object.hasOwn) — prototype-member server
  names must keep working.
- Client bundle purity: the built `lib/client.js` may require ONLY
  react/react/jsx-runtime; all `@deepseek-ai/*` imports are type-only.
- Locale discipline: every user-visible string lives in
  `src/client/locales.ts` (en/zh parity is compile-enforced + tested).
- Secrets never ride the settings document or any API response; credential
  values with CR/LF/NUL are rejected at the transport.
- Version identity: package.json == package-lock `packages[""]` == the dated
  CHANGELOG section == the release tag. No release without a changelog entry.

## What must pass before tagging

`npm run check` (typecheck + tests + build + verify:package),
`node scripts/release-notes.mjs <version>`, `node
scripts/verify-workflow-action-pins.mjs`, then the live smoke
(`npm run test:smoke`) on the smoke machine. Full runbook: `docs/RELEASE.md`.
