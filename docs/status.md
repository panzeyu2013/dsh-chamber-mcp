# Status — dsh-chamber-mcp

Current release, compatibility and verification state. Refreshed 2026-09-27.

## Release state

- **`v0.2.1` is prepared on `main` but NOT tagged** — `package.json` /
  `package-lock.json` version `0.2.1`, dated CHANGELOG section
  `## [0.2.1] - 2026-09-27` carrying two Fixed entries (the ON-state switch
  hit-area fix, and the 0.1.7 staged-session discovery fix that had silently
  returned every MCP call to the shipped generic row), and the full gate green
  (`npm run check`: typecheck, 532 tests, build, `verify:package` including the
  client-artifact lane, whose session fake now encodes the 0.1.7 shape). The
  local web profile is reinstalled from the packed `0.2.1` tgz and awaits one
  instance restart. Do not describe it as released — `v0.2.0` below is still
  the newest published release.
- **Published release: `v0.2.0`** — tag `v0.2.0` on `main` (`eec844e`),
  GitHub Release published 2026-09-25 with `dsh-chamber-mcp-0.2.0.tgz`
  (162,898 bytes, sha256
  `9984a453dcd5ae49179d6d3e6aa15f8f40c8bddb0ca50073897a13f957d53586`) + its
  matching `.sha256` sidecar; notes composed from the dated CHANGELOG section.
  CI and Release ran green on the tag. The published tarball's 47 packed files
  are byte-identical to the locally gated pack (only the gzip container differs
  by environment: local sha256
  `e71e08ca82771eaf23b899d58360d99f8e170a1a959d0a118910b992474e5c9a`). This is
  the first release on the 0.1.7 generation (`v0.1.1` is the previous one).
- **Published release: `v0.1.0`** — tag `v0.1.0` on `main`
  (`4413b0e`), GitHub Release published 2026-09-16 with
  `dsh-chamber-mcp-0.1.0.tgz` (157,283 bytes, sha256
  `cb88df50eb002cace2bef685837a058bf7868d5c69fa4d3be731acfc43505ed9`) + its
  `.sha256` sidecar; notes composed from the dated CHANGELOG section. The tag
  push ran `CI` and `Release` green (the Release job re-ran the full gate, then
  published; the downloaded asset is byte-identical to the locally verified
  tarball). `v0.0.3` (2026-09-15), `v0.0.2` and `v0.0.1` are the previous
  releases.
- **`v0.1.1` is RELEASED** — tag `v0.1.1` on `b8dc71d` (published 2026-09-16,
  CI + Release workflows green). Asset `dsh-chamber-mcp-0.1.1.tgz` (165,638 bytes,
  47 entries) with its `.sha256`; the published hash
  `52a8a2ad2536e20a5a2c8d798490b641b42fcd6ebe61de885a1ea54ad9803492` matches the
  downloaded asset. All six linked remote instances were updated through the
  chamber gateway's official `materialize` path and then restarted through the
  gateway's own `runtime/restart` action (every host reported a new instance
  process and a healthy gateway afterwards), so each runs `0.1.1` now. The LOCAL
  instance's profile was updated the same way through its own dsh CLI
  (`plugin --profile web add` on the chamber-managed `dsh-home`, asset staged as
  `dsh-chamber-mcp-0.1.1-<sha256 head>.tgz` like its predecessor) and keeps
  running until its runtime is restarted.
- **`v0.1.1` verification (on the tagged commit).** `npm ci` + `npm run check` PASS —
  `tsc` ×2, **554 tests / 28 files**, 47 packed entries, `verify-client-artifact`
  PASS, determinism (43 files), `verify:package` PASS;
  `node scripts/release-notes.mjs 0.1.1` composes the dated section alone;
  `scripts/verify-workflow-action-pins.mjs` PASS; `npm run verify:low-generation`
  PASS; the live smoke (`npm run test:smoke`) is green on both anchors —
  `dsh@0.1.5-rc.2` with `R3-live-capture: PASS`, `dsh@0.1.6-alpha.1` with
  `not-captured` (the known per-anchor R3 limitation). Reviews of this candidate
  found and fixed a client accessor regression and a missing production
  `agents.list()` wiring before the tag existed; the one-shot delegation
  `toolFilter` limitation below is recorded rather than fixed (upstream does not
  persist it).
