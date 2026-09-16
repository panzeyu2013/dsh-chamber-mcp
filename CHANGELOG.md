# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Release flow (see `docs/RELEASE.md` §Changelog-first flow):** before tagging,
> move every entry below into the dated `## [<version>] - YYYY-MM-DD` section.
> `scripts/release-notes.mjs` composes the GitHub Release body from THAT section
> only and ignores this one — an entry left here ships in the tree but never
> appears in the release notes.

### Changed

- **The workspace block scales: a responsive grid, a name filter, a frozen
  order.** With a dozen workspaces the expanded block was a long stack whose bulk
  pair sat past the fold. The rows are now an `auto-fill / minmax(200px, 1fr)`
  grid (one column in a narrow panel, more as it widens); past five workspaces a
  filter narrows the list by name, says so when nothing matches, and scopes the
  bulk pair to what is shown (`All on (N shown)`) instead of silently touching
  every workspace on the machine; the row order is computed ONCE when the list
  opens (enabled first, the rest in host order) so a toggle never moves a row out
  from under the pointer. A row renders NO state word at all: the switch carries
  on/off by itself (a column of identical "On"/"Off" labels was noise), and the
  inline filter drops the official field fill — `bg-layer-1` read as a white slab
  against the card's `bg-layer-3`, so it takes a transparent fill with the same
  `border-l3` hairline the outline buttons use.
- **The workspace card's bulk pair leads the list, and the default-off line now
  names its session scope.** `All on`/`All off` sat after the rows, so a long
  workspace list pushed them past the fold; they now sit directly under the
  manage control, and the manage control now keeps the on-count while the list
  is open (`Hide workspaces (N on)`) — with a long list that is exactly when the
  count would otherwise disappear. `server.defaultOff` also says what the
  per-workspace switch covers: that workspace's existing and new sessions alike
  (the host applies the pair per agent, and a live flip pushes to the agents
  already running).
- **The client layer moved to the v2 model: `@modelcontextprotocol/client@2.0.0`
  — the same dependency on every supported host generation.** The 1.x SDK is gone
  from the tree, and the code that existed only to compensate for it was DELETED
  rather than ported: hand-rolled `tools/list` pagination, its repeated-cursor
  and page caps, and the legacy `toolResult` normalization. `MAX_SYNC_TOOLS`
  (2000) stays — the client's `listMaxPages` bounds pages, not listed tools, and
  per-agent registration fan-out still needs a total cap (SEC-05). The aggregated
  listing carries the server's configured `timeoutMs`, so an operator deadline
  still bounds a handshake-then-stall server instead of the SDK's 60 s default.
- **Two host generations, one package.** Peers are
  `^0.1.5-rc.2 || ^0.1.6-alpha.1`, and the definition builder is SELECTED at
  runtime: on 0.1.6+ the official `createMcpToolDefinition` adapter (canonical
  result validation plus durable image admission), on 0.1.5 a verbatim port of
  that same adapter — same projection strings and empty-value semantics, same
  `CallToolResult` validation, same image admission and `finalizeContent`
  hook, held to the adapter's exact output by a parity suite — so an older host
  behaves like the official plugin instead of failing to load. The adapter is read off a NAMESPACE
  import precisely because a STATIC import of the 0.1.6-only export is an ESM
  link-time error that takes the whole plugin tree (and the host) down.
  `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-mcp-resources` are
  OPTIONAL peers for the same reason: a host without the first still runs on the
  fallback, and one without the second simply gets no shared resource tools.
- **Tool definitions are built by the official `createMcpToolDefinition`
  adapter wherever the host provides it.** On that path canonical result
  validation, `taskRequired` refusal and durable image admission are upstream
  behavior; the 0.1.5 fallback is a verbatim port of it rather than the
  historical placeholder projection (see `docs/design.md` §5(c)). A host
  that silently loses the adapter switches to the fallback ONCE, and the reason
  is logged. The listing is capability-gated (`getServerCapabilities()?.tools`)
  and aggregated by the client in one
  `listTools(undefined, { cacheMode: 'refresh', timeout })` call; calls go
  through `callTool({ name, arguments }, { signal, timeout, toolDefinition })`,
  and the generation is negotiated with `versionNegotiation: { mode: 'auto' }`.
- **Server instructions and MCP resources are published for the first time.**
  Every established connection contributes a literal `mcp:<serverName>`
  system-prompt section at the allocated `MCP_SERVERS` order (interpolation
  off; bounded by `MAX_INSTRUCTION_BYTES` = 32768 over the complete attributed
  value, and an oversized block fails that attempt) plus an `mcpResources`
  provider, so the service-owned `list_mcp_resources` /
  `list_mcp_resource_templates` / `read_mcp_resource` tools reach this
  plugin's servers. Both contributions are optional by construction: a
  composition that mounts neither degrades to no contribution. The prompt section
  is 0.1.6+ ONLY — 0.1.5 has no literal-section rendering (its renderer
  interpolates every section, so remote prose containing `{{...}}` could abort a
  turn or be substituted with a host variable), and that host never published one.
- **A failed attempt no longer has to prove a close event it never owed.**
  Only an ATTACHED generation (the client actually bound its transport) holds
  the 5 s close barrier; an unattached failure closes through its transport and
  retries on the normal budget. Previously a plain "command not found" burned
  the barrier and stopped reconnection for good with `failed generation did not
  close within 5000ms`.

### Removed

- **The card's default-off note line.** `server.defaultOff` ("Off by default —
  only the workspaces enabled below get the tools…") sat under every expanded
  workspace list and said what the OFF switches already show; it is gone from
  both locales, and with it the last server-level default sentence (the collapsed
  card still explains an empty list through `row.allOffDefault`).
- The `@modelcontextprotocol/sdk` (1.x) client dependency (replaced by
  `@modelcontextprotocol/client@2.0.0`), and the `0.1.2` generation from the
  claimed support window: this line re-verifies `0.1.5-rc.2` and
  `0.1.6-alpha.1` only.

### Fixed

- **The card-local filter's hint text was hard to read.** Dropping the white
  field fill left the card's own surface showing through, and the official
  placeholder token (`label-dimmed`) is tuned for a WHITE field — the hint read
  as barely there. The inline filter's placeholder now takes the next token up
  (`label-secondary`) with a pinned `opacity: 1`, so the raised fill contrast
  does not cost legibility. Panel-level inputs keep the shipped field look.
