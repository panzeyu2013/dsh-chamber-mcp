# Pre-release docs & hygiene audit — dsh-mcp-scope v0.0.1

- Auditor: final docs & hygiene reviewer (subagent). Date: 2026-09-06.
- Scope: version/name consistency, README truth, CHANGELOG/RELEASE alignment,
  secrets/internal-leak sweep, repo hygiene, milestone-evidence sanity.
- Head checked: `fcfae5c` + working tree (CHANGELOG.md, package.json,
  package-lock.json modified — the intended 0.1.0 → 0.0.1 rename).
- No files were modified by this audit; every fix below is a recommendation
  for the maintainer.
- Verification runs: `npm test` (Node v24.20.0 from `.tools/`) →
  **133 passed / 133, 11 files**; `node scripts/release-notes.mjs 0.0.1` →
  section extracted cleanly (dated 2026-09-06).

## Verdict

**Conditional pass — fix 6 blockers first, then tag.** No real credentials were
found anywhere in the tracked tree; the suite/test-count claims in README are
true; every spot-checked CHANGELOG `[0.0.1]` bullet is traceable to code. The
release-blocking items are version leftovers (0.1.0/0.2.0) in places that
*ship* or that break the release flow: the README install command (npm publish
is disabled yet the README's primary install path is the npm name, and its
file: fallback names a `0.1.0.tgz` that never existed), the stale
`packages[""].version` in the lockfile, and the smoke drivers that hard-code
the old tgz filename. One redaction is required before public: launch-token
values committed in `docs/milestones/M1-live-capture.log`. A cluster of stale
test-count/inject-list claims in evidence docs should be fixed or date-stamped
in the same pass.

## Per-check findings

Legend: **B** = fix before tagging v0.0.1 · **M** = fix before/with the public
push · **L** = recommended, first maintenance pass · INFO = verified clean.

### 1. Version & name consistency

| ID | Sev | File | Finding | Fix |
|---|---|---|---|---|
| V-01 | **B** | `README.md:28` | `# or: add file:./dsh-mcp-scope-0.1.0.tgz` — leftover 0.1.0; the file: fallback names a tarball that never existed. README ships inside the tgz, so this leaks into the release artifact. | `file:./dsh-mcp-scope-0.0.1.tgz`, or better: drop the file: hint and show the release-asset form `dsh plugin --profile web add https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz` (see V-02). |
| V-02 | **B** | `README.md:26-30` | Install section's *primary* command is `dsh plugin --profile web add dsh-mcp-scope` (npm-name install) — but npm publish is **temporarily disabled** (CHANGELOG, release.yml, RELEASE.md all say so). At v0.0.1 every new user running it fails. The README never says npm is disabled; RELEASE.md:34 and release.yml do. | Make the asset-URL install primary (mirroring RELEASE.md + release.yml header comment), keep the npm-name form as "once npm publishing is re-enabled", and state npm-disabled in one line. |
| V-03 | **B** | `package-lock.json:9` | `packages[""].version` is still `"0.1.0"` while the lockfile's top-level `version` and package.json are `0.0.1` (the rename only touched the top-level field). A committed `0.1.0` leftover; `npm ci` tolerates it but any `npm install` rewrites the lock. | `npm install --package-lock-only --legacy-peer-deps` (or hand-edit line 9) before the release commit. All other `0.1.0` hits in the lock are legitimate third-party versions (`dsh-client-*-0.1.0-rc.x`, `forwarded 0.2.0`, etc.). |
| V-04 | **B** | `scripts/smoke/m0.mjs:12`, `scripts/smoke/m1.mjs:36` | Both hard-code `file:.smoke/dsh-mcp-scope-0.1.0.tgz`. After the rename, `npm run pack:tgz` emits `dsh-mcp-scope-0.0.1.tgz`, so `test:smoke` breaks (and *today* it would silently install the **stale 0.1.0 artifact** still sitting in `.smoke/` from 2026-09-06 01:09 — evidence would not match the shipped code). | Derive the name from package.json (`dsh-mcp-scope-${version}.tgz`) or glob the newest `dsh-mcp-scope-*.tgz`; delete the stale `.smoke/dsh-mcp-scope-0.1.0.tgz`; re-run `npm run test:smoke` and refresh `docs/milestones/M1-raw.log` + M1-live-capture evidence. |
| V-05 | L | `docs/milestones/M0.md:13,90`, `M1.md:27,53`, `docs/review/fix-verification.md:18`, `architecture.md:65`, `performance.md:9` | Historical evidence referencing the pre-rename `0.1.0` package / tgz name and 87-test counts. Acceptable as dated evidence, but unlabelled today they read as current. | Add an "as of" stamp or a rename note ("captured while the package was versioned 0.1.0; renamed to 0.0.1 for first release") to M0.md/M1.md; optionally refresh counts (see S-03). |
| V-06 | L | `docs/RELEASE.md:42-56`, `.github/workflows/release.yml` header (v0.2.0 examples), `CHANGELOG.md:94` (`[0.1.0]` compare-link example) | Example flows use `0.2.0`/`0.1.0` as the "next release". After re-basing the first release to 0.0.1, the next release is **0.1.0**; examples skipping to 0.2.0 (and a `v0.0.0…v0.1.0` compare) mislead the first tagger. | Make examples generic (`<version>`) or step them to `v0.1.0`. Cosmetic (comments/HTML comment), not release-blocking. |
| INFO | — | `cordis.patch.yml` row `id: mcp-scope, name: dsh-mcp-scope` matches README/CHANGELOG claims and the exports map (`./cordis.patch.yml`). Package name consistent everywhere checked. No other user-facing `0.1.0`/`v0.1`/`0.2.0` leftovers in README, CHANGELOG body, workflows, src/, lib/, cordis.patch.yml. | — |

