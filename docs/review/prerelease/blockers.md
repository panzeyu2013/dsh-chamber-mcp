# Final pre-release blocker audit — dsh-mcp-scope v0.0.1

- Auditor: final blocker auditor (subagent). Date: **2026-09-06 UTC**.
- Toolchain: Node **v24.20.0** + npm 11.19.0 from `.tools/node-v24.20.0-linux-x64`.
- Baseline: HEAD `fcfae5c` + working tree (0.1.0 → 0.0.1 rename uncommitted).
- **Concurrency caveat:** sibling final-audits (docs-hygiene, mechanics, client-ux)
  ran in this workspace at the same time and a convergence pass edited tracked
  files **during** this audit (`src/client/controller.ts`,
  `src/shared/model.ts`, tests, `.github/workflows/*.yml`, `README.md`,
  `CHANGELOG.md`, `package-lock.json`, `scripts/release-notes.mjs`,
  `docs/milestones/M1-live-capture.log`, `docs/RELEASE.md`, …). All gate
  evidence below carries the tree state it was run against; the final snapshot
  is **03:07 UTC** and every run was re-verified on the settled tree
  (see §Evidence). Findings are written "as-found → status at snapshot" so the
  maintainer can re-verify the last few items at commit time.

---

## VERDICT

**RELEASE-BLOCKERS: none on the product code — the shipped surface (src/, lib,
cordis.patch.yml) is release-clean** (no critical logic defect found in the
blocker sweep; gate battery fully green; determinism verified; live M1 smoke
PASS under Node 24 today; tarball surface exact; no secret/path leaks in the
tarball). **However the tree as found at audit start had 7 release-critical
warts; 6 were already fixed in-tree by the concurrent convergence pass before
the final snapshot — 1 remained** (B-1 below, a 5-minute fix). Since the tree
is mid-edit, the honest verdict is: **do not tag until B-1 is fixed and
`npm run check` + `node scripts/release-notes.mjs 0.0.1` are re-run on the
exact commit** (5 minutes). Everything else is verification/hygiene (P1/P2).

### Must-fix before the tag (status at final snapshot 03:07 UTC)