- **A switch's hit box no longer spills into the next row.** The 4px slop that
  grew the target to 44×28 was centred in a 20px row, so two neighbouring rows'
  boxes overlapped by 6px — and because the absolutely positioned inputs paint in
  DOM order, the LOWER row won that band: the bottom ~2px of a switch toggled the
  row below, which is exactly what "the bounding box feels off" was. The row is
  now 28px (4+20+4), so the target stays inside its own row; the label stretches to
  the same band (no dead strip beside a live switch), and the keyboard ring draws
  the hit box itself (`outline-offset: 4px` instead of 2px).
- **A workspace switch no longer dims the whole card.** Flipping one workspace
  made every row inert for the duration of the write (the controller judges a
  save against the document it read, so overlapping writes would report a
  spurious conflict) — and inert means `opacity: .5` on every switch plus the
  card's buttons, so each toggle blinked the card. Row toggles are now QUEUED
  behind one another instead: every row stays interactive, a click during a write
  lands right after it, and only the row whose write is running carries
  `data-pending` / `aria-busy`.
- **The workspace card's filter can no longer strand its own query, and the
  dead copy this work left behind is gone.** A query narrowed the list even after
  the filter input disappeared (deleting workspaces down past the five-workspace
  threshold), leaving rows — and the bulk pair's scope — unreachable behind a
  control that was no longer on screen; the query is dropped with the input.
  `row.on`, `row.off` (the switch is the only state carrier now) and
  `state.clearing` were dead labels, and the notice payload's `total` was dead
  state: all four are removed rather than left for the contract to pin.
- **`retires the retained error once a generation is established` is no longer
  load-sensitive.** The test bound the handshake at 100ms while also requiring a
  real `node` spawn + initialize + sync on its second attempt; on a busy machine
  that attempt timed out too, the reconnect budget ran out and the test failed 2
  runs in 3. The bound now covers a real spawn (only the test changed).