- **What `v0.1.0` carries.** Headline change: **MCP off by default** — a
  configured server reaches no agent until a workspace explicitly enables it, the
  per-workspace switch now records an enable and the global switch stays a hard
  kill (see `docs/design.md` §3 and the `0.1.0` CHANGELOG entry); the
  workspace switching panel; per-server runtime refresh; `ptc` tool-row
  discovery; import-parser hardening; the registered-tools conversation notice
  (the UI review round that followed — no per-row state word, no default-off copy
  anywhere on the card, a card-local filter, hit boxes contained in their row and
  row writes queued instead of dimming the card — is part of this section)
  (derived client-side from the request's tool array and the rendered system
  prompt, never written into a session — a shipped-chrome disclosure row that
  expands into the per-server tool names and renders immediately before the
  system-prompt card); the host/gate fixes below; and the
  wireframe/design-document re-alignment with the official
  `IconChevronDownOutline14` geometry in the tool row.
- Releases ship the packed tgz as a GitHub Release asset; **npm publishing is
  temporarily disabled**. Flow and rollback: `docs/RELEASE.md`. Confirm what is
  actually published with `git ls-remote --tags origin` / `gh release view`.
- Tagging, pushing and publishing are maintainer actions.

## Compatibility

- Node ≥ 24; a dsh instance of the **0.1.7 generation** (peers
  **`^0.1.7-rc.2`**). The 0.1.5/0.1.6 generation is no longer supported: 0.2.0
  removed the local tool-adapter port, `verify:low-generation` and the
  low-generation smoke with it.
- The `@deepseek-ai/dsh-*` devDependencies pin one resolved generation — the
  compile-time API surface and the CI guard (**`0.1.7-rc.2`** on this line) —
  and the peers declare the generation this plugin was verified against. Do not
  mix generations in the dev tree, and do not pin the umbrella's own version
  when its internals resolve past it.
- Each Loader entry's own exported `Config` IS its settings form: this
  plugin's document (`servers`/`overrides`/`disabled`) lives in the profile
  patch row `{ id: mcp-scope, name: dsh-chamber-mcp, config: … }`, every field
  carries schemastery `.volatile()`, and a form write commits into the RUNNING
  fiber's references in place (`loader/volatile-update`) instead of remounting
  the plugin. An upgrading installation's legacy `<DSH_HOME>/settings.yaml`
  `mcp-scope:` section is imported once by `SettingsForms` into that same-id
  entry and the file is renamed `settings.yaml.imported` (measured end to end;
  see §Verification state).
- The tool build is the OFFICIAL `createMcpToolDefinition` from
  `@deepseek-ai/dsh-mcp-client` — imported DYNAMICALLY, so a composition
  without the package fails that server's tool sync with a reported reason
  instead of failing the whole plugin tree. Its 0.1.7 projection hook is
  `projectContent` (run before `tools/post-execute` policies). The adapter owns
  canonical result validation, `taskRequired` refusal, `isError` → throw and
  DURABLE IMAGE ADMISSION; this plugin owns the naming contract, the per-server
  tool cap, registration per agent scope, and transport/lifetime.
