# Security review — dsh-mcp-scope

Reviewer: security-review subagent. Method: read-before-claim on every file below, plus
focused experiments run with Node v22.22.3 (`/root/.nvm/versions/node/v22.22.3/bin`),
repo tests (`node node_modules/vitest/vitest.mjs run …` — transport/model/controller suites
green, 39/39), and inspection of live smoke artifacts under `.smoke/`. Evidence format:
`file:line` + quotes. Each claim below is marked **verified** (code/experiment/artifact) or
**assumed** (stated as such).

Reviewed sources: `docs/design.md`, `docs/acceptance.md`, `docs/host-notes.md`,
`docs/ui-notes.md`, `docs/recon/core-apis.md` (§2, §6), `docs/recon/runtime-test-env.md`,
`docs/recon/chamber-bridge.md`, `src/{index,manager,server,agents,tools,transport,schema,workspace}.ts`,
`src/shared/model.ts`, `src/client/{index,controller,section,server-card,add-form,locales,workspaces}.tsx|ts`,
official references `~/projects/dsh-chamber/ref-dsh/packages/subprocess/subprocess/src/index.ts`,
`ref-dsh/packages/mcp/mcp-client/src/{index.ts,transport.ts}`,
`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/{dsh-subprocess,dsh-credentials,dsh-credentials-local,dsh-settings,dsh-settings-file,dsh-api-settings-controller,dsh-mcp-client}/…`,
and installed `@modelcontextprotocol/sdk@1.30.0` (`dist/cjs/client/{stdio,streamableHttp,index}.js`,
`dist/cjs/shared/{protocol,stdio}.js`).

---

## 1. Summary verdict

**No critical or major findings.** The plugin is a faithful, well-contained mirror of the
official `dsh-mcp-client` execution model, and it is *better* than the official plugin on
secret-at-rest hygiene (official stores env/header values **literally in its config schema** —
anchor `dsh-mcp-client` `lib/index.js`: `env: z.dict(String).default({})`, `headers:
z.dict(String).default({})`, no `role('secret')` anywhere; this plugin stores only ref **names**
in the settings document and keeps values in the credentials domain).

All findings below are **minor/nit** and live inside one trust boundary:

