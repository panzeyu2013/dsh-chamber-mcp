# dsh-mcp-scope — performance review, ROUND 2 (post-fix verification)

Re-verification of the round-1 performance findings (docs/review/performance.md)
against the fix round (HEAD `2737f98`): per-server epochs, diffed reconcile,
per-event workspace re-resolution, subagent-origin exclusion, restart
coalescing, client landed-write read-back + granular publishes. Verdict up
front: **PERF-1 and PERF-2 are fixed and measured so**; the round-1 churn
numbers drop by ~3 orders of magnitude on the paths they claimed. One new
High finding (R2P-1: `manager.dispose()` never stops live supervisors — it
deletes from `tracked` before `stopServer()` looks the entry up), one Medium
UI regression-vs-round-1 measurement (R2P-2), one Low (R2P-3). Everything
else verified clean.

**Labeling:** **[M]** = measured in this round (benchmarks under
`.smoke/bench/r2-host.spec.ts` and `.smoke/bench/r2-client.spec.tsx`,
gitignored; commands below); **[R]** = reasoned from code with cited
locations. Methodology mirrors round-1 exactly (real ToolRuntime + dsh-scope
agent contexts driving the real applier/manager from `src/`; counting
logger; `tools/change` counter on the root ctx; medians of 3–7 reps after
warmup) plus new instrumentation: `workspaceRegistry.list()` call counter,
`overrides()` thunk counter, realpath micro-benchmarks, per-entry deltas.
UI numbers again jsdom + React 18 dev — pattern evidence, not browser ms.
Repo suite baseline re-run at review start: **126/126 green**; no repo files
modified (benchmarks only).

```
node node_modules/vitest/vitest.mjs run --config .smoke/bench/vitest.config.ts r2-host
node node_modules/vitest/vitest.mjs run --config .smoke/bench/vitest.config.ts r2-client
```

Numbers below are from the final full runs (host suite 14/14, client 7/7);
ranges span two full runs where GC-influenced (register-heavy phases vary
~1.5–2× between runs in-process).

---

## 1. Round-1 verification table

