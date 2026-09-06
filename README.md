# dsh-mcp-scope

A user-installable **third-party dsh plugin** that manages **MCP servers per
workspace** from the dsh Settings UI:

- a browser **MCP 服务器 / MCP servers settings section** — add/remove MCP
  servers (stdio or streamable-http), per-workspace on/off switches, write-only
  secret key inputs;
- a host half that connects to each server (official `@modelcontextprotocol/sdk`
  transports), discovers its tools and **injects them only into the tool scopes
  of enabled workspaces** — disabling a workspace removes the server's tools
  from that workspace's sessions at the injection layer (model-visible tool set),
  not merely at execution time.

Tool naming, output mapping, env hygiene and reconnect policy follow the official
`@deepseek-ai/dsh-mcp-client` contract (`mcp__<serverName>__<tool>`, `tools/list`
→ generation swap, scrubbed child env, backoff reconnect). All state lives in the
dsh settings domain of the instance the plugin is installed into; nothing is
shared across dsh instances; **dsh-chamber itself never seeds, bundles or
special-cases this plugin** — it is an ordinary `dsh plugin` install.

## Install

Prereqs: a dsh instance (0.1.2-rc.1 generation); Node ≥ 24 and pnpm on
PATH are toolchain requirements for building this repo and for the dsh CLI
driving pnpm — not requirements of the installed plugin itself.

Releases ship as a GitHub Release whose asset is the packed tarball
(`npm publish` is temporarily disabled). Install per instance:

```sh
# into the web profile of a specific dsh instance (per-instance management)
dsh plugin --profile web add \
  https://github.com/<owner>/dsh-mcp-scope/releases/download/v0.0.1/dsh-mcp-scope-0.0.1.tgz
# or, after building locally:  add file:./dsh-mcp-scope-0.0.1.tgz
# restart the instance (the profile bundle list changed)
```

(Once npm publishing is re-enabled, `dsh plugin --profile web add dsh-mcp-scope`
installs the same content from the registry.)

- The package's `dsh.bundle` patch inserts one loader row (`mcp-scope`); the
  browser half is discovered via the package's `dsh.client` declaration.
- First boot right after install may race the client-module scan — **restart once**
  and the section appears in `Settings` (nav order 25, after 智能体预设/Agent presets).
- Data is bound to that instance's `$DSH_HOME`: `settings.yaml` holds the
  `mcp-scope:` namespace document; secret values live only in
  `.credentials.yaml` (never ride any API response).

## Use

1. Open Settings → **MCP servers** and *Add server*:
   - stdio: server name + command + arguments (passed verbatim, no shell) +
     optional working directory + env-key rows. Each env key names a credential
     ref whose resolved value is injected into the child env (the row's value
     input is write-only).
   - Streamable HTTP: URL + header rows (name + write-only credential ref).
2. A server is **on by default in every workspace** of this dsh. Under the
   server card, switch specific workspaces off — their sessions' model-facing
   tool set no longer includes `mcp__<serverName>__*`.
3. Removing a server stops it everywhere and clears credential refs no remaining
   server references.

Notes: the server process runs as this dsh instance's user; the command's
environment is scrubbed of `DSH_*` and secret-shaped variables except what you
declare explicitly; servers connect at instance start (host activation
lifecycle, like the official client) and reconnect with the official backoff
policy.

## Uninstall

```sh
dsh plugin --profile web remove dsh-mcp-scope   # + restart the instance
```

Removing the package stops the servers and drops the settings section. Namespace
and credential leftovers can be cleaned by deleting the `mcp-scope:` section
from `$DSH_HOME/settings.yaml` and the related refs from
`$DSH_HOME/.credentials.yaml` (manual, documented; values are write-only so the
UI cannot read them back).

## Compatibility

- Target/verified: dsh **0.1.2-rc.1** (npm `next`; the generation dsh-chamber
  runs). Compile-time API surface: `@deepseek-ai/dsh-*@0.1.2-rc.1`.
- Requirement model: every configured server defaults on for all of this dsh's
  workspaces; only explicit per-workspace records turn one off.
- Sessions outside any registered workspace (plain cwd sessions) never receive
  MCP tools; delegation/subagent children are preset-governed and never
  receive MCP tools from this plugin (workspace root sessions do).
- Out of scope by design (no file/CLI management surface, no toolPolicy
  allow/ask/deny, no pause key, no custom naming, no status visualization, no
  on-demand connect toggles).

## Development

```sh
npm install            # dev deps (--legacy-peer-deps: dsh devDep version-line skew)
npm run typecheck      # src + tests
npm test               # vitest suite (133 tests)
npm run check          # full gate: typecheck + tests + build + package verify
npm run verify:package # pack → contents whitelist → consumer d.ts check → determinism
npm run pack:tgz       # build + .smoke/dsh-mcp-scope-<ver>.tgz
npm run test:smoke     # live M0/M1 smoke (needs the chamber-anchored dsh CLI; see docs/RELEASE.md)
```

CI (`.github/workflows/ci.yml`, Node 24 on push/tags/PR + dispatch) runs the full gate and
uploads the tarball; releases are tag-driven (`v*` → `.github/workflows/release.yml` → GitHub
Release whose asset is the packed `dsh-mcp-scope-<version>.tgz`; npm publish
is temporarily disabled). See `docs/RELEASE.md` for the release checklist and
smoke-runner requirements.

Docs: `docs/design.md` (architecture), `docs/recon/` (evidence reports),
`docs/milestones/M0.md` + `M1.md` (smoke evidence), `docs/host-notes.md` /
`docs/ui-notes.md` (API findings & deviations), `docs/review/` (round-2
six-axis review reports + `SUMMARY.md` disposition matrix). Smoke drivers
under `scripts/smoke/` boot scratch 0.1.2-rc.1 instances and drive the real
RPC surface.