- **A workspace row's switch was a 36×20 target and its state word swallowed
  clicks.** The native checkbox fills its box, so the box WAS the hit area, and
  "Off"/"On" sat beside the label as an inert sibling that looked clickable but
  was not — aiming at the row's right edge landed on the dead half. The box now
  carries a 4px slop (with a cancelling negative margin, so nothing moves) for a
  44×28 target, and the state word lives INSIDE the label (\`aria-hidden\`, since
  \`role="switch"\` + \`checked\` already carry it) so the whole text run toggles — and the word was then retired
  outright (see above): the switch is the state carrier.
- **Giving up now retracts the published instructions, not just the tools.** The
  reconnect budget's give-up pushed an empty tool list while the live
  `mcp:<serverName>` section kept returning the last connected generation's
  `initialize` instructions — the model was told to use `mcp__<server>__*`
  names that no longer existed. The field is cleared on give-up and on
  unregister, matching the official supervisor.
- **A generation that disposal superseded mid-connect is now closed.** If
  `dispose()` ran while the transport was still being built, the close was
  confirmed against an unattached client and the attempt that landed afterwards
  attached and returned without closing, leaving a live server process behind.
  The post-connect ownership check closes it (official discipline) and reports if
  the close cannot be confirmed.
- **Lockfile and manifest can no longer drift silently.** `verify:package` now
  compares the lock's root `dependencies`/`devDependencies`/peer surface
  against `package.json`, and refuses a lock whose entries carry a `resolved`
  URL without an `integrity` pin.


- **The injected-tools notice poisoned the session log.** The applier appended a
  private `mcp-scope/injected` / `mcp-scope/injected-updated` session event
  through `agent.session.append`. A third-party event is required-on-read: the
  envelope's `ignorable?: true` marker is the only way a reader may skip a type
  it does not know, and this generation has no write path that can set it
  (`Session.append` composes `type`/`seq`/`time`/`data` plus surface metadata
  only, and `KNOWN_SESSION_EVENT_TYPES` is generated from the harness's own
  `SessionEventMap`, so out-of-repo types are never in it). `validateStoredEvents`
  therefore refused the whole stored session — for every reader, the harness that
  wrote the event included, so affected sessions could not be opened at all. The
  applier is now a pure tool-scope writer (`tests/host/agents.spec.ts` asserts
  that every push, reconcile and revoke path appends nothing) and the notice is
  derived client-side from `request/header` events.
- **Workspace switches serialize per card.** Two quick toggles on different
  workspaces of the same server could report a bogus `conflict`: each save is
  judged by comparing the landed document against the expectation built from the
  revision it read, so the second one no longer matched. Every workspace row is
  now inert while one toggle is in flight (the clicked row included), and a
  regression test pins the disabled state of both rows.
- **Reconnect budget is no longer laundered by a successful connect.**
  `connectGeneration` reset the consecutive-failure counter on every connect, so
  a server that connected and immediately crashed was respawned forever at the
  initial delay: `maxAttempts` could never be reached, the tools were never
  unregistered and the card never left `connected`. Only a connection that stays
  up past the stability window (`maxDelayMs`) ends the outage now — upstream
  `dsh-mcp-client` pins that exact case ("a crash loop with briefly successful
  connects still exhausts the cap") — while the wire counter still reads 0 while
  connected. `tests/host/server.spec.ts` covers both directions.
- **Host-side failures can no longer take the process down or masquerade as
  connection failures.** The reconnect give-up continuation pushed the empty
  generation with no rejection handler, so a throwing applier path became an
  UNHANDLED rejection (Node exits 1). The applier push and the
  `agent/created`–adoption path are now contained with a logged error (a
  synchronous listener throw otherwise vetoes the agent's own publication), and a
  fire-and-forget mutation failure is logged instead of silently aborting the
  rest of a reconcile.
- **A queued credential restart starts the live definition.** The restart used
  the definition captured by the caller, so a settings edit racing a credential
  update could spawn the superseded command/URL until the reconcile behind it
  corrected it; the queued work now re-resolves the server from the live
  document.
- **Client devDependencies pinned exactly.** `dsh-client-ui-chat` and
  `dsh-client-ui-conversation` were the only devDeps with a caret range, against
  the repo's "one resolved generation" rule; both now pin `0.1.5-rc.2` like the
  rest of the dev tree.
- **Stale compiled artifacts can no longer ship, and the pack gate now notices.**
  `lib/` is the whole publish surface (`files: ["lib"]`) while every emitter only
  ADDS files, so a deleted or renamed source kept shipping its last compiled
  copy — the removed `mcp-scope/injected` contract stayed in the tarball after
  its source was deleted. `scripts/build.mjs` now wipes `lib/` before emitting,
  and `verify:package` fails when a packed module or declaration has no current
  `src/` counterpart (packed entries: 43 → 42).
- **Release dry-run gate now actually gates.** `.github/workflows/release.yml`
  compared the typed boolean input `dry_run` against the string `'true'`, which
  is never equal, so a manual dispatch with `dry_run: true` still ran the
  stale-draft deletion and the GitHub Release step — a "dry" run could publish.
  Both guards now read `!inputs.dry_run`.
- **Import parser tolerance (client half).** `parseMcpSnippet`
  (`src/client/import.ts`) now reads what real config files produce instead of
  only whole, strict JSON documents: a bare `"mcp": { ... }` section or a bare
  map of named servers with the enclosing braces left behind (trailing
  separators and the parent map's closer included), `//` and block comments,
  trailing commas, fenced blocks and surrounding prose, a server map behind a
  wrapper key, the VS Code `servers` shape, a top-level array of servers, and
  scalar `command`/`args` entries. Parsing is still `JSON.parse`-only — pasted
  text is never evaluated — and the form keeps filling from the first server
  while reporting the others.
- **Import parser hardening pass.** Server discovery is now a bounded,
  iterative walk, so a deeply nested paste can no longer overflow the stack:
  `parseMcpSnippet` keeps its "returns a business failure, never throws"
  contract, with a defensive net as the last resort. Explicit maps
  (`mcpServers` / `servers` / `mcp`) are merged in discovery order and
  de-duplicated by name instead of only the first map being read; a map whose
  first entry is empty prefers a usable entry; quoted server names keep their
  spaces and colons; imported names are trimmed. Field coercion: `env` accepts
  an object map or a `{name,value}` list and serializes structural values (no
  more `[object Object]`), a string `args` splits like a command line, numeric
  `0`/`1`/`"0"` flags and numeric-string `timeout` values are read, and
  null-ish `command` tokens are skipped instead of voiding the list. The import
  dialog now tells "unreadable JSON" apart from "readable, but no server entry"
  and caps the "also found" list at 8 names with a `(+N more)` suffix. The
  pasted-text helpers got the same pass: a quoted Windows command keeps its
  backslashes (`"C:\Program Files\node.exe"`), and an unquoted `.env`
  ` # comment` tail is dropped while a quoted value keeps its `#`.
- **Independent audit round (import parser).** A second, adversarial pass on
  the frozen parser found and fixed: `fencedBody` was super-quadratic on a long
  run of fence marks (4000 backticks: 9.1 s → 1 ms, so the Settings panel can no
  longer freeze) and is now a linear line scan; candidates are tried until one
  RESOLVES a server, so a paste carrying an example snippet (or prose with a
  stray `{`) above the real config still imports the config, and a later named
  map beats an earlier flat object; `balancedRegions` skips an unbalanced
  opener instead of aborting the scan; a torn section (missing or leading
  comma) is read by a last-resort quoted-key reader while YAML/TOML stay
  rejected; `env` also takes `["KEY=value"]` lists, `headers` takes
  `["Name: value"]` strings, a flat entry keeps its `name`, an array-valued
  `mcpServers` behind a wrapper key keeps every named server, `timeoutMs`
  falls back to `timeout` when it is not numeric, a nested `args` entry no
  longer voids the list, wrapper depth 5+ is covered, and `parseMcpSnippet`
  returns `empty` instead of throwing on non-string input. Extraction
  strategies are skipped above 4 MB and the wrapper walks use a head index plus
  a node budget, bounding the work a paste can trigger.
- **Deployment base path (client half).** The runtime panel's three requests
  (`src/client/runtime.ts`) were built as root-relative paths. That is correct
  for a plain `dsh web` document, but the chamber desktop serves the UI from the
  app shell's own origin while the dsh server listens on a different port and is
  reachable only through the per-instance proxy prefix (`/api/i/<instanceId>`):
  the shell's static layer answered the root-relative request with
  `404 {"error":"not_found"}`, so the panel reported a failed refresh and every
  card showed an unknown state. The store now resolves that prefix (same-origin
  path only — absolute or unsafe values are refused), remembers the base that
  answered, and falls back to the root origin when a candidate is not mounted;
  a plain `dsh web` document is untouched (no prefix, one request). Only an
  origin-level 404 that carries no plugin wire envelope triggers the fallback,
  so a POST is never delivered twice and a business failure is never retried.
  Runtime failures now name the HTTP status in the diagnostic text.
- **A failing connection no longer reads as a bare "connecting…".** The MCP
  handshake ran on the SDK's silent 60 s default, and every retry erased the
  failure reason at its start, so a server that spawned (or accepted HTTP) but
  never answered `initialize` left the card saying only that word for minutes.
  The handshake — and the Test probe — is now bounded by that server's own
  `timeoutMs`, and the reason is retired only once a generation is actually
  established: a retrying card shows "connecting… / attempt N of M" together
  with the localized reason (timed out, connection failed, spawn failed, …),
  and the counter stays off a given-up card whose copy line already names the
  exhausted budget. Regression: `tests/host/server.spec.ts` drives a transport
  that never answers the handshake (bounded failure, reason kept into the next
  attempt, reason dropped once a later attempt connects);
  `tests/client/section-render.spec.tsx` pins the counter's phases.

### Added

- **Workspace switching panel (browser half).** A card lists only the
  workspaces whose state differs from the default — under the default-OFF
  contract below that is the ENABLED set, or one "all N workspaces are off by
  default" line when there are none — and a **Manage workspaces (N on)** toggle
  reveals every row plus **All on / All off** (once more than one workspace
  exists) and the default-off note. The toggle is local UI state and never writes
  the settings document, and a single-workspace dsh reaches its only row through
  it instead of having it hidden.
- **Per-server runtime refresh.** `GET /api/mcp-scope.status?server=NAME`
  projects a single server (an invalid name keeps the existing `400`
  `bad-request` envelope, an unknown name answers `ok:true` with an empty list,
  and omitting the parameter keeps the full view), and the browser store's
  `refresh({ server })` merges that one entry and rejects on failure without
  touching the snapshot. A failed full refresh now retains the last good views
  (stale-while-revalidate) instead of blanking the panel.

- **MCP tool rows under a `ptc` agent preset (client half).** The transcript
  lane discovered MCP names from `request/header` tools and `tool/call` names
  only. Under a `ptc` agent preset both carry just `run_code` — the model
  sees the MCP tools as programmatic bindings, and an MCP call is dispatched
  from inside the program — so the plugin's row was never registered and every
  MCP call rendered with the generic row. The window scan now also reads the
  inner names of `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events, which
  is where those names actually appear. (The model context itself was never
  missing them: the session's system message carries all `mcp__…` bindings.)

- **Registered-tools notice in the conversation (one row per changed set).** A
  session now shows which MCP tools were registered without the user having to
  call one first — the collapsed row reads `MCP registered` with the shipped plug
  glyph, expanding it leads with ONE line of every source and its count and then
  gives each source its own disclosure (the names appear only once a source is
  opened). The row is DERIVED client-side (see
  the Changed entry below for the two sources it unions: the request's tool array
  and the names the rendered system prompt declares), so it reports what the
  request exposed, survives a reload and writes nothing into the session.
  `src/client/injection-row.tsx` rides the official seams the shipped lanes
  use — `ctx.uiConversation.events.register` (the seam the Chat lane's own
  `request-prompt` definition uses for the same event type) and the keyed
  `conversation.chat.node` seat — with one Context per header, so an unchanged
  set renders no row and a real change adds one line where it took effect. Both
  are optional and additive: a deployment without the conversation service
  keeps working and simply shows no row (a malformed payload renders nothing).

### Changed

- **MCP is now OFF by default in every session.** Enablement used to be
  default-ON: every workspace had every configured server until it was switched
  off there. The contract is inverted — `overrides[workspaceId][serverName]`
  now records an explicit ENABLE (presence = on, absence = off) — so a new
  server, a new workspace and a fresh session register no tools until the user
  turns the pair on. The global switch stays a hard kill
  (`disabled[serverName]`, unoverridable by any workspace enable), the per-card
  bulk actions stay one mutation for all workspaces, and the browser half
  follows: the collapsed card lists the ENABLED workspaces and says "not on in
  any workspace" when there are none, the manage toggle is **Manage
  workspaces (N on)**, and the note under the rows is **off by default — enable
  it in the workspaces you want**.
- **BREAKING: a pre-0.0.4 document's records change meaning — deliberately,
  with no migration.** Under the released contract `overrides[w][s] = true`
  meant "off in w"; it now means "on in w", and absence (previously on) is the
  new off. Compatibility is explicitly NOT preserved: the maintainer accepts the
  one-time inversion, so no marker, decoder migration or one-time write ships.
  Consequence for anyone upgrading: pairs that were explicitly switched OFF in
  v0.0.1–v0.0.3 are now ENABLED, and everything else goes off — re-check every
  workspace switch after upgrading. A document with no `overrides` rows, or an
  empty one, needs nothing (everything simply starts off).
- **The injected-tools notice is now a registered-tools row above the system
  prompt.** The conversation-lane notice reported "tools in context" from the
  request header alone, so it said nothing under a `ptc` agent preset (whose
  header carries only `run_code`) and rendered as a standalone r12 pill that
  read as a foreign element next to the system-prompt card. It now reports what
  the request REGISTERED, from both model-facing shapes the harness emits: the
  request tool array (`header.tools`) and the names the rendered system prompt
  declares (the generated SDK section a `ptc` presentation writes them into,
  read through the Chat lane's own `system-message` Context). Extraction uses
  the `mcp__` contract's own `[A-Za-z0-9_-]` alphabet — `-` included, since a
  server or tool name may carry one — and treats the two sources as a set. Only
  DECLARATION positions in the prompt count (the TypeScript `name:` member and
  the Python `async def name(` / `# tools["name"](…)` forms), so a tool
  description that mentions a name is not read as a registration, and a name is
  reported only when a CONFIGURED server owns it. The
  row itself follows the shipped conversation rows rule for rule: one 24px
  disclosure line with the plugin's plug glyph, a hover/open chevron swap, the
  13px secondary title, the server summary and the tool total, expanding by
  click or Enter/Space into the shipped 141px code-block scrollport, which
  lists each owning server's public `mcp__…` names (bounded per server by
  `INJECTION_NAME_LIMIT`, 256, with the remainder reported). Its change
  signature keys on the names, so a same-count tool swap is a real change. It
  is anchored a hair BEFORE the system-prompt card that opens the request's
  step — mirroring the official `requestPromptAnchor` rule for rule, its four
  guards included, so a resumed window or a repeated step cannot send the row to
  the top of the window — so it reads as a
  header for the model-facing input that follows, and the previous
  `header.seq - 0.1` position survives only as the fallback for a window that
  resolves no step. The row's node carries a session-level location on purpose:
  the Chat lane re-anchors any turn/step-located node sitting before the turn's
  opening human input onto that input (which would land it after the user
  message) and folds process-window members away in the compact view, while a
  location that is neither turn nor step short-circuits both rules. Still nothing is written into a session: the row is derived
  client-side, no shipped component is imported (the built client bundle still
  requires only react/react/jsx-runtime), and `verify-client-artifact` drives
  the collapsed row, the click expansion, the named tool list and the PTC
  prompt-only derivation in the packed bundle.

- **Verification hardening (release gates).** `verify:package` now builds
  explicitly before packing (some pack paths skip the `prepack` hook, which
  shipped whatever `lib/` happened to hold and made the determinism check
  compare a stale build against a fresh one), compares the WHOLE built tree
  across two builds instead of two bundles, fails on packed artifacts that have
  no current `src/` counterpart, and enforces package.json ↔ package-lock root
  version identity. `verify:workflows` now requires the refuse-republish step's
  real body (`gh release view` / `gh release delete` / `exit 1`), the
  dry-run skip on both release-mutation steps, a `# vX.Y.Z` comment on every
  SHA pin, and both step names for the gate-before-mutation ordering.
  `verify-client-artifact` drives the registered-tools notice lane in the packed
  bundle (definition, match rule, keyed view and a rendered row), so a dropped
  registration fails the release gate instead of passing silently.

- **The MCP tool row's expand chevron is now the shipped icon geometry.** The
  hover/open affordance was a private 24-unit stroke path whose ink weight did
  not match the official rows; it now inlines `IconChevronDownOutline14` from
  the pinned `ui-primitives` set byte-for-byte (a filled 14-unit path), so the
  row swaps in the same mark the shipped disclosure rows use. No test or packed
  artifact assertion referenced the old geometry (`verify-client-artifact` pins
  the plug path only), and the built bundle carries the new path unchanged.
- **The wireframe and `docs/design.md` are re-aligned.** The figure title now
  carries its version note (0.0.3 baseline; the 0.0.4 increments are not drawn),
  `docs/design.md` gains *Differences from the wireframe* — the seven decided
  figure-vs-code gaps, each resolved in the code's favour — and *The two lanes
  at a glance*, the tool-row and registered-tools-notice anatomy with the rules the
  lane derives. The glyph comment no longer claims the shipped set is authored
  on a 24-unit canvas (its marks are mostly 14/16-unit filled paths) or that the
  chevron already followed the shipped rows.
- **The section header no longer carries a global refresh button.** The runtime
  snapshot already re-reads once per settings-document revision, polls every 5 s
  while the panel is visible, and each card refreshes its own server; a failed
  full refresh surfaces the stale banner, whose Retry is now the only
  whole-table manual refresh. The wireframe keeps drawing the baseline button
  and `docs/design.md` records the removal as a deliberate gap. The acceptance
  suite pins the new header contract (Add/Cancel only), the per-card refresh and
  the banner's single full refresh.
- **The settings sidebar shows the plugin's own plug mark.** The settings shell
  picks a section's nav glyph from a hardcoded map by id and falls back to its
  settings gear for ours — both supported generations do, and the
  `settings.section` registration carries no icon option — so the browser half
  paints the repo's plug glyph into its own nav row: the row is matched by the
  localized `nav` label and accepted only in the shell's own shape, the shell
  glyph's class rides along so sizing and colour stay shell-owned, and a
  re-render or a locale flip repaints. Anywhere the DOM shape differs the patch
  is a no-op and the shipped gear stays.
- **The card's four actions are one capsule again — one frame, and only the
  destructive one is red.** Edit, Remove, Disconnect and Test share the official
  `.sm` outline recipe (h28 / r14 / `0 10px` / 12-18, transparent fill, the
  neutral 0.5px hairline frame, one hover tint); the destructive action differs
  by its LABEL colour alone (`state-error-primary`), so the group reads as one
  control group instead of mixed border weights. The plain danger treatment
  inside the confirm dialog and the staged form is unchanged.

## [0.0.3] - 2026-09-15

Runtime-visibility and configuration-completeness line. The original locked
scope cut server status, pause and on-demand connect (`docs/acceptance.md`
C3-C5); on request this line supersedes those cuts using the same framework
seams the shipped features already use - a sparse `disabled` map in the
settings document, per-server timeouts, and three JSON routes on the
Connection carrier. No new remote namespace, no new runtime dependency, no
chamber-side change: the routes ride the same `/api` surface the gateway
already proxies.

### Added

- **Global enable switch.** A sparse `disabled: { [serverName]: true }` map on
  the settings document turns one server off everywhere without deleting it: a
  disabled server is never supervised, its tools are revoked from every live
  agent, and re-enabling starts it fresh. The card header carries the switch
  and the draft form the same flag; because it is a flat sparse map, one toggle
  is ONE atomic path op (`set/unset ['disabled', name]`) that leaves the
  `servers` array and hand-written comments untouched.
- **Per-server timeout (`timeoutMs`).** Bounds 1000-600000 ms, applied to
  `tools/call` and one `tools/list` page; absent = the official 60 s default.
  Validated by the schema and the shared document validator.
- **Runtime status and manual connection control.** The host half now exposes
  `GET /api/mcp-scope.status`, `POST /api/mcp-scope.action` and
  `GET /api/mcp-scope.tools` through `ctx.connection.fetch.register` - the same
  carrier the official `/api/present.host` and `/api/session.export` features
  use - with the Host/Origin fence, browser authentication and the chamber
  gateway proxy applied unchanged. The supervisor reports a bounded snapshot
  (phase, attempts, next retry, timestamps, tool count, sanitized error); the
  response carries only a fixed host-generated code + message (spawn-failed,
  timeout, forbidden, protocol, gave-up, reconnect-disabled, generation-stuck,
  connection-failed) - the raw transport text stays in the host log, because
  remote bodies can echo a credential in an encoding an in-process substring
  pass cannot catch. The settings card shows the status dot/label, a localized
  failure line, Connect/Disconnect and Test; Test is a throwaway probe unless
  the server is already connected, in which case it reports the live generation
  read-only (no second process/connection).
- **Tool list on demand.** `GET /api/mcp-scope.tools?server=NAME` returns the
  synced tool identities (public + raw name, description) capped at 200 entries
  with per-field caps and no schema bodies. The card discloses them under a
  `Tools (N)` button; an unsynced server reports `not-connected` instead of an
  error.
- **Manual-stop latch.** Disconnect is a first-class state (`stopped`): it
  revokes the server's tools immediately and survives settings commits that do
  not change the definition; editing the definition or pressing Connect clears
  it. Reconnect-budget exhaustion surfaces as `failed` with the reason.
- **Configuration completeness.** The draft form gained an enable switch, the
  timeout field, an unsaved-changes guard on every dismissal path, clipboard
  paste for commands / `.env` / header lines, and a single-server JSON import
  (`mcpServers`, opencode and flat shapes; imported secret values land in the
  write-only inputs only). The section gained a name filter and the card
  all-on / all-off workspace switches, all batched into one revision-fenced
  mutation.

### Changed

- `docs/acceptance.md`: C3 (server-status visualization), C4 (on-demand
  connect/reconnect) and C5 (pause key) are superseded by this line and moved
  into an explicitly extended-scope section with their proofs.
- The card header layout now starts with the enable switch; the status row sits
  under the header and the bulk workspace switches sit with the rows.

### Fixed

- `overrideDoc` dropped the `disabled` map, so a per-workspace toggle (single
  or all-on/all-off) silently cleared every global off-switch and reported a
  false conflict. Regression tests cover the combination.
- Connect on a server whose reconnect budget was exhausted was a no-op while
  returning `connecting`; the handle is now disposed and restarted.
- A supervisor whose failed generation did not close within the 5 s bound
  reported `connecting` forever; it now reports `failed` with the
  `generation-stuck` code. `dispose()` also clears the armed retry timestamp,
  and a successful reconnect resets the consecutive-failure counter.
- `toolList` answered `200 {tools: []}` for a never-synced or down server
  instead of `409 not-connected`; the action route echoed the requested server
  name and accepted names outside the documented contract (2 KB reflection).
- `classifySaveError` treated any message containing "expected" as a conflict;
  `splitCommandLine` ate backslashes in unquoted Windows paths; an
  out-of-range timeout left Save dead with no message.
- The card's runtime error line localizes the host code; runtime actions report
  real pending labels and join the card's busy state; Test reports
  "Test OK - N tools"; the tool table refetches per sync generation and shows
  the true total.

### Evidence

- 250 unit/integration tests across 17 files; the supervisor snapshot/probe
  suite, the manager runtime-control suite and the route envelope suite are new.
- `npm run check` (typecheck x2, tests, build, `verify:package`) green; the
  artifact gate drives the built `lib/client.js` in jsdom and still asserts
  react-only bundle purity and determinism.
- Live smoke re-run 2026-09-15 on the current anchor (dsh 0.1.5-rc.2):
  `npm run test:smoke` (`M1` + `M0`) exit 0 with `dsh-chamber-mcp@0.0.3`
  installed through the anchor CLI; the M1 run captured the per-workspace
  model-facing tool list — **R3 PASS** (`mcp__fixture__*` on the enabled
  workspace's turn, none on the disabled one).
- Style conformance re-verified against the vendored pinned dsh theme: 368
  declared `--dsw-*`/`--dsh-*`/`--ds-*` names, 29 referenced by this
  stylesheet, 0 undeclared; S2–S7 and the class-map/CSS coverage gates green;
  the new 8 px status dot matches chamber's dot geometry.

## [0.0.2] - 2026-09-14

Upstream compatibility release. The plugin was migrated to the **dsh 0.1.5**
generation (npm `latest`) and audited end-to-end against it — host half and
browser half — with no API adaptation required beyond the client type surface;
the line then grew the 0.0.2 documentation/UX work, the MCP transcript lane, and
the verification hardening that followed two adversarial review rounds.

### Added

- **MCP calls get their own transcript row.** The browser half now owns how MCP
  tool calls render, through one keyed `tool.call.toolview` registration per
  discovered tool name: a plug mark, a `serverName · toolName` title with a
  `stdio` / `http` transport tag, and an expandable body with the raw arguments
  and the rendered result. Running and settled calls are deliberately different
  — running carries the sweep treatment, a primary title and `aria-busy`;
  settled drops the animation and shows its duration; a failure takes the error
  token on icon, title and summary; an interrupted call is marked as stopped.
  The name set is discovered from the staged session's own event window — every
  `request/header` (the model-facing tool array) **and** every `tool/call`
  (its own wire name). Both sources are load-bearing: the window is a bounded
  tail page of the session log while headers are emitted at loop boundaries
  rather than per turn, so a call can outlive its describing header and still be
  registered. The lane therefore needs **no host API**, adds **no runtime
  dependency** (both glyphs are inline SVG and the built bundle still requires
  only react/react/jsx-runtime), and degrades to the shipped generic row
  whenever a name is unregistered or past the 256-entry registration cap. Every colour is a `--dsw-*` alias token and every size
  mirrors the shipped row metrics. Evidence: `tests/client/tool-card.spec.tsx`
  and `tests/client/tool-register.spec.ts`, plus
  `scripts/verify-client-artifact.mjs` — run by `verify:package`, it drives the
  BUILT `lib/client.js` through the loader wrapper in jsdom and asserts the
  registrations, both state treatments and the click-to-expand interaction; that
  gate now also asserts client-bundle purity on the packed build. The live
  M0/M1 smoke re-run at HEAD against the scratch 0.1.2-rc.1 anchor (with freshly
  wiped scratch homes, see Fixed) confirms the boot graph still accepts the
  plugin — install `exit=0`, the profile gains `dsh-chamber-mcp`, its inventory
  row reads `enabled:true, fiberPhase:"active"` — and that the model-facing tool
  list carries `mcp__fixture__echo` / `mcp__fixture__env_report` in the enabled
  workspace while the disabled workspace's turn carries none.
- **Concurrency, hot-reload and hand-editing coverage.** New regression tests
  pin what was previously design-level only: several servers running at once
  (one supervisor each, a server joining while others are live, removal
  touching only the removed one) and two servers' tools coexisting in one
  workspace scope — including the same raw tool name — with per-(workspace,
  server) gating; plus the settings document's hand-editing contract (a
  hand-written document loads at boot, an external edit is published live, an
  edit that breaks the cross-field rules is not published and the last good
  document stays in effect). README gains a "Where the configuration lives"
  section: document path and YAML shape, credential refs vs values, and the
  hand-editing rules.

### Changed

- **Toolchain migrated to the dsh 0.1.5 line.** Every `@deepseek-ai/dsh-*`
  devDependency moves from `0.1.2-rc.1` to **`0.1.5-rc.2`** — deliberately the
  *resolved internal generation*, not the umbrella's own `0.1.5-rc.1`: a
  `dsh@0.1.5-rc.1` install resolves its internal caret ranges to `0.1.5-rc.2`
  (230 of 231 packages), and pinning the umbrella's literal version is
  internally inconsistent because upstream's own rc.1 peers pull rc.2
  artifacts. That set is now the compile-time API surface and the CI guard;
  rc.1 and rc.2 were both verified.
- **`--legacy-peer-deps` is gone.** With the whole `@deepseek-ai/*` devDep set
  on one generation the peer graph is self-consistent, so `npm install` and
  `npm ci` resolve unaided and CI dropped the flag. It had been needed first
  for the `dsh-client-runtime@0.1.1-rc.2` ↔ `dsh-agent` cross-line conflict and
  then for the rc.1-pin conflict above. The single-generation pin resolves
  both at the source.
- **Client half re-pointed at the 0.1.5 client contracts.** `ClientContext`
  (`dsh-client-runtime`) → `Context` from `@deepseek-ai/cordis`, which is the
  client context type upstream client plugins use; the local `FiberAwareContext`
  structural patch for `ctx.effect` is gone (cordis declares it). The workspace
  list type moves from `WorkspaceListState` to `WorkspaceSnapshot`
  (`@deepseek-ai/dsh-api-workspace-controller/client`), and `ctx.slots` is now
  merged from `@deepseek-ai/dsh-client-ui-renderer/client` — the package that
  owns the slot registry in 0.1.5. `WorkspaceView` structurally satisfies the
  narrow row type, so a cast went away with it.
- **Three off-train devDependencies dropped.** `dsh-client-runtime`,
  `dsh-client-schema-form` and `dsh-client-web-react` stopped publishing at
  `0.1.1-rc.2` / `0.1.0-rc.7` and never had a 0.1.2 or 0.1.5 release; only the
  first was still referenced (for types, now replaced). Removing them deleted
  101 packages from the lockfile — almost entirely the unused
  `dsh-client-web-react` markdown/katex/shiki tree. `dsh-http-proxy` (a new
  0.1.5 peer of `dsh-subprocess`, imported by its `lib/index.js` at load) and
  `dsh-api-workspace-controller` were added.
- **`dsh.client.inject` completed.** The browser half calls `ctx.slots` and
  `ctx.workspaces`, so `dsh-client-ui-renderer` and `dsh-api-workspace-controller`
  are now named there alongside the three existing edges. In 0.1.2 both
  services came from the client runtime and had no row of their own; in 0.1.5
  each has an explicit client package, and upstream's own convention (e.g.
  `dsh-client-locale` injecting the four packages whose services it uses) is to
  name them.
