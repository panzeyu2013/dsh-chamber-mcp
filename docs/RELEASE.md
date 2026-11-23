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
3. `npm run test:coverage` — vitest suite (unit + integration; hermetic, no network) under the coverage gate
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

A **live smoke job** (M0/M1 against a real instance of the declared line —
currently dsh 0.2.3-alpha.2) is available as `workflow_dispatch` on a
self-hosted runner tagged `dsh-smoke` (see §Smoke). `DSH_SMOKE_ANCHORS` is a
REQUIRED repository variable for that job: a comma-separated list of anchor CLI
paths inside the declared peer range. An empty value fails the job; the
driver's built-in default anchor is the chamber gateway CLI, which is outside
`^0.2.3-alpha.2` and is refused by the driver's own range gate. The job never
runs on ordinary runners. There is deliberately **no cross-line `compat`
matrix**: the plugin declares ONE support line and the dev pin, the CI
typecheck and the smoke all name it.

Dependency updates are **manual**: Dependabot is disabled by maintainer choice
(there is no `.github/dependabot.yml`), so action pins and the pinned
`@deepseek-ai/*` generation are bumped by hand and guarded by
`npm run verify:workflows` + `npm run check`.

## Pre-tag checklist (run all of it on the release commit)

```sh
# 0. version identity — all three must print the same <version>, and the grep
#    must match a DATED "## [<version>] - YYYY-MM-DD" heading. A prerelease
#    version (0.2.6-alpha.N) works the same; release.yml marks any version
#    containing '-' as a GitHub prerelease.
node -p "require('./package.json').version"
node -p "require('./package-lock.json').packages[''].version"
grep -n "^## \[$(node -p "require('./package.json').version")\] - " CHANGELOG.md

# 1. full gate (same chain as CI; installs are frozen npm ci, never bare install)
npm ci --no-audit --no-fund && npm run check

# 1a. lockfile policy. An ORDINARY dependency-surface change refreshes IN
#     PLACE. Never delete the lock and regenerate it beside node_modules: the
#     hidden lock (node_modules/.package-lock.json) becomes the virtual-tree
#     base and npm copies its missing resolved/integrity into the tracked
#     lock, which verify:package rejects and npm ci would install unpinned.
npm install --package-lock-only --no-audit --no-fund
#
#     A GENERATION MOVE (devDeps re-pinned across a dsh line, e.g. the
#     0.2.2-rc.3 -> 0.2.3-alpha.2 move) cannot use that path: the old lock's
#     packages peer on the previous framework pins, so the in-place refresh
#     exits ERESOLVE. Resolve in a CLEAN tree instead — no node_modules — and
#     pass the canonical registry explicitly (a user npm mirror in ~/.npmrc
#     would otherwise bake mirror URLs into the tracked lock; verify:package
#     only checks that resolved/integrity are PRESENT):
#       mkdir -p .scratch/lock && cp package.json .scratch/lock/
#       cd .scratch/lock
#       npm install --registry=https://registry.npmjs.org --no-audit --no-fund
#       cp package-lock.json ../../package-lock.json
#       cd ../..
#     Then prove it: npm ci (installs exactly the lock, rewrites nothing),
#     npm run check, and npm run verify:package. Never reach for
#     --force / --legacy-peer-deps.

# 1b. per-generation type guard — ONE line. The dev pin IS the generation
#     under test, so no --pin is needed: the scratch manifest re-pins every
#     @deepseek-ai/dsh-* dependency to <generation> and keeps the tree's own
#     framework pins. Any other generation means auditing a new line (see
#     §Auditing a new upstream line, trap 6) and then needs that line's three
#     framework pins; the install stays exact.
node scripts/verify-generation.mjs 0.2.3-alpha.2   # must end with PASS

# 2. release mechanics
node scripts/release-notes.mjs "$(node -p "require('./package.json').version")"   # notes compose
node scripts/verify-workflow-action-pins.mjs                                      # pins + release structure

# 3. live smoke on the smoke machine — ONE run per declared line, and the
#    window is exactly one line: dsh 0.2.3-alpha.2. The peer range IS the
#    support window, so a declared line without a run is an unverified claim;
#    the driver itself gates on the declared range and names an anchor outside
#    it. Install the anchor in a scratch directory, then point at its CLI:
#      npm install --prefix <scratch>/dsh@0.2.3-alpha.2 @deepseek-ai/dsh@0.2.3-alpha.2
export DSH_ANCHOR_CLI=<scratch>/dsh@0.2.3-alpha.2/node_modules/@deepseek-ai/dsh/lib/bin.js
npm run test:smoke
#    In CI the same run is the workflow_dispatch smoke job; it REQUIRES
#    DSH_SMOKE_ANCHORS (comma-separated CLI paths of the declared line) and
#    hard-fails when the variable is empty.

# 3a. MANUAL real-browser pass — REQUIRED before the STABLE tag (0.2.6); a
#     prerelease may ship with it outstanding, and must say so in its release
#     notes. In a real browser on the smoke machine, record under .scratch/:
#       - Settings → MCP servers renders from the Factory settings section;
#       - the same section is reused from the shell's Plugins page;
#       - the settings.section.icon seat renders the plug mark in the sidebar;
#       - an OAuth round-trip (Authorize opens the popup, the callback completes,
#         the detail flips to authorized, Sign out clears the grant);
#       - coexistence with an official-plane manager server (no visual/name
#         collision beyond the documented failed{conflict} row).
#     0.2.6-alpha.0 ships with this pass NOT recorded — its release notes state
#     so; do not tag the stable 0.2.6 until the pass (or an explicit maintainer
#     waiver) is recorded.

# 3b. commit, push main, and wait for the CI run on main to finish GREEN.
#     The Release workflow runs `npm run check` only, and the tag-triggered
#     CI runs in PARALLEL with the Release, so a CI failure could not stop
#     publication afterwards. .tmp/ is untracked AND gitignored (the local
#     upgrade plan + R1/R2 review artifacts), so `git add -A` never sweeps
#     scratch into the release commit.
git add -A && git commit -m "release: v<version>"
git push origin main
gh run list --workflow ci.yml --branch main --limit 1
gh run watch <ci-run-id> --exit-status

# 3c. validate the Release workflow itself with ONE dry run on main (chamber
#     rule: workflow/script/action-pin changes need a dry run before the
#     formal tag). dry_run skips release mutation; require success and record
#     the run id under .scratch/.
gh workflow run release.yml --ref main -f version=<version> -f dry_run=true
gh run list --workflow release.yml --limit 1
gh run watch <dry-run-id> --exit-status

# 4. what the remote actually has (never quote a released version from memory)
git ls-remote --tags origin
```

