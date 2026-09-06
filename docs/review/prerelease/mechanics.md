# Release-mechanics audit — dsh-mcp-scope v0.0.1 (prerelease)

Auditor: final release-mechanics check, read-only (no repo file was modified; only
gitignored `.smoke/` scratch and `docs/review/prerelease/` were written).
Date of audit: **2026-09-06 UTC** (Node v24.20.0 / npm 11.19.0 from
`.tools/node-v24.20.0-linux-x64`, Ubuntu x64). Working tree audited is the
pre-release state: package.json/CHANGELOG/package-lock bumped 0.1.0 → 0.0.1
(uncommitted), npm publish still commented out in `.github/workflows/release.yml`.

---

## VERDICT

**Not yet release-clean — blocked by one release-blocking finding (MECH-01).**

- **MECH-01 (HIGH):** every action pinned in both workflows runs the **Node 20
  actions runtime**, which GitHub runners no longer execute by default (Node 24
  default since 2026-06-16; opt-out env removed when Node 20 is deleted from
  runners on **2026-09-23**). A real push today fails at the very first action
  step. Fix = bump four pins to their verified Node-24 majors (exact refs below).
- Everything else in the mechanics chain (tag gate, changelog extraction, pack
  artifact, tgz-only release, fresh-runner `npm ci`, docs of what CI does) is
  verified working, with the smaller findings below.
- After MECH-01 (and preferably MECH-03/MECH-04) is fixed, the checklist in the
  last section is expected to succeed end-to-end on a real repo.

---

## 1. Workflow semantics (step-by-step, as the runner executes)

YAML parse: all three files parse cleanly (PyYAML `safe_load`; see appendix).
No templating traps (e.g. `on:` not quoted where needed, `${{` inside literal
blocks — none).

### 1.1 `ci.yml` — check job (matrix `node: ['24']`, ubuntu-latest)

| Step | Verdict | Notes |
|---|---|---|
| checkout@v4 | ❌ MECH-01 | node20 runtime — fails on real runners today |
| setup-node@v4 (24, cache npm) | ❌ MECH-01 + MECH-05 | node20 runtime; npm cache ineffective, see MECH-05 |
| `npm ci --no-audit --no-fund --legacy-peer-deps` | ✅ | proven on clean copy (appendix §A5); flag is genuinely required (plain `npm ci` → ERESOLVE, §A6) |
| typecheck / test / build / verify:package | ✅ | all pass under Node 24 (appendix §A1–A2) |
| upload-artifact@v4 `.smoke/verify/dist/*.tgz`, `if: always()` | ⚠️ | glob guaranteed only when verify:package succeeded — it is the step right before, on the same fresh runner, and `verify-package.mjs` `mkdir -p`s `.smoke/verify/dist` before packing, so on success the file exists. On any earlier failure `always()` makes upload run with no match → upload-artifact@v4 default `if-no-files-found: warn` → harmless warning (MECH-08). Fresh-runner concern: none — the tarball is produced inside the job. |

`fail-fast: false` with a single matrix entry is inert (harmless). Note: the
smoke job (self-hosted, `workflow_dispatch` only) has a real bug — MECH-02.

### 1.2 `release.yml` — release job (tag push `v*`, `permissions: contents: write`)

Trigger: `push.tags: ['v*']` — fires for lightweight **and** annotated tags
(the workflow file is taken from the tagged commit, which is the release commit
itself; no release event, no history needed). `actions/checkout@v4` fetch-depth
1 on the pushed tag ref is sufficient: nothing reads git history; the changelog
is read from the working tree; the release is created for the existing tag via
API (`tag_name` defaults to `github.ref_name` — a tag that was just pushed).
No draft/annotated-tag pitfalls.

Order of steps and guarantees:

1. `npm run check` — full gate; its last element `verify:package` does
   `rm -rf .smoke/verify` then **creates** `.smoke/verify/dist` and packs
   `dsh-mcp-scope-0.0.1.tgz` there. Any failure stops the job → no release.
