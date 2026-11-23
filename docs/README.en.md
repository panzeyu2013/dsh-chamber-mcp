# dsh-chamber-mcp

[![CI](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/panzeyu2013/dsh-chamber-mcp?display_name=tag)](https://github.com/panzeyu2013/dsh-chamber-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

[简体中文](../README.md) ｜ **English**

> **MCP servers, per workspace, managed from the dsh Settings UI.**
> Declare a server once (stdio or Streamable HTTP), then use a switch to decide **which workspaces** may see its tools. By default: none of them.

A standalone third-party [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin, installed as an ordinary `dsh plugin` — dsh-chamber neither seeds, bundles nor special-cases it.

## Why it exists

dsh ships `@deepseek-ai/dsh-mcp-client`, which **bridges** MCP into the model; this plugin no longer maintains a connection layer of its own. **Every configured server is mounted as an official `McpClientHost` instance** — one isolated seat child fiber per definition (isolating `tools`/`systemPrompt`/`mcpResources`/`credentials`/`mcpClientHost` and installing four capture-only façades). Connection, `${credential:…}` templates, reconnect backoff, generation swap, instructions and the resource provider, plus OAuth grant read/refresh/redaction, all belong to the mounted official instance. The plugin keeps the **per-workspace injection gate**, the settings UI, status/action routes, the OAuth *attempt* flow and the transcript lanes.

The Web profile (`dsh-web-app`) has also mounted the official `@deepseek-ai/dsh-mcp-manager` since 0.2.2-rc.2 (the 0.2.3-alpha.2 Web composition still carries the `mcp-manager` row) — but it manages the **host-global plane**:

- an official-manager server applies to the whole Host: once enabled, **every** session carries all of its MCP tools — context cost plus misfire risk;
- the official manager covers Settings edits, `${credential:…}` templates and status/restart/probe, but it has **no "workspace" dimension**;
- `dsh-workspace` is a project-grouping registry that registers no tools — **nothing upstream maps a workspace to a set of tools**.

This plugin supplies that missing piece: a **per-workspace injection gate** on top of the official bridge contract, plus its own **management surface** (server list / server detail / workspaces view in Settings). Both planes can coexist on one Host — global scope to the official manager, workspace granularity to this plugin. But **the same `serverName` must not be configured in both planes**: the official host reserves each name per application root, and this plugin maps a duplicate to the hard `failed{conflict}` error (read-only pre-check plus a mount-race code fallback) — not "two independent registrations".

## Core advantages

| Advantage | What it means |
| --- | --- |
| **Settings-native management** | Add, edit and remove servers in *Settings → MCP servers*, never touching `cordis.patch.yml`. UI writes commit into the **running** plugin and only cycle the affected servers — no instance restart |
| **Per-workspace injection, off by default** | A new server is off for **every** workspace; a new workspace or a fresh session never silently gains MCP tools. Switching a workspace off **revokes** `mcp__<serverName>__*` from that workspace's tool list — a model-visible change, not just an execution-time block |
| **Credential refs, not secrets** | The settings document stores `${credential:REF}` template strings only — the mounted official instance resolves them at connect time and never writes a value back; values live in the dsh credentials domain, are **write-only**, and never ride an API response or a log line |
| **An MCP-specific transcript row** | A call renders as an MCP row registered through the keyed `tool.call.toolview` slot: plug mark, `server · tool` title, transport tag, running/settled/failed/interrupted states, expandable arguments and result — not the shipped generic card |
| **Official connection layer** | Connection, `${credential:…}` templates, reconnect backoff, `tools/list_changed` generation swap, `instructions` prompt sections and the `mcpResources` provider are **executed by the mounted official `McpClientHost` instance**; this plugin only captures and replays them per agent — the naming/result/image contract is upstream code again |
| **On-demand tool loading** | Per server, `toolLoading: on-demand` keeps the tool list down to the loader `mcp__<serverName>__load_tools` and renders the catalog from the mounted client; a tool enters that agent's scope only after the model loads it (still gated by workspace enablement and the subagent `toolFilter`, and revocable) |
| **OAuth browser authorization** | An HTTP server can enable the official browser-authorization flow (OAuth O2): PKCE/DCR/callback are the official flow's, the grant lives in the credentials domain under a name-derived key the UI never shows, and the detail offers Authorize / Cancel authorization / Sign out, the five authorization-reason hints and a copyable authorization link. Available on this declared line only, and the browser must reach the host origin directly |
| **A clear split between UI and hand edits** | UI writes are live leaf-level YAML diffs (comments, anchors and formatting survive); a hand-edited patch row applies at the next boot, after the loader validates it |

## Quick start

Prerequisites: a dsh instance of a supported generation, `dsh` on `PATH`, plus Node ≥ 24 and pnpm (the toolchain `dsh plugin` uses to install the package — not a runtime requirement of the plugin itself, which the dsh host loads).

```sh
# install from the GitHub Release asset (npm publishing is temporarily disabled; <version> = see Releases)
dsh plugin --profile web add \
  https://github.com/panzeyu2013/dsh-chamber-mcp/releases/download/v<version>/dsh-chamber-mcp-<version>.tgz

# or build and install the local package
npm run pack:tgz
dsh plugin --profile web add file:./.smoke/dsh-chamber-mcp-<version>.tgz

# restart the instance afterwards (the profile bundle list changed)
```

1. Open *Settings → MCP servers* → **Add server**, or use **Import from clipboard** from the empty state. Two transports: **stdio** (name, command, arguments, optional working directory, env-key rows) and **Streamable HTTP** (URL and header rows). The editor accepts a full command line, `.env` lines, header lines, and single- or multi-server JSON (pick one when several are present); saving runs a connection test automatically.
2. A list row shows **status, scope and tool count** only. Open it for the detail: **Workspaces** switches this server on or off per workspace (immediate and undoable), while **Allow to run** under **Availability** is the global switch (not allowed = not started and no tools anywhere; the configuration stays on disk). A new server is **off in every workspace** by default.
3. The **Workspaces** tab answers the mirror question — which servers a workspace can use — and batches servers on or off. The detail also carries **Tools** (search and copy), **Configuration** (definition, credential references, copy JSON), live status / diagnostics, and a **Danger zone** removal that names the affected workspaces and credentials. The list supports name and state filters.

## What one session receives

| Session | Gets MCP tools? |
| --- | --- |
| Workspace-root session, pair switched on | Yes — `mcp__<serverName>__<rawName>` |
| Server in on-demand mode | Only `mcp__<serverName>__load_tools` is in the tool list; a tool becomes visible in that agent's scope after the model loads it |
| Workspace-root session, pair switched off | No — the definitions are revoked from that agent's scope |
| Session whose cwd is outside every registered workspace | No |
| Delegation / subagent child | Inherits the parent's workspace (a `continuable` child is narrowed by its `toolFilter`) |

- **The tools are ordinary tool schemas on the request**: they appear in the composer's context meter under **Tool definitions** (the meter renders only after the model has reported usage); a server publishing `instructions` additionally contributes a literal `### MCP server: <name>` prompt section.
- **Names are normalized**: `mcp__<serverName>__<rawName>` is trimmed to ≤ 64 chars of `[A-Za-z0-9_-]`; when normalization is lossy a 12-hex SHA-256 identity suffix is appended so two distinct MCP tools can never collapse into one name; `tools/call` sends the raw MCP name.
- **Listing is bounded**: the official `listMaxPages` (64) owns pagination; the plugin caps one server's captured EAGER generation at 2000 tools — over the cap it trims and flags `truncated` (the sync is not refused, the seam canary is exempt for that generation, and on-demand mode is not forced through the cap). Calls time out after 60 s by default and are aborted with the run's signal.
- **On-demand mode**: the catalog text is rendered by the mounted official instance; it may name tools a subagent's `toolFilter` excludes (the eager fan-out is filtered and `admit()` refuses the load, but the catalog is upstream-formatted). The tool-list route answers `mode: 'catalog'` with the offered count only — no definitions.

## Where the configuration lives

The configuration *is* the plugin's own Loader-entry Config — one row in the profile's user patch, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mcp-scope
  name: dsh-chamber-mcp
  config:
    servers:                        # serverName is the identity
      - serverName: github
        transport: streamable-http  # or stdio: command/args/cwd/env
        url: https://mcp.example.com/x
        toolLoading: eager          # or on-demand (eager is the default)
        headers:
          Authorization: ${credential:GITHUB_TOKEN}   # a credential TEMPLATE; values live in the credentials domain
    overrides:                      # presence = that workspace is ON (default off)
      ws-2f1c:
        github: true
```

- **Server identity** is `serverName`; `overrides` values must be exactly `true`; cross-field uniqueness (duplicate servers / env keys / header names) is rejected by the editor before a write, while the schema owns shape and the naming contracts.
- **Connection/tool-loading fields:** a server row also carries `startupTimeoutMs`, `closeTimeoutMs`, `toolCallTimeoutMs` (legacy `timeoutMs` read-compat only) and `toolLoading: eager / on-demand`; an HTTP row carries an optional `oauth` block (`clientId`/`scope` optional, `credentialKey` normally derived by the plugin). `reconnect` is import pass-through (the schema stores it and the mounted official host resolves it at connect; the editor does not expose it). `maxInstructionBytes`, `catalogDescriptionMaxLength`, `failOnStartupError` and `expandTemplates` stay in the schema for hand-edited documents, but the editor import strips them with a warning — they are not import pass-through.
- **Credential values** live only in the credentials domain (default `$DSH_HOME/.credentials.yaml`); the settings document stores the `${credential:REF}` template string, which the mounted official instance resolves at connect and never persists the value of.
- A legacy `settings.yaml` `mcp-scope:` section is imported once by the loader at first boot (the file is renamed `settings.yaml.imported`) — that is the upstream loader's old-config migration, unrelated to this plugin's generation support.
- A hand edit that breaks the schema keeps the entry from activating at boot: the log names the error and the settings section reports unavailable (there is no in-place repair form).

## Compatibility

| | Version |
| --- | --- |
| Compile-time anchor / dev pin | dsh **0.2.3-alpha.2** (cordis **4.2.0-alpha.1**, `cordis-plugin-loader` **1.2.0-alpha.1**, schemastery **~3.20.0-alpha.1**) |
| Declared line (peer range) | `^0.2.3-alpha.2`; cordis `~4.2.0-alpha.1` (`dsh-mcp-client` is a required peer) |
| Live-verification anchor | that line only: `DSH_ANCHOR_CLI` / CI's `DSH_SMOKE_ANCHORS` must name a **0.2.3-alpha.2** CLI (one M0/M1 run per declared line) |

**A single-line support window.** The 0.2.6 line declares exactly **one** supported line, `^0.2.3-alpha.2`: compile anchor, dev pin, CI guard and the live smoke all name it. The previous multi-line window is closed — **0.2.5 is frozen as the last release of the old line** (0.2.0/0.2.1/0.2.2 are no longer declared, compiled or smoke-verified). The tree keeps no compatibility layer or shim for older generations: 0.2.3-alpha.2 removed the `ctx.root` property, so the three reads are written directly as `ctx[Context.root]` (no feature-detected fallback), and a host outside the peer range is denied before load by the runtime plugin-compatibility preflight — upgrade dsh first. Landed gate measured on 2026-11-23: `npm run check` green (37 spec files / 812 tests; coverage statements/lines 93.27 %, branches 87.27 %, functions 89.22 %; packed-artifact check included), `verify-generation 0.2.3-alpha.2` PASS (no `--pin` needed on the same generation), and the alpha.2 M0 live smoke PASS (install/boot, settings write → volatile commit → reconcile → connect, the route still listing the fixture tools after a restart; per-workspace gating is asserted by the real-mount seam spec and the applier suites, not by this headless smoke).

**`0.2.6-alpha.0` is the first prerelease of the 0.2.6 line and the architecture-A landing.** The connection layer retires into the official `McpClientHost` instance (one isolated seat fiber per configured server + four capture-only façades + applier-owned fan-out), on-demand tool loading and OAuth browser authorization are new, and the browser half gains the official `settings.section.icon` seat, the OAuth panel, the catalog hint and the "Load tools" transcript row. The full behaviour-change ledger and the deferred register: `docs/design.md` §5(g); the known limitations: `docs/acceptance.md`.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No *MCP servers* section in Settings | The post-install client-module scan raced — restart the instance once |
| Section present but reports settings unavailable | The host half did not load (the `mcp-scope` row in the profile patch) or the connection is read-only; check the row, then restart the profile |
| A tool never appears | Check, in order: the session's cwd is a **registered workspace**; the server is **on** for it; the server is connected and has listed tools (connection log line comes from the mounted official instance as `mcp-client(<server>):`; plugin-owned lines stay `mcp-scope(...)`) |
| A hand-edited patch had no effect | An invalid schema keeps the whole entry from activating (section unavailable + log names the error); edit through the UI, or fix the row |
| A server stopped working after a crash | The mounted official instance backs off 500 ms→30 s, 10 attempts per outage; after giving up, reload the plugin or restart the instance |
| A server shows "Name conflict" | The same `serverName` is also configured on the official manager plane: keep it in one plane. The plugin reports `failed{conflict}` and does not start |
| The authorization page does not open / the callback fails | The OAuth callback needs the browser to reach the host origin directly (HTTPS or loopback HTTP); a reverse proxy normally breaks it. Also check the composition mounts `authorization` + `webServer` — otherwise the action answers `oauth-unavailable` |
| Status stays on "Waiting for authorization" | Click Authorize and finish the browser flow; the grant-commit event refreshes the status, or Sign out and retry |
| "Cleanup pending" after a disconnect | The previous connection could not confirm its close: the server is blocked from remounting until the plugin or Host restarts (this is the cleanup guard, not a configuration error) |
| Secret input looks empty after saving | By design: values are write-only. The badge shows *Configured* / *Not configured* / *Status unknown* |
| Switch the plugin off without uninstalling | Compose a patch over the profile (`dsh web --patch <file>`) that sets `disabled: true` under `- id: mcp-scope` |

## Uninstall

```sh
dsh plugin --profile web remove dsh-chamber-mcp   # then restart the instance
```

Removing the package stops the servers and drops the settings section; the data remains in the profile patch row `- id: mcp-scope` (delete that row to remove it) and the related refs must be deleted from `$DSH_HOME/.credentials.yaml` by hand (values are write-only, so the UI cannot read them back). OAuth grants live in the same credentials domain (`mcp-client/` namespace) and must be deleted by hand too.

## Documentation

| Doc | Contents |
| --- | --- |
| [`../README.md`](../README.md) | The Chinese README (primary) |
| [`design.md`](design.md) | Architecture: host/browser halves, mounted-official-instance + per-workspace injection model, settings document, seat lifecycle, OAuth O2, wire vocabulary, behaviour-change ledger, UI layout reference |
| [`acceptance.md`](acceptance.md) | Requirement/cut matrix (R1–R4 / E1–E13 / C1–C6), the shipped line's known limitations and the 0.2.6-alpha.0 gate evidence |
| [`RELEASE.md`](RELEASE.md) | Release & CI runbook |

## License

[MIT](../LICENSE). Adopted from the reference implementation `@deepseek-ai/dsh-mcp-client` (Copyright © 2026 DeepSeek, MIT) are the capture-façade/applier glue, the `mcp__` tool-naming contract and the OAuth credential-key / sign-out semantics; transport and sync/generation-swap are owned by the mounted official instance and are no longer mirrored here. See `LICENSE` for the attribution notice.
