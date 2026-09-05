# Recon: dsh-chamber GUI composition & where a third-party dsh client plugin's Settings section surfaces ("Settings → 服务器/Server area")

Status: in progress (M0 recon). Last updated by chamber-bridge recon agent.

Sources used (all read-only):

- `~/projects/dsh-chamber` — dsh-chamber monorepo **~0.2.0-beta.4** sources (`package.json` root `version: 0.2.0-beta.4`), esp. `docs/design/01,02,05,06,09,13,15,17,18`, `AGENTS.md`, `docs/progress/STATUS.md`, and packages `dsh-client-web`, `dsh-client-connection`, `dsh-chamber-client-ui-{sidebar,layout,git,open-in,settings-bridge,settings-connections}`, `dsh-host-client-graph`, `dsh-chamber-host-git-worktree`, `control-plane`, `gateway`, `desktop`, `cli`, `dsh-runtime`, `renderer`.
- **Installed gateway 0.2.1** at `/root/.dsh-chamber/gateway/current/dist` (bundled `index.js`/`cli.js`; `package.json` declares `"version": "0.2.1"`, `"dshAnchorVersion": "0.1.2-rc.1"`; `THIRD_PARTY_NOTICES.md`; `host-packages/`). **Caveat:** the installed gateway is *newer* than the monorepo checkout (it already contains a `@dsh-chamber/dsh-client-ui-mobile` packaged client plugin and `/chamber/*` orchestration that the beta.4 monorepo lacks). Where they differ, the installed bundle + live data dirs are ground truth; monorepo = source-level truth for the desktop/self-built UI.
- Live deployment data under `/root/.dsh-chamber/gateway/`: `gateway.conf`, `gateway.env`, `data/` (`catalog.json`, `chamber-plugins/`, `dsh-chamber-graph.patch.yml`, `dsh-home/`, `dsh-runtime/`, `managed-dsh/`, `versions/0.2.1`), `current/host-packages/`, `dsh-anchor/node_modules/@deepseek-ai/*` (dsh 0.1.2-rc.1 stock client/server packages, including the served `dsh-web-frontend/dist`).
- This session's own facts: `DSH_WEB_URL=http://127.0.0.1:30800`, `DSH_HOME=/root/.dsh-chamber/gateway/data/dsh-home`. Ports: dsh web instance on `127.0.0.1:30800` (loopback), gateway on `0.0.0.0:30801`.

---

## 0. TL;DR (answers up front)

