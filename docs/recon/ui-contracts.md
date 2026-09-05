# dsh client-UI plugin contracts: settings sections, forms, locale, workspace rows

Recon report, written 2026 from two sources:

* **ref-dsh checkout (master, package versions `0.1.0-rc.x`)**: `~/projects/dsh-chamber/ref-dsh/packages/client/*` and `~/projects/dsh-chamber/ref-dsh/packages/{settings,web,host,credentials,llm}/*`. This is the canonical *source* of every mechanism below.
* **Installed 0.1.2-rc.1 npm tree (authoritative where it drifts)**: `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/*` (the gateway deployment of `@deepseek-ai/dsh@0.1.2-rc.1` + `@deepseek-ai/dsh-web-frontend@0.1.2-rc.1`). Feature UI plugins (`dsh-client-ui-*`) are installed there; **platform/shell packages (`dsh-client-runtime`, `dsh-client-ui-slots`, `dsh-client-web-react`, `dsh-client-ui-primitives`, `dsh-client-schema-form`, `dsh-client-web`, `dsh-client-ui-attachment`[^1]) are NOT installed** — they are baked into the prebuilt web app (`@deepseek-ai/dsh-web-frontend/dist`) and exist only as monorepo sources in ref-dsh.

[^1]: `dsh-client-ui-attachment` *is* in the anchor tree but only as a plugin entry.

Short version of everything you need:

* A client UI plugin is a **dual-face npm package**: a no-op (or host) node half `lib/index.js` + a **prebuilt browser bundle `lib/client.js`** that is a CJS factory handed to `window.__ModuleLoader__.load({id, factory})`. No JSX ever runs in the browser un-compiled. There is no dev-mode source loading in a user install.
* In the browser the plugin exports the cordis-plugin shape `export const inject = [...]` + `export function apply(ctx: ClientContext)` from its `./client` entry. **There is no `ctx.settings` / `ctx.section` / `ctx.ui`.** Everything is a cordis service on `ctx`: `ctx.slots` (registry), `ctx.locale`, `ctx.settingsScope`, `ctx.workspaces`, `ctx.sessions`, `ctx.remote`, `ctx.get('connection')` → `connection.api` (the typed RPC client).
* A new settings page = one **list-slot registration into `settings.section`**: `ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label, locale, inject}, SectionComponent))`. The shell (`ui-settings-general` `SettingsRoot`) renders a flat left nav of all registrations (sorted by `order`) and mounts the active component.
* Settings storage = **Host-registered namespaces** (`installSettingsSection` server side) + client `ctx.settingsScope.bind({namespace})` giving a reactive `SettingsScope` with `getSnapshot/subscribe/set/unset` (0.1.2-rc.1 adds `mutate(ops, expectedRevision?)`).
* **There is no generic schema→form component.** `dsh-client-schema-form` is a *validation/path helper* package. Official settings forms are hand-written staged controls (`ValueField`/`SecretField` etc.) over a scope snapshot. Secrets are **never stored in the settings section**: a section field is `z.string().role('credential-ref')` naming an env/credential reference, and the literal is stored with `connection.api.credentials.set({ref, value})` (write-only; only `credentials.describe({refs})` answers "configured? writable?").
* Locale = **flat dictionary namespaces merged into `LocaleNamespaceMap`**; every namespace registers `{zh, en}` in one call (`ctx.locale.register(ns, {zh, en})`), enforced at compile time (`Record<BuiltInLocaleId, LocaleDictOf<N>>`). No i18n.yaml runtime file format — `README.i18n.yaml` is a *docs pairing* record only. Strings resolve per key through: active locale → zh fallback → shared `common` namespace → the raw key.
* Workspaces: enumeration is `useWorkspaces` (a **global standard hook every slot component receives**) over `ctx.workspaces.list` (`WorkspaceListState { items: WorkspaceView[] {workspaceId,path,title,sessionIds,...} }`). **No official per-workspace settings/toggle UI exists**; closest official patterns are per-workspace *session* grouping (ui-workspace), one-row settings (ui-permission-presets, ui-agent-preset rows), and the chamber GUI's per-server settings shell (chamber-specific).

---

## 1. Client plugin export shape and how the web React side is wired

### Package layout (both halves, one npm package)

Official client UI package, `packages/client/ui-settings-general/package.json` (ref-dsh):

```json
"name": "@deepseek-ai/dsh-client-ui-settings-general",
"version": "0.1.0-rc.5",
"type": "module",
"main": "lib/index.js",
"types": "lib/types/index.d.ts",
"exports": {
  ".":           { "types": "./lib/types/index.d.ts",  "default": "./lib/index.js" },
  "./invariant": { "types": "./lib/types/invariant.d.ts","default": "./lib/invariant.js" },
  "./client":    { "types": "./lib/types/client/index.d.ts","default": "./lib/client.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime", "...", "@deepseek-ai/dsh-api-remotes"], "platform": "web" } },
"files": ["lib/index.js","lib/invariant.js","lib/client.js","lib/types/**/*.d.ts"]
```

* `.` = the node/host half. For UI-only plugins it is a no-op loader entry, e.g. `packages/client/ui-settings/src/index.ts`:
  ```ts
  /** Host loader entry for the browser implementation exported from `./client`. */
  export function apply(): void {}
  ```
