# Recon: how a third-party dsh plugin package is structured, published, and installed

**Task**: determine EXACTLY how a third-party plugin package is structured, published, and
installed into a dsh instance ("user-installed model"), so we can build one.

## Sources consulted (and their version skew — read this first)

| Source | Version | Kind |
|---|---|---|
| `~/projects/dsh-chamber/ref-dsh` | root `0.1.0-rc.5` | TypeScript source (logic of record) |
| `/root/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh` | `0.1.1-rc.2` | global CLI (`dsh` on PATH) |
| `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/*` | `0.1.2-rc.1` | **the running instance's install** (authoritative artifacts) |
| `/root/.dsh-chamber/gateway/data/dsh-home` | — | real `$DSH_HOME` of the running gateway |
| `/root/.dsh-chamber/gateway/versions/0.2.1` | gateway wrapper 0.2.1 (`dshAnchorVersion 0.1.2-rc.1`) | boots the instance |

⚠ The ref-dsh checkout is OLDER than the installed anchor. Everywhere the two disagree,
the anchor (`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/…`) plus the
composed dump `/root/projects/dsh-mcp-scope/.recon/dump-web.yml` are ground truth for this machine.

---

## 0. One-paragraph model

dsh has **no plugin-registry runtime**. A dsh instance is a **profile**: a directory
`$DSH_HOME/profiles/<name>/` whose `package.json` (`dsh.profile.bundles`) lists **bundle
packages in order**. A bundle is an ordinary npm package whose manifest declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; that YAML file is a list of
**patch rows** that insert or override **loader rows** over an empty root entry list.
`dsh plugin --profile <name> <pnpm-args…>` = "run pnpm in the profile dir, then reconcile
`dsh.profile.bundles` against what is now installed" — a dependency whose manifest declares
`dsh.bundle` becomes the next bundle layer; anything else is a plain dependency (warned).
At boot the CLI composes every layer through the include plugin's patch algorithm and the
Cordis Loader mounts each row by importing its `name` (a module specifier) — host rows from
Node packages, client rows from dual-face packages that also ship a prebuilt browser bundle
exposed as `exports["./client"]` and declared `"dsh": { "client": … }`, served by the host at
`/plugins/<package>/client.js` and listed in `window.__DSH_BOOT__`.

---

## 1. What a published plugin package looks like

### 1a. The bundle manifest (configuration layer; this is what `dsh plugin add` recognizes)

From `docs/user/develop/basic/publish.md` (ref-dsh) — official wording:

> - A **bundle** is an npm package that ships a configuration layer. Its manifest declares
>   `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts
>   or overrides plugin rows.
> - A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable
>   composition. Its manifest declares `dsh.profile` …
> - A bundle is what you author and distribute; a profile is what a user boots with
>   `dsh --profile <name>`. Nothing is both.

Minimal authored package (doc, verbatim):

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

with plugin code `export const name = 'hello-plugin'; export function apply() {...}` and a
patch file:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

Official in-repo bundles look like this (anchor `@deepseek-ai/dsh-web-app/package.json`,
0.1.2-rc.1 — also representative exports/files map):

```json
"main": "lib/index.js",
"exports": {
  ".":                { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./startup":        { "types": "./lib/types/startup.d.ts", "default": "./lib/startup.js" },
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./src/*":          "./src/*",
  "./package.json":   "./package.json"
},
"files": ["lib/index.js", "lib/startup.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Notes:
- The `dsh.bundle` manifest has exactly one key, `patch` (relative path to the patch list).
  Type: `interface DshBundleManifest { patch: string }` in `ref-dsh/packages/boot/app-boot/src/profile.ts`.
- `"./src/*"` is exported for dev tooling (tsx/HMR). `cordis.patch.yml` is exported for
  config dumps, but the boot code reads the patch **by path**, not by import
  (`loadOverlayPatches(binName, patchPath)`).
- A package with **no** `dsh.bundle` still installs fine but is only a library dependency:
  `dsh plugin` prints a warning and adds no layer (verified live, §2b).
- The bundle's patch may reference **subpath rows** of its own or other packages, e.g. the
  real web row `- id: web-startup / name: '@deepseek-ai/dsh-web-app/startup'`, or base row
  `- id: tool-subagent-list-agents / name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'`.

### 1b. Dual-face packages (client plugins / host+client rows)

Official *client* packages are dual-face npm packages. Anchor
`@deepseek-ai/dsh-client-ui-settings/package.json` (0.1.2-rc.1):

```json
"main": "lib/index.js",            // HOST half — importable by the host Loader (usually a no-op apply)
"exports": {
  ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./src/*":  "./src/*",
  "./package.json": "./package.json"
},
"files": ["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts"],
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-api-remotes"], "platform": "web" } }
```

- Host half (`lib/index.js`) is literally (source: `ref-dsh/packages/client/ui-settings/src/index.ts`):
  ```ts
  /** Host loader entry for the browser implementation exported from `./client`. */
  /** Host plugin body — no host-side behavior for the settings domain base plugin. */
  export function apply(): void {}
  ```
- Browser half is a **prebuilt bundle** (`lib/client.js`, tsdown) whose export registers a
  plugin for the browser-side Cordis loader (CJS factory table; see
  `ref-dsh/packages/client/modules/src/client/manifest.ts`). It uses only service
  collaboration (`ctx.slots`, `ctx.locale`, `ctx.remote…`, `ctx.get('connection')`); cross-plugin
  value imports are a build error ("client bundle purity gate").
- `dsh.client` declaration fields (validated by the modules node half,
  `ref-dsh/packages/client/modules/src/index.ts`):
  ```ts
  interface DshClientDeclaration {
    inject?: string[]        // package-name dependency edges (service providers to wait for)
    platform: string         // only platform === 'web' composes into the browser graph
    immediately?: boolean    // stage-one prefetch; absent = lazy
  }
  ```
- Declaring `dsh.client` without exporting `"./client"` throws at boot:
  `client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`.

**How installed third-party code reaches the running host and browser — the actual mechanism**:

- There is **no runtime scan of a "plugins dir"**. Everything runs because a *loader row*
  whose `name` resolves is part of the composed entry tree, mounted at boot by
  `@deepseek-ai/cordis-plugin-loader` (module resolution from the config tree's `baseUrl`).
- Third-party packages join the tree in exactly two ways:
  1. **As a bundle** in `dsh.profile.bundles` (via `dsh plugin add`) — its patch inserts rows
     or overrides existing rows;
  2. **As rows named by any patch the user controls**: the profile's `cordis.patch.yml`,
     `$DSH_HOME/cordis.patch.yml`, or a `--patch <file>` overlay — e.g. the running gateway's
     `dsh-chamber-graph.patch.yml` inserts rows naming `@dsh-chamber/*` packages
     (§6). Row `name` just needs to be a package resolvable from the profile dir (its
     pnpm-managed `node_modules`).
- Host code runs in-process when the Loader imports `name` (package `main` or a subpath).
- Client code reaches the browser via `@deepseek-ai/dsh-client-modules` (row `modules`): it
  scans mounted entries whose packages declare `dsh.client`/`exports["./client"]`, and serves
  `/plugins/<package-name>/client.js?rev=…` (content-hash `rev`), and injects
  `window.__DSH_BOOT__ = {rev, entries:[{id,name,url,rev,inject?,immediately?}]}` into
  index.html. `id` in that graph **is the package name**. The web shell kernel then lazily
  loads each bundle (immediately-flagged ones in stage one).

---

## 2. The CLI: verbatim behavior and what `dsh plugin add` does

### 2a. Verbatim help (installed global CLI 0.1.1-rc.2, PATH-env `dsh`)

```
Usage: dsh [options] [command] [args...]

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                        arguments for the booted profile's app (see: dsh
                              --profile <name> --help)

Options:
  -V, --version               output the version number
  --profile <name>            the profile under $DSH_HOME/profiles to boot
  --patch <path>              extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config               print the composed profile tree and exit
  --dump-default-config       print the profile tree without its user layer or --patch overlays and exit

Commands:
  web [options] [args...]     boot the web profile (alias of --profile web); the web app's own flags follow
  plugin [options] [args...]  manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory

Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
```

`dsh plugin --help` has no own help — `plugin` requires `--profile`:
`error: required option '--profile <name>' not specified` (then anything after `--profile
<name>` is forwarded to pnpm).

The web app's own flags (captured by actually booting the anchor CLI, exit 0, fresh home):

```
Usage: dsh --profile web [options]

Serve the DeepSeek Harness browser UI.

Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence accepts (host or host:port; repeatable)
  -h, --help                     show this help
```

There are **no other launcher commands** for instances/workspaces/settings: profiles are
managed through `dsh plugin`, debugging through `--dump-config`/`--dump-default-config`,
user data through `$DSH_HOME` files (`settings.yaml` etc.), and runtime state through the
booted app's own flags/surfaces.

### 2b. What `dsh plugin add <pkg>` actually does (implementation + live proof)

Implementation: `ref-dsh/apps/cli/src/plugin.ts` (`runPlugin`). Steps, in order:

1. `dir = $DSH_HOME/profiles/<name>` (`resolveProfileDir`; a missing `package.json` →
   `initProfile(dir, PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES)` + stderr
   `dsh: initialized profile <name> at <dir>`). Template list (anchor app-boot,
   `lib/index.js`): `acp`, `web`, `headless`, `sdk`, `sdk-minimal` each
   `{ bundles: [...], patchReload: "live"|"startup" }`; **any other name gets
   `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`** and `patchReload: "live"`.
2. `spawnSync('pnpm', args, { cwd: dir, stdio: 'inherit' })` — the args are the raw
   remainder verbatim (relative `.`/`..` path specs are re-anchored to the user's cwd by
   `anchorPathSpec`, so `add ./checkout` links the user's directory, not the profile).
   pnpm ≥10 note: git dependencies need `allowBuilds:` in the profile's
   `pnpm-workspace.yaml` before their `prepare` scripts may run.
3. On pnpm exit 0: `reconcilePlugins(before, dir)` —
   - reads the installed `dependencies` and each one's manifest via two-anchor resolution
     (`resolveBundleDir(NAME, pkg, INSTALL_ANCHOR, profileDir)` = dsh installation first,
     then the profile dir);
   - if `manifest.dsh?.bundle?.patch !== undefined` and the name is not yet listed → **append
     to `dsh.profile.bundles`** and rewrite `package.json` (2-space JSON, trailing NL);
   - if it declares no `dsh.bundle` and was newly added by this pnpm run → warning
     (verbatim, observed live):
     ```
     dsh: warning: @recon/plain-lib declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
     ```
   - a removed dependency (or a version that dropped the declaration) is **removed from
     `bundles`**; template bundles (`@deepseek-ai/dsh-base`, …) are never touched because
     they are not dependencies.
   - Reconciling by installed state (not pnpm's dep diff) means `pnpm update` auto-activates
     a package that gained `dsh.bundle` in a newer version.

**Live proof (ran the real anchor CLI 0.1.2-rc.1 against scratch `$DSH_HOME`, offline,
pnpm 11.21.0):**

```
$ dsh --profile solo            # uninitialized, no template → fails loudly:
Error: dsh: profile "solo" does not exist; create it with 'dsh plugin --profile solo add <package>'

$ dsh plugin --profile solo list
dsh: initialized profile solo at <home>/profiles/solo
```

`initProfile` writes exactly (ground truth):

```
profiles/solo/
├── package.json
├── cordis.patch.yml
└── pnpm-workspace.yaml
```

```json
{
  "name": "dsh-profile-solo",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"], "patchReload": "live" } }
}
```

(`cordis.patch.yml` = the comment template ending in `[]`; `pnpm-workspace.yaml` =
`packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`.)

Then two local demo packages:

```
$ dsh plugin --profile solo add file:/abs/.../recon-plugin-demo   # declares dsh.bundle
… pnpm add output … (exit 0)

$ dsh plugin --profile solo add file:/abs/.../recon-plain-lib     # no dsh.bundle
+ Progress: resolved 2, reused 2, downloaded 0, added 1, done
Done in 389ms using pnpm v11.21.0
dsh: warning: @recon/plain-lib declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

Resulting manifest (note: only the bundle- declaring package joined the layers):

```json
{
  "name": "dsh-profile-solo",
  "private": true,
  "dependencies": {
    "@recon/plain-lib": "file:/abs/.../recon-plain-lib",
    "@recon/plugin-demo": "file:/abs/.../recon-plugin-demo"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@recon/plugin-demo"], "patchReload": "live" } }
}
```

Files changed by one `add`: `profiles/<name>/package.json` (dependencies + bundles),
`profiles/<name>/pnpm-lock.yaml` (pnpm's own), and the pnpm-installed tree under
`profiles/<name>/node_modules/` (hoisted linker, so `node_modules/@scope/pkg`).
`cordis.yml` stays the empty root; nothing outside the profile dir is edited by
`dsh plugin` (the profile-level shared symlink farm is healed at *boot*, not by plugin).

Remove is symmetric: `dsh plugin --profile <name> remove <pkg>` → pnpm remove +
reconcile drops it from `bundles`.

---

## 3. Boot chain: how an instance decides which plugins run

### 3a. Layout of a booted home

```
$DSH_HOME/                                  (env DSH_HOME else ~/.dsh; dsh-home-paths)
├── settings.yaml                           user settings document (llm providers, locale, agent-presets…)
├── cordis.patch.yml                        OPTIONAL home-level patch layer (applies to every profile)
├── profiles/
│   ├── node_modules/                       LAUNCHER-MAINTAINED flat fallback farm: one symlink per
│   │                                       package in the dsh app's dependency closure, pointed at the
│   │                                       installation's real locations (healProfilesModuleFallback)
│   └── web/                                one directory per profile
│       ├── package.json                    dependencies + dsh.profile.bundles (ordered) [+ patchReload]
│       ├── cordis.yml                      empty root entry list — the file the Loader includes
│       ├── cordis.patch.yml                user patch layer (hot-applied when patchReload=live)
│       ├── pnpm-workspace.yaml             nodeLinker: hoisted; autoInstallPeers: false
│       ├── node_modules/                   pnpm-managed out-of-tree deps (real dirs)
│       └── .dsh-module-fallback/           profile-private module-fallback projection dir (anchor ≥0.1.2)
├── sessions/  storages/  worktrees/ …      runtime data dirs written by base rows via dshHomePath()
```

### 3b. Composition (quote from `ref-dsh/apps/cli/src/profile-boot.ts` + `packages/boot/app-boot/src/profile.ts`)

Order, per the module docstring of `profile.ts`:

> A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json`
> (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered
> `bundles` list) and a `cordis.patch.yml` … Bundles are npm packages whose manifest declares
> `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is composed by applying
> each bundle's patch list in `dsh.profile.bundles` order over an empty entry list, then the
> profile's own patches, then any launcher layers (`--patch` files and flag-derived patches).

Full stack in application order (`composeProfile` → `allPatches`):

1. bundle layers: `profile.layers.flatMap(l => l.patches)` in `bundles` order;
2. `profiles/<name>/cordis.patch.yml` (user layer);
3. `$DSH_HOME/cordis.patch.yml` (home layer, "machine-local preferences that apply to every
   profile, so it outranks the per-profile layer");
4. each `--patch <path>` overlay in argv order, then flag-derived patches (agent-presets
   shipped-root injection, telemetry disable `{ id: 'session-telemetry-otel', disabled: true }`).

Then `runProfile`:

```ts
const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => { … })
```

`boot` (app-boot `index.ts`) mounts `Loader` (cordis-plugin-loader), runs `prepare`, then
`mountRootInclude(ctx, absoluteConfigPath, patches)` — it creates a `cordis:include` builtin
entry (`Include` from cordis-plugin-include) whose `config.path` is the profile's `cordis.yml`
and whose `config.patches` are the composed patch list. So:

- the include **reads the profile's `cordis.yml`** (an empty `[]` that is rewritten at every
  boot precisely so loader write-back can never bake composed rows into it), and
- applies **the whole flattened patch list in ONE `applyEntryPatches` call**
  (`composeEntries` does the same offline for `--dump-config`), then
- the include tree's child entries are created by the Loader: for each entry row the Loader
  **imports `name`** (bare specifiers resolved from the profile directory — `ctx.baseUrl` —
  via Node resolution, so pnpm-managed packages and the fallback farm both work) and runs
  the exported Cordis plugin with its `config` (config `!!js` expressions evaluate per-entry
  against the injected context, e.g. `!!js ctx.webStartup.port ?? 3080`, `!!js dshHomePath('sessions')`).

`assertEntriesActivated` then fails loud if any enabled entry has no active fiber.

Two-anchor resolution and the fallback farm (app-boot `profile.ts`):

> Module resolution is two-anchor by construction: a bundle name resolves first from the dsh
> installation (the launcher's own package), then from the profile directory. … In-box bundles
> … always come from the same installation as the running dsh, never from a profile-local copy.

`healProfilesModuleFallback(INSTALL_ANCHOR)` maintains `$DSH_HOME/profiles/node_modules` as
one symlink per package of the dsh app's resolvable dependency **closure** (BFS over
`dependencies` + `peerDependencies`), so an out-of-tree plugin's imports of `@deepseek-ai/cordis`
and any Service-Definition package resolve to the single installation's instances via the
ordinary Node parent walk (profile node_modules → profiles/node_modules). [On a read-only
`$DSH_HOME` filesystem the heal's unlink/re-link of a stale symlink fails with EROFS and boot
aborts — observed on this box.]

### 3c. Which rows exist / run is decided by… code in the patches, not the packages

There is no "enable/disable installed plugin" metadata beyond loader rows: an entry is
`disabled` when a patch says `disabled: true` (web-app disables base rows like `tool-bash`,
`skill-filesystem`, `ui-schedule`, …), and services order activation through row `inject`
lists. Plugin *packages* declare no faces; faces are per-row (`name` module + whether the
package is dual-face).

---

## 4. Plugin inventory: what the instance exposes about installed plugins

### 4a. Host service `plugin-inventory` (row `plugin-inventory` → `@deepseek-ai/dsh-host-plugin-inventory`)

Read-only projection of live Loader entries (ref-dsh `packages/host/plugin-inventory/src/index.ts`):

```ts
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  …
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),        // loader ROW id, e.g. 'plugin-inventory'
        moduleName: entry.options.name,          // module specifier, e.g. '@deepseek-ai/dsh-host-plugin-inventory'
        enabled: !entry.disabled,                // effective enablement incl. disabled ancestor groups
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    return { entries }
  }
}
```

`types.ts`:

```ts
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId      // Branded<'PluginEntryId'>
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase   // 'pending'|'loading'|'active'|'failed'|'unloading'|null
}
export interface PluginInventorySnapshot { readonly entries: readonly PluginInventoryEntry[] }
```

**There is no package `version` and no patch/row payload in the inventory** — a third-party
plugin shows up here automatically the moment its loader row is mounted (fiber active),
identified by row id + package specifier. The UI tab is contributed by client row
`ui-settings-plugin-inventory` (`@deepseek-ai/dsh-client-ui-settings-plugin-inventory`),
which registers into the **Plugins settings section's tab list**:

```ts
ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
  name: 'settings.plugins.tab',
  id: 'all',
  order: 10,
  label: () => t('tab'),
  locale: NS,
  inject: injected,          // { list: async () => (await ctx.remote.pluginInventory.list()).value }
}, PluginInventorySettingsTab))
```

It renders a searchable card list (title = short module name, phase label, enabled/disabled
tag); it is deliberately **read-only** — enable/disable happens through patch config
(`disabled: true` rows), not through this UI.

### 4b. The Plugins *section* itself (where config UI can hang)

Owned by client row `ui-settings-plugins` (`@deepseek-ai/dsh-client-ui-settings-plugins`),
whose section declares a `settings.plugins.tab` slot; its own "configurable" tab declares
`settings.plugin.item` and renders cards that bind **settings namespaces** via the client
settings scope (`ctx.settingsScope`) — host-side namespaces served by `dsh-settings-file`
(`settings.yaml`) through the settings/`api-remotes` transport. Shipped cards: Bash
(`bash:` namespace), Web Search, Agent Loop. There is no generic "register your plugin's
config card" contract — a third-party card is another client plugin registering
`settings.plugin.item` with its own controller (see `card-form.ts`, `slot-contract.ts`).

### 4c. Schema constraints on a plugin package's package.json (summary)

- Loader row (any package): must resolve from host (`main`/exports) and export a valid
  Cordis plugin; `id` unique per tree, `name` must match when overriding.
- Bundle: `dsh.bundle.patch` (string) — else not a layer (§1a).
- Client plugin: `dsh.client` object with string `platform` (`'web'` to appear), optional
  `inject` string[] and `immediately` boolean, AND `exports["./client"]` present; each field
  is validated and malformed values fail boot loudly. Optional negative verdicts
  (unresolvable specifier, no declaration) are cached per package name until restart —
  "plugin-set changes take effect on restart".
- No keywords, no `plugin` field, no cordis fields in `package.json` are read. (For the
  settings-page config cards, the schema lives in the plugin's own card/controller code, not
  in package.json.)

---

## 5. Bundle patch format specifics

### 5a. The row type and algorithm (authoritative source: anchor `@deepseek-ai/cordis-plugin-include/src/index.ts`, v1.0.7)

```ts
/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

and (loader v1.0.3, `src/config/entry.ts`):

```ts
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```

`applyEntryPatches(data, patches, warn)` — THE patch semantics (quoted rules):

- Works on a detached clone; all patches in a list apply in order over the same run.
- `insert` with no `id` → rows appended at **top level** of the tree
  (`data.push(...insert)`).
- `insert` with `id` → target must exist and be a **group** (`target.group`, array
  `config`); rows push into `target.config`. [Official bundle patch files do not use
  group-inserts; agent-preset compositions do.]
- Non-insert patch needs `id`; missing target → warn + skip (`patch: entry %C not found`).
  If the patch carries `name` and it differs from the target's `name` → warn + skip
  (`patch: name mismatch for %C (expected %C, got %C), skipping`).
- Every other key of the patch **overwrites the field on the target row wholesale** —
  `config` replaces the entire config object; `disabled: true` disables. Hence the comment
  convention on every official patch file: *"A patch replaces the targeted row's whole
  `config`, so each row below restates every key it owns."*
- Inserted rows are indexed immediately, so a later patch in the same list (or a later
  layer — the boot applies all layers as ONE flattened list) can target them.
- YAML dialect: `!!js <expr>` scalars become lazy expression nodes evaluated per entry
  against its injection-ready context (`process.env.X`, `ctx.webStartup.port ?? 3080`,
  `dshHomePath('storages')` …).

### 5b. Where the canonical rows live

NOT in `packages/bundle/src/index.ts`. Each bundle *package* ships its own patch file:
`packages/bundle/{base,headless,web-app}/cordis.patch.yml` in ref-dsh (installed copies:
`@deepseek-ai/dsh-{base,headless,web-app}/cordis.patch.yml`). `dsh-base`'s file is one giant
top-level `- insert:` list of ~90 rows (`timer`, `hmr`, `llm`, `settings`, `credentials`,
`sandbox`, `tool-fs`, `goal`, `subagent`, `tools`, `system-prompt`, `agent-loop`,
`llm-deepseek`, …); `dsh-web-app`'s is overrides by `id` (`- id: hmr / disabled: true`,
`- id: tools / config: …`, dozens of `- id: … / disabled: true`) plus two more `insert`
blocks (web-only host rows and the browser roster). The **real installed** (0.1.2-rc.1)
composed tree of the web profile is captured verbatim in
`/root/projects/dsh-mcp-scope/.recon/dump-web.yml` (525 lines; run of
`dsh --profile web --dump-config` against the anchor CLI).

### 5c. Row ids worth emulating (from the real web composition)

Host-plane rows inserted by web-app: `code-runtime`, `storage`, `storage-json`,
`storage-domain`, `message-feedback`, `session-log-download`, `workspace`,
`session-reference`, `file-reference-local`, `session-stats`, `session-turn-outline`,
`directory-picker`, `plugin-inventory`, `session-controller`, `settings-controller`,
`workspace-controller`, `cordis-host-runner`, `web-startup`, `webserver`, `web-runtime`,
`client-hmr`, `modules`, `connection`, `api-remotes`, `cordis-client-runner`, `agent-presets`.
Browser-roster rows: `ui-theme`, `locale`, `ui-layout`, `ui-renderer`, `ui-session`,
`ui-sidebar`, **`ui-settings`**, **`ui-settings-general`**, **`ui-settings-models`**,
**`ui-settings-plugin-inventory`**, `ui-conversation`, …, **`ui-settings-plugins`**, … .

- **Host plugin addition** (what a third-party bundle inserts): a top-level row, e.g.
  ```yaml
  - insert:
      - id: my-thing
        name: '@me/dsh-my-thing'          # resolves from the profile dir (or subpath export)
        config: { … }                      # optional; restate everything you own
  ```
  (official pattern: `- id: plugin-inventory / name: '@deepseek-ai/dsh-host-plugin-inventory'`).
  To add web-only behavior your bundle should also be listed **after** `@deepseek-ai/dsh-web-app`
  (it will be: `dsh plugin add` appends; template order `base, web-app` is preserved), and to
  change an existing row's behavior restate its whole config or set `disabled: true` by id.
- **Settings-section addition**: official sections are contributed by *client* plugins, each
  a loader row named after a dual-face package (`ui-settings-general` →
  `@deepseek-ai/dsh-client-ui-settings-general` etc.). Two shapes:
  - whole new nav page: the client half registers the `'settings.section'` slot, e.g.
    (ui-settings-general's own registration, ref-dsh source):
    ```ts
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'general', order: 0,
      label: () => t('general.nav'), locale: NS,
      children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
    }, GeneralSection))
    ```
  - tab inside the Plugins section: register `'settings.plugins.tab'`
    (ui-settings-plugin-inventory example in §4a; plugin-inventory tab id `'all'`, order 10).
  The settings slot contract (`ref-dsh/packages/client/ui-settings/src/client/contract/slots.ts`)
  is the canonical list of every settings slot: `settings.trigger/header/action/close/section/
  plugins.tab/onboarding/general.item`. Your client row's `dsh.client.inject` should name the
  service packages your bundle needs (e.g. `@deepseek-ai/dsh-client-ui-settings`,
  `@deepseek-ai/dsh-client-locale`, …), and the row itself only needs a unique `id`.

---

## 6. Evidence from the REAL instance (`/root/.dsh-chamber/gateway/…`)

### 6a. `$DSH_HOME` layout (`data/dsh-home`)

```
dsh-home/
├── settings.yaml                      # llm-deepseek (baseURL/models), llm-pi-ai, agent-presets.default,
│                                      # agent-default-model, locale.preference, ui-onboarding…
├── profiles/
│   ├── node_modules/                  # symlink farm → /root/.dsh-chamber/gateway/dsh-anchor/node_modules/*
│   │   └── @deepseek-ai/{cordis, cordis-plugin-*, dsh, dsh-app-boot, dsh-base, dsh-web-app, ~220 more}
│   └── web/
│       ├── package.json
│       ├── cordis.yml                 # empty root: comment + `[]`
│       ├── cordis.patch.yml           # EMPTY user layer: comment template + `[]`
│       ├── pnpm-workspace.yaml        # hoisted, autoInstallPeers false
│       ├── node_modules/@dsh-chamber/{dsh-client-ui-mobile, dsh-host-client-graph, dsh-host-git-worktree}
│       └── .dsh-module-fallback/node_modules/   # empty
├── sessions/ storages/ worktrees/     # runtime dirs
```

`profiles/web/package.json` (verbatim — **no `plugins` array exists anywhere**):

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      "patchReload": "live"
    }
  }
}
```

`cordis.patch.yml` is the untouched template (`[]`) and `dependencies` is empty: **the
`dsh plugin add` flow was NOT used on this instance** (no pnpm-managed deps, no lockfile).

### 6b. What was used instead — the dsh-chamber gateway (0.2.1)

- `data/managed-dsh/1494939.json` records the spawned dsh process: binary
  `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/dsh/lib/bin.js`,
  `profile: "web"`, `source: "spawn"`.
- `versions/0.2.1/dist/index.js` builds the spawn argv:
  ```js
  function webProfileArgs(port, patchPath) {
    const base = ["--profile","web","--host","127.0.0.1","--port",String(port),"--trusted-host",`127.0.0.1:${port}`];
    if (patchPath === void 0 || patchPath === "") return base;
    return ["--profile","web","--patch",patchPath,"--host","127.0.0.1","--port",String(port),"--trusted-host",`127.0.0.1:${port}`];
  }
  ```
- `data/dsh-chamber-graph.patch.yml` (the `--patch` overlay, verbatim):
  ```yaml
  - insert:
      - id: client-graph
        name: '@dsh-chamber/dsh-host-client-graph'
      - id: git-worktree
        name: '@dsh-chamber/dsh-host-git-worktree'
      - id: mobile
        name: '@dsh-chamber/dsh-client-ui-mobile'
  ```
- The gateway **seeds** the packages directly into the profile
  (`ensureSeedPackage` → `profiles/web/node_modules/@dsh-chamber/<pkg>` copies
  `package.json` + `dist/index.js`; `ensureSeedTargetParent` mkdirs
  `join(dshHome,'profiles','web','node_modules',… )`), i.e. **real directories, not
  symlinks**, and never touches `dsh.profile.bundles` — the rows arrive via the overlay.
  Host-only chamber packages (`@dsh-chamber/dsh-host-client-graph`) are plain
  `main: dist/index.js` modules; the client one (`@dsh-chamber/dsh-client-ui-mobile`) is the
  dual-face shape with `"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-slots"],
  "platform": "web" } }`, `exports["./client"] = ./lib/client.js`, `main: lib/index.js`.
  (A separate gateway "chamber plugins" store under `data/chamber-plugins/` + a
  `spawn dsh plugin command` executor exists for gateway-managed third-party plugins.)

### 6c. Boot evidence

`data/host-logs/30800.log` shows the running instance booting cleanly
(`dsh web: http://127.0.0.1:30800/?token=***`). The full composed row tree this machine
actually runs is `/root/projects/dsh-mcp-scope/.recon/dump-web.yml` (see §5b); `/root/projects/dsh-mcp-scope/.recon/web-help.out`
is the booted `dsh web --help`.

---

## (a) Step-by-step "user install" recipe we can document

Prereqs: Node ≥22, pnpm on PATH (the CLI runs `pnpm` itself; pnpm ≥10 needs the profile's
`pnpm-workspace.yaml` `allowBuilds:` entry for git deps with `prepare` scripts).

1. `dsh plugin --profile <name> add <package>` — where `<package>` is an npm name, a git
   spec, `file:/abs/path` (or a relative `./dir`/tarball from your cwd). First use creates
   the profile with `@deepseek-ai/dsh-base` as the only bundle (or the template for
   `web`/`headless`/`acp`/`sdk`/`sdk-minimal`).
2. `dsh` runs `pnpm add` inside `$DSH_HOME/profiles/<name>/` (hoisted linker, peers from the
   installation fallback farm), then reconciles:
   - package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` → appended to
     `dsh.profile.bundles` in `package.json`;
   - otherwise → warning; install a bundle or add a loader row yourself (step 4).
3. Optional user overrides: append rows to `profiles/<name>/cordis.patch.yml` (hot-applies
   live on web: `patchReload: "live"`), `$DSH_HOME/cordis.patch.yml`, or pass
   `--patch <file>` per run.
4. Verify: `dsh --profile <name> --dump-config` (shows a `# == <pkg>` layer comment),
   `dsh --dump-default-config` for bundles-only, then `dsh --profile <name>`.
5. Remove: `dsh plugin --profile <name> remove <package>`.

Files changed by the flow: profile `package.json` (+dep, +bundles entry), pnpm's
`pnpm-lock.yaml` + `node_modules/`; nothing else.

Author side: publish the built package (`lib/…` prebuilt, or rely on a git-hosted `prepare`
script users must allowlist); `files` must include the patch yml and built entry points;
`cordis.patch.yml` rows reference the package by name (subpath exports allowed); dual-face
packages additionally prebuild `lib/client.js` and declare `dsh.client` + `exports["./client"]`.

## (b) Facts not to get wrong

- There is no `plugins:` list, no `plugins.yaml`, and no runtime "plugins dir" scan. The
  inventory is a **projection of live loader rows**, and "plugins actually listed" in the
  settings UI are rows (id + module name + enabled + fiber phase) — no versions, no patches.
- `dsh plugin` is a pnpm forwarder + bundles-list reconciler; the only package.json contract
  for becoming a layer is `dsh.bundle.patch`. `cordis.yml` is an always-empty root rewritten
  at boot; never edit it (comments say so; the Loader can write back composed rows into it).
- Layer order matters and `config` patches REPLACE whole configs: later layers win per row
  and must restate every key; the whole patch stack is applied as one flattened list in
  include order (bundles in list order → profile patch → home patch → `--patch` overlays).
- Row `name` is a module specifier resolved from the profile directory (pnpm node_modules)
  or the dsh installation anchor — in-box names like `@deepseek-ai/dsh-base` always resolve
  to the installation's copy, so profile-local shadowing of in-box bundles is impossible.
- Client plugin ids in the browser graph are **package names**; `exports["./client"]` and
  `dsh.client.platform === 'web'` are required for a package to appear there; missing
  bundle/declaration validation errors fail boot loudly.
- Profile/boot plumbing is launcher-installation-versioned (CLI 0.1.1-rc.2 vs anchor
  0.1.2-rc.1 vs ref-dsh source 0.1.0-rc.5); the manifest now also carries
  `dsh.profile.patchReload` (`"live"` on web/custom, `"startup"` on template apps) that the
  launcher honors when deciding to hot-watch `cordis.patch.yml`.
- Boot needs `$DSH_HOME` writable at start (module-fallback symlink heal); read-only homes
  fail with EROFS even for `--help`.
- `dsh --profile <nonexistent>` with no shipped template errors and points at
  `dsh plugin --profile <name> add <package>`; the plugin subcommand auto-inits the profile
  on first use with `@deepseek-ai/dsh-base`.

## (c) Open questions

- Where does the Plugins-settings "configurable tab" get the set of namespaces/cards it
  renders, and is there a public host API a third-party card should register through
  (settings scope invalidation/subscription contract) — or is shipping your own card into
  `settings.plugin.item` plus a namespace in `settings.yaml` the intended path?
- Version skew: ref-dsh source (0.1.0-rc.5) vs installed anchor (0.1.2-rc.1) differ in row
  sets and some mechanics (e.g. `.dsh-module-fallback` projection, `patchReload`); is
  ref-dsh master newer than rc.5 with those features, or is the installed build from a
  different branch? (Recommend pinning the report's recipes against the anchor artifacts +
  dump-web.yml, which is what this instance runs.)
- The chamber gateway seeds `@dsh-chamber/*` packages into `profiles/web/node_modules` and
  inserts their rows via a generated `--patch` overlay instead of `dsh plugin add` (their
  packages have no `dsh.bundle`) — is that "row-naming overlay" model supported long-term
  for third parties, or only the internal chamber mechanism?
- Exact semantics of `dsh.client.inject` edges client-side (informational per manifest.ts?)
  vs authoritative `inject` service lists inside each client bundle — worth confirming before
  authoring a client plugin's inject lists.
- HMR story for third-party client bundles (`/plugins` route + `rebuilt()` + dev `pnpm run
  dev:web` rebuild watcher): does the shipped HMR contract apply to out-of-tree bundles, or
  is restart the supported loop?