### 2. README truth audit

| ID | Sev | Finding | Fix |
|---|---|---|---|
| R-01 | **B** | Install/uninstall commands — see V-01/V-02 (uninstall `dsh plugin --profile web remove dsh-mcp-scope` + restart is fine and matches the dsh CLI surface used in smoke). | See V-02. |
| R-02 | M | "Prereqs: Node ≥ 24, pnpm on PATH (the dsh CLI drives pnpm itself)" is a *toolchain* statement parked in the *Install* section. Evidence: Node ≥ 24 is engines/CI/.nvmrc (toolchain); the live installs in M0/M1 ran the plugin under a Node-22 dsh anchor with pnpm driven by the dsh CLI, and repo dev uses **npm** (workflows run `npm ci`, README dev section runs `npm install`), so pnpm-on-PATH isn't a user prerequisite either. | Reword: "Install needs only the dsh CLI (0.1.2-rc.1 generation, npm `next`); Node ≥ 24 is required only to build this repo from source (engines)." |
| R-03 | L | Delegation-children note is **absent** from README though it is in CHANGELOG (`[0.0.1]`), design.md, acceptance.md, agents.ts:17,179: sessions with `origin: 'subagent'` are never adopted, so delegation children never see MCP tools. Materiality for a first release: **low-medium** — main-session users delegating will silently lose MCP tools in children; cheap to state. | Add one line under "Use" or "Compatibility": "Delegation/subagent sessions never receive MCP tools (children are preset-governed; by design)." |
| R-04 | L | Section identity claims check out against code, so only wording polish: "nav order 25, after 智能体预设/Agent presets" is corroborated (src/client/index.ts:164 `order: 25`; recon/ui-contracts.md:157,306 shell nav general 0 / models 10 / plugins 15 / agent-presets 20; chamber-bridge.md:218). | None. |
| Verified-true | — | Test count "133 tests" = actual run (133/133, 11 files); dev-section commands all exist in package.json scripts (typecheck/test/check/verify:package/pack:tgz/test:smoke); CI description (ci.yml, Node 24, upload tarball, tag-driven release, npm disabled) matches the workflows; layout links resolve (design.md, recon/, milestones/M0.md+M1.md, host-notes.md, ui-notes.md, review/ round-2 + SUMMARY.md, RELEASE.md); cut list (no toolPolicy, pause key, custom naming, status viz, on-demand connects, CLI surface) matches acceptance.md C1–C6, schema.ts (no such fields), package.json (no `bin`); per-workspace default-on semantics, off-switch rows, write-only secret inputs, scrub of DSH_*/secret-shaped env, "session outside registered workspace ⇒ no MCP tools" (agents.ts + design.md) all match code; "restart once" caveat matches M0 evidence. | — |

