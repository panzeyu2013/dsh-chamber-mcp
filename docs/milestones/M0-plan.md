# M0 smoke evidence plan (dsh-mcp-scope)

Ground truth: scratch instance = **anchor CLI 0.1.2-rc.1** (`/root/.dsh-chamber/gateway/
dsh-anchor/node_modules/@deepseek-ai/dsh/lib/bin.js`) with scratch `DSH_HOME` under
`.smoke/`, rc.1 wire (slash endpoints + token/cookie auth), ports 3212x.
Driver: `scripts/smoke/instance.mjs`. Evidence artifacts land in `docs/milestones/`.

| # | M0 item (from the plan) | Procedure | Evidence expected |
|---|---|---|---|
| ① | Third-party client module loads/renders in the GUI | install tgz into scratch web profile (`dsh plugin --profile web add file:…`), restart, `pluginInventory/list` | row `mcp-scope` module `dsh-mcp-scope` enabled+active (fresh boot only — rc.2 live-reload quirk); index.html `/plugins/dsh-mcp-scope/client.js` served; settings page section presence asserted via settings/describe schema + (M1) browser render check |
| ② | Official settings domain, third-party ns R/W + revision | `settings/describe` → ns `mcp-scope`; `settings/mutate` ops w/ expectedRevision; stale revision → `settings-conflict` | ns listed with schema + resolved default value; writes land in `settings.yaml` under `mcp-scope:`; revision bumps; conflict error code |
| ③ | Host half session lifecycle → scope injection/revoke, two workspaces one-on-one-off | workspaces ws-a/ws-b (real dirs); sessions created in both; `overrides[ws-b][server]` set via mutate; watch boot log | logger lines `mcp-scope(...)` apply (ws-a agent) / revoke-or-skip (ws-b agent); fixture MCP spawn banner; unit-level real-registry proofs in tests/host |
| ④ | Authoritative workspace enumeration | host: `workspaceRegistry.list()` (unit/integration test); UI: `useWorkspaces` items (render-side) | integration test assertions; describe `workspace/list` ids match UI rows (M1) |
| ⑤ | secret fields write-only + removal cascade | `credentials/set` ref; `credentials/describe` never returns value; remove server via mutate → UI-planned `credentials/unset` for orphan refs | describe returns {configured,writable} only; .credentials.yaml plaintext file state; cascade covered in tests/client buildSaveOps |
| ⑥ | User-install command for real + reinstall guidance | `dsh plugin --profile web add file:<tgz>` on fresh scratch home; assert bundles list; remove; re-add | package.json `dsh.profile.bundles` gains/loses `dsh-mcp-scope`; README documents commands |

M0 additional evidence beyond the plan's list: `docs/host-notes.md` + `docs/ui-notes.md`
(API signatures & mounting recipes) and unit/integration test suite under tests/.

Artifacts (create as they land):
- docs/milestones/M0.md — the evidence log with verbatim outputs
- docs/milestones/M1.md — UI E2E evidence (add server via UI-facing mutate, section render)
