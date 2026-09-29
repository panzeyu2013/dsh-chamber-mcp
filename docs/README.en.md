# dsh-chamber-mcp

[![CI](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/panzeyu2013/dsh-chamber-mcp?display_name=tag)](https://github.com/panzeyu2013/dsh-chamber-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

[简体中文](../README.md) ｜ **English**

> **MCP servers, per workspace, managed from the dsh Settings UI.**
> Declare a server once (stdio or Streamable HTTP), then use a switch to decide **which workspaces** may see its tools. By default: none of them.

A standalone third-party [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin, installed as an ordinary `dsh plugin` — dsh-chamber neither seeds, bundles nor special-cases it.

## Why it exists

dsh ships `@deepseek-ai/dsh-mcp-client`, which **bridges** MCP into the model but does not *manage* it:

- one server = one line in the patch config; adding, editing or removing one means hand-editing `cordis.patch.yml`;
- secrets are written as literals (or `!!js process.env.X`) in that same file;
- tools register in whatever context composes the row — host-level rows land in the **global layer**, so **every** session carries every MCP tool: context cost plus misfire risk.

Upstream has no management surface to reuse either: *Settings → Plugins → Plugin configuration* renders a form only for an entry whose Config exposes editable fields (the official MCP client exposes none), the plugin list is read-only, and `dsh-workspace` is a project-grouping registry that registers no tools — **nothing upstream maps a workspace to a set of tools**.

This plugin supplies exactly those two missing pieces: the **management surface** (Settings UI) and the **scope** (a per-workspace injection gate).

## Core advantages

| Advantage | What it means |
| --- | --- |
| **Settings-native management** | Add, edit and remove servers in *Settings → MCP servers*, never touching `cordis.patch.yml`. UI writes commit into the **running** plugin and only cycle the affected servers — no instance restart |
| **Per-workspace injection, off by default** | A new server is off for **every** workspace; a new workspace or a fresh session never silently gains MCP tools. Switching a workspace off **revokes** `mcp__<serverName>__*` from that workspace's tool list — a model-visible change, not just an execution-time block |
| **Credential refs, not secrets** | The settings document stores ref names only; values live in the dsh credentials domain, are **write-only**, and never ride a settings document, an API response or a log line |
| **An MCP-specific transcript row** | A call renders as an MCP row registered through the keyed `tool.call.toolview` slot: plug mark, `server · tool` title, transport tag, running/settled/failed/interrupted states, expandable arguments and result — not the shipped generic card |
| **Official bridge contract** | Naming `mcp__<serverName>__<tool>`, result and image mapping, child-env scrubbing, `tools/list_changed` generation swap and the 500 ms→30 s backoff reconnect all mirror the official client; MCP **resources** are reachable through the official `mcpResources` provider |
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

1. Open *Settings → MCP servers* → **Add server**. Two transports: **stdio** (name, command, arguments, optional working directory, env-key rows) and **Streamable HTTP** (URL and header rows). Clipboard pastes (a full command line, `.env` lines, header lines) and single-server JSON import are accepted.
2. A new server is **off in every workspace**. **Manage workspaces (N on)** expands every workspace so you can switch them on one by one — that switch *is* what "this (server × workspace) pair is on" means; with more than one workspace there is also **All on / All off**. The switch beside the server name is the **global** enable: a disabled server is not started and exposes no tools anywhere, while its configuration stays on disk.
3. Each card carries its live status (connected / connecting / reconnecting / failed / stopped / disabled / unknown), **Connect** / **Disconnect** / **Test**, and **Tools (N)** (the synced tool names); **Edit** reopens the form, **Remove** stops the server everywhere and clears credential refs nothing else references. The section header has a name filter and **Refresh status**.

## What one session receives

| Session | Gets MCP tools? |
| --- | --- |
| Workspace-root session, pair switched on | Yes — `mcp__<serverName>__<rawName>` |
| Workspace-root session, pair switched off | No — the definitions are revoked from that agent's scope |
| Session whose cwd is outside every registered workspace | No |
| Delegation / subagent child | Inherits the parent's workspace (a `continuable` child is narrowed by its `toolFilter`) |

- **The tools are ordinary tool schemas on the request**: they appear in the composer's context meter under **Tool definitions** (the meter renders only after the model has reported usage); a server publishing `instructions` additionally contributes a literal `### MCP server: <name>` prompt section.
- **Names are normalized**: `mcp__<serverName>__<rawName>` is trimmed to ≤ 64 chars of `[A-Za-z0-9_-]`; when normalization is lossy a 12-hex SHA-256 identity suffix is appended so two distinct MCP tools can never collapse into one name; `tools/call` sends the raw MCP name.
- **Listing is bounded**: the official `listMaxPages` (64) plus a 2000-tool cap per server; a non-converging or over-cap listing fails the sync and keeps the previous tool generation; calls time out after 60 s and are aborted with the run's signal.

## Where the configuration lives

The configuration *is* the plugin's own Loader-entry Config — one row in the profile's user patch, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mcp-scope
  name: dsh-chamber-mcp
  config:
    servers:                        # serverName is the identity
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

- **Server identity** is `serverName`; `overrides` values must be exactly `true`; cross-field uniqueness (duplicate servers / env keys / header names) is rejected by the editor before a write, while the schema owns shape and the naming contracts.
- **Credential values** live only in the credentials domain (default `$DSH_HOME/.credentials.yaml`).
- **Upgrading from the 0.1.5/0.1.6 generation**: the first boot imports the old `settings.yaml` `mcp-scope:` section once and renames the file `settings.yaml.imported`.
- A hand edit that breaks the schema keeps the entry from activating at boot: the log names the error and the settings section reports unavailable (there is no in-place repair form).

## Compatibility

| | Version |
| --- | --- |
| Compile-time anchor / CI guard | dsh **0.2.0-rc.1** |
| Live-verified | dsh **0.2.0-rc.1** and **0.1.7-rc.2** |
| Peer range | `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` |

The 0.1.7 line stays supported while the 0.2.0 line is still a release candidate; both own the Config/volatile settings model and the official `createMcpToolDefinition` adapter this plugin consumes.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No *MCP servers* section in Settings | The post-install client-module scan raced — restart the instance once |
| Section present but reports settings unavailable | The host half did not load (the `mcp-scope` row in the profile patch) or the connection is read-only; check the row, then restart the profile |
| A tool never appears | Check, in order: the session's cwd is a **registered workspace**; the server is **on** for it; the server is connected and has listed tools (log line `mcp-scope(...)`) |
| A hand-edited patch had no effect | An invalid schema keeps the whole entry from activating (section unavailable + log names the error); edit through the UI, or fix the row |
| A server stopped working after a crash | Reconnect backs off 500 ms→30 s, 10 attempts per outage; after giving up, reload the plugin or restart the instance |
| Secret input looks empty after saving | By design: values are write-only. The badge shows *Configured* / *Not configured* / *Status unknown* |
| Switch the plugin off without uninstalling | Compose a patch over the profile (`dsh web --patch <file>`) that sets `disabled: true` under `- id: mcp-scope` |

## Uninstall

```sh
dsh plugin --profile web remove dsh-chamber-mcp   # then restart the instance
```

Removing the package stops the servers and drops the settings section; the data remains in the profile patch row `- id: mcp-scope` (delete that row to remove it) and the related refs must be deleted from `$DSH_HOME/.credentials.yaml` by hand (values are write-only, so the UI cannot read them back).

## Documentation

| Doc | Contents |
| --- | --- |
| [`../README.md`](../README.md) | The Chinese README (primary) |
| [`design.md`](design.md) | Architecture: host/browser halves, supervisor and injection model, settings document, upstream contracts and deliberate deviations, UI layout reference |
| [`acceptance.md`](acceptance.md) | Requirement/cut matrix (R1–R4 / E1–E8 / C1–C6) |
| [`status.md`](status.md) | Current release/verification state and known limitations |
| [`RELEASE.md`](RELEASE.md) | Release & CI runbook |

## License

[MIT](../LICENSE). Tool naming, sync/generation swap, executor and transport semantics mirror the reference implementation `@deepseek-ai/dsh-mcp-client` (Copyright © 2026 DeepSeek, MIT); see `LICENSE` for the attribution notice.