### 3. CHANGELOG / RELEASE alignment

| ID | Sev | Finding | Fix |
|---|---|---|---|
| C-01 | **B** | `CHANGELOG.md:8-14` — `[Unreleased]` still holds the two "GitHub Release publishing / npm disabled" bullets while the dated `[0.0.1]` section (the one `release-notes.mjs` will emit as the v0.0.1 GitHub notes) does not mention that releases ship as **tgz asset only** with npm disabled. The composed v0.0.1 notes therefore omit exactly the information a first-release user needs. | Fold the two bullets into `[0.0.1]` (or replace with a short `[0.0.1]` bullet: "Releases ship as a GitHub Release tgz asset; npm publishing temporarily disabled — see docs/RELEASE.md"), leaving `[Unreleased]` empty. |
| C-02 | L | `CHANGELOG.md:91-94` HTML-comment example uses `[0.1.0]` compare link; see V-06. | Generic/step to 0.0.1 in the comment. |
| Verified-true | — | Spot-checked 8+ `[0.0.1]` bullets against code: revision-fenced writes (M0 + settings.spec); mcp__ naming + collision hash, generation swap, `tools/list_changed` re-sync, backoff reconnect, 5 s close discipline (tools.ts, server.ts:89 `GENERATION_CLOSE_TIMEOUT_MS = 5_000`); scrubbed child env (transport.ts via dsh-subprocess); per-agent-scope registration, never global, subagent exclusion (agents.ts:17,179); removal-cascade prune of override rows — controller.ts:605 `removeServerOverrides(base.doc.overrides, serverName)` (round-2 IMPL-5, fixed in 4dd4d85); CR/LF/NUL rejection at transport (transport.ts:13,34,78,108); RFC 9110 header-token + env-key patterns at schema/document/**and** UI level (HEADER_NAME_PATTERN in shared/model.ts, schema.ts, add-form.tsx:151-155); `MAX_SYNC_TOOLS = 2000` cap keeping previous generation (tools.ts:51,147-149); read-back verification / conflict-not-success (controller applyOps); teardown revokes everything (manager.dispose); (epoch, syncId) dedupe; reserved override keys (`RESERVED_OVERRIDE_KEYS`). **No overclaims found.** | — |
| Verified-true | — | RELEASE.md mechanics match workflows: version===tag check, release-notes.mjs failure modes (missing/empty/undated), softprops asset from `.smoke/verify/dist/*.tgz`, npm re-enable recipe (uncomment + `NPM_TOKEN` + restore `id-token: write`) is consistent with release.yml comments and header; smoke section consistent with scripts. | — |
| H-01 | **B** | `docs/RELEASE.md:5` — "CI … runs on every push/PR against **Node 22 and 24**" is stale: ci.yml matrix is `['24']` only since 43a2dfd; README correctly says Node 24. | Say "Node 24". |

### 4. Secrets / internal-leak sweep

| ID | Sev | Finding | Fix |
|---|---|---|---|
| S-01 | **M** | `docs/milestones/M1-live-capture.log:2,6` — two **unredacted launch-token values** (`http://127.0.0.1:32132/?token=6fkFa4…`, `…?token=mXAnWXN…`) committed. They authenticate to the (dead) scratch instance's web GUI; residual risk is low but they are real secret-shaped values in a repo slated to go public. Everything else in the milestones logs is benign (session UUIDs, fixture refs `MCP_SCOPE_TEST_TOKEN`, `smoke-secret-123`, `sk-mock-123` — fixture values only, no real credentials found anywhere). | Redact the two tokens (`?token=<redacted>`) in the committed log. Keep fixture values as-is. |
| S-02 | **M** | `.github/workflows/ci.yml` smoke-job comment embeds the machine path `/root/.dsh-chamber/gateway/dsh-anchor`. Policy: workflows may reference only `<owner>` placeholders (release.yml complies). | Replace with a placeholder (`<chamber-anchor-path>`) + pointer to docs/RELEASE.md §smoke. |
| S-03 | L | Machine-specific absolute paths (`/root/.dsh-chamber/gateway/…`, `/root/.nvm/…`, `/root/projects/…`) appear in many committed docs **outside** the allowlist (milestones logs + RELEASE.md smoke-runner section + scripts/smoke): docs/recon/* (core-apis, mcp-client-official, chamber-bridge, ui-contracts, plugin-distribution, runtime-test-env), docs/review/* (round 1 + round 2), docs/ui-notes.md:6. They also name internal-only artifacts (.recon/dump-web.yml — gitignored) and the "chamber" gateway deployment layout/ports. No credentials among them (apiKey/token/password/authorization scan: only dummy `sekret-xyz-123` etc.). | Decide one of: (a) add a docs/README.md note "evidence docs contain sandbox-absolute paths of the authoring environment" (cheap, recommended for v0.0.1); (b) bulk-redact `/root/…` → `<sandbox>/…` in recon/review/ui-notes (mechanical, safer for public repo); (c) curate which evidence docs ship. Also consider genericizing the two README mentions of the internal codename ("dsh-chamber never seeds…" README.md:19, "the generation dsh-chamber runs" README.md:74) if that codename is not public. |
| S-04 | L | `docs/RELEASE.md:22` — the anchor path appears in the "CI (push / PR)" section, i.e. outside the §smoke-runner section that policy allows it in. | Move the sentence into §smoke or make it relative ("the smoke machine's anchor CLI path — see §smoke / scripts/smoke/instance.mjs"). |
| Clean | — | Token-like scans (`panze…`, `smoke-secret`, `sk-mock`, `sekret`, `sk-…`, `Bearer …`, `ghp_`, `AKIA`, apiKey/password/token value patterns) across the tracked tree found **no real credentials**; git history beyond HEAD not scanned (only current tree checked, per scope). README/CHANGELOG/src/lib/cordis.patch.yml contain none of `/root/`, `/home/`, `dsh-anchor`, `.dsh-chamber`, or nvm install paths (CHANGELOG's `.nvmrc` mention is the repo's own file, legitimate). | — |

### 5. Repo hygiene

| ID | Sev | Finding | Fix |
|---|---|---|---|
| Y-01 | L | `docs/README.md` index omits entries it should list now: the new `review/prerelease/` dir (this audit), and the milestone raw logs it links into (`M0-raw.log`, `M1-raw.log`, `M1-live-capture.log`); `review/` row is fine. | Add rows when this report lands; add raw-log rows. |
| Clean | — | `git status`: only the intended 3 modified files (CHANGELOG.md, package.json, package-lock.json — the 0.0.1 rename); nothing else staged/unstaged. `.gitignore` covers `.smoke/`, `.tools/`, `lib/`, `.recon/`, `*.tgz`, `node_modules/` — confirmed by `git ls-files` (0 tracked files under those prefixes); **lib/ is gitignored by design and CI builds it** (ci.yml + release.yml run `npm run build` before `verify:package`; `prepack` also builds). Largest tracked file is package-lock.json (215 KB); 79 tracked files, no binaries. LICENSE (MIT, tracked) and CHANGELOG: LICENSE + README ship in the tarball via npm auto-include under `files: [lib, cordis.patch.yml]` and verify-package.mjs asserts the exact pack surface (`lib`, `cordis.patch.yml`, `LICENSE`, `README.md`, `package.json`; no src/tests/.smoke/docs leaks) — intentional and consistent with RELEASE.md:12-13. `.nvmrc` = `24` matches engines/CI/README. | — |

### 6. Milestone evidence sanity (recommendations only)

| ID | Sev | Finding | Recommendation |
|---|---|---|---|
| S-03 (mst) | **M** | `docs/milestones/M1.md:57-63` ("Honest gaps") still claims *"No live model-request tool capture … no headless path found"* — directly contradicted by the committed `M1-live-capture.log` + `M1-raw.log` (R3-live-capture: PASS, on-workspace turn carries `mcp__fixture__*`, off-workspace does not; commit 47be3b7 closed this) and by M0.md:99-103, which points at M1.md for the closure. A maintainer can no longer tell the current state. | Rewrite M1.md gap bullet 2 to "closed via rc.1 remote mux (`session/follow`) — R3 PASS in M1-live-capture.log"; it may also mention the browser-render gap (bullet 1) is still open. |
| S-03 (cnt) | L | Test counts in evidence docs are stale vs the current 133/11: M0.md:90 & M1.md:27 say 87; host-notes.md:20-23 say 84/84 (10 files); ui-notes.md:27-29 say 130/11; SUMMARY.md:96 claims the count docs "were refreshed to 130/11" while line 114 correctly says 133 (README now 133). | Stamp each with "as of <date>" or refresh to 133/11 in the release pass (SUMMARY:96 wording too). |
| S-03 (gap) | L | M1.md's "M1 acceptance recap" R3 row credits only the in-process suite; the live R3 capture is the stronger evidence (M0.md has it). | Optionally mention M1-live-capture.log in M1.md's recap. |
| Clean | — | Live-capture/raw logs contain no real credentials (see S-01) and their PASS states (row active, revision fence, credentials write-only, R3 on/off tool sets) still match current behavior; the assertions they document are re-verifiable via `npm run test:smoke` (after V-04). | — |

## REQUIRED scrubs before release

1. README.md: rewrite the Install snippet for npm-disabled reality — asset-URL install (v0.0.1), drop the `0.1.0.tgz` file: fallback (V-01, V-02). (Ships in the tarball.)
2. package-lock.json: fix `packages[""].version` 0.1.0 → 0.0.1 (V-03).
3. scripts/smoke/m0.mjs + m1.mjs: version-agnostic tgz path; delete stale `.smoke/dsh-mcp-scope-0.1.0.tgz`; re-run smoke and refresh `docs/milestones/M1-raw.log` / evidence (V-04).
4. docs/RELEASE.md:5 — "Node 22 and 24" → "Node 24" (H-01).
5. CHANGELOG.md: fold `[Unreleased]` bullets into `[0.0.1]` (C-01).
6. docs/milestones/M1-live-capture.log: redact the two `?token=…` launch tokens (S-01).
7. .github/workflows/ci.yml: replace `/root/.dsh-chamber/gateway/dsh-anchor` comment path with a placeholder (S-02).
8. docs/milestones/M1.md: fix the stale "no live capture" gap bullet; stamp test counts (S-03 mst/cnt).

## Prioritized actions

1. **P0 — release-blocking, before the v0.0.1 tag:** items 1–5 above (README install, lockfile, smoke scripts, RELEASE.md matrix line, CHANGELOG Unreleased fold), then re-run `npm run check` and commit.
2. **P1 — before the repo goes public / same release commit:** items 6–8 above (token redaction, ci.yml path, M1.md contradiction + counts), plus ui-notes.md:69-71 inject-list correction (pre-FE-3 list with `connection`, missing `remote.credentials` — contradicts code `inject = ['slots','locale','remote','remote.credentials','settingsScope','workspaces']`, design.md:96 and its own §3.3) and the host-notes/ui-notes/SUMMARY:96 count stamps.
3. **P2 — first maintenance pass:** README prereq wording + delegation-children line (R-02/R-03); RELEASE.md §smoke path placement (S-04); docs/README.md index rows incl. `review/prerelease/` (Y-01); placeholder-version examples in RELEASE.md/release.yml/CHANGELOG comment (V-06); decide the evidence-doc machine-path policy (note vs redact) (S-03) and whether the internal "chamber" codename should be genericized in README.
4. **Positive results worth keeping:** 133/11 tests green on Node 24 (README claim exact); release-notes composition works for 0.0.1; the rename to 0.0.1 also resolved the long-documented ARCH-13 wire-identity skew (server.ts:321 already pins `{name:'dsh-mcp-scope', version:'0.0.1'}`, which now equals the package version); no overclaims found in the CHANGELOG; no real secrets anywhere.