- The client half speaks **`@modelcontextprotocol/client@2.0.0`** (this
  plugin's own dependency, not a host surface); `@modelcontextprotocol/sdk`
  (1.x) is no longer a dependency at all.
- The live smoke installs *and* boots through the anchor CLI `DSH_ANCHOR_CLI`
  names, reading its `dsh` version at run time and recording it in the
  transcript; the anchor must be a 0.1.7-generation CLI (the driver fails fast
  otherwise). The chamber gateway's anchor must be upgraded to 0.1.7 before this
  release can be installed there.
- **Upstream dist-tags (measured 2026-09-25):** `@deepseek-ai/dsh`
  `latest` = `0.1.5-rc.3`, `next` = `0.1.7-rc.2`, `alpha` =
  `0.1.7-alpha.2`. This line targets `next`; re-check the peer range when
  `latest` moves to the 0.1.7 line.
- **What 0.1.7 provides and this plugin consumes:** the per-entry
  `Config` settings model with `dsh-config-editor` persistence and volatile
  in-place commits; `SettingsForms`/`ConfigForms`; `createMcpToolDefinition`
  and the `server-context` module publishing `mcp:<server>` literal sections
  plus `mcpResources` providers; `maxInstructionBytes` (32,768-byte ceiling,
  fixed); `taskRequired` rejection; `outputSchema`/`structuredContent`
  handling. Not surfaced — and not implemented upstream either: OAuth-provider
  transport config, resource subscriptions, prompt templates, sampling,
  elicitation.

- **Upstream `0.1.7-rc.2` settings-seam change — the pre-migration tree broke
  (2026-09-25, reproduced on a real 0.1.7-rc.2 instance).** Registry dist-tags
  moved (`next` = `0.1.7-rc.2`, `alpha` = `0.1.7-alpha.2`, `latest` stays
  `0.1.5-rc.3`) while the chamber anchor still read `0.1.5-rc.3`. The
  generation redesigned the settings seam: `ctx.settings` became
  `SettingsForms` (per-entry `Config`, schema-projected volatile forms,
  `dsh-config-editor` persistence, in-place commits), and
  `SettingsProvider.register`/`installSection`, `SettingsScope`,
  `SettingsSectionHooks`, `SettingsRegisterOptions`/`SettingsApplies`, the
  `settings/updated` event and the `dsh-settings-file` provider were deleted
  without a shim; the browser seam `ctx.settingsScope`/`SettingsScopeBinder`
  was replaced by `ctx.configForms.get(entryId)` → `ConfigForm<T>`
  (`getSnapshot`/`subscribe`/`mutate`, plus `describe()`/`whileServed()`).
  Measured on `dsh-chamber-mcp@0.1.1`: `dsh: warning: 1 entry did not
  activate`, the plugin row `fiberPhase: "failed"`, `TypeError:
  ctx.settings.installSection is not a function`, no `mcp-scope` form and no
  registered tool; the browser half could not apply either (its `inject` named
  the removed service), so the settings page and the keyed
  `tool.call.toolview` lane were dark. The 0.1.7 compatibility preflight
  (`evaluatePluginCompatibility`, prerelease-inclusive semver) did NOT catch it
  — the old peers evaluated as compatible, so an install-before-upgrade fails at
  apply time rather than at install time.
- **The fix shipped in `0.2.0`; the measured evidence is under
  §Verification state.** The document moved into the entry's own
  `.volatile()` `Config` and is read per operation; the bridge runs an
  activation-time reconcile (the loader creates the fiber with its config and
  emits `loader/volatile-update` only for in-place commits) and reconciles on
  that event; the browser half binds `ctx.configForms.get('mcp-scope')` and
  suppresses the auto-generated page with
  `settings.configure({ auto: false }, ctx.fiber)`; the tool build is the
  official adapter only. Two accepted limitations are recorded rather than
  fixed: the schema cannot express the cross-field rules (duplicate
  serverNames/env keys/header names), so those stay client-enforced before a
  write, and a hand-edited profile patch that violates the *schema* keeps its
  entry from activating (no repair form would be left) — everything the schema
  shape still admits is canonicalized by `readDocument`.
- **Verdict (historical, 2026-09-25):** the pre-migration tree and `v0.1.1`
  did NOT work on `0.1.7-rc.2`; MCP was gone because the host fiber failed at
  apply. `0.2.0` migrates to that generation and drops the old peer range — the
  0.1.5/0.1.6 claims in the release records above remain the record for those
  releases.
- Internal Loader entry id (settings form + legacy import target): `mcp-scope`.

## Verification state

- **0.2.0 (published `v0.2.0`, tag `eec844e`; migrated to the 0.1.7 generation):**
  `npm run check` PASS — `tsc` ×2, **531 tests / 28 files**, 47 packed entries,
  `verify-client-artifact` PASS, determinism (43 files), `verify:package` PASS.
  Live smoke on a real `dsh@0.1.7-rc.2` anchor (scratch
  `npm i @deepseek-ai/dsh@0.1.7-rc.2`, `DSH_ANCHOR_CLI` pointed at its
  `lib/bin.js`): **M0 exit 0** with the plugin row `fiberPhase: "active"` (no
  `failed` line), `settings/describe` serving the `mcp-scope` form
  (`revision=0 value={"servers":[],"overrides":{},"disabled":{}}`), a
  `settings/mutate` landing as `revision=1` with the fixture server, the
  stale-revision write refused, and `/api/mcp-scope.tools` listing
  `mcp__fixture__echo` / `mcp__fixture__env_report`; the same route re-asserts
  the listing after an instance RESTART with no settings write in between
  (`after restart: listed 2 tools`), which pins the activation-time reconcile
  (the loader emits `loader/volatile-update` only for in-place commits);
  **M1 exit 0** with the
  tarball installed and the sessions created, `R3-live-capture: not-captured`
  (the known headless-anchor limitation — no turn starts without a UI surface
  claim). The settings write → volatile commit → reconcile → connect chain is
  therefore exercised end-to-end through the real RPC; the in-place
  (no-remount) property rides the loader's `loader/volatile-update` contract
  and is pinned by the entry-wiring test in `tests/host/index.spec.ts`.
  Two further checks were measured out of band on the same anchor: (a) the
  legacy import — a fresh home seeded with the old `settings.yaml` serves the
  imported server + override through `settings/describe`, carries them in the
  profile patch, and leaves `settings.yaml.imported` behind (the original file
  gone); (b) the browser default decode —
  `volatileForm(Config).toJSON()` rehydrated with a fresh schemastery node
  accepts the projected drafts of empty, legacy, HTTP+headers+disabled and
  partial documents, so `ConfigForm` does not sit at `loading` on our
  projected form.
- **0.0.3 (published):** `npm run check` PASS — `tsc` ×2, 250 tests / 17 files,
  build, `verify:package` (40 packed entries), and live smoke `npm run test:smoke`
  (`M1` + `M0`) exit 0 against the anchor CLI with `dsh-chamber-mcp@0.0.3`
  installed. The M1 capture records R3: the enabled workspace's model-facing turn
  carries `mcp__fixture__echo` / `mcp__fixture__env_report`, the disabled
  workspace's turn carries none (transcript evidence — the driver reports the
  verdict but does not fail on it).
