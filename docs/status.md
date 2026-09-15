# Status — dsh-chamber-mcp

Current release, compatibility and verification state. Refreshed 2026-09-15.

## Release state

- **Working line:** `0.0.3` on `main` — version set in `package.json` ==
  `package-lock` `packages[""]` == the dated CHANGELOG section; **not tagged**.
- **Newest published release:** `v0.0.2` — tag `v0.0.2`, GitHub Release published 2026-09-14 (assets `dsh-chamber-mcp-0.0.2.tgz` +
  `.sha256`). `v0.0.1` is the previous release.
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

## Verification state (0.0.3)

- `npm run check` PASS: `tsc` ×2, **250 tests / 17 files**, build,
  `verify:package` (40 packed entries; consumer d.ts; react-only client-bundle
  purity; the jsdom artifact check of the built browser half; deterministic
  rebuild).
- `node scripts/release-notes.mjs 0.0.3` composes; `npm run verify:workflows`
  PASS.
- Live smoke `npm run test:smoke` (`M1` + `M0`) exit 0 against the anchor CLI
  with `dsh-chamber-mcp@0.0.3` installed. The M1 capture records R3: the enabled
  workspace's model-facing turn carries `mcp__fixture__echo` /
  `mcp__fixture__env_report`, the disabled workspace's turn carries none
  (transcript evidence — the driver reports the verdict but does not fail on it).
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

## How to re-verify

```sh
npm run check                                    # typecheck + tests + build + pack surface
node scripts/release-notes.mjs 0.0.3             # the dated CHANGELOG section composes
npm run verify:workflows                         # action pins + release structure
npm run test:smoke                               # live M1 + M0 on the chamber anchor
git ls-remote --tags origin                      # what is actually released
```
