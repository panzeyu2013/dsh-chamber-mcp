# Round-2 frontend review — dsh-mcp-scope browser half (post-fix re-verification)

Reviewer: frontend reviewer (round 2). Scope: (1) disposition verification of
FE-1…FE-11 against the CURRENT tree, (2) fresh review of the rewritten
`src/client/**` + `tests/client/**` (priority), (3) re-verification of bundle
purity and the register/inject framework face after the wiring changes (inject
list, `connection` drop, `remote.credentials` row, new `replaceServer` face
action, edit/chips/banners components). Evidence: repo sources, the built
`lib/client.js` (deterministic sha256 `71b4144d…` across two consecutive
builds, this session), the installed 0.1.2-rc.1 dev tree
(`node_modules/@deepseek-ai`), and the gateway anchor install
(`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai`). Live runs
this session: vitest **126/126 (11 files)**; `npm run typecheck` (src + tests)
green; consumer d.ts typechecks (original `.smoke/consumer` and new
`.smoke/consumer2`) green.

---

## Verdict

**All 11 round-1 frontend findings are resolved as claimed, and the fix round
introduced no bundle, framework-face, or controller regression.** FE-1, the
one major, is fixed by a post-mutate read-back (`applyOps`) whose design is
sound against the *real* rc.1 scope client — verified in the shipped
`dsh-client-ui-settings` implementation, not just the fakes (the mirror folds
the write answer synchronously before `mutate()` resolves; on refusal
`recover()` re-reads the host before resolving; therefore the re-read can
never race a second-tab write and false conflicts are structurally
impossible). The typed-code classification (FE-2) is now belt-and-suspenders
on top of the read-back, which is the authoritative signal — appropriate,
because the real runtime *resolves* on business refusal and only throws
typed `RemoteError` (with `.code`) on transport faults.

New findings: 2 minor, 5 nit/informational (R2F-1…R2F-7). The one with real
behavioral impact is **R2F-1**: `McpScopeController.removeServer` never prunes
the removed server's per-workspace off-switch rows — `removeServerOverrides`
is dead code referenced only by tests — so re-adding a server under the same
name later silently resurrects it as **off** in every workspace that had
disabled it. Everything else is doc drift, copy/comment overclaim, and
narrow-race hygiene.

| area | verdict |
|---|---|
| 1. Bundle contract & purity (rebuilt) | **pass** — requires only `react` (3) + `react/jsx-runtime` (3); exports exactly `{apply, inject}`, no default; wrapper intact; new code added zero imports |
| 2. Entry & registration (post-change) | **pass** — inject list `['slots','locale','remote','remote.credentials','settingsScope','workspaces']` all real ctx services, dotted row matches official rc.1 bundles verbatim; `connection` drop grep-proven; register options + face → `useDoc`+actions mapping re-verified in the shipped renderer |
| 3. Controller & React | **pass** — FE-1 read-back verified against the real scope client; edit-mode state machine, per-card banners, chips, controlled rows, mount guards all sound; R2F-1/R2F-2 exceptions below |
| 4. Typing & structure | **pass** — FE-10 re-exports compile from a fresh consumer (24 names); no new casts; no `as any` |
| 5. Framework-injection match | **UNCHANGED (matches)** — face gains `replaceServer`, a flat pass-through action; `hooks:{doc}` seat untouched |
| 6. Locale | **pass** — new keys full en/zh parity; placeholders param-matched; plural `{one,other}` pairs resolve via `countKey` |
| 7. Build/test hygiene | **pass** — deterministic build, green suites, render spec now drives real async flows through framework-free harness only |

---

## FE disposition table (current code)

