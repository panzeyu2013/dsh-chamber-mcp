# Compliance review — CI / release / repository conventions

Auditor output for `dsh-mcp-scope` v0.0.1 (first release, GitHub-Release tgz asset,
npm publish disabled, Node 24), compared against its reference ecosystems:

- **Primary reference**: `dsh-chamber` (`.github/workflows/{ci,release,stale,triage}.yml`,
  `scripts/verify-workflow-action-pins.mjs`, root `package.json`, `CHANGELOG.md`,
  `docs/checklists/release-checklist.md`, `.github/` repo files).
- **Secondary reference**: the dsh upstream monorepo `deepseek-harness` — identical to
  `dsh-chamber/ref-dsh` (symlink, verified). Files studied: `.github/workflows/{ci,release,
  expected-filenames}.yml`, `.github/dependabot.yml`, `package.json`,
  `scripts/run-gates.ts`, `vitest.config.ts`, `scripts/release/{verify,publish}.ts`,
  `pnpm-workspace.yaml`, `docs/user/develop/basic/publish.md`, repo hygiene files.

All line citations were read from the actual files on disk at review time.

## Verdict

`dsh-mcp-scope` is **close to conformant on the core release-safety contract** — a single
tag-driven job that re-runs the entire validation chain *before* any GitHub-Release mutation,
with tag==version assertion, changelog-composed release notes, a package-content whitelist gate
with determinism check, and npm publishing disabled by explicit maintainer choice. The gaps
against the primary reference (chamber) are concentrated in **three cheap, high-value areas**:
(1) actions are pinned to moving v-major tags with **no sha-pin verification** — chamber's most
emphasized release-hardening norm (`scripts/verify-workflow-action-pins.mjs` + a CI step), whose
absence chamber documents as a real failure mode (a one-character SHA typo failing every tag
release); (2) **tag pushes do not run `ci.yml`** (chamber runs push-main + tags-v* + PR on the
same chain); (3) the release job has **no concurrency serialization** and **no stale-release
guard**, both of which chamber learned the hard way (v0.1.2 postmortem: softprops *updates* an
existing release and discards the fresh draft/body). Smaller findings: the self-hosted smoke job
is dead config (guarded by `workflow_dispatch` but `ci.yml` has no such trigger), no
lockfile-not-rewritten assert (less critical under `npm ci`, which is inherently frozen), no
`repository` field, no PR/issue templates, and `contents: write` at workflow scope instead of
per-job. Upstream-level gates (per-file 100 % coverage, knip/publint/constraints, doc-sync
catalog gates, i18n doc pairs) are monorepo scale and **not proportionate** for a single npm
package; chamber itself does not run most of them. Everything else — changelog format with a
`## [Unreleased]` header, Keep a Changelog release-body extraction, engines/`files`/LICENSE
attribution hygiene, `--legacy-peer-deps` necessity (documented), dependabot — conforms.

## Norm-by-norm matrix

Status: CONFORMS / PARTIAL / MISSING / DIVERGES-BY-DESIGN. Effort: S (< 0.5 day), M (≤ 2 days), L (> 2 days).

