# Round-2 fix verification — disposition-matrix audit (cross-cutting)

Auditor scope: verify **every row** of `docs/review/SUMMARY.md` (both tables)
against the current tree with direct evidence. This report does not duplicate
the round-2 area reviews; it checks truthfulness of the disposition matrix and
repo hygiene. Round-1 finding IDs below refer to `docs/review/{architecture,
implementation,security,performance,interaction,frontend}.md`.

## 0. Method executed (all live, this session, Node v22.22.3)

- `vitest run`: **126/126 passed (11 files)**; `npm run typecheck`: clean (both
  tsconfigs).
- `node scripts/build.mjs` run twice → identical sha256 for `lib/index.js`
  (`aa38a9f0…`) and `lib/client.js` (`71b4144d…`) — deterministic.
- `npm pack --dry-run` + fresh pack: 29 files, exactly `lib/**` +
  `cordis.patch.yml` + auto-included `README.md`/`package.json`; **no LICENSE
  file anywhere in repo or tarball**; no `node_modules`/deps bundled.
  `.smoke/dsh-mcp-scope-0.1.0.tgz` is **byte-identical** to a fresh pack
  (`26aa9355…`).
- `lib/client.js` requires only `react` and `react/jsx-runtime`.
- Consumer d.ts check (`dsh-mcp-scope/client` types + runtime + locale
  augmentation) re-compiled against the packed tgz: clean.
- M1 smoke: post-fix run log `.smoke/logs/m1-postfix.log` (17:31:38–51)
  completes with "evidence written to docs/milestones/M1-raw.log", no stack
  trace → exit 0 (inferred; the driver has no `process.exit`).
- Git: tree clean except concurrent round-2 reviewer output under
  `docs/review/round2/` (untracked, expected); `lib/`, `.smoke/` ignored.

## 1. Per-row audit — "Fixed in code"