> **Threat model.** A principal who can write the `mcp-scope` settings namespace **is** the dsh
> instance's administrator for all practical purposes. In the rc.1 anchor model used by the
> chamber gateway deployment, `/api` requires an authority-bound HttpOnly cookie minted from the
> launch token (`GET /?token=…` → 303 + cookie; no cookie → 401; off-loopback Host/cross-site →
> 403; recon `runtime-test-env.md` §6, `chamber-bridge.md`). In the rc.2 CLI model the same
> surface is fenced by the browser-trust Host check plus a **loopback-only** privileged method
> subset that includes `settings.*` and `credentials.*` (`runtime-test-env.md`: "A privileged
> subset (`settings.*`, `credentials.*`, …) is additionally **loopback-only**"; the managed web
> instance is spawned `--host 127.0.0.1 --trusted-host 127.0.0.1:<port>`, `chamber-bridge.md`).
> Within that fence, a namespace writer can already (a) run arbitrary commands as the dsh OS
> user via `servers[].command` (stdio), and (b) **read any credential whose ref name they know**
> by pointing a streamable-http server at their own endpoint with header rows / env keys naming
> that ref (resolution happens host-side at connect; §4.1 of recon `core-apis.md` "resolve per
> operation"; the credential ref space is global and name-addressed across plugins). (a) is
> inherent to the feature and identical to official mcp-client (`cordis.yml` `command`/`args`
> spawn the same way, ref-dsh `mcp/mcp-client/src/transport.ts:31-49`); the UI discloses it
> (`add.commandUserHint` "This command runs as this dsh instance's user.", `locales.ts:70,156`).
> (b) is a *documented-model* consequence of moving secret values into a shared, name-addressed
> credentials domain — it should be called out in the UI/README (see SEC-10). Anything that can
> already pass the fence is trusted; **malicious MCP servers themselves** (a spawned stdio server
> runs as the dsh user; a remote one can send tool content/errors) are out of scope — that is
> the feature being configured. No finding assumes an attacker beyond this fence.

Within that boundary the review found no shell-injection path, no env leak of `DSH_*`/secret
shaped ambient variables, no raw-secret persistence in the settings document, no stored-value
echo to the browser, and no unbounded reconnect loops. Details below.

---

## 2. Findings

| ID | Severity | Location (evidence) | Issue |
|---|---|---|---|
| SEC-01 | minor | `src/client/controller.ts:451-453, 458-468, 137-144` | Auto-unset cascade operates on a **global, cross-plugin credential namespace** and on a stale doc snapshot — can delete another owner's stored value; TOCTOU window with concurrent writers |
| SEC-02 | minor | `src/transport.ts:70-86`; `src/server.ts:342, 374` (SDK 1.30 behavior, experiment) | Stored secret values containing CR/LF (or NUL) are echoed **verbatim into host logs** via SDK/Node error strings on every failed attempt; HTTP error text can also carry remote-reflected content |
| SEC-03 | minor | `src/shared/model.ts:14, 55-58`; `src/client/controller.ts:33-44` | `serverName` `__proto__` passes validation; presence-semantics OFF switch (plain-object own-key model) breaks: UI view, host doc, and prune paths disagree → silent ON/OFF divergence the UI cannot display or repair |
| SEC-04 | minor | `src/manager.ts:94-98, 140-157, 184-206` | No debounce/rate-limit between each settings commit / credential event and a full process stop+start — a flapping writer causes unbounded (serialized) process churn |
| SEC-05 | minor | `src/tools.ts:124-144`; `src/agents.ts:168-208` | `tools/list` pagination is unbounded (infinite-cursor server ⇒ unbounded defs memory); official-mirrored, but registration here is per-agent (amplified cost vs official global registration) |
| SEC-06 | nit | `src/schema.ts:38-40, 27-30`; `src/shared/model.ts:96-117` | Schema itself does not pattern-check `envKeys` elements or header **names** (only the write-time `validateDoc` hook does) — a boot/user-layer `settings.yaml` bypasses the hook; names/values with newlines reach log lines (same-trust forgery) |
| SEC-07 | nit | `src/client/controller.ts:430-445`; `src/client/add-form.tsx:359-378` | Partial secret writes can outlive a failed doc write (orphaned literals) and are silently adopted by a later same-ref add ("blank = keep stored" semantics not shown on env rows) |
| SEC-08 | nit | `src/schema.ts:45`; `src/transport.ts:116-119`; `src/server.ts:61-84` | No length caps anywhere (doc/arrays/strings) and no host-side URL scheme check; misconfigurations surface only as bounded failed attempts (SDK 60 s request timeout, 10-attempt give-up) |
| SEC-09 | nit | `src/agents.ts:129-139, 250-266` | `entry.workspaceId` is resolved once at agent adopt; workspace deletion while an agent lives leaves tools applied (registry has no subscription API; no revoke listener possible) |
| SEC-10 | nit | `src/client/locales.ts:66-70`; README | UI discloses "runs as the dsh user" but nothing discloses that (i) any configured header/env ref is resolved **by name from the shared credentials domain**, or (ii) servers default **ON in every workspace** at the injection layer, or that removal cascades `unset` shared refs |

---

### SEC-01 — Removal cascade unsets credentials in a global, cross-plugin namespace (minor)

The credentials *reference* space is one global, name-addressed store shared by every plugin
(recon `core-apis.md` §2.1: `CredentialRef` = env-var name; §2.3: single
`$DSH_HOME/.credentials.yaml` "never materialized into the environment"; a value set by any
plugin UI under the same name is visible to all). The controller's orphan computation is
**doc-local**:

- `controller.ts:137-144` — `orphanedRefs(prev, next)` diffs only this plugin's own document;
- `controller.ts:451-453` — after the doc write commits, `unsetQuietly(plan.unsetRefs)` runs
  `credentials.unset(ref)` best-effort;
- `controller.ts:458-468` — refusals swallowed ("Best effort: an unset refusal … must not fail
  an already committed removal").

Consequences, both real:

1. **Cross-plugin/value clobber.** If a stored value under a shared name (e.g. a ref also used
   by another plugin or by this plugin's other servers through the same name) exists, and this
   plugin's *own* document stops referencing that name, the cascade `unset`s it — the other
   owner loses the value with no doc-level signal. The UI confirm copy only scopes it to this
   plugin's servers (`server.removeConfirmBody`, `locales.ts:34`: "Credentials that no remaining
   server references are cleared as well.").
2. **TOCTOU with concurrent writers.** `unsetRefs` is computed from the snapshot taken *before*
   the mutation (`submitPlan(base, …)` at `controller.ts:379, 446`). Between the revision-fenced
   commit and the best-effort unsets (a network round trip each), a concurrent client can add a
   server that re-uses the same ref name and stores a fresh value — the stale unset deletes it.
   (The credentials domain cannot distinguish owners; even a re-read before unset only narrows
   the window.)

**Fix options (pick one):** drop the auto-cascade and make credential clearing an explicit user
action (the card already has per-ref "Clear"); or, keep the cascade but (a) re-read the live
document immediately before unsetting and skip refs that are referenced again, and (b) document
that unset targets the shared name space (and prefer matching on values the plugin itself last
wrote — not possible today, so explicit-clear is the honest fix).

### SEC-02 — Resolved secret values can be echoed verbatim into host logs (minor)

Verified with Node 22: `new Headers({ 'X-A': 'a\r\nX-B: injected' })` throws
`TypeError: Headers.append: "a<CRLF>X-B: injected" is an invalid header value.` — the error
message **embeds the raw header value including the CRLF**. The SDK's streamable-http transport
builds `new Headers({...})` from `requestInit.headers` on every request
(`dist/cjs/client/streamableHttp.js` `_commonHeaders()`), so a stored credential whose value
contains CR/LF throws inside `send()` → `Client.connect` rejects → supervisor logs:

- `src/server.ts:342` — `log.warn(\`${label}: connection attempt failed: ${String(error)}\`)`
  (per attempt), and
- `src/server.ts:374` — `log.warn(\`${label}: initial connection or tool synchronization failed: ${String(error)}\`)`.

The raw stored value therefore lands in the host log (with an embedded newline — also a
log-line-forgery vector) up to the 10-attempt give-up. Same class for stdio: an env *value*
containing NUL makes Node throw synchronously at spawn, and the throw's message includes the
env entry (`TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.env['BAD_VAR']' must be a
string without null bytes. Received 'a\x00b'` — verified; the value is escaped there, but the
key name is not the only echoed text). Separately, HTTP error text logged via `String(error)`
can contain the remote server's response body (SDK `StreamableHTTPError(…, \`Error POSTing to endpoint: ${text}\`)`)
— a malicious/reflecting endpoint could inject log content or cause a secret it received to be
re-logged.

The credentials store itself does not reject CR/LF (only empty values are rejected —
anchor `dsh-credentials-local/lib/index.js` `set()`: "an empty value cannot be stored"),
so a user can store such values through the UI today.

**Fix:** reject/skip resolved env and header **values** containing `[\r\n\0]` inside
`resolveServerEnv`/`resolveServerHeaders` (`transport.ts:55-61, 78-84`) with a warn that names
the ref only; additionally sanitize control characters in error strings at the supervisor log
sinks (`server.ts`). Note: our test fixture intentionally returns `process.env.PROBE_TOKEN`
as tool output (`tests/fixture/mcp-fixture-server.mjs:103-108`) — test-only, never shipped
(§7).

### SEC-03 — `serverName: "__proto__"` silently corrupts the OFF-switch (minor)

`SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/` (`model.ts:14`) admits `__proto__`
(letters+underscores, ≤32). The enablement model is *own-key presence* on plain objects
(`isEnabled`, `model.ts:55-58`: "no record ⇒ enabled"). Verified JS semantics:

- `rest['__proto__'] = true` on `{}` is a **silent no-op** (inherited accessor setter, primitive
  value);
- `JSON.parse('{"__proto__": true}')` produces an *own* data property;
- reading `row['__proto__']` on a row **without** an own key returns `Object.prototype` (≠
  `undefined`), so `isEnabled` treats the server as **present** (disabled) for every workspace
  row that exists for any other reason;
- computed-key object literals `{ ...row, ['__proto__']: true }` create own data properties
  (safe), and the host settings provider applies path ops with spread literals
  (anchor `dsh-settings/lib/index.js` `applyPathOp`: `return { ...section, [head]: op.value }` —
  verified safe for `__proto__`).

The breakage is in **our own plain-assignment copies**: `pruneEmptyOverrideRows`
(`controller.ts:33-44`, used by every `decodeDoc`/`normalizeDoc`) does `rest[name] = true`,
which silently drops an OFF record for a `__proto__`-named server and — because a later
`row['__proto__']` read then returns `Object.prototype` — the UI's *canonical view* can disagree
with the host doc about whether the server is off in a workspace. Toggling then emits ops the
host applies, but the UI re-derivation keeps dropping the record: the checkbox state and the
actual injected tool set can silently diverge and cannot be repaired through the UI.
`removeServerOverrides` (`model.ts:61-73`) has the same assignment pattern (currently used by
tests only).

No prototype *pollution* of host objects was found (provider path ops and our row builders use
spread/computed literals), so impact is a silent configuration/control failure for one bizarre
name — but the OFF switch is the only control that excludes a server from a workspace's
model-visible tool set.

**Fix:** exclude prototype-colliding names at every gate (cheap and deterministic): add
`(?!__proto__$)` (or a `!== '__proto__'` check) to `SERVER_NAME_PATTERN`/`validateDoc`/UI
`evaluateDraft`, and write override rows through computed-literal/spread-only helpers with an
`Object.create(null)`-safe copy helper (`hasOwn` reads) so presence semantics can never touch
the prototype chain.

### SEC-04 — No debounce: settings flapping / credential events drive unthrottled process restarts (minor)

`manager.ts:94-98` serializes reconcile diffs and credential restarts on one mutation chain
("a settings commit can never race a credential restart into overlapping server processes" —
verified, this discipline is solid), but there is **no coalescing or rate limit**: every
`onChange` commit (`src/index.ts:84-86` → `manager.reconcile()`) and every
`credentials/reference-updated` for an in-use ref (`manager.ts:170-181`) that changes a
fingerprint (`manager.ts:198`: `defFingerprint !== fingerprint(server)`) enqueues a
`dispose()` + fresh `startServer()` (`manager.ts:140-157`) — i.e. a process kill and a new
spawn per event. A loop writing the doc (another admin tool, a file watcher round-tripping
`settings.yaml`, an HMR/patch reload cycle) or a rapid set/unset on a used ref churns server
processes at the chain's pace, each spawn running a full connect attempt with its own
reconnect backoff before being killed. Bounded (serialized, one process at a time, reconnect
timers `unref()`ed at `server.ts:286`) and same-trust, but it is the closest thing to a spawn
storm in the codebase.

**Fix:** debounce/coalesce reconcile+restart requests per serverName (e.g. 100–250 ms trailing
window), and make the restart loop skip when the just-started generation for that name has not
yet finished its first attempt.

### SEC-05 — Unbounded `tools/list` pagination and per-agent registration amplification (minor)

`fetchToolDefinitions` (`tools.ts:124-144`) drains `nextCursor` in a `do/while` with no page
limit; a malicious or buggy MCP server returning a cursor forever yields unbounded definition
growth (memory) and blocks the sync chain. This mirrors the official algorithm exactly
(ref-dsh `mcp/mcp-client/src/tools.ts:136-155` — same loop) — but the blast radius here is
larger in one dimension: official registers one global generation (`mcp-client` registers on
its own ctx), whereas this plugin registers def-by-def **into every live enabled agent scope**
(`agents.ts:193-195`, one `register()` per def per agent). A server advertising a huge tool
list therefore costs O(agents × tools) registrations. Stdio message size is otherwise bounded
by the SDK's 10 MiB `ReadBuffer` default (`dist/cjs/shared/stdio.js` —
`STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`, plugin does not override), and
`tools/list_changed` re-syncs serialize on `syncChain` (`server.ts:218-231`).

**Fix (optional hardening):** cap total tools (e.g. 10 000) and pages (e.g. 200) per fetch with
a fail-loud error; document the per-agent multiplication in the README.

### SEC-06 — Schema leaves `envKeys` elements and header names unpatterened (nit)

`DocumentSchema` stdio `envKeys: z.array(String).default([])` (`schema.ts:40`) and header
`name: z.string().required()` (`schema.ts:28`) carry no per-element pattern — the ref grammar
for env keys and the HTTP token grammar for header names are enforced only by the
`validateDoc` write hook (`model.ts:96-117`, wired at `index.ts:87-92`), which runs on settings
writes but **not** on a hand-authored/boot `settings.yaml` user layer (the composition layer is
the provider's input, not a hook-passing write). A bypassing env key reaches
`resolveServerEnv` → `manager.ts:101-102` `credentials.resolve(credentialRef(ref))`; the
`credentialRef()` brand throws `TypeError` for non-grammar names (anchor
`dsh-credentials/lib/index.js:21-22`) → the attempt fails, logs a warn, and enters the bounded
retry loop until give-up — no escalation, but the server is silently dead until the doc is
fixed. Header names with newlines also flow into warn strings (`transport.ts:80`: `…omitting header "${header.name}"`)
— same-trust log forgery.

**Fix:** move the grammar into the schema: `.pattern(CREDENTIAL_REF_PATTERN)` on
`envKeys` elements and an RFC 7230 token pattern on header names (mirrors the ref pattern
enforcement that already exists for `headers[].ref` at `schema.ts:29`).

### SEC-07 — Orphaned secret literals after failed doc writes; silent stale-value adoption (nit)

`submitPlan` (`controller.ts:435-445`) writes dirty secrets sequentially **before** the
revision-fenced doc mutation; a later failure (conflict/network) leaves already-landed values
in `.credentials.yaml` for refs the doc never references (acknowledged in `docs/ui-notes.md`
§5). Nothing is *leaked* by this, but: (a) such orphans are invisible in the UI (badges derive
from doc refs) and persist indefinitely; (b) when a future add re-uses the same ref name with a
blank secret field, the stale value is silently applied (draft `secrets` only carries non-empty
values — `controller.ts:430`; add-form env rows do not carry the "blank input keeps the stored
value" hint that HTTP header rows show, `add-form.tsx:359-378` vs `locales.ts:69`).

**Fix:** show per-row configured state in the add form (the store already has per-ref
`CredentialInfo` badges) and reuse the header-section wording for env rows; or stage-and-verify
refs before write.

### SEC-08 — No size caps and no host URL-scheme validation (nit)

Nothing bounds `servers` length, `args` length/element size, string lengths, or header/env row
counts (`schema.ts`, `model.ts` `validateDoc` — only emptiness/duplicates/grammar), and the
host schema accepts any URL string (`schema.ts:45`; `new URL(server.url)` at
`transport.ts:117`). Consequences, all verified bounded: non-http(s)/malformed URLs make
`fetch` throw (`file://` and `javascript:` → `TypeError: fetch failed`; `user:pass@` → `Request
cannot be constructed from a URL that includes credentials` — verified) and the supervisor
retries with backoff to a 10-attempt give-up (then silent until reload — `server.ts:268-277`);
an oversized document is a self-DoS by the config writer (same trust). The **UI** does pre-check
http(s) (`add-form.tsx:51-58`), so this only affects file-level or programmatic writers.

### SEC-09 — Workspace deletion does not revoke applied tools (nit)

`AgentEntry.workspaceId` is resolved once at adopt (`agents.ts:129-139`); there is no
workspace-removed event to listen to (registry "NO subscription API", recon `core-apis.md`
§3.1) and nothing re-judges `workspaceId !== undefined` after deletion, so a live agent keeps
the workspace's servers' tools until its session ends. Enablement re-judgement
(`applier.reconcile()`) only re-reads overrides, not workspace existence. Same-trust, minor
stale-state; worth a comment or a deletion hook when the registry grows one.

### SEC-10 — Disclosure gaps in UI copy / docs (nit)

Verified present: "This command runs as this dsh instance's user."
(`locales.ts:70` en / `:156` zh), default-on disclosures
(`server.defaultOn`, `server.newWorkspaceDefault`), removal-confirm incl. credential clearing
(`server.removeConfirmBody`). Not disclosed anywhere: header/env refs are resolved by **name
from the shared credentials domain** — so a configured HTTP server causes the host to send
whatever value that name resolves to (file, `.env`, or the dsh process's own ambient env) to
the configured endpoint; and new servers inject tools into every workspace's live agent scopes
at once (default-on × live push, `agents.ts:176`). Both follow from the threat model above but
should be one sentence in the add-form HTTP hint and README ("values are resolved from the
shared credential store by ref name at connect time").

---

## 3. Verified strengths (with evidence)

1. **No shell path exists.** Spawn is `StdioClientTransport` → `cross_spawn` with
   `shell: false` and argv arrays (`SDK dist/cjs/client/stdio.js` `start()`: `shell: false`);
   args are never joined into a shell string anywhere in this codebase (grep of `src/` for
   `sh -c`/template-joined commands: none). Experiment: an arg containing
   `; touch /tmp/pwned_shell $(id) \`id\` && …` reached the child verbatim as argv[1]
   (`"x; touch … $(id) … && …"` printed intact) and no file was created. `command` may be a
   bare name (PATH-resolved by the SDK) or a path; the *config writer* is the trusted admin
   (threat model above).
2. **Env scrub mirrors the official definition exactly.** `buildChildEnv` =
   `{ ...scrubbedParentEnv(), ...extra }` (`transport.ts:36-38`), importing
   `@deepseek-ai/dsh-subprocess`, whose installed implementation is byte-identical to ref-dsh:
   `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` and drops every key where
   `key.toUpperCase().startsWith("DSH_")` (anchor `dsh-subprocess/lib/index.js:31,46-48` =
   ref-dsh `subprocess/src/index.ts:44,60-66`) — verified by reading both. Explicit env merges
   **after** the scrub (`transport.ts:37`), and the test suite pins the semantics
   (`tests/host/transport.spec.ts:68-78`: ambient `MCP_SECRET_TOKEN/API_KEY/PASSWORD_1/DSH_HOME/
   dsh_token/Dsh_Whatever` dropped, `PLAIN_VAR` kept, explicit `MCP_SECRET_TOKEN` wins).
3. **No `undefined` can reach the child env.** `resolveServerEnv` only ever sets
   `extra[key]` when the resolved value is a non-empty string (`transport.ts:55-61`); types are
   `Record<string,string>` end-to-end. (Hazard noted for the record: Node stringifies an
   `undefined` env value to `'undefined'` — experiment `HAS_UNDEF: undefined` → child saw
   `"undefined"` — but no current path can produce it.)
4. **Empty resolved value == absent; layering matches the credential contract.** Empty/absent
   ref → key omitted with a warn naming only the ref (`transport.ts:56-58`); anchor
   `dsh-credentials-local` drops empty entries (`inherited()/dotenvFallback()` require
   `value.length > 0`) and resolves in the documented order process-env → file → `.env`
   (`lib/index.js:427-489`). If the dsh process env already holds the ref, `resolve` returns
   source `env` and a stored file value is shadowed — but the store **refuses** to write a
   shadowed ref in the first place (`assertUnshadowed`, `lib/index.js:636-639`), and after a
   restart that changed the ambient env, `describe` reports `{configured:true, source:'env',
   writable:false}` so the UI disables Clear (`server-card.tsx:105` `view?.writable !== false`)
   instead of pretending. Verified in the anchor provider source.
5. **`cwd` semantics are safe and inherited-by-default.** `cwd: server.cwd ?? ''`
   (`transport.ts:109`); experiment: spawning with `cwd: ''` runs the child in the dsh
   process's own cwd (no throw), so the documented "empty/absent = inherit" holds; relative
   cwds resolve against the dsh process cwd. SDK merges its own minimal default env
   (`getDefaultEnvironment`) *under* ours (`stdio.js` `env: { ...getDefaultEnvironment(),
   ...this._serverParams.env }`).
6. **Credentials domain hygiene.** Refs validated by `CREDENTIAL_REF_PATTERN` in the shared
   model (`model.ts:17`), schema for header refs (`schema.ts:29`), the host write hook
   (`model.ts:96-117`), the controller before every secret write (`controller.ts:431-433`), and
   the add-form (`add-form.tsx:80,110`). `credentialRef()` itself throws on non-grammar names
   (anchor `dsh-credentials/lib/index.js:21-22`), so even a bypassed doc cannot inject a weird
   name into `resolve` — it fails loudly into the bounded retry path. Env-key identity ==
   credential-ref identity is deliberate (single shared namespace); duplicates within a server
   are rejected (`model.ts:102,112`); cross-server ref sharing is intentional and handled
   correctly by the orphan computation (`controller.ts:137-144`) — the gap is only the global
   cascade (SEC-01).
7. **Header injection is not possible; CRLF values fail closed.** Header names/values from
   credentials reach `requestInit.headers` → SDK `new Headers(...)` → fetch-spec validation:
   CRLF in a **name** or **value** throws `TypeError` before any request is sent (verified
   experiments; no splitting possible — the whole header row is rejected). Userinfo URLs are
   rejected by the fetch layer; `file:`/`javascript:`/`ws:` are unusable through fetch.
   Residual issue: the throw text is logged with the value (SEC-02).
8. **No secrets in the settings document or on the wire.** Zero `role('secret')` /
   `role('credential-ref')`-style annotations anywhere in `src/` (grep: none); `envKeys` and
   header rows store **names only** (`schema.ts:40,46`); the document describe payload is the
   plain doc (M0 smoke shows the stored doc: `"envKeys":["MCP_SCOPE_TEST_TOKEN"]` with no value,
   `docs/milestones/M0.md`), and the credentials describe surface returns
   `{configured, source?, writable}` — never a value (anchor `dsh-credentials-local`
   `describe()` `lib/index.js:491-512`; `CredentialInfo` d.ts has no value member; wire
   `credentials.describe` maps it 1:1, `dsh-api-settings-controller/lib/typert.remote-client.d.ts`).
   The browser gateway is typed to exactly `describe/set/unset` (`client/index.ts:41-45,74-86`)
   and the controller uses describe results only for `configured`/`writable` badges
   (`server-card.tsx:103-105`). Files are 0600/0700 (verified `m1-home/.credentials.yaml` and
   `settings.yaml` are `-rw-------`; credentials-local `write()` passes `mode: 384, dirMode: 448`).
9. **No stored value is ever echoed by the UI.** Add form secret inputs are local staged
   state (`add-form.tsx` draft), `type="password"`, `autoComplete="new-password"`, sent only to
   `credentials.set`, discarded on close/cancel; there is no edit path for existing values;
   cards render ref names + badges only. Verified by reading every component and the controller
   write pipeline; no other API call exists that could return values.
10. **Save pipeline ordering + revision fence.** Secrets before doc (`controller.ts:435-449`);
    single atomic whole-array `servers` set; every mutate revision-fenced with the snapshot's
    revision (`controller.ts:470-483`, `toggleWorkspace` at `:397-405`); conflict recovery
    re-reads (`refresh()`). Stale-write refusal is proven end-to-end in the M0 smoke
    ("expected revision 0, now 1" → refused, `docs/milestones/M0.md`).
11. **Reconnect/backoff discipline is bounded and non-overlapping.** Fixed official defaults
    500 ms→30 s, max 10 attempts/outage, uptime ≥ maxDelayMs resets the budget, give-up commits
    empty defs and stops (`server.ts:46-51, 254-287`); an SDK default 60 s request timeout
    bounds every connect attempt (`SDK dist/cjs/shared/protocol.js`: `DEFAULT_REQUEST_TIMEOUT_MSEC
    = 60000`, applied when the caller passes no timeout), failed generations must close within
    5 s or the supervisor stops retrying rather than overlap children (`server.ts:242-252,
    344-352`); reconnect timers are `unref()`ed (`server.ts:286`); manager mutation chain
    serializes doc diffs vs credential restarts (`manager.ts:94-98`). Credential-value updates
    reach the next attempt because transport build resolves per attempt and is never cached
    (`transport.ts` header comment; `manager.ts:100-102`).
12. **Injection gate.** Tools are registered only through live `agent.ctx` scope layers —
    never globally — with real-registry tests proving `ctx.tools.get(name, agentA)` visible and
    global `get(name)` undefined (`tests/host/agents.spec.ts`; `agents.ts:168-208`); enablement
    is judged live per push (`agents.ts:176`), disposers run only for alive agents
    (`agents.ts:142-156`), scope entries die with the agent ctx (no leak on dispose).
13. **Packaging is clean.** `npm pack` tarball (`.smoke/dsh-mcp-scope-0.1.0.tgz`, inspected):
    29 entries — `lib/*.js`, `lib/types/**`, `cordis.patch.yml`, `package.json`, `README.md`.
    No `src/`, `tests/`, `.smoke/`, `node_modules/`, no source maps (`sourcemap: false` in
    `scripts/build.mjs`). `files` = `["lib","cordis.patch.yml"]`. Runtime deps minimal and both
    genuinely used by the host half (`@modelcontextprotocol/sdk` spawn/connect,
    `@deepseek-ai/schemastery` schema); dsh peers are correctly split peer vs dev; client
    platform packages are externals, not dependencies. (The `"./src/*"` exports entry points at
    an unshipped path, but that mirrors the official convention — recon
    `mcp-client-official.md` notes the same for official packages — and nothing imports it at
    runtime.)
14. **Single-instance guard** (`index.ts:43-60` — WeakSet keyed on `ctx.root`, duplicate
    activation fails loudly) and **fail-closed teardown** (manager/applier disposers on the
    plugin effect) verified.

---

## 4. Prioritized actions

1. **SEC-02** — one-line guards in `transport.ts` resolve functions (reject CR/LF/NUL values
   for headers *and* env; warn by ref name only) + control-char sanitize at the supervisor log
   sites. Highest value/effort ratio; closes the only path where a stored secret value can be
   written to logs.
2. **SEC-01** — decide the unset-cascade policy: prefer explicit Clear; at minimum re-check the
   live doc before unset and document the shared-namespace semantics in the removal confirm.
3. **SEC-03** — exclude `__proto__` (and document prototype-key hazards) from `serverName`
   validation in host schema, `validateDoc`, and the UI; switch row-building helpers to
   hasOwn-safe copies.
4. **SEC-04** — debounce reconcile/credential restarts per serverName.
5. **SEC-05 / SEC-06** — tool-list caps and per-element schema patterns (cheap hardening).
6. **SEC-07 / SEC-08 / SEC-09 / SEC-10** — copy/doc improvements and size caps; workspace
   deletion note.

## 5. Verification notes

Experiments (all run under Node v22.22.3; outputs quoted above where relevant): spawn with
shell metacharacter args; spawn `cwd:''`; env `undefined` value; env key containing `=`;
ENOENT error shape; `Headers` CRLF name/value rejection; `fetch` with `file:`/`javascript:`/
userinfo URLs; NUL-in-env spawn error; `__proto__` own-key/assignment/read semantics;
schemastery element-type enforcement and unknown-key stripping; SDK source reads for
timeout/header/stdio-buffer behavior. Repo test runs: transport/model/controller suites green
(39/39). Artifacts: `.smoke/dsh-mcp-scope-0.1.0.tgz` listing; `docs/milestones/M0.md`,
`.smoke/logs/m0-full.log`, `m1-home/settings.yaml`/`.credentials.yaml` permissions; grep scans
of `src/` for `role(`, `secret`, `resolve`, `describe`, logger calls.

**Assumed (not re-verified in this review):** internals of the settings provider beyond
`applyPathOp` (revision fencing and the validate-hook-on-write behavior are corroborated by the
host test suite and the M0 smoke run rather than by reading every provider code path);
behavior of the official (anchor) mcp-client *supervisor* log lines (only its transport and
config schema were read; SDK-level error strings are shared, so SEC-02's mechanism applies to
any logger of SDK errors); future behavior of chamber/gateway surfaces.
