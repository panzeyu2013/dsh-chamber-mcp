# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repo conventions aligned with dsh-chamber norms (compliance audit,
  `docs/review/compliance.md`): workflow action-pin & release-structure
  verification (`npm run verify:workflows`), tag pushes run the same CI
  chain, serialized publication with a refuse-existing-release guard, dry-run
  dispatch mode, tgz `.sha256` sidecar, `packageManager` field, PR template,
  AGENTS.md, built-entry import probe in `verify:package`.

## [0.0.1] - 2026-09-06

First functional release of the third-party dsh plugin: MCP servers managed per
workspace from the dsh Settings UI, with tools injected into the tool scopes of
enabled workspaces only.

### Added

- **Release mechanics**: tag-driven GitHub Release shipping the packed
  `dsh-mcp-scope-<version>.tgz` as its asset, release notes composed from this
  changelog (`scripts/release-notes.mjs`); npm publishing temporarily disabled
  — `dsh plugin add <asset-url>` is the install path.
- **Package & installation**: one npm package (`dsh-mcp-scope`) as a dsh
  bundle + dual-face plugin — `dsh plugin --profile web add dsh-mcp-scope`
  (or `file:<tgz>`); single loader row `mcp-scope`; zh/en locales; MIT with
  upstream attribution.
- **Host half**: settings-namespace document (`mcp-scope`: `servers` +
  per-workspace `overrides`, default-on semantics, revision-fenced writes);
  per-server supervisors mirroring the official `dsh-mcp-client` contract
  (mcp__ naming with collision hash, generation-swap sync, `tools/list_changed`
  re-sync, scrubbed child env, backoff reconnect, 5 s close discipline);
  stdio and streamable-http transports; credential refs resolved per connect
  from the write-only credentials domain.
- **Per-workspace injection gate**: tools are registered per agent scope
  (never globally) for live agents whose session cwd belongs to an enabled
  workspace; new servers and workspaces default to on; delegation children
  (`origin: 'subagent'`) are excluded by design (preset-governed).
- **Browser half**: Settings "MCP 服务器 / MCP servers" section (nav order
  25): server cards with definition details and per-workspace on/off rows,
  staged add/edit forms with write-only secret rows, removal cascade for
  orphaned credentials and override rows, tri-state credential badges,
  workspace-list loading/error phases, role=alert/status outcome feedback.
- **Operational evidence**: hermetic unit/integration suite (real ToolRuntime +
  real dsh-scope contexts, real settings-file provider, real stdio MCP
  fixtures), CI workflows (Node 24 gate + package verification), live M0/M1
  smoke drivers incl. the remote-mux session activation that captures the
  assembled model tool list per workspace (R3 PASS).

### Changed

- Toolchain target moved to **Node ≥ 24** (engines, CI matrix, `.nvmrc`).
- Client entry inject surface aligned with the rc.1 runtime
  (`remote.credentials`); error classification is typed-code first; document
  writes are verified by read-back (a refused write is reported as a conflict,
  never as success).
- Host entry re-exports the public model types for typed consumers.

### Fixed

- Plugin teardown never stopped live supervisors (dispose deleted bookkeeping
  before stopping); teardown now stops and revokes everything.
- A restarted server's first sync could be absorbed by the old handle's
  idempotence key — dedupe now keys on (epoch, syncId).
- Reconcile performed a blanket re-registration on every settings change —
  now a diffed pass (no-op reconciles register nothing).
- Workspace membership was frozen at agent adoption — now re-derived per
  push/reconcile and on durable workspace-domain change events, so deleted
  workspaces/directories revoke promptly.
- A credential restart queued while the server was removed from the document
  could strand live tools — restarts judge presence live and revoke.
- Removing a server left orphaned per-workspace off-switch rows (re-add
  resurrected as off) — removal now prunes them.
- Refused saves could silently report success and orphan newly written
  secrets — landed-write verification + new-ref-only cleanup with a
  concurrent-writer guard.
- `__proto__`-style server names could break the off-switch semantics —
  reserved override keys are rejected everywhere.

### Security

- Header/env credential values containing CR/LF/NUL are rejected at the
  transport boundary (no header injection, no secret echo in logs); log sinks
  sanitize error text.
- HTTP header names and env-key elements are validated at schema, document
  and UI level (RFC 9110 field-name tokens).
- `tools/list` pagination is bounded (`MAX_SYNC_TOOLS = 2000`); a server
  exceeding the cap fails the sync while the previous generation stays.

<!--
Release notes are composed from the section of the released version, so each
release must add a dated section here before tagging (scripts/release-notes.mjs).
Once a public repository URL exists, append comparison links, e.g.:
[0.1.0]: https://github.com/<owner>/dsh-mcp-scope/compare/v0.0.0...v0.1.0
-->
