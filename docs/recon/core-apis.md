# Recon: dsh core API contracts an MCP plugin depends on

Evidence report. Two source sets, both quoted verbatim where it matters:

- **ref-dsh** = source tree `~/projects/dsh-chamber/ref-dsh/packages/**` at version **0.1.0-rc.5** (all packages). Paths below abbreviate that root as `ref/packages/...`.
- **installed** = compiled `0.1.2-rc.1` packages under `/root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/<pkg>` (`lib/types/*.d.ts` authoritative). Paths abbreviate as `dsh-<pkg>/lib/types/*.d.ts`. **0.1.2-rc.1 is what real users run**, so where they differ, the installed contract wins.

Runtime composition of a real deployment (this install): `dsh-base/cordis.patch.yml` mounts the shared core rows — including `id: settings` → `@deepseek-ai/dsh-settings-file`, `id: credentials` → `@deepseek-ai/dsh-credentials-local`, plus `dsh-session`, `dsh-session-persistence-jsonl` (config `root: dshHomePath('sessions')`), `dsh-storage-json` (root `dshHomePath('storages')`), `dsh-tools`, `dsh-system-prompt`, `dsh-agent-loop` (`config: { agents: [] }`), `dsh-llm-deepseek`, `dsh-llm-pi-ai`, … Profiles are `$DSH_HOME/profiles/<name>` bundles (`boot/app-boot/src/profile.ts`).

---

## 1. dsh-settings

### 1.1 How a plugin declares its settings namespace + config schema

There is **no `settings` field on a plugin export**. A plugin that wants a user-editable section exports its schema as the entry `Config` (a schemastery schema, resolved from the composition `cordis.yml` row) and *additionally* registers a namespace whose schema is usually that same `Config`. Two idioms:

**0.1.2-rc.1 (installed)** — optional-settings consumer wiring inside `ctx.inject(['settings'], …)`:

```ts
// dsh-llm-deepseek/lib/index.js (installed) — pattern repeated by permission-presets, web-search-deepseek, bash-local, agent-loop…
const NS = "llm-deepseek"; // plain literal; type-checked as Namespace & SettingsNamespaceInput<Namespace>
ctx.inject(["settings"], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: ensureRegistrationFacts,
  });
});
```

**0.1.0-rc.5 (ref-dsh)** — same idea as a **free function** (removed in installed): `installSettingsSection(ctx, ns, schema, entry, hooks)` (`ref/packages/settings/settings/src/index.ts:863`). Namespace was made with a runtime brander `settingsNamespace('llm-deepseek')` (pattern `/^[a-z][a-z0-9-]*$/`, `index.ts:19-31`); the brander **does not exist in 0.1.2-rc.1** — replaced by the compile-time template-literal type `SettingsNamespaceInput` plus runtime `TypeError` guards ("not a lowercase hyphenated identifier"):

```ts
// dsh-settings/lib/types/index.d.ts (installed)
export type SettingsNamespace = Branded<'SettingsNamespace'>;
type SettingsNamespaceInput<Value extends string> = Value extends SettingsNamespace ? Value
  : string extends Value ? string
  : Value extends `${LowercaseLetter}${infer Rest}` ? ValidNamespaceTail<Rest> extends true ? Value : never : never;
// Methods are generic over it:
register<const Namespace extends string, T>(ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>;
```

Registration options (`SettingsRegisterOptions<T>`): `base?: Partial<T>` (composition entry config becomes the layer *below* the user document), `applies?: 'live' | 'restart'`, `validate?: (value: T) => void` (extra cross-field check; throwing refuses the write). `base` is how the *entry config* (what `apply(ctx, config)` received) is merged: resolved value = `schema(mergeLayers(base, userSection))` — i.e. **schema defaults ← composition entry `base` ← user document section** (`dsh-settings` d.ts `SettingsDescriptor` doc; ref src `resolve()` at `settings/settings/src/index.ts:696-710`). Registration is an effect on the calling fiber: duplicate namespace registration throws (`settings namespace "X" is already registered`); disposal of the registering fiber unregisters it (`register` doc, `index.ts:435-470`).

### 1.2 ctx.settings service API

```ts
// dsh-settings/lib/types/index.d.ts (installed; 0.1.0-rc.5 identical modulo namespace typing + installSection placement)
declare module '@deepseek-ai/cordis' { interface Context { settings: SettingsProvider } }
export declare abstract class SettingsProvider extends Service {
  abstract readonly writable: boolean;
  get documentPath(): string | undefined;          // file providers: absolute doc path
  prepareDocument(): Promise<string | undefined>;
  register<const Namespace extends string, T>(ns, schema, options?): SettingsScope<T>;
  installSection<const Namespace extends string, T>(owner: Context, ns, schema: z<T>, entry: T,
    hooks: SettingsSectionHooks<T>): void;          // 0.1.2-rc.1 ONLY (method); rc5: installSettingsSection(ctx,…)
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
  get(ns): unknown;                                  // resolved value; undefined while unregistered
  update(ns, patch: object, expectedRevision?: number): Promise<void>;    // deep-merge patch
  replace(ns, section: object, expectedRevision?: number): Promise<void>; // wholesale reset path
  mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>; // path ops for redacted writers
}
export interface SettingsScope<T> {
  get(): T;
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;  // disposer returned
  update(patch: object): Promise<void>;
  replace(section: object): Promise<void>;
}
export declare class SettingsConflictError extends Error {
  readonly code = "SETTINGS_CONFLICT"; readonly expected: number; readonly actual: number;
  constructor(ns: SettingsNamespace, expected: number, actual: number);
}
```

