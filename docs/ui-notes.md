# Client-UI implementation notes (dsh-mcp-scope browser half)

Author: client-UI subagent. Companion to `docs/design.md` §5 and
`docs/recon/ui-contracts.md`. Compiled against the repo's installed
0.1.2-rc.1/0.1.1-rc.2 dev tree plus the gateway anchor install
(`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai`) where the
repo tree does not ship the runtime packages.

## 1. Files created (this half)

| file | role |
|---|---|
| `src/client/index.ts` | browser entry: `inject` + `apply` (locale, controller wiring, `settings.section` registration) |
| `src/client/locales.ts` | flat `SettingsKey` union + `en`/`zh` dictionaries + `NS = 'mcp-scope.settings'` |
| `src/client/controller.ts` | framework-free domain core: scope store, credentials badge state, save pipelines, pure plan helpers |
| `src/client/section.tsx` | `McpScopeSection` page component (+ composed-props interface, outcome→text mapping) |
| `src/client/server-card.tsx` | one server card: badges, per-workspace on/off rows, remove cascade confirm |
| `src/client/add-form.tsx` | staged add form (transport switch, stdio/http fields, write-only secret rows, draft validation) |
| `src/client/workspaces.ts` | minimal workspace-row narrowing (typed items) |
| `tests/client/controller.spec.ts`, `tests/client/locales.spec.ts` | vitest suites |

Also edited (build-gate fixes, see §4): `tsconfig.json` (added `DOM` lib),
`tsconfig.tests.json` (override the inherited `tests` exclude).

## 2. Test results

`node node_modules/vitest/vitest.mjs run` → **client suites: locales (4),
controller (43) + jsdom section-render flows (10)** (the repo-wide suite is
130 tests / 11 files — see README):
- `locales.spec.ts`: same key set in en/zh; no empty/blank values;
  interpolation-placeholder parity per key; semantic spot checks (4 tests).
- `controller.spec.ts`: `decodeDoc` malformed-snapshot hardening (4), `buildSaveOps`
  (add server / edit env keys / remove cascade refs / remove cascade override
  pruning / unchanged rows, 6), `toggleOp` (no-op, off→set, on→unset+row prune,
  row kept, 4), shared-semantics alignment (2), `classifySaveError` (1).
- Component rendering tests: jsdom `section-render.spec.tsx` drives real user
  flows (form submit, per-card banners, role=alert/status, pluralized copy,
  tri-state badges) against the components with framework props faked
  (the real renderer wiring is verified separately — see docs/review/frontend.md §5).

`npm run typecheck` → green for the whole repo (client + host halves).

## 3. Exact type/runtime assumptions (verify against anchor when deploying)

### 3.1 `settings.section` registration & component typing (slots)
- Registration options on rc.1 `ctx.slots.register` are `{ name, children?,
  store?, locale?, inject?, ...kindOptions }` where list-kind requires `id`,
  optional `order`/`label` (`SlotLabel = string | (() => string)`); the
  component is checked at the call site against the composed props computed
  from the inject factory return + locale namespace (`SlotCore.register` in
  `dsh-client-ui-slots/lib/types/index.d.ts`). We declare **no children**
  (page-internal rows, no nested slot seats) — `children` declarations are
  optional and claiming them obliges consuming `renderSlot`.
- The section's own props are declared explicitly in
  `McpScopeSectionProps` (section.tsx): owner `close`, locale `t`, framework
  hooks `useDoc` + `useWorkspaces`, and the four injected actions, re-stated
  with locally-resolvable types. Reason: the official composed type
  (`PropsRuntime`/`InjectFace`/`SnapshotSelectorHook`) rides
  `@deepseek-ai/dsh-client-store` re-exports that are **not installed in this
  dev tree**, so every hook member collapses to `any` there; the register
  site still validates our interface structurally (contravariant params,
  `any` assignable both ways). If `dsh-client-store` types ever land in the
  tree, prefer the official `PropsRuntime<'settings.section'> & PropsLocale<NS>
  & InjectFace<McpScopeFace>` intersection again.
