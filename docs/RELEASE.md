# Release & CI guide — dsh-chamber-mcp

## CI (push / tags / PR)

`.github/workflows/ci.yml` runs the SAME validation chain on every push to
`main`/`master`, every `v*` tag push, and every PR against **Node 24** (chamber norm: a
tag can never publish an untested commit; release.yml additionally re-runs
the full gate itself because tag-triggered workflows run in parallel). The
first step verifies workflow action pins and release structure
(`node scripts/verify-workflow-action-pins.mjs`, the script the
`verify:workflows` alias wraps); installs are frozen `npm ci` with a
lockfile-not-rewritten assert. The workflow is also dispatchable so the
self-hosted live-smoke lane is reachable.

1. `npm ci`
2. `npm run typecheck` — src + tests, two tsconfigs
3. `npm test` — vitest suite (unit + integration; hermetic, no network)
4. `npm run build` — host ESM + client bundle + d.ts
5. `npm run verify:package` — packs the artifact and asserts:
   - tarball asserts the required entries (`lib/index.js`, `lib/client.js`,
     `lib/types/**`, `cordis.patch.yml`, `LICENSE`, `README.md`, `package.json`)
     and rejects `src|tests|.smoke|scripts|docs|.github` paths;
   - a consumer typecheck passes against the **packed** artifact for both
     entry points (`dsh-chamber-mcp` and `dsh-chamber-mcp/client`);
   - the built host entry imports and exports `name`/`inject`/`Config`/`apply`;
   - the built `lib/client.js` requires only `react` / `react/jsx-runtime`
     (client-bundle purity), and — driven through the loader wrapper in jsdom
     (`scripts/verify-client-artifact.mjs`) — registers one keyed
     `tool.call.toolview` view per discovered MCP tool, renders the running and
     settled rows with their distinct state treatment, and expands on a click;
   - the build is deterministic (second build byte-identical).
6. Artifact upload of the tarball.

A **live smoke job** (M0/M1 against a real chamber-anchored instance — the
anchor CLI the gateway currently ships) is available as `workflow_dispatch` on a self-hosted runner tagged
`dsh-smoke` (see §smoke, which records where the anchor CLI lives). It never runs
on ordinary runners.

Dependency updates are **manual**: Dependabot is disabled by maintainer choice
(there is no `.github/dependabot.yml`), so action pins and the pinned
`@deepseek-ai/*` generation are bumped by hand and guarded by
`npm run verify:workflows` + `npm run check`.

## Pre-tag checklist (run all of it on the release commit)

```sh
# 0. version identity — all three must print the same <version>, and the grep
#    must match a DATED "## [<version>] - YYYY-MM-DD" heading
node -p "require('./package.json').version"
node -p "require('./package-lock.json').packages[''].version"
grep -n "^## \[$(node -p "require('./package.json').version")\] - " CHANGELOG.md

# 1. full gate (same chain as CI; installs are frozen npm ci, never bare install)
npm ci --no-audit --no-fund && npm run check

# 2. release mechanics
node scripts/release-notes.mjs "$(node -p "require('./package.json').version")"   # notes compose
node scripts/verify-workflow-action-pins.mjs                                      # pins + release structure

# 3. recommended: live smoke on the smoke machine
npm run test:smoke

# 4. what the remote actually has (never quote a released version from memory)
git ls-remote --tags origin
```

Only then commit, tag `v<version>` and push — the tag is what makes the release
real. A tag must never point at a commit whose gate was not run.

## Releasing a tgz GitHub Release (tag-driven)

Preconditions (first release only):

- A public GitHub repository (the Release + asset need `push` rights; no
  secrets are required in the current tgz-only mode).
- **npm publishing is temporarily disabled**; releases ship the packed
  `dsh-chamber-mcp-<version>.tgz` as the GitHub Release asset, installable via
  `dsh plugin --profile web add <asset-url>`. Re-enable npm publish later by
  uncommenting the step in `.github/workflows/release.yml` (requires
  `NPM_TOKEN`, `id-token: write` for provenance, and the npm name owned).