- Patch semantics: `update` merges recursively over the user section only; `replace` resets keys absent from the new section back to `base`/defaults; `mutate` applies `{op:'set'|'unset', path: string[]}` edits (exists so a redacted viewer can write fields it never saw). Writes to one namespace serialize on a queue; all inputs must be lossless-JSON; `undefined` object entries are sparse-patch semantics.
- **Change notification**: two Cordis emit events (`dsh-settings/lib/types/types.d.ts` (installed) / `settings/settings/src/types.ts` (rc5), identical):

```ts
'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void
// SettingsUpdateSource = 'update' | 'provider'; deep-equal-gated (never emitted when resolved value unchanged)
'settings/document-updated'(ns: SettingsNamespace, revision: number): void
// raw user section changed (inherited→overridden, same value) — for config surfaces holding a revision
```

A plugin observes **its own** namespace via `scope.watch(cb)` (serialized per callback, in commit order; disposer guarantees no invocation after removal) — that is the sanctioned pattern; `settings/updated` is the raw event (filter on your own `ns`). `SettingsDescriptor` (from `describe()`, one per registered namespace, registration order) carries `{ns, schema: schema.toJSON(), value, revision, base?, user?, applies, secrets?}`.
- **Validation/defaults**: schema is the validator (schemastery `z<T>`); a stored section that fails validation at provider reload keeps the last good resolved value and warns; registration-time failure rejects registration. `validate()` rejects the write that produced a bad resolved value. `describe({ redactSecrets: true })` strips `role('secret')` fields from value/base/user and enumerates them in `secrets: RedactedSecret[]` — **every wire surface must pass `redactSecrets: true`** (SettingsDescribeOptions doc).

### 1.3 Host-plugin usage scan (ctx.settings / settings in ref-dsh)

- Uses settings: `llm/llm-deepseek` (`index.ts:270 installSettingsSection(ctx, NS, Config, config, …)`), `llm/llm-pi-ai` (`:278`), `web/web-search-deepseek` (`:129`), `interaction/permission-presets` (`index.ts:73` exports `PERMISSION_SETTINGS_NAMESPACE = settingsNamespace('permission')`, `:211`), `core/agent-loop` (`AGENT_LOOP_SETTINGS_NAMESPACE = 'agent-loop'`, `index.ts:237,335`), `core/agent-default-model`, `shell/bash-local`, `shell/pwsh-local`, client ui-theme/locale/ui-conversation (client side reads via remote describe).
- **mcp-client does NOT use ctx.settings** — it is a plain entry-config plugin (`mcp/mcp-client/src/index.ts`: exports `name='mcp-client'`, `inject=['tools']`, `Config` (z.union stdio/http), `async apply(ctx, config)`). Same for `schedule`. So "settings-aware" is opt-in; entry `config` always exists, user section only when the plugin registers.

### 1.4 Storage: settings-file

`dsh-settings-file` (`ref/packages/settings/settings-file/src/index.ts`, installed d.ts identical):

```ts
export interface Config { path?: string; dshHome?: string; watch?: boolean; debounceMs?: number }
// resolveSpec: filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), 'settings.yaml'))
// format from extension: .yaml/.yml/.json; YAML default
export declare class FileSettingsProvider extends SettingsProvider {
  get writable(): boolean;           // always true
  get documentPath(): string;        // resolved spec.filename
  prepareDocument(): Promise<string>; // materializes owner-only 0600 empty doc under 0700 dir
  static Config: z<Config>;
}
```

- **File/location**: one document `<DSH_HOME>/settings.yaml` (mode 0600, dir 0700) holds **every namespace as one top-level section key** (ns → raw user section). External edits are hot-published via chokidar watcher (write-settle `debounceMs` default 100); every in-process write re-reads under a cross-process writer lock and patches as a comment-preserving leaf diff (`patchNode`, `index.ts:74-92`). Unparsable doc → boot failure; at reload, warns and keeps last good.
- **Revision semantics**: the revision is **per registered namespace, in-memory only, never stored in the file**. `SettingsRegistration.revision` starts at 0 and bumps by 1 whenever the *raw user section* changes (deep-equal-gated, including a change that leaves the resolved value identical — an override equal to the base); it is monotonic per live registration and resets on re-registration. Callers pass it back as `expectedRevision`; a mismatch rejects the queued write with `SettingsConflictError` (`expected`/`actual`). A descriptor's `revision` is the value to echo. (`settings/settings/src/index.ts:719-723` bumpRevision + doc at `:340-342`; conflict check at `:625-627`.)

---

## 2. dsh-credentials

**Big version delta**: 0.1.0-rc.5 has only the *reference* half; **0.1.2-rc.1 adds a second, disjoint key space of durable "records"**.

### 2.1 Reference half (`CredentialRef`) — both versions

```ts
// dsh-credentials/lib/types/index.d.ts (installed)
export type CredentialRef = Branded<'CredentialRef'>;   // POSIX env-var name; /^[A-Za-z_][A-Za-z0-9_]*$/
credentialRef(value: string): CredentialRef; isCredentialRefName(value: string): boolean;
export abstract class CredentialProvider extends Service {
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>; // { value: string; source: string } | undefined
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>;   // {configured, source?, writable} — never the value
  abstract set(ref: CredentialRef, value: string): Promise<void>;   // rejects empty; rejects when a read-only layer shadows
  abstract unset(ref: CredentialRef): Promise<void>;                // idempotent; same shadowing rejection
}
// Event name delta: rc5 emits 'credentials/updated'(ref); installed emits (types.d.ts):
'credentials/reference-updated'(ref: CredentialRef): void
```