1. **Who serves the GUI end users see here:** the **managed dsh web instance** (`dsh 0.1.2-rc.1`, binary `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/dsh/lib/bin.js`, `--profile web`, `DSH_HOME=/root/.dsh-chamber/gateway/data/dsh-home`) serves the **official dsh web frontend** (`@deepseek-ai/dsh-web-frontend/dist`; verified no `@dsh-chamber` strings in its assets) on loopback `30800`. The **gateway (0.2.1) on `30801`** is the authenticated boundary that reverse-proxies that same official frontend + `/api` (design 17 §1: "在认证、Host/Origin 和资源边界后反代 dsh 官方 Web 前端与 `/api`") and injects a one-line trust declaration (`window.__DSH_TRANSPORT__={ownsHost:true}`) into the proxied `index.html`. The chamber **Electron desktop** (which serves the chamber self-built renderer) is **not** part of this deployment.
2. **The chamber GUI does not exist in this deployment as a separate chrome.** The chamber *desktop* GUI = a **self-built build of the official dsh web app** (source reuse, `packages/dsh-client-web` copy + `vendor/harness-packages`), whose single boot row `@dsh-chamber/app` (`packages/renderer/src/chamber-entry.ts`) mounts the **entire stock dsh client plugin tree plus six chamber client plugins** into each per-instance cordis context — chamber mounts plugins *inside* the dsh shell; it is not an iframe/proxy of the official app (remote *data* does go through the `/api/i/<id>` proxy).
3. **Settings in the chamber (desktop) GUI** is a chamber shell (`dsh-chamber-client-ui-settings-bridge`) that *shadows* the official `SettingsRoot` (`sidebar.settings` slot, priority `-1`) and renders: **server dropdown → the selected server's official settings sections (models/agent-presets/plugins/…, from a fixed child-cordis-context plugin subset) → divider → fixed chamber entries `__connections`(连接)/`__general`(通用)**, plus `__gateway-orchestration` when the server is a gateway and a per-server `dsh-runtime` section (order 31). **The child-context plugin list is a compile-time allowlist — instance-installed third-party sections are NOT projected into it.**
4. **In this deployment's GUI (official dsh SettingsRoot)** a third-party client plugin's `settings.section` **appears automatically** once the plugin is installed into the instance web profile and the instance restarts: it joins the flat, `order`-sorted settings nav list (stock orders: general 0, models 10, plugins 15, agent-presets 20) with its registered `id/order/label`. Chamber does not need to know, allowlist, or bundle it.
5. **"Server" vs "workspace":** in chamber UI, a *server* = a managed dsh instance source (`local` | `dsh-<id>` | `gateway-<id>`); the settings shell's dropdown lists these. *Workspaces* are **always the dsh workspaces of an instance** (host directories in that instance's workspace registry), listed per-server by the chamber sidebar via each instance's own `workspace.list`/`sessions.list` API — there is no chamber-side workspace concept.
6. **Third-party plugins survive chamber dsh-runtime updates** (confirmed by design 18): DSH_HOME (`<userData>/state/dsh-home` desktop / `<stateDir>/dsh-home` gateway) is a constant, physically separate from the replaceable runtime install tree; version switches snapshot/restore DSH_HOME but never rewrite profiles wholesale; chamber re-seeds only its *own* packages (`@dsh-chamber/*` scope) per spawn.

---

## 1. Architecture: what process serves the GUI, and how chamber UI relates to the dsh web app

### 1.1 Two product shapes (design 17 / AGENTS.md "Runtime Boundaries")

- **Desktop shape** (`packages/desktop` Electron + `packages/control-plane` + `packages/renderer`): a single Electron `BrowserWindow` does `loadURL(http://127.0.0.1:17500)` (`DEFAULT_CONTROL_PLANE_PORT = 17500`, `packages/control-plane/src/index.ts:81`; `packages/desktop/main.ts:247`) against the loopback control plane, which statically serves **the chamber self-built frontend** (`dist` + `__DSH_BOOT__` manifest). First screen = the local instance's full dsh shell. Per design 05 §1: `Electron 窗口（单 frame，loadURL http://127.0.0.1:17500）└─ dsh 前端（源码构建 · __DSH_BOOT__ 由我们注入；首屏 = 本地实例 dsh shell）└─ apps/web 式入口 → AppWebEntry → …`. **Not an iframe, not a proxy of the official app** — a source-reuse build of it: "The UI is the **dsh official frontend, source-reused and self-built** (single window, single frame; multiple instances coexist as N-ctx shells)" (AGENTS.md).
- **Server/gateway shape** (`packages/gateway`, this deployment): gateway spawns and manages a loopback dsh and reverse-proxies **the official dsh web frontend and `/api`** (design 17 §1: "2. 在认证、Host/Origin 和资源边界后反代 dsh 官方 Web 前端与 `/api`"). Browsers run the instance's own stock frontend; the chamber self-built renderer is **not used**. The 0.2.1 gateway additionally injects a trust declaration into the proxied index: `"<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>"` (`injectTrustDeclaration`, bundle `html-inject.ts` source) so host persistence works through the proxy — the only html mutation.

### 1.2 How the desktop chamber UI is composed (package roles)

Per `packages/renderer/src/chamber-entry.ts` (composite entry `@dsh-chamber/app`, the *only* boot-graph row):

