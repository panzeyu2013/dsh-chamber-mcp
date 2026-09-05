# dsh-mcp-scope — performance review

Evidence-based review of the per-workspace MCP server plugin (host half:
`src/index.ts`, `src/manager.ts`, `src/agents.ts`, `src/server.ts`, `src/tools.ts`,
`src/transport.ts`; browser half: `src/client/*`). Comparison point: the official
`@deepseek-ai/dsh-mcp-client` (one registry entry per tool, registered once in the
global layer — docs/recon/mcp-client-official.md §5).

**Date/version reviewed:** repo HEAD `4ae917c` (0.1.0). **Labeling:** **[M]** =
measured in this review (benchmarks under `.smoke/bench/`, gitignored; commands below);
**[R]** = reasoned from code with cited locations. All [M] timings are in-process
(vitest 3.2.7, Node 22.22.3, esbuild-transformed TS; UI numbers additionally in jsdom +
React 18 **dev** build, so browsers will be faster — the scale pattern, not the absolute
ms, is the evidence). Repo suite baseline: 87/87 tests pass.

---

## 1. Summary verdict

The design's cost model is **fan-out registration**: one MCP tool generation is
re-registered, def-by-def, into every live agent scope, i.e. total work per full pass
≈ `A_agents × Σ_servers T_tools` register/dispose pairs, where the official design pays
`Σ_servers T_tools` once. Each register/dispose costs ~15–35 µs (measured, includes one
`ctx.effect`, one `NamedEntries` insert, one `assertSupportedJsonSchema`, and **one
`tools/change` event emission per side**), so the fan-out is cheap at small scale but
dominates at scale:

- Reference case (2 servers × 10 tools × 20–24 live agents): **~12–13 ms** for a full
  sync push, **8.6–9.9 ms** for a one-server `list_changed` swap, **15.5–17.7 ms** with
  **900 registry events** for a *single workspace toggle* — where the minimal correct
  diff is ~50 revokes (**18× over-churn**), because `reconcile()` force-re-registers
  **every enabled (agent × server) generation on any namespace change** ([M]).
- Moderate-but-plausible scale (50 agents, 4 servers × 20 tools): **~150 ms + 8 000
  `tools/change` events + ~400 INFO log lines for a reconcile that changed nothing**
  ([M], 146–158 ms across runs). This runs synchronously on the host event loop.
- A related correctness hazard sits in the same idempotence machinery: a **restarted
  server's first commit reuses syncId 1, which the applier's same-syncId guard absorbs,
  leaving the pre-restart generation (executors bound to the closed SDK client)
  registered** until some later settings write — proven end-to-end with a real stdio MCP
  server ([M] + [R], PERF-2).

The per-*request* hot path is *not* degraded by the design: scoped `get()`/view
derivation costs the same as the global-registration baseline (~11–13 µs, [M]) because
entries land in the agent's own existing layer and chain depth is unchanged. Definitions
are shared object references across agents (no per-agent copy), memory is bounded by live
agents, and no unbounded structures were found ([R]). Boot is *less* gated than the
official plugin (no per-server activation await; connects run concurrently).

Verdict: architecture is sound for small deployments and its steady-state request path
matches the official baseline; the two things to fix before scaling up are (a) the
restart/syncId generation collision, and (b) the blanket force pass in `reconcile()`.
Both are small, local changes; together they remove ~90% of the measured churn and the
event/log storm. UI churn is real but modest (whole-section re-render per publish, no
memoization; publish amplification per host commit); worth one pass of coalescing/memo.

---

## 2. Findings