Rules: resolution is per-call (never cache across operations); empty stored value == absent; ambient process-env changes are not observable (no event). The managed store only layers **below** inherited process env.

### 2.2 Record half (`CredentialKey`) — 0.1.2-rc.1 ONLY

```ts
// dsh-credentials/lib/types/index.d.ts + types.d.ts (installed)
export type CredentialKey = Branded<'CredentialKey'>;   // "<scope>/<id>"
export function credentialKey(scope: string, id: string): CredentialKey;   // segments: lowercase hyphenated identifiers
export function parseCredentialKey(value: string): CredentialKey;
export function credentialKeyScope(key): string;  export function credentialKeyId(key): string;
export type CredentialRecord = ApiKeyRecord | GrantRecord;
// ApiKeyRecord = { kind:'api-key'; key?: string; env?: Readonly<Record<string,string>> }  (both may be absent = "owner confirmed ambient auth")
// GrantRecord = { kind:'grant'; payload: unknown }  — opaque JSON, owner's own format
abstract readRecord(key): Promise<CredentialRecord | undefined>;
abstract describeRecord(key): Promise<CredentialRecordInfo>;
abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;   // {key, kind} only
abstract modifyRecord(key, mutate: (current) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>; // ONLY write path (read-modify-write under cross-process lock)
abstract deleteRecord(key): Promise<void>;
// event: 'credentials/record-updated'(key: CredentialKey): void
```

Conventions (documented in the d.ts): `scope` = **the owning plugin's registered name**, `id` = the plugin's own addressing unit. Real usage, installed `dsh-llm-pi-ai/lib/index.js:1849-1861`:

```js
const RECORD_SCOPE = "llm-pi-ai";   // “the plugin's registered name … tells a later reader … that this plugin owns the format inside the record”
function recordKeyFor(providerId) { return credentialKey(RECORD_SCOPE, providerId) }   // providerId = harness route key
// list side filters: if (credentialKeyScope(entry.key) !== "llm-pi-ai") continue;
```

### 2.3 Storage: `.credentials.yaml`

`dsh-credentials-local` (installed d.ts): `CREDENTIALS_FILENAME = ".credentials.yaml"`, document at `<DSH_HOME>/.credentials.yaml`; `DOCUMENT_VERSION = 1`. Layered resolution (most trusted first): inherited process env (read-only, wins) > `$DSH_HOME/.credentials.yaml` (provider-managed, writable) > `<invocation cwd>/.env` > `$DSH_HOME/.env`. The file is a **strict store, never materialized into the environment**; writes re-read under a cross-process writer lock and patch comment-preserving. v1 document layout (parsed by `parseCredentialsDocument(text, filename)`):

```ts
export interface CredentialsDocument { refs: Map<string, string>; records: Map<string, CredentialRecord> }
```

(one top-level map per key space; flat pre-release layout auto-migrates under `refs:` via `renderFlatLayoutMigration`). Environment variables **never live in the managed document** — a ref stored through `credentials.set` shadows `.env`, and an inherited env value makes the store read-only for that ref (writes reject with "shadowed").

### 2.4 How a UI/API stores a secret and a plugin reads it (reference half)