| Row | Claim (abridged) | Verdict | Evidence |
|---|---|---|---|
| FE-1 | Post-write read-back compare; refusal ⇒ conflict; auto-unset of newly-written secrets | **VERIFIED** | `src/client/controller.ts:712–729` `applyOps` → post-mutate `this.refresh()` + `docsEqual(this.snapshot.doc, expectedDoc)`; mismatch ⇒ `conflict`, never ok. `submitPlan` 637–677 cleans up newly-stored refs on refused writes (`cleanupNewlyStored`, preconfigured set 647/684). Tests `tests/client/controller.spec.ts:472` ("never reports ok for a mutate that resolves without writing"), 489 (toggle refusal), 501 (overlap), 527 (preconfigured never unset). `FakeScope.refuseNext` resolves-without-writing — tests would fail without the read-back. |
| FE-2 | Typed `code` classification, `isDSHRemoteError`, scan as fallback | **VERIFIED** | `controller.ts:291–307`: `code === 'settings/conflict' \|\| 'SETTINGS_CONFLICT'` first, `isDSHRemoteError` marker second, regex only for non-platform errors. Tests spec 232–252 (typed-first, no-scan-on-typed, scan fallback). |
| FE-3 | `remote.credentials` added; `connection` dropped (grep-proven, commented) | **VERIFIED** (doc drift elsewhere, see §2 R2V-4) | `src/client/index.ts:119` inject = `['slots','locale','remote','remote.credentials','settingsScope','workspaces']`; FE-3 note comment 9–17; grep of `src/client` shows no runtime `ctx.connection`. Built bundle line 1573 matches. |
| FE-4 | 41 controller tests incl. in-memory scope/gateway fakes | **VERIFIED** | Live run: `controller.spec.ts (41 tests)`. Pipeline suite 421–639 over `FakeScope`/`FakeCredentials`: secret-before-doc ordering (422), abort-on-secret-failure pre-doc (447), refusal/overlap/conflict (472/489/501), removal unsets post-commit (553), revision pass-through on every path (570). |
| FE-6 | Generation counter + ref-set check before publish | **VERIFIED** | `controller.ts:434–435, 515–549`: `credentialsGeneration` bumped per describe start; publish gated on `generation === credentialsGeneration` AND unchanged ref set (531–535). Tests 642–677 (out-of-order settle discarded, `credentialsAt` not bumped). |
| FE-10 | Type-only re-exports from `./client` entry | **VERIFIED** | `index.ts:59–76`; `lib/types/client/index.d.ts` re-exports; consumer d.ts compile against packed tgz succeeds (would be TS2307 without). |
| FE-11 | Mounted-ref guards; success paths skip trailing writes | **VERIFIED** (code-level only) | `section.tsx:80–86/116–132`, `server-card.tsx:88–94/136–174`, `add-form.tsx:276–282/316–337` — `mounted` refs, success paths return before further `setState`. No dedicated test (jsdom cannot observe), acceptable for the code-smell class. |
| FE-9 / UX copy | {one,other} count keys, row add/remove keys, placeholders localized | **VERIFIED** | `locales.ts:34–39` one/other pairs + `countKey` 120–125; `add.envAdd/envRemove/headerAdd/headerRemove/argRemove` keys used in `add-form.tsx:425/430/470/475/543/552`; placeholders `add.secretPlaceholder/headerNamePlaceholder/credentialRefPlaceholder` (461/517/526/534); `add.ellipsis` fallback (365). Render spec asserts the count-1 forms (209–211). |
| UX-01/03 | Per-card `role=alert` banners; form-local success/failure; `role=status` note + focus move | **VERIFIED** | Card banner `server-card.tsx:202–206`; form banner `add-form.tsx:353–357`; section `role=status` note + focus to card header `section.tsx:98–101, 179–185`; tests render spec 274–293, 313–340, 342–363. Residual (unclaimed): no focus management after successful *remove* — focus drops (UX-01's remove half), card unmounts. |
| UX-04 | Edit affordance, prefilled staged form, rename migrates override rows, definition chips | **VERIFIED** | Edit button `server-card.tsx:195–197`; staged edit `section.tsx:166–177`; `draftFromServer` `add-form.tsx:53–76`; details line/URL/cwd 231–246; rename migration `controller.ts:184–205 renameOverrideKey` + `replaceServer` 568–582; tests spec 603–615 (override rows migrate), render spec 365–401. |
| UX-02 | Controller-level auto-cleanup on failure/refusal; never unsets pre-configured refs | **VERIFIED** | `controller.ts:637–686`; refusal-tolerant best-effort `unsetQuietly` 689–699 (comment). Tests 447–470, 472–487, 527–551. |
| Badge tri-state | `secret.unknown` neutral state; retry on events | **VERIFIED** | `server-card.tsx:60–67 badgeState` (undefined view ⇒ unknown, never "Not configured"); `secret.unknown` locales; retry gated on doc ref set not badge map `controller.ts:501–504`; tests render spec 224–227/230–253, controller spec 679–693. |
| Workspace rows | Localized loading/error gating; empty only when settled | **VERIFIED** | `workspaces.ts:35–39`; card gating 104–107/287–295; locales `workspaces.loading/error`; test render spec 255–272. |
| Form ergonomics | Real `<form onSubmit>`, autofocus, `type=button`, Clear pending/disabled | **VERIFIED** | `add-form.tsx:306–309/345–349/364/566–571`; Clear pending/disabled `server-card.tsx:254/269–277` (also covers UX-09's Clear leg); render spec 295–311. |
| PERF-1/IMPL-2 | Diffed reconcile; no-op reconcile provably registers nothing | **VERIFIED** | `agents.ts:277–289` (no force pass), idempotence guard 234–238, one snapshot per event 267/285. Test agents.spec 389–425 asserts **zero log lines** from the applier + registration identity unchanged after a no-op reconcile, real flips revoke/apply — would fail under the old blanket force. (Assertion style = log-line count + def identity, per the fixer's stated deviation — matches the row.) |
| PERF-2 | Manager-owned per-server epoch in the dedupe key + regression test | **VERIFIED** | `manager.ts:81–95, 122–139` (epoch bump per start, comment); `agents.ts:64–86, 234–238`; test agents.spec 350–387 (restart push reusing syncId 1 swaps defs: `toBe(newGen)`, `not.toBe(oldGen)`, executor runs new def; same (epoch,syncId) re-push no-op). |
| IMPL-1/ARCH-2 | WorkspaceId re-resolved per push/reconcile; deletion revokes; creation-after-adopt applies | **VERIFIED** | `agents.ts:153–166 refreshEntryWorkspaces` called at 266/284; docstring 10–14 states revocation happens "on the next event" (honest residual); tests agents.spec 427–450 (deletion), 452–470 (creation). |
| ARCH-3/IMPL-6 | Adopt only non-`subagent`-origin agents; symmetric paths; deviation documented | **VERIFIED** | `agents.ts:168–184` (`header.origin === 'subagent'` → skip) — listener and boot scan funnel through `adopt`; deviation docstring 16–20 + `docs/acceptance.md:29`. Test agents.spec 472–517 covers both paths. Real-loop delegation check still deferred as the row's documented tail says. |
| IMPL-4 | Dedicated unregister commit; no `synced 0 tools` line; counters count real listings only | **VERIFIED** | `server.ts:220–230 unregister()` pushes EMPTY_DEFS without log/counter bump (syncId reused); `commit()` 207–218 only on real listings; give-up error wording kept (official) + explicit "tools unregistered; reload…" tail (227–230 region comment; 292). Test server.spec 186–215: generation/syncId stay 0, commit `{syncId:0,size:0}`, no "synced 0 tools" line. |
| IMPL-7 | Dead `ready.then` removed | **VERIFIED** | No `ready`/`.then` handler remains in `src/manager.ts` (grep-clean); supervisor `ready` (server.ts:389–394) still never rejects. |
| IMPL-3 | `pendingRestarts` coalescing per serverName | **VERIFIED** | `manager.ts:88–89, 159–186` (comment 160–165; absorbed requests return false and are not logged — 207–209). Test manager.spec 165–204 (two same-tick events ⇒ one stop/start/one log; marker cleared ⇒ later event restarts). |
| SEC-02 | Transport-level value rejection (skip + ref-only warn) | **VERIFIED** | `transport.ts:38 INVALID_VALUE_PATTERN`, env 77–80, headers 107–110, warn names ref/name only; docstring 13–15. Tests transport.spec 116–138/140–155 (value never in warn text). |
| SEC-03 | `RESERVED_OVERRIDE_KEYS` guard in `validateDoc` + tests | **VERIFIED** | `model.ts:93, 110–112`; wired via host validate hook `index.ts:87–92`; test model.spec 168–174. |
| SEC-06 | Schema gaps "covered by shared validateDoc; boot-layer path documented" | **OVERSTATED** | Git diff (4ae917c→2737f98): `schema.ts` untouched; `validateDoc` unchanged except the SEC-03 reserved-name check — the envKeys-element/header-ref pattern checks and the header name `!== ''` check **pre-existed** (round-1 `model.ts:95–120` identical). Header names still have no RFC-token pattern (round-1 IMPL-11 remains). No code or doc change anywhere documents the boot/user-layer `settings.yaml` bypass path — that half of the row is unverifiable. Row states pre-existing coverage as a fix and cites a documentation that does not exist. |
| ARCH-1 | `zod` dependency + `@deepseek-ai/dsh-timeout` peer declared | **VERIFIED** | `package.json:49–64` (`zod ^4.4.3` dep; `dsh-timeout ^0.1.2-rc.1` peer + dev); `src/tools.ts:30` and `src/server.ts:28` consumers; fresh `npm pack` contains neither (declared, not bundled). |
| FE-7/UX-17 | Doc drift fixed: design.md children-slot claim, ui-notes wording | **PARTIAL / mislabeled** | design.md §5 children-slot block removed and replaced with the real `inject: () => controller.face()` registration + "no child slots" (design.md:89–94). BUT: (a) "UX-17" is a **wrong ID** — `interaction.md` UX-17 is *visual-language mismatch with official chrome*, which was NOT fixed (documented polish, same subject as FE-5); the doc-drift item is **FE-7** only. (b) ui-notes.md:35 wording fix is cosmetic ("skipped" → "initially skipped"); §2 still reports "3 files / 39 tests" and never mentions the 10 passing render tests. |
| SEC-01/05 etc. | Cascade/robustness minors hardened / documented in comments + acceptance.md | **OVERSTATED** | SEC-01 hardening is real and comment-documented (`controller.ts:620–636, 688–699`), and acceptance.md:29 records three decisions. But "etc." is undefined and SEC-05 (unbounded `tools/list` pagination + per-agent amplification) got **no cap, no comment, no README/acceptance note** — `tools.ts:119–151` carries no mention. Row breadth exceeds evidence. |

## 2. Per-row audit — "Documented (accepted)"

| Row | Claim | Verdict | Evidence |
|---|---|---|---|
| ARCH-4 | Known environment limitation (M1.md); m1 smoke exits 0 recording `not-captured` | **VERIFIED** | `docs/milestones/M1.md:55–67`; `M1-raw.log` (10 lines) ends "R3-live-capture: not-captured"; post-fix run log `.smoke/logs/m1-postfix.log` completes cleanly (exit 0 inferred — no crash/stack, evidence written; the driver has no explicit exit-code instrumentation, minor caveat). |
| ARCH-3 tail | Preset scopes govern children; deviation documented in agents.ts + acceptance.md | **VERIFIED** | `src/agents.ts:16–20`; `docs/acceptance.md:29`. Real-delegation re-validation deferred exactly as stated. |
| IMPL-3 tail | Reconcile + credential restart same tick can still double-cycle; convergent; fingerprint-aware skip impossible by design | **VERIFIED** (thin anchor) | Code behavior matches: reconcile diffs restart directly on the chain (`manager.ts:216–238`) while a queued `restartServer` (159–186) later stops/starts again; convergent via live doc re-read (181) and fingerprint compare. Caveat: the residual is recorded **only in this SUMMARY row** — no code comment or doc states the double-cycle or the "impossible by design" rationale. |
| SEC-01 tail | Inherent shared-ref-namespace model; new-ref-only cleanup, best-effort, refusal-tolerant | **VERIFIED** | Code comments `controller.ts:626–636` (submitPlan), 679–699 (cleanup + best-effort unset). |
| PERF-UI | Whole-section re-render accepted (~1 ms @ 20 rows); coalesce/memo queued as polish | **VERIFIED** | Benchmark in `performance.md` §3 (1 ms @ 20 rows; 11.8–14.2 ms @ 1 000); §5 item 4 tracks the UI pass as future work; no code change claimed. |
| FE-5 | Hand-rolled styling accepted; revisit when tokens pinned | **VERIFIED** | Components still use raw inline styles/literals (`server-card.tsx:41–57, 177–178` etc.); `design.md:102` "Hand-written controls (official card-form pattern)" supports the stance. |
| FE-8 | `__esModule`/getters vs `Symbol.toStringTag` cosmetic | **VERIFIED** | `lib/client.js:23` defines `__esModule` via `__toCommonJS`; no `Symbol.toStringTag` define anywhere in the bundle; entry has no default export. |
| Image bridging | rc.5 placeholders deliberate; degraded content with diagnostics; host-notes documented | **VERIFIED** | `docs/host-notes.md` (c)3 lists placeholder formats; `src/tools.ts:20–22` docstring + 274–277 comment + 296–300 placeholders (`[image: …, content discarded]`, `[audio: …]`, `[resource: …]`) and diagnostic line for unknown blocks. |
| SEC-04/08/10, UX-10…19 | Tracked as future polish; failures bounded today | **VERIFIED** | No code changes for these items (checked each: no debounce in manager; no URL caps host-side; UX-10/11/12/14/15/17/19 untouched — none appears in the fixed table under its real ID); tracking lists in the round-1 reports' prioritized sections (`interaction.md:81–87`, `performance.md §5`); bounded-failure claim matches SEC-08 analysis (SDK 60 s timeout, 10-attempt give-up). |

## 3. Meta-hygiene findings

| ID | Sev | Finding |
|---|---|---|
| R2V-1 | Low | **FE-7/UX-17 row ID corruption (SUMMARY.md:52).** UX-17 in `interaction.md` is visual-chrome mismatch (untouched, documented under FE-5's acceptance). The doc-drift fix is FE-7 only. Row should read `FE-7` (or `FE-7 / ui-notes`). Also ui-notes wording fix is cosmetic — see R2V-4. |
| R2V-2 | Med | **SEC-06 row (SUMMARY.md:50) is not a fix.** schema.ts and validateDoc semantics (beyond SEC-03) unchanged vs round 1; "boot-layer path documented" unverifiable — no documentation of the settings.yaml bypass path exists in src or docs. Recommend demoting the row to a "pre-existing coverage" note or deleting it; the RFC-token header-name gap (IMPL-11) remains. |
| R2V-3 | Med | **SEC-01/05 "etc." row (SUMMARY.md:53) over-broad.** SEC-05 never addressed (no cap, no doc) and has no other disposition row anywhere; SEC-10's disclosure ask only partially met (removeConfirmBody + defaultOn text existed pre-fix; shared-credentials-domain disclosure sentence still absent from add-form hints/README as requested). |
| R2V-4 | Med | **Doc drift persists in changed claims.** `design.md:89` still documents the pre-FE-3 inject list (`'connection'` present, `remote.credentials` absent) — contradicts current code/SUMMARY. `design.md:108–111` deps list omits the new `zod` dep and `dsh-timeout` peer. `README.md:89` says "87 tests" (now 126). `docs/host-notes.md:20,23` still claim "84 tests / 10 files" (round-1 IMPL-12, untouched). `docs/ui-notes.md:26–35` §2 reports "3 files / 39 tests" + "initially skipped" render tests. `design.md:78` "Tool semantics identical to official mcp-client" overclaim remains despite the image-bridge cut (ARCH-6 recorded only in host-notes (c)3; design.md not re-worded as ARCH-6 asked). `docs/acceptance.md` dict-of-dicts + round-2 decisions lines ARE correct (verified). |
| R2V-5 | Med | **Matrix completeness.** No disposition row for: ARCH-6/7/9/10/11/12/14, IMPL-5/8/9/10/11/12, PERF-3/4/6/7, SEC-04/05/07/09 (SEC-04/05/07/09 partially folded into vague rows). Some are genuinely fixed in code (IMPL-8 EMPTY_DOC frozen — model.ts:57–60 + test 160; PERF-7 via single-snapshot reads agents.ts:284–288; SEC-07 = FE-1/UX-02; SEC-09 = IMPL-1/ARCH-2; PERF-3 by PERF-1/2; ARCH-10 = FE-2; ARCH-13's ready.handler = IMPL-7). **IMPL-5's runtime gap remains real and unlisted**: `removeServerOverrides` is still referenced only by tests (`controller.removeServer` 585–594 passes overrides through unchanged, no prune ops) — yet the fix commit message claims "removeServerOverrides … wired". A re-added server resurrects as OFF in every workspace that had disabled it, and the pipeline test 117–129 passes only because the test itself builds the pruned doc (it does not exercise the controller path). |
| R2V-6 | Low | **License/notice hygiene.** `package.json` declares MIT but no LICENSE file exists in repo or tarball (fresh `npm pack` = 29 files, none is a license). Official mirrored source (`@deepseek-ai/dsh-mcp-client` at the anchor) is MIT © 2026 DeepSeek and ships a LICENSE file. src/{server,tools,transport}.ts mirror its algorithms in places (per own docstrings: "mirroring the official dsh-mcp-client … exactly"); same-org so legal risk is low, but hygiene requires an MIT LICENSE (with an attribution line to the mirrored official code) so npm packaging and the MIT notice condition are satisfied. |
| R2V-7 | Info | Smoke claim nuance: "m1 smoke now exits 0" is inferred from clean completion (no `process.exit` instrumentation); the driver's earlier failure mode (round-1 `m1-run.log` ENOENT crash) is gone, and evidence file + log timestamps (17:31) precede the commit (17:33); the installed tgz is byte-identical to the current tree. |

## 4. Verdict

The disposition matrix is **largely truthful**: all high-value "fixed" rows
(FE-1/2/3/4/6/10/11, UX-01…04, badge tri-state, workspace rows, form
ergonomics, PERF-1/2, IMPL-1/ARCH-2, IMPL-3, IMPL-4, IMPL-7, ARCH-1,
ARCH-3/IMPL-6, SEC-02, SEC-03; all documented-table rows incl. the
image-bridge scope cut) were verified in code with line-level quotes and backed by regression tests
that would fail without the fix; the full suite (126/126), both typechecks,
deterministic double build, tarball/package-file alignment, and consumer d.ts
check all reproduce. Exceptions, in descending order of importance: (1) the
FE-7/UX-17 row mislabels UX-17 and its ui-notes half is cosmetic; (2) the
SEC-06 "fix" row is pre-existing coverage restated as a fix plus an
unverifiable documentation claim; (3) the SEC-01/05 "etc." row overstates
SEC-05 (never addressed); (4) drift in docs the fix round claimed to correct
(design.md §5 inject list, §6 deps, ui-notes §2, README/host-notes test
counts, design.md:78 image-bridge "identical" claim); (5) IMPL-5's override-
row prune is dead in the runtime path despite the commit message; (6) no
LICENSE file (MIT declared but no notice shipped). None of the six fixers'
stated deviations (restart-coalescing residual, give-up wording, zero-churn
assertion style, `connection` drop, edit-rename) is contradicted by code or
by the SUMMARY text.

## 5. Prioritized corrections (files NOT modified by this audit)

1. **SUMMARY.md:52** — change row id `FE-7/UX-17` → `FE-7`; text: "design.md §5 children-slot claim corrected (inject list itself still stale — see below); ui-notes wording partially corrected". Optionally add a row "UX-17 (visual chrome) — accepted with FE-5; UX-10…19 tracked as polish" so UX-17's real subject has a home.
2. **SUMMARY.md:50 (SEC-06)** — reword to "Pre-existing validateDoc coverage of envKeys/header-ref grammar (no schema change; boot-layer bypass remains — documented nowhere; header-name RFC-token gap (IMPL-11) open)". Move out of "Fixed in code" or mark as PARTIAL disposition.
3. **SUMMARY.md:53 (SEC-01/05 etc.)** — either name the exact IDs dispositioned or split: "SEC-01 (hardened in controller comments; shared-namespace cascade accepted — see SEC-01 tail)", "SEC-05: open (no cap; README note pending)".
4. **design.md:89** — replace inject list with `['slots','locale','remote','remote.credentials','settingsScope','workspaces']` (no `connection`) or state the FE-3 rationale; **design.md:108–111** — add `zod` dep + `@deepseek-ai/dsh-timeout` peer to the deps list; **design.md:78** — append ARCH-6 caveat ("…except: no rc.1 attachment/image bridge — placeholders, see host-notes (c)3").
5. **README.md:89** and **docs/host-notes.md:20,23** and **docs/ui-notes.md:26–35** — refresh test counts (126/11) and render-test status.
6. **SUMMARY.md:41–42 (IMPL-3 tail)** — add an anchor: "recorded in manager.ts restart comment / acceptance.md" or explicitly say the residual is matrix-only.
7. Commit-message/IMPL-5: wire `removeServerOverrides` into `controller.removeServer` (or document retention and delete the dead export); add a controller-level regression test for re-add-after-remove default-on (the current prune test constructs the doc itself and cannot catch the runtime gap).
8. Add a LICENSE file (MIT, © note + attribution to `@deepseek-ai/dsh-mcp-client` algorithms where mirrored); re-pack (npm auto-includes LICENSE).
