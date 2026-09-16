# Status — dsh-chamber-mcp

Current release, compatibility and verification state. Refreshed 2026-09-15.

## Release state

- **Published release: `v0.0.3`** — tag `v0.0.3` on `main` (`bf344ef`), GitHub
  Release published 2026-09-15 with `dsh-chamber-mcp-0.0.3.tgz` + `.sha256`;
  notes composed from the dated CHANGELOG section. `v0.0.2` and `v0.0.1` are
  the previous releases.
- **Working line: the unreleased 0.0.4 line.** `main` carries the next-version
  changeset on top of the `v0.0.3` commit (`bf344ef`): workspace exception
  panel, per-server runtime refresh, `ptc` tool-row discovery, import-parser
  hardening, the injected-tools conversation notice (derived from
  `request/header`, never written into a session), the host/gate fixes below,
  and the wireframe/design-document re-alignment with the official
  `IconChevronDownOutline14` geometry in the tool row, plus the
  **0.1.6-alpha.1 / `@modelcontextprotocol/client@2.0.0` generation migration**
  (two generations on one code path: the official adapter on 0.1.6+, the plugin's
  own text projection on 0.1.5 — see CHANGELOG §Changed). No version bump yet.
- Releases ship the packed tgz as a GitHub Release asset; **npm publishing is
  temporarily disabled**. Flow and rollback: `docs/RELEASE.md`. Confirm what is
  actually published with `git ls-remote --tags origin` / `gh release view`.
- Tagging, pushing and publishing are maintainer actions.

## Compatibility

- Node ≥ 24; a dsh instance of a supported generation.
- The `@deepseek-ai/dsh-*` devDependencies pin one resolved generation — the
  compile-time API surface and the CI guard (**`0.1.6-alpha.1`** on this line).
  The peers declare the generations this plugin was VERIFIED against:
  **`^0.1.5-rc.2 || ^0.1.6-alpha.1`** (0.1.5-rc.1 is not claimed: only rc.2 was
  ever run). The `0.1.2` generation is no longer claimed either — this line
  re-verified only these two.
- The two generations differ in what the host provides, and the plugin selects at
  runtime: 0.1.6+ supplies `createMcpToolDefinition` (official canonical
  validation + durable image admission), `ctx.mcpResources` and literal
  system-prompt sections; 0.1.5 runs this plugin's verbatim port of that adapter
  — same projection, validation, admission and `finalizeContent` hook, held to
  the adapter's exact output by a parity suite — but has no shared resource tools
  and publishes no prompt section (that host interpolates every section, so server
  prose containing `{{...}}` could abort a turn). That selection is a NAMESPACE lookup — a static named import of the
  0.1.6-only export fails the whole cordis plugin tree on an older host
  (measured; the dsh instance exited 1).
- The client half speaks **`@modelcontextprotocol/client@2.0.0`** on BOTH
  generations (it is this plugin's own dependency, not a host surface);
  `@modelcontextprotocol/sdk` (1.x) is no longer a dependency at all.
- The live smoke installs *and* boots through a chamber-compatible anchor CLI,
  reading its `dsh` version at run time and recording it in the transcript; the
  anchor must sit inside the peer range above.
- Internal settings namespace / loader row id: `mcp-scope`.

## Verification state

- **0.0.3 (published):** `npm run check` PASS — `tsc` ×2, 250 tests / 17 files,
  build, `verify:package` (40 packed entries), and live smoke `npm run test:smoke`
  (`M1` + `M0`) exit 0 against the anchor CLI with `dsh-chamber-mcp@0.0.3`
  installed. The M1 capture records R3: the enabled workspace's model-facing turn
  carries `mcp__fixture__echo` / `mcp__fixture__env_report`, the disabled
  workspace's turn carries none (transcript evidence — the driver reports the
  verdict but does not fail on it).
- **0.0.4 line (working tree):** `npm run check` PASS — `tsc` ×2,
  **449 tests / 25 files**, build, `verify:package` (44 packed entries; consumer
  d.ts; react-only client-bundle purity; the packed-bundle artifact check, which
  also drives the injected-tools notice lane; lockfile-vs-manifest surface and
  integrity coverage; determinism over the whole built tree), plus
  `npm run verify:workflows` PASS. Live smoke runs on **BOTH** generations, each
  installing this working tree's packed tarball:
  - `dsh@0.1.6-alpha.1` (installed separately, pointed at through
    `DSH_ANCHOR_CLI`): `npm run test:smoke` (`M1` + `M0`) exit 0 — the plugin
    row activates (`fiberPhase: active`), the settings namespace describes and
    mutates, credentials never ride the wire, the fixture child receives the
    resolved env key, `/api/mcp-scope.tools` reports the listed tools (so the
    connect + `tools/list` + commit path is asserted, not inferred), and
    workspace override flips land on live sessions. `M1` records
    `R3-live-capture: not-captured` — a headless instance does not start a turn,
    so the model-facing tools array is not re-verified live (the driver reports
    that verdict without failing on it).
  - `dsh@0.1.5-rc.2` — **the chamber app's own anchor** (`vendor/dsh`): `M0`
    exits 0 with the same lifecycle evidence (including the `/api/mcp-scope.tools`
    listing assertion), which is the two-generation claim actually exercised: the
    namespace lookup misses `createMcpToolDefinition` and the plugin runs on its
    local text projection. Before the fallback landed this same run failed with
    `plugin tree failed to load ... does not provide an export named
    'createMcpToolDefinition'` and the instance exited 1.
  - The newest line — the connect handshake bounded by the server's own
    `timeoutMs` (the aggregated `tools/list` keeps that deadline), the failure
    reason retained across retry attempts, the attached/unattached close
    discipline (including a generation that disposal superseded mid-connect), the
    prompt section gated on the host's allocation key, the instruction
    retraction on give-up, the `mcpResources` provider with real resource
    round-trips, the runtime definition-builder selection (and its one-time
    notice when the host lacks the official adapter), the fallback's case-by-case
    parity with the adapter (projection strings, empty-value semantics, image
    diagnostics, `finalizeContent` guards), and the section header's global
    refresh button removed — is covered by that count. The low-generation path
    itself has its own executable check, `npm run verify:low-generation` (see
    below), because the vitest suite is pinned to the newer generation.