| ID | Claimed | Verdict | Evidence |
|---|---|---|---|
| FE-1 | Post-write read-back compare; refusal ⇒ conflict; new-secret auto-unset | **FIXED** | `applyOps` (`controller.ts:712–729`): after `await mutate` → `refresh()` → `docsEqual(this.snapshot.doc, expectedDoc)`; mismatch ⇒ `{ok:false,reason:'conflict'}`, never ok. Real-runtime grounding (repo `dsh-client-ui-settings/lib/client.js:1040–1061`): refusal ⇒ `recover(generation)` = `await mirror.load()` then **resolve**; success ⇒ `mirror.acceptView(response.value)` **before** resolve; mirror re-run protection at `acceptView` (lines 1265–1296) prevents a stale in-flight describe from publishing pre-write state. So the post-settle re-read is synchronous against an already-folded mirror — the "second tab between mutate-settle and read-back" false-conflict window cannot exist on the real client. Every caller passes the correct intended doc: `addServer` (`557–558`), `replaceServer` (`576–581`), `removeServer` (`589–593`), `toggleWorkspace` (`604–605`, override-only op with `next = overrideDoc(base…)`). Cleanup on refusal: `submitPlan` `667–670` → `cleanupNewlyStored` with `preconfigured` exclusion (`647`, `680–686`). **Normalization tolerance**: `serverDefEqual` (`92–113`) treats absent `args`/`cwd`/`envKeys`/`headers` as empty and ignores key order — exactly the schema-default fills (`schema.ts:38–47` `args: default([])`, `cwd: default('')`, …) a validating host could add; overrides are compared as key sets after symmetrical row pruning (`normalizeDoc`/`decodeDoc`). Read-back is intentionally whole-doc strict otherwise (server order matters) — right call: any genuine superseding write *should* read as conflict. Tests: `controller.spec.ts:472–499` (resolve-without-write ⇒ conflict, incl. toggle), `501–525` (overlap), `527–551` (preconfigured never unset), `570–583` (revision pass-through) |
| FE-2 | Typed `code` + `isDSHRemoteError` first, message scan as backstop | **FIXED** | `classifySaveError` (`controller.ts:291–307`) checks `code === 'settings/conflict' \|\| 'SETTINGS_CONFLICT'` first, then `isDSHRemoteError`, then message scan. Real-runtime question answered: the business refusal path never *throws at all* (see FE-1), so classification is only reached on genuine transport rejections — and those are **typed**: anchor `dsh-api-gateway/lib/client.js:30–44` `RemoteError extends Error { code; details; isDSHRemoteError = true }`, rebuilt per failure ("`throw result.error` keeps throw semantics"). `.code` is populated on the real path; the message scan is dead on typed errors and only a backstop for local/non-platform throws. The conflict signal that matters (read-back) is code-independent — exactly right |
| FE-3 | `remote.credentials` added; `connection` dropped | **FIXED** | `index.ts:119`: `['slots','locale','remote','remote.credentials','settingsScope','workspaces']`. Each name is a real ctx service: `slots`/`workspaces`/`remote`/`locale`/`settingsScope` merges verified in repo-tree d.ts (`dsh-client-runtime/lib/types/client/index.d.ts:92–117` + GlobalStandardProps `useWorkspaces`; ui-settings/locale augmentations); **`remote.credentials`**: dotted rows are the official vocabulary on the identical runtime — anchor bundles list exactly this style: settings-plugins `["slots","locale","remote","remote.credentials","remote.session","settingsScope"]`, settings-models adds `"remote.credentials"`/`"remote.settings"`/`"remote.llm"`, settings-general `"remote.settings"`; `dsh-client-ui-workspace` injects `"workspaces"` and calls `ctx.get("workspaces")` (precedent for our workspaces row). Runner gates activation on declared inject names (`dsh-cordis-client-runner/lib/client.js:320–323, 581`), so dotted names must resolve on the real runtime — they do (official production bundles use them). `connection` drop: grep of `src/client` shows zero runtime `ctx.connection` access (only explanatory comments, `index.ts:12–15, 128–129`); access pattern is `ctx.remote.credentials.*` wrapped by `remoteCredentials()` (`101–113`) with `unwrap` copying `code` (`93–98`) |
| FE-4 | Async pipeline tests over real-semantics fakes | **FIXED** | `controller.spec.ts:421–639` (41 controller tests total). Fakes model the real scope: `FakeScope.mutate` (347–360) **resolves without writing** on revision mismatch and on `refuseNext`, mirrors the ui-settings refusal+reload; `FakeCredentials` with gates/fail sets/deferred describes. Coverage: secret-before-doc ordering via op log (422–445), abort-on-secret-failure **before** doc write + new-ref cleanup (447–470), resolved-but-unlanded add ⇒ conflict + secret unset (472), same for toggles (489), mid-save external commit fences the write (501–525), preconfigured refs never unset on conflict (527), orphan unsets only after committed removal (553–568), `expectedRevision` pass-through on add/toggle/remove (570–583), `replaceServer` in-place (585), rename migrates override rows (603–615), missing-target and name-collision guards (617–638), FE-6 out-of-order describe + ref-event retry (641–694). Residual gap (accepted): no pipeline-level test of a *rejecting* mutate (thrown typed `RemoteError` through `applyOps`/`classifySaveError`) — the classifier is unit-covered (231–259) and the refusal semantics are resolve-based on the real client, so the gap is minor |
| FE-5 | Hand-rolled styling vs primitives/tokens | **ACCEPTED** (unchanged by design) | Components still use inline styles/literal colors (`server-card.tsx:41–48, 177–178`; `add-form.tsx:354`, section `57–64`); no `@deepseek-ai/dsh-client-ui-primitives` or `--dsw-*` tokens. Consistent with SUMMARY disposition (minimal-UI stance, revisit when tokens pinned); purity gate would permit primitives |
| FE-6 | Describe-race guard | **FIXED** | `controller.ts:434–435, 515–549`: `credentialsGeneration` bumped at every describe start (and on the empty-refs invalidation path); publish requires `generation === credentialsGeneration` **and** the doc's ref set still equals the described set; stale runs discarded without bumping `credentialsAt`. Empty-refs path clears stale maps only when non-empty. Disposal bumps generation (`481`). Tests 642–677 prove a late-stale run neither publishes nor bumps |
| FE-7 | design.md children claim + ui-notes wording | **FIXED** (claim corrected; residual drift → R2F-4) | `docs/design.md §5` no longer declares `children:` and now documents the real registration with "no child slots" (`design.md:88–94`); `ui-notes.md:35` says "initially skipped". The broader stale-claim drift (inject list, test counts, classification description) survives in design.md/ui-notes.md — R2F-4 |
| FE-8 | Interop markers | **ACCEPTED** (unchanged) | Bundle still ends `module.exports = __toCommonJS(index_exports)` (`lib/client.js:31`), `__esModule` + getters, no `Symbol.toStringTag`, no default export; loader consumes raw exports; cosmetic only |
| FE-9 | Hardcoded placeholders/ellipsis | **FIXED** | `add.headerNamePlaceholder`/`add.credentialRefPlaceholder`/`add.secretPlaceholder`/`add.ellipsis` keys (`locales.ts:86–89`; used `add-form.tsx:365, 461, 517, 526, 534`); all row-button copy through `t()`; full-string scan of the three components found no remaining hardcoded user-visible text besides composed id/aria-label prefixes |
| FE-10 | Client types reachable | **FIXED** | Type-only re-exports from the entry (`index.ts:59–76`); built `lib/types/client/index.d.ts` re-exports section/controller/add-form/server-card/workspaces/locales/shared types. Consumer check: new `.smoke/consumer2/consumer-check2.ts` imports **24 names** (`McpScopeSectionProps`, `McpScopeFace`, `SaveOutcome`, `SaveFailure`, `ServerSaveInput`, `SecretWrite`, `SettingsScopePort`, `CredentialsGateway`, `RemoteResultLike`, `McpStoreSnapshot`, `McpStoreSource`, `SectionT`, `SnapshotHook`, `ServerCardProps`, `AddServerFormProps`, `AddDraft`, `AddProblems`, `WorkspaceItem`, `WorkspaceListHook`, `WorkspaceListStatus`, `SettingsKey`, `McpScopeDoc`, `ServerDef` + values `inject`/`apply`) via package self-name `dsh-mcp-scope/client` — **tsc green** (only a probe arithmetic error in my own check file, fixed) |
| FE-11 | Mounted guards incl. new edit/save flows | **FIXED** | `section.tsx:80–86` mounted ref; `handleAdd`/`handleEdit` (`116–132`) check `mounted.current` after the awaited action before `setStaged`/`setJustSaved`; `add-form.tsx:276–282, 329–337` guard all post-await state writes and the success path skips trailing writes (form closes via `onClose`); `server-card.tsx:88–94` + all three handlers (`136–174`) return after unmount; banner/note timers are effect-owned and cleaned up on unmount; the focus/scroll effect (`section.tsx:98–101`) is a DOM read only — harmless after unmount. Residual: header-level cancel during an in-flight save is not fenced — R2F-2 |