* `./client` = the browser half. **`dsh.client` in package.json is how the host discovers browser entries** (`packages/client/modules/src/index.ts`: "scans the host Loader's entries for packages declaring `dsh.client`"); `inject` there is informational graph metadata (prefetch/HMR), *not* activation sequencing.
* The installed 0.1.2-rc.1 package matches this shape exactly (checked `…/node_modules/@deepseek-ai/dsh-client-ui-settings-general/package.json`: exports `./client` → `./lib/client.js`, `dsh.client.inject` list present). `lib/client.js` (verified head/tail of the installed file):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-general",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		...
		return module.exports;
	}
});
```

### Entry source shape (browser half)

Every official `src/client/index.ts` exports exactly `inject` (array of required cordis service names) and `apply(ctx)`; several also re-export types. Smallest complete official example, `packages/client/ui-settings-general/src/client/index.ts` (trimmed of its store/chrome internals — this is the settings **shell** package; registration mechanics verbatim):

```ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'   // slot decls + ctx.settingsScope merge (type-only!)
import type {} from '@deepseek-ai/dsh-client-locale/client'        // ctx.locale merge (type-only!)
import { GeneralSection } from './GeneralSection.tsx'
import { en, zh, type SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { settings: SettingsKey }   // typed dictionary namespace
}

