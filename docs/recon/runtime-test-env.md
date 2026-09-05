# Recon: running a SCRATCH dsh instance headlessly + driving it over HTTP + MCP test servers

Status: M0 recon — **empirically verified** (every "verified" below was executed against a live scratch instance in this container on 2026-09-05). Sources: global dsh CLI install, installed `@deepseek-ai/*` packages, and live probing with `curl`.

Sibling recon docs: `core-apis.md` / `ui-contracts.md` / `mcp-client-official.md` / `plugin-distribution.md` (all centered on the **0.1.2-rc.1 anchor** = what dsh-chamber runs) and `chamber-bridge.md` (chamber itself). This doc is the **operational layer**: how to boot a throwaway instance, what its HTTP/WS API really is, and how to script end-to-end smoke tests.

---

## 0. Version matrix — read first (two API generations exist)

| Install | Path | Version | API generation |
|---|---|---|---|
| **global CLI** (this container) | `/root/.nvm/versions/node/v22.22.3/bin/dsh` → `/root/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh` | `dsh -V` → `0.1.1-rc.2` | **rc.2**: dotted RPC methods (`POST /api/settings.describe`), NO cookie/token auth, api-proxy gateway (`dsh-host-apiproxy`), WS `/api/events.mux` + `/api/events.host` |
| **anchor** (chamber's dsh) | `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/dsh` | `0.1.2-rc.1` | **rc.1**: typert namespaces with slash endpoints (`POST /api/settings/describe`, `{args}` payloads), cookie auth (launch-token URL), WS mux `/api/remote.mux` |
| chamber gateway | `/root/.dsh-chamber/gateway/current` (data: `/root/.dsh-chamber/gateway/data/dsh-home`) | gateway 0.2.1, anchors dsh `0.1.2-rc.1` | runs the **rc.1** instance that serves this GUI on :30800 |
| ref-dsh source mirror | `/root/projects/dsh-chamber/ref-dsh` | `0.1.0-rc.5` | **older source mirror** — use for prose/design, not for wire truth |

npm latest (`npm view @deepseek-ai/dsh version`) = `0.1.2-rc.1`, i.e. the registry "latest" is the rc.1-generation anchor code, while this container's preinstalled global CLI is the newer rc.2 generation. Confusingly the rc.2 CLI prints **no authenticated URL and no cookie auth** (it dropped rc.1's browser-session cookie in favor of a loopback trust fence), while the rc.1 anchor has full cookie auth. **Recommendation for M0 smoke: use the global CLI 0.1.1-rc.2 with a scratch `$DSH_HOME`** — it is self-contained, starts headless in ~2 s, needs no auth for automation, and everything below was verified against it. Document rc.1 differences in §6 so a chamber-shaped run (cookie flow) is possible later.

---

## 1. dsh CLI — verbatim help (rc.2, `dsh --help`)

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
  --patch <path>              extra patch-list overlay applied after the profile
                              layer (repeatable)
  --dump-config               print the composed profile tree and exit
  --dump-default-config       print the profile tree without its user layer or
                              --patch overlays and exit

Commands:
  web [options] [args...]     boot the web profile (alias of --profile web); the
                              web app's own flags follow
  plugin [options] [args...]  manage a profile's plugins by forwarding the
                              remaining arguments to pnpm in the profile
                              directory

Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
```

`dsh web --help` (rc.2, captured with a scratch home):

```
Usage: dsh --profile web [options]