| PERF-n | Round-1 claim | Round-2 disposition | Verified? (numbers) |
|---|---|---|---|
| PERF-1 | `reconcile()` blanket force pass = 18× over-churn (toggle at 24 agents: 15.5–17.7 ms / 900 events vs ≤50 needed; no-op reconcile at 50×4×20: 146–158 ms / 8 000 events / ~400 INFO lines) | Fix: diffed reconcile — act only on (enablement ⇄ applied) flip or (epoch, syncId) change; one doc snapshot per event | **FIXED [M]** — no-op reconcile: **0.068 ms / 0 events / 0 log lines** at 24×2×10, **0.15 ms / 0 events / 0 lines** at 50×4×20 (was 146–158 ms + 8 000 events: ~1000× reduction). One-workspace toggle OFF at 24 agents: **0.44 ms, exactly 60 events = 60 minimal** (ratio 1.0), 6 revoke lines, bench-a/server-b lines: 0. Toggle ON: 2.1 ms, 60 registers. Flip OFF at 50×4×20: 2.7–3.3 ms, exactly 500 events (25 agents × 20 tools — O(changed pairs)). Workspace deletion (revoke path): 12–26 ms / 2 000 events (25 agents × 4 servers × 20 — all four servers revoked, 100 revoke lines); workspace re-creation re-applies all (2 000 registers). Verified in repo tests too (`tests/host/agents.spec.ts:389`). |
| PERF-2 | Restart reuses syncId 1 → applier absorbs the new generation (stale executors stay registered) | Fix: manager-owned per-server epoch in the dedupe key; bump on every `startServer` (`manager.ts:87-95,127`); guard on (epoch, syncId) (`agents.ts:238`) | **FIXED [M]** — applier-level: push(epoch2, syncId1) after (epoch1, syncId1) → def identity changes, stale gen revoked, 20 events (one full swap of 10 tools) in **1.1 ms**; same-(epoch,syncId) re-push ×1000 = **3.5–5.1 µs/push, 0 events, 0 lines**. Manager E2E with the real fixture stdio server: after a settings-driven restart the new generation **lands in the live agent scope** (`appliedLines 1→2`, `defIdentityChanged: true`, `generation swap` revoke logged) — round-1's `staleDefsRetained: true` no longer occurs; restart cycle (stop→start→sync→apply) **~101–120 ms wall**, dominated by the process lifecycle. Restart-commit fan-out at 24 agents × 10 tools: 9.9–10.1 ms / 480 events — one extra swap cycle per pair, exactly the expected cost of registering the new generation (≈ one `list_changed` re-sync; the old "free" absorbed path was the bug, not a win). Same-commit re-push after restart at 24 agents: 0.12 ms, silent. Regression test added (`agents.spec.ts:350`). |
| PERF-3 | Per-def `tools/change` + INFO log storm during swaps/reconciles | Fix: subsumed by PERF-1/2 (churn removed ⇒ events/logs removed); no residual mitigation added | **VERIFIED [M]** — events now scale with changed pairs only: 480 per one-server swap, 60 per one-workspace toggle (minimal), 0 on no-ops (was 8 000 / reconcile). Log lines track applies/revokes only (6 per 24-agent toggle, 0 per no-op). Residual per-pair INFO logs on real churn remain as documented (acceptable). |
| PERF-4 | Adopt on every `agent/created` incl. subagents; ~0.77 ms/agent @ 2×10 tools | Fix: subagent-origin excluded (`agents.ts:174`); workspace re-resolution at adopt | **VERIFIED [M]** — root adoption cost unchanged order: 50 agents × 4 servers × 20 tools **166–297 ms total ≈ 3.3–5.9 ms/agent** for 80 registers+80 events+realpath ≈ **41–74 µs/register** (round-1: 38.5 µs/register @ 2×10). Subagent-origin spawn+announce: **0.036 ms/agent, 0 events, 0 log lines** (adopt skipped entirely; round-1 would have paid a full registration each). Adopt adds 1 `registry.list()` + 1 realpathSync per adopted agent — µs. |
| PERF-5 | UI: whole-section re-render per publish, 2–4 publishes+describes per host commit, 11.8–14.2 ms/publish at 1 000 rows, no memo | Disposition: **accepted as polish** (SUMMARY PERF-UI); round-2 added read-back + richer cards, not coalescing/memo | **UNCHANGED + heavier [M]** — publishes per own-save commit: 4 (scope notify + applyOps refresh + forwarded-event refresh + describe settle); 6 with the forwarded remote event; external commit: 3. Describes: 2–3 per commit, each a **single full-set RPC** (verified no N+1: 3 calls × 150 refs during one commit at 50 servers × 3 refs; every describe full-set `controller.ts:515-549`). Per-publish section render at 1 000 rows now **14.9–36.5 ms** (round-1: 11.8–14.2) — the richer per-card tree (edit/remove/clear buttons, chips, tri-state badges, per-row on/off labels, footer rows) costs ~1.3–2.6× per publish in jsdom/dev; at 20 rows 2.3 ms (round-1 ~1 ms). Same-tick publishes still batch into few React renders; read-back itself is µs (below). Still zero memoization. |
| PERF-6 | Multi-server stop/start serial; credential storms queue N sequential restarts | Fix: restart **coalescing** per serverName (`pendingRestarts`, `manager.ts:159-186`); serial dispose discipline otherwise unchanged (documented) | **VERIFIED [M]** — 8 same-tick credential events → exactly **1 stop + 1 start + 1 "reconnecting" line** (coalesced; ~101–142 ms cycle); a later genuine event restarts again (marker cleared when the queued mutation runs). Serial multi-server stop/start on doc changes remains (documented, rare). |
| PERF-7 | `overrides()` re-read per (entry × server) pair inside reconcile loops | Fix: hoisted — one doc snapshot per event (`agents.ts:285`) | **VERIFIED [M]** — `overridesReadsPerReconcile: 1` at 24×2×10 and 50×4×20 (instrumented thunk); adopt reads once per adopted agent. Also verified `registry.list()` is **once per event** (push/reconcile), not per pair: counter shows 1/reconcile, 209 total for 200 adopts + 4 pushes + 5 reconciles. |