- Settings schemas declare `z.string().role('secret')` for inline keys and `z.string().role('credential-ref')` for env-name fields (llm-deepseek `Config.apiKeyEnv` default `'DEEPSEEK_API_KEY'`, `llm/llm-deepseek/src/index.ts:44,92`; web-search-deepseek `:64-65`). Secret fields are stripped from every wire `describe` (`role('secret')` redaction lives in `dsh-settings` `redact.ts` — the web UI never sees a stored secret, so a config card's secret control writes out-of-band via `api.credentials.set({ref, value})`, cf. `client/ui-settings-plugins/src/client/web-search-card-controller.ts:174` and card-form `CardSecretSpec`).
- Host RPC face (ref `host/apiproxy/src/api/credentials.ts`, also `credentials.describe/set/unset` in `fetch/handler.ts:137-139` and `api-proxy.ts:3326-3358`): `credentials.set(request {ref, value}) → {}`, `credentials.unset {ref}`, batch `credentials.describe {refs: string[]} → {credentials: Record<string, CredentialView>}`; wire errors `bad-request` / `credential-rejected`. Plugins then call `credentials.resolve(credentialRef(config.apiKeyEnv))` **per operation** (llm-deepseek `index.ts:231`, web-search-deepseek `index.ts:104`).
- **"secret-role" literal does not exist anywhere** — grep of ref-dsh and all installed d.ts found only a test description string ("treats a secret-role container as one opaque secret leaf", `settings/settings/tests/redact.spec.ts:82`). The mechanism is schemastery's generic `Schema.role(text, extra?)` builder (`@deepseek-ai/schemastery/lib/types/index.d.ts:153-154`, `role?: string` in `Meta`); the harness convention is role **`'secret'`** (interpreted by dsh-settings `redactSecrets` and by form UIs) and role **`'credential-ref'`** for env-name pickers (defined nowhere as a type — same `.role()` string, read by settings/plugin-config UIs; there is no dedicated package).

---

## 3. dsh-workspace + workspace controllers

### 3.1 Host-side service

```ts
// dsh-workspace/lib/types/index.d.ts (installed; rc5 same) — ctx.workspaceRegistry
export type WorkspaceId = Branded<'WorkspaceId'>;      // generated uuid, never the path
export declare class WorkspaceRegistry extends Service {
  static inject: string[]; // ['storageDomain','sessionPersistence']
  create(path: string, title?: string): Promise<Workspace>;
  get(id: WorkspaceId): Workspace | undefined;
  list(): Workspace[];                    // synchronous, durable registry order; NO subscription API
  delete(id: WorkspaceId): Promise<boolean>;
  insertBefore(id, beforeId?): Promise<readonly WorkspaceId[]>;
  get archivedSessionIds(): readonly SessionId[];
  archiveSession(sessionId: SessionId): Promise<void>;
  resolveByPath(path: string): Promise<Workspace | undefined>;   // canonical realpath equality (both versions; installed d.ts:139)
}
export interface Workspace {              // dsh-workspace/lib/types/types.d.ts
  readonly id: WorkspaceId; readonly path: string;   // canonical fs.realpath of create-time path, immutable
  readonly title: string; readonly createdAt: string; readonly updatedAt: string;
  readonly sessionIds: readonly SessionId[];         // header-validated membership, manual order
  setTitle(title: string): Promise<void>;
  attachSession(sessionId): Promise<void>;           // validates header.cwd canonical == path
  insertSessionBefore(sessionId, beforeSessionId?): Promise<void>;
  detachSession(sessionId): Promise<void>;
  status(): Promise<'ok' | 'missing-dir'>;
}
```

Membership rule (quoted from entity doc): "Membership requires both an id in that account and a session header whose canonical cwd equals the workspace path." Boot auto-accounts historical sessions grouped by canonical cwd; workspaces are durable records in the storage domain (`workspaces` table + order state; `realpathNormalize` canonicalization). Host callers in ref: `host/apiproxy/src/api-proxy.ts:1513` list, `:1712` resolveByPath/create, `:2220`/`:2449` attachSession after create/fork, `:2805-2919` web endpoints incl. follow baseline.

### 3.2 Session↔workspace relation (and the missing `session.workspaceId`)

**There is no `workspaceId` on Session, SessionHeader, or any session event.** `SessionHeader` (`dsh-session/lib/types/index.d.ts`, rc5 `core/session/src/types.ts:61-99`) carries only `{version, id, createdAt, cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset?}`. Workspace is a derived/registry fact: `workspace.sessionIds` (validated against `header.cwd`), or canonical `cwd` equality via `resolveByPath`. Id convention: session ids are `session-<uuid>` strings branded `SessionId` (`api-proxy.ts:2165` `session-${randomUUID()}`); the typert wire lookup for a session is `'session'` with parameter `session`, wire `sessionId` (`core/session/src/index.ts:797-801`).

### 3.3 Web-client side (installed `dsh-api-workspace-controller`)

Host face (from `lib/typert.remote-client.d.ts` — generated; the exact endpoints the web client calls):

```ts
interface TypertRemoteNamespaceMap {
  'workspace': {
    create(request: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>>      // {path} → {workspace, created}
    rename({workspaceId, title}): Promise<RemoteResult<WorkspaceValue>>;
    delete({workspaceId}): Promise<RemoteResult<WorkspaceDeleteValue>>;
    insertBefore({workspaceId, beforeWorkspaceId?}): Promise<RemoteResult<WorkspaceOrderValue>>;
    insertSessionBefore({workspaceId, sessionId, beforeSessionId?}): Promise<RemoteResult<WorkspaceValue>>;
    archiveSession({sessionId}): Promise<RemoteResult<WorkspaceArchiveValue>>;
    follow(signal?): AsyncIterable<WorkspaceFollowFrame>;   // reconnect-safe state stream
  }
  'directoryPicker': { createDirectory(path, name); list(path?); pick() }   // from dsh-host-directory-picker
}
```

`WorkspaceView = { workspaceId, path, title, sessionIds, createdAt, updatedAt }`; `WorkspaceFollowFrame = {type:'baseline', value:{items, archivedSessionIds}} | {type:'upsert'|'remove'|'order'|'archived', …}` (`lib/types/types.d.ts`). Client controllers (installed): `WorkspaceController extends Service implements IWorkspaces` with `readonly list: WorkspaceSource` (`getSnapshot()/subscribe(listener): () => void` — observable snapshot store) + command methods; `ClientWorkspaceModel` owns the projection (`lib/types/client/service.d.ts`, `model.d.ts`). Remote error codes: `workspace/invalid-path`, `workspace/name-conflict`, `workspace/not-found`, `workspace/move-invalid` (`lib/types/types.d.ts`, dsh-workspace types.d.ts). rc5-era equivalents of these endpoints live in `host/apiproxy/src/api-proxy.ts` (same vocabulary; rc5 API has no directoryPicker/typert split).

---

## 4. core/scope + core/session + core/tools + core/agent

### 4a. The layered tools registry (dsh-tools)

```ts
// dsh-tools/lib/types/index.d.ts (installed; API identical to rc5 except mode value 'code'→'ptc')
export declare class ToolRuntime extends Service {
  register(definition: ToolDefinition): () => void;   // exact disposer = unregister
  restrict(filter: ToolRestriction): () => void;       // scoped ctx only; per-scope allow/deny mask over INHERITED tools
  guard(guard: ToolGuard): () => void;                 // monotonic denial check; global or per-agent via ctx
  presentAs(mode: ToolPresentationMode): () => void;   // scoped ctx only
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined;
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>;
}
export type ToolPresentationMode = 'native' | 'ptc' | 'both';   // rc5: 'native' | 'code' | 'both'
export interface ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```

- **Layering** (registry internals, rc5 `core/tools/src/index.ts:1031-1118` and `view()` at `:1159-1210`): tools live in per-`ScopeKey` layers (global layer for unscoped ctx). `register()` inserts into the layer of `this.ctx`: **global ctx ⇒ global tool; an agent-scoped ctx (`agent.ctx`) ⇒ that agent's scope layer**. Scoped tools shadow inherited (global/ancestor) same-name tools; a scope's own layer is never filtered by restrictions; the reserved `run_code` presentation transport is appended outside the layers (per scope, only when that scope's mode is non-native). `ScopedLayers` (`dsh-scope`) gives each scope a chain: an agent's layer parent is its composition/preset scope, up to global.
- **Input**: a single `ToolDefinition` object (not `(name, schema, exec)`). `ToolDefinition extends ToolSchema` (name/description/parameters from `@deepseek-ai/dsh-llm`) plus **mandatory** `output: ToolOutputDefinition` (`{ schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }`), `execute(args: unknown, exec: ToolRunContext): Promise<unknown>`, and optionals `finalizeContent?`, `timeoutMs?`, `isConcurrencySafe?(args)`, `presentCall?`, `presentResult?` (`index.d.ts:96-135`, `ToolOutputDefinition` at `:96-104`). `defineTool({name, description, parameters, output, execute, …})` is the typed builder (dts export). Runtime `register()` validates: throws `TypeError` unless `output.schema`+`render` present; `assertSupportedJsonSchema(output.schema)`; `timeoutMs` positive finite; **reserved name**: `tool name "run_code" is reserved for the Code Mode/PTC presentation transport and cannot be registered or shadowed`.
- **Conflicts**: per-layer `NamedEntries` insertion failure — `tool "X" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` (global) / `tool "X" is already registered in this scope` (scoped).
- **Pipeline events** (scope-filtered, `Scoped<ToolRuntime>`): `'tools/pre-execute'(exec, next): Promise<PreToolDecision>` (waterfall), `'tools/execute'(exec, next)` (waterfall around-dispatch), `'tools/post-execute'(exec, result, next)`, `'tools/code-dispatch-log'`, `'tools/result'(exec, result)` (emit, unfrozen final), and unfiltered `'tools/change'()`. Tool call identity: `ToolExecutionInput { callId, name, arguments, agent?: Agent, signal, parent? }`; the loop sets `agent` = the agent on whose behalf the call runs, which is also the scope key for filtered dispatch (`index.ts:146-209` d.ts; `ToolExecutionInput.agent` doc "set by the agent loop").
- **Call-time access to the calling session/agent inside a tool**: `execute(args, exec: ToolRunContext)` — `exec.agent` (or `exec.agent.session.header.cwd`) and `exec.signal`. Guard/restrict decisions happen in registry/agent-layer code; a guard registered on a plain ctx sees every call (`guardReason` walks global then `exec.agent` chain, `index.ts:1119-1137`).

### 4b. dsh-scope (what it defines)

`dsh-scope` is the scoped-context primitive, not a domain model: `ScopeKey = object` (identity-compared; **the live `Agent` object is used as its own scope key**), `createScope(ctx, key, options?) → {ctx, rawDispose, dispose}`, `bindScopeParent(key, parent) → {rebind}`, `scopeOf(ctx): ScopeKey | undefined`, `scopeTarget(base, key): Scoped<T>`, `scopeChainOf`, plus `ScopedLayers`/`NamedEntries`/`AnonymousEntries`/`ScopeLayer` (store.ts) powering tool/prompt registration inheritance: child scopes inherit ancestor layers; event dispatch admits a listener tagged with any ancestor key ("events flow up the chain, never down"). Files: `ref/packages/core/scope/src/{index,store,scoped-events.generated}.ts`.

Agent-scope derivation (rc5): `core/agent-loop/src/agent.ts:94` `this.scope = createScope(loopCtx, this)` (key = the agent); registry dispatch uses `scopeTarget(agent, agent)` carriers (`core/agent/src/index.ts:479`), so `ctx.on('session/created', …)` **on `agent.ctx`** receives only that agent's sessions; preset mounts link agent keys to a standing composition scope via `bindScopeParent(agentKey, standing.key)` (`preset/agent-presets/src/index.ts:286,323,467`); `ctx.agent` DX accessor is `Agent|undefined` own-property on `Agent.ctx` (`core/agent/src/index.ts:36-50`).

### 4c. Session lifecycle (dsh-session + dsh-agent)

```ts
// dsh-session/lib/types/index.d.ts (installed) — identical names in rc5 core/session/src/index.ts:37-87
declare module '@deepseek-ai/cordis' { interface Events {
  'session/created'(this: Scoped<Session>, session: Session): void;   // emit; sync throw vetoes + rolls back with paired disposal
  'session/disposed'(this: Scoped<Session>, session: Session): void;
  'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;  // post-commit fire-and-forget append feed
  'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;       // awaited parallel durability checkpoint
}}
// Agent events (core/agent/src/runtime-types.ts:146-292, installed dsh-agent d.ts same):
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent }): void;
'agent/disposed'(… payload { agent }): void;
'agent/status'(… { agent; status: AgentStatus }): void;              // 'idle' | 'running'
'agent/session-start'(… { agent; source: SessionStartSource }): void; // 'startup'|'resume'|'clear'|'compact'
'agent/inbox/inserted|claimed|discarded'(…), 'agent/pre-step'(…, next), 'agent/request'(…, next),
'agent/request-error'(…, next), 'agent/turn-stopping'(…), 'agent/error'(…)
```

There are **no exported event-name constants** — the names are literal keys declared on the Cordis `Events` interface (dispatch via `ctx.on(...)`/`ctx.emit(...)`).

`SessionStore` (ctx.sessions): `create(id?, options?)`, `prepare(id?, options?)`, `enter(session): () => void` (returns detach closure; no `session/created` emit), `announce(session)` (emits `session/created` — "a synchronous `session/created` listener throws → the store rolls back with a paired disposal", `enter` doc at d.ts:361-376), `flush(session)`, `get(id)`, `list()`, `fork(...)`. Publication sequence (AgentFactory doc, `core/agent/src/index.ts:183-214`): unpublished `agentCtx` minted → `setup(agentCtx)` awaited → optional synchronous `commit()` → session inserted + announced (`session/created`) → agent inserted + announced (`agent/created`) → `agent/session-start` → loop starts. `Session` fields: `id`, `header: SessionHeader`, `surface`, `events`/`append`, `snapshotEvents`, `requestHeader()`, `deriveMessages()` etc.

**Official per-agent/session tool-attachment pattern** (schedule plugin — canonical, quoted): global plugin listens for root agents once (`schedule/schedule/src/index.ts:33-71`):

```ts
ctx.effect(() => {
  const stopCreated = ctx.on('agent/created', ({ agent }) => {
    if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
    const cleanup = agent.ctx.effect(() => {                       // everything is scoped to the agent
      const disposeTools = registerScheduleTools(ctx, agent.ctx, agent, …)  // toolCtx.tools.register(defineTool({…})) per tool
      const stopStatus = agent.ctx.on('agent/status', …)
      runtime.start()
      return async () => { stopStatus(); disposeTools(); await runtime.dispose() }
    }, 'schedule.runtime()')
    runtimes.set(agent, cleanup)
  })
  return async () => { … }   // unload: dispose every agent runtime
}, 'schedule.lifecycle()')
```

`registerScheduleTools(rootCtx, toolCtx, agent, onDurableChange)` pushes `toolCtx.tools.register(defineTool({name, description, parameters, output: {schema, render}, execute…}))` disposers and returns an aggregate disposer (`schedule/schedule/src/tools.ts:296-330`). Executions re-check `exec.agent !== agent` as a defensive scope assertion (tools.ts `schedule_list`). Tools may also be registered **globally** at plugin load (mcp-client does this: tools are published on `ctx.tools` for every agent once connected, `mcp/mcp-client/src/tools.ts`).

---

## 5. Workspace at session-event time; call-time gating

- **Sessions are created with a cwd, not with a workspace**. Gateway/web session creation (`host/apiproxy/src/api-proxy.ts:2165-2235`): optional `workspaceId` in the request → registry lookup → `cwd = workspace?.path ?? payload.cwd ?? defaults.cwd` → `ensureSession(sessionId, cwd, …)` → `ctx.agents.create({ sessionId, meta: {cwd, …}, setup })` → **after** publication `await workspace.attachSession(sessionId)` (failure ⇒ `workspace-attach-failed` error, session stays live). Forks similarly attach after creation, choosing the workspace by membership of the source (subagent sources walk `sessionQuery.traceSession(source.id)` ancestors, `forkWorkspace` `api-proxy.ts:1512-1526`).
- So inside a `session/created` listener the workspace **is not yet attached** — and the event carries no workspace. Reliable mapping: session → workspace by membership (`workspaceRegistry.list().find(w => w.sessionIds.includes(session.id))`) or by canonical `header.cwd` (`workspaceRegistry.resolveByPath(cwd)`; canonical path equality is the membership predicate). Workspace membership self-heals on the *next* registry mutation and at boot.
- **Tool-call-time gating** uses `exec.agent` (or scope-filtered events): an execution's `agent: Agent` gives `agent.session.header.cwd` for cwd checks, and workspace checks can be done per call against `ctx.workspaceRegistry` (list/resolveByPath are sync reads in-process; the registry is a plain service available on any host ctx). Official filters prefer `tools.restrict()`/`tools.guard()` on the agent scope; for decision data that changes, read per call — mirroring the credentials rule (never cache across operations).
- Session-scoped (per-agent) subscriptions: register listeners **on `agent.ctx`** (`agent.ctx.on('session/event', …)`), and remember dispatch scoping keys on `agent` — `session/created` dispatched with `Scoped<Session>` built from the agent scope only reaches listeners on `agent.ctx` (or global ctx).

---

## 6. Home paths, base bundle, env discipline

### 6.1 DSH_HOME

`dsh-home-paths` (`ref/packages/util/home-paths/src/index.ts`, installed d.ts same):

```ts
export const DSH_HOME_DIR_NAME = '.dsh';
export const DSH_HOME_ENV = 'DSH_HOME';
resolveDshHome(configured?, env = process.env): string;  // configured > $DSH_HOME (empty/whitespace = unset) > ~/.dsh
dshHomePath(...segments): string;  expandHomePath(path); defaultDshHome(); dshHomeDisplay(home);
```

Known files/dirs under the home (from providers/composition quoted above): `settings.yaml` (settings-file default), `.credentials.yaml` (credentials-local), `sessions/` (jsonl persistence root, configured `dshHomePath('sessions')` — layout `<root>/<projectKey(cwd)>/<encoded-session-id>/session.jsonl` or `.jsonl.zstd`, `session-persistence-jsonl/src/format.ts:177-207`), `storages/` (storage-json root), `.env` (user env layer), `profiles/<name>/` with `package.json` (`dsh.profile.bundles`), `cordis.patch.yml`, and the flat module fallback `profiles/node_modules` (one symlink per install package; `boot/app-boot/src/profile.ts:36-111,204-220`). Profile templates: `web` = `[dsh-base, dsh-web-app]`, `headless` = `[dsh-base, dsh-headless]` (`profile.ts:114-117`).

### 6.2 dsh-base

`dsh-base` carries **no runtime API** (`lib/types/index.d.ts`: "`@deepseek-ai/dsh-base` — the shared dsh core as a profile bundle … this module carries no runtime API."). Its substance is `cordis.patch.yml` — the one insert list that rows real profiles load (settings-file as `id: settings`, credentials-local as `id: credentials`, tools/system-prompt/agent-loop rows quoted above).

### 6.3 Env discipline (what is stripped / layered)

- `dsh-subprocess` (`ref/packages/subprocess/subprocess/src/index.ts`): `DSH_ENV_PREFIX = 'DSH_'`; `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`; `scrubbedParentEnv(): Record<string,string>` = ambient env **minus credential-shaped names minus all `DSH_*` names** (case-insensitive) — "the canonical base every harness child starts from"; explicit env layers merge after the scrub. (Also the type `DshEnvironment = Readonly<Record<`${'DSH_'}${string}`, string>>` — deliberately forwarded `DSH_*` facts ride the spec's explicit `env`.) Remote/E2B subprocesses scrub the same way (`e2b/subprocess-e2b/src/environment.ts:65` `name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)`).
- `mcp-client` stdio children: `buildChildEnv(extra) = { ...scrubbedParentEnv(), ...extra }` (`mcp/mcp-client/src/transport.ts:12-22`) — **so an MCP server child never inherits DSH_* or secret-shaped env**; anything needed must be passed in the config `env` map.
- Launch env model (`util/launch-environment/src/index.ts`): immutable snapshot over layers `'process' > 'project-env' (<invocation cwd>/.env) > 'user-env' ($DSH_HOME/.env)`; `launchEnvironmentOf(ctx)`, ctx key `launchEnvironment`; app-boot loads cwd `.env` then home `.env` before config entries mount (`boot/app-boot/src/index.ts:167-206`). Adapters resolve `DEEPSEEK_API_KEY`-style refs through this when no credentials seam exists.
- Credentials-local layering is the same trust order, with the managed file above `.env` (section 2.3).

---

## Imports we would need (exact package names + top-level exports)

Package names are `@deepseek-ai/<name>`; listed exports are runtime exports (verified from installed `lib/index.js` / `lib/types/*.d.ts` at 0.1.2-rc.1). Type-only exports (`SettingsNamespace`, `SettingsScope`, `SessionHeader`, `Agent`, `Workspace`, `ToolDefinition`, …) come from the same packages via `import type`.

- `@deepseek-ai/dsh-settings` — runtime: `SettingsProvider`, `SettingsConflictError`, `redactSecrets`; types: `SettingsNamespace` (from `/types` subpath too: `SettingsNamespaceView`, `SettingsPathOpView`, events module augmentation), `SettingsScope`, `SettingsRegisterOptions`, `SettingsDescriptor`, `SettingsSectionHooks`, `SettingsUpdateSource`, `SettingsPathOp`.
- `@deepseek-ai/dsh-settings-file` — `FileSettingsProvider`, `resolveSpec`; type `Config`. (Provider to mount if our plugin must bring its own; normally already mounted by dsh-base.)
- `@deepseek-ai/dsh-credentials` — `credentialRef`, `isCredentialRefName`, `credentialKey`, `parseCredentialKey`, `credentialKeyScope`, `credentialKeyId`, `CredentialProvider`; types `CredentialRef`, `CredentialKey`, `CredentialRecord`, `ApiKeyRecord`, `GrantRecord`, `CredentialInfo`, `ResolvedCredential`, events augmentation.
- `@deepseek-ai/dsh-credentials-local` — `LocalCredentialProvider`, `CREDENTIALS_FILENAME`, `DOCUMENT_VERSION`, `parseCredentialsDocument`; type `Config`.
- `@deepseek-ai/dsh-workspace` — `WorkspaceRegistry`, `WorkspaceId`, `WorkspaceMoveInvalidError`, `WorkspaceUnknownSessionError`, `WorkspaceOrderInvalidError`, `realpathNormalize`; type `Workspace`.
- `@deepseek-ai/dsh-scope` — `createScope`, `bindScopeParent`, `scopeOf`, `scopeTarget`, `scopeChainOf`, `ScopedLayers`, `NamedEntries`, `AnonymousEntries`; types `ScopeKey`, `ScopeLayer`, `Scoped<T>`, `Scope`.
- `@deepseek-ai/dsh-session` — `SessionStore`, `Session`, `SessionId`, `KNOWN_SESSION_EVENT_TYPES`, `isJsonValue`; types `SessionHeader`, `SessionEvent`, `SessionEventMap`, `SessionId`/`SessionSeq` brands; plus `@deepseek-ai/dsh-session/types` subpath.
- `@deepseek-ai/dsh-tools` — `ToolRuntime`, `defineTool`, `ToolNotFoundError`, `ToolOutputError`, `ToolArgsError`, `RUN_CODE_NAME`, `validateArgs`, schema converters; types `ToolDefinition`, `ToolOutputDefinition`, `ToolExecution`, `ToolRunContext`, `ToolExecutionInput`, `ToolExecutionResult`, `ToolRestriction`, `ToolGuard`, `ToolPresentationMode`, `PreToolDecision`, `PostToolDecision`.
- `@deepseek-ai/dsh-agent` — `AgentRegistry`; types `Agent`, `AgentOptions`, `AgentStatus`, `CreateAgentOptions`, `AgentSetup` (events declared on cordis `Events` via this package).
- `@deepseek-ai/dsh-home-paths` — `resolveDshHome`, `dshHomePath`, `DSH_HOME_ENV`, `DSH_HOME_DIR_NAME`, `expandHomePath`.
- `@deepseek-ai/dsh-util-workspace-path` — `resolveWorkspacePath`, `workspaceTitleOf`, `abbreviateHomePath` (path/display helpers for workspace-rooted paths).
- `@deepseek-ai/dsh-subprocess` — `scrubbedParentEnv`, `DSH_ENV_PREFIX`, `SENSITIVE_ENV_PATTERN` (child-process env hygiene for any spawned MCP server).
- `@deepseek-ai/dsh-base` — composition only, no exports (never imported).
- Client/web side only (not host imports): `@deepseek-ai/dsh-api-workspace-controller` (client `WorkspaceController`, remote `workspace.*`), `@deepseek-ai/dsh-api-session-controller` (remote `session.*`), generated through `@deepseek-ai/dsh-typert-protocol`.
- Peer/type context: `@deepseek-ai/cordis` (`Context`, `Service`), `@deepseek-ai/schemastery` (`z`), `@deepseek-ai/dsh-llm` (types `ContentBlock`, `ToolSchema`, `CallId`), `@deepseek-ai/dsh-brand` (`Branded`).

## Facts not to get wrong

1. **Version delta matters**: ref-dsh (0.1.0-rc.5) has `settingsNamespace()`/`installSettingsSection()` and a single credential key space with event `credentials/updated`; installed 0.1.2-rc.1 has compile-time `SettingsNamespaceInput`, `SettingsProvider.installSection(owner,…)`, no runtime namespace brander, the added record space (`credentialKey`/`modifyRecord`, events `credentials/reference-updated` + `credentials/record-updated`), and tool mode `'ptc'` instead of `'code'`. Build against 0.1.2-rc.1 d.ts.
2. `ctx.tools.register(definition)` returns the **exact disposer**; scope = the context you call it on (`agent.ctx` ⇒ that agent only). Registration conflicts and the reserved `run_code` name throw at register time. `output: {schema, render}` is **mandatory** and schema-checked.
3. Namespace strings must be lowercase kebab `[a-z][a-z0-9-]*`; credentials record scopes are the **plugin's registered name**; refs are uppercase env-var names. `role('secret')` is a schemastery `role()` string — values are stripped from all wire `describe` and never readable back by UIs; "secret-role" as a literal type/package does not exist.
4. There is no `session.workspaceId` anywhere; workspace membership is a derived registry fact keyed on canonical `header.cwd == workspace.path`; `session/created` fires **before** the gateway attaches the session to a workspace.
5. Settings writes are revision-fenced per namespace and JSON-only; `update` is a deep merge over the user section, `replace` is the reset path; event `settings/updated` is deep-equal-gated while `settings/document-updated` tracks raw-section revision.
6. `DSH_*` and `/KEY|PASSWORD|SECRET|TOKEN/i`-matching env vars are stripped from every spawned child (incl. MCP stdio servers) — pass what a server needs explicitly. `$DSH_HOME` defaults to `~/.dsh`; child data files live at its root (`settings.yaml`, `.credentials.yaml`, `sessions/`, `storages/`), profiles under `profiles/<name>`.
7. Agent/session id is one shared branded `SessionId` (wire `sessionId`); sessions persist under `sessions/<projectKey>/<id>/session.jsonl[.zstd]`; agent tools registered through `agent.ctx` are gone the moment the agent is disposed — no separate cleanup needed beyond the ctx effect.

## Unknowns

- The rc5-vs-installed naming for the tool presentation mode enum (`'code'` → `'ptc'`) signals the 0.1.2-rc.1 tree renamed code-mode to ptc; ref-dsh (rc5) has not caught up. Check the installed `dsh-tools` d.ts for the definitive mode names before writing config.
- Installed `dsh-client-runtime` does not exist under this anchor's `node_modules` (client-modules/web-app do); if the plugin ships any browser-side code it should target `@deepseek-ai/dsh-client-modules`/the generated remote-client surfaces instead, and verify actual installed subpaths (`/client` exports) at build time.
- Whether settings registration inside `agent.ctx` (per-agent namespace variants) is supported/used anywhere — registration is documented as effect-scoped per fiber; no official plugin registers a namespace per agent (all register from their root apply). Not verified whether `installSection` from a non-root ctx would behave correctly.
- Default values/behaviors of the rc5-era web API (`api-proxy` methods) vs the typert controllers (`session/*`, `workspace/*`) for *the exact web build this MCP GUI ships* — the controllers' d.ts is authoritative for 0.1.2-rc.1, but error-code and payload details for session create (`workspaceId` handling, `agentPreset` echo) should be re-checked against `dsh-api-session-controller`'s `SessionCreateRequest` when implementing workspace-pinned session creation.