- The `hooks: { doc: source }` inject compartment binds the component prop
  `useDoc` (renderer converts `name` → `use<Capitalized>`). Our source is a
  plain `{ getSnapshot, subscribe }` observable (uSES-safe stable snapshot
  between publishes) — no `dsh-client-store` value dependency.
- `inject = ['slots','locale','connection','remote','settingsScope','workspaces']`
  exactly as assigned; `connection` is required at runtime by the transport
  generation but we make **no call into it** (see 3.3).

### 3.2 Forwarded remote events (verified)
`dsh-api-remotes/lib/types/remote-events.d.ts` (installed 0.1.2-rc.1) is the
one allowlist: `'settings/document-updated'` (emit, listener `(ns, revision)
=> void` — payload from `@deepseek-ai/dsh-settings/types` cordis `Events`
merge: `(ns: SettingsNamespace, revision: number)`) and
`'credentials/reference-updated'` (emit, `(ref: CredentialRef) => void` from
`@deepseek-ai/dsh-credentials/types`). We subscribe to both via
`ctx.remote.$on`, filter the document event by `MCP_SCOPE_NAMESPACE`
('mcp-scope'), and re-read through the controller (scope mirror already
refreshes itself inside the ui-settings provider; our handler re-publishes
the store and re-describes credential badges).

### 3.3 `connection.api` DOES NOT EXIST on this runtime — the credentials face is `ctx.remote.credentials`
Recon-D's `connection.api.credentials.*` shape is the ref-dsh (0.1.0-rc.5)
pre-Remote world. On the installed 0.1.2-rc.1 runtime:
- `dsh-client-connection`'s `ConnectionHandle` has no `.api` member at all
  (`lib/types/client/index.d.ts` — only `rpc`/`generation`/`state`…).
- The settings+credentials RPC groups were generated into the Remote
  assembly: anchor `dsh-api-settings-controller/lib/typert.remote-client.d.ts`
  declares `TypertRemoteNamespaceMap { 'credentials': { describe(refs:
  string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>; set(ref,
  value: string): Promise<RemoteResult<void>>; unset(ref: string):
  Promise<RemoteResult<void>> } … }`, mounted by `dsh-api-remotes/client`
  next to `settings`. Official rc.1 settings cards document exactly this:
  "whose `remote.credentials` namespace answers for the credential the
  section references" (web-search-card-controller.d.ts).
- So `apply` wraps `ctx.remote.credentials` into a `CredentialsGateway` that
  folds the Typert `RemoteResult` union (`{ok:true,value} | {ok:false,error}`)
  into thrown errors (remote failures never throw on their own). The local
  `McpRemoteWire` interface in `src/client/index.ts` re-states that surface
  because the repo dev tree does not install `dsh-api-gateway` /
  `dsh-api-settings-controller` (their d.ts imports are unresolvable there,
  `skipLibCheck` collapses `ctx.remote` to `any`); anchor d.ts are
  authoritative for the runtime shape.

### 3.4 `ctx.effect` typing is lost in the npm d.ts tree (relative augmentation)
cordis 4.0.2 augments its own `Context` with `effect` via a RELATIVE module
augmentation (`declare module './context.ts'` in `fiber.d.ts`). Against the
shipped d.ts-only package that specifier resolves to no file under NodeNext,
so the merge silently never applies for consumers — `ctx.effect` errors with
"did you mean the static member". Cross-package absolute augmentations
(`ctx.locale`, `ctx.settingsScope`, `ctx.slots`, `ctx.remote`) merge fine.
Runtime is unaffected (effect is mixed onto the proxied context). Fix: one
localized structural `FiberAwareContext` intersection in `src/client/index.ts`
(commented), nothing else touches it.