Serve the DeepSeek Harness browser UI.

Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free
                                 one
  --trusted-host <authority...>  extra authority the /api browser-trust fence
                                 accepts (host or host:port; repeatable)
  -h, --help                     show this help

Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
```

Notes (source: `dsh/lib/bin.js`, `plugin-9h8shc4d.js`, `profile-boot-*.js` and `@deepseek-ai/dsh-app-boot` in the CLI install):

- The launcher owns only `--profile/--patch/--dump-config*`; everything after its own flags goes **verbatim** to the booted app. `web` = `--profile web`. `-h` printed above comes from `dsh-web-app/startup` (`dsh-web-app/lib/startup.js`): flags `--host` (**`0.0.0.0` is rejected** — "intentionally not supported yet for safety… use 127.0.0.1"), `--port` (numeric, `0` = OS-assigned), `--no-open`, `--trusted-host` (repeatable, bare `host` or `host:port`).
- `dsh plugin --help` is **not printable**: the `plugin` command declares `requiredOption('--profile <name>')` and commander errors first (`error: required option '--profile <name>' not specified`, exit 1). `plugin` forwards everything after `--profile <name>` to `pnpm` **in the profile directory** and then reconciles `dsh.profile.bundles` against installed state: any dependency whose package.json declares `dsh.bundle.patch` joins the profile's bundle layer stack automatically. A relative path spec (`dsh plugin --profile web add ../plugin`) is re-anchored against your invoking cwd. First use auto-initializes the profile directory (manifest `{name: dsh-profile-<name>, private: true, dependencies: {}, dsh: {profile: {bundles: [...]}}}`, `cordis.patch.yml`, `pnpm-workspace.yaml`). Shipped templates: `web: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`, `headless: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless]`; other names default to `[@deepseek-ai/dsh-base]`.
- `dsh --profile web ...` also auto-initializes a **missing** `web` profile from its template (`loadProfile` in dsh-app-boot: `PROFILE_TEMPLATES.web`), and heals a symlink farm at `$DSH_HOME/profiles/node_modules` (one symlink per package in the CLI's dependency closure — this is how in-box bundles resolve without pnpm). **First boot therefore needs no pnpm and no network.**
- Boot composes rows as patch layers in order: bundle patches (`dsh.profile.bundles`) → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays → telemetry patch (`DSH_TELEMETRY_DISABLED` — **any non-empty value**, even `"0"`, disables the `session-telemetry-otel` row). Long-lived surfaces watch the profile + home patch files and hot-apply changes (§3 caveat).
- Env: `DSH_HOME` overrides the default home `~/.dsh` (`dsh-home-paths`: `DSH_HOME_ENV`, dir name `.dsh`). No `DSH_PORT` — the web app's port comes only from `--port` (webserver config fallback `3080`). `DSH_WEB_URL` is published into the shell env of sessions, not read for binding. `DSH_TOOLS_MODE=native|ptc|both` opts the process into PTC tool presentation.

---

## 2. `$DSH_HOME` layout (verified on the real chamber home AND the scratch home)

Real instance `/root/.dsh-chamber/gateway/data/dsh-home` (mode 0700):

```
settings.yaml            # per-namespace YAML user layer: keys ARE namespace namespaces
                         # e.g. ui-onboarding:, agent-presets:, llm-pi-ai:, agent-default-model:,
                         # locale:, llm-deepseek: — root namespaces + their values
.credentials.yaml        # version: 1 ; refs: {<REF>: <value>} (+ rc.1: records: {<key>: {kind,
                         #   payload: {version, secret}}} for the browser-session grant)
.anonymous-user-id
profiles/                # node_modules (symlink farm) + one dir per profile:
  web/                   #   package.json, cordis.yml (empty root, rewritten every boot),
                         #   cordis.patch.yml (user layer), pnpm-workspace.yaml,
                         #   node_modules/, .dsh-module-fallback/
sessions/<sanitized-workspace-path>/<session-id>/…   # session logs; the dir name is the cwd with / → -
storages/workspace.json  # workspace registry, see §4
storages/session_projcache.json
worktrees/<name>/        # chamber-only (dsh-chamber-host-git-worktree); core dsh does NOT use git worktrees
```

The rc.2 `workspace.json` shape (scratch, verbatim):

```json
{ "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": ["8efdff8a-…"], "archivedSessionIds": [] },
  "tables": { "workspaces": { "8efdff8a-…": { "path": "/root/projects/dsh-mcp-scope/.smoke/ws-a",
      "title": "ws-a", "sessionIds": ["session-1b04a994-…"], "createdAt": "…", "updatedAt": "…" } } } }