Only then create the ANNOTATED tag on the gate-tested main commit and push it
— the tag is what makes the release real, and a tag must never point at a
commit whose gate was not run. Every release tag since `v0.1.1` is an
annotated object:

```sh
git tag -a v<version> -m "dsh-chamber-mcp v<version>"
git push origin v<version>   # triggers .github/workflows/release.yml
```

If the tag-triggered run fails, fix forward with `gh run rerun <id>` (or
delete and re-push the tag). Do NOT retry through a non-dry
`workflow_dispatch`: that path is not a release path — release creation is
tag-push-only (`if: github.event_name == 'push'`, with
`tag_name: ${{ github.ref_name }}`), so a dispatch can run the gate and the
dry-run checks but never mutates a Release.

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
# 5. commit, push main, wait for CI green, validate the Release workflow with
#    one dry run, then tag + push (the checklist's steps 3b/3c)
git add -A && git commit -m "release: v<version>"
git push origin main
# wait for the CI run on main to finish green, then:
gh workflow run release.yml --ref main -f version=<version> -f dry_run=true
# wait for that dry-run run to finish green, then:
git tag -a v<version> -m "dsh-chamber-mcp v<version>"
git push origin v<version>  # triggers .github/workflows/release.yml
```

### Docs to update with the release

`CHANGELOG.md` is the only version-bearing doc: the workflow composes the
release notes from its dated `## [<version>] - YYYY-MM-DD` section and fails
without one. `README.md` stays version-agnostic — the install example uses
`<version>` placeholders and the badge reads the Releases page — so no doc
statement has to flip once the tag lands, and there is no post-release edit.
Re-run the pre-tag checklist after editing the changelog.

The workflow then:

1. re-runs the full gate and verifies `package.json#version === requested`;
2. composes the release notes from the changelog section of the released
   version (`node scripts/release-notes.mjs "$PKG_VERSION"` — fails the run
   if the section is missing or empty or undated, so a release can never ship
   without notes);
3. refuses to re-publish over an existing *published* release (only stale
   drafts are deleted first — softprops would otherwise silently update the
   old release and discard the fresh body);