| # | Sev | Finding (as-found) | Status at snapshot |
|---|---|---|---|
| B-1 | **BLOCKER** | `README.md:28`: install snippet ships inside the tarball and instructs `dsh plugin --profile web add dsh-mcp-scope` (npm publish is **disabled** — the name does not resolve) with `# or: add file:./dsh-mcp-scope-0.1.0.tgz` (names a tarball that never existed; release asset is `…0.0.1.tgz`). A first user with only the tgz cannot install by following the README. | **STILL BROKEN at snapshot** (README.md:28 unchanged). Fix: asset-URL form `dsh plugin --profile web add https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz` (owner placeholder), drop the npm-name primary while publish is off. |
| B-2 | BLOCKER (process) | `scripts/smoke/m0.mjs:12` + `scripts/smoke/m1.mjs:36` hard-coded `file:.smoke/dsh-mcp-scope-0.1.0.tgz`. After the rename, `pack:tgz` emits `dsh-mcp-scope-0.0.1.tgz`: on a clean checkout `test:smoke` fails at the first `dsh plugin add` (ENOENT); and the stale 0.1.0 tgz still sitting in `.smoke/` (packed 01:09, **before** the last source build 02:14 — `lib/manager.js` differs, sha256-proven) meant the previous m1 PASS (02:15) exercised pre-fix manager code, not the release content. | **FIXED in-tree** by convergence pass: both drivers derive `PKG_VERSION` from package.json (`m0.mjs:12` `dsh-mcp-scope-${PKG_VERSION}.tgz`, m1 equivalent). Maintainer: delete stale `.smoke/dsh-mcp-scope-0.1.0.tgz` and re-run `npm run test:smoke` before tagging. |
| B-3 | BLOCKER (CI) | All four workflow action pins run the **Node 20 action runtime** (verified `runs: using: node20` in the live `action.yml` of `actions/checkout@v4`, `actions/upload-artifact@v4`, `softprops/action-gh-release@v2`; setup-node@v4 same family). GitHub runners default to the Node 24 runtime and require an opt-out for node20 actions (public changelog 2026-06-16; node20 removal 2026-09-23 — full citation in `docs/review/prerelease/mechanics.md` MECH-01). The tag-push release gate could fail at step 1. | **FIXED in-tree**: `checkout@v5`, `setup-node@v5`, `upload-artifact@v6`, `softprops/action-gh-release@v3` (ci.yml/release.yml). Maintainer: verify on a real push/PR (not just workflow_dispatch smoke). |
| B-4 | HIGH | `package-lock.json` internal skew: top-level `version` 0.0.1 but `packages[""].version` stayed `"0.1.0"` (engines `>=22.0.0` while package.json says `>=24.0.0`). `npm ci` tolerates it; the packed artifact is unaffected; but the committed lockfile would carry a stale self-version + wrong engines. | **PARTIALLY FIXED**: `packages[""].version` now 0.0.1; **engines row still `>=22.0.0`** (snapshot). Low-severity leftover: hand-edit or `npm install --package-lock-only` before commit. |
| B-5 | MED | `CHANGELOG.md [Unreleased]` still held the "GitHub Release publishing / npm disabled" bullets, so the composed v0.0.1 release notes (GitHub body) would omit the tgz-only install reality for first-release users. | **FIXED in-tree**: `[Unreleased]` emptied; a "Release mechanics" bullet folded into `[0.0.1]`. Re-verify output of `node scripts/release-notes.mjs 0.0.1` at commit. |
| B-6 | MED | Release-notes composer captured the changelog **footer HTML comment** into the GitHub Release body (capture ran to EOF), and a `## ` heading inside a future code fence would truncate notes. | **FIXED in-tree**: `scripts/release-notes.mjs` stops at `<!--` (footer scaffolding excluded). |
| B-7 | MED (hygiene) | Two **unredacted launch tokens** (`?token=…`) committed in `docs/milestones/M1-live-capture.log` of a repo slated to go public. | **FIXED in-tree** (0 `token=` matches at snapshot). |

---

## 1. Blocker sweep (fresh-eyes findings)

- TODO/FIXME/HACK/XXX: **none** in `src/`, `scripts/`, `.github/workflows/`
  (grep-verified; the temporary probe spec a parallel auditor left in
  `tests/client/` was deleted by its owner mid-audit; it had broken
  `npm run typecheck` with TS2339 and its type error is recorded in
  `.smoke/audit-typecheck.log`).
- `console.*`/debugger in shipped paths: **none** in `src/**`,
  `scripts/build.mjs`, `scripts/verify-package.mjs`, and the built `lib/`
  (grep-verified). Smoke drivers (`scripts/smoke/*.mjs`) use
  stdout/`process.stdout.write` — drivers, not shipped code.