```

`settings.yaml` is written by `dsh-settings-file` on every accepted write; **secret-role fields are stored in it in plaintext** but never ride any API response (§5, "write-only" = wire-level).

---

## 3. Headless boot — the minimal recipe (verified end to end)

**Container-specific gotcha first:** in this sandbox `/tmp` is **per-command** (fresh tmpfs per bash invocation; verified by marker files). A server started under `/tmp` dies with its shell. Everything persistent — `DSH_HOME`, logs, npm/pnpm caches, MCP server node_modules — must live under the session workspace `/root/projects/dsh-mcp-scope/.smoke/…`. `/root` itself is read-only, so also override `HOME` (pnpm store defaults under `$HOME/.local/share`, npm cache under `$HOME/.npm`).

Boot (background job; server keeps running while you probe from other shells):

```bash
export PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH
export DSH_HOME=/root/projects/dsh-mcp-scope/.smoke/home   # must be writable + persistent
export HOME=/root/projects/dsh-mcp-scope/.smoke/homedir    # writable fake home for npm/pnpm caches
export DSH_TELEMETRY_DISABLED=1
dsh web --no-open --port 32123 > .smoke/logs/boot.log 2>&1   # keep as the FOREGROUND child of a bg job
```

Observed (verified): profile `web` auto-created under `$DSH_HOME/profiles/web` on first use; `dsh web: http://127.0.0.1:32123` printed on stdout in **< 2 s** (subsequent cold boots similar; no X/electron anywhere — pure node HTTP; can't measure RSS precisely from outside the sandbox but nothing GUI-like is loaded). `/` returns the SPA index with **no auth redirect on rc.2** (200 + HTML, `window.__DSH_BOOT__` injected). `/api/*` requires only the browser-trust fence: Host header must be loopback (`127.*`/`localhost`/`[::1]`) or a `--trusted-host` authority, no cross-site markers. A privileged subset (`settings.*`, `credentials.*`, `agentPreset.*`, `host.pickDirectory`/`openPath`, `llm.discoverModels`) is additionally **loopback-only** (`client-connection` `PRIVILEGED_METHODS`). Stop with SIGTERM/SIGINT; hot patch-watchers live-apply `cordis.patch.yml` (profile + home) without restart.

Ports: avoid `30800` (chamber GUI) and `30801` (gateway) — they are occupied outside this sandbox. `32123` is proven free; use `3212x` ranges. Multiple instances are fine on distinct ports **with distinct `$DSH_HOME`s** (the `storages/workspace.json` + sessions state is per-home).

**rc.2 live-reload caveat (reproduced 4×, mark as BUG to verify in M1):** hot-adding *any* row to the profile user layer via the `cordis.patch.yml` watcher (even a `disabled: true` client row) permanently breaks the `pluginInventory` endpoint in that process — `/api/pluginInventory.list` starts returning `not found` 404 until restart (settings/session/workspace dotted methods keep working; it is typert src-discovery of the `dsh-host-plugin-inventory` service that is lost). A clean boot *with* the row already in the patch file was also affected in one run. Recipe: after editing `cordis.patch.yml`, **restart the instance before asserting plugin-inventory state**. The live reload itself works (see §7: the inserted `dsh-mcp-client` row spawned the MCP server child immediately, its stderr appearing in the boot log).

---

## 4. Workspaces (rc.2; verified)

- Defined by a **directory registry**, not worktrees: `workspace.create {path}` registers an **existing** directory (no mkdir; `workspace-invalid-path` otherwise), idempotent adopt; `workspace.list` returns `{items: WorkspaceView[], archivedSessionIds}` where `WorkspaceView = {workspaceId, path, title, sessionIds, createdAt, updatedAt}`. `rename/delete/insertBefore/insertSessionBefore/archiveSession` per §5 map.
- Session ↔ workspace binding: `session.create {workspaceId}` (or `cwd`) attaches the session; the workspace row's `sessionIds` gains it and the session log lands in `sessions/--<abs-path with / → -->/<sessionId>/`. Session summaries carry `cwd` and `agentPreset`.
- Settings-UI surfaces render from the registry; **there is no per-workspace tool/permission switch in core dsh** — anything like "per-workspace off switch" is the third-party plugin's own design (its setting + tool-scope wiring). What core gives you to build it on: per-workspace `cwd` on sessions, agent-preset composition per session, `dsh-scope` scoped tool registrations/restrictions, and the `ctx.settings`/`ctx.tools` seams. **Unknown:** which knob (settings ns + patch rewrite vs. in-process `ctx.tools` scope filter) dsh-mcp-scope should turn — see M0 step 8 and `mcp-client-official.md`/`core-apis.md`.