### 3.5 Settings path-op contract (mutate)
`SettingsPathOpView = {op:'set', path: string[], value: JsonValue} |
{op:'unset', path: string[]}` (`@deepseek-ai/dsh-settings/types`,
"set creates intermediate objects, unset removes"). We did NOT confirm host
array-index path semantics, so per the brief the safe default is used: the
servers array is written as ONE `set ['servers']` whole-array op per save,
and per-workspace switches are atomic `set`/`unset` ops at
`['overrides', <workspaceId>, <serverName>]` (+ row-level `unset` when the
row empties). `scope.mutate(ops, expectedRevision?)` with the revision
captured before the write; on rejection the scope already performs its
recovery re-read, and the controller additionally re-publishes (conflict
text shown; snapshot stays fresh).

### 3.6 Workspace enumeration
Global standard hook `useWorkspaces` is present on every root-slot component
(merge in `dsh-client-runtime/client`); the hook/state typing is again
`any`-degraded for `WorkspaceListState.items` (its `WorkspaceView` re-export
chain crosses packages absent from this dev tree), so `workspaces.ts` narrows
rows to the used fields through one targeted cast. `workspaceId` is a
branded string on the wire; treat as string for path ops (the shared model
indexes plain strings).

## 4. Build-gate config fixes applied (and why)
- `tsconfig.json`: `lib` gained `"DOM"`. The tsconfig previously shipped
  `lib: ["ES2023"]` only, but the browser half (React JSX handlers,
  `HTMLInputElement`, `URL`) requires DOM typings; without it every
  `event.target.value`/`checked` access fails (`EventTarget & HTMLInputElement`
  has no `value`). Host half doesn't use DOM and is unaffected.
- `tsconfig.tests.json`: the base config excludes `tests`, which the derived
  config inherited — `tsc -p tsconfig.tests.json` could never see any test
  file (TS18003). Added an explicit `"exclude": ["node_modules", "lib"]`
  override so the mandated `npm run typecheck` gate actually checks the
  suites.

## 5. Semantics / risk notes for the coordinator
- Save order is secrets-first-then-document per the brief: dirty literal
  secrets are `credentials.set` sequentially BEFORE `scope.mutate`; a
  per-ref failure aborts with `secret-write-failed` + the failing refs
  (partial secret writes may have landed — the doc is untouched; no
  rollback exists in the credentials domain). On document success, refs
  orphaned by the removal diff are `credentials.unset` best-effort (refusals
  — e.g. inherited-env shadowing — do not fail the committed removal).
- Round-2 (resolved): failures are classified by the typed `code`
  (`settings/conflict` / `SETTINGS_CONFLICT`) and the `isDSHRemoteError`
  marker first, with the message scan demoted to a non-platform fallback
  (`classifySaveError`, controller.ts). Business refusals on this runtime do
  not throw at all: the scope client recovers and RESOLVES, so the pipeline
  verifies the write LANDED by re-reading and comparing the document
  (`docsEqual`) — a refused write surfaces as `conflict`, never as success.
- `addServer` guards `validateDoc(next)` again before writing (belt against
  UI-only validation drift); UI also validates name pattern/duplicates,
  required command/url, URL format (http(s) parse), env-key/header-name
  duplicates, header name non-empty, and env-style refs.
- `decodeDoc` canonicalizes: missing/non-object sections → empty doc; empty
  override rows and non-`true` literals pruned (schema-valid docs only carry
  literal `true`; the model's presence semantics stay consistent).
- The workspace rows show real workspaces only (`useWorkspaces` items) — no
  "all workspaces" pseudo-row — with the empty state text when none exist.
- Locale: both built-in locales registered in ONE call under namespace
  `mcp-scope.settings` with the `LocaleNamespaceMap` augmentation; every
  rendered string (labels, hints, validation, error banners, confirm copy)
  comes from the dictionaries — no hardcoded UI English. Namespace key union
  is compile-checked at both the register site and every `t()` call.
- Remaining runtime unknowns for M0: (1) whether the settings scope's decode
  hook sees `{servers:[], overrides:{}}` defaults when the host registered no
  user layer (we treat `value === undefined` as empty doc, fine either way);
  (2) exact settings-conflict remote error shape (see above); (3) whether
  HMR/unload ordering ever races the remote `$on` disposers with
  `controller.start()` (all disposers are fiber-owned through one effect).
