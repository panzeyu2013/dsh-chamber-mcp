# dsh-chamber-mcp — docs index

Start with the root [`README.md`](../README.md) for what the plugin is, how to
install and use it, and the exact injection semantics. The pages here are the
engineering record behind it.

> **Reading conventions.** Evidence pages ([`recon/`](recon/),
> [`review/`](review/), [`milestones/`](milestones/),
> [`host-notes.md`](host-notes.md), [`ui-notes.md`](ui-notes.md)) are
> **point-in-time** records: test counts, file paths, package names and line
> numbers inside them are as-of their own date. The package was named
> `dsh-mcp-scope` until the v0.0.2 rename. Current disposition of every audit
> finding lives in **[`review/STATUS.md`](review/STATUS.md)** — read that
> before treating any older page as a live punch list. Several evidence pages
> name absolute paths of the authoring machine (e.g. `/root/...` checkouts, the
> chamber anchor, `.smoke/` scratch dirs); those are historical pointers, not
> contents of this repository.

## Design & scope

| Doc | Contents |
|---|---|
| [`design.md`](design.md) | Locked architecture & decisions (namespace document, host gate, UI, build/test tooling) |
| [`acceptance.md`](acceptance.md) | Requirement/cut matrix from the scope lock (R1–R4, C1–C6) and the data model |
| [`RELEASE.md`](RELEASE.md) | CI + release mechanics: workflows, tag flow, smoke runner, upstream-audit recipe, rollback |

## Implementation findings

| Doc | Contents |
|---|---|
| [`host-notes.md`](host-notes.md) | Host-half API findings & intentional deviations (written during implementation) |
| [`ui-notes.md`](ui-notes.md) | Client-half API findings & deviations, incl. the design-system mapping (§6) and the transcript lane: keyed MCP tool rows, discovery, declaration choices (§7) |

## Evidence

| Doc | Contents |
|---|---|
| [`recon/`](recon/) | Six reconnaissance reports — official mcp-client contract, plugin distribution, core APIs, UI contracts, chamber bridge, runtime test env — framed as of reconnaissance time |
| [`milestones/M0.md`](milestones/M0.md) | M0 smoke evidence log (install, inventory, namespace R/W + revision, credentials) |
| [`milestones/M0-plan.md`](milestones/M0-plan.md) | How the smoke evidence is produced (`scripts/smoke/`) |
| [`milestones/M1.md`](milestones/M1.md) | M1 usable-build evidence + gap status |
| [`milestones/M0-raw.log`](milestones/M0-raw.log), [`M1-raw.log`](milestones/M1-raw.log) | Raw driver transcripts (`M0-raw.log` is the pre-rename v0.0.1 run) |
| [`milestones/M1-live-capture.log`](milestones/M1-live-capture.log) | Raw live R3 tool-capture transcript (launch tokens masked) |

## Audits

| Doc | Contents |
|---|---|
| [`review/STATUS.md`](review/STATUS.md) | **Consolidated disposition of every audit finding at HEAD** — the only live page in this set |
| [`review/SUMMARY.md`](review/SUMMARY.md) | Round-1/round-2 finding matrix |
| [`review/`](review/) round-1 files | Round-1 audits: the six-axis review (architecture, implementation, interaction, frontend, performance, security) plus the separate conventions/compliance audit |
| [`review/round2/`](review/round2/) | Round-2 follow-up audits and fix verification |
| [`review/prerelease/`](review/prerelease/) | Pre-release blockers, client UX, docs hygiene, release mechanics |
| [`review/deploy-issue/`](review/deploy-issue/) | Install-diagnosis reports, version contract, local-mount evidence |

Repository conventions and invariants for contributors live in
[`AGENTS.md`](../AGENTS.md); release notes live in
[`CHANGELOG.md`](../CHANGELOG.md).