---

## 5. HTTP RPC surface of a running rc.2 instance (verified live; contract types in `dsh-host-apiproxy/lib/types/api/*.d.ts`)

Carrier: `POST /api/<method>` with JSON body

```json
{ "type": "client-request", "rpcId": "<any-string>", "method": "<method>", "payload": { <args…> } }
```

Response envelope:

```json
{ "type": "server-response", "rpcId": "<echo>", "result": { "ok": true, "value": {…} } }
{ "type": "server-response", "rpcId": "<echo>", "result": { "ok": false, "error": { "code": "…", "message": "…", "details": {…} } } }
```

An unclaimed method is an HTTP 404 `not found`; bad payload → `ok:false code:"bad-request"`; content-type must be `application/json` (else 415). Two stream endpoints exist as WebSocket upgrades: `/api/events.mux` (per-session aggregated mux: `session/event` passthrough, `session/subscribed`, queue/jobs/projection frames, approval & user-question frames) and `/api/events.host` (`host/session-*`, `host/workspace-*`, …); plain GET on them answers `426 upgrade required`. Business-stream payload shapes: `events.d.ts` (`MuxFrame`/`HostFrame`).

Full method map (`rpc-map.d.ts`):

| Domain | Methods |
|---|---|
| session | `session.list`, `search`, `create`, `history`, `models`, `selectModel`, `rename`, `fork`, `prompt`, `attachment`, `updateQueue`, `cancel` |
| workspace | `workspace.list`, `create`, `rename`, `delete`, `insertBefore`, `insertSessionBefore`, `archiveSession` |
| settings | `settings.describe`, `openDocument`, `update` (merge patch), `replace` (wholesale), `mutate` (path ops `{op:'set'|'unset', path:[…]}`) |
| credentials | `credentials.describe {refs:[…]}`, `set {ref, value}`, `unset {ref}` |
| host | `host.describe`, `pickDirectory`, `listDirectory`, `createDirectory`, `openPath` |
| llm | `llm.providers`, `models`, `discoverModels` |
| agentPreset | `agentPreset.list/select/read/copy/openDocument/remove` |
| skill | `skill.list` | subagent | `subagent.list/history/prompt/interrupt` | goal | `goal.create/edit/pause/resume/complete/clear` |

Verified live (abridged real responses):

- `settings.describe` `{}` → `{"writable":true,"hasDocument":true,"namespaces":[{ns, schema(schemastery JSON), value(redacted), base?, user?, applies:'live'|'restart', secrets:[{path,set}], revision}…]}`. On a bare scratch home: namespaces `agent-default-model, ui-theme, locale, ui-onboarding, ui-conversation, llm-deepseek, web-search-deepseek, agent-loop, agent-presets, shell, permission, llm-pi-ai`, all `rev 0`. `web-search-deepseek`'s schema shows the secret vocabulary: fields with `"role":"secret"` (write-only) and `"role":"credential-ref"` (names the env var/credential ref, e.g. `apiKeyEnv: DEEPSEEK_API_KEY`).
- `settings.mutate {ns:'locale', ops:[{op:'set',path:['preference'],value:'en'}], expectedRevision:0}` → `ok`, revision 1; retrying with stale `expectedRevision:0` → `ok:false code:'settings-conflict'` ("settings namespace \"locale\" changed since it was read (expected revision 0, now 1)"). The file `$DSH_HOME/settings.yaml` gained `locale:\n  preference: en`.
- Secret-role write: `settings.update {ns:'web-search-deepseek', patch:{apiKey:'sekret-xyz-123'}, expectedRevision:0}` → ok, `secrets:[{path:['apiKey'], set:true}]`, `user:{}` — **the value never rides a response**, but it is persisted verbatim under `settings.yaml` → `web-search-deepseek: apiKey: sekret-xyz-123` (plaintext file, 0700 home). `credentials.set {ref:'MCP_TEST_TOKEN', value:'…'}` → ok; `credentials.describe {refs:[…]}` → `{configured:true, source:'file', writable:true}`; file `.credentials.yaml` → `version: 1\nrefs:\n  MCP_TEST_TOKEN: <plaintext>`.
- `session.create {}` → `{sessionId:'session-…', agentPreset:'standard'}` (idle agent, `blank:true, running:false`); `session.create {workspaceId}` attaches (workspace `sessionIds` updates). `session.list` returns summaries incl. `projections` (`sessionStats`, `title`, `goal`, `tokenUsage`…).
- `llm.models {}` → catalog incl. provider `deepseek-official` (`settingsNs:'llm-deepseek'`); its ns accepts `baseURL` + `apiKeyEnv` — set `baseURL` to a mock OpenAI-compatible server to run offline turns (§8).
- **There is no HTTP method listing a session's registered model-facing tools.** `session.history` returns raw `SessionEvent`s (tool `call`/`result` events appear only after a turn runs), `skill.list` lists human-invocable skills only, `pluginInventory.list` lists loader rows only. Tool-presence assertions therefore need either (a) an in-process cordis test, (b) plugin-inventory row state, or (c) a mock LLM capturing the `tools` array of the request dsh sends (recommended, §8).