- **Client bundle externals re-derived from the 0.1.5 frozen platform table**
  (`PLATFORM_MODULES`). The previous list named four packages that are not
  platform modules in 0.1.5 and were never imported; the list now mirrors the
  table verbatim, so an accidental import of a non-platform module fails the
  build instead of producing a bundle the loader cannot resolve.
- **Peer window widened** to `^0.1.2-rc.1 || ^0.1.5-rc.1` for the eight
  `@deepseek-ai/dsh-*` peers. The previous `^0.1.2-rc.1` cannot match the
  0.1.5 line: semver's prerelease rule only lets a prerelease version satisfy a
  comparator with the *same* `major.minor.patch`, so `0.1.5-rc.2` failed it and
  pnpm printed "Issues with peer dependencies found" on every install. The
  range is purely declarative — dsh profiles install with
  `autoInstallPeers: false` and resolve plugin peers by NAME from the dsh
  install's module-fallback farm (`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`),
  so nothing was broken by the old range; the install log now matches the
  documented support window.

- **Settings-page styling aligned with the dsh design system.** The MCP section
  no longer renders raw controls with inline styles and literal colours: it
  ships one token-only stylesheet (`src/client/styles.ts`, injected under the
  official `style[data-plugin-css]` convention) whose values mirror the pinned
  design system — `ui-primitives` Button/Tag/Pill/Switch geometry, the
  settings-panel card and editing-surface fills, the official field
  vocabulary — so the section reads as part of the panel in both themes
  (mapping table in `docs/design.md` §9).