2. Tag/version sanity — `tag_ver="${GITHUB_REF_NAME#v}"` strips the `v`
   correctly; `node -p "require('./package.json').version"` works on Node 24
   under this `"type": "module"` package (verified: eval input is CommonJS,
   prints `0.0.1`; §A3). Mismatch → `::error::` + exit 1 → job fails.
   `PKG_VERSION` written to `GITHUB_ENV` is visible to all later steps both as
   a shell variable (`"$PKG_VERSION"`, step 5) and as `${{ env.PKG_VERSION }}`
   in `with:` (step 6) — standard, documented behavior.
3. Compose notes — `scripts/release-notes.mjs "$PKG_VERSION" --out
   .smoke/release-notes.md`. **`.smoke` exists at this point** because
   `verify:package` (inside `npm run check`) already created it; if it ever
   did not (step reordering), the script crashes with a raw ENOENT stack trace
   (still fails the job — loud, ugly; MECH-06b).
4. softprops/action-gh-release@v2 — verified against the action's `action.yml`
   at ref `v2`: inputs `name`, `body_path`, `files`, `fail_on_unmatched_files`
   all exist with exactly those names; `files` accepts newline-delimited globs
   resolved from `${{ github.workspace }}` → `.smoke/verify/dist/*.tgz` matches
   exactly the single tarball; `fail_on_unmatched_files: true` turns a miss
   into a hard error. `body_path` file exists (step 3, same job). If it were
   missing, the action falls back to `body` (unset) → an **empty** body, not
   auto-generated notes (`generate_release_notes` defaults false) — but that
   state is unreachable because step 3 exits 1 on any notes problem.
   Release **name** input = `dsh-mcp-scope v0.0.1`. Needs `contents: write` —
   declared at workflow level; GITHUB_TOKEN is used by default. Runtime is
   node20 → **MECH-01**.
5. Attach artifact — uploads the same tgz as a workflow artifact. Fine.

`permissions: contents: write` is the only permission needed in tgz-only mode;
no secrets. The commented-out npm step is correctly inert, and its header
recipe (`NPM_TOKEN` + `id-token: write`) is accurate for re-enabling.

### 1.3 Version/tag consistency machinery

- package.json `0.0.1` ↔ tag `v0.0.1` (strip `v` → `0.0.1`) — consistent.
- `release-notes.mjs 0.0.1` runs and prints the section (exit 0; §A4). Fail
  modes verified/read: missing version section → exit 1 with actionable error;
  empty body → exit 1; missing date → exit 1. Date requirement is presence-only
  (no ISO-format validation) — acceptable.
- Extraction logic: section keyed `## [<version>] - <date>` (or `## <version>`);
  headings of level > 2 (`### Added`, …) are kept and never terminate capture —
  correct. Capture ends at the next heading of level ≤ 2. **Edge case:** a
  line starting `## ` inside a code fence would terminate the section early —
  the script has no fence awareness. Current CHANGELOG contains no fenced block
  and no `## ` line inside the 0.0.1 section, so today it is safe; note for
  future changelog edits (MECH-06a).
- **Trailing comment leak (MECH-06):** the footer `<!-- … -->` block at
  CHANGELOG.md lines 90–95 sits *after* the 0.0.1 section and before EOF, so
  the generated notes body includes it. GitHub renders HTML comments hidden,
  so users never see it, but it ships in the release body (with a stale
  `v0.0.0...v0.1.0` compare-link template inside).

## 2. npm/registry interplay while publish is disabled

- `publishConfig.access: public`, `prepack: node scripts/build.mjs`,
  `files: [lib, cordis.patch.yml]` — none of these interfere with the disabled
  publish. `prepack` fires on every `npm pack`, which is exactly what
  verify/pack/asset steps want: the tarball always embeds a fresh build.
- **No recursion:** `build.mjs` spawns only `node …/tsc` and uses the esbuild
  JS API — it never invokes npm; traced the full chain
  `npm pack → prepack → build.mjs → tsc/esbuild` (no npm child). `npm ci` does
  not run the root `prepack`.
