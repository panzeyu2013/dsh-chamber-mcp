# Client-UI implementation notes (dsh-chamber-mcp browser half)

> **As of 2026-09-15 (working tree, package 0.0.3, suite 250/17).** Written during
> implementation against the **0.1.2-rc.1** runtime; the pinned devDependency
> generation is now **0.1.5-rc.2** (the client half was re-pointed at the 0.1.5
> client contracts — see CHANGELOG 0.0.2). Deviations recorded below were
> re-checked against the current `src/client/` where noted; §8 covers the 0.0.3
> runtime status / configuration surface.

Author: client-UI subagent. Companion to `docs/design.md` §5 and
`docs/recon/ui-contracts.md`. Originally compiled against the repo's installed
0.1.2-rc.1/0.1.1-rc.2 dev tree plus the gateway anchor install
(`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai`) where the
repo tree did not ship the runtime packages; at HEAD the repo tree installs the
whole pinned `@deepseek-ai/*` 0.1.5-rc.2 set.

## 1. Files created (this half)

| file | role |
|---|---|
| `src/client/index.ts` | browser entry: `inject` + `apply` (locale, controller wiring, `settings.section` registration) |
| `src/client/locales.ts` | flat `SettingsKey` union + `en`/`zh` dictionaries + `NS = 'mcp-scope.settings'` |
| `src/client/controller.ts` | framework-free domain core: scope store, credentials badge state, save pipelines, pure plan helpers |
| `src/client/section.tsx` | `McpScopeSection` page component (+ composed-props interface, outcome→text mapping) |
| `src/client/server-card.tsx` | one server card: badges, per-workspace on/off rows, remove cascade confirm |
| `src/client/add-form.tsx` | staged add form (transport switch, stdio/http fields, write-only secret rows, draft validation) |
| `src/client/import.ts` | 0.0.3 single-server JSON import (`mcpServers`, opencode and flat shapes → draft; secret values land write-only) |
| `src/client/runtime.ts` | 0.0.3 runtime store over the three host routes: status/action/tool-list reads, pending-action state (§8) |
| `src/client/styles.ts` | style seat: the plugin's stylesheet, its class-name map, and the `data-plugin-css` tag mount (§6) |
| `src/client/workspaces.ts` | minimal workspace-row narrowing (typed items) |
| `src/client/tool-card/{names,icon,row,view,register}.ts(x)` | transcript lane: MCP tool identity from the session's request header, the keyed tool view, and its registration lifecycle (§7) |
| `tests/client/controller.spec.ts`, `tests/client/locales.spec.ts`, `tests/client/styles.spec.tsx`, `tests/client/section-render.spec.tsx`, `tests/client/tool-card.spec.tsx`, `tests/client/tool-register.spec.ts`, `tests/client/import.spec.ts`, `tests/client/runtime.spec.ts` | vitest suites (8 files; the repo-wide suite is 17 files) |

Also edited (build-gate fixes, see §4): `tsconfig.json` (added `DOM` lib),
`tsconfig.tests.json` (override the inherited `tests` exclude).

## 2. Test results

`node node_modules/vitest/vitest.mjs run` → **client suites: locales (4),
controller (56), styles (10), jsdom section-render flows (19), tool-card (21),
tool-register (11), import (13), runtime (6)** (the repo-wide suite is 250
tests / 17 files — see README):
- `styles.spec.tsx`: the style-token gate of §6.4 (token allowlist, no literal
  colours, 0.5px hairlines, full-round pairing, class/CSS coverage, tag mount)
  plus render checks that the card and the form consume the class map.
- `locales.spec.ts`: same key set in en/zh; no empty/blank values;
  interpolation-placeholder parity per key; semantic spot checks (4 tests).
