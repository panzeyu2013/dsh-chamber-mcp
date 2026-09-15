# Acceptance matrix (locked scope + the extended 0.0.3 line)

Source: the locked MVP requirements (message #1), extended on 2026-09-14 by the
runtime-visibility / configuration-completeness line (0.0.3). Each row:
requirement → how we prove it (smoke / unit / E2E) → evidence location.

## Must (MVP)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| R1 | Settings → MCP section with server rows + add/edit/remove forms; management is UI-native (the settings document stays hand-editable by design) | jsdom render/flow tests of the real components + `scripts/verify-client-artifact.mjs`; a live in-GUI click-through is still open | docs/milestones/M1.md (gap), docs/ui-notes.md §6 |
| R2 | Default on: after add, effective in all of this dsh's workspaces | unit (evaluation fn) + E2E two workspaces | docs/milestones/M0.md |
| R3 | Explicit per-workspace off; when off, that workspace session's model-visible tool set excludes the server's tools (injection gate, not mere exec denial) | E2E: session tool listing per workspace (remote-mux capture) | docs/milestones/M1-live-capture.log, docs/milestones/M1.md |
| R4 | Distribution: ordinary third-party dsh plugin, user-installed per dsh; chamber not seeded, not bundled, zero code involvement | install test on scratch instance; chamber untouched | docs/milestones/M0.md |

## Extended (0.0.3 — supersedes the original cuts C3–C5)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| E1 | Global enable switch: `disabled: { [serverName]: true }` (own-property presence = off); a disabled server is not supervised, its tools are revoked everywhere, and re-enabling starts it fresh. ONE atomic path op per toggle; per-workspace toggles never touch the map. | shared-model unit tests + manager reconcile tests + controller regression tests + form/card render tests | tests/host/model.spec.ts, tests/host/manager.spec.ts, tests/client/controller.spec.ts, tests/client/section-render.spec.tsx |
| E2 | Per-server `timeoutMs` (1000–600000) applied to `tools/call` and one `tools/list` page; absent = official 60 s | shared-model validator tests + a bridge test asserting the configured value reaches both `client.request` call sites | tests/host/model.spec.ts, tests/tools.spec.ts, tests/host/server.spec.ts |
| E3 | Runtime status over the Connection carrier: `GET /api/mcp-scope.status` returns the versioned bounded view (phase, attempts, retry, timestamps, tool count, fixed host-generated error code+message — never remote text) for every document server | route envelope tests + supervisor snapshot tests + manager view tests incl. a raw-text-never-crosses assertion | tests/host/routes.spec.ts, tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E4 | Manual connect/disconnect: disconnect is a first-class `stopped` state that revokes tools and survives unrelated settings commits; Connect (or a definition change) clears the latch; reconnect-budget exhaustion reads `failed` | manager runtime-control tests + card render tests | tests/host/manager.spec.ts, tests/client/section-render.spec.tsx |
| E5 | Test connection: throwaway probe when down; read-only live report when connected (no second process/connection) | supervisor probe tests + manager read-only test | tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E6 | Tool identity on demand: `GET /api/mcp-scope.tools?server=NAME`, capped (200 entries, name 200 / description 500) with the true `total`, never schema bodies; unsynced/down → `not-connected` | route tests + supervisor tool-summary tests + pure `capToolList` bounds test | tests/host/routes.spec.ts, tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E7 | Configuration completeness: draft enable switch + timeout, unsaved-changes guard on every dismissal path, clipboard paste (command / `.env` / header lines), single-server JSON import, section name filter, card all-on/all-off workspace switches batched into one mutation | pure parser tests, controller action tests, render/flow tests | tests/client/import.spec.ts, tests/client/controller.spec.ts, tests/client/section-render.spec.tsx |
| E8 | Runtime status never breaks the document UI: a missing route, failed fetch or malformed envelope degrades to `unavailable`/`error` | runtime store tests + card degradation test | tests/client/runtime.spec.ts, tests/client/section-render.spec.tsx |

## Cut (must NOT exist)

| # | Cut item | Guard |
|---|---|---|
| C1 | toolPolicy allow/ask/deny | not in config schema (test asserts schema shape) |
| C2 | custom naming | naming constant `mcp__<serverName>__<tool>` only |
| C3 | ~~server-status visualization~~ | **superseded by E1/E3** (0.0.3) |
| C4 | ~~on-demand connect/reconnect~~ | **superseded by E4** (0.0.3) |
| C5 | ~~server pause key~~ | **superseded by E1** (0.0.3) |
| C6 | CLI/command management surface (the settings document is hand-editable by design) | no CLI command added |

## Data model

- `servers: ServerDef[]` — stable identity `serverName`; optional `timeoutMs`.
- `disabled: Record<string, true>` — sparse global off-switch, OWN-property
  presence = off; flat so one toggle is one atomic path op.
- `overrides: WorkspaceOverrides` = `Record<string, Record<string, true>>` —
  recorded = explicitly off; dict-of-dicts so a toggle is one atomic path op.
- `enabled(w, s)` = not globally disabled AND the override row has no OWN
  property `s` (`Object.hasOwn`) — new server/workspace default-on, and
  prototype-member server names keep working.
- Round-2 (review) decisions recorded in docs/review/*: subagent/delegation
  children are not adopted (preset-governed), workspace membership is re-derived
  per push/reconcile, credentials values with CR/LF/NUL are rejected at the
  transport.
- Storage: dsh settings domain (plugin namespace) + credentials domain
  (write-only values); per-instance isolation via DSH_HOME.