### Changelog-first flow

Keep a Changelog — notes accumulate under `## [Unreleased]` and the release
composes its body from the dated section (see `CHANGELOG.md`):

```sh
# 1. move the notes you accumulated under "## [Unreleased]" into a dated
#    section, e.g. "## [<version>] - <YYYY-MM-DD>", grouped by
#    Added / Changed / Deprecated / Removed / Fixed / Security
# 2. bump package.json#version to the same <version>
# 3. update the version-bearing prose (see "Docs to update with the release")
# 4. run the Pre-tag checklist above in full
# 5. commit + tag + push
git add -A && git commit -m "release: v<version>"
git tag v<version>
git push origin main
git push origin v<version>  # triggers .github/workflows/release.yml
```

### Docs to update with the release

Keep these three in step with the tag; each one states, or is composed from, the
released version:

| File | What must be true at the tagged commit |
|---|---|
| `CHANGELOG.md` | a dated `## [<version>] - YYYY-MM-DD` section (release notes are composed from it — the workflow fails without one) |
| `README.md` | the *Install* release-status line names the version actually on the Releases page, and the install example resolves |
| `docs/status.md` | the "Release state" block (working line, published release, verification state) |

Re-run the pre-tag checklist after editing any of them.

**Ordering note.** At the tagged commit the Releases page still serves the
*previous* release (the tag push is what creates the new one), so the pre-tag
wording is honest only until the workflow finishes. Two statements therefore
flip in a **post-release edit** — do it right after the workflow reports success,
then commit with `docs: release v<version> is out`:

| File | Before the workflow finishes | After it succeeds |
|---|---|---|
| `README.md` | "the newest published release is `v<previous>`; the `<version>` line is prepared … but not tagged yet" | "the newest published release is **`v<version>`**" (drop the not-tagged sentence; the install example already uses `<version>` placeholders) |
| `docs/status.md` | "`<version>` is prepared on `main` … but **not tagged**; do not describe it as released" | "**Published release: `v<version>`**" plus the tag/Release line and the verification state at that commit |

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
  fallback farm; only `@modelcontextprotocol/client`, `@deepseek-ai/schemastery`
  and `zod` are real dependencies installed by pnpm.
- Support window: **`^0.1.5-rc.2 || ^0.1.6-alpha.1`**, both verified live.
  The pinned devDependency set and the CI guard are `0.1.6-alpha.1`. On 0.1.6+
  the host provides `createMcpToolDefinition` (official canonical validation +
  durable image admission) and `ctx.mcpResources`, so tool results take the
  official path and the resource tools can reach this plugin's servers; on 0.1.5
  neither exists and the plugin uses its own text projection. A dsh upgrade that
  changes the typed surface triggers a compat release; CI typecheck against the
  installed dsh set is the guard.
- **What each generation publishes.** Prompt instructions are attached to a
  literal `mcp:<server>` system-prompt section on 0.1.6+ only. 0.1.5 has no
  literal-section rendering — its renderer interpolates every section, so a
  server instruction containing `{{...}}` would either abort the turn or be
  substituted with a host variable — so the plugin publishes nothing there,
  which is exactly what the 0.1.5 host shipped.
- **The live smoke runs against an anchor in the support window.** Point
  `DSH_ANCHOR_CLI` at the chamber anchor (dsh 0.1.5-rc.2, exercising the
  fallback) or at a separately installed 0.1.6-alpha.1 anchor (exercising the
  official adapter); each transcript records the version it used. Note that the
  M1 driver installs through `dsh plugin add`, which delegates to pnpm inside
  the profile directory: on a checkout whose `package.json` declares
  `packageManager`, corepack's strict mode can refuse the install: use the
  scratch `pnpm` shim documented in `docs/status.md` §"How to re-verify" (or
  export `COREPACK_ENABLE_STRICT=0`). M0, the plugin-lifecycle driver, is
  unaffected either way.
