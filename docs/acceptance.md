# Acceptance matrix (from the locked scope)

Source: the locked MVP requirements (message #1). Each row: requirement → how we prove it (M0 smoke / unit / E2E) → evidence location.

## Must (MVP)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| R1 | Settings → server area → MCP section with server rows + add/edit/remove forms; management is UI-native (the settings document stays hand-editable by design) | jsdom render/flow tests of the real components + `scripts/verify-client-artifact.mjs` (the BUILT browser half driven in jsdom); a live in-GUI click-through is still open | docs/milestones/M1.md (gap), docs/ui-notes.md §6 |
| R2 | Default on: after add, effective in all of this dsh's workspaces | unit (evaluation fn) + E2E two workspaces | docs/milestones/M0.md |
| R3 | Explicit per-workspace off; when off, that workspace session's model-visible tool set excludes the server's tools (injection gate, not mere exec denial) | E2E: session tool listing per workspace (remote-mux capture) | docs/milestones/M1-live-capture.log, docs/milestones/M1.md |
| R4 | Distribution: ordinary third-party dsh plugin, user-installed per dsh; chamber not seeded, not bundled, zero code involvement | install test on scratch instance; chamber untouched | docs/milestones/M0.md |

## Cut (must NOT exist)

| # | Cut item | Guard |
|---|---|---|
| C1 | toolPolicy allow/ask/deny | not in config schema (test asserts schema shape) |
| C2 | custom naming | naming constant `mcp__<serverName>__<tool>` only |
| C3 | server-status visualization | out of scope (no server-status surface; a transcript tool row carries its own call state — running/settled/failed/interrupted — exactly like the shipped rows) |
| C4 | on-demand connect/reconnect | lifecycle follows host activation (official behavior) |
| C5 | server "pause" key | not in schema |
| C6 | CLI/command management surface (the settings document is hand-editable by design) | no CLI command added |

## Data model

- `servers: ServerDef[]`, `overrides: WorkspaceOverrides` = `Record<string, Record<string, true>>` — recorded = explicitly off; dict-of-dicts so a toggle is one atomic path op (same semantics as the plan's array shorthand).
- `enabled(w, s)` = the override row has no OWN property `s` (`Object.hasOwn`) — new server/workspace default-on, and prototype-member server names keep working.
- Round-2 (review) decisions recorded in docs/review/*: subagent/delegation children are not adopted (preset-governed), workspace membership is re-derived per push/reconcile, credentials values with CR/LF/NUL are rejected at the transport.
- Storage: dsh settings domain (plugin namespace) + credentials domain (write-only values); per-instance isolation via DSH_HOME.