- **0.1.0 (published):** the pre-tag checklist ran on the release commit
  (`4413b0e`, tagged `v0.1.0`). `npm run check` PASS — `tsc` ×2, **514 tests / 27 files**,
  build, `verify:package` (45 packed entries; consumer d.ts; react-only
  client-bundle purity; the packed-bundle artifact check, which also drives the
  registered-tools notice lane; lockfile-vs-manifest surface and integrity
  coverage; determinism over the whole built tree, 41 files);
  `npm ci --dry-run` clean (lockfile matches the manifest);
  `node scripts/release-notes.mjs 0.1.0` composes the release body from the dated
  section (31.6 KB); `npm run verify:workflows` PASS;
  `npm run verify:low-generation` PASS (the BUILT half resolved against the low
  generation's real packages: fallback selection, image admission, refusal).
  Local artifact `dsh-chamber-mcp-0.1.0.tgz` (157,283 bytes, sha256
  `cb88df50eb002cace2bef685837a058bf7868d5c69fa4d3be731acfc43505ed9`) with its
  `.sha256` sidecar — packed from the FINAL tree (README is a shipped entry, so
  a doc edit there moves the hash; `lib/` is byte-identical to the build the
  earlier smoke installed). Live smoke `npm run test:smoke` (`M1` + `M0`) exits 0 on
  **BOTH** generations, each installing that tarball:
  - `dsh@0.1.5-rc.2` — **the chamber app's own anchor** (`vendor/dsh`): `M1`
    records **`R3-live-capture: PASS`** — the enabled workspace's model-facing turn
    carries `mcp__fixture__echo` / `mcp__fixture__env_report` (29 tools) and the
    disabled workspace's turn carries none — with the same lifecycle evidence
    (settings describe + mutate, the stale-revision write refused, the
    `/api/mcp-scope.tools` listing assertion, the fixture child receiving the
    resolved env key). This is the two-generation claim actually exercised: the
    namespace lookup misses `createMcpToolDefinition` and the plugin runs on its
    local text projection. Before the fallback landed this same run failed with
    `plugin tree failed to load ... does not provide an export named
    'createMcpToolDefinition'` and the instance exited 1.
  - `dsh@0.1.6-alpha.1` (installed separately under `.smoke/anchor-016`, pointed
    at through `DSH_ANCHOR_CLI`): `M1` records `R3-live-capture: not-captured` —
    a headless instance starts no turn, so the model-facing tools array is not
    re-verified live (the driver reports that verdict without failing on it) —
    and `M0` exits 0 with the full lifecycle evidence.
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
- **The live smoke for this release ran on the MERGED tree.** Both halves are in
  the 0.1.0 tarball the drivers install, including the registered-tools notice
  (client-only) and **MCP off by default** (host-visible — M1's R3 verdict is
  exactly about enablement); the drivers encode the new polarity (presence IS the
  enable), and the chamber anchor's run reads `R3-live-capture: PASS`
  (`onHasMcp && !offHasMcp`). The earlier generation-migration capture is kept for
  history; this is the run that gates the tag.
- Transcripts are written under `.smoke/logs/` (gitignored) and are not
  committed. `M0-raw.log`/`M1-raw.log` hold the last driver run of each kind; the
  two-anchor evidence for this release is kept side by side as
  `anchor-0.1.5-run.log` and `anchor-0.1.6-run.log` — the full `test:smoke`
  transcripts (M1 then M0) for each anchor. Each records the anchor CLI with its
  version, the installed `dsh-chamber-mcp@0.1.0`, the plugin row's `fiberPhase`,
  the live-capture verdict (`R3-live-capture: PASS` on the chamber anchor,
  `not-captured` on the headless 0.1.6 anchor) and the `/api/mcp-scope.tools`
  listing (`listed 2 tools: mcp__fixture__echo, mcp__fixture__env_report`).

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
  recorded **`R3-live-capture: PASS`**, while the headless 0.1.6-alpha.1 and
  0.1.7-rc.2 anchors record `not-captured` — those instances never start a turn,
  so the mock LLM receives no chat request. The capture is transcript evidence
  either way: the driver reports the verdict without failing on it.
- **The 0.1.5/0.1.6 generation is unsupported as of 0.2.0.** The plugin's
  verbatim port of the official tool adapter (and its parity suite) was removed
  with that generation, and so was `npm run verify:low-generation`; 0.1.7 is the
  only peer range.
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

## How to re-verify

```sh
npm run check                                    # typecheck + tests + build + pack surface
node scripts/release-notes.mjs 0.2.0             # the dated CHANGELOG section (before tagging)
npm run verify:workflows                         # action pins + release structure
# Live smoke on the ONLY supported generation (0.1.7): the chamber anchor must
# be a 0.1.7 CLI before `npm run test:smoke` can pass. For a local run:
#   mkdir -p .scratch/anchor-017 && (cd .scratch/anchor-017 && npm i --no-audit @deepseek-ai/dsh@0.1.7-rc.2)
#   export DSH_ANCHOR_CLI="$PWD/.scratch/anchor-017/node_modules/@deepseek-ai/dsh/lib/bin.js"
#   npm run test:smoke
# pnpm EAGAIN workaround: some sandboxes fail pnpm's store→profile copy
# (`EAGAIN ... copyfile`). Pin the import method to hardlink in the scratch
# home's .npmrc (store and profile both live under .smoke, same filesystem):
#   printf 'package-import-method=hardlink\n' > .smoke/homedir/.npmrc
# macOS: nvm's `pnpm` is a corepack shim and refuses while this repo pins
# `packageManager: npm`. With node on PATH, build the gitignored .smoke/bin
# scratch shim once (run the three lines, dropping the leading "#   "):
#   mkdir -p .smoke/bin && ln -sf "$(command -v node)" .smoke/bin/node
#   printf '#!/bin/sh\nexec node /Applications/dsh-chamber.app/Contents/Resources/pnpm/bin/pnpm.cjs "$@"\n' > .smoke/bin/pnpm
#   chmod +x .smoke/bin/pnpm
# then point the driver at it and at a 0.1.7-generation anchor CLI:
#   export DSH_SMOKE_NODE="$PWD/.smoke/bin/node"
#   export DSH_SMOKE_NODE_BIN_DIR="$PWD/.smoke/bin"
#   export DSH_ANCHOR_CLI="$PWD/.smoke/anchor-017/node_modules/@deepseek-ai/dsh/lib/bin.js"
#     (install `npm i @deepseek-ai/dsh@0.1.7-rc.2` into a scratch dir and point at
#      its node_modules/@deepseek-ai/dsh/lib/bin.js)
#   npm run test:smoke
git ls-remote --tags origin                      # what is actually released
```
