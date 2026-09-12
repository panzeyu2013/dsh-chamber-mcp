# dsh-chamber-mcp — docs index

> **Reading conventions.** Evidence pages (`recon/`, `review/`, `milestones/`,
> `host-notes.md`, `ui-notes.md`) are **point-in-time** records: test counts,
> file paths, package names and line numbers inside them are as-of their own
> date. The package was named `dsh-mcp-scope` until the v0.0.2 rename. Current
> disposition of every audit finding lives in **`review/STATUS.md`**.
> Several evidence pages name absolute paths of the authoring machine (e.g.
> `/root/...` checkouts, the chamber anchor, `.smoke/` scratch dirs); those are
> historical pointers, not contents of this repository.

| Doc | Purpose |
|---|---|
| design.md | Locked architecture & decisions (namespace document, host gate, UI) |
| acceptance.md | Requirement/cut matrix from the scope lock |
| recon/ | Six evidence reports (official mcp-client, distribution, core APIs, UI contracts, chamber bridge, runtime test env) — framed as of reconnaissance time |
| milestones/M0.md | M0 smoke evidence log (install, inventory, ns R/W + revision, credentials) |
| milestones/M1.md | M1 usable-build evidence + gap status |
| milestones/M0-plan.md | How the smoke evidence is produced (scripts/smoke) |
| milestones/M0-raw.log, M1-raw.log | Raw driver transcripts (`M0-raw.log` is the pre-rename v0.0.1 run) |
| milestones/M1-live-capture.log | Raw live R3 tool-capture transcript (launch tokens masked) |
| host-notes.md | Host-half API findings & deviations (written during implementation) |
| ui-notes.md | Client-half API findings & deviations (written during implementation) |
| review/ | Audits: round 1 + `review/round2/` + `review/prerelease/` + `review/deploy-issue/`, the round-1/2 `SUMMARY.md` matrix, and **`review/STATUS.md`** (consolidated disposition at HEAD) |
| RELEASE.md | CI + release mechanics: workflows, tag flow, smoke runner, rollback |