- **The low-generation path has an executable check.** `npm run
  verify:low-generation` copies the built host half into a scratch tree whose
  `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-attachment` resolve to the
  LOW-generation install, asserts the production selection lands on the fallback
  (not the adapter), and drives an image result through admission and
  `finalizeContent`. The vitest suite is pinned to the newer devDependency
  generation, so it structurally cannot reach that path — run this alongside the
  live smoke before a release. `DSH_LOW_GENERATION_ROOT` points it at another
  low-generation install.
- **Do not reintroduce a STATIC import of a generation-specific export.**
  Measured on 2026-09-16: with a static `import { createMcpToolDefinition } from
  '@deepseek-ai/dsh-mcp-client'`, installing into the shipped 0.1.5-rc.2 chamber
  anchor succeeded silently and then the whole plugin tree failed to load
  (`does not provide an export named 'createMcpToolDefinition'`) and the dsh
  instance exited 1. The bridge therefore reaches that adapter through a
  NAMESPACE import and selects the local fallback when the property is absent,
  which is what keeps the two-generation peer range honest. The same rule applies
  to any future generation-specific surface: reach it through a namespace/service
  lookup, never a static named import.
- Auditing a new upstream line (the 0.1.5 migration, CHANGELOG 0.0.2): diff
  `src/` of the peer packages between the two release tags (`dsh-v<old>`..
  `dsh-v<new>` in the harness checkout), bump the devDependency pins, typecheck
  + test against the new set, then boot the real new CLI per §Smoke — capturing
  the per-workspace tool list AND the browser half's registration trace — and
  only then widen the peer range. Four traps this pass found:
  1. **Pin the RESOLVED generation, not the umbrella's own version.** A
     `dsh@X` install resolves its internal caret ranges past `X` (0.1.5-rc.1 →
     0.1.5-rc.2 for 230 of 231 packages), and upstream's own rc.1 peers pull
     rc.2 artifacts, so pinning the literal umbrella version leaves the dev
     tree self-inconsistent and forces `--legacy-peer-deps`. Pin every
     `@deepseek-ai/*` devDep to the generation the target install actually
     resolves to; the flag then falls away.
  2. **A pinned package can silently leave the release train.** 0.1.2-era
     `dsh-client-runtime`, `dsh-client-schema-form` and `dsh-client-web-react`
     never shipped past `0.1.1-rc.2`/`0.1.0-rc.7`. Check `npm view <pkg>
     dist-tags` before assuming a package still tracks the umbrella.
  3. **Client service and type ownership moves between packages.** `ctx.slots`
     is declared by `dsh-client-ui-renderer` in 0.1.5, not by the client
     runtime. Grep the installed tree for each injected service name and each
     slot key instead of assuming the old owner still provides them.
  4. **`dsh.client.inject` must name the client packages whose services the
     browser half calls** (that is the upstream convention, e.g.
     `dsh-client-locale`). It is load-bearing for boot-graph factory arrival
     and entry composition, not decoration.

## Smoke — what the self-hosted job runs

`npm run test:smoke` = `scripts/smoke/m1.mjs` (fresh install → settings
describe/mutate → two-workspace model-facing tool capture; the R3 verdict is
transcript evidence, not an exit-code assertion) then `scripts/smoke/m0.mjs`
(install, inventory, revision conflict, credentials, gate). Both drivers **pack
the plugin from the working tree on every run** and drive the install *and* the
boot through the anchor CLI (`scripts/smoke/instance.mjs`'s `ANCHOR_CLI` — the
gateway's current anchor, read at run time), recording the anchor version,
tarball path and installed artifact at the top of the transcript; both fail the
run if the installed version differs from `package.json`, and m0 additionally
fails if the install exits non-zero or the profile does not gain the bundle.
Prereqs on the
runner: writable repo checkout, that anchor CLI, pnpm on PATH, registry network
for pnpm; everything else lands under `.smoke/` (gitignored). Each driver writes
its transcript to `.smoke/logs/{M0,M1}-raw.log` (M1 also keeps the captured LLM
requests there); transcripts are evidence for that run, not repo content, and are
never committed.

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
