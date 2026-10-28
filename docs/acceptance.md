# Acceptance matrix (locked scope + the extended line)

Source: the locked MVP requirements, extended on 2026-09-14 by the
runtime-visibility / configuration-completeness line (0.0.3); re-based on 0.1.0
by the default flip (**R2/R3**: MCP is OFF until a workspace enables the pair)
and the UI review that followed (E7). Each row:
requirement → how we prove it (smoke / unit / E2E) → evidence location.

## Must (MVP)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| R1 | Settings → MCP section with server rows + add/edit/remove forms; management is UI-native (the settings document stays hand-editable by design) | jsdom render/flow tests of the real components + `scripts/verify-client-artifact.mjs`; an unscripted real-session pass happened in the 0.1.0 UI review (the maintainer drove the panel in the desktop app), but a scripted click-through harness is still open | tests/client/section-render.spec.tsx, scripts/verify-client-artifact.mjs, docs/design.md §9 |
| R2 | **Default OFF (0.1.0, supersedes the original):** after add, the server is configured but effective NOWHERE until a workspace explicitly enables it | unit (evaluation fn) + E2E two workspaces | tests/host/agents.spec.ts, tests/host/model.spec.ts |
| R3 | Explicit per-workspace ENABLE; a workspace without the enable record has the server's tools excluded from its session's model-visible tool set (injection gate, not mere exec denial) | E2E: session tool listing per workspace (remote-mux capture) | `npm run test:smoke` — **re-run 2026-09-16 on the 0.1.0 tarball: `R3-live-capture: PASS`** on the chamber anchor (the enabled workspace's turn carries `mcp__fixture__echo` / `mcp__fixture__env_report`; the disabled one carries none), `not-captured` on the headless 0.1.6-alpha.1 and 0.1.7-rc.2 anchors (no turn starts without a UI surface claim; see §Known limitations), tests/host/agents.spec.ts |
| R4 | Distribution: ordinary third-party dsh plugin, user-installed per dsh; chamber not seeded, not bundled, zero code involvement | install test on scratch instance; chamber untouched | `npm run test:smoke` (M0) |

## Extended (0.0.3 — supersedes the original cuts C3–C5)

| # | Requirement | Proof method | Evidence |
|---|---|---|---|
| E1 | Global enable switch: `disabled: { [serverName]: true }` (own-property presence = off); a disabled server is not supervised, its tools are revoked everywhere, and re-enabling starts it fresh. ONE atomic path op per toggle; per-workspace toggles never touch the map. | shared-model unit tests + manager reconcile tests + controller regression tests + form/card render tests | tests/host/model.spec.ts, tests/host/manager.spec.ts, tests/client/controller.spec.ts, tests/client/section-render.spec.tsx |
| E2 | Per-server `timeoutMs` (1000–600000) applied to `tools/call` and one `tools/list` page; absent = official 60 s | shared-model validator tests + a bridge test asserting the configured value reaches both `client.request` call sites | tests/host/model.spec.ts, tests/tools.spec.ts, tests/host/server.spec.ts |
| E3 | Runtime status over the Connection carrier: `GET /api/mcp-scope.status` returns the versioned bounded view (phase, attempts, retry, timestamps, tool count, fixed host-generated error code+message — never remote text) for every document server | route envelope tests + supervisor snapshot tests + manager view tests incl. a raw-text-never-crosses assertion | tests/host/routes.spec.ts, tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E4 | Manual connect/disconnect: disconnect is a first-class `stopped` state that revokes tools and survives unrelated settings commits; Connect (or a definition change) clears the latch; reconnect-budget exhaustion reads `failed` | manager runtime-control tests + card render tests | tests/host/manager.spec.ts, tests/client/section-render.spec.tsx |
| E5 | Test connection: throwaway probe when down; read-only live report when connected (no second process/connection) | supervisor probe tests + manager read-only test | tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E6 | Tool identity on demand: `GET /api/mcp-scope.tools?server=NAME`, capped (200 entries, name 200 / description 500) with the true `total`, never schema bodies; unsynced/down → `not-connected` | route tests + supervisor tool-summary tests + pure `capToolList` bounds test | tests/host/routes.spec.ts, tests/host/server.spec.ts, tests/host/manager.spec.ts |
| E7 | Configuration completeness: draft enable switch + timeout, unsaved-changes guard on every dismissal path, clipboard paste (command / `.env` / header lines), single-server JSON import (tolerant JSONC read: brace-less section, comments, trailing commas, fences, wrapper keys, arrays), section name filter, the card's workspace block (a name filter past five workspaces, all-on/all-off batched into one mutation and scoped to the rows a filter leaves SHOWN, a row order frozen on open so a toggle never moves a row, and NO per-row state word — the switch is the state carrier) | pure parser tests, controller action tests, render/flow tests | tests/client/import.spec.ts, tests/client/controller.spec.ts, tests/client/section-render.spec.tsx |
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
  presence = OFF (it is a hard kill no workspace enable can override); flat so one
  toggle is one atomic path op.
- `overrides: WorkspaceOverrides` = `Record<string, Record<string, true>>` —
  recorded = explicitly ON; dict-of-dicts so a toggle is one atomic path op.
- Enablement is two predicates combined at the call sites (`src/agents.ts`,
  `src/manager.ts`, the client gate): `isEnabled(overrides, w, s)` (the override
  row HAS an OWN property `s`, `Object.hasOwn`) AND NOT
  `isServerDisabled(doc, s)`. The default is OFF — a new server, a new workspace
  and a fresh session register no tools until the pair is explicitly enabled —
  and prototype-member server names keep working.
- Decisions: subagent/delegation children ARE adopted — a child inherits its parent's
  cwd, so the same workspace enablement decides — and the narrowing a **continuable**
  child's delegator declared is mirrored per name from that child's OWN durable
  `subagent/descriptor` (`src/delegation.ts`; one-shot descriptors persist no filter
  and are logged, never guessed; a descriptor that cannot be folded fails open with a
  warning; both limits are recorded in `docs/design.md` §4);
  workspace membership is re-derived per push/reconcile;
  credential values with CR/LF/NUL are rejected at the transport.
- Storage: dsh settings domain (plugin namespace) + credentials domain
  (write-only values); per-instance isolation via DSH_HOME.

## Known limitations

- No SCRIPTED in-GUI `Settings → MCP servers` click-through exists. An
  unscripted real-session pass did happen during the 0.1.0 UI review (the panel
  was driven in the desktop app: workspace switches, the card-local filter, the
  notice row), and it is what filed the review findings that shipped in 0.1.0 —
  but the recorded evidence for the render paths remains the jsdom flows and the
  shipped-bundle preview harness.
- The 5 s close barrier is covered for UNATTACHED failures (the
  hung-handshake and missing-executable specs); the attached-failure close-event
  timing (~2 s on stdio) is measured out of band, not asserted by a test. The
  attached barrier's give-up branch itself is still not asserted (reaching it
  needs a transport that answers the handshake and then never reports a close).
  The legacy `toolResult` branch and the hand-rolled pagination guards are gone
  with the 1.x client, so they need no test at all.