const NS = 'settings'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')
  const t = ctx.locale.bind(NS)
  ...
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: {
      'settings.trigger':  { kind: 'single', scope: 'root' },
      'settings.header':   { kind: 'single', scope: 'root' },
      'settings.action':   { kind: 'list',   scope: 'root' },
      'settings.close':    { kind: 'single', scope: 'root' },
      'settings.section':  { kind: 'list',   scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: shellInjected,
  }, SettingsRoot))
  ...
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'general', order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
}
```

**Key facts:**

* **`inject` is a plain array of service names** — not `Config`/`filter`/nested plugin descriptors. The cordis-style loader waits until each named service exists on `ctx` (`ctx.get('connection')` is used because `connection` is not part of the merged interface). Service names seen in official plugins: `'slots'`, `'locale'`, `'connection'`, `'remote'`, `'settingsScope'`, `'sessions'`, `'workspaces'`, `'conversation'`, `'inputTriggers'`, `'commandUi'`, `'conversationEvents'`.
* **Type-only imports do the cross-package "context merge" work.** `import type {} from '@deepseek-ai/dsh-client-ui-settings/client'` pulls in that package's `declare module '@deepseek-ai/cordis'` merges (`ctx.settingsScope`) and its `declare module '@deepseek-ai/dsh-client-ui-slots'` slot declarations. Runtime value imports across packages are **forbidden by the client-bundle purity gate** (`tsdown.client.ts`: any `@deepseek-ai/...` value import that is not a platform module or an inline-safe wire layer is a build error) — collaboration goes through cordis services.
* **ctx services actually available to a client plugin** (merged Context interface; no `ctx.settings`, `ctx.section`, `ctx.ui` exist):
  - `ctx.slots: SlotRegistry` (from `dsh-client-runtime/client`, `runtime/src/client/slots.ts`): `register`, `inject`, `entries`, `entriesOfSlot`, `subscribe`, `getVersion`, `spec`, `install`, `installLocale`, `snapshot`.
  - `ctx.settingsScope: SettingsScopeBinder` (from `dsh-client-ui-settings/client`): `bind(spec) → SettingsScope<T>`.
  - `ctx.locale: LocaleRuntime` (from `dsh-client-locale/client`): `register`, `bind`, `getSnapshot`, `subscribe`, `setLocale`.
  - `ctx.workspaces: IWorkspaces` (runtime): `list` observable + connect/create/rename/delete/etc.
  - `ctx.sessions`, `ctx.remote`, `ctx.conversationEvents`, `ctx.conversationViews`, `ctx.modules` (client-modules loader), plus `ctx.get('connection')` → `ConnectionHandle` with `.api: IApiClient` and `.isLoopback`.

### Registration API signature (`dsh-client-ui-slots`, `SlotCore.register`, implemented by the `SlotRegistry` service on the prototype so disposers land in the caller's fiber)

```ts
register<K, ...>(options: {
  name: K                        // target slot key (must be declared)
  children?: ChildrenDecl        // declares child slots: { 'slot.name': { kind, scope } }
  store?: StoreDecl              // optional store seat
  locale?: N                     // dictionary namespace → framework puts a typed `t` prop on the component
  inject?: (...params) => I      // business-face factory (returned hooks land as use<Name> props)
  id?: string; order?: number; label?: SlotLabel   // list-kind shape
  priority?: number
}, component: (props) => ReactNode): () => void
```

* Component = **plain React function component**, imported from the same package's `src/client/*.tsx` (never inline JSX in `index.ts`). Props are the *four-share composition*: `PropsRuntime<'settings.section'>` (owner props + global hooks `useSessions`/`useWorkspaces`) & `PropsRenderSlots<...>` (child slots) & `PropsStore<...>` & the inject face & `PropsLocale` (`t`) — see `packages/client/AGENTS.md` rule 3 and the `ComposedProps` type in `ui-slots/src/index.ts`.
* **`ctx.slots.inject(key, cb)`** (`runtime/src/client/slots.ts`) is the order-independent registration seam: the callback runs synchronously when the slot declaration exists, else on each declaration lifetime; unload disposes. `ctx.slots.register(...)` inside it; generators allowed (multiple registrations, e.g. `function* () { yield a; yield b }`).
* Rendering: the web shell (`packages/client/web/src/app-shell.ts`) calls `ctx.slots.install(createSlotRenderer())` (web-react renderer) and renders `root`. `ui-layout`'s `AppFrame` occupies `root` and declares `sidebar`, `conversation`, `details`, `shell.overlay`. `ui-sidebar` declares `sidebar.settings`, and `ui-settings-general` occupies it with `SettingsRoot` which renders nav + each section via `renderSlot('settings.section', { close: onClose }, { only: activeId })`.

`ctx.slots.register` throws at load time on: undeclared target slot, duplicate `id` at same priority (list slots), duplicate child-slot declaration, store under two scopes; `settings.section` entries with same `id` shadow at different `priority` (lowest wins).

## 2. Settings page composition

* Shell: `ui-settings-general` `SettingsRoot.tsx` + `SettingsPanel` (modal dialog, `role="dialog"`, left nav rail, right content column). **Nav = flat list of every `settings.section` registration**, projected in `client/index.ts` `shellInjected`:

```ts
rows = ctx.slots.entries('settings.section')
  .map(e => ({ id: e.options.id ?? '', order: e.options.order ?? 0,
               label: resolveSlotLabel(e.options.label) ?? '' }))
  .sort((a, b) => a.order - b.order)
```

  subscribed to both the ledger (`ctx.slots.subscribe('settings.section', …)`) and the locale revision, so label thunks re-read fresh text per render (registration-time `label: () => t('nav')` follows locale changes without re-registration).
* Section metadata per registration: `id` (nav key — drives the `only` filter and the shell's icon lookup `navIcon(id)`: known ids `models`, `agent-presets`, `plugins` get specific glyphs, everything else falls back to the gear), `order` (nav position; general=0, models=10, plugins=15, agent-presets=20), `label` (thunk or string; no locale-key indirection — the registrant localizes its own text). No `group` concept, no server grouping.
* Active page: `renderSlot('settings.section', { close: onClose }, { only: active })`; section owner props = **only** `{ close: () => void }` (`ui-settings/src/client/contract/slots.ts` `SettingsSectionOwnerProps`); everything else arrives through the section's own inject face + global hooks. The nav has no default/`default` route metadata — falls back to `rows[0]`.
* Nested groups exist only where a section declares **child slots** and renders them:
  - General page → `settings.general.item` (one column of feature-owned preference rows; `GeneralSection.tsx` is the whole page: `<div>{renderSlot('settings.general.item', {})}</div>`).
  - Plugins page → `settings.plugins.tab` tabs (`ui-settings-plugins` `PluginsSettingsSection`, tab ledger pattern identical to the section ledger) → then the `configurable` tab declares `settings.plugin.item` cards.
  So "group inside a settings page" = your section component + a child list slot you declare and render with `renderSlot`. Nav stays flat.
* Owners of the *slot contract* vs *the shell* are deliberately split: the slot-type declarations (`'settings.section'` etc.) live in `dsh-client-ui-settings` (`ui-settings/src/client/contract/slots.ts`, plain `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }`); the shell component lives in `ui-settings-general` (comment in `ui-settings/src/client/index.ts` explains the cycle reasons). A settings section plugin therefore imports `type {} from '@deepseek-ai/dsh-client-ui-settings/client'` only for the types and `ctx.settingsScope`.
* rc.1 drift (authoritative): installed `dsh-client-ui-settings/lib/types/client/` adds `settings-contract.d.ts` (the `SettingsScope*` types moved here from `dsh-client-runtime`), `settings-mirror.d.ts`, `schema.d.ts`; `SettingsScope` additionally exposes `mutate(ops, expectedRevision?)`. Slot contract and `SettingsScopeBinder.bind` are unchanged (`bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>`).

### Chamber GUI "server area" — chamber-specific

Yes, chamber-specific. `~/projects/dsh-chamber/packages/dsh-chamber-client-ui-settings-bridge/src/client/index.ts`:

> "registers the「设置 / Settings」shell into the `sidebar.settings` slot at a LOWER priority than the official SettingsRoot registration, so the official shell is shadowed… The shell itself (SettingsShell.tsx) mounts a child cordis context per selected server and renders the chamber-global connections surface as a fixed nav entry."
> `const SHADOW_PRIORITY = -1` … `ctx.slots.register({ name: 'sidebar.settings', id: 'chamber-shell', priority: SHADOW_PRIORITY, ... }, SettingsShell)`
> "The per-server「dsh 运行时」settings.section is NOT registered here: the shell renders the SELECTED server's child-cordis-context ledger, so the section registers per session via createRuntimeSectionPlugin(instanceId) in bridge-context.ts".

So the "per-server settings area" is the chamber desktop/control-plane GUI (server dropdown + one dsh web instance per server). The vanilla dsh settings surface has **no per-server or per-workspace dimension at all**.

## 3. Forms and secret fields

### There is no generic schema→form component

`packages/client/schema-form/src/index.ts` (doc comment):

> "Schema/draft model layer for settings editors: rehydrate the wire's serialized schemastery envelope, resolve nodes by settings path, validate drafts, and edit them immutably by path. **Editors render their own controls (the Models page hand-writes its layout) on top of these helpers.**"

Exports: `deletePath, getPath, hasPath, nodeAtPath, rehydrateSchema, setPath, validateDraft` + type `SchemaNode`. Used e.g. in `ui-settings/src/client/settings-scope.ts` to validate a wire section against its schema (`validateDraft(rehydrateSchema(view.schema), view.value)`).

### The official "form" pattern — staged, hand-written controls

Reference: `ui-settings-plugins` (`BashCard`, `AgentLoopCard`, `WebSearchCard`) — `card-form.ts` (form model) + `fields.tsx` (controls) + `PluginCard.tsx` (chrome). Architecture:

* `CardForm<T>` holds per-field specs (`textField`/`numberField` = `{field, format(value)→text, parse(text)→{kind:'set'|'clear'}|undefined}`) plus `CardSecretSpec`s (`{field, write(text)→Promise<boolean>}` for credentials). Drafts are staged; **nothing writes until Save**.
* Shell state: `{available, writable, dirty, invalid, saving, failed}` where `available = snapshot.status === 'ready'`, `writable = snapshot.writable` (read-only documents disable all controls; the whole card renders nothing when the namespace is not served to this client).
* Writes on save: `scope.set(field, value)` / `scope.unset(field)` for section fields (a field whose user-layer *presence* exists is "overridden"; clearing = `unset` so it re-inherits composition `base`/defaults), secrets go to `credentials.set` (see below). The Host is the only authority: after writes the form re-reads and re-seeds (CardForm.save: "The Host is the only authority on whether a value was accepted… so the outcome is read back from the section rather than predicted here.").

Control anatomy (`fields.tsx`, trimmed): `ValueField` renders label + staged `<input>` + invalid/overridden badges + reset; `SecretField` (the "credential input"):

```tsx
/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 */
export function SecretField(props: Pick<FieldProps,'id'|'label'|'hint'|'text'|'disabled'|'onEdit'> & {
  configured: boolean
  stateLabel: string
}) {
  ...
  <input id={props.id} type="password" autoComplete="off"
         value={props.text} disabled={props.disabled}
         onChange={(event) => { props.onEdit(event.target.value) }} />
  ...
}
```

### Where 'secret-role' / secrets live (host schema roles)

Grep of all of ref-dsh for `secret-role`/`role('secret')`:
* **Only one literal mention of "secret-role"** — a *description* of container semantics in `packages/settings/settings/tests/redact.spec.ts` ("treats a secret-role container as one opaque secret leaf"). The actual API is schemastery's `.role('secret')` and `.role('credential-ref')` on the **Host plugin's schema**, e.g. `packages/web/web-search-deepseek/src/index.ts`:

```ts
export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),                  // literal never crosses a wire
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV), // names the credential store ref
  baseURL: z.string(), ...
})
```

* Host side (`packages/settings/settings/src/redact.ts`): `redactSecrets` strips every `role('secret')` field from `value`/`base`/`user` **before any wire boundary** and returns a sidecar enumerating positions:
  ```ts
  export interface RedactedSecret { path: string[]; set: boolean }  // "whether the field held a value before redaction"
  ```
  `SettingsDescriptor` carries `secrets?: RedactedSecret[]` and `SettingsDescribeOptions.redactSecrets` says: "Strip `role('secret')` fields from `value`/`base`/`user` and enumerate them in each descriptor's `secrets`. **Every wire surface MUST pass this.**"
* Path-based mutation exists precisely because UIs hold redacted views (`packages/settings/settings/src/index.ts`, `SettingsPathOp = {op:'set'|'unset', path: readonly string[]}`): "a configuration UI reads the redacted descriptor, which by construction never received the role('secret') fields… a wholesale replace rebuilt from a redacted document silently deletes every secret the wire never returned."

### Saving a secret — the official call chain

The official pages **never write a secret into the settings section**. Section schema fields that are secrets are `credential-ref`s; the literal goes to the **credentials domain** on the same RPC client:

`ui-settings-plugins/src/client/web-search-card-controller.ts` (constructor + writeKey):

```ts
constructor(private readonly scope: SettingsScope<WebSearchSettings>,
            private readonly api: Pick<IApiClient, 'credentials'>) {
  this.form = new CardForm(scope,
    [textField('baseURL'), numberField('maxUses')],
    [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }])   // secret spec: written OUTSIDE the section
  ...
}
private async readCredential(): Promise<void> {
  const ref = refOf(this.scope.getSnapshot())        // snapshot.value.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  ...
  const response = await this.api.credentials.describe({ refs: [ref] })   // → {credentials: {[ref]: {configured, writable}}}
  ...  // publishes configured/writable only
}
private async writeKey(value: string): Promise<boolean> {
  try { await this.api.credentials.set({ ref: refOf(this.scope.getSnapshot()), value }) } ...
  await this.readCredential()
  return this.credential.configured
}
```

And the settings-namespace write path that `SettingsScopeController` implements (`ui-settings/src/client/settings-scope.ts` → `SettingsScope.set/unset`):

```ts
response = await this.api.settings.mutate({
  ns: this.spec.namespace,
  ops: [op],                                   // { op: 'set'|'unset', path: [field], value? }
  ...(revision === undefined ? {} : { expectedRevision: revision }),
})
```

The **Models page** is the fullest example (`ui-settings-models/src/client/store.ts` + tests in `provider-form.client.spec.tsx`): it reads namespace `llm-pi-ai` (`api.settings.describe`), writes non-secret fields with `settings.mutate` (`ns`, `ops:[{op:'set',path:[...]}]`, `expectedRevision`), and stores keys with `api.credentials.set({ref: '<PROVIDER>_API_KEY', value})` where the ref is derived by `deriveKeyRef(id)` (uppercase id + `_API_KEY`, must match `/^[A-Za-z_][A-Za-z0-9_]*$/`), describing credentials via `credentials.describe({refs})` to show "configured/not configured, writable/not writable". The key control renders a plain password input whose draft **starts blank on every load** and stores nothing when left blank.

Push freshness: `ctx.remote.$on('settings/document-updated', ns => …)` and `ctx.remote.$on('credentials/updated', ref => …)` forwarded events (registered with `ctx.effect`) + `ctx.on('connection/reset')`; 0.1.2-rc.1's ui-settings base additionally owns a shared describe mirror so every scope refreshes from one wire read.

## 4. Locale (en-US/zh-CN requirement)

* There is **no i18n.yaml runtime format**. Each package has a `README.i18n.yaml` but it is a *bilingual README pairing record* ("Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each side…"), i.e. repo tooling, not translation data.
* Translations are **TypeScript dictionaries in code**, per package: `src/client/locales.ts` exporting a flat key union + `export const en: Record<Key,string>` and `export const zh: Record<Key,string>` mirror (quotes above: `nav: 'Plugins'` / `nav: '插件'`). Values are template strings with `{name}` params (locale's `translate` substitutes `\{(\w+)\}`).
* Registration (once per plugin, in `apply`, inside `ctx.effect`): `ctx.locale.register(NS, { zh, en })` where `NS` is a **dictionary namespace declared via `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { '<ns>': KeyUnion } }`**. Typed registration requires **all built-in locales** (`record<BuiltInLocaleId, LocaleDictOf<N>>`, `BuiltInLocaleId = 'zh' | 'en'` in 0.1.2-rc.1, `dsh-client-locale/lib/types/locale-settings.d.ts`) — a missing language is a compile error; duplicate `(ns, locale)` throws at runtime.
* Namespacing convention: `'<feature-area>.<feature>'` — official namespaces: `settings` (shell+General), `settings.models`, `settings.plugins`, `settings.agentPreset`, `settings.permission`, `settings.locale`, `workspace`, `skill`, `theme` (via `common` for shared vocab). **The key passed to `t()` is the bare dictionary key, not a namespaced id** — the namespace is bound once (`const t = ctx.locale.bind(NS)` gives a stable translate; slot registrations that set `locale: NS` get a framework-synthesized `t` prop with the same domain).
* Lookup chain (`dsh-client-locale/src/client/index.ts` `translate/lookup`): entry's namespace in active locale → that namespace's **zh fallback** → shared `common` namespace (active then zh) → the raw key ("missing text stays visible, fail loud in the UI rather than blank"). `FALLBACK_LOCALE = 'zh'`; browser language provisional until a durable `settings {preference}` selection exists.
* Language switching: `ctx.locale.setLocale(id)` (persists via host settings namespace `locale`, field `preference`); registered dictionaries never re-register on switch — the LocaleFace revision drives re-renders (nav label thunks re-evaluate per render) and `locale/change` fires for the switch itself.

## 5. Tool-list UI and workspace rows

### (a) Lists of tools on the client

Searched all client packages for `listTools/getTools/tools.list` and tool-catalog service names: **no client tool-registry listing API exists** in the official UI (ref-dsh master and rc.1 types). What officially exists:

* **Tool *calls*** (rendering a run's tool invocations) — `ui-tool`: registers tool views into slot `tool.call.toolview` (keyed slot), e.g. `ui-skill`:
  ```ts
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'skill', locale: NS }, SkillRow))
  ```
  Data comes from session snapshots/projections (tool-call tree in runtime `sessions/tool-call-tree.ts`, request inspection holds `tools: readonly ToolSchema[]` for the *in-flight request* only).
* **Skill catalog** — session-scoped: `(ctx.get('connection') as ConnectionHandle).api.skills.list({ sessionId })` with per-session cache/invalidation (`ui-skill/src/client/index.ts`).
* **Slash commands** — session-scoped via `ctx.remote.commands.list(sessionId)` + `commands/change` events (`ui-commands/src/client/service.ts`).
* The full RPC surface (`IApiClient`, `packages/host/apiproxy/src/fetch/client.ts`) has groups: `sessions`, `subagents`, `host`, `workspace`, `skills`, `agentPresets`, `goals`, `settings`, `credentials`, `llm`, `events` — **no tools group**. Tool availability is decided host-side per agent/session.
* Conclusion for our feature: any "list of tools to toggle" must come from our own Host extension (a cordis service + RPC or a settings namespace projection); there is no official listing to reuse.

### (b) Per-workspace toggle rows — what officially exists

**No official settings UI enumerates workspaces into per-workspace toggle/select rows.** What exists:

* `ui-permission-presets` is a **single General-settings row** (`settings.general.item`, id `permission`, order −20) letting the user choose the default preset *for sessions created later*; the per-session permission select is rendered from the host-computed `permissions` **projection** of the current session (`session.projections.faceOf('permissions')`), and choosing executes the `/permission <preset>` command — see `ui-permission-presets/src/client/index.ts` (`inject = ['commandUi','sessions','slots','locale','connection','remote']`, row written through `PermissionPresetSettingsController(connection.api)` on settings namespace `permission-presets`-ish, invalidations via `ctx.remote.$on('settings/document-updated', ns => ns === PERMISSION_SETTINGS_NS)`).
* `ui-agent-preset` registers **two settings surfaces**: a General row (`id 'agent-preset'`, order −25: default preset) and a full **settings section** (`id 'agent-presets'`, order 20) whose page manages the preset roster (copy/delete/default); a per-session chip applies the staged preset when a workspace connects. This is "per-session/roster", not "per-workspace".
* **Enumeration of workspaces client-side** (what a per-workspace UI *would* use): the global standard hook `useWorkspaces` is delivered to every slot component (runtime merge in `runtime/src/client/index.ts`: `useWorkspaces: SnapshotSelectorHook<WorkspaceListState>` in `GlobalStandardProps`; web-react binds it from the slot host's `workspaces.list`, `web-react/src/scoped-slots.tsx`). The service face (`ctx.workspaces: IWorkspaces`, `runtime/src/client/contract/workspaces.ts`) exposes `readonly list: ObservableSnapshot<WorkspaceListState>`. State shape (`runtime/src/client/workspaces/service.ts`):
  ```ts
  export interface WorkspaceListState {
    items: readonly WorkspaceView[]
    archivedSessionIds: readonly SessionId[]
    state: 'idle' | 'loading' | 'error'
    phase: WorkspaceListPhase
    error: RpcError | null
    baselinesReady: boolean
    recentWorkspaceId: WorkspaceId | undefined
  }
  ```
  `WorkspaceView` (`packages/host/apiproxy/src/api/workspace.ts`): `{ workspaceId: WorkspaceId (branded), path: string, title: string, sessionIds: SessionId[], createdAt, updatedAt }`. Official consumers: `ui-workspace` `WorkspaceBrowser.tsx` (`const workspaces = useWorkspaces(state => state.items)`), `WorkspacePicker`.
* **Row pattern to copy for toggles**: feature row registered into `settings.general.item` (or rows inside your own section), with a **`store` seat** for row-local state (see `ui-theme` AppearanceRow + `ui-conversation` EnterBehaviorRow: `ctx.slots.register({name:'settings.general.item', id:'appearance', order:10, store, locale:'settings.theme', inject: injected}, AppearanceRow)` — inject factory receives baked `actions` when a store is declared; props get `useStore`) and persistence through a settings namespace bound with `ctx.settingsScope.bind({namespace})`, e.g. ui-theme `inject = ['slots','locale','connection','remote','settingsScope']`, `const host = ctx.settingsScope.bind<ThemeSettings>({namespace: THEME_SETTINGS_NAMESPACE})`. Per-workspace *values* would naturally be stored as one section per feature containing a dict keyed by `workspaceId` (mirroring `llm`'s `providers: Schema.dict(...)` pattern) or per-workspace rows are derived host-side.

## 6. modules + runtime — what ships, who bundles, dev vs prod

* **Browser code is always prebuilt.** Official flow (verified in the installed 0.1.2-rc.1 package): tsdown emits `lib/index.js` (node half) and `lib/client.js` (browser half) per package. The client bundle is CJS wrapped as `window.__ModuleLoader__.load({ id: '<package-name>', factory: (require) => { ... return module.exports; } })` (`packages/client/tsdown.client.ts` — "Emits a closure-factory artifact… resolves externals through the injected require (loader module table — cordis DI entities, no globals, no import map)"). CSS Modules are compiled by lightningcss into the bundle: importing `x.module.css` yields a hashed class map and injects `<style data-plugin="<id>">` at factory execution; the loader removes the tags on unload.
* **Externals = the frozen module table only**: `PLATFORM_MODULES` from `packages/client/web/src/platform.ts`: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-attachment`, `@deepseek-ai/dsh-client-schema-form`, plus the documented exemption `@deepseek-ai/dsh-client-runtime/client`. **Every other dependency is inlined into the bundle** (`noExternal`), and any other `@deepseek-ai/*` value import is a *build error* (purity gate plugin in tsdown.client.ts) — cross-plugin collaboration is service-only.
* Runtime loading (`dsh-client-modules`, browser half `system.ts` + `manifest.ts`):
  - The Host node half (`modules/src/index.ts`, service `ClientModuleRegistry`) scans cordis-loader entries for `package.json#dsh.client`, reads each package's `exports['./client']` file from disk, hashes it, and composes `window.__DSH_BOOT__` = `{rev, entries: [{id, url: '/plugins/<id>/client.js?rev=…', inject: [...], immediately?}]}` injected into the served index.html. Missing prebuilt bundle ⇒ loud boot error "client bundle not found… run `pnpm run build` before launch".
  - Browser: `ClientModuleSystem` installs `window.__ModuleLoader__`, then executes classic `<script src="/plugins/<id>/client.js">`; executing only **registers** a factory; materialization (factory(require) → exports) happens lazily on first import by the vendored cordis Loader, self-resolving dependencies among registered bundles. Seed/static modules (react etc.) are answered from the shell instance table; anything unresolvable throws ("not a seed word… not a row in the boot graph (the runtime mirror of the bundle purity gate)").
  - So: **a plugin must ship its compiled `lib/client.js`; a user install has no compile step**, and your package cannot rely on the Vite/dev module graph of the shell. In the monorepo dev flow, tsdown watch + `dsh-client-hmr` invalidate/rebuild bundles (`ctx.modules.invalidate(id)`); production serves the built artifacts. The `runtime` package itself (sessions/workspaces/slots services) is one of these plugin bundles (immediately-tier row), while `web`/`app-shell` ship inside `dsh-web-frontend`.
  - 0.1.2-rc.1 deployment layout proof: gateway `dsh-anchor` npm-installs `@deepseek-ai/dsh@0.1.2-rc.1` (feature plugin set incl. every `dsh-client-ui-*` shown in §"packages" below) and `@deepseek-ai/dsh-web-frontend@0.1.2-rc.1` (the built web app, `exports: {"./dist/*": "./dist/*"}`, zero runtime deps — the platform modules are inside its bundle).

