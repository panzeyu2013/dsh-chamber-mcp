# Acceptance matrix (from the locked scope)

Source: the locked MVP requirements (message #1). Each row: requirement → how we prove it (M0 smoke / unit / E2E) → evidence location.

## Must (MVP)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| R1 | Settings → server area → MCP section with server rows + add/remove form; no file-level switches | live instance E2E + screenshots/API | docs/milestones/M1.md |
| R2 | Default on: after add, effective in all of this dsh's workspaces | unit (evaluation fn) + E2E two workspaces | docs/milestones/M0.md |
| R3 | Explicit per-workspace off; when off, that workspace session's model-visible tool set excludes the server's tools (injection gate, not mere exec denial) | E2E: session tool listing per workspace | docs/milestones/M0.md |
| R4 | Distribution: ordinary third-party dsh plugin, user-installed per dsh; chamber not seeded, not bundled, zero code involvement | install test on scratch instance; chamber untouched | docs/milestones/M0.md |

## Cut (must NOT exist)

| # | Cut item | Guard |
|---|---|---|
| C1 | toolPolicy allow/ask/deny | not in config schema (test asserts schema shape) |
| C2 | custom naming | naming constant `mcp__<serverName>__<tool>` only |
| C3 | status visualization | out of scope; single read-only line at most in M2 |
| C4 | on-demand connect/reconnect | lifecycle follows host activation (official behavior) |
| C5 | server "pause" key | not in schema |
| C6 | config-file/CLI management surface | no CLI command added |

## Data model

- `servers: ServerDef[]`, `overrides: Record<WorkspaceId, ServerId[]>` (recorded = explicitly off), `revision`.
- `enabled(w, s) = !overrides[w]?.includes(s.id)` — new server/workspace default-on.
- Storage: dsh settings domain (plugin namespace) + credentials domain (write-only values); per-instance isolation via DSH_HOME.