- `M1`'s live R3 capture (the model-facing `tools[]` array) needs an anchor that
  actually starts a turn: on the 0.1.5-rc.2 chamber anchor the 0.1.0/0.1.1 runs
  recorded **`R3-live-capture: PASS`**, while the headless 0.1.6-alpha.1,
  0.1.7-rc.2, 0.2.0-rc.1 and 0.2.2-alpha.2 anchors (the last three re-run on
  2026-10-28) record `not-captured` — those instances never start a turn, so the mock LLM
  receives no chat request. The capture is transcript evidence
  either way: the driver reports the verdict without failing on it.
- **The 0.1.5/0.1.6 generation is unsupported as of 0.2.0.** The plugin's
  verbatim port of the official tool adapter (and its parity suite) was removed
  with that generation, and so was `npm run verify:low-generation`; the peer
  ranges are 0.1.7 and 0.2.0.
- **`npm run test:smoke` packs `lib/`, not `src/`.** Run `npm run build` (or
  the full `npm run check`) first, or the smoke silently exercises the PREVIOUS
  build — a stale `lib/tools.js` once kept the static adapter import and
  reproduced the fatal 0.1.5 failure after the fix had landed in `src/`.
- Delegation children (`origin: 'subagent'`) ARE adopted: a child inherits its
  parent's cwd, so the workspace's own enablement decides, and the narrowing its
  delegator declared — the durable `subagent/descriptor` a continuable child carries
  (`toolFilter: {allow?, deny?}`) — is mirrored per name, so a server whose names are
  all filtered out publishes neither tools nor its context. A descriptor that cannot
  be folded (newer version, malformed payload, a generation without the read API)
  fails open with a warning: the workspace enablement stays the gate.
- Delegation inheritance is covered by unit tests (`tests/delegation.spec.ts`, the
  `allow`/`deny` math) and integration tests over a REAL ToolRuntime + real dsh-scope
  agent scopes (`tests/host/agents.spec.ts`: adoption through the listener and the boot
  scan, per-name mirroring, whole-server withholding INCLUDING its context, fail-open on
  unreadable/malformed descriptors, and a seeded fork whose inherited prefix carries a
  parent's descriptor). The live smoke (`npm run test:smoke`) exercises the root-session
  lifecycle; it does not delegate, because the driver's mock LLM answers with fixed text —
  scripting a `subagent` tool call and asserting the child's `request/header` tool array
  is the open end-to-end item.
- Under a `ptc` agent preset the request header lists only `run_code`; the
  registered-tools notice still reports the set, because it also reads the names
  the rendered system prompt declares. A request whose system prompt page left
  the bounded window AND whose header carries no MCP names shows no notice
  (MCP names still render per call through the tool-row lane; see
  `docs/design.md` §5(f)).
- With MCP off by default, a session with no enabled (workspace, server) pair
  registers no tools and the registered-tools notice renders no row at all; the
  settings section is the only surface that reports why. A transcript-side
  "MCP is off" hint is deliberately not shipped yet (the notice cannot always
  distinguish "off" from "this window lost the page that names the tools").
- The notice only reports names a CONFIGURED server owns, and it reads the
  settings document once per assembled request header: while that document is
  still loading (the store reports an empty list), the header renders no row and
  the engine does not re-evaluate that Context when the document arrives — the
  next request assembles a new Context and emits it, so the gap lasts at most one
  request.