Non-findings re-checked [M]: same-(epoch,syncId) re-push idempotence (above);
`pushServerState` server scoping (only the pushed server's pairs churn —
bench-b log delta 0 during bench-a restart/`list_changed`); applier `dispose()`
revokes everything at 50×4×20 in **20–24 ms / 4 000 events / 200 revoke
lines** and post-dispose pushes/reconciles are absorbed no-ops; long-session
swap churn is bounded (1 500 sequential generation swaps ≈ 220–246 µs/swap,
revoke after them disposes exactly **5** defs — one applied set, no disposer
accumulation).

## 2. New findings

| ID | Sev | Location | Finding | Evidence | Why it matters / fix |
|---|---|---|---|---|---|
| R2P-1 | **High** | `src/manager.ts:239-249` (`dispose()`) | `manager.dispose()` deletes each serverName from `tracked` **before** calling `stopServer()`, and `stopServer()` (`manager.ts:142-144`) re-reads `tracked.get(serverName)` → `undefined` → returns immediately. Dispose therefore never stops a live supervisor, never logs "server stopped", and (because `stopServer` owns the `revokeFirst` revoke) never revokes live registrations. Present identically in round-1 (`4ae917c`) — no round-1 test exercised dispose with a live server, and the fix round did not touch it. | [M] 50-supervisor boot/dispose: start 19–21 ms, `dispose()` **0 ms**, stopped lines **0**, and **50 supervisors still fired reconnect attempt 2 after dispose** (retry warns at t+500 ms — the reconnect timers were never cleared). Dispose-with-queued-restarts: starts stay 1/server, stops **0**, no errors (queued mutations absorb correctly, but teardown then stops nothing). Direct probe with a live applied generation: `manager.dispose()` → revokedLinesDelta **0**, stoppedLinesDelta **0**, tool **still registered** in the agent scope after dispose. [R] Code path `manager.ts:243-246`. | Every teardown path that calls `manager.dispose()` (plugin HMR/unload, `index.ts:76-78`, tests) leaks the live supervisors: stdio children keep running / HTTP sessions keep their reconnect loops, and any live tool registrations survive until the applier's own ctx-effect teardown happens to revoke them (and supervisors then keep pushing into a disposed applier — no-ops). Each HMR/reload cycle leaks one supervisor generation. **Fix:** stop first, delete inside `stopServer` as it already does — e.g. `await Promise.allSettled([...tracked.keys()].map((name) => stopServer(name, true).catch(() => {})))` — and add a regression test asserting "server stopped" lines and revoke on dispose with a live server. |
| R2P-2 | Medium | `src/client/server-card.tsx` / `section.tsx` (no memo anywhere, whole snapshot subscribed) | Round-2's per-card additions (remove/edit/clear buttons, definition chips, tri-state badge spans, per-workspace on/off labels + "new workspace default" footer, transient banner/confirm markup) raised the per-publish full-section render at 1 000 rows to 14.9–36.5 ms (jsdom/React-dev) from round-1's 11.8–14.2, and publishes per own-save commit are 4–6 (2–3 describes; stale describe results discarded by the generation guard, so 1–2 RPCs per commit are wasted). | [M] r2-client section bench (2×10: 2.3 ms; 20×50: noop 36.5 ms / toggle 27.7 ms; 50×20: 17.1 / 35.8; 5×200: 16.1 / 14.9; failed-toggle click at 1 000 rows with a visible `role=alert` banner: 4.8 ms median). Publish/describe accounting: own save 4 publishes/2 describes, with forwarded `settings/document-updated` 6/3, external commit 3/2. Read-back itself is negligible: `decodeDoc` 4.0 µs + `docsEqual` 3.4–7.8 µs at 50 servers. | Same axis as round-1 PERF-5, dispositioned "polish" — confirmed still open, and the per-publish constant grew. At 1 000 rows a single no-op publish is 15–37 ms synchronous in jsdom/dev (browsers faster, still linear in rows). Not a blocker at the section's realistic sizes (20 rows ≈ 2 ms). Fixes unchanged from round-1: tick-level publish coalescing in the controller (kills the duplicate refresh + wasted describe per commit), `React.memo` on `ServerCard`/rows with stable props, and a narrow doc-slice subscription instead of whole-snapshot. |
| R2P-3 | Low | `src/manager.ts:87-95` (`epochs`) | The per-serverName epoch map is append-only: entries are created on every `startServer` and never pruned when a server is removed from the doc. | [R] `nextEpoch` is the only writer (`manager.ts:91-95`); no `epochs.delete` anywhere. Growth = one ~50-byte entry per distinct serverName ever configured over the plugin's lifetime — bounded in practice by config churn, negligible memory. | Not a leak in any realistic session; note for hygiene. **Fix (optional, safe only for full removals):** delete the epoch in `stopServer` when the caller is a removal (server vanished from the doc, `revokeFirst=true`) — a re-added name then restarts at epoch 1 with no live applied generation to collide with. Never prune on restart-path stops (that would recreate PERF-2). |