```ts
ctx.plugin(ConnectionPlugin, { basePath: chamberBasePath })   // per-entry /api/i/<id>
ctx.plugin(TypertRegistry); ctx.plugin(ApiGateway); ctx.plugin(ApiRemotes)
ctx.plugin(Runtime); ctx.plugin(Locale); ctx.plugin(UiTheme)
ctx.plugin(UiLayout)        // @dsh-chamber/dsh-client-ui-layout     (fork: layout-store / sidebarWidth)
ctx.plugin(UiSidebar)       // @dsh-chamber/dsh-client-ui-sidebar    (multi-source session nav, replaces official)
ctx.plugin(UiGit)           // @dsh-chamber/dsh-client-ui-git        (worktree rows + sagas)
ctx.plugin(UiOpenIn)        // @dsh-chamber/dsh-client-ui-open-in    (Finder/VS Code per session)
ctx.plugin(UiSettings) … UiSettingsGeneral/Models/Plugins/PluginInventory  // stock settings family
ctx.plugin(UiConversation) … (commands, workspace, model-selection, directory-picker-browse) …
ctx.plugin(UiSettingsConnections)  // @dsh-chamber/...-settings-connections (连接 section)
ctx.plugin(UiSettingsBridge)       // @dsh-chamber/...-settings-bridge     (settings SHELL, shadows SettingsRoot)
void registerDeferred(ctx)  // jobs/goal/skill/… deferred chunks
```

So the desktop chamber UI is: **one self-built dsh shell per instance source** (N-ctx, per design 05 §4: one `AppWebEntry` per source, each an independent cordis context, hidden/shown), where chamber client plugins *replace* the official layout/sidebar registrations and *add* settings shell/connections/git/open-in. Chamber client plugin packages & roles:

| Package (`@dsh-chamber/…`) | Role |
|---|---|
| `dsh-client-ui-layout` | fork of official ui-layout shell (layout-store persistence) — replaces official registration |
| `dsh-client-ui-sidebar` | self-built sidebar: all sources' sessions/workspaces in one list, per-source groups, chamberBridge (`shared/aggregate-store.ts`, `shared/instance-api.ts`) — replaces official ui-sidebar registration |
| `dsh-client-ui-settings-connections` | settings `connections` section (id `connections`, order 30): local card + remote host CRUD/systemd/logs + plugin management modal |
| `dsh-client-ui-settings-bridge` | settings SHELL: `sidebar.settings` seat at priority −1 (shadows official SettingsRoot), server dropdown + per-server child-ctx bridge of the official settings subset + fixed chamber entries |
| `dsh-client-ui-git` | Git worktree topology rows + create/remove sagas (design 08) |
| `dsh-client-ui-open-in` | desktop open-in per session header (designs 16/17/20) |

### 1.3 The settings-bridge main logic (quoted)

Registration (`packages/dsh-chamber-client-ui-settings-bridge/src/client/index.ts`):

```ts
/** Shadow priority: the official SettingsRoot registers at the default 0;
 * the slot core's shadowing rule renders the LOWEST priority winner, so -1
 * replaces the official shell without touching its ledger entry. */
const SHADOW_PRIORITY = -1
...
ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
  name: 'sidebar.settings', id: 'chamber-shell', priority: SHADOW_PRIORITY,
  label: () => t('trigger'), inject: injected }, SettingsShell))
// The per-server「dsh 运行时」settings.section is NOT registered here: the
// shell renders the SELECTED server's child-cordis-context ledger …
```

The shell (`SettingsShell.tsx`) renders a modal whose nav is: **title → ServerDropdown → selected-server section rows → (optional gateway row) → `navDivider` → fixed chamber rows**. The rows come from a *child* context assembled per selected server (`bridge-context.ts`):