## 7. ui-workspace and workspace enumeration (verification)

`ui-workspace` exists (`packages/client/ui-workspace/src/client/index.ts`): two registrations — `WorkspaceBrowser` fills the sidebar's `sidebar.workspaces` seat ("the whole browsing region") and `WorkspacePicker` fills the conversation hero picker seat; both declare `single` directory-flow child slots (`sidebar.workspaces.directoryFlow`, `conversation.hero.workspace.directoryFlow`) occupied by picker compositions (`ui-directory-picker-native`/`-browse`). Workspace rows live in `sidebar.workspaces` (each row: workspace title + its accounted sessions; per-workspace row ops = rename/delete/new-session via `ctx.workspaces`), **not** in Settings. There is no `workspaces` settings section anywhere in ref-dsh; Settings' nav knows only `general/models/plugins/agent-presets` sections. Workspace enumeration API = `ctx.workspaces.list` / `useWorkspaces` (see §5b).

---

## Packages to depend on (0.1.2-rc.1 deployment)

Verified installed versions (gateway dsh-anchor node_modules):

| package | installed | role in a UI settings plugin |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-settings` | 0.1.2-rc.1 | `settings.section` slot types + `ctx.settingsScope` (`SettingsScopeBinder.bind`); type-only import |
| `@deepseek-ai/dsh-client-locale` | 0.1.2-rc.1 | `ctx.locale` merge; locale namespaces/types |
| `@deepseek-ai/dsh-client-runtime` | (shell-bundled; monorepo 0.1.0-rc.x) | `ClientContext`, global-hook merges; type-only |
| `@deepseek-ai/dsh-client-ui-slots` | (shell-bundled) | value import ok: `resolveSlotLabel`, all `Props*`/`SlotMap` types |
| `@deepseek-ai/dsh-client-web-react` | (shell-bundled) | value import ok: `bindSnapshotSelector` |
| `@deepseek-ai/dsh-client-ui-primitives` | (shell-bundled) | icons/primitives (`IconSettingsOutline16` etc., `Button`, …) |
| `@deepseek-ai/dsh-client-schema-form` | (shell-bundled) | value import ok: `validateDraft/rehydrateSchema` if needed |
| `@deepseek-ai/dsh-client-connection` | 0.1.2-rc.1 | `ConnectionHandle`/`IApiClient` types |
| `@deepseek-ai/dsh-api-remotes` | 0.1.2-rc.1 | `ctx.remote` merge (`settings/document-updated`, `credentials/updated`), type-only |
| `@deepseek-ai/cordis` | 4.0.2 | `Service`, `Context` |
| `react` | 18.3.1 (peer `^18.2.0`) | components |
| `@deepseek-ai/dsh-settings` + `@deepseek-ai/schemastery` | host-side | only if the plugin also ships a Host half registering its namespace (`installSettingsSection`) |

Runtime-external (frozen table) specifiers your bundle may `require`: the PLATFORM_MODULES list above + `@deepseek-ai/dsh-client-runtime/client`. Everything else is inlined at build. A Host-half settings namespace registration (server side, quoted from `packages/web/web-search-deepseek/src/index.ts`):

```ts
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
export const WEB_SEARCH_NS = settingsNamespace('web-search-deepseek')
...
installSettingsSection(ctx, WEB_SEARCH_NS, Config, config, {
  setSource: (source) => { current = source },
  onChange: () => {},
})
```

## Minimal bilingual settings-section plugin skeleton

Package `my-settings-plugin` (name it per your convention, e.g. `@your-scope/dsh-mcp-scope-settings`). Layout mirrors official packages:

```
package.json          # exports "." → lib/index.js, "./client" → lib/client.js, dsh.client{inject,platform:"web"}, files:[lib]
src/index.ts          # host half: no-op apply()
src/client/index.ts   # browser entry (below)
src/client/MySection.tsx
src/client/locales.ts # en + zh
```

```ts
// src/client/index.ts — browser half entry (pattern: ui-settings-models/plugins)
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only merges: 'settings.section' slot + ctx.settingsScope; ctx.locale.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MySection } from './MySection.tsx'
import type { MySectionInjected } from './MySection.tsx'
import { MyScopeController, MY_NS } from './my-controller.ts' // binds ctx.settingsScope
import { en, zh, type MyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'my-scope.settings': MyKey }
}
const NS = 'my-scope.settings'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-scope: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new MyScopeController(ctx.settingsScope.bind({ namespace: MY_NS }), connection.api)

  ctx.effect(() => { /* invalidations: ctx.remote.$on('settings/document-updated', …) + 'connection/reset' */ }, '…')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'my-scope',          // unique nav key
    order: 30,               // after agent-presets(20)
    label: () => t('nav'),   // locale-following thunk
    locale: NS,
    inject: (): MySectionInjected => ({ hooks: { myScope: controller.store }, ...controller.actions() }),
    children: { 'my-scope.settings.row': { kind: 'list', scope: 'root' } }, // optional nested list
  }, MySection))
}
```

```tsx
// src/client/MySection.tsx — component (any section officially looks like this)
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
export type MySectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'my-scope.settings'>
  & InjectFace<MySectionInjected> & PropsRenderSlots<'my-scope.settings.row'>