R2P-1 was confirmed against the current tree only; the underlying typo class
(delete-then-lookup) exists in the same form in `4ae917c`, so it is a
pre-existing bug surfaced by this round's dispose quiescence check, not a
fix-round regression. No other regressions found: every code path the fix
round touched measured at or better than round-1 intent.

## 3. Per-request / per-event costs (measured answers to the review asks)

- **realpathSync count per event** [M]: `reconcile()`/`pushServerState()` call
  `registry.list()` **once per event** (`agents.ts:161-166,284` — counter: 1
  per reconcile) then one `workspaceIdOf` per entry = **one realpathSync per
  entry with a cwd**. `revokeServer` resolves nothing. Adopt pays 1 list + 1
  realpath. Measured realpathSync micro: **2.17–2.23 µs**; `workspaceIdOf`
  over 50 workspaces: 2.15–2.25 µs (1 realpath + 50 path compares). Applier
  delta: no-op reconcile at 200 agents × 4 servers with real cwds **0.51 ms
  (2.56 µs/entry)** vs **0.066 ms (0.33 µs/entry)** with cwd-less agents —
  the per-entry realpath delta ≈ 2.25 µs matches the syscall micro exactly.
  So the round-2 "re-resolve per event" rule costs ~2.2 µs × live entries per
  doc/sync event: ~0.11 ms at 50 agents, ~0.44 ms at 200 — negligible versus
  the pair loop it enables (which is itself ~0.3 µs/pair on the no-op path).
- **Adoption cost** [M]: 41–74 µs/register incl. realpath/list/adopt
  overhead — same order as round-1 (38.5 µs); 4×20-tool adopt = 3.3–5.9
  ms/agent; subagent spawn skip saves the whole registration fan-out
  (0.036 ms/agent).
- **One-server list_changed swap at 24 agents** [M]: **10.0 ms / 480 events**,
  only the changed server's pairs touched (48 lines for bench-a, 0 for
  bench-b) — equal to round-1's 8.6–9.9 ms within noise; the added per-event
  workspace refresh (~50 µs) is invisible at this scale.
- **Restart path cost** [M]: the epoch fix turns an absorbed no-op into one
  real generation swap of the restarted server's (agent × tool) pairs: 9.9–
  10.1 ms at 24×10 — the same cost as a `list_changed` re-sync, which a
  restart must pay anyway to land the new defs. Same-(epoch,syncId) re-push:
  3.5–5.1 µs (guard intact).
- **Coalescing** [M]: burst of 8 same-tick credential events → exactly 1
  stop/start and 1 log line (test `manager.spec.ts:165` covers 2; bench
  covers 8); queued-restart markers clear when the mutation runs, so later
  events restart again. Verified by log counting, not timing.
- **Boot/teardown** [M]: 50 supervisors reconcile-started in 19–21 ms
  (connect attempts run concurrently, fail fast on a closed port); second
  dispose idempotent and silent. Dispose quiescence itself is *not* a
  meaningful measurement today because of R2P-1 (dispose does no work); the
  applier half of teardown is verified: revokes 4 000 registrations in 20–24
  ms, 200 revoke lines, post-dispose events absorbed.
- **Landed-write read-back** [M]: per save the controller pays one extra
  decode + compare: `decodeDoc` 4.0 µs + `docsEqual` 3.4–7.8 µs at 50
  servers — negligible vs the RPC it verifies. No N+1 credentials describes
  introduced (all describes are one batched full-set call; per-commit 2–3
  calls with the duplicate refresh, stale results discarded by the FE-6
  generation guard).