```ts
/** The official settings plugin subset the child context mounts. */
const SETTINGS_PLUGINS: readonly SettingsPlugin[] = [
  UiSettings, LocalePlugin, UiTheme, UiSettingsGeneral, UiSettingsModels,
  UiSettingsPlugins, UiSettingsPluginInventory, BridgeRows,
]
...
const plugins = [ ...SETTINGS_PLUGINS,
  await import('@deepseek-ai/dsh-client-ui-agent-preset/client'),   // lazy chunk
  ...(runtimePlugin === null ? [] : [runtimePlugin]), ]             // dsh-runtime per server
```

The child ctx ("an INDEPENDENT root Context (no parent inheritance)") gets a **fake connection** whose `api` is a per-instance unary client (`bridge-api.ts`: `POST {base}/api/i/<id>/api/<method>` with the official client-request envelope; surfaces `settings.describe/update/mutate/openDocument`, `credentials.*`, `pluginInventory.list`, …) and `isLoopback: true` so settings scopes persist to the **target** host. Row identity/order (`bridge-context.ts:sectionRows`):

```ts
return slots.entries('settings.section').map(entry => ({
  id: entry.options.id ?? '', order: entry.options.order ?? 0,
  label: …entry.options.label… })).sort((a, b) => a.order - b.order)
```