- **Workflow actions are pinned to commit SHAs.** Every `uses:` in `ci.yml` and
  `release.yml` now names a 40-hex commit (`actions/checkout@v5.1.0`,
  `actions/setup-node@v5.0.0`, `actions/upload-artifact@v6.0.0`,
  `softprops/action-gh-release@v3.0.3`) instead of a moving major, and the
  temporary allowlist in `scripts/verify-workflow-action-pins.mjs` is empty —
  the condition that script documented ("replace it once SHA resolution is
  possible") is met. Pins are bumped by hand (Dependabot stays disabled).
- **Documentation consolidation.** The root `README.md` is restructured around
  the reader's path — install, use, what the model sees (injection semantics,
  tool naming, context-meter footprint), document format and hand-editing,
  uninstall, the official-client comparison, compatibility, security/trust
  model, troubleshooting and development — and `docs/README.md` becomes a
  linked index. Release and install examples are
  version-generic, `docs/RELEASE.md` gains a runnable pre-tag checklist and the
  list of version-bearing docs to update with a release, and
  `.github/workflows/release.yml` drops `--legacy-peer-deps`, so the release gate
  resolves exactly like CI.

### Fixed

- **`tools/list` pagination could spin forever.** A server repeating a
  `nextCursor` made the sync loop re-fetch the same page indefinitely, so the
  server never committed a tool generation. Every followed cursor is now
  recorded and a repeat rejects the sync as an invalid tool list (the previous
  generation stays registered), matching the guard the official
  `dsh-mcp-client` bridge added in the same upstream release.