export function MySection({ close, t, renderSlot, useMyScope }: MySectionComponentProps) {
  const state = useMyScope(s => s)
  // hand-written staged form controls (see §3) writing through injected actions
  // → scope.set/unset for plain fields, connection.api.credentials.set for secrets
  return <div>…</div>
}
```

Per-workspace rows inside it: read `useWorkspaces(s => s.items)` (global hook — always present on section components), and toggle state stored in the Host namespace (e.g. dict keyed by `workspaceId`); row persistence pattern = `PermissionRow`/`AppearanceRow`.

### Facts not to get wrong

1. `settings.section` registration happens in the **browser plugin** (`src/client/index.ts`), the slot is declared by `dsh-client-ui-settings`, the *page* is your own component; **nothing server-side declares UI sections**.
2. Register through **`ctx.slots.inject('settings.section', …)`**, never `ctx.slots.register` directly at apply time — declaration order across plugins is unconstrained; `inject` waits for the declaration.
3. A section's **`label`** must be the localized text (string or thunk) — the shell does not translate; there is no locale-key indirection. Register **`locale: NS`** to get the typed `t` prop.
4. `settings.section` list entries need a unique **`id`** (duplicate id at same priority throws) and are sorted by **`order`**; unknown `id`s fall back to the gear nav icon; no groups.
5. **Secrets never ride responses**: store the literal via `api.credentials.set({ref, value})`; keep a `credential-ref` (env-style name) in the section; never write `role('secret')` paths through settings mutate; treat the input as write-only (blank draft = keep stored key); badge "configured/unset" comes from `credentials.describe({refs})`.
6. **No generic schema-form component exists** — copy the staged `ValueField`/`SecretField` + `CardForm` pattern; use `dsh-client-schema-form` helpers (`validateDraft`, `rehydrateSchema`) only for validation.
7. Locale: both languages are **required** per namespace (`register(ns, {zh, en})`, compile-enforced); keys are flat strings with `{param}` interpolation; fallback chain en→zh→common→key. Lookup of the *active* locale is call-time — bind `t` once.
8. Your package must **ship a prebuilt `lib/client.js`** in the exact `__ModuleLoader__.load` factory shape with only the platform-table externals; otherwise the browser cannot load it (dev-time source loading does not exist in user installs). Ship `lib/types/**/*.d.ts` too (the `./client` types subpath is what other packages' type-only imports resolve).
9. Cross-package **value imports are forbidden** (build gate + runtime module table). Runtime collaboration = cordis services (`ctx.settingsScope`, `ctx.locale`, `ctx.slots`, …); type-only imports for merges.
10. Writes to settings are revision-fenced (`expectedRevision`); a stale write returns a conflict and the client re-reads. Fields are marked overridden by **presence in the user layer**, not by value comparison; `unset` restores composition `base`/schema default.
11. Workspace enumeration is `useWorkspaces`/`ctx.workspaces.list` with `WorkspaceView {workspaceId,path,title,sessionIds}` — but there is **no official per-workspace settings precedent and no tool-list registry API** in 0.1.2-rc.1; those parts of the feature are greenfield (Host extension needed for data).

### Unknowns / to verify during implementation

* Whether rc.1's settings **write path for `role('secret')` section fields** is outright rejected host-side or silently routed to the credentials store is not documented in client code (official clients never attempt it). Plan on the credential-ref pattern only.
* Full rc.1 drift surface of `dsh-client-locale` (locale *definitions* registry: `registerLocale`-style APIs visible in installed types for language-pack plugins — `BuiltInLocaleId` vs open `LocaleId`); not needed for shipping zh+en.
* The exact serving path of `/plugins/<id>/client.js` for scoped package names (URL-encoding) and the shell's `dsh.client.inject` "immediately" flag policy were not needed to author a plugin; verify against the gateway's webServer config when deploying.
* Whether extra dictionaries (e.g. `common` vocabulary additions) must also be registered before first render — minor; official plugins only register their own NS.
* Host-side namespace naming rules (`settingsNamespace(...)` branding + collision behavior) when adding the Host half of the plugin; check `dsh-settings` docs (`docs/` in ref-dsh) at implementation time.