---

## New findings (round 2)

| ID | Sev | Evidence | Why | Fix |
|---|---|---|---|---|
| R2F-1 | minor (behavioral) | `controller.removeServer` (`controller.ts:585–594`) passes `overrides: base.doc.overrides` **unchanged** — no `removeServerOverrides` call; grep shows `removeServerOverrides` (`shared/model.ts:73–85`) referenced only by `tests/host/model.spec.ts` and one `buildSaveOps` unit test (`controller.spec.ts:117–131`) that constructs the pruned doc itself (never exercises the controller path). Its own docstring: "a removed server cannot resurrect as off … when it is later re-added"; the removal-confirm copy promises "its configuration is deleted" (`locales.ts:43`) | Every removal leaves the document carrying `overrides[w][name] = true` rows for the removed name. The UI renders no trace of them (cards only for live servers) and the read-back stays green (expectedDoc keeps the rows too, `589–593`), so nothing flags it — but re-adding the same serverName later silently comes back **off** in exactly those workspaces, contradicting the documented default-on model and the confirm copy | `removeServer` should build `next.overrides = removeServerOverrides(base.doc.overrides, serverName)` so `buildSaveOps` emits the prune ops (the covered op shape already exists — `controller.spec.ts:125–130`); add a pipeline test `removeServer → re-add → enabled everywhere` |
| R2F-2 | minor (UX) | While a staged save is in flight, only the form's own buttons are disabled (`add-form.tsx:566–571`); the section-header toggle (`section.tsx:139–149`) stays live and clicking it unmounts the form mid-save. `handleSave` then finds `mounted.current === false` (`add-form.tsx:329`) and silently drops the outcome | The write is not abortable (controller has no cancel); secrets may already be stored and the doc write may land — with no success note, no failure banner, and the form gone, the user believes the save was cancelled. Outcome consistency is preserved (cleanup still runs for refused writes) but the signal is lost | Disable/guard the header toggle while the form reports saving (lift `saving` up or pass an `onDirty` flag), or keep the form mounted until the in-flight save settles |
| R2F-3 | nit | `SERVER_NAME_PATTERN` accepts `constructor`/`__proto__`/`prototype`; `evaluateDraft` checks only pattern+duplicate (`add-form.tsx:98–105`) so such a name passes UI validation, then `submitPlan`'s `validateDoc` rejects with `reason:'invalid'` (`controller.ts:642`), rendered as the generic `error.unexpected` text (`failureKey`, `controller.ts:317–328`) | Reserved names are legal-looking until the final error, then get a misleading message | Flag reserved names in `evaluateDraft` (new `validation.reservedName` key) or map `invalid` to a targeted message at the form |
| R2F-4 | nit (doc drift) | `docs/design.md:89` still declares the pre-FE-3 inject list `['slots','locale','connection','remote','settingsScope','workspaces']` (no `remote.credentials`, stale `connection`); `docs/ui-notes.md:66–68` same, plus §2 (lines 26–36) still reports "3 files / 39 tests" and §3.5 (158–162) still describes message-scan classification | Docs contradict the fixed code/SUMMARY; a reader following them would re-introduce the FE-3 drift or the FE-2 regression | Align design.md §5 + ui-notes §2/§3 with `index.ts:119` and the typed-first classifier; update test counts |
| R2F-5 | nit (race hygiene) | `submitPlan` computes `preconfigured` from the badge map at call time (`controller.ts:647`, `wasConfigured` 621–624); the map is filled by the async describe launched at `start()` (`474`) and refreshes. A Save issued before the first describe settles can misclassify a pre-existing ref as "new" | On a refused doc write the cleanup then unsets that ref (`669`, `684–685`). The old value was already overwritten by this attempt's own successful `set`, so it is unrecoverable either way; the practical effect is a shared ref ending unconfigured for *other* servers instead of keeping the new literal. Narrow window (cards render before badges settle; Save needs a filled form) | Mitigate by describing the dirty refs before deciding `preconfigured` (or treat any ref the failed attempt wrote as keep-if-set, since the doc write refused), and document the choice |
| R2F-6 | info | No controller-level write fence: two saves on different cards, or a card action plus a form save, can be in flight together (per-surface guards only serialize within one card/form; the scope tail serializes the wire writes) | Both mutates carry the same captured revision; the host commits one and refuses the other, which surfaces as a conflict banner on the slower surface — semantically correct, mildly noisy | Accept (single-user host, low frequency); optional: a controller `busy` promise that parks later submits until the current one settles |
| R2F-7 | nit | `server-card.tsx:9–10` docstring: the failure banner "clears when the next action starts **or is dismissed**" — there is no dismiss affordance; it only auto-retires (8 s timer, `97–101`) and clears on the next action or confirm-cancel | Copy overclaims an a11y behavior; `role="alert"` content that vanishes after 8 s can also be missed by slow readers (auto-retire is a deliberate trade-off, fine) | Drop "or is dismissed" from the comment; optionally leave dismiss to the section-level re-announce pattern |