- `controller.spec.ts` (44): `decodeDoc` malformed-snapshot hardening (4),
  `buildSaveOps` (identical docs / add server / append env key / remove env key
  orphaning a ref / remove-server credential cascade / remove-server override
  pruning / untouched override rows, 7), `toggleOp` (no-op, off→set,
  on→unset+row prune, row kept, 4), `docsEqual` landed-write comparison (4),
  `renameOverrideKey` (2), shared-semantics alignment (2),
  `classifySaveError` (4), the save pipeline FE-4 (15) and the credential
  refresh FE-6 (2).
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
- `inject = ['slots','locale','remote','remote.credentials','settingsScope',
  'workspaces','sessions']` exactly as assigned — `sessions` was added by the 0.0.2
  transcript lane (`src/client/index.ts:124`; without it the lane stays off) (round-2 FE-3: `connection` was dropped —
  grep-proven unused; `remote.credentials` is the real credentials gateway,
  see 3.3).

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
  because `@deepseek-ai/dsh-api-settings-controller` (which generates the
  settings/credentials remote namespaces) is still absent from the dev tree, so
  those d.ts imports are unresolvable there and `skipLibCheck` collapses
  `ctx.remote`; the anchor's generated d.ts remain authoritative for the runtime
  shape. (`@deepseek-ai/dsh-api-gateway`, named in the original rationale, **is**
  present in `node_modules` at HEAD as a transitive dependency — that half of the
  reason no longer holds.)