- **A server could still stall the sync with unlimited FRESH cursors.** The
  duplicate-cursor guard does not bound pages that carry no tools while minting
  a new cursor each time: no name repeats and no tool accumulates, so neither
  the duplicate guard nor `MAX_SYNC_TOOLS` ever trips. One sync is now capped at
  `MAX_SYNC_PAGES` (= `MAX_SYNC_TOOLS`) `tools/list` requests. One page per tool
  is already pathological, so no legitimate server is restricted by this — the
  regression test without the cap exhausts the V8 heap.

- **The MCP row now follows the Settings font-size axis.** Its title, summary and
  duration read the shipped `--dsh-content-font-size-secondary` /
  `--dsh-content-font-delta` tokens (with the shipped defaults as fallbacks)
  exactly as the shipped tool rows do; the previous fixed `13px/24px` froze the
  row at the default size. The style-token whitelist test knows both tokens.
- **The live-smoke drivers were reusing their scratch homes.** `scripts/smoke/m0.mjs`
  and `m1.mjs` created their scratch `$DSH_HOME` but never wiped it, so a run
  inherited the previous run's profile: once the package rename and version bump
  moved the packed tarball, the stale profile dependency pointed at a file that
  no longer existed, the install phase failed with ENOENT — and the M0 driver,
  which only *logged* the exit status, carried on against the OLD installed
  package (so its "after install" evidence proved nothing). Both drivers now
  delete their scratch home and workspace dirs before booting, M0 fails the run
  on a non-zero install or a profile that did not gain the bundle, and both hand
  `dsh plugin add` a controlled environment (PATH, the DSH home contract and
  proxy/CA settings) instead of inheriting the invoking npm's config channel:
  the run that failed had inherited it, and a wiped scratch home is exactly the
  case where the profile's pnpm must fill its store from scratch. Every run
  since — through `npm run test:smoke`, the documented entry point — passes.
  The same class of failure survived in the *tarball*: the drivers packed only
  `if (!existsSync(TGZ))`, so a `.smoke/*.tgz` left by an earlier revision (same
  name, same version) was installed and the run reported green against old code.
  Both drivers now pack from the working tree on **every** run, install and boot
  through the **anchor CLI** (so the run is one generation — the chamber's, read
  at run time rather than assumed), assert the installed package version equals
  the working tree's, and record the anchor version, tarball path and installed
  artifact in the transcript.