Client-runtime note: `@deepseek-ai/dsh-client-runtime/client` is a **browser bundle** — `import()` under plain node fails with `ReferenceError: window is not defined` (verified). Drive the instance with a plain-fetch RPC driver instead (envelope above is the whole protocol; ~40 lines), or with `session.history` polling. `dsh-client-connection/client` types are browser-side too.

---

## 6. rc.1-generation surface (anchor 0.1.2-rc.1 — chamber) for contrast

Read from installed types (not exercised — the real home is read-only):

- Endpoints are **slash typert namespaces**: `POST /api/settings/describe` (payload `{"type":"client-request","rpcId":…,"method":"settings/describe","payload":{"args":{}}}`); namespaces `settings` (`describe/update/replace/mutate/openSettingsDocument/openAgentPresetDirectory`), `credentials` (`describe/set/unset`), `session` (`create/list/search/inspect/page/follow*/control*/prompt/cancel/rename/fork/selectModel/modelCatalog/attachment/updateQueue/openWorkspacePath`), `workspace` (`create/rename/delete/insertBefore/insertSessionBefore/archiveSession/follow*`), `directoryPicker`, `fileReferences`, `skills`, `pluginInventory/list`; stream methods over WS mux at **`/api/remote.mux`**; forwarded host events (`$events`) + `$events/result`.
- **Auth:** browser-session cookie model (`dsh-client-connection`): on boot the URL line carries `?token=<process launch token>`; `GET /?token=…` → 303 + sets an authority-bound HMAC-signed HttpOnly cookie (`dsh-auth-<sha256(authority)>`, secret persisted as a `client-connection/browser-session` grant record in `.credentials.yaml`); `/api/*` without the cookie → 401, off-loopback Host or cross-site markers → 403. Headless driver: fetch `/?token=` from the boot log with a cookie jar first.
- Settings/credentials semantics (describe views with `ns, schema, value, base, user, applies, secrets, revision`; `credentials.set` refuses when an env layer shadows the ref) match §5.

---

## 7. MCP test servers + dsh's MCP host half (verified)