- Swallowed-error / unhandled-rejection walk (src/index.ts apply, manager,
  supervisor, applier):
  - `apply` registers manager effects **before** `installSection`; if
    `installSection` throws (see §4 boot walk) the cordis failed-fiber teardown
    runs every disposer (`_unload` → disposables awaited), so the manager
    dispose effect stops all supervisors and the agents effect revokes live
    registrations — no leaked processes. Every internal promise tail is
    caught (`mutations` chain, `syncChain`, `Promise.allSettled` in dispose,
    supervisor `settling`/close barriers with 5 s fail-closed timeout).
  - Manager disposal ordering (index.ts effect registered after
    createManager's internal effects) ⇒ LIFO: `manager.dispose()` runs before
    the credential/domain/agents listeners are removed — supervisors stop
    while the applier is still alive and revoke-first; then `applier.dispose()`
    revokes stragglers; late supervisor commits during teardown cannot
    outlive it (push no-ops after applier dispose; `(epoch,syncId)` guard).
  - Credentials event handler: no async work in the listener body; restart
    queueing is chain-serialized and coalesced; marker cleared before any
    await (no wedge); `restartServer` judges doc presence live.
  - Settings hooks: `onChange → manager.reconcile()` is chain-enqueued
    (never throws into the watcher); `setSource` assigns a thunk (cannot
    throw); `validate` throws deliberately — write-time refusals happen
    before persistence (pinned by `tests/host/settings.spec.ts`).
- Round-1/round-2 residual sweep vs current code: SEC-03 reserved-name write
  gate + `RESERVED_OVERRIDE_KEYS` present (`shared/model.ts:96`); SEC-02
  CR/LF/NUL transport rejection present (`transport.ts:38-43`); R2S-2 sink
  sanitization present (`server.ts:183-187`, `agents.ts:146-150`); IMPL-11
  header/env-key token patterns present in schema + validateDoc + UI
  (`HEADER_NAME_PATTERN`, RFC 9110 tchar). The remaining documented
  residuals (SEC-03 boot-layer nit; IMPL-3 same-tick double-cycle; delegation
  E2E untested; UX focus polish) are non-blocking, documented, and unchanged
  — see docs/review/SUMMARY.md + round2 reports.
- **Pre-release F1 fix landed mid-audit (convergence pass)** and is a genuine
  correctness improvement now in the release: `isEnabled`/`overrideDoc`/
  `diffOverrides` moved to **own-property presence** (`Object.hasOwn`,
  null/type guards), so serverNames colliding with `Object.prototype` members
  (`toString`, `valueOf`) can no longer read as phantom off-switches or make
  the toggle a silent no-op; regression tests added (`model.spec.ts`,
  `controller.spec.ts`). Typecheck-failing test literals (TS2322) were fixed
  in-tree; final gates green (135 tests).

## 2. Host release-critical re-verification — evidence table

All runs: Node v24.20.0. Logs kept in `.smoke/` (gitignored).

| Check | Result | Evidence |
|---|---|---|
| (a) suite 3× + typechecks + build + verify:package | **GREEN** | 3× `npm test`: **133/133, 11 files, exit 0** (.smoke/audit-test-{1,2,3}.log, ~3.2-3.6 s each); `npm run typecheck` exit 0 (audit-typecheck-2.log); `npm run build` exit 0 (audit-build-1.log); `npm run verify:package` exit 0 (audit-verify.log: `packed: dsh-mcp-scope-0.0.1.tgz`, `tarball contents OK (30 entries)`, `consumer typecheck OK`, `determinism OK`, `verify:package PASS`). All runs pre-F1-fix tree. |
| (a′) gates re-run on the FINAL settled tree (post-F1 + convergence) | **GREEN** | `npm run typecheck` exit 0, `npm test` **135/135, 11 files** exit 0, `npm run build` exit 0, `npm run verify:package` exit 0 (audit-h1..h4.log, 03:0x). Intermediate state (F1 fix with type-unfixed test literals) failed typecheck — TS2322 ×4 — fixed in-tree; recorded in audit-tc-final.log. |
| (b) determinism double-build | **OK** | verify:package internal rebuild compare passes (`determinism OK`); pack→hash→rebuild→hash identical in both battery runs. |
| (c) `node scripts/release-notes.mjs 0.0.1` | **OK** | exit 0; emits dated section `## 0.0.1 - 2026-09-06` with full body (audit-notes.md, 80 lines). Pre-fix run included the changelog footer comment — B-6, since fixed in-tree. |
| (d) `npm run pack:tgz` naming | **OK** | Produces `.smoke/dsh-mcp-scope-0.0.1.tgz` (61,566 B). Caveat: in this sandboxed session a bare `npm run pack:tgz` failed writing npm logs to `/root/.npm` (environment HOME restriction — verify-package.mjs documents the same and redirects `npm_config_cache`); with `npm_config_cache=.smoke/npm-cache` it exits 0. On CI/self-hosted runners HOME is writable. Fresh-checkout hazard (missing `.smoke/` as pack destination) is recorded by the mechanics audit (MECH-02) — recommended `mkdir -p .smoke` in the script or job. |
| (e) LIVE smoke m1 under Node 24 today | **PASS** | Run 02:58-02:59 UTC, exit 0 (`.smoke/logs/audit-m1-run.log`): plugin add OK (bundles `@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-mcp-scope`), namespace R/W, fixture server supervised, two live sessions, **R3-live-capture: PASS** — on-workspace turn carries `mcp__fixture__echo/env_report` (28 tools), off-workspace turn carries none (26 stock). Assertions match current code (no stale expectations: script asserts tool naming, bundle list, snapshots, request-log turns — all observed). The run used the current-content tarball (fresh 0.0.1 pack copied over the stale `.smoke/dsh-mcp-scope-0.1.0.tgz` name the driver then hard-coded — B-2 fixed after). Evidence file `docs/milestones/M1-raw.log` was refreshed by the run and **restored to its pre-run content** (this audit writes only this file). Freshness caveat: smoke drivers do not wipe scratch homes (`m1-home` reused workspaces/servers across runs — the earlier 02:15 PASS installed the stale pre-fix tarball, sha256-differing in `lib/manager.js`). |
| (f) installSection invalid-doc boot path | **Walked — no uncaught throw escapes cordis; fails loud at boot** | See §3. |

## 3. Boot-path walk: stored-section validation failure at registration (check f)

Read against the identical dsh-settings generation installed in the repo and
the anchor (`lib/index.js` sha256-identical):

1. `installSection` → `register()` resolves the stored section **synchronously**:
   `resolved = resolve(schema, base, section(stored), validate)` — schema parse
   first, then the consumer `validate` hook on the schema-valid value
   (dsh-settings docs: "An invalid stored section fails the registration
   itself").
2. Our `validate` runs `validateDoc` (duplicates, reserved names, empty
   command/url, env-key/header-name tokens). So a **hand-authored
   `settings.yaml` section that is schema-valid but semantically invalid**
   (e.g. duplicate serverName) makes `installSection` throw, exactly like a
   schema-invalid section.
3. The throw happens inside `apply()` **after** `createManager`; the cordis
   fiber marks the plugin failed (`_reload` catch → `_error`), disposes the
   fiber's effects (manager dispose stops supervisors, applier revokes — clean,
   awaited, no unhandled rejection), and dsh-app-boot's `assertEntriesActivated`
   audit turns that into a **host boot failure** with the plugin's stack
   (`dsh-app-boot/lib/index.js:1431-1467,1503`; fail-loud is the platform's
   design for every loader entry and every settings namespace).
4. Conversely, **write paths are fully protected before persistence** (UI
   mutate/update/replace → resolve+validate throws pre-persist, nothing
   written; pinned by tests/host/settings.spec.ts incl. duplicate names and
   empty commands), and **external file changes** (settings-file watcher →
   `publish()`) keep the last good value and warn — never crash.
5. Recovery story: an invalid stored section is visible in the boot error; the
   user fixes/removes the `mcp-scope:` section of `settings.yaml` (or removes
   the plugin). Acceptable but **should be documented** (README uninstall notes
   already point at settings.yaml) and the error text "mcp-scope: refusing
   document write: …" is misleading on the boot (load) path — recommend
   rewording to "mcp-scope: invalid document rejected: …" (NEW-F-1, LOW).
6. Gap: no test pins the registration-time failure path (settings.spec covers
   write refusals only). Recommend one boot-style test
   (register section from an invalid stored file → expect installSection
   throw / plugin failure) (NEW-F-2, LOW). Not release-blocking: the write and
   publish paths are pinned and the boot path is platform-fail-loud by design.

## 4. First-boot & upgrade sanity (check 3)

- **Row activation on a stock web profile: proven live.** M0/M1 runs install
  into a fresh scratch profile whose bundles are exactly
  `@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app` + ours; the loader row
  `mcp-scope` activates, the inventory lists it, the `mcp-scope` settings
  namespace is served and writable (revision-fenced). `dsh-base`'s patch
  provides the host rows (`settings`, `credentials`, `tools`, `workspace`,
  `agent-loop`, …); `dsh-web-app` overrides/additions are the web-only rows
  (docs/recon/plugin-distribution.md §5b/5c; `.recon/dump-web.yml` capture).
- **Inject names vs the 0.1.2-rc.1 surface: all exist.** `ctx.settings`,
  `ctx.credentials`, `ctx.tools`, `ctx.workspaceRegistry`, `ctx.agents` are
  declared by the anchor generation's d.ts declaration merges (verified in
  `@deepseek-ai/dsh-{settings,credentials,tools,workspace,agent}/lib/types`);
  repo devDeps are the same generation and the typecheck compiles both host
  and tests. Events `credentials/reference-updated` (dsh-credentials) and
  `domain/changed` (dsh-storage-domain, `workspace`/`workspaces`) both exist
  in the anchor d.ts; the manager's domain-listener closes the
  workspace-delete quiescent window (SUMMARY round-2 residual, code at
  `manager.ts:217-227`, test in manager.spec).
