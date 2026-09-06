# Pre-release client/UX audit — dsh-mcp-scope v0.0.1 (tgz asset)

Auditor: final client/UX pre-release pass. Scope: the shipped browser half
(`src/client/**`, built to `lib/client.js`, exercised only by the jsdom suites
+ the bundle-in-boot-graph check — **no real-browser run is possible in this
environment**), plus the round-1/round-2 UX finding surface
(`docs/review/round2/interaction.md`, `docs/review/round2/frontend.md`) against
the **current** tree (post-fix-round commits `4dd4d85`, `47be3b7`, `5e562b0`).
Output is this file only; no other file was modified (one temporary probe spec
was created under `tests/client/`, run, and deleted — see §2.3).

## 0. Verdict

**Ship condition: READY after one small code fix (or conscious deferral of it) —
see §9 action 1.** The two prior review rounds' highs are fixed in the current
tree and unit/render-pinned; copy is truthful where it matters most (conflict
copy now says "Not saved"); bundle purity, determinism, consumer d.ts and both
suites all re-verified green under Node 24. No crash path, no silent draft
destruction, no focus/failure-feedback dead end on any *ordinary* first-user
flow was found. What remains is (a) **one new Med-low functional corner**:
server names that collide with `Object.prototype` members (`toString`,
`valueOf`, `hasOwnProperty`, …) are legal per the shipped name pattern, pass
the reserved-name guard (which blocks only `__proto__`/`constructor`/
`prototype`), and then render stuck-OFF / non-toggleable in any workspace whose
override row is non-empty — a 3-line own-key semantics fix in the shared
model+controller closes the whole class; (b) one genuinely broken a11y claim:
the remove-confirm Esc/Cancel "focus returns to the Remove button" path is a
no-op (ref read while the button is unmounted — focus drops to `<body>`); and
(c) low/copy nits. Everything else in the round-2 residual list is either
fixed, covered by the shipped suites, or a consciously acceptable residual with
rationale in §8.

## 1. Evidence baseline (all live this session)

- Node **v24.20.0** (`/root/projects/dsh-mcp-scope/.tools/…` in PATH).
- `node node_modules/vitest/vitest.mjs run tests/client/` → **57/57**: locales
  4, controller 43, jsdom section-render 10. Repo-wide `vitest run` → **133/133
  (11 files)**. `tsc -p tsconfig.tests.json --noEmit` green.
- `node scripts/build.mjs` run → sha256 `lib/client.js` =
  `4d485bad06ad7be105d7f61321ab7b6fd1443928cf7de7a06a738fb551b92175`,
  identical before/after my rebuild (deterministic).
- `node scripts/verify-package.mjs` → **PASS**: packs `dsh-mcp-scope-0.0.1.tgz`
  (30 entries), consumer typecheck OK for host **and** `./client` entry types,
  determinism OK.
- Source re-read in full with fresh eyes: `locales.ts`, `section.tsx`,
  `server-card.tsx`, `add-form.tsx`, `controller.ts`, `index.ts`,
  `workspaces.ts`, `shared/model.ts`, all three client specs.
- Temporary jsdom probe suite (11 tests, `zz-prerelease-probe.spec.tsx`) ran
  green, then was deleted; results cited below as **P1…P11**. Suite state after
  deletion re-verified: client 57/57, tree clean.

## 2. Check 1 — shipped strings

**Pass, with nits.** Every user-visible string in the three components rides
`t()` from `src/client/locales.ts` (grep for JSX text/attribute literals found
none beyond the interpunct `·` summary separator and the `×` dismiss glyph —
the `×` carries the localized `action.dismiss` aria-label). Key hygiene: every
defined key is used by at least one component (dead-key scan found exactly one
exception — nit N4); no `t()` call references an undefined key (compile-enforced
`SettingsKey` union at every call site).

- **en/zh parity**: `locales.spec.ts` asserts identical key sets, non-empty
  values and per-key interpolation-placeholder parity (4 tests) + render spec
  #10 mirrors the key set; placeholders at real call sites match the
  dictionaries (`{name}` in `add.added`/`edit.saved`/`add.toolPrefixHint`,
  `{count}` via `countKey`, `{path}` in `server.cwd`, `{refs}` in
  `error.secretWriteFailed`/`error.conflictKeptRefs`); no placeholder key
  anywhere renders untranslated or un-parameterized.