4. writes a `.sha256` sidecar next to the tgz and — on a **tag push only**
   (the step is gated `!inputs.dry_run && github.event_name == 'push'`, with
   `tag_name: ${{ github.ref_name }}`, so a manual dispatch never mutates a
   Release) — creates the **GitHub Release** with the notes as the body and
   `dsh-chamber-mcp-<version>.tgz` + `….tgz.sha256` attached (plus the
   workflow artifact upload). It marks the
   release as a **prerelease** whenever the version contains a hyphen
   (`prerelease: contains(version, '-')`), so the `0.2.6-alpha.N` series
   publishes as GitHub prereleases and only the stable `0.2.6` becomes the
   normal Release. npm publishing is currently commented out — see the
   workflow header for the re-enable recipe.

Publication is serialized (`concurrency.group: release-publish`) and also
runs from `workflow_dispatch` with a **dry_run** mode: any change to
workflows/scripts/action pins must be validated by one dry run before the
formal tag (chamber rule). The dry run exists in addition to the main-push CI
run, not instead of it: CI runs the same `npm run check` chain in parallel, the
Release run is self-contained.

Local pre-tag tarballs are evidence, not a byte-identity claim: `npm pack`
copies working-tree file modes (a 0600 working-tree file yields a different
tarball than CI's 0644 checkout), so never quote a local pack digest in
release notes. The Release's `.sha256` sidecar is the authoritative digest
for the published bytes; verify the downloaded asset against it.

Compatibility notes for consumers:

- The dsh loader resolves the row module from the profile dir (pnpm) or the
  dsh installation; the published tarball is exactly what
  `dsh plugin --profile web add dsh-chamber-mcp` installs. On this line the
  plugin mounts an official `McpClientHost` instance per configured server, so
  `@deepseek-ai/dsh-mcp-client` must be present in the rotation (it is a
  REQUIRED peer now) and browser authorization additionally needs
  `authorization` + `webServer` mounted in the composition.
- Peers (`@deepseek-ai/dsh-*`, cordis) are resolved from the dsh install's
  fallback farm; `@deepseek-ai/schemastery` is the ONLY runtime dependency
  installed by pnpm. REQUIRED peers on this line: `@deepseek-ai/dsh-mcp-client`
  (optional on the old line), `@deepseek-ai/dsh-scope` (a shipped value import
  with the capture façades), `@deepseek-ai/dsh-client-ui-slots` and
  `@deepseek-ai/dsh-api-workspace-controller` (the browser half's slot /
  workspace-controller types + service), plus the framework/agent/credentials/
  session/settings/tools/workspace peers. `@deepseek-ai/dsh-mcp-resources` and
  `-system-prompt` are the ONLY optional peers. The
  `@deepseek-ai/dsh-attachment`, `-subprocess` and `-timeout` peers are
  REMOVED — attachment is not a peer at all, and attachment/subprocess/timeout
  now exist only as devDependencies.
  `@modelcontextprotocol/server` and `zod` are devDependencies (test fixtures
  only), and `@modelcontextprotocol/client` is not declared by the plugin at
  all: the mounted official instance brings its own SDK copy, so none of it is
  part of a consumer install.
- **Support window: exactly ONE line — `^0.2.3-alpha.2`** (cordis
  `~4.2.0-alpha.1`), which is also the compile anchor and the dev pin: dsh
  **0.2.3-alpha.2** with `@deepseek-ai/cordis` **4.2.0-alpha.1**,
  `@deepseek-ai/cordis-plugin-loader` **1.2.0-alpha.1** and schemastery
  **~3.20.0-alpha.1** (a single range; the 0.2.2-line union is gone). The
  previous multi-line window (0.2.0/0.2.1/0.2.2) is CLOSED: **0.2.5 is the
  frozen last release of the old line**, and `0.2.6-alpha.0` starts the
  single-line 0.2.6 prerelease series. The runtime preflight evaluates the peer
  range against the host's own version and refuses an out-of-range bundle, so an
  old-line instance must upgrade dsh first.
- **There is no cross-line `compat` matrix any more.** `npm run check`
  compiles the dev pin and `node scripts/verify-generation.mjs 0.2.3-alpha.2`
  compiles the same single line in a scratch tree (no `--pin`), so a peer claim
  is never wider than an actual compile. A future generation move re-pins this
  one line in `package.json` and `ci.yml`; the old lines are not carried. The
  0.1.5/0.1.6 plugin generation — the shared settings namespace
  (`installSection`/`settingsScope`) and the plugin's own text projection — is
  long gone (removed at 0.2.0); do not reintroduce per-generation feature paths
  for a line nobody declares. The mounted instance still owns the definition
  build through the official `createMcpToolDefinition` adapter (its projection
  hook is `projectContent`, installed before `tools/post-execute` policies);
  the plugin captures the built definitions instead of building any.
- **What the generation publishes.** The mounted instance contributes a
  literal `mcp:<server>` system-prompt section (the server's `initialize`
  instructions, `interpolate:false`) and an `mcpResources` provider; the
  applier replays both into the scope of each agent whose workspace enables the
  server (once per epoch, retracted on gate close/teardown). Enablement is the
  only gate — a tool-less server still publishes its context.
- **The live smoke runs against an anchor in the support window — one run per
  declared line, and there is exactly one line: dsh 0.2.3-alpha.2.** Point
  `DSH_ANCHOR_CLI` at that line's CLI (for a local run,
  `npm install @deepseek-ai/dsh@0.2.3-alpha.2` in a scratch directory and point
  at its `@deepseek-ai/dsh/lib/bin.js`; the driver's built-in default is the
  chamber gateway anchor, which is outside the declared range and is refused
  by the driver);
  each transcript records the version it used. In CI the workflow_dispatch
  smoke job REQUIRES `DSH_SMOKE_ANCHORS` and hard-fails when it is unset.
  Note that the M1 driver installs through
  `dsh plugin add`, which delegates to pnpm inside the profile directory: on a
  checkout whose `package.json` declares `packageManager`, corepack's strict
  mode can refuse the install: use a scratch `pnpm` shim (or export
  `COREPACK_ENABLE_STRICT=0`). pnpm also reads its USER config through
  `XDG_CONFIG_HOME`, and a user `rc` that pins `store-dir` at a read-only path
  (a sandboxed runner, for example) makes every install die with
  `[ERR_SQLITE_ERROR] unable to open database file` while the driver only
  reports `pnpm add … failed`; clear `XDG_CONFIG_HOME` and `XDG_DATA_HOME` for
  the run. M0, the plugin-lifecycle driver, is unaffected either way.