- **Memory/boundedness** [M + R]: applier — entries dropped on
  `agent/disposed`, `applied` holds exactly one set per (agent × server)
  even after 1 500 swaps (revoke after them fired exactly 5 disposers),
  `serverState` replaced per commit; manager — `pendingRestarts` is
  self-clearing, `epochs` is append-only per distinct serverName (R2P-3);
  controller — listener sets fully cleaned across 100 start/stop cycles
  (subscriber count 0), credentials snapshot keys = doc ref set (40/40 after
  150 saves; replaced, never accumulated), per-attempt secret-cleanup state
  (`newlyStored`/`failedRefs`) is sized by the dirty secrets of one attempt.
  No unbounded structures found.

## 4. Methodology transparency

- Same harness recipe as round-1: real `Context` + SystemPrompt + ToolRuntime
  + real dsh-scope agent contexts; real `createAgentApplier`/`createManager`
  from `src/`; fixture stdio MCP server for manager E2E. Round-2 pushes carry
  `{ epoch, syncId, defs }` as the new API requires.
- New instrumentation: counting wrappers for `workspaceRegistry.list()` and
  the `overrides()` thunk (both injected through the applier's options —
  counts are exact), plus a counting-injected realpath for `workspaceIdOf`
  micro-checks; per-entry deltas derived by varying cwd shape at fixed agent
  counts.
- All timings in-process (vitest 3.2.7, Node 22.22.3, esbuild-transformed
  TS); UI in jsdom + React 18 **dev** — browsers will be faster; churn
  counts (events, log lines, publishes, describes) are
  environment-independent and are the primary evidence. Medians of ≥3 reps
  after warmup where the operation is side-effect-free (reconcile no-ops,
  guard pushes); real-churn operations (swaps, E2E restarts) are single
  runs — those numbers vary 1.5–2× between runs from GC, so ranges are
  reported. Manager E2E numbers include real process spawn/close.
- Benchmarks live in `.smoke/bench/r2-host.spec.ts` + `r2-client.spec.tsx`
  (gitignored, runnable with the two commands above); round-1 bench files
  were not rerun (their expectations encode the pre-fix behavior, e.g. the
  syncId-collision test now intentionally fails).
- Labeling: **[M]** measured, **[R]** reasoned, per table cell and finding.

## 5. Strengths (this round)

1. **Both Highs are genuinely closed** [M]: reconcile churn is O(changed
   pairs) (ratio 1.0 measured), no-op reconciles cost ~0.07–0.15 ms with
   zero events/lines, and restarts register the new generation with an
   auditable swap (identity change + `generation swap` revoke), with the
   µs-level guard preserved for true no-ops.
2. **The (epoch, syncId) dedupe design is clean**: one extra integer per
   server, bumped exactly where the handle identity changes, no layering on
   the per-event hot path beyond one comparison per pair.
3. **Per-event workspace re-resolution is cheap and correct** [M]: one
   `list()` + N realpathSyncs ≈ 2.2 µs/entry, and it makes deletion and
   late-created workspaces behave correctly with no event-ordering debt.
4. **Restart coalescing works under burst load** [M]: same-tick bursts of any
   size collapse to one cycle per serverName; markers clear so later real
   requests still restart.
5. **Client write-verification is cheap** [M]: the FE-1 read-back is a
   sub-10 µs compare at 50 servers, and badge refreshes stay one batched
   full-set describe — no N+1 was introduced by the tri-state/refresh
   changes.
6. **Boundedness holds under churn** [M]: 1 500 swaps, 150 saves, 100
   start/stop cycles — no accumulation anywhere measured.

## 6. Prioritized actions

1. **Fix R2P-1 (manager dispose) first** — one-line class fix plus a
   regression test asserting stops+revokes on dispose with a live server;
   it is the only correctness hole this round found, and it invalidates the
   teardown half of the perf story (HMR leak).
2. **UI polish per R2P-2** when the section is next touched: tick-coalesce
   controller publishes (kills the duplicate refresh + wasted describe per
   commit), memoize `ServerCard`, narrow the section subscription. Verified
   unchanged from round-1's recommendation; measured per-publish cost at
   1 000 rows is 1.3–2.6× round-1.
3. **Optional**: prune `epochs` on full server removal (R2P-3), keeping
   restart-path entries intact.
4. Re-run this suite after the R2P-1 fix; expect dispose at 50 supervisors to
   become ~O(50 × close) ms with 50 "server stopped" lines and the probe's
   `toolStillRegisteredAfterDispose` to flip to false.