| # | Norm | Reference (repo:file:line) | What the reference requires | Our status + evidence | Recommendation (effort) |
|---|------|---------------------------|-----------------------------|----------------------|------------------------|
| (a) | Workflow triggers: push main + tags `v*` run the **same** validation chain; PR runs it too | chamber `.github/workflows/ci.yml:3-12` — `push: branches [main]`, `push: tags ['v*']`, `pull_request` all on the one `test` job; comment ci.yml:6-11 explains tag pushes must run the same chain and release.yml keeps a *release-local* gate because tag-triggered workflows run in parallel. Harness (weaker): ci.yml:3-7 is push-master + PR only; tags are not CI-gated (full primary aggregate runs on master push, serial-linux-selfhosted ci.yml:574-618). | Every merge-relevant event validates the identical scripted chain; a tag can never publish an untested commit. | **PARTIAL.** scope ci.yml:3-6 runs push main+master + PR → full `check` job (ci.yml:34-51: typecheck→test→build→verify:package). Tags trigger only release.yml, which *re-runs the full chain inline* (release.yml:49-50 `npm run check`) before mutation — the guarantee holds (validation-before-mutation) and mirrors chamber's "release must validate itself" rationale, but `ci.yml` itself is never exercised on a tag, and the chain exists in two places that can drift. Harness-upstream parity alone would be CONFORMS (they don't gate tags at all); chamber letter-parity requires the tag trigger. | **MUST, S.** Add `tags: ['v*']` under `push` in `ci.yml` with chamber-style comment (why: same chain + parallel release self-gate). Accept the duplicate run per release (chamber does). |
| (b) | Validation-chain completeness | chamber ci.yml:32-33 (pin verify), 55-61 (5 typecheck groups), 62-63 (verify:i18n), 64-67 (action-SHA upstream resolution `--actions-only`), 68-69 (`test:release-workflow` policy tests), 70-111 (unit suites + smoke), 112-132 (renderer/host/desktop sub-builds + notices), 133-139 (gateway `pack` → temp-install → `--help` runtime smoke); packaging deliberately excluded from push path with rationale ci.yml:15-21. Harness: PR lanes run `check:ci:static` (ci.yml:110-113 → run-gates.ts:354-372: constraints, licenses, package-invariants, doc-sync leaves, module-graph, **knip**), `check:ci:coverage` (ci.yml:175-176 → vitest `--coverage`, per-file 100 % thresholds vitest.config.ts:269-279), `check:ci:consumers` (ci.yml:256-257 → run-gates.ts:387-411: build, publint, lint+duplication, snapshots, built-bin smoke); full aggregate incl. typecheck on master (serial-linux-selfhosted ci.yml:609-618). | CI runs the whole typed/tested/buildable/packageable surface, plus a hygiene tail. Which upstream gates are proportionate for a *single npm package*: typecheck, unit tests, build, pack-content/consumer verification (all present); lint/unused-export (knip), publint, coverage thresholds and doc-sync catalogs are **monorepo/upstream scale — chamber itself runs none of them**. | **CONFORMS** on the package-core chain (typecheck src+tests package.json:31; 133 vitest tests; build; verify-package whitelist+consumer-d.ts+determinism scripts/verify-package.mjs:37-93) — scope is actually *stronger* than chamber on artifact verification (chamber does not assert tarball contents/determinism). **PARTIAL** on hygiene tail: (i) no action-pin gate (see c); (ii) built `lib/` output is never *executed* in CI (tests import `src/`; verify-package typechecks but does not import the packed/lib entry — chamber's analog runs the installed binary, release.yml:371-376); (iii) smoke exists but its trigger is dead (see below); (iv) no coverage threshold — acceptable (chamber has none; harness's 100 % per-file is a monorepo norm, vitest.config.ts:269-271). | **MUST** (c-gate). **SHOULD, S**: import `lib/index.js` under plain Node in verify-package (a `--help`-equivalent for an ESM plugin: dynamic `import()` of the built entry with peers resolving from repo `node_modules`). Fix dead smoke trigger: `ci.yml` has no `workflow_dispatch` in `on:` (ci.yml:3-6) yet the smoke job is gated `if: github.event_name == 'workflow_dispatch'` (ci.yml:60) — add the trigger or delete the job. Coverage/publint/knip: OPTIONAL, not proportionate now (see adoption list). |
| (c) | Action pinning: full-commit SHA + `# vX.Y.Z` comment + automated offline verify + shared pins across ci/release | chamber workflow files: every `uses:` is `<owner>/<action>@<40-hex> # vX.Y.Z`, e.g. ci.yml:25 (`actions/checkout@11bd7190… # v4.2.2`), ci.yml:34 (`pnpm/action-setup@fe02b34f… # v4.1.0`), ci.yml:37, release.yml:84/248/274/282/285/349/358/361/412/421/424/523/532/535. Verify script `scripts/verify-workflow-action-pins.mjs`: 39 (every external action ref must be 40-hex — catches *new* actions too), 45-48 (one SHA per action across all workflows), 50-57 (checkout/pnpm/setup-node must be pinned in both ci.yml and release.yml), 59-65 (release.yml must carry `concurrency.group: release-publish` + `cancel-in-progress: false`), 67-76 (create-release waits on validation; draft creation skipped on dry-run). Wired as first step of both ci.yml:32-33 and release.yml:280-281, and via `pnpm run verify:workflows` (package.json:38). Network half: ci.yml:64-67 resolves every SHA upstream (`release-preflight --actions-only`); release checklist:48-49. Upstream harness DIVERGES: moving majors (`checkout@v6`, `setup-node@v6`, `pnpm/action-setup@v4`, ci.yml:75/80/84, release.yml:41/46/50) — chamber's sha discipline is the local hardened norm, and the one this repo's smoke/anchor infrastructure already depends on. | All external actions immutable; one consistent pin per action; the guarantee is *enforced by CI*, not by convention; release structural invariants are machine-checked. | **MISSING.** scope ci.yml:19/22/47 and release.yml:34/37/76/84 use `checkout@v5`, `setup-node@v5`, `upload-artifact@v6`, `softprops/action-gh-release@v3` — moving tags, no comments, no verify script, no CI step. A supply-chain regression or silent action update changes CI behavior without review. | **MUST, M.** Port `scripts/verify-workflow-action-pins.mjs` (~70 lines, dependency-free; keep the format/drift/presence asserts; adapt the release-policy asserts to our single-job shape: concurrency group + mutation steps must come after the gate step), add `node scripts/verify-workflow-action-pins.mjs` as step 1 in both workflows (no install needed), and in the same change re-pin all four actions to full SHAs with `# vX.Y.Z` comments (resolve via `git ls-remote https://github.com/<owner>/<action>.git 'refs/tags/v*'`; pick the current v-major's newest tag commit, e.g. checkout v5.latest — the verify script will fail until this is done, which is the point). |
| (d) | Lockfile determinism: frozen install + assert the lockfile was not rewritten | chamber ci.yml:48 (`pnpm install --frozen-lockfile`), ci.yml:53-54 (`git diff --exit-code -- pnpm-lock.yaml`, rationale 49-52: pnpm 11 prunes importer records, so a non-frozen install must never silently rewrite the lockfile); same pair in every release job (release.yml:291-293, 368-370, 430-432, 541-543); harness: `pnpm install --frozen-lockfile` in every job (ci.yml:108 etc.). | The committed lockfile is the deterministic contract; installs are immutable; a rewritten lockfile fails the run. | **CONFORMS** on frozenness by construction: every install is `npm ci` (ci.yml:32, release.yml:47, ci.yml:75; docs/RELEASE.md:47), and `npm ci` is inherently frozen — it errors when package.json and package-lock.json disagree and never writes the lockfile (stronger than pnpm's frozen mode, which drift-checks only via the diff assert). package-lock.json is committed. **PARTIAL**: no equivalent of the diff assert, so a future step that slips to bare `npm install` (which silently rewrites) would go undetected. | **MUST, S.** Add a post-install step to both workflows: `git diff --exit-code -- package-lock.json` with the chamber rationale comment. (For npm the assert is near-vacuous today; it is insurance + makes the invariant visible.) OPTIONAL: have the pin-verify script assert install steps use `npm ci` and never bare `npm install`. |
| (e) | Package-manager pinning & peer relaxation policy | chamber: `"packageManager": "pnpm@11.21.0"` (package.json:6) + `pnpm/action-setup` with explicit `version: 11.21.0` (ci.yml:34-36); no npm anywhere, no peer relaxation — peers are exact-pinned per package. Harness: `"packageManager": "pnpm@11.7.0"` (package.json:7), action-setup@v4 without version (ci.yml:80). Peer handling in harness: packages declare the vendored framework as peers (release.yml:83-89); the ONLY relaxation is a scoped `peerDependencyRules.allowedVersions: typescript '>=5 <7'` (pnpm-workspace.yaml:31-33) — never blanket `--legacy-peer-deps`; and a constraint that cordis peer/dev ranges must match exactly (scripts/check-workspace-constraints.ts:301-307). | Toolchain pinned to an exact PM version; peer conflicts resolved by narrowing ranges or scoped rules, never by blanket legacy mode. | **PARTIAL + DIVERGES-BY-DESIGN.** Divergence is real: `npm ci --legacy-peer-deps` (ci.yml:32 etc.) blanket-relaxes peers, which neither reference does. But the necessity is genuine and well documented (devDep matrix spans dsh version lines whose peer ranges conflict — dsh-client-runtime 0.1.1-rc.2 vs 0.1.2-rc.1 peers; ci.yml:28-31 comment, docs/RELEASE.md:47) — this is an artifact of pinning a cross-line dev matrix in npm, where pnpm's scoped-rule equivalent does not exist. Runtime consumers are unaffected (peers resolve from the dsh install; docs/RELEASE.md:76-78). Missing: no `packageManager` field; npm version floats with the Node 24 image (setup-node node-version '24'). | **SHOULD, S**: add `"packageManager": "npm@<version npm 24.x ships>"` (informational under npm but records intent; update on bumps). **OPTIONAL, L**: when the dev matrix settles on one dsh line, drop `--legacy-peer-deps` from all three call sites + `.nvmrc` docs and centralize via `.npmrc` if the flag must stay. Keep the divergence documented either way. |
| (f) | Release process norms | chamber release.yml: **validation-before-mutation** (create-release `needs: validation`, :72, and script-asserted at verify-workflow-action-pins.mjs:67-71), **serialization** (`concurrency.group: release-publish`, `cancel-in-progress: false`, :60-62, script-asserted :61-65), **version gate** (semver canonical-only + preflight `--versions-only` asserting tag version == every package version, :90-159), **changelog body extraction with hard fail** (:161-181), **refuse published rerun / delete only stale drafts** (:197-242 — 2026-08 postmortem: softprops finds an existing release by tag and *updates* it, discarding the fresh draft's body), **draft → per-asset build+verify → finalize flip** (:245-264, :477-509, :560-587, :589-648), **per-asset verification**: gateway ships `.tgz` + `.tgz.sha256` (:371-395; release-checklist.md:133), **dry-run mode** for infra changes (:43-52, 209, 244-247; checklist:116-121), tag==commit binding (:112-143). Harness release.yml: pack **proves on every PR/push** (:10-13), publish is a separate manual `workflow_dispatch` job guarded by an **environment with required reviewers + allowed tags** (:109-121), tag/version family assertion (release:verify, :72-75; scripts/release/verify.ts), publishes **exactly the packed bytes** (artifact download, :141-149), integrity-idempotent publish (scripts/release/publish.ts — registry state decides; identical tarball skips, differing tarball fails). Upstream provenance: none observed — scripts/release/*.ts and workflows carry no `--provenance`/`id-token`; both references publish via `NODE_AUTH_TOKEN`. | Release = tested bytes only; concurrent or repeated runs must not corrupt shared release state; every published artifact is verified at upload time; publication is the least-privileged, most-deliberate step. | **CONFORMS**: single job gates fully before mutation (release.yml:49-50 precede :75-86); tag==version (release.yml:52-61); changelog body with fail-on-missing/empty/undated (release.yml:63-64; scripts/release-notes.mjs:58-71); `fail_on_unmatched_files: true` (release.yml:81) prevents an empty release; npm publish disabled by explicit maintainer choice with a re-enable recipe (release.yml:5-13, 66-73; docs/RELEASE.md:30-36). **PARTIAL**: no `concurrency` group (double tag-push race); no refuse-existing-published-release guard — a manual re-run after a successful release makes softprops *find and update* the published release (chamber postmortem, release.yml:198-206) instead of failing; no draft→finalize split (fine for one asset, but the above guard is the substitute chamber chose even with drafts); no sha256 sidecar for the tgz (chamber ships `.tgz.sha256` for its tarball asset, release.yml:377-384, checklist:133); no dry-run dispatch (chamber demands one dry run whenever release infra changed, checklist:24-26/116-121 — exactly the situation the c/d/f adoptions create); artifact upload lacks `if-no-files-found: error` (release.yml:83-86); workflow-scope `permissions: contents: write` (release.yml:26-27) instead of chamber's top-level read + per-job write (release.yml:54-55, 74-75). | **MUST, S-M**: add `concurrency: {group: release-publish, cancel-in-progress: false}` (and assert it in the new verify script); add pre-mutation guard "published release exists for v<tag> → fail closed; only delete stale drafts" (gh api listing, ~15 lines, port of release.yml:197-242); add `if-no-files-found: error` to the artifact upload. **SHOULD, S**: sha256 sidecar uploaded next to the tgz; **SHOULD, M**: `workflow_dispatch` dry-run inputs (version + dry_run) mirroring chamber — releases that touch workflows must be dry-run-verified once before the formal tag; **SHOULD, S**: top-level `permissions: contents: read` + job-level `contents: write`. Draft→finalize split: OPTIONAL/not proportionate for a single asset (documented as deliberate). |
| (g) | Changelog norms | chamber CHANGELOG.md:1-15: Keep a Changelog format + SemVer statement, **`## [Unreleased]` header kept at top** (:13), dated sections `## [0.2.0-beta.4] - 2026-08-30` (:15), grouped headings; the release body is the matching `## [<version>]` section extracted with hard fail (release.yml:161-181); bilingual pair + `verify:i18n` gate (ci.yml:62-63; checklist:51-59). Harness: no root changelog (per-family release machinery; scripts/release/bump.ts family model). | A user-facing changelog in Keep-a-Changelog shape with a live `[Unreleased]` bucket; release notes come from the repo file, never GitHub's auto-generated list; missing section fails the release. | **CONFORMS.** scope CHANGELOG.md:1-6 (Keep a Changelog + SemVer links), :8 `## [Unreleased]` header, :10 dated `## [0.0.1] - 2026-09-06`, grouped Added/Changed/Fixed/Security; release body composed from the exact section with fail-on-missing/empty/undated (scripts/release-notes.mjs:58-71). Release notes even carry the date header — stricter than chamber's awk extraction. English-only repo: chamber's bilingual doc-pair + i18n gate is not applicable (DIVERGES-BY-DESIGN; in-app zh/en locales live in src/client/locales.ts and are covered by tests, not doc gates). | No change required. OPTIONAL: once the repo is public, add version comparison links at the footer (template already reserved in CHANGELOG.md:88-92). |
| (h) | Repo hygiene: CODEOWNERS, issue/PR templates, stale/triage bots, expected-filenames, dependabot cadence, LICENSE, package metadata | chamber: `.github/CODEOWNERS:1-2` (single-maintainer placeholder), `.github/PULL_REQUEST_TEMPLATE.md` (structured bilingual: Intent / Non-goals / Affected surfaces / Repository guidance / Validation / Risks), ISSUE_TEMPLATE bug_report.yml + feature_request.yml + config.yml, stale.yml:15-21 (`actions/stale@sha # v9.1.0`, 60 d stale / 14 d close, enhancement exempt), triage.yml:14-28 (auto-label bug/enhancement from issue body); updates via Renovate (renovate.json, devDeps grouped monthly-ish) — no dependabot. Harness: dependabot.yml:3-41 (npm + uv + github-actions, daily 04:00 Asia/Shanghai, 30-day cooldown, kind/dependency labels); expected-filenames.yml (PR gate forbidding "golden" filenames → scripts/check-expected-filenames.sh); 5 issue templates + pull_request_template.md; no CODEOWNERS; CONTRIBUTING.md:11-12 ("cannot accept external pull requests at the moment"). License/attribution: harness root LICENSE; scope LICENSE:1-8 = MIT with explicit upstream attribution for mirrored `@deepseek-ai/dsh-mcp-client` logic — good practice for a plugin that mirrors official code. Package metadata: scope package.json has engines (:26-28), files whitelist (:22-25), publishConfig.access public (:105-107), prepack build (:116) — but **no `repository`/`homepage`/`bugs`/`author`**. | Hygiene tools scale with project size; the universal core is: dependabot on both ecosystems, LICENSE correct + attribution where code is mirrored, package metadata complete enough for npm/GitHub to attribute the package, templates that make review cheap. | **CONFORMS**: LICENSE (root, packed, MIT + attribution), dependabot.yml:1-13 (npm weekly increase-if-necessary limit 5 + github-actions monthly) — cadence lighter than harness's daily+cooldown but right for a plugin repo; chamber uses Renovate, so no single reference cadence to match. **PARTIAL/MISSING**: no CODEOWNERS, no PR/issue templates; no `repository` field. **Not applicable**: expected-filenames (upstream snapshot-fixture convention; no analog here), stale/triage bots (no issue volume yet). | **MUST-once-public, S**: add `"repository"` (+ optional `homepage`/`bugs`/`author`) to package.json when the public URL exists. **SHOULD, S**: PR template (chamber-shaped but condensed, and in the repo's English): Intent / Validation (exact commands) / Risks — drop chamber's "Repository guidance" table or point it at AGENTS.md if one is added; issue templates (one bug form) OPTIONAL. CODEOWNERS (single-maintainer placeholder like chamber's) OPTIONAL once public. Stale/triage bots: NOT NOW — revisit at issue volume (explicit, cheap to add later from chamber's files). |
| (i) | Docs conventions: AGENTS/CLAUDE presence, docs gates | chamber: root AGENTS.md (always-on repo rules; the PR template's "Repository guidance" section maps changes to AGENTS.md rules), CONTRIBUTING.md + docs/DEVELOPMENT.md §5 "CI 与发布" (docs/DEVELOPMENT.md:132-146) + docs/checklists/release-checklist.md (release runbook), i18n-pair doc verification (verify:i18n). Harness: AGENTS.md + CLAUDE.md + `.agents/notes/` + an extensive doc-sync gate family running in CI (run-gates.ts:571-616: verify-md-wrap/links, doc-refs, catalogs, doc budgets, translation pairing…) and node-specific gates (verify-agent-note-*). | An agent-readable repo map with the validation checklist, and a written release runbook; heavy doc gates are monorepo documentation-site machinery. | **CONFORMS** on runbook/docs substance: docs/RELEASE.md:1-104 is a genuine release/CI/smoke/rollback runbook, plus design/acceptance/recon/milestone docs with an index (docs/README.md) — proportionate and better than many small repos. **MISSING**: no AGENTS.md (and no CLAUDE.md — both fine to omit for a plugin). No doc gates — proportionate to skip (upstream runs them because the docs are a published multi-language site, run-gates.ts:571-616). | **SHOULD, S**: minimal AGENTS.md (~15-20 lines): repo map (docs index, scripts), "what must pass before tag" (npm run check, release-notes extraction, dry-run rule once adopted), pointer to docs/RELEASE.md — this is what makes the future PR template's guidance section and any external contributor useful. CONTRIBUTING.md: OPTIONAL. Doc-link/wrap gates: skip (recorded divergence). |

## Prioritized adoption list

### MUST — cheap, high-value (release-safety parity with chamber)

1. **`scripts/verify-workflow-action-pins.mjs` (new)** — port of chamber's
   `scripts/verify-workflow-action-pins.mjs:21-57`: dependency-free Node; scan `.github/workflows/*.yml`;
   every external `uses:` must be a full 40-hex SHA (assert format), one SHA per action across
   workflows (assert no drift), shared bootstrap actions present in both ci.yml and release.yml;
   plus release-structural asserts adapted to our shape: release.yml carries
   `concurrency.group: release-publish` + `cancel-in-progress: false`, and all mutation steps
   (release creation/upload) appear after the gate steps. Wire a `"verify:workflows"` script in
   package.json and add `node scripts/verify-workflow-action-pins.mjs` as the first step of
   `ci.yml` (after checkout) and of `release.yml`'s job — chamber runs it before install
   (ci.yml:32-33, release.yml:280-281).
2. **`.github/workflows/ci.yml`** — (i) add `tags: ['v*']` to the `push` trigger with the chamber
   comment (ci.yml:6-11 rationale); (ii) add the action-pin verify step; (iii) add post-install
   `git diff --exit-code -- package-lock.json` step (chamber ci.yml:53-54 rationale); (iv) add
   `workflow_dispatch:` to `on:` so the self-hosted smoke job (ci.yml:60) is reachable as
   documented in docs/RELEASE.md:19-22 — or delete the dead job.
3. **`.github/workflows/release.yml`** — (i) top-level `permissions: contents: read`, job-level
   `permissions: contents: write` (chamber release.yml:54-55/74-75); (ii) `concurrency` block
   (`group: release-publish`, `cancel-in-progress: false`, chamber release.yml:57-62); (iii)
   action-pin verify step; (iv) lockfile diff assert; (v) pre-mutation guard: enumerate releases
   by tag (`gh api --paginate repos/{owner}/{repo}/releases?per_page=100` + jq) → if any
   *published* release exists for `v<version>` fail closed; delete only stale drafts (port of
   chamber release.yml:197-242, which exists because softprops silently *updates* an existing
   release — release.yml:198-206 postmortem); (vi) `if-no-files-found: error` on the artifact
   upload (release.yml:83-86).
4. **Action re-pinning (same change as #1, or the verify script fails)** — resolve and apply full
   SHAs + `# vX.Y.Z` comments for `actions/checkout@v5`, `actions/setup-node@v5`,
   `actions/upload-artifact@v6`, `softprops/action-gh-release@v3` in both workflows; resolution
   recipe: `git ls-remote https://github.com/<owner>/<action>.git 'refs/tags/v*'` and pin the
   current major's newest tag commit (the comment cites the tag name). This closes norm (c), the
   largest single gap vs. chamber.
5. **`package.json`** — add `"repository": {"type": "git", "url": "git+https://github.com/<owner>/dsh-mcp-scope.git"}`
   (+ `homepage`/`bugs` if desired) the moment the public URL exists; add
   `"packageManager": "npm@<bundled npm of Node 24>"`.

### SHOULD

6. **`scripts/verify-package.mjs`** — add an execution step: after the consumer typecheck, run
   `node --input-type=module -e "await import('file:./lib/index.js')"` (or an imports probe of
   both entries) against repo `node_modules` so the *built* ESM is executed in CI, not just
   typechecked — the packaged-runtime analog of chamber's installed-`--help` smoke
   (release.yml:371-376). S.
7. **`docs/RELEASE.md` + `release.yml`** — document and implement the dry-run rule chamber
   enforces (checklist:24-26/116-121): any change to workflows/scripts/action SHAs must be
   validated by one `workflow_dispatch` dry run before the formal tag. Minimal shape: dispatch
   inputs `version` (required) + `dry_run` (boolean) skipping the GitHub-Release mutation steps;
   then document "dry-run first" in the §Releasing flow. M.
8. **Release asset sha256 sidecar** — in release.yml, write `<tgz>.sha256` next to the packed
   tgz and attach it to the Release, matching chamber's gateway asset pair
   (release.yml:377-384; checklist:133: `dsh-mcp-scope-0.0.1.tgz` + `….tgz.sha256`). S.
9. **`.github/PULL_REQUEST_TEMPLATE.md` (new)** — condensed chamber shape (PR template:1-31):
   Intent / Non-goals / Validation (exact commands — "不得仅凭类型/静态检查声称运行时行为正确"
   spirit) / Risks; English. S.
10. **`AGENTS.md` (new, root)** — repo map + release invariants + "what must pass before tag"
    pointer to docs/RELEASE.md (enables the PR template's guidance table if adopted; chamber
    precedent AGENTS.md). S.

### OPTIONAL

11. Coverage threshold in vitest.config.ts — only if desired; chamber runs none, harness's
    per-file 100 % (vitest.config.ts:269-279) is monorepo scale; a single low global threshold
    adds little for a 133-test plugin suite. S.
12. Issue templates (one bug form) + CODEOWNERS placeholder — once public, from chamber's
    files; until then templates churn with the repo shape. S.
13. Stale + triage label bots — revisit at issue volume; chamber's stale.yml/triage.yml are
    drop-in templates when needed. S.
14. Network action-SHA resolution step in ci.yml (chamber ci.yml:64-67 preflight `--actions-only`
    with `GITHUB_TOKEN`) — chamber added it because offline format checks cannot detect an
    upstream SHA that no longer resolves; worthwhile once public. M.
15. Centralize `--legacy-peer-deps` into `.npmrc` (npm excludes it from packs) and/or drop it
    when the dev matrix settles on one dsh line. L, defer.
16. `.github/dependabot.yml` — optionally align github-actions to weekly (currently monthly) so
    action SHAs refresh at reviewable cadence once sha-pinned. S.

### EXPLICIT DIVERGENCE (documented, do not "fix")

- **npm publish disabled** (release.yml:5-13/66-73, docs/RELEASE.md:30-36) — maintainer choice
  for v0.0.1; the ecosystem explicitly blesses the alternative distribution form
  ("Ship a tarball from `pnpm pack`; users run `dsh plugin add ./…tgz`",
  docs/user/develop/basic/publish.md:175-178), and chamber ships its gateway the same way
  (release.yml:339-343: "npm publication is deliberately out of scope"). Re-enable recipe with
  provenance note already commented in the workflow. Note: neither reference uses npm OIDC
  provenance today — no precedent to match; keep `--provenance` optional.
- **`--legacy-peer-deps` in the dev tree** (norm e) — necessity documented in three call sites +
  RELEASE.md; consumers unaffected; pnpm-style scoped relaxation not available under npm.
- **No coverage gate** — chamber parity (harness's 100 % per-file is upstream scale).
- **No CODEOWNERS / stale / triage / expected-filenames / doc gates / i18n doc pairs** —
  fresh single-maintainer plugin repo, English-only docs; expected-filenames and doc gates
  exist upstream to protect a multi-language monorepo documentation site.
- **Draft→finalize two-phase release** — single-asset tgz release does not need it; the
  refuse-published guard (adoption #3.v) provides the same protection chamber gets from the
  draft lifecycle + finalize job.

## Open questions

1. **Public repository URL / owner** — blocks `repository` field, CODEOWNERS, changelog
   comparison links (CHANGELOG.md:88-92), and any network-based pin resolution step. Is the
   repo already provisioned (private) or still local-only?
2. **Node support window** — `engines: >=24.0.0` (package.json:26-28, .nvmrc) is a deliberate
   toolchain choice (CHANGELOG.md:50), but the upstream runtime the plugin targets declares
   `^22.19.0 || >=24.0.0` (harness package.json:9) and CI-tests Node 22.19 (harness ci.yml:
   272-275); chamber floor is 22.18. If users run dsh on Node 22 LTS, a hard 24 floor can break
   install at runtime. Keep ≥24 (documented) or widen when the rc line settles?
3. **Tag trigger duplication** — adding `tags: ['v*']` to ci.yml (adoption #2.i) re-runs the full
   gate in parallel with release.yml on every release (~doubled CI cost per tag). Chamber accepts
   this; confirm we do too.
4. **`--legacy-peer-deps` longevity** — the dev matrix mixes `dsh-client-runtime@0.1.1-rc.2`
   with the 0.1.2-rc.1 line (package.json:75-76). Is the old runtime pin intentional (surface
   parity with the rc.1 runtime the client half targets, per CHANGELOG.md:51-52) or merely
   stale? It is the root cause of the peer conflict; a single-line matrix removes the flag.
5. **Smoke-job trigger** — add `workflow_dispatch` to ci.yml (adoption #2.iv), or is the
   self-hosted `dsh-smoke` runner lane expected to stay dormant until the repo is public? If
   dormant, delete the job rather than keep dead config.
6. **action-gh-release version to pin** — scope uses `@v3`; chamber pins `softprops/
   action-gh-release` at v2.3.2. If v3 has no released tag newer than v3.0.0 the comment would
   read `# v3.0.0`; verify tag availability during adoption so the comment cites a real release.


---

## Adoption status (2026-09-06, applied in commit after this report)

MUST 1–4 implemented: `scripts/verify-workflow-action-pins.mjs` (chamber-style
format/drift/presence + release-structural asserts; moving majors currently
carry a checked-in allowlist with TODO-SHA notes because SHA resolution needs
network access to GitHub — replace the allowlist when the repo is public);
ci.yml runs on push main/tags `v*`/PR/workflow_dispatch and verifies pins +
asserts the lockfile; release.yml gained per-job `contents: write`,
`concurrency.group: release-publish`, a refuse-published-release guard
(delete stale drafts only), dry-run dispatch mode, the tgz `.sha256`
sidecar, and `if-no-files-found: error`. SHOULD 6–10 implemented:
`verify:package` now imports the BUILT host entry; dry-run rule documented in
docs/RELEASE.md; PR template + AGENTS.md added; dependabot actions weekly.
Open questions 1/2 remain environment/owner decisions (public URL, engines
window); 3 accepted (tag duplication, chamber parity); 4 documented
(legacy-peer-deps root cause); 6 resolved in favor of the allowlist until
SHA resolution is possible.