- Cost note: the release job builds 3× (check's build, prepack inside
  verify:package's `npm pack`, determinism rebuild). Slow but harmless.
- Version field vs lockfile: package.json `0.0.1` ↔ lockfile top-level
  `version: 0.0.1` — but lockfile `packages[""].version` is still **0.1.0**
  (MECH-03). npm ci does not compare these (proven — clean-tree install
  passed); the packed artifact's inner package.json correctly says 0.0.1
  (pack reads package.json, not the lock).

## 3. CI resilience (Node 24)

- Local gate + clean-copy gate both pass: typecheck (src+tests), 133 vitest
  tests, build, verify:package incl. consumer d.ts typecheck and the
  determinism second-build — identical output (`verify:package PASS`).
- Fresh-runner install proven: full `npm ci --no-audit --no-fund
  --legacy-peer-deps` on a pristine copy of the tree (no node_modules) with
  npm 11.19.0: exit 0, `added 337 packages`, then full `npm run check` exit 0.
  Lockfile is v3, committed, consistent w.r.t. dependency specifiers
  (`packages[""]` name/version skew aside, MECH-03).
- Install scripts in the dev tree: only **esbuild** has one —
  `esbuild@0.25.12` (direct devDep) and a nested `esbuild@0.28.2`
  (vitest → vite). npm 11 emits `npm warn install-scripts … not yet covered by
  allowScripts` for both, **but still runs them** (verified: the installed
  `bin/esbuild` is the native ELF, while the published tarball ships a JS
  shim → `install.js` executed). It needs no network (platform binary comes
  from the `@esbuild/linux-x64` optional dependency). Forward note: npm 12
  (already released; npm notices advertise 12.0.2) may block unapproved
  install scripts — if a future toolchain bump starts failing around esbuild,
  approve it (`npm install-scripts approve esbuild` / allow-scripts config).
  Only the dev/test tree is affected; runtime deps (`@modelcontextprotocol/sdk`,
  `@deepseek-ai/schemastery`, `zod`) have no install scripts, and consumer
  installs go through pnpm anyway.
- engines `node >=24.0.0` + `.nvmrc` 24 + matrix `['24']` agree.

## 4. Artifact hygiene

- `npm pack --dry-run --json`: filename `dsh-mcp-scope-0.0.1.tgz`, 30 entries,
  61,566 bytes — byte-identical name/size to the real pack produced by
  verify:package (listing in appendix §A7).
- Exact contents (all under the npm-tarball `package/` root): `lib/*.js`
  (9 files), `lib/types/**` (15 `.d.ts`), `cordis.patch.yml`, `LICENSE`,
  `README.md`, `package.json` (name `dsh-mcp-scope`, version `0.0.1`). No
  `src/`, `tests/`, `docs/`, `.smoke/`, `scripts/`, `node_modules/` — the
  verify whitelist enforces this and it passed. Notably `lib/` is packed even
  though `.gitignore` lists it: the `files` whitelist wins over gitignore
  (empirically confirmed) — no `lib`-stripping hazard.
- Layout: identical to registry tarballs — npm publishes exactly the `npm
  pack` output, so the `package/` root convention is the registry convention.
  pnpm (which `dsh plugin add` drives) fetches/extracts npm-style tarballs and
  renames `package/` into `node_modules/<name>`; GitHub Release assets are
  served as opaque octet-stream downloads of this same tgz → **no stripping or
  repack needed** before handing the URL to `dsh plugin add`. The repo's own
  consumer typecheck additionally proves the tgz extracts and resolves both
  entry points.
- Asset URL will be
  `https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz`.

## 5. Docs vs mechanics

| Doc claim | Reality |
|---|---|
| RELEASE.md §CI: runs on Node **22 and 24** | ❌ matrix is single Node **24** only (MECH-04) |
| RELEASE.md §release: local gate `npm ci && npm run check` | ❌ plain `npm ci` **fails** (ERESOLVE: dsh-client-runtime 0.1.1-rc.2 vs dsh-agent 0.1.2-rc.1); must be `npm ci --legacy-peer-deps` (MECH-04) |
| RELEASE.md + release.yml header: release example `v0.2.0` / `## [0.2.0] - 2026-09-20` / commit `release: v0.2.0` | ⚠️ first release is v0.0.1 — copy-paste hazard (MECH-04) |
| README: `add file:./dsh-mcp-scope-0.1.0.tgz` | ⚠️ stale example version (0.0.1) (MECH-04) |
| RELEASE.md workflow description (gate → notes → release + asset, npm disabled) | ✅ accurate incl. "no secrets required" |
| README/CI Node-24 statements, 133-test count, `pack:tgz` purpose | ✅ accurate |
| CHANGELOG `Unreleased` vs `[0.0.1]` | ⚠️ the "GitHub Release publishing" bullet under `[Unreleased]` describes machinery that ships in 0.0.1 and is therefore also described under 0.0.1/Added; left as-is it will ride along into the next release's notes (MECH-10) |

## 6. Findings

| ID | Sev | Finding | Fix |
|---|---|---|---|
| MECH-01 | **HIGH** | All pinned actions run the Node 20 runtime: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` (both workflows) and `softprops/action-gh-release@v2` (release). Verified `runs.using: node20` in each `action.yml` at the pinned ref. GitHub runners default to Node 24 since 2026-06-16 (node20 requires opt-out `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true`) and **remove Node 20 on 2026-09-23** (changelog 2025-09-19 + 2026-08-25 editor note). A real run today fails at step 1 of every job. | Bump to Node-24 majors (runtime verified by reading each action.yml): `actions/checkout@v5` (v6/v7 exist), `actions/setup-node@v5` (v6/v7 exist), `actions/upload-artifact@v6` (**v5 is still node20**; v7 exists), `softprops/action-gh-release@v3`. Stopgap only until 2026-09-23: job-level `env: { ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION: true }`. Dependabot's github-actions monthly updates will then keep these current. |
| MECH-02 | MED | ci.yml smoke job (fresh self-hosted workspace) runs `npm run pack:tgz` = `npm pack --pack-destination .smoke/`; npm **does not create** a missing pack destination (verified ENOENT) and nothing in that job creates `.smoke/` → the step fails on a real run. Local dev only works because `.smoke/` already exists from earlier runs. | `mkdir -p .smoke` before packing (in the job or inside `pack:tgz`); mention in RELEASE.md §smoke. |
| MECH-03 | MED | package-lock.json internal skew: top-level `version: 0.0.1` but `packages[""].version: 0.1.0` (lines 3 vs 9). Will be committed in this state unless resynced. `npm ci` tolerates it (proven), and the packed artifact is unaffected, but consumers of the lockfile (`npm ci` on old npm, lockfile-reading tooling, dependabot) can see 0.1.0. | Before committing: `npm install --package-lock-only --legacy-peer-deps` (verified to rewrite `packages[""].version` → 0.0.1), then re-run the local gate. |
| MECH-04 | MED | Docs vs mechanics: RELEASE.md "Node 22 and 24" claim; RELEASE.md local-gate command missing `--legacy-peer-deps` (would ERESOLVE); v0.2.0/2026-09-20 examples in RELEASE.md + release.yml header comment; README `dsh-mcp-scope-0.1.0.tgz` example. | Update to Node 24 / v0.0.1 / 2026-09-06 and add the flag. |
| MECH-05 | LOW | ci.yml npm cache is ineffective: `npm_config_cache: ${{ runner.temp }}/npm-cache` is set only as env of the setup-node step; setup-node computes the cache path with `npm config get cache` **inside that step** (verified in setup-node v4 source) → actions/cache saves/restores `runner.temp/npm-cache`, but the later `npm ci` step (no env) uses the default `~/.npm` → cache never hits; every run downloads all packages and the save step archives an untouched dir. (release.yml has no such env and is fine.) | Hoist `npm_config_cache` to the job level (or drop it so setup-node caches the default `~/.npm` that npm ci actually uses). |
| MECH-06 | LOW | (a) release-notes.mjs is fence-unaware: a `## `-line inside a future code fence would truncate the notes; (b) the composed 0.0.1 body includes the CHANGELOG footer HTML comment (capture runs to EOF) — hidden in the GitHub UI but shipped; (c) `--out` into a nonexistent dir crashes with a raw ENOENT (only reachable if `.smoke` is gone — currently guaranteed by verify:package). | Stop capture at `<!--`/EOF footer; move the footer comment above the first section; add `mkdir` for the out dir (defensive). |
| MECH-07 | LOW | `exports` advertises `"./src/*"` but `src/` is deliberately never packed (files whitelist + verify ban) → dead subpath export; `dsh-mcp-scope/src/*` resolves to a missing file for consumers. `./cordis.patch.yml` export is fine (file is shipped). | Drop the export or ship `src` — decide intent. |
| MECH-08 | NIT | ci.yml upload step `if: always()` uploads nothing with only a warning when any earlier step failed (upload-artifact@v4 default `if-no-files-found: warn`); `fail-fast` single-matrix entry also inert. | Prefer no `always()` or `if-no-files-found: error` so failed gates surface upload failure instead of noise. |
| MECH-09 | NIT | npm 11 prints `install-scripts` allowScripts warnings for both esbuild copies on every fresh install (warn-only today; npm 12 may deny unapproved scripts). Also cosmetic `npm notice … npm 12.0.2 available`. | No action now; if a future npm on CI starts refusing esbuild's postinstall, approve it explicitly. |
| MECH-10 | NIT | `[Unreleased]` retains the "GitHub Release publishing" bullet although that machinery ships in 0.0.1 (duplicated under 0.0.1/Added) — it will leak into the *next* release's notes. | Move/delete the bullet as part of the release commit. |

## 7. Exact commands the maintainer should run to publish v0.0.1

Working from a real clone (writable HOME; no sandbox npm workarounds needed),
default branch `main`:

```sh
# 0. (prerelease fixes, this audit)
#    MECH-01: bump the four action pins in .github/workflows/{ci.yml,release.yml}
#             (checkout@v5, setup-node@v5, upload-artifact@v6,
#             softprops/action-gh-release@v3) and push those commits first —
#             verify at least one CI run is green BEFORE tagging.
#    MECH-03: npm install --package-lock-only --legacy-peer-deps   # resyncs 0.0.1
#             git diff --stat package-lock.json                    # small, version-only
#    MECH-04/MECH-10: fix RELEASE.md/README examples + Unreleased bullet.
#    Commit all of the above (the 0.0.1 changelog section, package.json,
#    lockfile and docs must ride the SAME commit as the tag).

# 1. local release gate (must end "verify:package PASS")
npm ci --no-audit --no-fund --legacy-peer-deps
npm run check

# 2. (recommended) live smoke on the smoke machine
mkdir -p .smoke
npm run build && npm run pack:tgz && npm run test:smoke   # M1 + M0 PASS

# 3. commit + tag + push (lightweight tag is fine; workflow file ships in this commit)
git add -A
git commit -m "release: v0.0.1"
git tag v0.0.1
git push origin main
git push origin v0.0.1        # triggers release.yml

# 4. verify the run on github.com/<owner>/dsh-mcp-scope/actions
#    expected: check green → Tag/version sanity ok → "release notes for 0.0.1
#    written" → GitHub Release "dsh-mcp-scope v0.0.1" created (published, not
#    draft) with the changelog notes as body and asset
#    dsh-mcp-scope-0.0.1.tgz attached → workflow artifact uploaded.

# 5. verify the shipped asset == the locally verified tarball
curl -fL -o /tmp/v.tgz \
  https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz
sha256sum /tmp/v.tgz .smoke/verify/dist/dsh-mcp-scope-0.0.1.tgz   # identical

# 6. (once) consumer install from the asset URL in a scratch profile
dsh plugin --profile web add \
  https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz
#    expected: pnpm installs dsh-mcp-scope, Settings gains "MCP servers" after
#    an instance restart (documented first-boot client-scan race).
```

Expected failure modes after the fixes: tag pushed without the matching
committed changelog section → job stops at notes compose (intended); version
mismatch → job stops at sanity (intended); asset missing → gh-release hard
fails via `fail_on_unmatched_files` (intended).

---

## Post-audit note (workspace concurrency, 2026-09-06 ~03:00 UTC)

While this audit was running, a **concurrent change by another auditor** landed
in the shared workspace (`src/client/controller.ts`, `src/shared/model.ts` —
"own-property semantics (pre-release F1)" hardening, mtime 02:57:51 UTC). It is
**not** part of this release-mechanics audit and was not made by it. A final
gate re-run on the tree *after* that edit failed at
`tsc -p tsconfig.tests.json --noEmit` with TS2322 (`Type 'boolean' is not
assignable to type 'true'` at `tests/host/model.spec.ts:162,164,165,167` — the
F1 expectations vs the new `isEnabled` return typing). All PASS evidence above
was collected before 02:57 on the then-current tree, plus on a clean copy at
~02:40. Consequence for the release: **re-run the §7 checklist gate on the
final merged tree before tagging** — the mechanics conclusions in this report
are unaffected by that source-level change.

## Appendix — evidence (commands run + results)

- **A1** `npm run check` (local, Node 24.20/npm 11.19): exit 0 — typecheck ok,
  `Tests 133 passed`, build ok, `packed: dsh-mcp-scope-0.0.1.tgz`, `tarball
  contents OK (30 entries)`, `consumer typecheck OK (host + ./client entry
  types)`, `determinism OK`, `verify:package PASS`.
- **A2** Clean-tree simulation (copy of repo w/o node_modules, same flags as
  CI, writable npm cache): `npm ci --no-audit --no-fund --legacy-peer-deps`
  exit 0 (`added 337 packages`), then `npm run check` exit 0 with the same
  PASS lines. (Sandbox note: this machine's `/root/.npm` is read-only, so npm
  commands were run with `npm_config_cache` redirected — runner HOMEs are
  writable, no repo impact.)
- **A3** `node -p "require('./package.json').version"` in the repo (type:
  module, Node 24) → prints `0.0.1`, exit 0 (the exact release.yml sanity
  expression).
- **A4** `node scripts/release-notes.mjs 0.0.1` → exit 0, prints the full
  dated section **plus the trailing `<!-- … -->` footer** (MECH-06).
  `… 9.9.9` → exit 1 `CHANGELOG.md has no "## [9.9.9]" section`;
  `--out /nonexistent-dir/x.md` → ENOENT crash (exit 1).
- **A5** `npm ci` without `--legacy-peer-deps` (clean copy) → exit 1,
  `ERESOLVE could not resolve … @deepseek-ai/dsh-client-runtime@0.1.1-rc.2 …
  Found: @deepseek-ai/dsh-agent@0.1.2-rc.1` — the flag in CI is required.
- **A6** esbuild install-script behavior under npm 11.19: `npm warn
  install-scripts … esbuild@0.25.12 … esbuild@0.28.2 … not yet covered by
  allowScripts` (warn-only); published tarball's `bin/esbuild` is a JS shim
  while the installed file is the native ELF → postinstall ran; build passes
  because the platform binary ships via the `@esbuild/linux-x64` optional dep
  (0.25.12 top-level for the build; 0.28.2 nested under vitest→vite).
- **A7** `npm pack --dry-run --json` → `dsh-mcp-scope-0.0.1.tgz`, 30 files,
  61,566 bytes; full `tar -tzf` listing = the 30 `package/**` entries listed
  in §4; inner `package/package.json` = name dsh-mcp-scope, version 0.0.1.
- **A8** Action runtimes (from each repo's `action.yml` at the pinned/latest
  refs, fetched 2026-09-06): checkout v4→`node20`, v5/v6/v7→`node24`;
  setup-node v4→`node20`, v5/v6/v7→`node24`; upload-artifact v4→`node20`,
  v5→`node20`, v6/v7→`node24`; softprops/action-gh-release v2 (v2.6.2,
  final v2)→`node20`, v3→`node24` (v3.0.3 current). Input names
  `name/body_path/files/fail_on_unmatched_files` confirmed present in the v2
  action.yml; v2 README: body_path read first, fallback to body, no
  auto-generated notes unless `generate_release_notes: true`.
- **A9** Runner policy: github.blog/changelog/2025-09-19-deprecation-of-node-20
  -on-github-actions-runners (editor note 2026-08-25): Node 24 default since
  2026-06-16, opt-out env `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true`,
  Node 20 removed from runners 2026-09-23.
- **A10** setup-node v4 `src/cache-utils.ts`: npm cache path =
  `npm config get cache` executed inside the action step → honors the step's
  `npm_config_cache` env (basis of MECH-05).
- **A11** `npm pack --pack-destination <missing dir>` → `npm error enoent`
  (npm does not create the destination; basis of MECH-02).
- **A12** `npm install --package-lock-only --legacy-peer-deps` on a copy with
  the skewed lockfile → rewrote `packages[""].version` 0.1.0 → 0.0.1 (basis of
  MECH-03 fix).