---

## Bundle & purity re-verification (rebuilt this session)

`node scripts/build.mjs` → typecheck + decl pass + host JS + esbuild CJS
wrapper; **deterministic**: sha256 `71b4144d1590aa611e75463a257432bd2d02583e4e3a0d0a71d54f958893c035` on two consecutive builds.

- **Require sites** (complete set): `3× require("react")`, `3× require("react/jsx-runtime")` — nothing else; zero `require("@deepseek-ai/…")`, zero inlined JSX helpers. The fix round's new code (edit mode, chips/banners, replaceServer, per-card/form banners) added no imports whatsoever: `src/client/**` value imports are react + relative modules only (`controller.ts:23`, `index.ts:24–32`, `section.tsx:15–22`, `add-form.tsx:16–24`, `server-card.tsx:15–21`); every `@deepseek-ai` import is `import type` (erased).
- **Exports**: exactly `{ apply, inject }` via lazy getters (`lib/client.js:27–30`); **no default export**; `__esModule` marker from `__toCommonJS`; no `Symbol.toStringTag` (FE-8 accepted); no `sourceMappingURL` (cleaner than official).
- **Wrapper**: `window.__ModuleLoader__.load({id:'dsh-mcp-scope', factory})` head + `return module.exports` tail intact.

## Register/inject face after the changes

