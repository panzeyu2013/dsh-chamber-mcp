# Release & CI guide — dsh-mcp-scope

## CI (push / PR)

`.github/workflows/ci.yml` runs on every push/PR against Node **22 and 24**:

1. `npm ci`
2. `npm run typecheck` — src + tests, two tsconfigs
3. `npm test` — vitest suite (unit + integration; hermetic, no network)
4. `npm run build` — host ESM + client bundle + d.ts
5. `npm run verify:package` — packs the artifact and asserts:
   - tarball contains exactly the publish surface (`lib`, `cordis.patch.yml`,
     `LICENSE`, `README.md`, `package.json`; no `src|tests|.smoke|docs` leaks);
   - a consumer typecheck passes against the **packed** artifact for both
     entry points (`dsh-mcp-scope` and `dsh-mcp-scope/client`);
   - the build is deterministic (second build byte-identical).
6. Artifact upload of the tarball.

A **live smoke job** (M0/M1 against a real chamber-anchored dsh 0.1.2-rc.1
instance) is available as `workflow_dispatch` on a self-hosted runner tagged
`dsh-smoke` (see §smoke). It never runs on ordinary runners — the anchor CLI
lives on the smoke machine (`/root/.dsh-chamber/gateway/dsh-anchor`).

Dependabot keeps npm + actions dependencies reviewed (weekly/monthly).

## Releasing to npm (tag-driven)

Preconditions (first release only):

- The npm name **`dsh-mcp-scope`** must be available/owned. If you publish
  under a scope instead, update `package.json#name` **and** the loader row in
  `cordis.patch.yml` (`name: dsh-mcp-scope` → the new module name) and re-run
  `npm run verify:package`.
- Add the repository secret **`NPM_TOKEN`** (automation token, publish-only).
- Provenance (`--provenance`) requires OIDC; if unsupported, drop it from
  `.github/workflows/release.yml` (see comments there).

Steps:

```sh
# 1. version + changelog
#    bump package.json#version (semver; pre-1.0: 0.x.y)
#    record user-visible changes (docs/CHANGELOG.md)

# 2. local release gate (same as CI)
npm ci && npm run check

# 3. optional but recommended: live smoke on the smoke machine
npm run test:smoke          # M1 (R3 capture) + M0 evidence

# 4. commit + tag + push
git add -A && git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0     # triggers .github/workflows/release.yml
```

The workflow re-runs the full gate, verifies `package.json#version === tag`,
then `npm publish --provenance` and uploads the tarball artifact.

Compatibility notes for consumers:

- The dsh loader resolves the row module from the profile dir (pnpm) or the
  dsh installation; the published tarball is exactly what
  `dsh plugin --profile web add dsh-mcp-scope` installs.
- Peers (`@deepseek-ai/dsh-*`, cordis) are resolved from the dsh install's
  fallback farm; only `@modelcontextprotocol/sdk`, `@deepseek-ai/schemastery`
  and `zod` are real dependencies installed by pnpm.
- Support window: dsh 0.1.2-rc.1 generation (npm `next`). A dsh upgrade that
  changes the typed surface should trigger a compat release; CI typecheck
  against the installed dsh set is the guard (devDependencies pin
  `0.1.2-rc.1`).

## Smoke (§smoke) — what the self-hosted job runs

`npm run test:smoke` = `scripts/smoke/m1.mjs` (fresh install → namespace R/W →
two-workspace R3 tool-capture PASS) then `scripts/smoke/m0.mjs` (install,
inventory, revision conflict, credentials, gate). Prereqs on the runner:
writable repo checkout, the anchor CLI path from `scripts/smoke/instance.mjs`,
pnpm on PATH, registry network for pnpm; everything else lands under
`.smoke/` (gitignored). Evidence artifacts: `docs/milestones/M1-live-capture.log`
etc.

## Rollback

- npm: `npm unpublish dsh-mcp-scope@<bad>` (only within 72h) or publish a
  fixed patch; users reinstall via `dsh plugin --profile web add` (profile
  bundles reconcile by installed state, so `pnpm update` picks the fix).
- The plugin is per-instance state: uninstall guidance lives in README.