i.e. **sections = whatever the plugins mounted on the child ctx registered** (id/order/label from each registration), rendered via `BridgeOutlet … opts={{ only: active }}` (one active section's content). **The mounted plugin set is the allowlist** — it is a fixed compile-time list of the *official settings plugin family* + chamber's `BridgeRows` + `dsh-runtime`; **plugins installed into the dsh instance are not part of it and their `settings.section` entries never reach this ledger**. Instance facts (config) do go to the target host through the bridge, which is the "projection" claim: the section *content* is a live projection of the selected server's settings domain, but the section *roster* is curated.

Fixed ids (`nav-active.ts`): `__connections` (连接), `__general` (通用), `__gateway-orchestration` (网关编排, only when the selected server `kind === 'gateway'`). Per-server `dsh-runtime` section (`runtime-section-plugin.ts`): `id: 'dsh-runtime', order: 31` (right after agent-presets order 20), not mounted at all for `kind=dsh + transport=http` (no management surface, design 17 §3).

---

## 2. The "Server area" in Settings; section registry; where instance-contributed sections land

### 2.1 Where the managed-servers list lives

Two places, both in `packages/dsh-chamber-client-ui-settings-bridge`:

1. **`ServerDropdown`** at the top of the settings nav (`SettingsShell.tsx`, locale: `选择服务器/搜索服务器…`). Rows come from `chamberBridge.getServers()` (`bridge-servers.ts`: `BridgeServerRow = ChamberServerAggregate` — the renderer-published projection `{id, kind: local|dsh|gateway, transport: local|ssh|http, label, connected, phase, …}`), i.e. **the roster of managed dsh instances/servers** (local + registered ssh/http hosts), same projection the sidebar consumes. Default selection: the hosting instance (`local`), else first connected server.
2. **`ConnectionsSection`** (固定 `__connections` nav entry below the divider) — the full connection-management surface (local card + remote host CRUD), from `dsh-chamber-client-ui-settings-connections` (`settings.section` id `connections`, order 30 per design 05 §5, but the shell renders it as a *fixed* entry, not from the server's ledger — design 18 §3.6 revision).

### 2.2 Layout (nav groups vs section list)

The modal (design 15 §1, "v1 平铺形态已实现"):

```
设置 title
├─ ServerDropdown (local 默认；远程按连接态着色)      ← "服务器" area anchor
├─ navList: rows of the SELECTED server's ledger      ← instance-contributed sections
│     (official subset: general/models/plugins/agent-presets + chamber dsh-runtime)
│     [__gateway-orchestration row if server kind=gateway]
├─ navDivider
└─ navList: FIXED chamber-global entries              ← never follows the selected server
      __connections 连接 / __general 通用
```

There is **no two-level grouping** in v1 (two-level "Chamber group + server settings group" deferred — design 15 D2).

### 2.3 Section registry entries the chamber adds (quoted ids/orders)

| Section | id | order | Where it registers | Rendered from |
|---|---|---|---|---|
| official General | `general` | 0 | stock `dsh-client-ui-settings-general` (anchor: `id:"general", order:0`) | child ctx (stock) |
| official Models | `models` | 10 | stock (anchor `id:"models", order:10`) | child ctx (stock) |
| official Plugins | `plugins` | 15 | stock (anchor) | child ctx (stock) |
| official agent presets | `agent-presets` | 20 | stock agent-preset (anchor) | child ctx (stock, lazy chunk) |
| chamber per-server runtime | `dsh-runtime` | 31 | `runtime-section-plugin.ts` per bridge session | child ctx (chamber) |
| chamber connections | `connections` | 30 (in host ctx ledger) | `…-settings-connections/src/client/index.ts` | **fixed** nav entry under divider, never the ledger |
| chamber shell | `chamber-shell` | — (sidebar.settings slot) | settings-bridge `index.ts`, priority −1 | shadows official SettingsRoot |
| fixed entries | `__connections` / `__general` / `__gateway-orchestration` | — | `nav-active.ts` | fixed nav |

Plugin-inventory is not its own nav section in rc.1: it registers the inventory tab inside Plugins ("Read-only Cordis Loader inventory tab in Web Plugins settings", anchor package description).

### 2.4 Where a *dsh-instance-contributed* (third-party) section renders

- **In the chamber desktop settings shell: nowhere today.** The shell projects only the child-ctx allowlist (§1.3). A third-party plugin's section registered on the host shell ctx (where the instance's plugins run as "extra rows", design 09) is invisible in the modal; the nav would show it only if the plugin were added to `SETTINGS_PLUGINS`/composite (a chamber code change), or if the child-bridge failed and the whole `sidebar.settings` seat fell back to the official SettingsRoot (failure fallback only, `BridgeEntryBoundary` comments in `SettingsShell.tsx`).
- **In the gateway-served official dsh UI (this deployment): automatically, in the flat `order`-sorted nav of the stock `SettingsRoot`** (anchor `dsh-client-ui-settings-general` registers `sidebar.settings` with children incl. `settings.section` and renders rows `{id, order, label}` sorted + `renderSlot("settings.section", …, {only: active})`). Chamber plays no role in that list beyond booting the instance with its seeded plugins; the browser roster/`__DSH_BOOT__` and settings slots are stock dsh.

---

## 3. Desktop vs gateway deployment; what chamber injects into the managed dsh instance

### 3.1 End-user deployment here

Gateway 0.2.1 (installed `/root/.dsh-chamber/gateway/current`), `gateway.conf`: `GATEWAY_PORT=30801`, `DSH_PORT=30800`, `DSH_WS=/root/.dsh-chamber/gateway/dsh-anchor`, systemd mode. The managed dsh (rc.1, DSH_HOME `…/data/dsh-home`) is spawned via (bundle quote):

```js
function webProfileArgs(port, patchPath) {
  const base = ["--profile","web","--host","127.0.0.1","--port",String(port),"--trusted-host",`127.0.0.1:${port}`];
  if (patchPath …) return ["--profile","web","--patch",patchPath,"--host","127.0.0.1","--port",String(port),"--trusted-host",`127.0.0.1:${port}`];
}
```

i.e. **the dsh-chamber-graph.patch.yml overlay is passed as `--patch` on every spawn**. Live overlay at `…/data/dsh-chamber-graph.patch.yml`:

```yaml
- insert:
    - { id: client-graph,  name: '@dsh-chamber/dsh-host-client-graph' }   # host (boot-graph Remote)
    - { id: git-worktree,  name: '@dsh-chamber/dsh-host-git-worktree' }   # host (Git Remote)
    - { id: mobile,        name: '@dsh-chamber/dsh-client-ui-mobile' }    # client UI (mobile adaptation)
```

Corresponding seeded package copies live in `profiles/web/node_modules/@dsh-chamber/{dsh-client-ui-mobile,dsh-host-client-graph,dsh-host-git-worktree}` (bare package.json+dist copies; mobile also in `current/host-packages/dsh-chamber-client-ui-mobile`). The gateway registers these in `createPlane` `extraSeedEntries` with `source: "desktop-synced"`/`"packaged"` (bundle quote; desktop seeds the two host packages per spawn via control-plane `host-graph-seed.ts` `ensureHostPackage`/`buildPatchOverlay`, gateway additionally seeds the mobile client package — its package.json: "seeded into the gateway-hosted instance as the **single packaged client-plugin exception**").

### 3.2 Distinguishing chamber-injected vs stock plugins in the instance

- **Stock (anchor `@deepseek-ai` list, dsh 0.1.2-rc.1):** everything in the web profile's bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` — the `dsh-web-app/cordis.patch.yml` browser roster includes `dsh-client-ui-sidebar`, `…-layout`, `…-renderer`, `…-session`, `…-settings`, `…-settings-general/models/plugin-inventory/plugins`, `…-agent-preset`, `…-conversation`, `…-approval`, `…-workspace`, `…-commands`, etc. (all `@deepseek-ai/*`).
- **Chamber-added (this deployment):** exactly the three overlay rows above — two host packages (server-side Remotes; the *client*-facing row of `client-graph` is what chamber desktops use to fetch boot graphs, design 09) and one small client plugin (`dsh-client-ui-mobile`: narrow-viewport/touch adaptation only; registers no settings sections — verified in `lib/client.js`).
- Chamber's full client plugin set (sidebar/layout/git/open-in/connections/settings-bridge) is **only** bundled into the desktop self-built renderer — it is *not* seeded into instance profiles in either shape (desktop gets them from the renderer bundle; gateway gets only `mobile`).

The instance's own `DSH_HOME/settings.yaml` namespaces today: `ui-onboarding, agent-presets, llm-pi-ai, agent-default-model, locale, llm-deepseek` — stock namespaces only; no chamber-owned or third-party plugin namespaces present yet.

---

## 4. Workspace concept mapping

In chamber UI (design 05 §2/§3; sidebar package `shared/`):

- **"Server"/source = a managed dsh instance** (`local`, `dsh-<id>` over ssh, `gateway-<id>` over http; design 17 four-axis model). Roster/connection state are non-secret projections (control-plane `/health` + `/api/connections`, desktop transport status).
- **Sidebar groups = per-source**, and **each workspace group is that instance's dsh workspace** (host directory registered in the instance's workspace registry). Data rule (design 05 §2.3): "会话/workspace 数据**只来自各实例自己的 API**（经 `/api/i/<id>/*` 同源 unary：workspace.list / sessions.list 等）". `shared/instance-api.ts` (quoted): "…doFetch injects the per-instance proxy prefix (`/api/i/<id>`)… workspace.*/session.* unary methods land on the right dsh instance". Workspaces of mounted ctxs are additionally published as snapshots from each shell's own runtime (`sessions.list`/`workspaces.list` subscriptions); unready sources fall back to 30s unary pulls. Chamber's git plugin adds workspace-level git topology rows, but the *concept* of workspace is always the dsh instance's.
- Therefore **there is no chamber-side workspace store**: "workspaces" in the chamber GUI == the workspaces of the connected/selected dsh instances (local instance too). Clicking a workspace/session opens it in that instance's shell (N-ctx) or dispatches to it via the chamber bridge.