- Credential pills, cards and the form no longer widen the settings column when
  a header name, credential ref or working directory is long: the pill shrinks
  and ellipsizes (with `title` fallbacks) and path-like copy wraps.
- Row-level validation now marks the offending input (error border +
  `aria-invalid`), not just the problem list under it.
- **The live-smoke driver works end to end again.** `scripts/smoke/m0.mjs`
  referenced an undeclared `PKG_NAME` (the M0 driver died at startup) and now
  derives name/version from `package.json`; `scripts/smoke/m1.mjs` recorded the
  plugin install as `exit=undefined` because it read `.status` off an
  `execFileSync` stdout string — it now uses `spawnSync`, records a real exit
  status, and fails the run when it is non-zero; the stdio fixture
  (`scripts/smoke/fixture/echo-server.mjs`) no longer hard-codes the authoring
  box's absolute SDK path, so `npm run test:smoke` is runnable outside that one
  checkout.
- `scripts/release-notes.mjs` tracks fenced code blocks, so a `## ` line inside a
  fence can no longer truncate the composed release body, and `--out` creates
  missing parent directories instead of failing with a raw ENOENT.

### Security

- Pagination is now bounded in both dimensions: a repeated cursor and an
  unbounded page count each fail the sync. A hostile MCP server could
  previously hold a supervisor in an endless `tools/list` request loop with
  either trick, driving unbounded network work and memory growth.

