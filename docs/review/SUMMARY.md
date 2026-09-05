# Round-2 review — consolidated summary & dispositions

Six independent reviews of the post-M1 implementation (architecture, host
implementation, security, performance, interaction/UX, frontend). Each report
lives next to this file (`architecture.md`, `implementation.md`, `security.md`,
`performance.md`, `interaction.md`, `frontend.md`) with per-finding evidence.
All findings below were dispositioned; code fixes are in the current tree
(suite: **126 tests / 11 files green**, both typechecks, build + smoke
re-verified after the fix round).

## Verdicts at a glance

| Axis | Verdict | Critical/Major |
|---|---|---|
| Architecture | Conditionally sound; per-agent-scope gate is the correct R3 mechanism | 4 majors → fixed/documented |
| Implementation | Faithful mirror of official mcp-client; races walked microtask-level | 1 major → fixed |
| Security | No critical/major; model better than official on secret-at-rest | 0 |
| Performance | Fan-out design sound with parity costs; two churn/correctness hazards | 2 high → fixed |
| Interaction | Sound domain core; user-visible feedback under-communicated | 4 high UX → fixed |
| Frontend | Loadable, purity-clean, framework-injection mechanism proven real | 1 major → fixed |

## Disposition matrix (review ID → action)

### Fixed in code
| ID | Issue | Fix |
|---|---|---|
| FE-1 | `scope.mutate` resolves on Host refusal → false success | Post-write read-back compare (`docsEqual` over `normalizeDoc`); refusal ⇒ `conflict`; auto-unset of newly-written secrets on refused writes; pipeline tests |
| FE-2 | Message-scan error classification | Typed `code` (`settings/conflict`) + `isDSHRemoteError` first, scan as fallback |
| FE-3 | Inject list drift | `remote.credentials` added; unused `connection` dropped (grep-proven, commented) |
| FE-4 | Async pipeline untested | 41 controller tests incl. in-memory scope/gateway fakes: ordering, abort, refusal, overlap, revision pass-through |
| FE-6 | Describe race (stale badges) | Generation counter + ref-set check before publish |
| FE-10 | Client types unreachable | Type-only re-exports from the `./client` entry |
| FE-11 | setState-after-unmount | Mounted-ref guards; success paths skip trailing writes |
| FE-9 / UX copy | Hardcoded placeholders, mislabeled row buttons, un-pluralized counts | All localized (`{one,other}` count keys, dedicated add/remove-row keys, sample placeholders as locale copy) |
| UX-01/03 | No success signal; errors far from failing card | Per-card `role=alert` banners, form-local success/failure, `role=status` success note + focus move |
| UX-04 | No edit path; cards hid definitions | Edit affordance with prefilled staged form (rename migrates override rows); cards show command/args/url/env/header chips |
| UX-02 | Cancel/partial-save orphaned secrets | Controller-level auto-cleanup of newly-written refs on failure/refusal (never unsets pre-configured refs) |
| Badge tri-state | Describe failure read as "Not configured" | `secret.unknown` neutral state; retry on events |
| Workspace rows | Loading/error states blind | Localized loading/error gating; empty state only when settled |
| Form ergonomics | No Enter-submit/autofocus; fire-and-forget Clear | Real `<form onSubmit>`, autofocus, `type=button`, Clear pending/disabled |
| PERF-1/IMPL-2 | Reconcile blanket force ⇒ 18× churn | Diffed reconcile; no-op reconcile provably registers nothing |
| PERF-2 | Restart reuses syncId 1 → new generation absorbed | Manager-owned per-server **epoch** in the dedupe key + regression test |
| IMPL-1/ARCH-2 | WorkspaceId frozen at adopt (deletion/creation drift) | Re-resolved per push/reconcile; deletion revokes; creation-after-adopt applies |
| ARCH-3/IMPL-6 | Delegation children adoption semantics unverified | Adopt only non-`subagent`-origin agents (listener + roots scan symmetric); deviation documented |
| IMPL-4 | Give-up log/counter noise | Dedicated unregister commit; no `synced 0 tools` line; counters count real listings only |
| IMPL-7 | Dead `ready.then` + rejection risk | Removed (ready cannot reject) |
| IMPL-3 | Credential/settings double restart | `pendingRestarts` coalescing per serverName |
| SEC-02 | CR/LF/NUL values could reach headers/env + host logs | Transport-level value rejection (skip + ref-only warn) |
| SEC-03 | `__proto__`-style serverNames break off-switch | `RESERVED_OVERRIDE_KEYS` guard in `validateDoc` + tests |
| SEC-06 | Schema gaps on envKeys elements / header names | Covered by shared `validateDoc`; boot-layer path documented |
| ARCH-1 | Undeclared runtime imports | `zod` dependency + `@deepseek-ai/dsh-timeout` peer declared |
| FE-7/UX-17 | Doc drift (children slot claim, skipped-test wording) | design.md/ui-notes.md corrected |
| SEC-01/05 etc. | Cascade/robustness minors | Hardened/document policies in code comments + acceptance.md |

### Documented (accepted limitations or deliberate choices)
| ID | Issue | Disposition |
|---|---|---|
| ARCH-4 | No live assembled-model tool-list capture (cold sessions headless) | Known environment limitation (docs/milestones/M1.md); registry-level gate proof stands; m1 smoke now exits 0 recording `not-captured` |
| ARCH-3 tail | Delegation children see no MCP tools | Deliberate: preset scopes govern children (deviation documented in agents.ts + acceptance.md); re-evaluate with a real-delegation test on a chamber GUI |
| IMPL-3 tail | Reconcile-restart + credential-restart same tick can still double-cycle | Convergent; fingerprint-aware skip impossible for credential restarts by design |
| SEC-01 tail | Unset cascade operates on the shared ref namespace | Inherent to the credentials domain model (name-addressed refs); new-ref-only cleanup, best-effort unset, refusal-tolerant |
| PERF-UI | Whole-section re-render without memo | Accepted at current scale (jsdom ~1 ms @ 20 rows); coalesce/memo queued as polish |
| FE-5 | Hand-rolled styling vs ui-primitives/`--dsw-*` tokens | Accepted cosmetic divergence (plan's minimal-UI stance); revisit when token names are pinned |
| FE-8 | esbuild `__esModule`/getters vs official `Symbol.toStringTag` | Cosmetic; no default export exists, loader consumes raw exports |
| Image bridging | rc.1 official ships attachments-based image bridging; ours keeps rc.5 placeholders | Deliberate scope cut (docs/host-notes.md); image content degrades to placeholder text with diagnostics |
| SEC-04/08/10, UX-10…19 | Debounce, URL caps, disclosure polish, a11y extras | Tracked as future polish; bounded failures today (SDK timeouts, backoff, give-up) |

## Post-fix verification
- `tsc` (src + tests) clean; vitest **126/126** (11 files); build deterministic; client bundle requires only `react`/`react/jsx-runtime`; consumer d.ts check compiles.
- Live smoke re-run (scratch 0.1.2-rc.1): install → inventory active → namespace R/W + revision → server add → sessions/overrides all healthy; mock-LLM capture gap recorded as `not-captured`.