---

## 5. Third-party plugin lifecycle under chamber (persistence across chamber dsh-runtime updates)

Confirmed from design 18 (`docs/design/18-dsh-runtime-version.md`) + live layout:

- **DSH_HOME is constant and physically separate from the replaceable runtime install tree** (§3.7): desktop `dshHome() = <userData>/state/dsh-home`, gateway `dshHome() = <stateDir>/dsh-home` (line ~707; live: `/root/.dsh-chamber/gateway/data/dsh-home`). Version switches swap only the runtime (version trees/`current` pointer under the state dir), never the data dir.
- **Every switch snapshots DSH_HOME before switching and can restore it** (§3.7: "不变量：无快照不切指针"; restore = two-phase rename). Data compatibility across versions is dsh's own migration responsibility; the activation gate probes settings.yaml parse + session-list readability.
- **Plugin installs/uninstalls write into DSH_HOME profiles** (`dsh plugin --profile web add|remove`; plugin-sync.ts local/remote paths both use that CLI; local also via `file:` materialize). Restart semantics (design 18 §3.6 item 8): "dsh boot 重读 DSH_HOME profiles + `--patch` overlay（`dsh plugin` 装/删的插件生效）" — plugins activate on the next dsh process boot; per-server restart buttons exist (local `restartLocal()`, gateway `POST /chamber/runtime/restart`, ssh `restart_service`). Electron shell itself doesn't restart.
- **Chamber re-seeds only its own packages per spawn**: `ensureHostPackage` targets `@dsh-chamber/<name>` inside `profiles/web/node_modules` (name regex `^@dsh-chamber\/[a-zA-Z0-9._-]+$` — third-party names are never touched) and rewrites the chamber-owned overlay rows idempotently. So user-installed third-party profile plugins persist across chamber runtime updates; the runtime *version* determines which dsh client/server ecosystem the plugin runs against.

