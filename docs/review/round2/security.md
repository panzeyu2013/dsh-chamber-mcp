# Round-2 security review — dsh-mcp-scope (post-fix verification)

Reviewer: round-2 security-review subagent. Method: read-before-claim on the round-1 report
(`docs/review/security.md`), the disposition matrix (`docs/review/SUMMARY.md`), the pre-read
docs (`docs/acceptance.md`, `docs/host-notes.md`, `docs/ui-notes.md`, `docs/recon/core-apis.md`
§2/§6), the **current** `src/{transport,server,agents,manager,schema,index,tools,workspace}.ts`,
`src/shared/model.ts`, `src/client/{controller,index,section,server-card,add-form,locales,workspaces}.tsx|ts`,
plus anchor runtime evidence (`.credentials-local/lib/index.js`, `dsh-credentials/lib/index.js`,
`dsh-session/lib/types/types.d.ts`, `dsh-agent/lib/types/index.d.ts` at
`/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai`). Verification runs under
Node v22.22.3 (`/root/.nvm/versions/node/v22.22.3/bin`): full suite **126/126 green (11 files)**,
both typecheck gates clean (exit 0), `npm pack --dry-run` file list re-derived (29 entries,
identical set to `.smoke/dsh-mcp-scope-0.1.0.tgz`). Every claim is marked **verified** or
**assumed** (stated as such).

---

## 1. Updated threat-model statement

**The fix round did not move a trust boundary.** The fence statement of round 1 still holds:
any principal who can write the `mcp-scope` settings namespace (or reach
`settings.*`/`credentials.*` over the browser wire) is the dsh instance's administrator for all
practical purposes — the privileged remote subset is loopback-only and the `/api` cookie fence
stands (recon `runtime-test-env.md` §6 / `chamber-bridge.md`, unchanged by this round; nothing
in the diff adds a network listener, a new wire method, or a new privileged method). Within the
fence the config writer can already spawn commands as the dsh user and read any credential by
ref name; malicious MCP servers are the configured feature and stay out of scope. All
round-1 and round-2 findings live inside this boundary and none assumes an attacker beyond it.

One statement in the model is **updated** for the new code: the client now performs **automatic
`credentials.unset` operations from failure paths** (refused/conflicted doc writes and
secret-write aborts), where round-1 code only unset after a *successful committed* removal.
The capability exercised (`unset` by ref name) is not new — the removal cascade and per-ref
Clear already used it — but the *trigger conditions* are: an unset now runs exactly when a
concurrent writer has just won the revision race, i.e. in the one situation where another
owner is most likely to have freshly stored a value under the same ref name. The blast radius
of SEC-01's documented "shared name space, no owner distinction" hazard is therefore wider
than before and is the subject of new finding **R2S-1** (minor). Everything else the fence
guards (cross-plugin name-addressed resolution, default-on × live per-agent injection, removal
cascade) is unchanged in kind.

Also re-stated for this round: schema/hook validation does **not** run on the boot/user-layer
`settings.yaml` composition (only on settings-namespace writes); a hand-authored layer remains
a same-trust input that only the *schema parse* (and transport guards) filter — relevant to
SEC-03/SEC-06 residuals below.

---

## 2. Round-1 finding dispositions (ID | disposition | evidence)