- **Inject list** rows all resolve as ctx services (see FE-3 evidence): `slots`, `locale`, `remote`, `remote.credentials` (dotted row — official bundles list the same names against this exact runtime), `settingsScope`, `workspaces` (official ui-workspace precedent). No `connection` anywhere in runtime code; the only remaining mentions are the explanatory FE-3 comment (`index.ts:9–17`) and a wire comment (`129`) — no stale code path.
- **Face shape still maps**: shipped renderer (`dsh-client-web-react/lib/index.js:206–226`) `bindInjectHooks`: `hooks.doc` → `useDoc` (`use${Cap}`), remaining members (`addServer`, **new `replaceServer`**, `removeServer`, `toggleWorkspace`, `unsetCredential`) pass through verbatim into the composed props; `McpScopeSectionProps` (`section.tsx:44–55`) destructures exactly that set plus the `close` owner share, `t` locale seat, and the `useWorkspaces` GlobalStandardProps seat. Register options (`index.ts:159–171`) — `{name, id, order, label-thunk, locale: NS, inject: () => controller.face()}` — are unchanged and valid against `SlotCore.register`. The credentials surface is reached as `ctx.remote.credentials.*` through the local wire wrapper (`index.ts:134–135, 101–113`) — matching official settings-models/plugins usage (`ctx.remote.credentials.describe/set/unset`); `ctx.get('remote')` is not used by us.

## Component/controller correctness (new code)