- npm latest: `@modelcontextprotocol/server-everything` **2026.8.31**, `@modelcontextprotocol/server-filesystem` **2026.8.31**, `@modelcontextprotocol/sdk` **1.30.0**.
- **Installed offline** (persistent, workspace): `/root/projects/dsh-mcp-scope/.smoke/mcp-nodes/` (116 packages). Bins: `node_modules/.bin/mcp-server-everything`, `mcp-server-filesystem`. Both ran standalone under plain node with a newline-delimited JSON-RPC stdio handshake (verified: `initialize` → capabilities; `tools/list` → e.g. filesystem's `read_file`…; everything announces `tools/list_changed`). `server-everything` also serves standalone **Streamable HTTP**: `node …/server-everything/dist/index.js streamableHttp` → "MCP Streamable HTTP Server listening on port 3001" (verified).
- In-repo custom stdio test server: `@modelcontextprotocol/sdk@1.30.0` exports `dist/esm/server/mcp.js` (high-level `McpServer`), `dist/esm/server/stdio.js` (`StdioServerTransport`), `dist/esm/server/streamableHttp.js`, plus `inMemory.js`. A ~30-line local JS server (register one echo tool, connect `StdioServerTransport`) is the recommended controlled probe; no express needed for stdio.
- dsh host half: the in-box `@deepseek-ai/dsh-mcp-client` row (config contract in `mcp-client-official.md`) is a profile row per server:

```yaml
- insert:
    - id: mcp-fs
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fs          # tool prefix; tools register as mcp__fs__<rawName>
        transport: stdio
        command: /root/.nvm/versions/node/v22.22.3/bin/node   # absolute; env is scrubbed otherwise
        args: [ /root/projects/dsh-mcp-scope/.smoke/mcp-nodes/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js,
                /root/projects/dsh-mcp-scope/.smoke/ws-a ]
```

Verified live: on write to `profiles/web/cordis.patch.yml` the running instance hot-mounted the row and **spawned the MCP server** (its banner "Secure MCP Filesystem Server running on stdio … allowed directories …" appeared in the boot log within seconds). Tool registration itself is silent on success (rc.2 logs only re-sync/errors); names are `mcp__<serverName>__<rawName>` (≤32 char serverName), atomic full-generation syncs, conflicts rejected wholesale. Removal = remove the row (restart before asserting plugin-inventory, §3 caveat).

---

## 8. M0 smoke test script (concrete; implementer-run)

Assumes: repo scratch under `/root/projects/dsh-mcp-scope/.smoke`, global CLI rc.2, npm/pnpm caches redirected into `.smoke` (npm: `npm_config_cache`, pnpm: fake `HOME`), MCP servers installed (§7). Ports: use `32123` (proven) or `3212x`; never `30800/30801`.

1. **Environment + boot.** `mkdir -p .smoke/{home,logs,mcp-nodes,ws-a,ws-b}`; export `PATH` (nvm bin), `DSH_HOME=.smoke/home`, `HOME=.smoke/homedir`, `DSH_TELEMETRY_DISABLED=1`. Start `dsh web --no-open --port 32123` as a background job (foreground child), log to `.smoke/logs/boot.log`.
   **Observe:** within ~2–5 s the log contains exactly `dsh web: http://127.0.0.1:32123`; `curl http://127.0.0.1:32123/` → 200 HTML with `window.__DSH_BOOT__`; `$DSH_HOME/profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml}` exist (first boot auto-init).
2. **API sanity + workspaces.** `POST /api/workspace.create {path: .smoke/ws-a}` → ok `{workspace:{…}, created:true}`; repeat → `created:false`; `workspace.list` shows it; `POST /api/workspace.create` with a missing dir → `workspace-invalid-path`.
   **Observe:** `storages/workspace.json` gains the row (id, path, title, timestamps).
3. **Session in workspace.** `POST /api/session.create {workspaceId:<id>}` → `{sessionId:'session-…', agentPreset:'standard'}`; `workspace.list` → `sessionIds` contains it; `session.list` → summary with `cwd` = the workspace path, `blank:true`.
   **Observe:** log dir `sessions/--root-projects-dsh-mcp-scope-.smoke-ws-a--/session-…/` appears.
4. **Settings read/write w/ revision.** `settings.describe` → namespaces incl. `locale` rev 0; `settings.mutate {ns:'locale', ops:[{op:'set',path:['preference'],value:'en'}], expectedRevision:0}` → ok rev 1; mutate again with `expectedRevision:0` → **`settings-conflict`**; describe → value has `preference:'en'`; `cat $DSH_HOME/settings.yaml` shows the user layer.
   **Plugin namespace version of this step (needs the built plugin, M1):** after `dsh plugin --profile web add <package>` + restart, `settings.describe` lists the plugin's ns with its schema; writes land in `settings.yaml` under that ns key.
5. **Credentials write-only.** `credentials.set {ref:'MCP_TEST_TOKEN', value:'s3cret'}` → ok; `credentials.describe {refs:['MCP_TEST_TOKEN']}` → `{configured:true, source:'file', writable:true}` **without the value**; `credentials.unset` → configured false; file `.credentials.yaml` holds/removes the plaintext under `refs:`.
6. **Secret-role field (host capability, no plugin needed).** `settings.update {ns:'web-search-deepseek', patch:{apiKey:'x'}}` → ok; describe → `secrets:[{path:['apiKey'], set:true}]`, no value anywhere in the response; the value exists only on disk.
   **Observe (write-only semantics):** any further describe/history read never contains the secret.
7. **Plugin loads into instance profile.** With a packaged plugin (bundle manifest `dsh.bundle.patch`) in the repo: `dsh plugin --profile web add file:…` (pnpm in the profile dir; reconcile appends the package to `dsh.profile.bundles`). Restart, then `POST /api/pluginInventory.list` (dotted or slash per generation) → entry with the plugin's module name, `enabled:true, fiberPhase:'active'`; `cat profiles/web/package.json` shows the bundle added.
   **Caveat:** do the pluginInventory assert on a **fresh boot** (rc.2 live-reload drops the claim, §3).
8. **Host half ↔ MCP stdio ↔ mcp__ tools.** Insert the §7 `mcp-fs` row into `profiles/web/cordis.patch.yml` while running (or before boot + restart).
   **Observe:** boot log shows the filesystem server banner (spawned). **Tool-presence proof (recommended):** run a tiny OpenAI-compatible mock on 127.0.0.1 (`/v1/chat/completions`), point the instance at it via `settings.update {ns:'llm-deepseek', patch:{baseURL:'http://127.0.0.1:<mock>/v1'}}` (+ `credentials.set DEEPSEEK_API_KEY` for `apiKeyEnv` if the adapter requires a key), then `session.prompt {sessionId, mode:'queue', content:[{type:'text', text:'…'}]}` and assert the mock's captured request body `tools[].name` contains `mcp__fs__read_file` etc.; alternatively assert only row+spawn and inspect a later `session.history` tool event after one mocked turn completes. **Unknown:** the deepseek-adapter request/stream dialect against a stub — reserve this step for M1 and verify adapter codec first (`dsh-llm-deepseek`).
9. **Per-workspace off switch removes them.** Depends on dsh-mcp-scope's own switch design (settings ns + tool-scope filtering vs. row add/remove). Generic core-level probe: remove the `mcp-fs` row from the patch + restart → server no longer spawns, and (with the mock) the next prompt's `tools` array has no `mcp__fs__*`. **Unknown/design decision:** the actual per-workspace mechanism the plugin ships; core dsh has no such switch today.
10. **Credentials write-only (plugin's own store).** If the plugin stores per-server keys: `credentials.set {ref:<plugin ref>}` then assert `describe` never returns values and all UI-facing reads (settings describe over the plugin ns) redact them (§5/6 verified for in-box ns).

Known unknowns recap: (a) rc.2 pluginInventory claim loss after user-patch live reload (bug or discovery-order issue — needs M1 triage); (b) no HTTP session-tool-list endpoint — tool assertions need the mock-LLM capture or in-process tests; (c) exact mock-LLM dialect the deepseek adapter expects; (d) per-workspace switch design for the plugin itself; (e) where the plugin's settings "card" hooks in UI (`settings.plugin.item` slot keyed by ns — `ui-contracts.md`), which is browser-side and not exercisable headlessly beyond `settings.describe`.

---

## 9. Practical notes

- Boot ~1–3 s; stop = SIGTERM; each run rewrites `profiles/web/cordis.yml` to `[]` (by design, patch composition is authoritative).
- No Xvfb/electron/GUI ever needed; the "web UI" is a node http server + static SPA dist. Feasible to run several scratch instances on distinct ports/homes in this container (only 30800/30801 are taken, outside the sandbox).
- Memory footprint not measurable from inside the sandbox (no cross-namespace /proc); nothing in the boot path suggests more than a typical node app (~200–400 MB with sessions). Re-measure in M1 with `ps -o rss` from the instance's own job shell.
- Persistence: EVERYTHING for a scratch instance must be under `/root/projects/dsh-mcp-scope/.smoke` (workspace) — `/tmp` is wiped between commands and `/root` is read-only (npm cache / pnpm store would hit `EROFS` otherwise).
- Boot logs double as the MCP-spawn observability point (server children inherit the log fd); rc.2's `dsh-mcp-client` logs errors/re-syncs via `ctx.logger`, success is silent.
