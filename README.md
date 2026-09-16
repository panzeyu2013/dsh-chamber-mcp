# dsh-chamber-mcp

[![CI](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/panzeyu2013/dsh-chamber-mcp?display_name=tag)](https://github.com/panzeyu2013/dsh-chamber-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

**MCP servers, per workspace, from the dsh Settings UI.** A standalone
third-party [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin:
declare MCP servers once (stdio or Streamable HTTP), then decide **per
workspace** — with a switch — whether that workspace's sessions see their
tools.

- **Settings-native management.** *Settings → MCP servers* (`MCP 服务器`) adds,
  edits and removes servers; no `cordis.patch.yml` editing and no instance
  restart to change what runs.
- **Per-workspace tool scopes, off by default.** A server reaches a
  workspace's model-visible tool set only after that workspace is explicitly
  enabled for it — a new server, a new workspace and a fresh session carry no
  MCP tools until then — and switching it off removes
  `mcp__<serverName>__*` from that workspace's sessions at the injection layer,
  not merely at execution time.
- **Credential refs, not secrets.** The settings document stores ref names
  only; values are write-only, live in the dsh credentials domain, and never
  ride a settings document, an API response or a log line.
- **Official bridge contract.** Naming (`mcp__<serverName>__<tool>`), result
  mapping, env scrubbing, generation swap on `tools/list_changed` and the
  backoff reconnect policy mirror `@deepseek-ai/dsh-mcp-client`.
- **Hand-editing works.** With the default file provider the document is
  watched and live-reloaded, so an external edit starts/stops/restarts only the
  affected servers.

All state lives in the dsh settings domain of the instance the plugin is
installed into; nothing is shared across dsh instances. **dsh-chamber itself
never seeds, bundles or special-cases this plugin** — it is an ordinary
`dsh plugin` install.

## Install

Prerequisites:

- a dsh instance of the supported generation (see [Compatibility](#compatibility));
- `dsh` on `PATH`, plus **pnpm** and **Node ≥ 24** — the toolchain the `dsh
  plugin` CLI uses to install the package (not a runtime requirement of the
  plugin itself, which is loaded by the dsh host).

Releases ship as a GitHub Release whose asset is the packed tarball
(`npm publish` is temporarily disabled). Pick the newest asset from the
[Releases page](https://github.com/panzeyu2013/dsh-chamber-mcp/releases) —
the **newest published release is `v0.0.3`** (published 2026-09-15, tgz +
`.sha256`) — and install it per instance:

```sh
# into the web profile of one dsh instance (per-instance management)
dsh plugin --profile web add \
  https://github.com/panzeyu2013/dsh-chamber-mcp/releases/download/v<version>/dsh-chamber-mcp-<version>.tgz

# or build and install the local package
npm run pack:tgz
dsh plugin --profile web add file:./.smoke/dsh-chamber-mcp-<version>.tgz

# restart the instance afterwards (the profile bundle list changed)
```

Once npm publishing is re-enabled, `dsh plugin --profile web add dsh-chamber-mcp`
installs the same content from the registry.

What the install does:

- the package's `dsh.bundle` patch inserts one loader row (`mcp-scope`); the
  browser half is discovered through the package's `dsh.client` declaration;
- the settings section appears at nav order 25, after
  智能体预设 / Agent presets. The first boot right after install may race the
  client-module scan — **restart once** if it is missing;
- data is bound to that instance's `$DSH_HOME`: `settings.yaml` holds the
  `mcp-scope:` namespace document, secret values live only in
  `.credentials.yaml` and are never returned by any API.

## Use

1. Open *Settings → MCP servers* and choose **Add server**. Two transports:
   - **stdio** — server name, command, arguments (passed verbatim, `shell:
     false`), optional working directory, and env-key rows. Each key names a
     credential ref whose resolved value is injected into the child env; the
     row's value input is write-only.
   - **Streamable HTTP** — URL and header rows (name + write-only credential
     ref).
2. A new server is **off in every workspace** of this dsh; the card lists the
   **enabled** workspaces only — the ones explicitly switched on — or one
   "all N workspaces are off by default" line when there are none. **Manage
   workspaces (N on)** reveals every workspace row — switching one on/off drops
   `mcp__<serverName>__*` from that workspace's sessions — plus **All on /
   All off** once more than one workspace exists. The switch beside the server
   name is the **global** enable: a disabled server is not started and exposes no
   tools anywhere, while its configuration stays on disk.
3. Each card also carries its live **runtime status** (connected / connecting /
   reconnecting / failed / stopped / disabled / unknown), a localized failure line,
   **Connect** / **Disconnect** and **Test**. Disconnect is a real stop and
   survives unrelated settings edits; editing the definition or pressing
   Connect brings it back (including after the reconnect budget is exhausted).
   Test uses a throwaway connection unless the server is already connected, and
   the section header carries a **Refresh status** action.
4. **Tools (N)** discloses the synced tool names of a connected server.
5. **Edit** reopens the staged form (enable switch and per-server timeout
   included); **Remove** stops the server everywhere and clears credential refs
   that no remaining server references. The form guards unsaved changes, and
   accepts clipboard pastes (a full command line, `.env` lines, header lines)
   plus a single-server JSON import.
6. The section header has a name filter once servers exist.

Servers connect when the plugin starts (host activation lifecycle, like the
official client) and reconnect with the official backoff policy — the Connect
step never blocks dsh boot. The runtime status/actions ride the same `/api`
Connection surface the rest of the GUI uses, so a remote/authenticated
deployment (including the chamber gateway proxy) needs no extra configuration;
if that surface is absent the section degrades to "runtime status unavailable"
and every document feature keeps working.

## What the model sees

The plugin is an **injection gate**, not a permission filter. Tools are
registered into the *tool scope of each live agent* whose session is a
workspace root session in an enabled workspace — never into a global registry.

| Session | Gets MCP tools? |
|---|---|
| Workspace root session, server on for that workspace | Yes — `mcp__<serverName>__<rawName>` |
| Workspace root session, workspace switched off for that server | No — the definitions are revoked from that agent's scope |
| Session whose cwd is outside every registered workspace | No |
| Delegation / subagent child (`origin: 'subagent'`) | No — children are preset-governed (`docs/design.md` §4) |

Consequences worth knowing:

- **Disabling a workspace is a model-visible change**: the tools disappear from
  the tool list the model is offered, not just from what it may execute.
  Live sessions are updated on the next reconcile (a settings commit or a
  server re-sync), and the change lands in the next request's tool list.
- **The tools are part of the context.** MCP definitions are ordinary tool
  schemas on the request, so they appear in the composer's context meter (the
  ring beside the send button) under **工具定义 / Tool definitions**, priced
  heuristically from the request's tool array. A server that publishes
  `instructions` additionally contributes a literal `### MCP server: <name>`
  prompt section (not counted by the tool-definition line). The meter itself
  renders only after the model has reported usage for the session.
- **A call renders as an MCP row, not the generic card.** The plugin owns how
  its calls render through the keyed `tool.call.toolview` slot: the leading mark
  is a plug, the title is `serverName · toolName` with a `stdio` / `Streamable HTTP`
  transport tag, and the row expands to the raw arguments and the rendered
  result. A **running** call carries the sweep treatment and a primary title
  and reports `aria-busy`; a **settled** call drops the animation and shows its
  duration; a **failed** call yields the leading mark to the shipped red status
  dot and puts the failure's first line on the summary in the error colour; an
  **interrupted** call shows the amber dot. The disclosure behaviour is the
  shipped one too: click or Enter/Space expands, and the leading glyph swaps to
  the chevron on hover or while open. The view set is derived
  from the session's own event stream — every tool the request header offered
  plus every call the transcript actually shows — so a call outside that set, or
  a tool past the registration cap, falls back to the shipped generic card
  instead of breaking the transcript.
- **Names are normalized, never colliding.** A public name is
  `mcp__<serverName>__<rawName>` trimmed to the DeepSeek function-name contract
  (≤ 64 chars of `[A-Za-z0-9_-]`); when normalization is lossy, a 12-hex
  SHA-256 identity suffix is appended so two distinct MCP tools can never
  collapse into one name. The raw MCP name is what is sent in `tools/call`.
- **Rich content is the official adapter's.** An image block becomes a durable
  attachment when the composition provides an attachment store and the current
  model route declares image input; otherwise it projects a diagnostic line
  (`[image unavailable: …]`) while the canonical value keeps the raw block —
  base64 never reaches model history. Audio and embedded resources project as
  diagnostics.
- **Tool calls time out after 60 s** (official default) and are aborted with
  the run's signal. A listing that does not converge (the client's own
  `listMaxPages`, 64) or that exceeds the plugin's 2000-tool cap fails the sync
  and keeps its previous tool generation.

## Where the configuration lives

The plugin stores nothing of its own: it registers the `mcp-scope` **settings
namespace**, so the document lives wherever that instance's settings provider
puts it. With the default file provider that is one document for every
namespace — `$DSH_HOME/settings.yaml`, with the extension picking the format
(`.yaml`, `.yml`, `.json`):

```yaml
mcp-scope:
  servers:                        # one entry per server; serverName is the identity
    - serverName: github
      transport: streamable-http  # or stdio: command/args/cwd/envKeys
      url: https://mcp.example.com/x
      headers:
        - name: Authorization
          ref: GITHUB_TOKEN       # a credential REF, never a value
  overrides:                      # presence = that workspace is ON (default off)
    ws-2f1c:
      github: true
```

- Credential **values** never ride this document — only ref names. The values
  live in the credentials domain (default on-machine provider:
  `$DSH_HOME/.credentials.yaml`), written write-only from the UI.
- **Hand-editing works.** The file provider watches the document by default
  (`watch: true`, 100 ms settle), so adding or removing a server, or flipping an
  override, with any editor takes effect live: the plugin reconciles on the
  published change and starts/stops/restarts only the affected servers — no
  instance restart. Writes made through the UI are leaf-level YAML diffs, so
  comments, anchors and formatting survive on every untouched node.
- A hand-edit must satisfy the same rules the UI enforces: a unique
  `serverName` (`[A-Za-z0-9_-]{1,32}`, and not `__proto__` / `constructor` /
  `prototype`), a required `command` (stdio) or `url` (http), no duplicate env
  keys or header names, credential refs matching `[A-Za-z_][A-Za-z0-9_]*`, and
  `overrides` values of exactly `true`.
- An edit that breaks those rules is **not published**: the running instance
  keeps the last good document (and warns) while the file on disk holds the bad
  text — fix the file to converge. An unparsable document fails the load at boot
  (loud); once running, an unreadable or unparsable edit keeps the last good
  sections. Deleting the file resets every namespace to its defaults, and a
  section whose plugin is not loaded is never dropped.

## Uninstall

```sh
dsh plugin --profile web remove dsh-chamber-mcp   # + restart the instance
```

Removing the package stops the servers and drops the settings section.
Namespace and credential leftovers can be cleaned by deleting the `mcp-scope:`
section from `$DSH_HOME/settings.yaml` and the related refs from
`$DSH_HOME/.credentials.yaml` (manual, documented; values are write-only, so the
UI cannot read them back).

## Relationship to the official dsh MCP client

dsh already ships `@deepseek-ai/dsh-mcp-client`, and this plugin deliberately
mirrors its bridge contract. It exists because the official client covers only
part of what "manage MCP servers for this dsh" means:

| | official `dsh-mcp-client` | this plugin |
|---|---|---|
| Where servers are configured | the Cordis composition (`cordis.patch.yml`, `dsh web --patch`) — one loader row per server | the dsh **Settings UI**, stored in the `mcp-scope` settings namespace |
| Secret handling | literals (or `!!js process.env.X`) in that config file | **credential refs**; values live in the credentials domain and never ride the settings document or any API response |
| Who sees the tools | whatever context the row is composed in — host-level rows land in the **global layer**, so every agent/session sees them | **only the tool scopes of enabled workspaces**; disabling a workspace removes the server's tools from that workspace's model-visible set |
| Enable/disable, add/remove | edit the config file and reload | per-workspace switches + add/remove in the UI, plus live hand-editing of the document |
| MCP capabilities bridged | tools only | tools, **plus resources** on 0.1.6+ (the plugin contributes the `mcpResources` provider, so the official resource tools can reach its servers); tools only on 0.1.5 |
| Naming / env scrub / reconnect / generation swap | `mcp__<serverName>__<tool>`, scrubbed child env, backoff reconnect, `tools/list_changed` re-sync | the same contract, verified against it |
| The call's row in the transcript | whatever the shipped tool row renders (generic card, title = tool name) | an **MCP row** owned through the keyed `tool.call.toolview` slot: plug mark, `server · tool` title, transport tag, shipped state marks (red/amber dots) and disclosure behaviour, expandable arguments + result |
| Image results | bridged to attachments when the model accepts images | the same bridge, attachments, diagnostics and canonical value on **both** generations: 0.1.6+ runs the official adapter, 0.1.5 this plugin's verbatim port of it |

Stock dsh has no MCP management surface to reuse: the Plugins → *Plugin
configuration* tab renders a card only for a settings namespace a plugin
registers (the official client registers none), the plugin list is read-only, and
`dsh-workspace` is a project-grouping registry that registers no tools — so no
upstream mechanism maps a workspace to a tool set; this plugin supplies one
through its own settings namespace and per-agent tool scopes (`docs/design.md`).

## Compatibility

| | Version | Notes |
|---|---|---|
| Compile-time anchor & CI guard | dsh **0.1.6-alpha.1** | every `@deepseek-ai/dsh-*` devDependency is pinned to that generation and `npm run typecheck` + tests run against it |
| Live-verified | dsh **0.1.5-rc.2** and **0.1.6-alpha.1** | `npm run test:smoke` installs and boots the packed tarball through whichever anchor CLI `DSH_ANCHOR_CLI` points at, and each transcript records the version it used. The chamber anchor (dsh 0.1.5-rc.2) exercises the built-in fallback; the 0.1.6-alpha.1 anchor exercises the official adapter |
| Peer range | `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1` | the two generations verified live: 0.1.6+ gets the official `createMcpToolDefinition` adapter, the `mcpResources` provider and prompt instructions; 0.1.5 keeps the plugin's own text projection and publishes no prompt section (that host always interpolates section text) |

- Requirement model: every configured server defaults on for all of this dsh's
  workspaces; only explicit per-workspace records turn one off.
- Sessions outside any registered workspace (plain cwd sessions) never receive
  MCP tools; delegation/subagent children are preset-governed and never receive
  MCP tools from this plugin (workspace root sessions do).
- Out of scope by design: no file/CLI management surface, no toolPolicy
  allow/ask/deny, no custom naming (`docs/acceptance.md`, cut list C1–C2/C6).
  The 0.0.3 line deliberately supersedes the original pause/status/on-demand
  connect cuts (C3–C5) with the global enable switch, the runtime status
  surface and manual Connect/Disconnect/Test — see the extended matrix E1–E8.

## Security & trust model

- **A configured MCP server is code you chose to run.** stdio servers execute
  as the dsh instance's user with the instance's filesystem access; streamable
  HTTP servers receive whatever their headers carry. Configure only servers you
  trust, and treat their tool output as untrusted input.
- **Credentials are write-only.** Values are resolved per (re)connect from the
  credentials domain; missing and empty refs are omitted with a warning, and
  resolved values containing CR/LF/NUL are rejected at the transport boundary
  so they can neither inject headers/env nor forge log lines. Warnings name the
  ref, never the value.
- **Child environments are scrubbed.** stdio children inherit neither `DSH_*`
  nor credential-shaped ambient variables — only the keys you declare
  explicitly; spawn is `shell: false` (no shell interpolation).
- **Remote input is bounded.** `tools/list` aggregation is capped by the
  client itself (`listMaxPages`, 64 — the non-converging-cursor defence), the
  plugin caps the TOTAL listed tools at `MAX_SYNC_TOOLS` = 2000 per server, and
  invalid results fail closed to the previous tool generation. Input schemas pass through unchanged; an advertised output schema
  is only honoured when it passes the dsh tool-registry's JSON-schema check,
  and otherwise falls back to an unconstrained result.
- **A failed connection stops being dangerous.** After 10 consecutive failed
  reconnect attempts the supervisor gives up and **unregisters the server's
  tools** rather than leaving half-dead entries; reconnect resumes on plugin
  reload / instance restart.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No *MCP servers* section in Settings | The post-install client-module scan raced. Restart the instance once; verify with `dsh plugin --profile web list` that the bundle is installed. |
| Section renders, but says settings are unavailable | The client is read-only or the namespace is not served to this connection — check that the host half loaded (loader row `mcp-scope`) and the profile was restarted. |
| A tool never appears in a session | Check, in order: the session is a **workspace root** session; the server is **on** for that workspace (not switched off); the server is connected and listed tools (see the instance log for `mcp-scope(...)`). Subagent children never receive MCP tools by design. |
| Hand-edited `settings.yaml` had no effect | The edit violated a document rule and was not published — the instance keeps the last good document and warns. Fix the file; the log names the violated rule (duplicate key, cross-field conflict, pattern mismatch). |
| A server stopped working after a crash | The supervisor reconnects with 500 ms → 30 s backoff, 10 attempts per outage. After giving up, reload the plugin or restart the instance. |
| Secret input looks empty after saving | By design: values are write-only. The badge shows *Configured* / *Not configured* / *Status unknown*; only the stored ref name is in the settings document. |
| I want to switch the plugin off without uninstalling it | Compose a patch over the profile (`dsh web --patch <file>`) that disables the loader row: under `- id: mcp-scope`, set `disabled: true` (the row is visible in `dsh --dump-config`). The servers stop and the settings section disappears; the namespace document stays on disk. |
| I want to know whether the MCP tools count toward context | Yes — they are ordinary tool schemas in the request. Open the context meter beside the composer's send button and read **工具定义 / Tool definitions** (see [What the model sees](#what-the-model-sees)). |

## Development

```sh
npm install            # dev deps (all @deepseek-ai/* pinned to one dsh generation)
npm run typecheck      # src + tests
npm test               # vitest suite (497 tests, 25 files)
npm run check          # full gate: typecheck + tests + build + package verify
npm run verify:package # pack → contents whitelist → consumer d.ts → built host entry import → bundle purity → MCP-row artifact check → determinism
npm run verify:client-artifact # drive the BUILT client bundle in jsdom (MCP row + registered-tools notice registration/render/expand, incl. the PTC prompt-only source)
npm run pack:tgz       # build + .smoke/dsh-chamber-mcp-<ver>.tgz
npm run test:smoke     # live M0/M1 smoke (needs the chamber-anchored dsh CLI; see docs/RELEASE.md)
npm run verify:workflows # action pins + release-structure invariants
```

CI (`.github/workflows/ci.yml`, Node 24 on push/tags/PR + dispatch) runs the full
gate and uploads the tarball; releases are tag-driven (`v*` →
`.github/workflows/release.yml` → GitHub Release whose asset is the packed
`dsh-chamber-mcp-<version>.tgz` plus its `.sha256`; npm publish is temporarily
disabled). See `docs/RELEASE.md` for the release checklist and smoke-runner
requirements.

Contributing: every change that alters behaviour needs a `CHANGELOG.md` entry
(releases compose their notes from the dated section), a passing `npm run check`,
and — for workflow or release-mechanics changes — one `workflow_dispatch` dry
run of `release.yml` before the tag.

## Documentation

| Doc | Contents |
|---|---|
| `docs/design.md` | Architecture and decisions, upstream contracts and deliberate deviations, the style seat and the UI layout reference |
| `docs/acceptance.md` | Requirement/cut matrix (R1–R4, E1–E8, C1–C6) |
| `docs/status.md` | Current release/verification state and known limitations |
| `docs/RELEASE.md` | CI + release mechanics, smoke runner, rollback |

Smoke drivers under `scripts/smoke/` boot scratch instances from the anchor CLI
named by `DSH_ANCHOR_CLI` — the chamber anchor (dsh **0.1.5-rc.2**, gateway
0.3.0) or a newer one such as **0.1.6-alpha.1** — install the tarball freshly
packed from the working tree, and drive the real RPC surface. Each transcript
records the version it used, and M0 asserts through `/api/mcp-scope.tools` that
the supervisor actually listed the fixture server's tools on that anchor.

## License

[MIT](LICENSE). Tool-naming, sync/generation-swap, executor and transport
semantics mirror the reference implementation
`@deepseek-ai/dsh-mcp-client` (Copyright © 2026 DeepSeek, MIT); see `LICENSE`
for the attribution notice.