- **Edit-mode state machine**: `AddServerForm` is keyed per session (`key="add"` / `key={edit-${original.serverName}}`, `section.tsx:154–177`) so switching card A → card B (or add → edit) remounts with a fresh `useState(props.initial)`; same-server reopen also remounts (form unmounts between). The one preserved-instance case (Edit A → Edit A again while open) intentionally keeps the user's in-progress draft. Edit-prefill staleness vs doc changes is handled by the controller's conflict path, not by prop syncing — deliberate.
- **Per-card banners**: failure state lives inside `ServerCard` (keyed by `server.serverName` at the list, `section.tsx:190–193`) — per-card identity, replace-not-accumulate (`setFailure(outcome)`), cleared when the next action starts or on confirm-cancel, 8 s auto-retire with effect-owned timer.
- **Chips/summary**: chip text is plain React text/code children — escaped by default; URL/command lines use `text-overflow`/`title` — no HTML injection surface.
- **Focus effect** (`section.tsx:98–101`): runs post-commit with the affected card present (uSES store update and the success `setState` settle in the same batch before the effect); rename success targets the new id; missing element is a silent no-op. Render spec asserts the happy path incl. `document.activeElement`.
- **Controlled rows**: args/env/header rows fully controlled, keyed by index with append/remove-only mutation; the render spec + controller validation cover remove-middle correctness (values re-read per render). Add/remove-row buttons are `type="button"`; rows are disabled while saving.
- **attemptNewRefs lifecycle** (`newlyStored`/`preconfigured`): locals per `submitPlan` call — no leakage across saves; reset on every path (failure ⇒ cleanup+return, refusal ⇒ cleanup+return, success ⇒ kept); cancel (form close) touches nothing in the controller.
- **refreshCredentials call sites** after cleanup: `unsetQuietly` refreshes (`controller.ts:698`), refusal/secret-failure paths reach it through cleanup, `onCredentialRefUpdated` retries quiet failures; all guarded by `disposed` and the FE-6 generation.
- **In-flight fence**: per-card `busy`/per-form `saving` guards exist and are correct; no controller-level fence (R2F-6).

## Locale, render-spec, consumer checks

- **Locale parity** (e): new keys (`edit.*`, `server.edit/remove*`, `error.conflict/saveFailed/secretWriteFailed/unexpected`, `validation.*`, placeholder/hint keys, `add.ellipsis`) exist in en **and** zh with matched `{count}/{name}/{path}/{refs}` placeholders — `locales.spec.ts` (4 tests) + zh-mirror assertion in the render spec green; plural `{one,other}` pairs resolved through `countKey`.
- **jsdom render spec** (f): 10 tests now drive real async flows (add/edit success announce + focus move, refused save keeps the form open with its own `role=alert`, per-card toggle failure banner, workspace loading/error gating, real `<form>` submit wiring, autofocus). Framework-free path only (hand-rolled `propsOf` fakes; no `SlotCore.register`, no renderer import) — appropriate. Brittleness is low: 20 ms real-timer flush, effect-cleanup on unmount, `setValue` via the native setter; focus assertions rely on jsdom's `focus()` support with `tabIndex={-1}` targets (stable).
- **Consumer d.ts** (g): see FE-10 — self-name `dsh-mcp-scope/client` resolves all value + 24 re-exported type names against the freshly generated `lib/types`.

## Prioritized actions

1. **R2F-1** — prune override rows in `controller.removeServer` via the existing `removeServerOverrides` helper (re-add must not resurrect as off); add the controller-path pipeline test.
2. **R2F-2** — fence the section-header cancel while a staged save is in flight (or keep the form mounted until settle) so a mid-save cancel never silently swallows a landing write.
3. **R2F-4** — doc drift: design.md §5 / ui-notes inject-list, test counts, classification description (aligns with fix-verification R2V-4).
4. **R2F-3 / R2F-5 / R2F-7** — reserved-name UI validation with a targeted message; decide the pre-describe-save cleanup policy for shared refs; comment fix.
5. **R2F-6** — accept or add a controller-level submit fence; no action required for FE-5/FE-8 (accepted dispositions).

## Remaining runtime unknowns (unchanged from round 1)

- End-to-end proof of the register/inject face still requires a chamber-GUI smoke — static verification + shipped-renderer tracing remains the strongest available evidence.
- Whether a non-loopback (memory-persistence) settings deployment reports `unavailable` — the UI handles all three statuses either way.