**Inferred (mark as such), not directly verified:** that a dsh-runtime *major* update whose client-modules manifest/layout changes would keep working with a profile-installed third-party client plugin is dsh's compatibility contract (chamber explicitly declines to guarantee it — extra rows degrade "feature-absent" rather than crash the shell, design 09 §3.5/README "后端版本容忍"); for the gateway UI the browser always gets the *active runtime's* own frontend, so client-plugin version skew is between the plugin and that dsh version.

---

## 6. Where our (MCP) section will appear — concrete recommendation

The MCP plugin in this project is a **third-party dsh client plugin** (`dsh.client` platform web) contributing a `settings.section` ("MCP 服务器…", users' "服务器/Server area").

**Case A — this deployment (gateway-managed official dsh web UI at 30800, the GUI users actually use):**
1. Install into the instance web profile (same `dsh plugin --profile web add` machinery chamber's plugin UI wraps; whitelisted npm spec). Restart the managed dsh (gateway: `POST /chamber/runtime/restart` / chamber UI "重启 dsh"; or systemd) so the boot graph picks up the new client row.
2. Settings (设置) opens the **stock official SettingsRoot**; our section appears **automatically** as a nav row `id`/`order`/`label` from its registration, sorted by `order` among `general(0) / models(10) / plugins(15) / agent-presets(20)`. E.g. `order: 25` → right after 智能体预设(20); nothing else in the UI is grouped — no chamber allowlist, no bundle repack, no chamber knowledge needed.
3. Config persistence: settings namespace writes go through the instance's settings API to `DSH_HOME/settings.yaml` (current namespaces listed in §3.2) — same as stock sections.

**Case B — chamber desktop GUI (not deployed here):** the section would *not* appear automatically in the chamber settings modal (fixed child-ctx allowlist, §1.3/§2.4). If chamber desktop support is ever needed: (a) add the package to the settings-bridge child mount (`SETTINGS_PLUGINS` in `bridge-context.ts` + peer deps) and/or composite coverage — chamber rebuild required; or (b) target the official SettingsRoot fallback path — not a product surface. Non-settings surfaces of the plugin (if any) would still run per-instance as extra rows (design 09) with no chamber code change.

**Case C — pure official dsh web instance (not chamber-managed):** identical to Case A (it is the same stock UI mechanics).

Open questions/risks:
- The literal user-facing label "Settings → 服务器/Server area": no string `服务器` exists in the chamber settings copy (`连接`/`通用`/`网关编排`/`dsh 运行时`) nor in the rc.1 official zh client bundles — we could not introspect the live authenticated GUI DOM (dsh web root requires its launch-token cookie, minted only at spawn). Please confirm whether the users' "服务器" refers to (a) the settings content of the selected server in the chamber shell (server dropdown area), (b) a planned MCP-server section label of ours, or (c) something in the stock UI.
- The chamber gateway 0.2.1 is newer than the beta.4 monorepo; only the desktop UI is covered by monorepo source quotes — desktop claims (Case B) are source-level, not live-verified here.
- If MCP sections must also appear *inside* the chamber desktop modal, that is an explicit chamber-side integration (curated mount list), not an instance-side install property.

## 7. Evidence index (files)

- `~/projects/dsh-chamber/AGENTS.md` (runtime boundaries; package roles)
- `~/projects/dsh-chamber/docs/design/05-connection-manager.md` §1/§2/§5/§6; `15-chamber-settings-page.md`; `09-client-plugin-runtime-loading.md` §3.1–3.5; `17-server-side-gateway.md` §1/§2/§3; `18-dsh-runtime-version.md` §3.6/§3.7
- `~/projects/dsh-chamber/packages/renderer/src/chamber-entry.ts` (composite mounts all stock + chamber plugins; COVERED_FACTORIES)
- `~/projects/dsh-chamber/packages/dsh-chamber-client-ui-settings-bridge/src/{index.ts, client/SettingsShell.tsx, client/bridge-context.ts, client/nav-active.ts, client/bridge-api.ts, client/runtime-section-plugin.ts}`
- `~/projects/dsh-chamber/packages/dsh-chamber-client-ui-settings-connections/src/client/index.ts`
- `~/projects/dsh-chamber/packages/dsh-chamber-client-ui-sidebar/src/shared/{instance-api.ts, aggregate-store.ts}`
- `~/projects/dsh-chamber/packages/control-plane/src/{host-graph-seed.ts, spawn-dsh.ts, index.ts}`; `~/projects/dsh-chamber/packages/desktop/plugin-sync.ts`
- `/root/.dsh-chamber/gateway/current/dist/index.js` (bundled gateway; `webProfileArgs`, `extraSeedEntries`, `injectTrustDeclaration`, browser-auth-cookie)
- `/root/.dsh-chamber/gateway/current/host-packages/dsh-chamber-client-ui-mobile/package.json` + `lib/client.js`
- `/root/.dsh-chamber/gateway/data/{dsh-chamber-graph.patch.yml, dsh-home/profiles/web/…, dsh-home/settings.yaml, managed-dsh/1494939.json}`
- `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/{dsh-web-frontend/dist, dsh-web-app/cordis.patch.yml, dsh-client-ui-settings-general/lib/client.js, dsh-client-ui-settings-models/lib/client.js, dsh-client-ui-settings-plugins/lib/client.js, dsh-client-ui-agent-preset/lib/client.js, dsh-client-connection/lib/index.js}`

## 8. Confirmed vs inferred

- **Confirmed (code/artifacts quoted above):** desktop chamber UI composition & shadow-shell mechanics; the child-ctx allowlist; the deployed gateway spawn args & seed overlay rows; the served UI being stock `dsh-web-frontend`; dsh-home separation & snapshot-on-switch; chamber seed touching only `@dsh-chamber/*`; stock section ids/orders; official SettingsRoot rendering (rows sorted by order, `only: active`); html trust injection.
- **Inferred:** chamber-runtime-update compatibility of arbitrary third-party client plugins (dsh's own contract; degrade-not-crash on the desktop side); identity of the users' "服务器" area (see open questions); behavior of a plugin installed into the web profile in the *running* authenticated GUI (not introspectable without the launch cookie).