- **Reach the official MCP client host through the memoized DYNAMIC import.**
  The host half resolves `@deepseek-ai/dsh-mcp-client` lazily in
  `src/upstream.ts` (one import for the whole plugin, shared by every seat):
  the plugin still activates and serves the settings document on a
  headless/partial composition, each server degrades to a fixed `failed{load}`
  code when the peer is missing, and a REJECTED load is never cached, so
  installing the peer and reloading the Host recovers without a plugin
  restart. Historical measurement stays relevant (2026-09-16, 0.1.5 chamber
  anchor): a static
  `import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'`
  installed silently and then the whole plugin tree failed to load (`does not
  provide an export named 'createMcpToolDefinition'`) and the dsh instance
  exited 1. The general rule remains: reach any optional or generation-specific
  surface through a dynamic import or a service lookup, never a static named
  import. The OLD adapter wrapper is gone: definition building is the mounted
  instance's, and the plugin only captures what it registers.
- Auditing a new upstream line (the 0.1.5 migration, CHANGELOG 0.0.2): diff
  `src/` of the peer packages between the two release tags (`dsh-v<old>`..
  `dsh-v<new>` in the harness checkout), bump the devDependency pins, typecheck
  + test against the new set, then boot the real new CLI per §Smoke — capturing
  the per-workspace tool list AND the browser half's registration trace — and
  only then widen the peer range. Traps these line audits found:
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
  5. **A compatible typed surface is NOT a compatible install.** The runtime
     has evaluated every `@deepseek-ai/dsh-*` peer of a profile bundle
     against its own version since the 0.1.7 line
     (`evaluatePluginCompatibility`, prerelease-inclusive; the function is
     byte-identical in 0.1.7-rc.2 and 0.2.0-rc.1) and REFUSES an out-of-range
     bundle: `dsh plugin add` exits 1 with `installation rejected …
     incompatible …`, and the boot-time profile preflight denies the row.
     What a new upstream line changes is only the runtime version the declared
     range is compared against. Measured on 2026-09-28 with
     `dsh@0.2.0-rc.1` and the then-current `0.2.1` peers
     (`^0.1.7-rc.2`): typecheck and the full 535-test suite were clean
     against the 0.2.0 dependency set — the refusal came from the declared
     range alone. Widen or bump the peers as part of the new-line audit, and
     run the smoke on the new anchor as the proof.
   6. **The one declared line (0.2.3-alpha.2): pin the whole generation and
      its framework set; once it IS the dev pin, audit it with NO `--pin`.**
      The 28 `@deepseek-ai/dsh-*` devDependencies move to `0.2.3-alpha.2`,
      `@deepseek-ai/cordis` to `4.2.0-alpha.1`,
      `cordis-plugin-loader` to `1.2.0-alpha.1`, and schemastery to a single
      `~3.20.0-alpha.1` (the old `^3.18.4 || ~3.18.6-alpha.2` union existed only
      to bridge the old lines and is gone with the single-line window). The
      0.2.3-alpha.2 audit was measured on 2026-11-23: the patched tree compiles
      and passes the full suite (37 files / 812 tests) against the installed set, and
      `node scripts/verify-generation.mjs 0.2.3-alpha.2` prints PASS with NO
      `--pin` — the scratch manifest re-pins the generation's own packages and
      keeps the dev tree's framework pins, so nothing else is owed. To audit a
      DIFFERENT generation before declaring it, pass its three framework pins
      explicitly; the guard keeps the install EXACT, so the closure is complete
      and the framework types are exercised. Two adaptations were needed for
      this line and should be expected on the next move: `ctx.root` is gone
      (three reads become `ctx[Context.root]` with a VALUE import of
      `Context`), and `dsh-system-prompt` now injects `sessionProjections`
      (the test mount recipe is `tests/support/mount-real.ts`: mount
      `SessionProjectionRegistry` → `SystemPrompt` → `ToolRuntime` → the
      tools-injecting factory ctx; a bare `ctx.plugin(SystemPrompt)` stays
      PENDING and `fiber.await()` resolves for a pending fiber). The official
      `createMcpToolDefinition` output schema also gained a `description` on
      `content.items` (test assertion widened). There is no cross-line matrix
      and no legacy compatibility: a future generation move re-pins this single
      line here, in `package.json` and in `ci.yml`, and 0.2.5 stays the frozen
      last release of the old line.

