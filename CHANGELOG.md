# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Settings-page styling aligned with the dsh design system.** The MCP section
  no longer renders raw controls with inline styles and literal colours: it
  ships one token-only stylesheet (`src/client/styles.ts`, injected under the
  official `style[data-plugin-css]` convention) whose values mirror the pinned
  design system — `ui-primitives` Button/Tag/Pill/Switch geometry, the
  settings-panel card and editing-surface fills, the official field
  vocabulary — so the section reads as part of the panel in both themes
  (closes review finding FE-5; mapping table in `docs/ui-notes.md` §6).

### Fixed

- Credential pills, cards and the form no longer widen the settings column when
  a header name, credential ref or working directory is long: the pill shrinks
  and ellipsizes (with `title` fallbacks) and path-like copy wraps.
- Row-level validation now marks the offending input (error border +
  `aria-invalid`), not just the problem list under it.

## [0.0.2] - 2026-09-10

Upstream compatibility release: the plugin was migrated to the **dsh 0.1.5-rc.1**
generation (npm `latest`) and audited end-to-end against it — host half and
browser half — with no API adaptation required beyond the client type surface.

### Changed

- **Toolchain migrated to the dsh 0.1.5 line.** Every `@deepseek-ai/dsh-*`
  devDependency moves from `0.1.2-rc.1` to **`0.1.5-rc.2`** — deliberately the
  *resolved internal generation*, not the umbrella's own `0.1.5-rc.1`: a
  `dsh@0.1.5-rc.1` install resolves its internal caret ranges to `0.1.5-rc.2`
  (230 of 231 packages), and pinning the umbrella's literal version is
  internally inconsistent because upstream's own rc.1 peers pull rc.2
  artifacts. That set is now the compile-time API surface and the CI guard;
  rc.1 and rc.2 were both verified.
- **`--legacy-peer-deps` is gone.** With the whole `@deepseek-ai/*` devDep set
  on one generation the peer graph is self-consistent, so `npm install` and
  `npm ci` resolve unaided and CI dropped the flag. It had been needed first
  for the `dsh-client-runtime@0.1.1-rc.2` ↔ `dsh-agent` cross-line conflict and
  then for the rc.1-pin conflict above. This is the resolution
  `docs/review/compliance.md` §(e) asked for once the matrix settled on one
  line.
- **Client half re-pointed at the 0.1.5 client contracts.** `ClientContext`
  (`dsh-client-runtime`) → `Context` from `@deepseek-ai/cordis`, which is the
  client context type upstream client plugins use; the local `FiberAwareContext`
  structural patch for `ctx.effect` is gone (cordis declares it). The workspace
  list type moves from `WorkspaceListState` to `WorkspaceSnapshot`
  (`@deepseek-ai/dsh-api-workspace-controller/client`), and `ctx.slots` is now
  merged from `@deepseek-ai/dsh-client-ui-renderer/client` — the package that
  owns the slot registry in 0.1.5. `WorkspaceView` structurally satisfies the
  narrow row type, so a cast went away with it.
- **Three off-train devDependencies dropped.** `dsh-client-runtime`,
  `dsh-client-schema-form` and `dsh-client-web-react` stopped publishing at
  `0.1.1-rc.2` / `0.1.0-rc.7` and never had a 0.1.2 or 0.1.5 release; only the
  first was still referenced (for types, now replaced). Removing them deleted
  101 packages from the lockfile — almost entirely the unused
  `dsh-client-web-react` markdown/katex/shiki tree. `dsh-http-proxy` (a new
  0.1.5 peer of `dsh-subprocess`, imported by its `lib/index.js` at load) and
  `dsh-api-workspace-controller` were added.
- **`dsh.client.inject` completed.** The browser half calls `ctx.slots` and
  `ctx.workspaces`, so `dsh-client-ui-renderer` and `dsh-api-workspace-controller`
  are now named there alongside the three existing edges. In 0.1.2 both
  services came from the client runtime and had no row of their own; in 0.1.5
  each has an explicit client package, and upstream's own convention (e.g.
  `dsh-client-locale` injecting the four packages whose services it uses) is to
  name them.
- **Client bundle externals re-derived from the 0.1.5 frozen platform table**
  (`PLATFORM_MODULES`). The previous list named four packages that are not
  platform modules in 0.1.5 and were never imported; the list now mirrors the
  table verbatim, so an accidental import of a non-platform module fails the
  build instead of producing a bundle the loader cannot resolve.