| ID | Sev | Location | Finding | Evidence | Why it matters / fix |
|---|---|---|---|---|---|
| PERF-1 | **High** | `src/agents.ts:223-231` (`reconcile()` → `applyToEntry(..., force=true)`), reached from `src/manager.ts:203-204` on **every** `onChange` (`src/index.ts:80-93`) | Every namespace change (even a toggle in one workspace, even a change that alters no server) force-revokes and re-registers every enabled (agent × server) generation: the `force` flag bypasses the same-syncId idempotence guard (`agents.ts:188`) for **all** pairs, not just the pair whose enablement flipped. | [M] One toggle at 24 agents × 2×10 tools: 15.5–17.7 ms, 900 def-events vs ≤50 needed (5 agents × 10 revokes, no re-register) = **~18× over-churn**. No-op reconcile at 50 agents × 4×20 tools: **146–158 ms, 8 000 `tools/change` events, ~400 INFO log lines**, synchronous in the host loop. Same-syncId *non-forced* re-push costs 0.013 ms (guard works — it is only ever bypassed by reconcile). | Churn is model-visible to every `tools/change` consumer and log-visible per (agent × server); scales linearly with agents × tools; unnecessary work for agents in *other* workspaces and for unchanged servers. **Fix:** diff per (entry, server): act only when enablement-vs-applied differs (flip OFF/ON) or `syncId` changed — i.e. call the same `applyToEntry` path without blanket force. Hoist `overrides()`/doc reads to once per reconcile. Pair with PERF-2 (see §5.2). |
| PERF-2 | **High** (correctness hazard surfaced by the perf guard) | `src/server.ts:186-211` (syncId starts at 0 per handle) vs `src/agents.ts:188` (guard on `syncId` only); restart paths `src/manager.ts:127-157` | A restarted supervisor is a fresh handle whose first commit is again `syncId 1`. If the old handle's last committed push was also 1 (the common case: no prior re-sync), the applier's same-syncId guard **absorbs the new generation**: new defs are never registered and the pre-restart defs (executors closing over the *closed* SDK client — calls fail) stay live until a later settings write force-re-applies. | [M] Applier-level: push(gen2, syncId 1) after push(gen1, syncId 1) → registry still holds gen1 (`staleGenerationKept: true`); self-heals only via `reconcile()`. Manager-level E2E with the real fixture stdio server: after a settings-driven restart (`envKeys` change → dispose + restart + re-sync, `synced 8 tools` twice) the registered defs were still the pre-restart ones (`staleDefsRetained: true`); healed by a later disable/enable cycle. | Today the forced reconcile partially masks this (it re-applies *old* state before the restart commit lands, and heals only on a *subsequent* settings write). PERF-1's fix (drop blanket force) is only safe after this is fixed. **Fix:** make the generation token survive handle restarts — manager/applier-level monotonic epoch per serverName (bump on every `stopServer→startServer` and on credential restarts), so dedupe is on (server, epoch, syncId); or `revokeFirst` on restart and re-register at the new commit. Also add a regression test: restart + new tool list must land in live agent scopes. |
| PERF-3 | Medium | `src/agents.ts:168-208` + dsh-tools `register()` (`layers.effect` → notify → `ctx.emit('tools/change')` per register *and* per disposer); applier INFO log per (agent × server) apply/revoke (`agents.ts:155,207`) | Per-def event + log storm during every swap/reconcile; each `tools/change` emission costs ~3.5 µs with zero listeners ([M]) and any real consumer (UI tool list, prompt assembly) is invoked synchronously mid-swap, able to observe partially-revoked generations. | [M] 1 `tools/change` per register (500/500) and per disposer (240-pair swap → 480 events); 8 000 events in one ~150 ms no-op reconcile (146–158 ms across runs). INFO logs: one line per (agent × server) per apply + revoke — ~400 lines per such reconcile at 50×4. | Eliminated almost entirely by PERF-1/PERF-2 fixes (no churn → no events). Residual mitigation if ever needed: aggregate INFO logs per push instead of per (agent × server), and keep registration swaps synchronous as today (they already are — no async window exists inside one pass, so no call can interleave mid-swap: Node runs the revoke→register sequence atomically; only event *listeners* see intermediate state). |
| PERF-4 | Medium | `src/agents.ts:251-260` (adopt on **every** `agent/created`, no roots filter — unlike the official schedule pattern `core-apis.md` §4c) | Each new agent — root session *or subagent* (delegation children, transient) — pays canonical-cwd realpath + full per-server registration into its own scope layer. Subagent bursts multiply registers; each also emits 1 `tools/change` per def. | [M] Adopt of 4 new agents after sync: 3.1 ms total ≈ **0.77 ms/agent** with 20 registers + 20 events each. Cost is load-bearing only if subagent scope views do not inherit parent-agent own-layer entries (restriction-filtered inheritance per `core-apis.md` §4a — own-layer entries are exemption-immune, which is the gating point of the design). | 0.5–1 ms per spawn at 20 tools is small per event but adds up in delegation-heavy workspaces (30 subagents ≈ 20 ms + 600 events). Optional: confirm inheritance semantics; if subagent chains inherit the parent agent's layer, adopt only root agents and let views inherit (would also cut PERF-1/PERF-3 fan-out for subagents). Otherwise document that per-subagent registration is the intended gate and accept the cost. |
| PERF-5 | Medium | `src/client/controller.ts:311-320,331-337,345-370` + `src/client/index.ts:115-122` + `src/client/section.tsx:75,151-165` (no `React.memo` anywhere; whole snapshot subscribed) | Whole-section re-render on every store publish, and publish amplification per host commit: scope event → publish + describe; forwarded `settings/document-updated` → publish + describe again; each describe resolution → publish. 2–4 full-tree renders per commit. Every render is a full S×W row tree with no memoization and no selector narrowing (`useDoc((s) => s)`). | [M] jsdom/React-dev full re-render per publish: 1 ms at 20 rows, **11.8–14.2 ms at 1 000 rows** — identical whether content changed or not (no-op publish == toggle publish), showing zero skipping. Mount: 27–144 ms at these scales. | Every click on a toggle re-renders all server cards of all workspaces; unrelated credential badge refreshes re-render the list too. **Fix:** coalesce publishes per tick (dedupe the scope-event + remote-event double refresh); memoize `ServerCard` (stable `server`/doc slice props) and the workspace-row list; keep the decoded doc identity stable between publishes; credentials badge state is per-ref — ideally subscribe credentials in a leaf component only. See §5.4. |
| PERF-6 | Low | `src/manager.ts:94-98,184-206` (single mutation chain; restarts serialize stop→start per server) | A doc change touching several server definitions (or removing several) stops/disposes servers **sequentially**; each `dispose()` awaits generation close + in-flight sync quiescence (`server.ts:389-410`), capped at 5 s per unresponsive child (`GENERATION_CLOSE_TIMEOUT_MS`). | [R] Normal stdio children close in ms; pathological ones cost up to 5 s each serially. Credential-update storms for N servers using one ref queue N sequential restarts (`manager.ts:170-181`). | Low frequency (settings edits are rare, human-driven) — acceptable today. **Fix (cheap):** dispose different servers in parallel inside one reconcile batch; keep the per-server close discipline intact. |
| PERF-7 | Low | `src/agents.ts:176,181` + `manager.ts:91` (`overrides()` → `getDoc()` re-read per (entry × server) pair inside reconcile loops) | `overrides()` (live settings read) is invoked up to 3× per pair during `reconcile()`; harmless today (settings resolve is cheap), but it is pure repetition inside the O(A×S) loop. | [R] | Read the doc once per reconcile and thread the value through the pair loop. Cosmetic; the real win is PERF-1. |