## Smoke — what the self-hosted job runs

`npm run test:smoke` = `scripts/smoke/m1.mjs` (fresh install → settings
describe/mutate → two-workspace model-facing tool capture; the R3 verdict is
transcript evidence, not an exit-code assertion) then `scripts/smoke/m0.mjs`
(install, inventory, revision conflict, credentials, gate). Both drivers **pack
the plugin from the working tree on every run** and drive the install *and* the
boot through the anchor CLI (`scripts/smoke/instance.mjs`'s `ANCHOR_CLI`, from
`DSH_ANCHOR_CLI`; it must be a CLI of the declared line — the driver's built-in
default is the chamber gateway anchor, which is outside `^0.2.3-alpha.2` and is
refused), recording the anchor version, tarball path and installed artifact at
the top of the transcript; both fail the run if the installed version differs
from `package.json`, and m0 additionally fails if the install exits non-zero or
the profile does not gain the bundle. The workflow_dispatch smoke job requires
`DSH_SMOKE_ANCHORS` and hard-fails when it is unset. Prereqs on the
runner: writable repo checkout, that anchor CLI, pnpm on PATH, registry network
for pnpm; everything else lands under `.smoke/` (gitignored). Each driver writes
its transcript to `.smoke/logs/{M0,M1}-raw.log` (M1 also keeps the captured LLM
requests there); transcripts are evidence for that run, not repo content, and are
never committed.

## Rollback

- GitHub Release: edit/delete the Release (or delete just the asset). A fix
  release needs its own version identity: bump `package.json` +
  `package-lock.json` (`packages[""]`) and add a dated
  `## [<next-version>]` CHANGELOG section (e.g. `0.2.6-alpha.1` for a bad
  `0.2.6-alpha.0`), commit, re-gate, then annotate-tag and push that version.
  Never reuse the released version under a suffix tag: the identity gate
  requires package.json == lock root == dated CHANGELOG heading == tag. To
  withdraw a bad release commit without a version bump, `git revert` the
  release commit and push the revert — do not force-move a published tag
  (delete/re-push is only the failed-run recovery above); deleting a tag moves
  the Release back to `draft` state for reuse.
- Users reinstall by pointing `dsh plugin --profile web add` at the new
  asset URL (profile bundles reconcile by installed state).
- The plugin is per-instance state: uninstall guidance lives in README.
- (When npm publishing is re-enabled: `npm unpublish` within 72 h or a fixed
  patch release, and users simply `dsh plugin --profile web add dsh-chamber-mcp`
  again — pnpm update picks the fix.)