- **zh sanity read**: hand-quality, not machine output — e.g.
  `未保存：你的修改未生效（设置文档已在别处变化，已重新载入最新版本）。`,
  `该服务器将在所有 workspace 停止并删除配置；其余服务器不再引用的凭据也会一并清除。`,
  `值仅写入——留空输入框即保留已存值。` (proper `——` dash). Romanized
  `workspace` inside zh sentences is the documented glossary choice
  (round-2). Nit N3 collects the only inconsistency: three short zh error
  strings end without `。` while every other zh sentence (incl.
  `error.conflict`) ends with one.
- **Banner truthfulness** — the R2U-02 core is genuinely fixed: `error.conflict`
  now opens "Not saved: your change was not applied (…the latest version was
  reloaded)." and `failureText` (`controller.ts:350–356`) appends
  `error.conflictKeptRefs` ("…were already updated and stay stored") whenever
  the failure carried refs whose new literal survived a refused doc write —
  exactly the un-restorable side effect round 2 demanded be surfaced
  (unit-pinned `controller.spec.ts:527–551`). Residual wording caveats are
  accepted/listed in §8 (b2/b3/b4): self-inflicted race conflicts still read
  "changed elsewhere", Clear failures reuse the "write" verb, and the removal
  confirm over-promises slightly on best-effort credential unsets.

## 3. Check 2 — jsdom end-to-end flows

### 3.1 What the shipped suite covers (read + run, green)

Render spec (10): empty state + add affordance; pluralized summaries /
definition details / badge tri-state (unknown-before-describe never lies);
workspace loading/error/empty gating (no "empty" text during load/error, no
off-chip pre-settlement); per-card `role="alert"` conflict on toggle failure;
real `<form onSubmit>` + `type=button` discipline + autofocus; add-success
`role="status"` note + focus on `mcp-scope-card-<name>`; refused add keeps the
form open with its own alert and a re-enabled Save; edit prefill → save →
rename focus; zh key mirror. Controller spec (43): the whole FE-4 pipeline
(secret-before-doc ordering, abort+cleanup on secret failure, resolved-but-
unlanded ⇒ conflict, overlap fence, preconfigured-never-unset, orphan unsets
post-commit, **removal override-row prune** (R2F-1), revision pass-through on
every write path, replaceServer in-place / rename-migration / vanished-original
conflict / name-collision invalid, FE-6 out-of-order describe guard + event
retry).

### 3.2 Flows the suite does NOT cover, with my verification

A temporary probe (P1–P11, deleted after the run) exercised exactly the gaps a
first user hits. Confidence labels: **H** = code inspection is decisive,
**LIVE** = probe-verified this session.

