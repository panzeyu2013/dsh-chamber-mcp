# Frontend review — dsh-mcp-scope browser half (Settings section plugin)

Reviewer: frontend reviewer. Scope: bundle contract/purity, entry & registration
correctness, controller & React correctness, typing, component architecture
against the real renderer, locale, build hygiene. Evidence: the repo sources,
`lib/client.js` built during this review (`node scripts/build.mjs`, deterministic
sha256 `0c3d9c5c…` across two builds), the installed 0.1.2-rc.1 client packages in
`node_modules/@deepseek-ai` (repo dev tree), and the gateway anchor install
`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai` (official rc.1
bundles and d.ts). All tests pass (11 files / 87 tests), `npm run typecheck`
green, consumer d.ts check via package self-name green.

---

## Summary verdict

**The browser half is loadable, purity-clean, and its framework-injection
mechanism is a real match for the rc.1 renderer — but its write pipeline trusts a
promise that the real settings scope resolves even when the Host refuses the
write, so conflicts and rejected saves are silently reported as success.** That
is the one finding that changes runtime behavior for users (FE-1, major). The
framework-match question (item 5) is answered **yes**: every prop the component
destructures (`close`, `t`, `useDoc`, `useWorkspaces`, the four actions) is
produced by the actual web-react renderer from the actual registration options —
verified in the renderer's shipped implementation, not just its types, and
mirrored by official rc.1 plugins (agent-preset/web-search cards use the same
`{ hooks: { …: store }, …actions }` face consumed as `use<Name>` props).

Verdict per area:

| area | verdict |
|---|---|
| 1. Bundle contract & purity | **pass** — only `react` + `react/jsx-runtime` requires; no `@deepseek-ai` value import at all; wrapper shape matches official; nits only (interop markers, no sourcemap comment at all — cleaner than official) |
| 2. Entry & registration | **pass** — inject list, effect discipline, `slots.inject` disposer shape, register options all match the installed d.ts; `connection` keep is precedented by official settings-general |
| 3. Controller & React | **fail on one major** (false success on refused writes); the rest (revision on every write path, disposers, hooks order, keys, controlled rows) is sound |
| 4. Typing & structure | **pass with caveat** — 3 contained `as unknown as` casts, no `as any`; none hides a framework mismatch; register-site validation is vacuous under type collapse |
| 5. Real-framework injection match | **MATCHES** (definitive, evidence in §5) |
| 6. Locale & i18n | **pass** — full en/zh parity, params parity, tests; two sample placeholders untranslated (nit) |
| 7. Build/dev hygiene | **pass** — deterministic, layered tsconfigs OK, d.ts consumer check OK |

Findings table: 1 major, 5 minor, 5 nit (FE-1 … FE-11).

---

## Findings