| ID | Disposition | Evidence |
|---|---|---|
| SEC-01 | **PARTIAL** — cascade replaced by new-ref-only auto-cleanup + best-effort, refusal-tolerant unset (SUMMARY "SEC-01 tail … Inherent"); new failure-path unsets add a sharper race — see **R2S-1** | `controller.ts:637-686` (`cleanupNewlyStored` unsets only refs stored by *this attempt* and not `preconfigured`); `controller.ts:647` `wasConfigured` = describe view `configured === true`; tests `controller.spec.ts:447-553`; removal cascade (post-commit `unsetQuietly(plan.unsetRefs)`) unchanged `controller.ts:673-675` |
| SEC-02 | **FIXED at the value boundary; residual logged-error sinks remain** | `transport.ts:38-43, 77-80, 107-110`: CR/LF/NUL resolved values rejected per key/header, warn names ref/header only, value never placed into env/`Headers`; tests `transport.spec.ts:116-156` assert warnings contain no `\r\n\0` and no value text; supervisor sinks still log raw `String(error)` (`server.ts:344, 361, 393`, `agents.ts:197, 253`) — see R2S-4 |
| SEC-03 | **PARTIAL** — write-path gates added; schema/UI patterns and row-copy helpers still reserved-name-admitting | `model.ts:93` `RESERVED_OVERRIDE_KEYS = {'__proto__','constructor','prototype'}`; `model.ts:110-112` in `validateDoc`; test `model.spec.ts:168-174`; backstop `docErrors` before every controller write (`controller.ts:642`). Still NOT covered: `schema.ts:35,43` serverName pattern admits `__proto__` (boot-layer docs pass schema parse), UI `evaluateDraft` (`add-form.tsx:101`) flags it only as generic failure at save; assignment-style row copies (`model.ts:79`, `controller.ts:46`, `controller.ts:196-200`) would silently drop such rows — unreachable via write paths today (host hook + `docErrors` refuse first) but live for boot-layer docs: UI shows ON while host row reads inherited → silent, unrepairable-by-toggle divergence for `constructor`/`prototype`-style names. Same-trust, nit-class, residual |
| SEC-04 | **ACCEPTED (partial fix, bounded)** — diffed reconcile removed the settings-churn driver; queued-window coalescing per serverName; no debounce; burst spaced across a running restart still restarts per event | `manager.ts:216-237` (reconcile only restarts on fingerprint change), `manager.ts:159-186` (`pendingRestarts` coalesce, marker cleared at mutation *start*), test `manager.spec.ts:165-211` (same-tick absorbed, later event restarts); worst case one live process per serverName, serialized on `mutations` — see R2S-3 |
| SEC-05 | **NOT-FIXED / ACCEPTED** (documented future polish, official-mirrored) | `tools.ts:129-143` do/while drains `nextCursor` uncapped; per-agent multiplication `agents.ts:243-245`; SUMMARY disposition row "SEC-04/08/10 … tracked as future polish" |
| SEC-06 | **PARTIAL** — element grammar moved into shared `validateDoc` for the *write path* only; schema-level patterns on `envKeys` elements / header **names** still absent | `model.ts:119-139` (env-key/ref grammar + header empty/duplicate in hook); `schema.ts:28` `name: z.string().required()` no token pattern, `schema.ts:40` `envKeys: z.array(String)` no element pattern; boot-layer bypass documented only in the round-1 report itself (`security.md:71`) and implicitly by acceptance.md "boot-layer path documented" — no explicit doc/README statement found in this round (grep of design.md/README/ui/host notes). See R2S-5 |
| SEC-07 | **PARTIAL** — orphan-after-failure largely solved by refusal auto-unset; hint parity still missing on env rows; stale adoption gap closed by pre-configured skip | `controller.ts:658-671` abort + cleanup; tests `controller.spec.ts:447-470`; `locales.ts` `add.envSectionHint` says only "injected as environment variables …" — no "blank keeps the stored value" wording (contrast `add.headerSectionHint` `locales.ts:91`); add-form still shows no per-row configured badge |
| SEC-08 | **NOT-FIXED / ACCEPTED** | no length caps anywhere (`schema.ts`), no host URL-scheme check (`transport.ts:145` `new URL(server.url)`); bounded failures + SDK 60 s timeout unchanged (verified round 1; nothing in the diff changes this) |
| SEC-09 | **FIXED** | workspace membership re-resolved per push/reconcile from one live registry snapshot (`agents.ts:153-166, 261-289`); tests: workspace deletion revokes + later pushes don't resurrect (`agents.spec.ts:427-450`), workspace appearing after adopt applies (`:452-470`) |
| SEC-10 | **PARTIAL** | README now discloses default-on in every workspace, per-workspace off, runs-as-dsh-user, scrubbed env, sessions-outside-workspaces get nothing (`README.md:42-58, 76-79`), removal-confirm names credential clearing (`locales.ts:43`); still not disclosed anywhere: refs resolve **by name from the shared credentials domain** (env/header rows send whatever that name resolves to, incl. ambient env / other plugins' values), and the removal cascade / failure cleanup `unset` that shared name space |

Disposition of the "Fixed in code" rows that matter to security (FE-1, FE-2, FE-6, UX-02,
IMPL-1/2/3/4/7, PERF-1/2, ARCH-3): verified in code + tests where security-relevant —
FE-1 landed-write comparison with refusal ⇒ conflict (`controller.ts:712-729`), typed-code
error classification with message scan only as backstop (`controller.ts:291-307`), describe
generation guard (`controller.ts:515-549`), no `undefined`-resolved values into child env
(re-verified `transport.ts:51-53, 62-84`).

---

## 3. New round-2 findings

### R2S-1 (minor) — refusal/conflict-path auto-unset can delete a concurrently committed owner's fresh value

**Evidence.** `submitPlan` computes `preconfigured` from the **pre-write snapshot's describe
view** (`controller.ts:647`) and, after a refused/conflicted doc write, unsets every dirty ref
that was not `preconfigured` (`controller.ts:666-671`, `cleanupNewlyStored` `:680-686`).
`applyOps` re-reads the live scope on refusal (`:724` `this.refresh()`), but the cleanup then
ignores the fresh doc: a ref that the **current** (winning writer's) doc references is still
unset. The controller's own overlapping-commit test pins the behavior: a mid-save external
commit makes both attempted refs `unset` (`controller.spec.ts:501-524`).

**Why.** Two-tab/dual-writer interleaving: writer A and writer B both add a server that reuses
one env ref name (common: standard servers with `API_KEY`-style names). A sets first, B's doc
write wins the revision fence, A's write is refused ⇒ A's cleanup unsets the ref — deleting
B's just-stored value while B's committed doc still references it. Round-1 code performed **no
unset on failure** (an orphan literal remained and still resolved for B's server); the new
failure path actively destroys the winner's fresh value. The cleanup *class* (unset of the
shared, ownerless name space) is the documented SEC-01 tail — but the conflict path is exactly
the case where a concurrent owner is most likely to have just written, so this new trigger is
the sharpest instance of the hazard. Everything else in the chain was verified safe:

- env-configured refs (ambient env) can **not** be misclassified as new and wrongly unset:
  anchor `describe` returns `{configured:true, source:'env', writable:false}` for inherited
  refs, `{configured:true}` for file/dotenv layers, `{configured:false}` only when no layer
  resolves a value (`.credentials-local/lib/index.js:491-512`) ⇒ `wasConfigured` is true for
  every resolvable ref, and even a stale-view misclassification is harmless: `unset` of an
  env-shadowed ref is refused by `assertUnshadowed` (`:636-639`, message verified) and
  swallowed by `unsetQuietly`. A dotenv-layer value can never be deleted by our unset (the
  file has no own entry; `write(ref, undefined)` with no own value is a no-op, `:613-615`).
- the unset *candidates* are never guessed: cleanup targets only refs this attempt's
  `credentials.set` actually stored; the removal cascade targets refs orphaned by our own
  committed doc; Clear targets doc badge refs (`controller.ts:609-618`).
- residual (unchanged in kind): same-name cross-plugin clobber on `set`; post-commit removal
  cascade TOCTOU; failed-save **overwrite** of a preconfigured ref is deliberately kept (old
  value cannot be restored — test `controller.spec.ts:527-551` codifies that the *new* value
  stays after a refusal; that attempted literal becomes the live value of any other server
  referencing the same ref).

**Fix.** On the refusal path only, re-check the post-refresh live doc and skip unsets for refs
`credentialRefsOfDoc(this.snapshot.doc)` still references (the value written for a live ref is
the intended one for *some* committed doc; deleting it is always wrong). Optionally re-describe
before unsetting. The removal-cascade TOCTOU would need the same live re-check plus matching
the value this plugin last wrote — infeasible in an ownerless domain; explicit-clear remains
the honest long-term policy (round-1 option).

### R2S-2 (minor) — SEC-02 residual: log sinks still echo raw error text (remote-reflected secret round-trip); boot-layer names can forge log lines

**Evidence.** The transport rejection is airtight for **resolved values** (both env and header
paths; warn text is value-free — verified in code and asserted by tests, `transport.spec.ts:
116-156`), and no new log line (epoch/defs/give-up/credential-restart) carries a resolved value
(`server.ts:216` counts only; `manager.ts:208` names only the ref). But the supervisor sinks
still log `String(error)` verbatim (`server.ts:344,361,393`): a reflecting/malicious HTTP
endpoint can return the header value it just received inside its error body (SDK
`StreamableHTTPError` text) and that text is logged — a stored secret can still reach the host
log *via the remote round-trip*. Round 1 listed exactly this residual; the sanitize-at-sink
half of the proposed fix was not applied. Separately, **header names and env-key names are
still schema-unpatterned** (SEC-06): a hand-authored boot-layer `settings.yaml` can carry a
header name/env key containing CR/LF, which then reaches log text through the omission warns
(`transport.ts:101,108` embed `header.name`) and through the anchor `credentialRef()` TypeError
(`` credential ref "${value}" must match … `` — `dsh-credentials/lib/index.js:21-22`) logged by
`server.ts:361`. Same-trust (boot-layer writer) and fail-closed (request never sent, retry
bounded), but it is the one remaining path where control characters from the doc reach log
lines.

**Fix.** Control-character-sanitize at the three `server.ts` sinks (cheap, round-1 action #1
second half); add an RFC 7230 token pattern for header names and `CREDENTIAL_REF_PATTERN` on
`envKeys` elements inside `schema.ts` so the boot layer is filtered at schema parse.

### R2S-3 (minor, informational-to-accepted) — coalescing window ends at mutation start; bursts spaced across a running restart still restart per event

**Evidence.** `restartServer` clears `pendingRestarts` as the first act of the queued mutation
(`manager.ts:168-169`) and the mutation then awaits `stopServer` → `handle.dispose`
(quiescence: close + ≤5 s close-wait + `settling` + `syncChain`, `server.ts:408-429`), which
can take seconds when a connect attempt is in flight. Credential events arriving *during*
execution each enqueue a fresh stop+start (marker already clear) — the test suite pins the
intended split: same-tick events coalesce to one restart, a later event restarts again
(`manager.spec.ts:165-211`). Bounds are real and unchanged: everything serializes on the
`mutations` chain; at any instant ≤1 process per serverName; a failed generation that does not
close within 5 s stops retries rather than overlapping (`server.ts:366-370`, test
`server.spec.ts:228-248`); reconnect timers `unref()`ed; give-up empties the defs map and
stops. So no spawn *storm* and no overlap — only a churn multiplier for a sustained event
burst, which the round-1 acceptance already classed as "bounded failures today". Recommend a
trailing debounce (100-250 ms) per serverName as backlog, not a security blocker.

### R2S-4 (minor) — manager `restartServer` can start a server whose definition left the document (unreachable today; trap for future callers)

**Evidence.** In the `current === undefined` branch, a queued restart starts `next` with **no
live-doc presence check**, while the tracked branch has one (`manager.ts:171-183`, check at
`:181`). Reached today only from the credential listener, which filters by the live doc's ref
set before queueing (`manager.ts:200-211`), so a phantom start would require the server to be
removed *between* event time and mutation run with the event still queued — all interleavings
on the serialized chain were walked and converge (the removal reconcile either runs first —
listener then reads the removed ref out of use and never queues — or the queued restart's own
presence check sees the removal). If a future caller enqueues `restartServer(name, staleDef)`,
the branch silently resurrects a removed server (tools re-register into live scopes until the
next doc change). One-line hardening: mirror the `:181` presence check in the undefined branch.

### R2S-5 (informational) — subagent-origin filter is sound against typed creation paths

**Evidence.** `adopt` skips `origin === 'subagent'` on **both** paths through one funnel
(`agents.ts:168-183`); the anchor type space has exactly one origin literal — `origin?:
'subagent'` in `CreateAgentOptions.meta` (`dsh-agent/lib/types/index.d.ts:63-76`) and
`SessionHeader.origin?: 'subagent'` (`dsh-session/lib/types/types.d.ts:87-91`) — and the
header is **durable session metadata** (delegation depth "persisted so a recursion budget
survives restart and resume"), so a resumed subagent child cannot reappear origin-less after a
host restart. Tests cover both adoption paths and assert the child's scope never receives
tools (`agents.spec.ts:472-510`). No bypass class exists in the typed model: a child that is
not `origin:'subagent'` is not a delegation child, and children are the only `origin`
carriers. Residual (informational): scope-chain inheritance means tools registered on an
adopted root's scope may be *visible* to that root's delegation children through the scope
chain regardless of our filter — governance there is the children's preset composition
(round-1 ARCH-3 tail, documented deviation in `agents.ts:16-20` + acceptance.md); a real
delegation E2E on a chamber GUI remains the open verification (host-notes/milestones), and any
future child class must carry `origin` or this filter silently widens. Severity: low; no
escalation path found (registration alone does not bypass preset/toolFilter narrowing, and a
child inheriting root tools is pre-existing dsh-scope semantics, not a new hole).

### R2S-6 (informational) — per-event `fs.realpathSync` on session cwds: no DoS/TOCTOU of consequence

**Evidence.** Every `pushServerState`/`reconcile`/`adopt` re-resolves each tracked entry's
workspace: `workspaceRegistry.list()` + one `realpathSync` per entry, injectable for tests,
errors → `undefined` → tools withheld (`agents.ts:153-166`, `workspace.ts:23-50`). Analysis:
(a) **DoS**: the call is synchronous on the host event loop and its cost is bounded by path
depth; a hung mount under a session cwd would stall the loop, but workspace roots are local
registry paths and realpath failures are caught (no crash path; the entry degrades to
"no workspace", which is fail-closed). (b) **TOCTOU**: resolution and enablement judgment are
one call; the derived id is used only to pick the enabled-server set for that agent's scope —
a symlink swap between registry registration and judgment transiently attributes the agent to
the wrong workspace's server set; every later event re-resolves (self-correcting), the swap
requires filesystem write access to the workspace area (same trust), and no registration is
ever bound to a path (only to agent + enabled set), so nothing outlives the misjudged event.
(c) Rate: one sync-realpath per (event × live agent), events being server commits — low
frequency; only a credential-event burst (R2S-3) inflates it. Verdict: no change required;
move to async realpath or a registry-provided session-workspace mapping if live-agent counts
grow an order of magnitude.

### R2S-7 (verified, no finding) — new-code checks that came back clean

(a) **Epoch/coalescing cannot overlap two live handles for one serverName**: all
stop/start pairs run inside one serialized mutation (`manager.ts:111-115`); a restart fully
quiesces the old handle (close + ≤5 s wait + in-flight attempt + sync chain) before
`startServer`; give-up commits are enqueued on the supervisor's sync chain behind any in-flight
commit (`server.ts:290-295`); an empty (give-up) commit still revokes applied tools because
the enablement check precedes the (epoch, syncId) idempotence guard in `applyToEntry`
(`agents.ts:221-238`) — the equal-syncId give-up case is therefore not absorbed; tested
(`server.spec.ts:186-216`, `agents.spec.ts:227-256`).
(b) **Frozen `EMPTY_DOC`/`EMPTY_DEFS`**: no mutation site anywhere — grep + read of every
consumer: `decodeDoc` returns it only as a read-only default (`controller.ts:59`), `index.ts`
uses it as the pre-attach source and installSection entry, the real
`FileSettingsProvider` spec mounts it without mutation (`settings.spec.ts`), `EMPTY_DEFS` is
assigned, never modified (`server.ts:99,192,228`); model spec asserts deep freeze
(`model.spec.ts:160-166`); ESM = strict mode, so an accidental write would throw loudly.
(c) **UI injection surface**: zero `dangerouslySetInnerHTML`/`innerHTML` in `src/`; server
names/commands/URLs/cwd/header names render only as React text/attribute content (`server-card
.tsx`, `add-form.tsx`, `section.tsx`); the URL is never an `<a href>`; `title`/`id` attributes
carry React-escaped content from pattern-validated names; failure text is localized keys whose
only params are ref names (`controller.ts:331-333`) — remote error bodies never reach the DOM.
(d) **Packaging after dep changes**: `npm pack --dry-run` → 29 files — `lib/*.js`,
`lib/types/**`, `cordis.patch.yml`, `README.md`, `package.json`; no `src/`, `tests/`, `docs/`,
`.smoke/`, node_modules, or source maps (identical to the inspected `.smoke` tgz). `zod
^4.4.3` (runtime dep, genuinely used: `tools.ts:30,55`) and `@deepseek-ai/dsh-timeout`
(peer + devDep, genuinely used: `server.ts:28,71-75`) are declared. Residual nit unchanged:
the `"./src/*"` export maps an unshipped path (official-convention mirror; nothing imports it
at runtime).

---

## 4. Verified strengths (round-2 deltas on top of round-1's list)

1. **Value-rejection is now provably value-free.** Warnings name key/ref/header only and the
   test suite asserts the absence of `\r\n\0` *and* of value text in them
   (`transport.spec.ts:116-156`); rejection happens before the value can reach `Headers` or the
   child env, closing the round-1 "stored secret verbatim into host logs" mechanism for the
   value path.
2. **The new-ref classification chain is anchored to real provider semantics.** Verified in
   the anchor: env-configured refs describe as `configured:true/writable:false`, file and
   dotenv layers as `configured:true`, and `unset`/`set` are refused for env-shadowed refs —
   so the "newly written" test cannot target a ref that resolves a value, and even a stale
   describe view fails safe (refused unset) rather than destructive.
3. **Failure paths stay localized.** Doc writes and secret writes are ordered
   secrets-first with per-ref abort (`controller.ts:643-663`); the auto-unset runs only for
   refs this attempt stored; every unset is best-effort and cannot fail an already-committed
   removal (`controller.ts:689-699`); refusal classification relies on typed codes first
   (`controller.ts:291-307`).
4. **Lifecycle discipline is materially tighter.** Epoch-keyed applier idempotence
   (manager `epochs`, `agents.ts:238`), queued give-up commits, sync-chain serialization,
   5 s close discipline, unref'd timers, coalesced same-tick restarts, diffed reconcile
   (no-op reconcile registers nothing — PERF-1 test), workspace re-resolution with live
   revocation — each verified in code and pinned by tests.
5. **Package/supply surface unchanged and clean** (29 files, deps declared, no new runtime
   imports beyond the two declared ones).
6. **Frozen defaults enforce fail-loud** under ESM strict mode for any future careless
   mutation of `EMPTY_DOC`/`EMPTY_DEFS` (guards, not just comments).

---

## 5. Prioritized actions

1. **R2S-1** — gate refusal-path cleanup on the post-refresh live doc: never unset a ref the
   current document still references (one condition in `cleanupNewlyStored`'s call site).
2. **R2S-2** — sanitize control characters in the three `server.ts` error sinks (and the
   `agents.ts` disposer/registration error lines) — closes the remote-reflected echo and the
   boot-layer name path; add the per-element schema patterns (header-name token + envKeys
   element) so the boot layer is filtered at parse.
3. **R2S-4** — presence-check in `restartServer`'s undefined branch (one line, trap-proofing).
4. **R2S-3** — trailing debounce per serverName (100-250 ms) as backlog; not a blocker.
5. **Copy/doc residuals (SEC-10, SEC-07 hint parity, SEC-06 boot-layer note)** — one sentence
   in README + add-form hints: env/header values resolve **by ref name from the shared
   credentials domain**, removal and failed-save cleanup unset that shared name space, and env
   rows keep "blank = keep stored"; explicitly document (design.md/README) that
   hand-authored `settings.yaml` user layers bypass the `validateDoc` hook and are filtered
   only by the schema + transport guards.

Round-2 verdict: **no critical, no major — all new findings minor/informational, all inside
the unchanged trust boundary.** SEC-09 is fully fixed; SEC-02 (value path), SEC-01 (policy
form), SEC-04 (diff+coalesce) are fixed-in-substance with the precisely stated residuals
above; SEC-03/06/07/10 are partial (write-path gates in, boot-layer/schema/UI-copy gaps out);
SEC-05/08 remain accepted hardening backlog exactly as dispositioned in SUMMARY.md.

*Verification notes: tests 126/126 (11 files) and both `tsc` gates green on the reviewed
commit; anchor quotes from `.credentials-local/lib/index.js:491-512, 613-615, 636-639`,
`dsh-credentials/lib/index.js:21-22`, `dsh-session/lib/types/types.d.ts:87-91`,
`dsh-agent/lib/types/index.d.ts:63-76`; npm pack dry-run listing matches the shipped tgz.*
