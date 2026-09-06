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

## Releasing a tgz GitHub Release (tag-driven)

Preconditions (first release only):

- A public GitHub repository (the Release + asset need `push` rights; no
  secrets are required in the current tgz-only mode).
- **npm publishing is temporarily disabled**; releases ship the packed
  `dsh-mcp-scope-<version>.tgz` as the GitHub Release asset, installable via
  `dsh plugin --profile web add <asset-url>`. Re-enable npm publish later by
  uncommenting the step in `.github/workflows/release.yml` (requires
  `NPM_TOKEN`, `id-token: write` for provenance, and the npm name owned).

Changelog-first flow (Keep a Changelog — see CHANGELOG.md):

```sh
# 1. move the notes you accumulated under "## [Unreleased]" into a dated
#    section, e.g. "## [0.2.0] - 2026-09-20", grouped by
#    Added / Changed / Deprecated / Removed / Fixed / Security
# 2. bump package.json#version to the same 0.2.0

# 3. local release gate (same as CI)
npm ci && npm run check

# 4. optional but recommended: live smoke on the smoke machine
npm run test:smoke          # M1 (R3 capture) + M0 evidence

# 5. commit + tag + push
git add -A && git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0     # triggers .github/workflows/release.yml
```

The workflow then:

1. re-runs the full gate and verifies `package.json#version === tag`;
2. composes the release notes from the changelog section of the released
   version (`node scripts/release-notes.mjs "$PKG_VERSION"` — fails the run
   if the section is missing or empty or undated, so a release can never ship
   without notes);
3. creates the **GitHub Release** for the tag with those notes as the body
   and the packed `dsh-mcp-scope-<version>.tgz` attached as the release
   asset (plus the workflow artifact upload). npm publishing is currently
   commented out — see the workflow header for the re-enable recipe.

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

- GitHub Release: edit/delete the Release (or delete just the asset) and push
  a fixed tag (`v<version>+1`) with the corrected tgz; deleting a tag moves
  the Release back to `draft` state for reuse.
- Users reinstall by pointing `dsh plugin --profile web add` at the new
  asset URL (profile bundles reconcile by installed state).
- The plugin is per-instance state: uninstall guidance lives in README.
- (When npm publishing is re-enabled: `npm unpublish` within 72 h or a fixed
  patch release, and users simply `dsh plugin --profile web add dsh-mcp-scope`
  again — pnpm update picks the fix.)