- **No inject-name typo risk found**; a mismatch would fail `tsc` against the
  pinned devDeps (they mirror the anchor byte-for-byte for dsh-settings).
- **Future dsh removes/renames a service:** inject is a required list, so the
  fiber stays inactive ("pending, waiting for service: X"); in 0.1.2-rc.1
  dsh-app-boot treats settled-pending entries as activation failures at boot
  audit — i.e., degradation is a **loud boot error naming the missing service
  (and the plugin auto-activates if the service later appears)**, not a
  half-working row. Acceptable fail-loud behavior for a compat break; note it
  in RELEASE.md's compatibility paragraph (the "next dsh bump" discipline
  already exists there). NEW-U-1 (LOW/INFO).
- Upgrade path within v0.0.1: no earlier release exists; re-running
  `dsh plugin add` over an existing install is idempotent (bundle list
  reconciliation, m0 evidence). A settings doc written by a **future**
  version that our schema/validateDoc rejects fails boot loudly (§3) — the
  documented recovery (edit settings.yaml) applies.

## 5. Publish surface (check 4)

- `files: ["lib", "cordis.patch.yml"]` + npm auto-include LICENSE/README/
  package.json. **Tarball listing (30 entries): exactly lib/* (js + types),
  cordis.patch.yml, LICENSE, README.md, package.json — no src/tests/.smoke/
  scripts/docs/.github leaks** (verify:package whitelist + independent
  `tar -tzf` listing at `.smoke/audit-tgz-listing.txt`).
- **CHANGELOG.md is intentionally excluded**; nothing inside the tarball
  references a changelog (package.json, README, cordis.patch.yml clean).
  Release notes are composed from the repo changelog at tag time — correct.
- **prepack recursion:** `npm pack` → `prepack: node scripts/build.mjs` →
  plain tsc ×2 + esbuild (`build.mjs` calls no npm) — **no recursion, no
  double-build loop**; each pack rebuilds once (cheap, deterministic).
- LICENSE present, MIT, with upstream attribution of the mirrored
  dsh-mcp-client logic (verified header). `publishConfig.access: public`,
  `engines.node >=24.0.0`, `.nvmrc` 24, CI Node 24 — consistent
  (lockfile root-entry engines row `>=22.0.0` is the lone leftover, B-4).
- **Leak grep:** no `/root/`, `/home/`, `/tmp/`, `.smoke` references in
  `lib/` or `cordis.patch.yml`; no console/debugger/TODO in lib (clean, see
  §1). Workflows still name the smoke machine's anchor path in comments
  (ci.yml, RELEASE.md §CI) — self-hosted-runner description; hygiene item
  (docs-hygiene S-02, P2).
- README inside the tarball references repo-only docs (`docs/design.md` etc.)
  that do not ship — inert links for tgz consumers (LOW, cosmetic).

## 6. Version consistency (check 5)

- package.json **0.0.1** == package-lock top-level **0.0.1** == CHANGELOG
  `[0.0.1] - 2026-09-06` == release-notes extraction (0.0.1) == tarball name
  `dsh-mcp-scope-0.0.1.tgz` == supervisor wire identity
  `{name:'dsh-mcp-scope', version:'0.0.1'}` (`lib/server.js:218` — the long-
  documented ARCH-13 skew is now resolved by the rename).
- Leftovers (user-facing): **README.md:28 `0.1.0.tgz`** (B-1, unfixed at
  snapshot); lockfile root-entry engines `>=22.0.0` (B-4). Historical
  0.1.0/0.2.0 mentions in milestone evidence docs are dated artifacts
  (labeled in docs-hygiene V-05); RELEASE.md/release.yml copy-paste examples
  (`v0.2.0`) and the "Node 22 and 24" CI claim were **fixed in-tree** by the
  convergence pass (mechanics MECH-04/H-01); CHANGELOG compare-link example
  comment updated.
- README placeholders: install snippet is the only version-bearing example
  (B-1). `npm run pack:tgz # …dsh-mcp-scope-<ver>.tgz` uses a placeholder —
  fine.

## 7. New findings (severity)

| ID | Sev | Finding |
|---|---|---|
| NEW-F-1 | LOW | Boot-time validate failure reports "refusing document write" — no write occurred (load path). Reword to "mcp-scope: invalid document rejected: …". |
| NEW-F-2 | LOW | No test pins installSection/register failure on an invalid *stored* doc (write-path refusals are pinned; boot path is code-walked only). |
| NEW-U-1 | LOW/INFO | Missing-service future degradation = loud boot failure listing the pending service (0.1.2-rc.1 loader audit); self-heals when the service appears. Document in RELEASE.md compatibility notes. |
| NEW-E-1 | LOW | Smoke drivers do not wipe scratch homes; successive runs reuse workspaces/servers, so "fresh install" evidence weakens across runs, and a stale tarball of a pre-fix tree silently passes (proven by sha256 diff of `.smoke/dsh-mcp-scope-0.1.0.tgz` lib/manager.js vs current). Wipe `m0-home`/`m1-home` (or record reuse) in the drivers. |
| NEW-E-2 | INFO | Audit-time concurrency: parallel auditors edited the tree mid-gate (source + tests + workflows + docs); the F1 fix and all B-fixes landed this way. Final snapshot is green, but re-run `npm run check` on the exact commit to be tagged. |
| NEW-C-1 | LOW | `ci.yml` npm cache env is scoped to the setup-node step only, so actions/cache stores a dir npm ci never uses (mechanics MECH-05). Fix: job-level `npm_config_cache`. |

## 8. Prioritized actions

1. **P0 (before tag):** fix README.md:28 install snippet (B-1); resync the
   lockfile engines row (B-4); `rm .smoke/dsh-mcp-scope-0.1.0.tgz`; then
   `npm run check` and `node scripts/release-notes.mjs 0.0.1 --out
   .smoke/release-notes.md` on the tagged commit; confirm the changelog
   section body has no HTML-comment footer (B-6 fix re-verified).
2. **P1 (same release, before the repo goes public):** verify the workflow
   action-pin bumps on a real push (B-3); re-run `npm run test:smoke` on the
   smoke machine and refresh `docs/milestones/M1-raw.log` + M1-live-capture
   evidence (B-2 tail); M1.md stale "no live capture" gap bullet + test-count
   stamps (docs-hygiene S-03).
3. **P2 (first maintenance pass):** NEW-F-1/F-2/U-1/E-1/C-1 + docs-hygiene
   P2 rows (machine-path policy, prereq wording, docs index) + mechanics
   MECH-02 (`mkdir -p .smoke` for pack:tgz), MECH-05, MECH-07 (dead
   `./src/*` export), MECH-08/09.

## Appendix — cross-references

- Sibling reports in this directory: `docs-hygiene.md` (V-01…V-06, S-01…S-03,
  C-01/H-01), `mechanics.md` (MECH-01…09 with appendix evidence incl. clean
  npm-ci runs and pack ENOENT verification), `client-ux.md` (render-probe
  results incl. the prototype-member behavior that became the F1 fix).
- Audit run logs (gitignored, kept for the maintainer): `.smoke/audit-*.log`,
  `.smoke/logs/audit-m1-run.log`, `.smoke/audit-tgz-listing.txt`,
  `.smoke/audit-notes.md`.
- `.smoke/dsh-mcp-scope-0.1.0.tgz` = stale pre-fix artifact (delete);
  `.smoke/dsh-mcp-scope-0.0.1.tgz` = fresh pack of the release content.