- **Smoke transcripts can no longer capture a dsh launch token.**
  `scripts/smoke/instance.mjs` masks `token=…` where child output is echoed or
  logged (`dsh web` prints a fresh per-process token on every boot, and that
  token authenticates the instance's whole Host API and WebSocket surface). The
  two values that had reached the repository are fully purged: the committed
  transcript is redacted, the 23 gitignored `.smoke/**/*.log` transcripts were
  scrubbed, and history was rewritten so no commit or object in this clone still
  contains them, and the rewritten history was force-pushed so the public remote
  serves the purged history — verified from a fresh clone.

### Compatibility

- Peer ranges stay `^0.1.2-rc.1 || ^0.1.5-rc.1`: the surface this plugin calls
  is byte-identical or additively changed across the two generations, and the
  migrated build was live-verified on **both** (the 0.1.5 line and the
  0.1.2-rc.1 anchor, which was the chamber's generation at recon and first
  release). CI guards the 0.1.5 set only.
- Verification for this release: `npm run check` PASS (typecheck, **185 tests /
  14 files**, build, package verification — 36 packed entries, consumer d.ts
  check, client-bundle purity, the jsdom artifact check of the shipped browser
  half, deterministic rebuild) plus a live smoke run that **packs from the
  working tree, installs and boots through the chamber anchor CLI** (`dsh
  0.1.5-rc.2` — the gateway moved to 0.3.0 during this line, so the anchor and
  the pinned generation now coincide) —
  per-workspace `mcp__<server>__*` injection captured from the model-facing tool
  list (R3 PASS), and the browser half fetched from `/plugins/`, evaluated under
  the frozen platform table, and driven through `apply()` against the real
  service contracts (dictionaries, settings scope, `settings.section`
  registration, both remote subscriptions all reached). Both checks were run
  again after the `dsh.client.inject` change, which alters the boot graph row.
- The live smoke itself is now trustworthy: the drivers wipe their scratch homes,
  pack from the working tree on every run, install and boot through one anchor
  generation, and fail the run if the install exits non-zero, the profile misses
  the bundle, or the installed version differs from `package.json` — and each
  transcript records the anchor version, tarball and installed artifact.

## [0.0.1] - 2026-09-06

First functional release of `dsh-chamber-mcp`, a standalone third-party dsh
plugin: MCP servers managed per workspace from the dsh Settings UI, with tools
injected into the tool scopes of enabled workspaces only.

### Added

- **Repo conventions** (aligned with dsh-chamber norms): workflow action-pin & release-structure
  verification (`npm run verify:workflows`), tag pushes run the same CI
  chain, serialized publication with a refuse-existing-release guard,
  dry-run dispatch mode, tgz `.sha256` sidecar, PR template, AGENTS.md,
  built-entry import probe in `verify:package`. Dependabot is disabled by
  maintainer choice.
- **Release mechanics**: tag-driven GitHub Release shipping the packed
  `dsh-chamber-mcp-<version>.tgz` as its asset, release notes composed from this
  changelog (`scripts/release-notes.mjs`); npm publishing temporarily disabled
  — `dsh plugin add <asset-url>` is the install path.
- **Package & installation**: one npm package (`dsh-chamber-mcp`) as a dsh
  bundle + dual-face plugin — `dsh plugin --profile web add dsh-chamber-mcp`
  (or `file:<tgz>`); single loader row `mcp-scope`; zh/en locales; MIT with
  upstream attribution.
- **Host half**: settings-namespace document (`mcp-scope`: `servers` +
  per-workspace `overrides`, default-on semantics, revision-fenced writes);
  per-server supervisors mirroring the official `dsh-mcp-client` contract
  (mcp__ naming with collision hash, generation-swap sync, `tools/list_changed`
  re-sync, scrubbed child env, backoff reconnect, 5 s close discipline);
  stdio and streamable-http transports; credential refs resolved per connect
  from the write-only credentials domain.
- **Per-workspace injection gate**: tools are registered per agent scope
  (never globally) for live agents whose session cwd belongs to an enabled
  workspace; new servers and workspaces default to on; delegation children
  (`origin: 'subagent'`) are excluded by design (preset-governed).
- **Browser half**: Settings "MCP 服务器 / MCP servers" section (nav order
  25): server cards with definition details and per-workspace on/off rows,
  staged add/edit forms with write-only secret rows, removal cascade for
  orphaned credentials and override rows, tri-state credential badges,
  workspace-list loading/error phases, role=alert/status outcome feedback.
- **Operational evidence**: hermetic unit/integration suite (real ToolRuntime +
  real dsh-scope contexts, real settings-file provider, real stdio MCP
  fixtures), CI workflows (Node 24 gate + package verification), live M0/M1
  smoke drivers incl. the remote-mux session activation that captures the
  assembled model tool list per workspace (R3 PASS).

### Changed

- Toolchain target moved to **Node ≥ 24** (engines, CI matrix, `.nvmrc`).
- Client entry inject surface aligned with the rc.1 runtime
  (`remote.credentials`); error classification is typed-code first; document
  writes are verified by read-back (a refused write is reported as a conflict,
  never as success).
- Host entry re-exports the public model types for typed consumers.

### Fixed

- Plugin teardown never stopped live supervisors (dispose deleted bookkeeping
  before stopping); teardown now stops and revokes everything.
- A restarted server's first sync could be absorbed by the old handle's
  idempotence key — dedupe now keys on (epoch, syncId).
- Reconcile performed a blanket re-registration on every settings change —
  now a diffed pass (no-op reconciles register nothing).
- Workspace membership was frozen at agent adoption — now re-derived per
  push/reconcile and on durable workspace-domain change events, so deleted
  workspaces/directories revoke promptly.
- A credential restart queued while the server was removed from the document
  could strand live tools — restarts judge presence live and revoke.
- Removing a server left orphaned per-workspace off-switch rows (re-add
  resurrected as off) — removal now prunes them.
- Refused saves could silently report success and orphan newly written
  secrets — landed-write verification + new-ref-only cleanup with a
  concurrent-writer guard.
- `__proto__`-style server names could break the off-switch semantics —
  reserved override keys are rejected everywhere.

### Security

- Header/env credential values containing CR/LF/NUL are rejected at the
  transport boundary (no header injection, no secret echo in logs); log sinks
  sanitize error text.
- HTTP header names and env-key elements are validated at schema, document
  and UI level (RFC 9110 field-name tokens).
- `tools/list` pagination is bounded (`MAX_SYNC_TOOLS = 2000`); a server
  exceeding the cap fails the sync while the previous generation stays.

<!--
Release notes are composed from the section of the released version, so each
release must add a dated section here before tagging (scripts/release-notes.mjs).
Once a public repository URL exists, append comparison links, e.g.:
[<next-version>]: https://github.com/<owner>/dsh-chamber-mcp/compare/v<previous>...v<next-version>
-->