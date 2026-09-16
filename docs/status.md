# Status — dsh-chamber-mcp

Current release, compatibility and verification state. Refreshed 2026-09-16.

## Release state

- **Published release: `v0.0.3`** — tag `v0.0.3` on `main` (`bf344ef`), GitHub
  Release published 2026-09-15 with `dsh-chamber-mcp-0.0.3.tgz` + `.sha256`;
  notes composed from the dated CHANGELOG section. `v0.0.2` and `v0.0.1` are
  the previous releases.
- **Working line: the unreleased 0.0.4 line.** `main` carries the next-version
  changeset on top of the `v0.0.3` commit (`bf344ef`): **MCP off by default** — a
  configured server reaches no agent until a workspace explicitly enables it, the
  per-workspace switch now records an enable and the global switch stays a hard
  kill (see `docs/design.md` §3 and the Unreleased CHANGELOG entry); the
  workspace switching panel; per-server runtime refresh; `ptc` tool-row
  discovery; import-parser hardening; the registered-tools conversation notice
  (derived client-side from the request's tool array and the rendered system
  prompt, never written into a session — a shipped-chrome disclosure row that
  expands into the per-server tool names and renders immediately before the
  system-prompt card); the host/gate fixes below; and the
  wireframe/design-document re-alignment with the official
  `IconChevronDownOutline14` geometry in the tool row. No version bump yet.
- Releases ship the packed tgz as a GitHub Release asset; **npm publishing is
  temporarily disabled**. Flow and rollback: `docs/RELEASE.md`. Confirm what is
  actually published with `git ls-remote --tags origin` / `gh release view`.
- Tagging, pushing and publishing are maintainer actions.

## Compatibility

- Node ≥ 24; a dsh instance of a supported generation.
- The `@deepseek-ai/dsh-*` devDependencies pin one resolved generation — the
  compile-time API surface and the CI guard. Peers accept the two generations
  this surface was verified against: `^0.1.2-rc.1 || ^0.1.5-rc.1`.
- The live smoke installs *and* boots through the chamber's current anchor CLI,
  reading its `dsh` version at run time and recording it in the transcript.
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
  **452 tests / 24 files**, build, `verify:package` (42 packed entries; consumer
  d.ts; react-only client-bundle purity; the packed-bundle artifact check, which
  also drives the registered-tools notice lane; determinism over the whole built
  tree), plus `npm run verify:workflows` PASS.
- **The live smoke has NOT been re-run for this line.** The recorded `M1` + `M0`
  run (exit 0 against the chamber anchor CLI, `dsh@0.1.5-rc.2` under
  `/Applications/dsh-chamber.app/.../vendor/dsh/`) predates two behavior changes
  on this tree: the registered-tools notice (client-only) and **MCP off by
  default** (host-visible — its R3 verdict is exactly about enablement, so the
  recorded verdict is NOT evidence for this tree). Both drivers were updated to
  the new polarity (`scripts/smoke/m1.mjs`, `scripts/smoke/m0.mjs`: presence IS
  the enable) and must be re-run before tagging.
- Transcripts are written under `.smoke/logs/` (gitignored) and are not
  committed.

## Known limitations

- No in-GUI `Settings → MCP servers` click-through has been performed in a real
  desktop session; the jsdom flows and the shipped-bundle preview harness cover
  the render paths.
- The 5 s failure-close discipline and the legacy `toolResult` branch have no
  dedicated test.
- Delegation children (`origin: 'subagent'`) are deliberately not adopted —
  they are preset-governed and never receive MCP tools.
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

## How to re-verify

```sh
npm run check                                    # typecheck + tests + build + pack surface
node scripts/release-notes.mjs 0.0.4             # the dated CHANGELOG section (before tagging)
npm run verify:workflows                         # action pins + release structure
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
#   export DSH_ANCHOR_CLI=/Applications/dsh-chamber.app/Contents/Resources/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
#   npm run test:smoke
git ls-remote --tags origin                      # what is actually released
```