| ID | Sev | Location + evidence | Why | Fix |
|---|---|---|---|---|
| FE-1 | **major** | `src/client/controller.ts:470-483` (`applyOps` catch + unconditional success) vs the real scope: `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js` `mutate()` — `if (!response.ok) { await this.recover(generation); return; }` (**resolves, never rejects**; refusal triggers an internal mirror reload and a silent return). Official compensation: `dsh-client-ui-settings-plugins/lib/client.js` `save()` — after `await this.scope.mutate(…, this.draftRevision)` it re-reads: `const landed = this.currentEnabled() === desiredEnabled && sameRoutes(…); this.failed = !landed;` (and pre-checks `snapshot.revision !== this.draftRevision → conflicted`). Our pipeline returns `{ok:true}` whenever mutate resolves | Every Host-refused write (stale `expectedRevision`, read-only refusal, two-card overlap, second tab) is reported as success: added server silently missing, toggle silently reverts, remove silently no-ops; the conflict banner (`error.conflict`) is effectively unreachable, and a secrets-first add that then hits a refused doc write leaves the stored credential behind with **no** orphan cleanup (cleanup only runs on the success path) | After `mutate` settles, compare the re-read snapshot doc against the intended canonical doc (`normalizeDoc` both sides); mismatch ⇒ `{ok:false, reason:'conflict'}` + publish. Optionally pre-check `base.revision` vs current scope revision before writing (official `draftRevision` pattern). Keep the catch for local faults only. Add a regression test with a scope port whose `mutate` resolves-without-writing (refusal) and one whose `mutate` rejects |
| FE-2 | minor | `src/client/controller.ts:187-194` `classifySaveError` message-scan `/conflict|revision|stale|expected/i`; the platform defines a **typed, code-discriminated** failure: `dsh-api-settings-controller/lib/types/types.d.ts` → `'settings/conflict': { ns, expected, actual }`, `'settings/rejected'`; `index.ts:66-71` `unwrap()` already copies `result.error?.code` onto the thrown Error and nobody reads it | The rc.1 host message (`dsh-settings` `SettingsConflictError`: `…changed since it was read (expected revision N, now M)`) happens to match the regex today; the protocol doc says "Discrimination is always by `code`, never by instanceof/message". Any host copy change silently degrades conflict UX to generic failure | `classifySaveError`: match `code === 'settings/conflict'` first (marker `isDSHRemoteError` second), message scan as backstop only |
| FE-3 | minor | `src/client/index.ts:89` inject list `['slots','locale','connection','remote','settingsScope','workspaces']` — we call `ctx.remote.credentials.*` but no `'remote.credentials'` row; official plugins that call it list it: settings-plugins `["slots","locale","remote","remote.credentials","remote.session","settingsScope"]`, models lists `remote.credentials`/`remote.llm`/`remote.settings`. `ui-notes.md §3.3` justifies `'connection'` ("transport generation") — unverifiable here, but official `dsh-client-ui-settings-general` injects `["slots","locale","connection","remote","remote.settings","settingsScope"]`, so keeping `connection` is precedented | Rows are activation/prefetch edges; missing `'remote.credentials'` risks first-call-before-namespace-mount ordering (today the namespace mounts with the same remotes assembly, so no observed failure — hygiene, not a proven break) | Align with official style: keep `connection` (harmless, matches settings-general) but note the rationale is unsubstantiated, or drop it; either way add `'remote.credentials'` since that is the dotted service we actually call |
| FE-4 | minor | tests: `tests/client/controller.spec.ts` covers only pure helpers (`decodeDoc`, `buildSaveOps`, `toggleOp`, `classifySaveError`); the async pipeline (`submitPlan`, `applyOps`, `unsetQuietly`, refusal & overlap handling) is untested; `tests/client/section-render.spec.tsx` fakes all framework props (`propsOf`) — jsdom bypasses the renderer, so no test would catch FE-1 or a wrong `hooks` seat name | The two highest-risk behaviors (refused writes, cross-card overlap) are exactly the untested ones | Port tests: fake `SettingsScopePort`/`CredentialsGateway` in-memory; assert secret-first ordering, abort on `secret-write-failed` before doc write, orphan unset on success, refusal ⇒ conflict outcome, overlapping saves ⇒ one conflict |
| FE-5 | minor | visual integration: all controls are raw `<button>/<input>` + inline styles with literal colors (`rgba(192,57,43,…)` banner, `#c0392b`, `rgba(127,127,127,…)`) in `section.tsx`, `server-card.tsx`, `add-form.tsx`; nothing imports `@deepseek-ai/dsh-client-ui-primitives` or uses `--dsw-*` tokens, while official cards (anchor `dsh-client-ui-settings-general/lib/client.js` head) require primitives and render token-styled chrome | The page will look non-native in both light/dark themes (no token reactivity), miss design-system focus/disabled/typography behavior, and diverge from Settings chrome | Optional polish: use primitives/`Input`/`Button` + `var(--dsw-…)` tokens (all are in the platform externals table, so the purity gate permits them) |
| FE-6 | minor | `src/client/controller.ts:345-370` `refreshCredentials`: no in-flight guard — two overlapping `describe` runs can publish in reverse order (older ref list wins after a doc change) with `credentialsAt` bumped by the stale run | Transiently wrong badges ("configured"/"unset" for the previous doc's ref set) until the next event/save; window is small (single-user local host) | Capture a generation counter at start; discard results that are no longer current (compare ref list or generation before publish) |
| FE-7 | nit | `docs/design.md` §5 lines 90-92 still declare `children: { 'mcp-scope.settings.row': {kind:'list', scope:'root'} }` in the register options; the implementation (and `docs/ui-notes.md §3.1`) deliberately declares no children — declaring obliges consuming `renderSlot` (`RendersCheck` in ui-slots d.ts); also `ui-notes.md §2` says component render tests were "skipped" while `section-render.spec.tsx` ships 3 passing tests | Doc drift; a future reader following design.md would claim a child slot the entry may not render | Update design.md §5 to the real registration; fix the ui-notes wording |
| FE-8 | nit | wrapper markers: our bundle end is `module.exports = __toCommonJS(index_exports)` ⇒ `{__esModule:true, getters apply/inject}` and **no** `Symbol.toStringTag`; official tsdown artifacts define `Object.defineProperty(exports, Symbol.toStringTag, {value:"Module"})` and no `__esModule`. Loader evidence: `dsh-client-modules/lib/client.js` `makeRequire` returns raw `record.exports` (no interop transform) and nothing imports our package by name | No default export exists (entry exports only `apply`/`inject` + erased type re-exports), so named reads are unambiguous; asymmetry is cosmetic today | No change required; if tsdown parity is ever desired, set the toStringTag in the wrapper. (Also note: our bundle emits **no** `//# sourceMappingURL=`; the official bundle references `client.js.map` it does not ship — a devtools-only 404. Ours is cleaner.) |
| FE-9 | nit | `src/client/add-form.tsx:431,440` hardcoded `placeholder="Authorization"` / `placeholder="AUTH_TOKEN"`; `section.tsx:279` `draft.name.trim() || '…'` param; all other copy flows through `t()` (verified by scan) | Untranslated UI text in a bilingual plugin | Move to `validation.*`/sample keys or drop the sample placeholders; use a locale key for the ellipsis fallback |
| FE-10 | nit | `lib/types/client/*.d.ts` exist for `section/controller/add-form/server-card/workspaces` but `exports` map (package.json) exposes only `./client` ⇒ consumers cannot import `McpScopeSectionProps`/`McpScopeFace` (consumer check: `TS2307 Cannot find module 'dsh-mcp-scope/client/section'`); official packages also expose only the entry but re-export their useful types from it (`dsh-client-ui-settings/lib/types/client/index.d.ts` re-exports `LanguageRowComponentProps`, `SettingsScope…` etc.) | Component/controller types are unreachable by typed consumers | Re-export the face/store/props types from `src/client/index.ts` (they are type-only; bundle unaffected) |
| FE-11 | nit | `src/client/server-card.tsx:49-56,58-66` and `add-form.tsx:248-262`: `setState` in `finally` after an awaited action can run after unmount (e.g. add-success closes the form while `handleSave`'s `finally` still runs `setSaving(false)`) | React 18 silently ignores post-unmount updates — no warning, no leak; strictly a code-smell | Optional: flip a local `mounted` ref, or restructure so the success path skips the state write |

---

## 1. Bundle contract & purity (built `lib/client.js`, 51 744 B, unminified)

**(a) External require sites.** Parse of the built bundle — the complete set of
runtime `require` calls:

```
3× require("react")
3× require("react/jsx-runtime")
```

Nothing else. All `@deepseek-ai/*` imports in `src/client/**` are `import type`
(verified line-by-line: controller.ts:14-16, index.ts:10-13, workspaces.ts:11,
section.tsx:10, server-card.tsx:8) and are erased by esbuild. The only value
imports are relative (`../shared/model.js`, `./locales.js` …) and are inlined.
The frozen platform table in `scripts/build.mjs:25-34` exactly matches the
official list (recon §1/§6); the bundle consumes a strict subset (`react`,
`react/jsx-runtime`). **No extra `@deepseek-ai` value import exists, so the
runtime module table can never miss** — the loader fails loud on such drift
(`dsh-client-modules/lib/client.js`: `require("…") missed the module table — …
a build-time externals drift`).

**(b) Wrapper shape & interop.** Our head/tail:

```js
window.__ModuleLoader__.load({
	id: "dsh-mcp-scope",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
…
module.exports = __toCommonJS(index_exports);   // {__esModule:true, apply, inject} via getters
…
		return module.exports;
	}
});
```

Official head/tail (`dsh-client-ui-settings-general/lib/client.js`): identical
`load({id, factory})`, `var module = { exports: {} }; var exports =
module.exports;` then `Object.defineProperty(exports, Symbol.toStringTag,
{value:"Module"})`, and the tail assigns `exports.apply = apply; exports.inject
= inject; return module.exports;`. Differences: (1) official marks the exports
object with `Symbol.toStringTag`; esbuild marks ours `__esModule` and installs
enumerable getters; both are plain named-export carriers. The loader consumes
`factory(require)` returns **raw** (`materialize` → `record.exports`; `makeRequire`
returns `record.exports` with no default/namespace transform) and no runtime
consumer imports our package by name, so neither marker matters today (FE-8).
(2) No `export default` anywhere in the client entry (exported set is exactly
`apply`, `inject`, type re-exports) — no default-interop hazard. (3) esbuild
emits `module.exports = __toCommonJS(index_exports)` before later module bodies,
which is safe because exports are lazy getters over hoisted declarations.

**(c) sourceMappingURL.** Ours emits none (`grep sourceMappingURL lib/client.js`
→ empty; esbuild `sourcemap:false`). Official bundles append
`//# sourceMappingURL=client.js.map` while the `.map` is not shipped
(verified: no `*.map` in the official lib dir) — a devtools-only 404 request
when DevTools opens. Verdict: harmless both ways; ours produces no request at all.

**(d) jsx-runtime externalization.** Confirmed: `require("react/jsx-runtime")`
at the three TSX module sites; zero inlined JSX helpers in the bundle
(`grep -c 'function jsx'` → 0). No `react-dom` require (nothing uses it) — fine.

## 2. Entry & registration correctness (`src/client/index.ts`)

- **inject list**: `['slots','locale','connection','remote','settingsScope','workspaces']` — every name is a real ctx service on this runtime: `slots` (runtime `SlotRegistry`), `locale`, `settingsScope`, `workspaces: IWorkspaces` (`dsh-client-runtime/lib/types/client/index.d.ts` Context merge), `remote` (`ClientRemote`), `connection` (connection handle plugin; official settings-general also injects it, so keeping it is precedented — see FE-3 for the actual deviation: the missing `remote.credentials` row).
- **ctx.effect**: `apply` casts to a localized `FiberAwareContext` (`index.ts:61-63`, documented at length); the relative cordis augmentation does not merge in this tree (ui-notes §3.4). Both effects match the official idiom (`ctx.effect(() => ctx.locale.register(NS, {zh,en}), '…')` — same signature/label style as `ui-settings-general`). Effect 2 returns a cleanup that disposes `controller.start()` and both `remote.$on` registrations.
- **locale register duplicates**: runtime (`dsh-client-locale/lib/client.js:1264`) throws on `(ns, locale)` duplicates; the disposer removes only its own entries by identity — so effect-teardown + re-register (HMR) is safe. We register exactly once per apply.
- **slots.inject semantics**: `SlotRegistry.inject(key, cb: () => disposer | iterable<disposers>)` — cb "runs synchronously when the declaration already exists … Collapse disposes the effect"; our callback returns the `register()` disposer (correct type; register itself is routed through the caller's `ctx.effect`, so unload cascades). A generator is optional, not required.
- **register options vs `SlotCore.register`** (installed ui-slots d.ts): `{name, children?, store?, locale?, inject?, …KindOptions}`; list-kind = `{id: string, order?: number, label?: SlotLabel, priority?}` with `SlotLabel = string | (() => string)`; `locale?: N extends keyof LocaleNamespaceMap & string`; inject factory params for root/no-store = `[]`. Ours: `id:'mcp-scope'`, `order:25`, `label: () => t('nav')` (valid thunk), `locale: NS` (literal type `'mcp-scope.settings'` ∈ our `LocaleNamespaceMap` merge), `inject: () => controller.face()` (zero-arg) — **all valid**. Duplicate-id guard: `'mcp-scope'` collides with nothing (shell sections: general 0 / models 10 / plugins 15 / agent-presets 20). Declaring **no children** is the correct choice (ui-notes §3.1; the design doc still claims a child slot — FE-7).
- Note: type-collapse means the register site's component check runs against `any`-degraded `ComposedProps` (ui-slots re-exports `dsh-client-store` types that are not installed), so its "validation" is vacuous here; the *manual* trace in §5 is what proves the contract — and it matches.

## 3. Controller & React correctness (`controller.ts`, components)

**FE-1 (major)** is the headline (see table): `scope.mutate` on rc.1 **resolves
after a refused write** (internal recovery reload, silent), so `applyOps`'s
try/catch + `classifySaveError` never sees real conflicts, and success is
reported unconditionally. The official card pipeline instead re-reads and
compares (`landed` check) and pre-flags staleness against a `draftRevision`.
Everything else:

- **Revision fencing**: every doc write passes the revision captured before the write — `addServer`/`removeServer` → `submitPlan(…)` → `applyOps(plan.ops, base.revision)`; `toggleWorkspace` → `applyOps(ops, base.revision)`. `unsetCredential` is a pure credentials-domain op (no doc write). ✓
- **Secrets-then-doc ordering**: dirty secrets are written sequentially before the mutation; a per-ref failure aborts with `secret-write-failed` + failing refs (partial secret writes may have landed — documented in code and ui-notes). Two gaps: no `refreshCredentials()` after that failure, and on a *silently refused* doc write the already-stored credentials are never cleaned up (FE-1).
- **Orphan cleanup**: `unsetQuietly` best-effort with refusal tolerance, only on the success path — correct per design.
- **Subscriptions**: `scope.subscribe` disposer captured in `start()` and released in `dispose()`; remote handlers registered inside the second `ctx.effect`, whose cleanup disposes them; `disposed` guards every async continuation. Clean.
- **Component state**: hooks are called unconditionally before any early return in `McpScopeSection` (stable order); no conditional hooks anywhere. `useState(EMPTY_DRAFT)` means drafts survive document refreshes — which is right for conflict retry, and duplicate names appear live because `evaluateDraft` re-runs against the current `existingNames`.
- **Keys**: server cards keyed by `serverName`, workspace rows by `workspaceId`, refs by `ref` — all unique in a validated doc. Arg/env/header rows are keyed by **index** with append/remove-only mutation and fully controlled values — safe (no keyed state per row).
- **Controlled inputs**: all inputs controlled (value + onChange); checkbox rows use `checked={!off}` with per-row pending lock; radio transport switch resets nothing stale. ✓
- **Focus**: no focus management (no dialogs); the inline remove-confirm keeps focus context simple. Acceptable.
- **setState-after-unmount**: possible in `finally` blocks after awaited actions (FE-11, nit — React 18 tolerates silently).

## 4. Typing & structure

Cast inventory in `src/client`: exactly three `as unknown as` (index.ts:106
remote wire — extensively documented against the anchor's typert types;
controller.ts:163 `JsonValue` widening for the whole-array op; workspaces.ts:28
items narrowing) — zero `as any`. All are contained, commented, and none hides a
framework-shape mismatch: the `McpRemoteWire` re-statement matches the anchor
d.ts (`dsh-api-settings-controller/lib/types/credentials.d.ts`: `describe(refs):
Promise<Record<string, CredentialInfo>>`, `set`/`unset` throwing `RemoteError`,
refusals mapped to `credential/rejected`; typert client folds into
`RemoteResult`, which `unwrap()` handles). The props re-declaration in
`section.tsx` (`McpScopeSectionProps`) is a deliberate local type with the 
register site still checking the component — today against collapsed types
(vacuous, see §2), but the runtime shape is proven by §5. Consumer-side, the
`./client` entry types compile standalone (self-name tsc check OK, including the
`LocaleNamespaceMap` augmentation); subpath/type-reachability nit is FE-10.

## 5. Component architecture vs the REAL renderer — does the injected face reach the component? **YES (verified in the shipped renderer implementation)**

The mechanism is *not* invented. Chain of evidence (all installed packages):

1. **ui-slots types** (`lib/types/index.d.ts`): `InjectFace<I>` — `I extends {hooks: infer HS}` → `Omit<I,'hooks'> & PropsSlotHooks<HS>` where `PropsSlotHooks<HS> = { [N in keyof HS as \`use${Capitalize<N>}\`]: BoundHookOf<HS[N]> }`, and `BoundHookOf` maps a `HostObservable<Snapshot>` source to `SnapshotSelectorHook<Snapshot>`.
2. **Renderer implementation** (`dsh-client-web-react/lib/index.js`, the actual code that ships): `bindInjectHooks(face)` iterates `face.hooks`, computes `hookName = \`use${name[0].toUpperCase()}${name.slice(1)}\``, and sets `bound[hookName] = observableHook(source)` for non-function sources; the rest of the face (`addServer` …) passes through verbatim. `observableHook` = cached `bindSnapshotSelector(source)` (uSES bridge over `getSnapshot`/`subscribe`).
3. **Prop assembly** (`renderEntry`): `jsx(Comp, {...kit, ...injected, ...slotInjected.props, ...ownerProps})` where `kit` = standard props (`standardProps(host,'root')` = `{useSessions: observableHook(host.sessions.list), useWorkspaces: observableHook(host.workspaces.list)}`) + `kit.t = localeSeat(face, entry.locale)` when `locale:` is declared + `close` from the shell's `renderSlot('settings.section', {close}, {only: activeId})` owner share (`SettingsSectionOwnerProps`).
4. Our face `{ hooks: { doc: McpStoreSource }, addServer, removeServer, toggleWorkspace, unsetCredential }` therefore lands as props `{ useDoc, addServer, removeServer, toggleWorkspace, unsetCredential }` — exactly the names `McpScopeSection` destructures. `useDoc` is cached per registration (`rootInjectCache`, keyed by entry), so our per-`face()`-call fresh source wrapper is accessed once; `getSnapshot`/`subscribe` closures read the live controller snapshot (`() => this.snapshot`), and snapshot objects are replaced (never mutated) between publishes — uSES-safe.
5. **Official rc.1 example** (`dsh-client-ui-settings-plugins/lib/client.js`): `inject() { return { hooks: { webSearchCard: this.store }, …this.form.actions() }; }` consumed as `const state = props.useWebSearchCard((snapshot) => snapshot);` — same face grammar, same `use<Name>` consumption; the AgentLoop/Bash/Configurable cards and the section's `tabs` hook repeat the pattern. The official entry registers through the identical `ctx.slots.inject('settings.section', () => ctx.slots.register({…, inject: sectionInjected}, Section))` seam.

One nuance worth keeping: `controller.store` is a **getter creating a new source object per access**; this works only because the renderer caches inject props per entry (one `face()` call, one binding). If anything ever re-injects on the same entry, a second source identity would spawn a second cached uSES hook — harmless but wasteful; making `store` a stable object would be more robust. Not a defect today.

Also confirmed the locale `t` seat renders only when the locale face is installed (`SlotAssemblyError` otherwise — boot order is fine: our dictionaries register in `apply`, the locale plugin is immediately-tier).

## 6. Locale & i18n

`register(NS, {zh, en})` in one call inside `ctx.effect`; `NS='mcp-scope.settings'`
merged into `LocaleNamespaceMap` (compile-enforced key domain); `Record<BuiltInLocaleId, LocaleDictOf<N>>` = both built-ins required — satisfied. Tests assert full key parity, non-empty values, and per-key interpolation-placeholder parity (en/zh `{count}`, `{refs}`, `{name}` — matched 1:1). UI string scan found only the two sample placeholders and the `'…'` param (FE-9); every label/hint/validation/banner/confirm string flows through `t()` with keys type-checked at each call site. Lookup-chain expectation (ns → zh fallback → common → raw key) is framework behavior, not ours.

## 7. Build/dev hygiene

- `scripts/build.mjs`: typecheck (`tsc -p tsconfig.json`, noEmit) → declaration pass (`tsconfig.types.json` into wiped `lib/types`) → host JS pass (`tsconfig.host.json` into `lib`) → esbuild CJS + wrapper. Output deterministic (identical sha256 across consecutive builds). `lib/types` is fully regenerated (no stale-d.ts risk). Tests config typechecked by `npm run typecheck` (`tsconfig.tests.json`), run by vitest (87 pass).
- Layering: `tsconfig.json` (DOM lib added, per ui-notes §4) / `tsconfig.types.json` / `tsconfig.host.json` / `tsconfig.tests.json` (excludes overridden). `@types/react-dom` present; jsx `react-jsx`.
- Consumer check: `.smoke/consumer/consumer-check.ts` importing `dsh-mcp-scope/client` via package self-name compiles clean (types + augmentation reachable). `./client/*` subpaths are not exported (FE-10).
- Dev-dep set is heavy but each listed package is either used by tests/host or needed for client type resolution in this tree (ui-notes documents the missing-store/gateway collapse). No runtime bloat: the shipped bundle inlines only our own modules + react external requires.

## Strengths

- Purity discipline is exemplary: zero runtime `@deepseek-ai` imports, externals table exact, loader-shape wrapper correct, deterministic build.
- The inject face (`hooks: {doc}` → `useDoc` + flat actions) exactly mirrors official rc.1 plugins; the section consumes only props the renderer demonstrably produces.
- Controller layering (framework-free, pure-plan helpers unit-tested, disposer discipline, uSES-stable snapshots, `expectedRevision` on every doc write, secrets-first-then-doc with abort semantics) is clean and well-commented.
- Full bilingual parity with typed keys everywhere; error/empty/read-only/unavailable states all handled; workspace rows render only real workspaces.
- Decode hardening (`decodeDoc` canonicalization, prune) means malformed wire documents cannot crash the UI.
- Register/locale/effect lifecycle follows official idioms (ctx.effect ownership, inject seam, disposer-returning register) — HMR/unload-safe by construction.

## Prioritized actions

1. **FE-1 (major):** post-mutate read-back verification in `applyOps` — treat an un-landed write as `conflict`, never report `ok:true` on a refused write; wire cleanup of credentials stored by an add whose doc write was refused; add controller tests for refusal/overlap.
2. **FE-2:** classify by typed `code` (`settings/conflict`) with the message scan demoted to fallback.
3. **FE-4:** async-pipeline tests (secret ordering, abort, orphan unset, refusal, double-submit).
4. **FE-3:** align the inject list with the services actually called (`remote.credentials`).
5. **FE-6/5/7/9/10/11:** minor robustness & polish items (describe race guard, token-based styling or accept divergence, doc drift fixes, sample-placeholder localization, type re-exports, mount-guards).

## Remaining runtime unknowns (unverifiable from this repo)

- Real-renderer interplay has only been proven statically + against the shipped renderer code and official bundles — a chamber-GUI smoke (per recon runtime-test-env) is the only end-to-end proof; the section-render jsdom tests deliberately bypass the framework.
- Whether the settings scope in a memory-mode (non-loopback) deployment reports `unavailable` — the UI handles all three statuses, so either answer is safe.