- Transcripts are written under `.smoke/logs/` (gitignored) and are not
  committed. `M0-raw.log`/`M1-raw.log` hold the last run; the two-anchor evidence
  is kept side by side as `M0-anchor-0.1.5-raw.log`, `M0-anchor-0.1.6-raw.log`
  and `M1-anchor-0.1.6-raw.log` — each records the anchor CLI and its version, the
  plugin row's `fiberPhase`, and the `/api/mcp-scope.tools` listing
  (`listed 2 tools: mcp__fixture__echo, mcp__fixture__env_report`).

## Known limitations

- No in-GUI `Settings → MCP servers` click-through has been performed in a real
  desktop session; the jsdom flows and the shipped-bundle preview harness cover
  the render paths.
- The 5 s close barrier is covered for UNATTACHED failures (the
  hung-handshake and missing-executable specs); the attached-failure close-event
  timing (~2 s on stdio) is measured out of band, not asserted by a test. The
  attached barrier's give-up branch itself is still not asserted (reaching it
  needs a transport that answers the handshake and then never reports a close).
  The legacy `toolResult` branch and the hand-rolled pagination guards are gone
  with the 1.x client, so they need no test at all.
- `M1`'s live R3 capture (the model-facing `tools[]` array) is
  `not-captured` in a headless run — a cold instance never starts a turn, so the
  mock LLM receives no chat request. R3 stays transcript-evidence-only.
- **On 0.1.5 two host surfaces are simply absent, and the plugin degrades
  explicitly**: the shared `list_mcp_resources` family does not exist there, and
  no `mcp:<server>` prompt section is published (that host always interpolates
  section text, so server prose containing `{{...}}` could abort a turn or be
  substituted with a host variable). Everything else — tool projection and
  failures, canonical values, and durable image admission — behaves exactly like
  the official adapter on both generations.
- **`npm run test:smoke` packs `lib/`, not `src/`.** Run `npm run build` (or
  the full `npm run check`) first, or the smoke silently exercises the PREVIOUS
  build — a stale `lib/tools.js` once kept the static adapter import and
  reproduced the fatal 0.1.5 failure after the fix had landed in `src/`.
- Delegation children (`origin: 'subagent'`) are deliberately not adopted —
  they are preset-governed and never receive MCP tools.
- Under a `ptc` agent preset the request header lists only `run_code`, so the
  injected-tools notice does not appear there (MCP names still render per call
  through the tool-row lane; see `docs/design.md` §5(f)).

## How to re-verify

```sh
npm run check                                    # typecheck + tests + build + pack surface
node scripts/release-notes.mjs 0.0.4             # the dated CHANGELOG section (before tagging)
npm run verify:workflows                         # action pins + release structure
npm run verify:low-generation                    # resolve the BUILT half against the LOW generation's real packages
npm run test:smoke                               # live M1 + M0 on the chamber anchor
# macOS: nvm's `pnpm` is a corepack shim and refuses while this repo pins
# `packageManager: npm`. With node on PATH, build the gitignored .smoke/bin
# scratch shim once (run the three lines, dropping the leading "#   "):
#   mkdir -p .smoke/bin && ln -sf "$(command -v node)" .smoke/bin/node
#   printf '#!/bin/sh\nexec node /Applications/dsh-chamber.app/Contents/Resources/pnpm/bin/pnpm.cjs "$@"\n' > .smoke/bin/pnpm
#   chmod +x .smoke/bin/pnpm
# then point the driver at it and at the chamber anchor:
#   export DSH_SMOKE_NODE="$PWD/.smoke/bin/node"
#   export DSH_SMOKE_NODE_BIN_DIR="$PWD/.smoke/bin"
#   export DSH_ANCHOR_CLI="$PWD/.smoke/anchor-016/node_modules/@deepseek-ai/dsh/lib/bin.js"
#     (any CLI inside the support window works: the chamber app ships
#      0.1.5-rc.2, which exercises the fallback; install e.g.
#      `npm i @deepseek-ai/dsh@0.1.6-alpha.1` into a scratch dir and point at its
#      node_modules/@deepseek-ai/dsh/lib/bin.js to exercise the official adapter)
#   npm run test:smoke
git ls-remote --tags origin                      # what is actually released
```
