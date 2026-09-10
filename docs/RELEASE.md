# Release & CI guide — dsh-chamber-mcp

## CI (push / tags / PR)

`.github/workflows/ci.yml` runs the SAME validation chain on every push to
main, every `v*` tag push, and every PR against **Node 24** (chamber norm: a
tag can never publish an untested commit; release.yml additionally re-runs
the full gate itself because tag-triggered workflows run in parallel). The
first step verifies workflow action pins and release structure
(`npm run verify:workflows`); installs are frozen `npm ci` with a
lockfile-not-rewritten assert. The workflow is also dispatchable so the
self-hosted live-smoke lane is reachable.

1. `npm ci`
2. `npm run typecheck` — src + tests, two tsconfigs
3. `npm test` — vitest suite (unit + integration; hermetic, no network)
4. `npm run build` — host ESM + client bundle + d.ts
5. `npm run verify:package` — packs the artifact and asserts:
   - tarball contains exactly the publish surface (`lib`, `cordis.patch.yml`,
     `LICENSE`, `README.md`, `package.json`; no `src|tests|.smoke|docs` leaks);
   - a consumer typecheck passes against the **packed** artifact for both
     entry points (`dsh-chamber-mcp` and `dsh-chamber-mcp/client`);
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
  `dsh-chamber-mcp-<version>.tgz` as the GitHub Release asset, installable via
  `dsh plugin --profile web add <asset-url>`. Re-enable npm publish later by
  uncommenting the step in `.github/workflows/release.yml` (requires
  `NPM_TOKEN`, `id-token: write` for provenance, and the npm name owned).

Changelog-first flow (Keep a Changelog — see CHANGELOG.md):

```sh
# 1. move the notes you accumulated under "## [Unreleased]" into a dated
#    section, e.g. "## [0.0.1] - 2026-09-06", grouped by
#    Added / Changed / Deprecated / Removed / Fixed / Security
# 2. bump package.json#version to the same 0.0.1

# 3. local release gate (same as CI)
npm ci --no-audit --no-fund --legacy-peer-deps && npm run check

# 4. optional but recommended: live smoke on the smoke machine
npm run test:smoke          # M1 (R3 capture) + M0 evidence

# 5. commit + tag + push
git add -A && git commit -m "release: v0.0.1"
git tag v0.0.1
git push origin main
git push origin v0.0.1     # triggers .github/workflows/release.yml
```

The workflow then:

1. re-runs the full gate and verifies `package.json#version === requested`;
2. composes the release notes from the changelog section of the released
   version (`node scripts/release-notes.mjs "$PKG_VERSION"` — fails the run
   if the section is missing or empty or undated, so a release can never ship
   without notes);
3. refuses to re-publish over an existing *published* release (only stale
   drafts are deleted first — softprops would otherwise silently update the
   old release and discard the fresh body);
4. writes a `.sha256` sidecar next to the tgz and creates the **GitHub
   Release** with the notes as the body and `dsh-chamber-mcp-<version>.tgz` +
   `….tgz.sha256` attached (plus the workflow artifact upload). npm
   publishing is currently commented out — see the workflow header for the
   re-enable recipe.

Publication is serialized (`concurrency.group: release-publish`) and also
runs from `workflow_dispatch` with a **dry_run** mode: any change to
workflows/scripts/action pins must be validated by one dry run before the
formal tag (chamber rule).

Compatibility notes for consumers:

- The dsh loader resolves the row module from the profile dir (pnpm) or the
  dsh installation; the published tarball is exactly what
  `dsh plugin --profile web add dsh-chamber-mcp` installs.
- Peers (`@deepseek-ai/dsh-*`, cordis) are resolved from the dsh install's
  fallback farm; only `@modelcontextprotocol/sdk`, `@deepseek-ai/schemastery`
  and `zod` are real dependencies installed by pnpm.
- Support window: dsh **0.1.2-rc.1** (the chamber anchor generation, still in
  production) and **0.1.5-rc.1 / 0.1.5-rc.2** (npm `latest`), expressed by the
  peer range `^0.1.2-rc.1 || ^0.1.5-rc.1`. A dsh upgrade that changes the typed
  surface should trigger a compat release; CI typecheck against the installed
  dsh set is the guard (devDependencies pin `0.1.2-rc.1`).
- Auditing a new upstream line (the 0.1.5 pass, CHANGELOG 0.0.2): diff `src/`
  of the peer packages between the two release tags (`dsh-v<old>`..`dsh-v<new>`
  in the harness checkout), typecheck + test against the new package set, then
  boot the real new CLI per §smoke capturing the per-workspace tool list, and
  only then widen the peer range. The peer range is declarative only — profiles
  install with `autoInstallPeers: false` and resolve these peers by name from
  the dsh install's fallback farm — so a widened range never changes what is
  installed.

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
  patch release, and users simply `dsh plugin --profile web add dsh-chamber-mcp`
  again — pnpm update picks the fix.)