Non-findings worth recording (checked, no issue):

- **Per-request view cost parity** [M]: `tools.get(name, scope)` (full view derivation per call) ≈ **11.7 µs** in the per-agent layout vs **12.5 µs** in the global layout (20 agents × 20 tools). Registering into the agent's own layer adds no chain depth and no lookup cost.
- **Definitions are shared, not copied** [R]: `applyToEntry` (`agents.ts:194`) registers the *same* `ToolDefinition` objects from the supervisor's frozen master map into every scope; dsh-tools `register()` borrows the value (`NamedEntries.insert`), never mutates definitions (schema reads deep-clone at projection time). Sharing is safe; memory per (agent × def) is one layer-map entry + disposer closures only.
- **Definition duplication accounting** [R]: the doc's claim "copy of every tool into every agent" is true of *registration entries*, not of definition objects — object count stays `Σ T_s`.
- **`list_changed` re-sync scope** [R + M]: pushServerState touches only the changed server across enabled agents (measured 8.6–9.9 ms / 240 swap pairs at 24 agents) and skips disabled/empty pairs — correctly scoped, not over-broad (its per-def cost is the architecture multiplier, addressed by PERF-1/2 frequency control).
- **Memory/leak check** [R]: applier `entries` (per-agent bookkeeping incl. per-server disposer maps) is dropped at `agent/disposed` (`agents.ts:255-259`); scope-layer entries die with the agent ctx fiber; supervisor bookkeeping is bounded (one reconnect timer, unref'd; `syncChain` tail is a single settled promise; master defs maps are replaced per commit, never appended). UI listeners are effect-owned disposers (`index.ts:109-128`). No unbounded structures found in either half.
- **Credential resolves** [R]: per (re)connect attempt, per ref, sequential (`transport.ts:47-86`); typical N ≤ 3 and each is a provider read — trivial. Never cached, so fresh values reach the next attempt (correctness over micro-perf).
- **Sync/discovery parity** [R]: per-server `syncChain` serialization, `list_changed` → enqueued re-sync, backoff 500 ms→30 s, 10-attempt budget, 5 s close discipline, stability-window reset — byte-for-byte the official semantics (`server.ts:218-287`); reconnect timers `unref()`ed.

---

## 3. What I benchmarked & how

Throwaway vitest suites under `.smoke/bench/` (gitignored; kept for replication):

```
node node_modules/vitest/vitest.mjs run --config .smoke/bench/vitest.config.ts
```

- `.smoke/bench/bench-host.spec.ts` — mounts the **real** ToolRuntime + SystemPrompt on a
  root Context, real dsh-scope agent contexts (`createScope` keyed by agent objects), and
  the **real** `createAgentApplier`/`createManager` from `src/`, exactly per
  `tests/host/agents.spec.ts`; counting logger (silent) + `tools/change` counter on the
  root context (emission counts verified: 1 per register, 1 per disposer). Medians of 3–5
  reps after warmup. Includes an end-to-end manager scenario with the **real fixture
  stdio MCP server** (`tests/fixture/mcp-fixture-server.mjs`).
- `.smoke/bench/ui-bench.spec.tsx` — renders the real `McpScopeSection` via
  `react-dom/client` in jsdom with a `useSyncExternalStore`-backed store (React 18 dev);
  measures mount + full-tree re-render per store publish at 20 / 1 000 rows.

Micro breakdowns (500-tool loops, [M]): full `register()` into an agent scope
**28.9 µs/reg** (global-layer baseline 32.0 µs — identical unit cost); composition:
`assertSupportedJsonSchema` 3.6 µs, `tools/change` emit with zero listeners 3.5 µs,
`NamedEntries.insert+undo` 0.06 µs — the remaining ~20 µs (attribution by difference)
is the per-register Cordis `ctx.effect`/generator machinery (`layers.effect`, dsh-scope
`effect()`).

Caveats: all host timings are in-process (no I/O except fixture spawns) and include the
vitest transform pipeline (~10–20% overhead on micro numbers at most); UI numbers are
jsdom + dev React (browsers will be faster, likely 3–10×; per-publish cost scales
linearly with rows in both environments). Churn counts (events, log lines) are
environment-independent.

## 4. Strengths

1. **Request-path parity with official** [M]: per-`get()` view derivation costs the same
   as the global baseline — the per-agent design adds no steady-state lookup tax.
2. **Shared definitions** [R]: no per-agent copies; registry borrow semantics make the
   sharing safe; memory is bounded by live agents and reclaimed on `agent/disposed`.
3. **Targeted supervisor management** [R]: server diffing by `serverName` + fingerprint;
   only changed servers restart; credential events are filtered by `refsInUse()` and hit
   only servers drawing on the changed ref; overrides-only changes never restart servers.
4. **Boot behavior** [R]: `apply()` returns fast (no per-server activation gate — the
   official plugin *awaits* initial connect+sync per instance, so N official rows
   serialize N connect latencies at boot); supervisor connects start concurrently and
   tool availability races are absorbed by the push-to-agents model.
5. **Official-identical sync/reconnect discipline** [R]: serialized `list_changed`
   re-syncs, backoff/budget/close rules, unref'd timers; idempotent same-syncId re-push
   costs 0.013 ms [M] when the force flag is not involved.
6. **UI** [R]: credentials are re-described in **one batched RPC per refresh** (no N+1),
   writes are single revision-fenced mutations with pure diff plans, all listeners are
   effect-owned, and the section unmounts cleanly.

## 5. Prioritized actions

1. **Fix the restart generation collision (PERF-2) first** — it is a live correctness
   bug today (stale executors after any settings-driven or credential-driven server
   restart when the old handle had not re-synced), and PERF-1's fix depends on it.
   Introduce a per-server epoch that survives handle restarts (bump in `stopServer`/
   `restartServer`), include it in the applier dedupe key, and add a regression test
   that a restarted server's new tool list lands in live agent scopes.
2. **Replace reconcile's blanket force pass with a per-pair diff (PERF-1)** — act only
   when (enabled ⇔ applied) flips or the (epoch, syncId) changed; hoist the doc read out
   of the pair loop. Removes ~90% of measured churn/events/logs (18× over-churn measured
   on the toggle case; ~150 ms no-op reconciles disappear).
3. **Then re-measure** the reference scenario (expect: toggle ≈ 0.5 ms + ~50 events at
   24 agents; no-op reconcile ≈ 0).
4. **UI pass (PERF-5)**: coalesce controller publishes per tick (kills the 2–4 renders +
   2 describes per commit), memoize server cards/rows, keep decoded-doc identity stable
   between publishes, narrow the section's subscription to the doc slice.
5. **Optional hardening**: parallelize multi-server stop/start batches (PERF-6);
   aggregate per-push INFO logs (PERF-3 residual); decide/adopt root-agent-only
   registration if subagent inheritance semantics permit it (PERF-4).