| Gap (first user WILL do this) | Confidence | Result |
|---|---|---|
| Settings opens with zero servers / zero workspaces | LIVE P9 | Empty copy + Add button; per-card "No workspaces yet" only from a settled list; no phantom rows. Good. |
| Many workspaces (40 rows) | LIVE P9 | 40 switches render; inline list, no virtualization — acceptable at this scale (§7). |
| Read-only connection | LIVE P7 | `state.readonly` note; no Add; no Edit/Remove; rows disabled. Good. |
| Duplicate server name / reserved names (`__proto__`, `constructor`) | LIVE P1 | Live messages reveal as soon as the name has content (`validation.duplicateName`, `validation.nameReserved`). Good. |
| **`toString`-class names** | LIVE P8 | **Broken** — stuck-OFF and un-toggleable in workspaces with any other off server; see finding F1. |
| Header name with a space | LIVE P3 | Live `validation.headerNameToken` message + Save disabled. Good. |
| Empty-required dead-end (name filled, command empty) | LIVE P2 | Save disabled with **no message anywhere** — partial residual of R2U-01, finding F3. |
| Remove confirm: open / failure banner / dismiss / success unmount | LIVE P6 | Confirm copy + alert + dismiss × + card removal all work; focus after remove falls to `<body>` (§8 b1). |
| Esc / Cancel on remove confirm | LIVE P5 | Esc and Cancel close the confirm but **do not return focus to Remove** — finding F2 (ref-timing bug; the fix round's claim in `server-card.tsx:106–120` is ineffective). |
| Staged form open vs card actions (draft protection, R2U-05) | LIVE P4 | All card controls (rows incl.) disable while any form is open; re-enable on cancel. Good. |
| Save in flight vs header Cancel (R2F-2) | LIVE P11 | Header button + footer Cancel both disabled during a staged save. Good. |
| Edit with untouched blank secret rows (blank-keep) | LIVE P10 | Save sends `secrets: []` (no credential writes); env key row preserved. Good — this mapping (draftToServer) had no prior direct test. |
| Clear (unset) lifecycle on a configured badge | H (code) | `handleClear` → `unsetCredential` → `refreshCredentials()` after success (`controller.ts:623–632`) → badge flips configured→unset after one describe round-trip; failure surfaces card-level alert with `refs`; `Clearing…` pending label (`secret.clearing`). |
| Unknown badge with no later events | H (code) | No retry affordance/timer — degrades only on a later doc/credential event (accepted, §8 a1). |
| Esc on remove confirm while removal in flight | H (code) | Esc during `removing` closes the panel; the op cannot be cancelled anyway and its outcome still lands on the (surviving or unmounted) card path — safe. |

Test-quality residuals of R2U-08 (auto-retire timers untested, no fake-timer
suite, the disabled-save reveal gate invisible to submit-dispatch tests) remain
— accepted as suite debt (§8 a5); the probes above cover the behavioral
questions for this audit.

## 4. Check 3 — bundle / purity (rebuilt this session)

- **Require sites**: exactly `3 × require("react")` + `3 ×
  require("react/jsx-runtime")` — nothing else; **zero** `@deepseek-ai/…`
  strings in the whole bundle (all framework imports are `import type`,
  erased). No inlined JSX helpers.
- **Exports**: `module.exports = __toCommonJS(index_exports)` with lazy
  getters for exactly `{ apply, inject }`; **no default export**;
  `__esModule` marker via `__toCommonJS`; no `Symbol.toStringTag`
  (FE-8 accepted).
- **Wrapper intact**: head
  `window.__ModuleLoader__.load({ id: "dsh-mcp-scope", factory: (require) => {`
  … tail `return module.exports;` `});` preserved.
- **No accidental @deepseek-ai value import**: grep-verified in bundle; the
  inject list `['slots','locale','remote','remote.credentials','settingsScope',
  'workspaces']` rides as a string array (bundle line 1664) — `connection`
  absent.
- **Consumer d.ts**: `verify:package` consumer typecheck green for host + the
  `dsh-mcp-scope/client` entry (24 re-exported names) against the freshly
  built `lib/types`.
- Deterministic: two consecutive builds byte-identical (sha in §1).

## 5. Check 4 — regression spot checks (code-level)

| Item | Result | Evidence |
|---|---|---|
| Header add/cancel toggle vs an open edit form; staged replaces; lost drafts | **Clean** | One staged session at a time; switching requires closing first (header becomes Cancel while `formOpen`); cards are `actionsDisabled` whenever `staged !== null` (R2U-05, LIVE P4); the only draft-discard path left is explicit Cancel after a failed save — cleanup already ran (UX-02), acceptable. |
| Busy fence during save | **Fixed** | `section.tsx:81/121–139` (busy lifts to header), `add-form.tsx:291/583–588` (saving disables both form buttons); header cancel disabled while a save is in flight (R2F-2, LIVE P11). Cross-card writes during a form save are still possible (R2F-6 accepted — second writer loses with a truthful conflict banner). |
| justSaved focus by element id | **Clean** | Card header id `mcp-scope-card-<serverName>`; serverName is `[A-Za-z0-9_-]{1,32}` — id-safe, and `getElementById` matches any id verbatim (no CSS-escaping hazard); target `<strong tabIndex={-1}>` is programmatically focusable (render spec asserts `activeElement` id). Focus effect no-ops silently if the commit ever lands late (accepted, §8 a4). |
| Removal cascade copy accuracy | **True with one refusal-corner over-promise** | Controller prunes override rows AND unsets doc-orphaned refs only after a landed write (`controller.ts:597–608`, spec 571); copy "Credentials that no remaining server references are cleared as well." is accurate except when the credentials domain refuses the unset (best-effort swallow) — §8 b4. |
| Off-count gating with loading/error | **Clean** | `offCount` only computed when the workspace list is settled (`server-card.tsx:123–126`); chip suppressed during loading/error (render spec 255–272); `isEnabled` reads are live so the chip tracks the doc. |
| Credentials badge lifecycle after cleanup unsets | **Clean** | `unsetCredential` refreshes (`controller.ts:630`), `unsetQuietly` refreshes after cleanup (`723`), `onCredentialRefUpdated` retries gated on the doc ref set (`513–516`); FE-6 generation guard prevents stale publishes. |
| replaceServer rename behavior & hint discoverability | **Migration correct; hint absent** | Rename migrates per-workspace off rows (`controller.ts:588–592`; spec 646), vanished original ⇒ conflict (spec 660), name collision ⇒ invalid (spec 672), UI duplicate gate excludes self (`section.tsx:116–118`). No en/zh copy anywhere tells users that renaming moves their switches — undiscoverable polish residual (§8 a3). |
| Reserved names (`__proto__` etc.) | **Partial — see F1** | The three blocked names get a live message (P1) + host `validateDoc` backstop; the rest of the `Object.prototype` key space is not blocked and not own-key-safe. |
| Header-name with spaces | **Clean** | RFC-9110 tchar pattern in the shared model + live UI message (P3); closes the round-1 IMPL-11 gap. |

## 6. Check 5 — first-run experience

- **Zero servers**: "No MCP servers configured yet." + Add button; opening Add
  autofocuses the name field (spec). **Servers but zero workspaces**: card +
  "No workspaces yet" + "On by default…" caption. **All workspaces off**:
  rows show `Off`, chip counts them; nothing contradicts the default-on model.
- **40-workspace scroll/overflow**: rows render inline per card; a 40-row card
  is a few hundred DOM nodes — trivially fine (round-1 benchmark: ~1 ms @ 20
  rows, 11–14 ms @ 1000); no virtualization needed at this scale; the settings
  shell scrolls. **Noted as acceptable**, not a gap.
- **Keyboard / Tab**: add form is one real `<form>` — Enter submits only via
  the form's submit button; while the draft is invalid the submit button is
  disabled and implicit Enter-submission is a browser no-op, so there is **no
  unintended submit path** (radios are in a named group inside the same form;
  Enter on a focused radio would submit — but only when valid, by design);
  every other button is `type="button"` (spec #6). Tab order: header
  Cancel/Add precedes the form, name → transport → rows → Save/Cancel — sane.
  Esc is handled only for the remove confirm (F2 covers its bug); the form has
  no Esc-to-close — acceptable minimal-chrome choice.

## 7. Round-1 / round-2 disposition matrix vs the CURRENT tree

| ID (round 2) | Disposition now | Evidence |
|---|---|---|
| R2U-01 validation dead end | **PARTIAL** | Content-carrying problems reveal live while typing (pattern/duplicate/reserved/token/url — P1/P3); but pure *emptiness* (empty name/command/url) never reveals because `attempted` is unreachable while Save is disabled → **F3**. |
| R2U-02 conflict copy | **FIXED** | `error.conflict` + `error.conflictKeptRefs` appended by `failureText`; unit + probe evidence (§2). |
| R2U-03 banner placement/dismiss | **PARTIAL → accepted** | Dismiss × now exists (comment claim truthful, `server-card.tsx:99–100/230–237`); banner still card-top, not row-local, no scroll-into-view — accepted at this scale (§8 a2). |
| R2U-04 focus/dialog semantics | **PARTIAL** | Esc handler added but its focus return is a no-op (**F2**); no `role="dialog"` on the confirm; remove-success and form-cancel still drop focus to `<body>` (accepted §8 b1). |
| R2U-05 draft-destroying switches | **FIXED** | `actionsDisabled` on cards (P4); only same-server Edit→Edit re-seed case was remounting anyway. |
| R2U-06 unknown-badge recovery | **not addressed — accepted** | Event-driven retry only; no timer/affordance (§8 a1). |
| R2U-07 copy nits | **1–2 FIXED, 3–4 accepted** | `secret.clearing` label, single-char `…` both locales fixed; per-card load/error repetition + rename-migration silence accepted (N3/N4, §8 a3); new nit: dead `state.clearing` key. |
| R2U-08 suite quality | **PARTIAL — accepted** | Locale-keyed assertions improved; remove/invalid-gate/timer coverage still absent (my probes covered the behavior, not the suite). |
| R2F-1 removal prune | **FIXED** | `controller.ts:601–606` + pipeline test 571 (was dead code at round-2 review). |
| R2F-2 mid-save teardown | **FIXED** | Section busy fence (P11). |
| R2F-3 reserved names | **PARTIAL** | 3 names + message; prototype-key class open → **F1**. |
| R2F-5 pre-describe preconfigured window | accepted | Unchanged narrow race; overwritten value unrecoverable either way. |
| R2F-6 no controller-level fence | accepted | Truthful conflict copy now softens it (§8 a6). |
| R2F-7 comment overclaim | **FIXED** | Dismiss exists; comment matches. |
| Round-1 UX-01…19 | as round-2 table, plus above | No re-opened item beyond R2U-01/03/04 tails tracked here. |

(Doc-drift note: `docs/review/round2/fix-verification.md` describes the
pre-fix tree — its §1 IMPL-5 row and sha `71b4144d…` are superseded by the
fix commits; a SUMMARY refresh is a release-docs task outside this file's
scope.)

## 8. New findings

| ID | Sev | Where + evidence | Why it matters | Fix |
|---|---|---|---|---|
| **F1** | Med-low | `SERVER_NAME_PATTERN` allows `toString`/`valueOf`/`hasOwnProperty`/`toLocaleString`/… and `RESERVED_OVERRIDE_KEYS` blocks only `__proto__`/`constructor`/`prototype` (`model.ts:14,96`). Presence reads are prototype-inheriting: `isEnabled` → `row[serverName] === undefined` (`model.ts:66–69`) and `overrideDoc`/`diffOverrides` use `name in row` (`controller.ts:174,217–218`). Override rows are plain objects, so a name matching an `Object.prototype` member with **no own entry** resolves to an inherited function ⇒ `isEnabled` = false (OFF) in every workspace whose row contains any other off server, and the enable plan is empty (toggle "succeeds" with zero ops, `controller.ts:616–617`) — the switch is stuck OFF with no message. **LIVE P8**: `toString` card renders `Off` in ws-1 (`git` off there), click fires the action but the row stays off. Host half reads the same way (`agents.ts:227,232`), so a re-added/named agent is dropped in those workspaces too. Toggle-off→on cycles also can't recover (own key deleted ⇒ inherited read again). | Legal input silently corrupts the default-on model and cannot be fixed from the UI — the "reserved names" guard round 2 added is an incomplete workaround for the real defect: prototype-inherited reads. | Make presence semantics own-key: `Object.hasOwn(row, serverName)` in `isEnabled`, `overrideDoc`, `diffOverrides` (had/want), and the model prune helpers; add one regression test with `toString`; optionally extend `RESERVED_OVERRIDE_KEYS` with `Object.getOwnPropertyNames(Object.prototype)`. No copy changes. |
| **F2** | Low | Remove-confirm Esc and Cancel handlers end with `removeButtonRef.current?.focus()` (`server-card.tsx:112–117, 252–256`), but the Remove button is **unmounted while the confirm is open** (header renders it only when `!confirmingRemove`, `209–224`), so the ref is null at handler time and focus is never restored. **LIVE P5**: after Esc and after Cancel, `document.activeElement` is `<body>`. | The fix round's own focus-return claim (comment `106–120`) doesn't work; keyboard users are dumped to `<body>` after dismissing the confirm. | Focus in a post-render effect keyed on `confirmingRemove === false`, or keep the Remove button mounted (hidden) and ref it, or move focus to the re-rendered button via callback ref. |
| **F3** | Low | Required-emptiness never explains itself: `reveal` fires only for problems with real content or after `attempted`, and `attempted` is unreachable while Save is disabled (`add-form.tsx:291–303, 583`). **LIVE P2**: name filled, command empty ⇒ Save disabled, zero messages. | Round-2's R2U-01 (disabled-Save explain dead end) is closed for invalid *content* but still open for *empty* required fields — the most common first add mistake. | Reveal `required` messages once any field has content (or on blur of a touched field). Optional asterisk/`required` marker. |
| **N1** | Low | Edit flows silently clear stored credentials of refs dropped from the definition: any env/header row removed (or transport switch dropping `envKeys`) orphans the ref and `submitPlan` runs `unsetQuietly` on it after the write (`controller.ts:691–693, 714–724`) — no copy in the edit form discloses the cascade (only `server.removeConfirmBody` does, for removal). | Write-only values vanish server-side without a visible cue; the "blank keeps stored" promise may mislead users into thinking row removal is value-preserving. Shared-ref cross-server impact is the accepted UX-11 model. | Add one localized hint line to the env/header section captions ("removing a key deletes its stored credential"), or document as accepted. |
| **N2** | Nit | Clear failure reuses the secret-**write** verb: `handleClear` catch → `{reason:'secret-write-failed'}` ⇒ "Failed to write credential(s): X" for a failed **unset** (`server-card.tsx:188`). | Misleading verb in a rare banner. | New failure reason or key (`secret-clear-failed` / "Failed to clear…"). |
| **N3** | Nit | zh punctuation: `error.saveFailed`/`secretWriteFailed`/`unexpected` lack the final `。` every other zh sentence (incl. `error.conflict`) carries; en side is uniform. Also `state.clearing` ('Clearing…'/'清除中…') is a **dead key** — the used one is `secret.clearing` (identical text) — a leftover of the R2U-07 fix. | Cosmetic inconsistency; dead dictionary pair invites drift. | Normalize zh sentence endings; delete `state.clearing` or route `secret.clearing` through it. |

## 9. Accepted-risk list (with rationale)

- **a1** Unknown-badge stuck state without a retry affordance (R2U-06): honesty over affordance for v0.0.1; every doc/credential event retries, and the FE-6 guard keeps the UI consistent. Risk: a one-off describe failure stays visible until the next event.
- **a2** Card-top failure banner can sit off-screen for very tall cards; 8 s auto-retire without scroll-into-view (R2U-03 tail). Dismiss × and role="alert" placement are in place; row-local failure rendering is disproportionate for the failure frequency.
- **a3** Rename-migration and edit-drop credential-cascade are undiscoverable from copy (R2U-07.4 / N1): migration is semantics-preserving either way, and cascade matches the documented removal model; copy additions deferred.
- **a4** Focus effect assumes the store commit lands before the effect runs (R2U-08.4): no-op on the rare late commit — benign.
- **a5** Suite debt (R2U-08): transient dismissal timers, remove/clear flows and the disabled-Save gate are not in the shipped suite (behavior verified externally this session). Green suite cannot regress-fence them yet.
- **a6** No controller-level write fence (R2F-6): a second quick write across surfaces loses with a *truthful* "Not saved" conflict banner and full refresh — acceptable single-user-host noise.
- **b1** Focus drops to `<body>` after a successful remove and after canceling the staged form (R2U-04 tail, minus the F2 half): screen-reader users lose position after destructive/form-close actions. Accepted for the minimal-chrome release; F2's Esc/Cancel fix is the cheap half and is recommended anyway.
- **b2** Conflict copy still attributes self-inflicted races to "changed elsewhere"; the leading "Not saved: your change was not applied" is now the operative truthful clause.
- **b3** Clear-failure "write" verb (N2) — banner copy nit on a rare path.
- **b4** `server.removeConfirmBody` promises credentials "are cleared as well" while the unsets are best-effort (inherited-env shadowing refusal swallows); the doc write is already committed at that point, so failure is data-*preserving* — safe direction.
- **b5** Enter anywhere in a valid add/edit form submits and closes it (implicit submission): standard single-form behavior; fields remain editable via re-open (Edit keeps the draft).
- **b6** "Unexpected error." for a controller-level `invalid` (e.g., a true duplicate arriving between UI check and save) — narrow race, generic copy.

## 10. Prioritized pre-release actions

1. **F1 — own-key override semantics** (`Object.hasOwn` in `model.isEnabled`
   + `controller.overrideDoc`/`diffOverrides`, extend or replace the reserved
   list with the full `Object.prototype` name set, 1 regression test). ~6
   lines + test; closes a legal-input functional corruption that reaches the
   host agent applier too. **Recommend landing before v0.0.1**; if the release
   train cannot take it, ship and fix in v0.0.1+1 — F1 does not corrupt data,
   only inverts default-on for exotic names in shared override rows.
2. **F2 — make the Esc/Cancel focus return real** (post-render effect focus on
   the Remove button). One-line-class fix; otherwise remove the broken claim
   from the comment so the shipped code doesn't overpromise.
3. **F3** — reveal required-emptiness on content/blur (small `reveal` change +
   1 render test).
4. **N2/N3** — copy nits batch (unset-verb key, zh `。`, drop dead
   `state.clearing`). Pure dictionary changes, both locales, no logic risk.
5. **N1** — hint copy for the edit-drop cascade, or record in release notes as
   intended semantics.
6. Post-release suite hardening (a5): fake-timer dismissal test, remove/clear
   render tests, invalid-draft reveal test.

Nothing in F2–N3 or the accepted list should hold the release; F1 is the only
item with user-visible wrong behavior on valid input, and it is either a tiny
pre-ship fix or an explicitly tracked v0.0.1+1 item.