- **Peer window widened** to `^0.1.2-rc.1 || ^0.1.5-rc.1` for the eight
  `@deepseek-ai/dsh-*` peers. The previous `^0.1.2-rc.1` cannot match the
  0.1.5 line: semver's prerelease rule only lets a prerelease version satisfy a
  comparator with the *same* `major.minor.patch`, so `0.1.5-rc.2` failed it and
  pnpm printed "Issues with peer dependencies found" on every install. The
  range is purely declarative — dsh profiles install with
  `autoInstallPeers: false` and resolve plugin peers by NAME from the dsh
  install's module-fallback farm (`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`),
  so nothing was broken by the old range; the install log now matches the
  documented support window.

### Fixed

- **`tools/list` pagination could spin forever.** A server repeating a
  `nextCursor` made the sync loop re-fetch the same page indefinitely, so the
  server never committed a tool generation. Every followed cursor is now
  recorded and a repeat rejects the sync as an invalid tool list (the previous
  generation stays registered), matching the guard the official
  `dsh-mcp-client` bridge added in the same upstream release.
- **A server could still stall the sync with unlimited FRESH cursors.** The
  duplicate-cursor guard does not bound pages that carry no tools while minting
  a new cursor each time: no name repeats and no tool accumulates, so neither
  the duplicate guard nor `MAX_SYNC_TOOLS` ever trips. One sync is now capped at
  `MAX_SYNC_PAGES` (= `MAX_SYNC_TOOLS`) `tools/list` requests. One page per tool
  is already pathological, so no legitimate server is restricted by this — the
  regression test without the cap exhausts the V8 heap.

### Security

- Pagination is now bounded in both dimensions: a repeated cursor and an
  unbounded page count each fail the sync. A hostile MCP server could
  previously hold a supervisor in an endless `tools/list` request loop with
  either trick, driving unbounded network work and memory growth.

### Compatibility

- Peer ranges stay `^0.1.2-rc.1 || ^0.1.5-rc.1`: the chamber anchor still runs
  0.1.2-rc.1, the surface this plugin calls is byte-identical or additively
  changed across the two generations, and the migrated build was live-verified
  on **both** (the 0.1.5 line and the 0.1.2-rc.1 anchor). CI now guards the
  0.1.5 set only.
- Verification for this release: `npm run check` PASS (typecheck, 138 tests,
  build, package verification) plus a live boot of the real 0.1.5-rc.1 CLI —
  per-workspace `mcp__<server>__*` injection captured from the model-facing tool
  list (R3 PASS), and the browser half fetched from `/plugins/`, evaluated under
  the frozen platform table, and driven through `apply()` against the real
  service contracts (dictionaries, settings scope, `settings.section`
  registration, both remote subscriptions all reached). Both checks were run
  again after the `dsh.client.inject` change, which alters the boot graph row.

## [0.0.1] - 2026-09-06

First functional release of `dsh-chamber-mcp`, a standalone third-party dsh
plugin: MCP servers managed per workspace from the dsh Settings UI, with tools
injected into the tool scopes of enabled workspaces only.

### Added

- **Repo conventions** (compliance audit `docs/review/compliance.md`,
  aligned with dsh-chamber norms): workflow action-pin & release-structure
  verification (`npm run verify:workflows`), tag pushes run the same CI
  chain, serialized publication with a refuse-existing-release guard,
  dry-run dispatch mode, tgz `.sha256` sidecar, PR template, AGENTS.md,
  built-entry import probe in `verify:package`. Dependabot is disabled by
  maintainer choice.
- **Release mechanics**: tag-driven GitHub Release shipping the packed
  `dsh-chamber-mcp-<version>.tgz` as its asset, release notes composed from this
  changelog (`scripts/release-notes.mjs`); npm publishing temporarily disabled
  — `dsh plugin add <asset-url>` is the install path.
- **Package & installation**: one npm package (`dsh-chamber-mcp`) as a dsh
  bundle + dual-face plugin — `dsh plugin --profile web add dsh-chamber-mcp`
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
[0.1.0]: https://github.com/<owner>/dsh-chamber-mcp/compare/v0.0.0...v0.1.0
-->
