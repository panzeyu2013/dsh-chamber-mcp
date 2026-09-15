# dsh-chamber-mcp — docs index

Design, status, decisions and process for this repository. Start with the root
[`README.md`](../README.md) for what the plugin is and how to install and use
it.

| Doc | Contents |
|---|---|
| [`design.md`](design.md) | Architecture: host/browser halves, supervisor and injection model, settings document, runtime routes |
| [`acceptance.md`](acceptance.md) | Requirement/cut matrix: the locked scope, the extended 0.0.3 line (E1–E8) and the cut list |
| [`status.md`](status.md) | Current release/verification state, compatibility window, known limitations, re-verify commands |
| [`RELEASE.md`](RELEASE.md) | Release & CI runbook: pre-tag checklist, tag-driven publication, rollback |
| [`mcp-desktop-layout.md`](mcp-desktop-layout.md) (+ [`.svg`](mcp-desktop-layout.svg)) | Settings section/card/form layout reference |
| [`host-notes.md`](host-notes.md) | Host-half implementation notes: upstream API contracts relied on and deliberate deviations |
| [`ui-notes.md`](ui-notes.md) | Browser-half implementation notes: client contracts, style seat, transcript lane, runtime surface |

These pages describe the repository itself. Audits, reconnaissance reports and
milestone captures from earlier lines are deliberately not kept here; they
remain in git history.