### 3.4 `ctx.effect` typing — RESOLVED (no local patch remains)
cordis augments its own `Context` with `effect` via a RELATIVE module
augmentation (`declare module './context.ts'` in `fiber.d.ts`), which against a
shipped d.ts-only package resolves to no file under NodeNext and silently never
merges. The original mitigation was a localized structural `FiberAwareContext`
intersection in `src/client/index.ts`; the 0.1.5 client-contract re-point made
that unnecessary, and **that symbol no longer exists anywhere in `src/`** —
`src/client/index.ts` now records that no local structural patch is needed and
calls `ctx.effect(...)` directly. Runtime was never affected (effect is mixed
onto the proxied context).

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
Global standard hook `useWorkspaces` is present on every root-slot component.
At HEAD the merge comes from
`@deepseek-ai/dsh-api-workspace-controller/client` (0.1.5 — the package that also
declares the `ctx.workspaces` service this plugin injects); the 0.1.2-era
`dsh-client-runtime` is off the upstream release train and is no longer a
dependency or a cast site. `src/client/workspaces.ts` narrows each row to the
fields it renders through its own `WorkspaceItem` interface, which
`WorkspaceView` structurally satisfies — **no cast is needed**. `workspaceId` is
a branded string on the wire; treat as string for path ops (the shared model
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
- Remaining runtime unknowns: (1) whether the settings scope's decode
  hook sees `{servers:[], overrides:{}}` defaults when the host registered no
  user layer (we treat `value === undefined` as empty doc, fine either way);
  (2) ~~exact settings-conflict remote error shape~~ — **RESOLVED**: the host
  refuses the write and the controller reports it as a conflict, never as
  success (`applyOps` read-back), and the captured error is in `docs/milestones/M0.md`
  §②; (3) whether
  HMR/unload ordering ever races the remote `$on` disposers with
  `controller.start()` (all disposers are fiber-owned through one effect).

## 6. Style seat (round-1 FE-5: visual integration)

FE-5 found the section "non-native in both themes": raw `<button>`/`<input>`
with inline styles and literal colours (`rgba(192,57,43,…)`, `#c0392b`,
`rgba(127,127,127,…)`), nothing reading the theme. `src/client/styles.ts` now
owns the surface's chrome.

### 6.1 Why a stylesheet string, not CSS modules or the primitives

The purity invariant (AGENTS.md) allows `lib/client.js` to require only
`react`/`react/jsx-runtime`, so all `@deepseek-ai/*` imports stay type-only —
which rules out the official CSS-module bundles (built for their own packages)
and also the `ui-primitives` components. The plugin therefore does what the
official bundles do internally: ship the CSS as text and append one
`style[data-plugin="dsh-chamber-mcp"][data-plugin-css="dsh-chamber-mcp/client.styles.css"]`
tag. `mountStyles()` runs in `apply` through `ctx.effect`.

Two things go beyond the official guard-and-append, because a bare "does the
tag exist?" check has two failure modes that matter here:

- **refresh** — a tag left by an earlier revision is re-filled with the current
  sheet, because an HMR cycle may apply the new code *before* the outgoing
  fiber's disposer runs; without it the page would keep painting the previous
  revision;
- **ownership count** — the number of live mounts lives on the tag
  (`data-refs`), so a second copy of this plugin in the same document (the
  chamber shell can host more than one instance per page) shares the one
  stylesheet, and whichever unloads first cannot strip it from under the other.
  The last disposer removes the tag.

Mirroring the primitive CSS rather than importing it also keeps the plugin
working across the peer range (`^0.1.2-rc.1 || ^0.1.5-rc.1`) without a
compile-time dependency on the primitives' JS API — the geometry is copied
from the pinned generation, which §6.3 pins property by property.

### 6.2 What was replaced

| before | now |
|---|---|
| inline styles with literal colours/heights | classes off one token-only stylesheet |
| `border: 1px dashed rgba(127,127,127,.5)` form box | the panel's editing surface (`bg-module-platform`, r12, 14/16 padding) |
| raw `<button>` (OS default chrome) | `ui-primitives` Button capsules: `size="sm"` (h28/r14) for row and header actions, the figma `md` capsule (h36/r18) for the form footer; `outline` for dismiss/secondary, `primary` for commit, danger tint for destructive actions |
| raw `<input>` (OS default chrome) | official field vocabulary: h34/r8, `border-l4` hairline, `bg-layer-1`, 13px, `brand-primary` focus border, `label-dimmed` placeholder, dimmed when disabled, error border when invalid |
| raw `<input type="checkbox" role="switch">` | the Switch primitive's look (36×20 track, `brand-primary` when on, 16px thumb, 120ms slide) driven by the same controlled checkbox through `:checked` |
| native radios | the Pill primitive's pill (24px/r12, ghost-active fill + inset ring when selected) over the same real radios |
| literal-colour banners (`#c0392b` / green box) | token notices: failures on the danger tint with `state-error` text, the saved note as `state-success` text |
| opaque spans for transport/summary/credentials | the Tag pill (999px + `corner-shape: round`, 11/17) with the Tag tone palette: `outline` for the transport, `success`/`warning` (10%/12% `color-mix`) for configured/unconfigured refs, neutral for unknown |

### 6.3 Alignment table (checked, not asserted)

Every value below was read from the pinned dsh sheets (vendored upstream
packages at the authoring machine's
`/root/projects/dsh-chamber/vendor/harness-packages/@deepseek-ai` — not a path
inside this repo) and then verified against the
rendered surface: a Chromium audit of `getComputedStyle` in both themes
(`.smoke/ui-preview/audit.mjs`) and a source-level property diff
(`.smoke/ui-preview/align.py`). "same" = byte-equal declaration.

| surface | reference (official) | result |
|---|---|---|
| section column | `ui-settings-models` `.section` | same (flex column, gap 12, max-width 720, `label-primary`) |
| section title | `.title` | same (16px/24px, 500) |
| header action / row actions | `ui-primitives` Button `.sm` + `outline` (what the official `settings.action` seat renders) | same (h28, r14, 0 10px, 12/18, `border-l3`) |
| form footer buttons | Button `.md`/`.primary`/`.outline` + `EditorFooter` order | same (h36, r18, 0 14px, 14/22; dismiss left, commit right) |
| card | `ui-settings-plugins` `.card`/`.header`/`.body` | same fill/radius/hairline (`border-l4`, r16, `bg-layer-3`), 16px inset; `ui-settings-models` `.rowCard` is the 14px variant (not used) |
| staged form | `ui-settings-models` `.editor`/`.addCard` | same (r12, `bg-module-platform`, 14/16, gap 14) |
| field label | `ui-settings-plugins` fields `.label` | same size/weight/colour (13px, 500, `label-primary`; line-height written 20px vs `1.5` = 19.5px) |
| input | fields `.input` (h34, 0 12px, 13px, `border-l4`, r8) + `.input` of `ui-settings-models` (`bg-layer-1`, focus `brand-primary`, placeholder `label-dimmed`) | same; `bg-layer-1` (not the card fill) so the field reads as a box on the module fill in DARK, where `bg-layer-3` == `bg-module-platform` |
| invalid input / problem text | fields `.inputInvalid` / `.invalid` | same geometry and 12/18; colour `state-error-primary`. Upstream reads `--dsw-alias-label-error`, which NO sheet declares (the declaration is silently dropped) — see §6.4 |
| transport tag | `ui-primitives` Tag `.tag` + `data-tone='outline'` | same (999px, `corner-shape: round`, 1px 8px, 11/17, `border-l4`, `label-tertiary`) |
| credential badges | Tag tones `success`/`warning` | same `color-mix` fills and colours |
| switch | `ui-primitives` Switch `.switch`/`.thumb` | same (36×20, pad 2, r10, `corner-shape: round`, `border-l3` → `brand-primary`, 16px thumb, `translateX(16px)`, 120ms) |
| transport choice | `ui-primitives` Pill `.pill`/`.active`/`.interactive:hover` | same (including the hover fill on the unselected pill, guarded by `:not(:checked)` so the selected fill survives); horizontal padding 10px (Button `.sm`) instead of 8px, because this pill is a button-like choice holding translated copy |
| hints / problems / notices | fields `.hint`, `ui-settings-models` `.error`/`.savedNotice` | same (12/18, `label-tertiary` / `state-error-primary` / `state-success-primary`) |
| card list | `ui-settings-plugins` `.cards` | same gap 10px, no list markers (`ui-settings-models` `.rows` uses 8px) |
| error banner | chamber `.pluginRisk` vocabulary (danger tint + `state-error` text) | same tokens (no literals) |
| focus rings | `.button:focus-visible` → `box-shadow: 0 0 0 2px border-l3` (settings sections); `brand-primary` outline on the invisible-behind-paint controls (switch, pill, link, icon) | as referenced |

### 6.4 Checked by a gate, not by eye

`tests/client/styles.spec.tsx` applies the dsh-chamber style rules
(`dsh-chamber/scripts/dev/verify-style-tokens.mjs`, S1–S7) to this one sheet:
every `--dsw-*`/`--ds-*` reference must be a token the pinned theme declares
(S1 — this is what rejects upstream's undeclared `--dsw-alias-label-error`),
no literal colours and no colour fallback on a token (S4), every neutral
border 0.5px and no 1px filled divider (S3), every full-round radius paired
with `corner-shape: round` (S7), no custom properties of our own (S2/S6). It
also asserts that the class map and the stylesheet cover each other exactly
(no dead rule, no unstyled class) and that the tag mount is idempotent and
disposed, then renders the card and the form to check the components actually
consume the seat.

Rendered evidence (gitignored harness under `.smoke/ui-preview/`, not part of
the package): `make.mjs` builds a page that mounts the REAL section inside a
replica of the official settings panel chrome; `shoot.mjs` screenshots it in
both themes under real interaction (list, staged form, remove confirm, failed
toggle, save) — plus a hostile-content page (`long.html`, see §6.6) — and
`audit.mjs` records `getComputedStyle` + geometry for the same five states:
0 horizontal overflow, 540px content column, card actions flush to the card's
inner edge, switch thumb at `translateX(16px)` only when on. Run:
`node .smoke/ui-preview/make.mjs && PAGE=… OUT=… PREFIX=light xvfb-run -a electron .smoke/ui-preview/shoot.mjs`.

`ax.mjs` dumps Chromium's accessibility tree for both states, which is how the
structural changes were checked where assistive tech reads them: the transport
choice is still `radiogroup 传输方式` + two named `radio` nodes with correct
`checked`, each workspace row is a named `switch` with the right state and
disables with the staged form, the section/form titles stay `h2`/`h3`, and
every button keeps its name.

`artifact.mjs` drives the **shipped** `lib/client.js` (the wrapped loader
factory, not the sources) in a real browser through the lifecycle the M0 recon
could not observe (`docs/review/deploy-issue/04-local-mount-evidence.md`,
blind spot #1). Result of the recorded run (`.smoke/ui-preview/artifact.json`,
2026-09-11): the loader registers `dsh-chamber-mcp`; the factory requires
**only** `react` and `react/jsx-runtime`; `apply` registers three labeled
effects with `mcp-scope: styles` first, then the dictionary and controller
wiring, and one `settings.section` registration (`mcp-scope`, order 25, label
from the namespace); the style effect puts the sheet in the document with the
right tag attributes — **14,020 B in that run**, against **14,247 B** before the
§7 transcript lane and **22,710 B** at the current working tree (the §7 lane
block is 8,463 B); the
registered component renders the styled markup; and the effect's disposer
removes the tag.

### 6.5 Contrast, measured (and why nothing was "fixed")

Contrast ratios computed from the rendered colours (WCAG 2.1, relative
luminance), light / dark:

| pair | light | dark |
|---|---|---|
| card name on card | 18.9 | 11.6 |
| code line (`label-secondary`) | 5.8 | 8.0 |
| input text on field | 18.9 | 15.0 |
| field label on the form fill | 17.5 | 11.6 |
| badge ref (`label-secondary`) on the tone fill | 5.3 | 6.8 |
| primary button label on fill | 18.9 | 18.1 |
| quiet copy (`label-tertiary`: card meta, row state, hints) | 3.7 | 5.7 |
| error notice on the danger tint | 4.2 | 3.1 |
| success tones (saved note, configured badge) | 2.3 / 2.1 | 5.3 / 4.5 |
| transport tag (`label-tertiary` on the card) | 3.7 | 5.7 |

The two sub-AA rows are the design system's own values, not this sheet's:
`label-tertiary` is what every official settings section uses for secondary
copy (PluginCard `.description`, ModelsSection `.modelCatalogMeta`), and the
success tone is the `state-success-primary` green that `ModelsSection
.savedNotice` and the `Tag` `success` tone paint as text. Nothing here
deviates: a darker green does not exist in the token set, and colour is never
the only signal (every toned badge also renders its state word, so WCAG 1.4.1
holds). Recorded so the next reviewer sees the measurement rather than
re-deriving it.

### 6.6 Review findings (hostile-content pass)

A full review of this restyle ran the surface against content the schema does
not cap, which the first pass had only exercised with friendly fixtures:

1. **Horizontal overflow (fixed).** `HEADER_NAME_PATTERN` and
   `CREDENTIAL_REF_PATTERN` bound the character set, not the length, so a
   46-character header name plus a 45-character ref made one credential pill
   718px wide inside a 506px card content box — the card, the section and the
   settings column all overflowed (measured: section +195px, card +196px). The
   pill is now capped (`max-width: 100%`), its two code parts absorb the shrink
   and ellipsize (`min-width: 0` + `text-overflow`), and both carry a `title`
   with the full value — the same guard upstream applies to overlong badge
   cells. A working directory is an arbitrary host path, so the quiet-copy rule
   gained `overflow-wrap: anywhere` as well. Re-measured with the hostile
   fixture (`?long=1`): 0 overflow on every container.
2. **Stylesheet ownership (fixed).** The first implementation removed the tag
   on dispose and no-op'd when one already existed. That loses the sheet when
   two copies of the plugin are mounted in one document and the first to unload
   is not the one that created the tag (the chamber shell can host several
   instances per page), and it would keep painting a stale revision when an HMR
   apply runs before the outgoing fiber's disposer. The tag now carries the
   live-mount count and is re-filled when its text is no longer current; the
   last disposer removes it (§6.1, both orderings covered in
   `tests/client/styles.spec.tsx`).
3. **Doc drift (fixed).** The suite grew (133 → 151 tests, 11 → 12 files), so
   the counts in `README.md` and `docs/host-notes.md` were refreshed.
   `docs/review/**` keeps its numbers: those are dated review records, not live
   claims.
4. **Checked, no change needed.** Every JSX attribute, role and behavior
   survives the restyle (attribute-set diff before/after: only `style=` became
   `className=`, and the one moved `key` is the card's, now on its `<li>`); no
   user-controlled value reaches a style or class context (classes are static,
   there are no inline styles), so the new `title` fallbacks on truncated
   badges are the only place a server-supplied string meets an attribute and
   React escapes it; the staged form's footer is Cancel-then-Save as the
   official `EditorFooter` orders it, with the same `<form>`/Enter-submission
   semantics as before.

Not changed, and why: the pill/notice tone contrast (§6.5), the 16px card
inset and 8px internal gap (PluginCard's values; `ui-settings-models` uses
14px/12px — both official, one had to be chosen), the pill padding of 10px
(Button `.sm`, not Pill's 8px), and the bundle growth. Measured in a scratch
build of the pre-transcript-lane tree: `lib/client.js` 75,485 → 93,286 B
(+17.8 KB), of which 14.4 KB is the stylesheet text and 3.4 KB the class
plumbing and the invalid-state markup; the sheet stays unminified on purpose (it is read in devtools far
more often than it is transferred, and a minifying step in `build.mjs` would
put the CSS text outside review, since the built file is not in the diff).

### 6.7 Second-round scan (states, engine, harness)

Round 2 audited different surfaces than round 1 (which read the diff, the AX
tree and the rendered geometry):

1. **States that had never been rendered (fixed + verified).** Read-only,
   empty, in-flight (hanging save/toggle), invalid draft, workspace
   load/error/empty, English copy and a 252px column were all rendered for the
   first time. Clean everywhere (0 overflow, controls wrap instead of
   squeezing), with one real gap: a row-level problem was reported only in the
   text list, so nothing said *which* input was wrong. Row inputs now carry the
   official invalid treatment (`inputInvalid` border + `aria-invalid`), mapped
   precisely — an env-row problem marks its key input, a header problem marks
   the name input unless it is the ref that is wrong.
2. **Transport pills had no hover state (fixed).** The official interactive
   Pill answers the pointer; the unselected choice now takes
   `interactive-bg-hover` while the selected one keeps its fill (the
   `:not(:checked)` guard is what keeps the newer rule from out-shouting the
   selected state — verified by hovering both pills in a real browser).
3. **Engine-level scan (new, `.smoke/ui-preview/scan-engine.mjs`).** Against
   the preview page (as of the round-2 run): 88 scoped rules and 25 referenced
   tokens — the sheet is now 136 rules / 27 tokens — every token resolving in
   BOTH themes; no unsupported property and no dropped declaration;
   `prefers-reduced-motion: reduce` turns the form's mount animation off and
   every transition to 0s; real Tab presses paint a ring on capsules
   (`box-shadow`), and on the radio pill / switch track through their sibling
   rules (`outline: 2px brand-primary`); the focused input shows the official
   border-colour change instead of a ring. The 24 selectors "dead" in that run
   are the hover/focus/disabled/placeholder states plus the states the run did
   not drive (alert, saved note, empty, read-only), each of which is exercised
   by the audit matrix above.
4. **The tests can fail.** The style spec was mutation-tested: dropping
   `corner-shape: round`, widening a hairline to 1px, writing a literal colour,
   referencing the undeclared `label-error`, removing the badge width cap, and
   breaking the tag's ownership count each turn the suite red (7/7).
5. **Harness defects the round found in its own tooling (fixed)** — recorded
   because each one produced *false confidence*, not a false alarm:
   - the fixture query sat on the `<script src>` URL, so every state page
     silently rendered the DEFAULT fixture (the state matrix initially proved
     nothing about states; caught only because the facts — not just the
     overflow — were asserted);
   - `light-en.html` injected no query, so no run had ever rendered English
     copy;
   - the artifact page carried no theme, so every token read as unresolved and
     the focus ring computed to `none`;
   - the artifact driver disposes the sheet as its last step, so the first
     engine scan measured zero rules and reported "no problems";
   - the invalid-draft scenario typed into the wrong row index (`arguments` is
     row 0, the env key is row 1), so the ref-validation path was never hit.
   The engine scan now ABORTS when the page carries no sheet, and the state
   pages inject their query as a page global.

## 7. Transcript lane: the MCP tool row (0.0.2 line)

The browser half also owns how MCP calls render in the conversation. The lane
was deliberately built to need **no host API and no new runtime dependency**:
the tool names come from the session's own event stream, and both glyphs are
inline SVG.

- **Slot contract.** `tool.call.toolview` is a *keyed, session-scoped* slot
  dispatched by the EXACT wire tool name (`dsh-client-ui-tool`
  `contract/slots.d.ts`): an unclaimed key falls back to the shipped generic
  row, and reusing a key replaces that row — so registering is additive for our
  own names and never touches the shipped ones. Registration goes through
  `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key,
  locale: NS, priority: 1 }, View))`, the same seam `dsh-client-ui-skill` uses
  for `skill` (plus the shadowing rank — see *Declaration choices*); the
  disposer removes the row on teardown or HMR.
- **Discovery — two sources, both required.** `ctx.sessions.list` names the
  staged session (the framework's own doc: *"Staging IS the open signal — the
  window opens ⟺ the session is on stage"*), whose binding's `eventSource`
  window supplies MCP names from
  - every `request/header` — `event.data.header.tools[]` (`.name`), the complete
    model-facing tool array (`EpochHeader.tools` is an optional direct child of
    `header`; the client-connection token fixture and
    `ui-conversation`'s request inspector read the same path), and
  - every `tool/call` — `event.data.name`, the call the event renders.

  The second source is not redundant. The window is a **bounded, paginated tail
  page** of the session log (`events.open({ maxMessages: 50 })`, host cut
  `DEFAULT_MAX_MESSAGES = 50` over `user/message` + `assistant/message`), while
  `request/header` is appended at loop-instance boundaries and *on change* — not
  per turn — so a session that ran long enough can render MCP calls whose
  describing header sits before `entries[0]`. A `tool/call` event is present
  exactly when its row renders, so registering from the call events the window
  actually carries makes the lane independent of that pagination; scrolling up
  (`events.prepend`) re-publishes and heals the boundary call. Names accumulate
  across sessions so a revisited session keeps its rows. The header remains the
  only source for tools that were offered but never called — those register
  ahead of their first call. Without the sessions service the lane stays off and
  every MCP call keeps the shipped row.
- **Identity.** A public name cannot be decomposed on the client (it may carry
  the 12-hex lossy-normalization suffix), so the owning server is matched by the
  **longest configured `serverName` prefix** from the settings document — which
  also keeps a serverName containing `_` unambiguous. A tool whose server left
  the document still renders, without a transport tag.
- **Cap.** The keyed dispatch projects the slot's WHOLE entry list per rendered
  row (`entriesOfSlot` is computed on every call — no memo, verified in
  `dsh-client-ui-slots`), so the lane registers at most
  `DEFAULT_TOOL_VIEW_LIMIT` (256) names; names past the cap keep the shipped row
  and the client context's logger (when present) records one warning.
- **States.** `running` / `ok` / `error` / `stopped` are classified by the same
  expression the shipped rows use (`!done` ⇒ running, else
  `block.error?.code === 'interrupted'` ⇒ stopped, else `isError` ⇒ error, else
  ok — `dsh-client-ui-tool` `ToolRow`). Running carries the shipped sweep
  (`300px`, `2.6s ease-out infinite`, same gradient and keyframes) plus
  `aria-busy` and a primary title; settled rows drop the animation and show
  `time - callTime`. **Terminal states yield the LEADING SLOT to the shipped
  status dot** — error red, interrupted amber (`--dsw-alias-state-error-primary`
  / `--dsw-alias-state-warn-primary`, the same anatomy as `StateDot`: a 10px box
  whose `::after` core is 6px (`inset: 20%`) under a 10%-opacity halo) — so, exactly like upstream, the title keeps its normal colour and
  only the failure's summary line takes the error token. The row's own metrics
  and layout mirror the shipped ones (24px row, 16px leading box with 14px
  glyphs, 6px gap, 13px/24px title, the shipped 2x2 caption-dot separator, a
  14px/24px ellipsizing summary, then the suffix items) and the disclosure
  behaviour is `DisclosureRow`'s: `role=button`/`tabIndex`/`aria-expanded` only
  when expandable, Enter/Space toggle, glyph→chevron on hover, chevron while
  open. Assistive technology gets the shipped treatment as well: the dot and the
  sweep are colour-only, so running/error/interrupted rows carry a visually
  hidden state word (`stateStatus`'s rule — a settled-ok row needs none) and the
  row's own visible text stays the accessible name. Every number and token here
  was read out of the shipped stylesheets
  (`ToolRow`/`DisclosureRow`/`StateDot` module CSS); the pinned generation's
  theme DECLARES `--dsh-content-font-size-secondary` and
  `--dsh-content-font-delta` (and the shipped rows read them), so this sheet
  reads them too with the shipped defaults as fallbacks — the row follows the
  Settings font-size axis exactly like the shipped rows. (Only the older
  0.1.1-rc.2 profile theme lacks both, where the fallbacks apply.)
- **Styling.** Same style seat as the settings section: shipped row metrics
  (24px row, 16px leading box with 14px glyphs, 6px gap, 13px/24px title,
  14px/24px summary, 0.5px hairlines), `--dsw-*` alias tokens only (plus the
  theme's caption token for the separator dot), inline 24-unit glyphs rendered
  at 14px, and the reduced-motion block disables the sweep. The built bundle
  still requires only `react` / `react/jsx-runtime`.
- **Declaration choices (audited against both generations).**
  - `dsh.client.inject` gains exactly ONE module: `dsh-client-ui-tool`, the
    package that declares the `tool.call.toolview` slot (its
    `conversation.chat.node` entry carries the `children` table) and is present
    in the 0.1.1-rc.2 anchor set *and* the 0.1.5-rc.2 pin. The **provider of
    `ctx.sessions` is deliberately NOT named**: it is `dsh-client-runtime` in
    the anchor generation and `dsh-api-session-controller` in 0.1.5 — a module
    id that only exists in one of them would be a dangling edge in the other.
    The cordis `inject: ['sessions']` service requirement already orders us
    after whichever package provides it (both generations expose the service
    under that exact name: `rootCtx.reflect.provide("sessions", …)` in the
    anchor's `dsh-client-runtime`, and the same name in the 0.1.5
    `dsh-api-session-controller`), and the shipped `dsh-client-ui-conversation`
    injects `"sessions"` the same way.
  - Rows register at `priority: 1`. Keyed dispatch is exact-key and the
    shadowing rank is ascending ("lowest renders"), while a same-key pair at
    the SAME priority **throws** in the slot core — and the throw would hit
    whichever package registers second. Rank 1 makes a future official row for
    the same wire name win and makes that collision impossible; the generic
    fallback is not an entry, so rank 1 still renders today.
  - Registration is per exact wire name through
    `ctx.slots.inject(key, () => ctx.slots.register(...))`, the same seam
    `dsh-client-ui-skill` uses for `skill`. `inject` is a fiber effect
    (`ctx.effect`) that runs its callback immediately when the declaration
    exists and later when it lands, so calling it from a session subscription is
    legal; the callback must not throw (a deferred throw would surface as an
    uncaught microtask error), which is why the lane installs rows behind a
    try/catch and leaves a failed name un-registered for a later retry.
  - The row reuses the existing `mcp-scope.settings` locale namespace instead of
    declaring a second one: the namespace id is just a dictionary handle, the
    dictionaries already carry en/zh parity under the compile-enforced key
    union, and a second namespace would add a second declaration site for no
    user-visible benefit.
- **Evidence.** `tests/client/tool-card.spec.tsx` (identity incl. longest-prefix
  and hashed names, the four states, expand/collapse, keyboard, aria) and
  `tests/client/tool-register.spec.ts` (diff, cap, teardown, observer
  lifecycle); `tests/client/styles.spec.tsx` gates the new classes with the rest
  of the sheet; and `scripts/verify-client-artifact.mjs` (run by
  `verify:package`) drives the BUILT `lib/client.js` through the loader wrapper
  in jsdom — it registers one view per discovered name, renders the running and
  settled forms, and expands on a real click.

## 8. 0.0.3 runtime status + configuration surface

- **`src/client/runtime.ts`** is a dependency-free store over the three host
  routes: global `fetch`, injectable for tests, in-flight dedupe, no timer of
  its own. A failed/unreachable call publishes `unavailable`/`error` and the
  section keeps rendering the document; the client bundle still requires only
  react/react/jsx-runtime.
- **Wiring.** `apply()` composes the runtime store into the same
  `settings.section` inject face (`useRuntime` hook seat + action callbacks),
  refreshes on `settings/document-updated` and `connection/reset`, and the
  section polls every 5 s while visible and once per document revision.
- **Cards** render the status dot/label, a localized failure line derived from
  the host's fixed error code (remote text never crosses the wire; unknown codes
  fall back to the host message), Connect/Disconnect/Test and a `Tools (N)`
  disclosure; the enable switch starts the header, Test is gated on a runtime
  view, and runtime action failures surface in the card's own role=alert banner
  (separate from document save failures).
- **Form** additions: enable switch, `timeoutMs`, an inline unsaved-changes
  guard (header and footer route through the same `requestClose`), clipboard
  paste for command / `.env` / header lines, and a single-server JSON import
  (`src/client/import.ts`, pure + unit-tested). `section` adds a name filter
  and per-card all-on/all-off switches (one batched mutation).
- **Style acceptance (0.0.3 additions).** The status dot uses chamber's dot
  geometry verbatim (`8px`, `border-radius: 50%`, `corner-shape: round`, state
  tokens); dialog/textarea/enable-row reuse the sheet's existing field
  vocabulary. S1 was re-verified authoritatively against the vendored pinned
  theme (368 declared tokens, 29 referenced, 0 undeclared); S2–S7 and the class
  map/CSS coverage gate are green.
- **Retained trade-off.** `draftToServer` trims and drops empty argument rows:
  the form's blank argument row is a placeholder, so preserving it would add a
  phantom empty argument to every save. A pasted explicit empty argument is
  therefore not persisted (round-3 finding C-P2-1, retained by decision).
- **Layout reference.** The shipped desktop layout (section surface, card
  anatomy, add/edit form, state matrix, metrics) is documented with wireframes in
  `docs/mcp-desktop-layout.md` + `docs/mcp-desktop-layout.svg`.
- **Evidence.** `tests/client/runtime.spec.ts`, `tests/client/import.spec.ts`,
  the extended `controller.spec.ts` / `section-render.spec.tsx`, and the
  style-token gate. `scripts/verify-client-artifact.mjs` gained the `ctx.on`
  seat now that the client half subscribes to `connection/reset`; round-3
  findings and dispositions live in `docs/review/round3/REPORT.md`.
