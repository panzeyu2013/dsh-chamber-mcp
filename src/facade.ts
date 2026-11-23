/**
 * Capture-only facades for one mounted MCP server (host half).
 *
 * The official dsh-mcp-client instance registers its tools, prompt sections and
 * resource provider through the services of ITS context. The plugin mounts that
 * instance below an isolated child context that provides four façade services
 * (tools / systemPrompt / mcpResources / credentials) instead of the real
 * ones, so every upstream registration is CAPTURED, never fanned out. The
 * applier is the only fan-out owner; the façade's agent-scoped path delegates
 * admission to it.
 *
 * Ownership rules (measured upstream behaviour):
 * - ONE effect owns the whole capture set: createFacades attaches a single
 *   seat-fiber effect that clears the store, because upstream re-registers the
 *   tool generation on every connect/reconnect/list-change while recreating
 *   sections/resources per generation and DISCARDS their disposers
 *   (dsh-mcp-client/server-context.ts). Per-registration effects would
 *   accumulate for the seat's whole life (measured before this design).
 * - every net change/removal notifies hooks.onCaptureChanged synchronously with
 *   a LAZY peek (most sinks need only the version/count; a full snapshot copy
 *   per registration would be quadratic per generation); the manager coalesces
 *   and publishes, and the callback is contained so it can never throw into an
 *   upstream registration path;
 * - ToolsFacade.get is FAIL-CLOSED: a definition is visible only for a live
 *   Agent the applier has published this server to, so the on-demand loader
 *   catalog cannot leak never-admitted names;
 * - the credentials façade wraps the REAL provider captured by constructor
 *   injection (never this.ctx.get('credentials'), which resolves the façade
 *   itself and recurses) and rejects CR/LF/NUL on every resolve (SEC-02): the
 *   per-attempt re-resolution is what closes the rotate-then-reconnect window.
 *
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { AssembleContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRegistrationOptions } from '@deepseek-ai/dsh-tools'
import { INVALID_CREDENTIAL_VALUE_PATTERN } from './shared/defaults.js'

/** Default cap on one server's captured eager tool generation (SEC-05 fan-out bound). */
const DEFAULT_MAX_SYNC_TOOLS = 2_000

/**
 * Order used when the real prompt registry cannot name one (headless
 * composition without dsh-system-prompt). Must be finite: the real registry
 * refuses a non-finite order.
 */
export const FALLBACK_SECTION_ORDER = 0

/** One captured prompt section, resolved at capture time for per-agent replay. */
export interface CapturedSection {
  /** Section name (unique within one capture). */
  readonly name: string
  /** Numeric placement (finite; the real registry rejects non-finite orders). */
  readonly order: number
  /** Live text provider evaluated with the assembling agent's scope. */
  readonly text: (scope: ScopeKey | undefined) => string
  /** Whether the text is a prompt-variable template (upstream sets false for instructions). */
  readonly interpolate?: boolean
  /** Complete-prompt marker when the registration carried one. */
  readonly complete?: boolean
  /** Notice before changed text. */
  readonly replacement?: string
  /** Notice a disposed registration leaves in admitted sessions. */
  readonly retirement?: string
}

/** One server's complete captured registration state. */
export interface CaptureSnapshot {
  /** Captured eager/loader definitions by public name, in capture order. */
  readonly tools: ReadonlyMap<string, ToolDefinition>
  /** Captured prompt sections in capture order. */
  readonly sections: readonly CapturedSection[]
  /** Captured resource providers by server name. */
  readonly resources: ReadonlyMap<string, McpResourceProvider>
  /** Whether the tool cap trimmed this generation (canary exemption). */
  readonly truncated: boolean
  /** Monotonic capture version: increments on every net change (applier idempotence). */
  readonly version: number
}

/** Hooks the caller (the per-server seat / manager wiring) supplies to a façade set. */
export interface FacadeHooks {
  /** Configured server name (used by error text and the applier visibility predicate). */
  readonly serverName: string
  /** The REAL credential provider; captured by constructor injection (S4). */
  readonly credentials: CredentialProvider
  /**
   * Synchronous notification after every capture change/removal. The sink
   * receives a LAZY peek: most sinks only need the version/count, so copying the
   * full snapshot (O(tools)) per registration would be quadratic per generation.
   */
  readonly onCaptureChanged?: (peek: () => CaptureSnapshot) => void
  /** Resolve a live Agent from a scope key; undefined for a stale/non-agent scope. */
  readonly agentOf?: (scope: ScopeKey) => Agent | undefined
  /** Applier admission: register one loaded tool for one agent; returns its disposer. */
  readonly admit?: (agent: Agent, definition: ToolDefinition) => () => void
  /** Applier visibility: whether this agent currently publishes this server. */
  readonly isApplied?: (agent: Agent, serverName: string) => boolean
  /** Real prompt registry order lookup; absent in a headless composition. */
  readonly getSectionOrder?: (name: string) => number | undefined
  /** Capture cap override (tests); defaults to DEFAULT_MAX_SYNC_TOOLS. */
  readonly maxSyncTools?: number
  /** Diagnostic sink (legacy capture trim, inactive-fiber fallbacks). */
  readonly warn?: (message: string) => void
}

/** Host-only sentinel: a scoped registration reached a scope that is not a live Agent. */
export class SeamMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeamMismatchError'
  }
}

/** A credential resolve produced a value that must never reach env/headers/logs. */
export class InvalidCredentialValueError extends Error {
  /** The offending credential ref (the value is never retained or formatted). */
  readonly ref: string

  constructor(ref: string) {
    super('credential ref ' + JSON.stringify(ref) + ' resolved to an invalid value (CR/LF/NUL)')
    this.name = 'InvalidCredentialValueError'
    this.ref = ref
  }
}


/**
 * One server's capture state. Pure state + contained notification; the seat
 * fiber scopes its lifetime and `createFacades` installs the ONE store-level
 * seat effect that clears it (per-registration effects would accumulate).
 */
export class CaptureStore {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly sections: CapturedSection[] = []
  private readonly resources = new Map<string, McpResourceProvider>()
  private truncated = false
  private version = 0

  constructor(private readonly hooks: FacadeHooks) {}

  /** Maximum captured eager definitions (SEC-05). */
  private get cap(): number {
    return this.hooks.maxSyncTools ?? DEFAULT_MAX_SYNC_TOOLS
  }

  /** Fresh snapshot of the current capture (maps copied; definitions untouched). */
  snapshot(): CaptureSnapshot {
    return {
      tools: new Map(this.tools),
      sections: [...this.sections],
      resources: new Map(this.resources),
      truncated: this.truncated,
      version: this.version,
    }
  }

  /** One captured definition by public name. */
  tool(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /**
   * Capture one server-global definition.
   *
   * @param definition - definition the upstream instance registered.
   * @returns idempotent removal, or undefined when the cap trimmed this entry.
   * @throws when the public name is already captured (upstream rolls the sync back).
   */
  addTool(definition: ToolDefinition): (() => void) | undefined {
    if (this.tools.has(definition.name)) {
      throw new Error('mcp-scope(' + this.hooks.serverName + '): tool ' + JSON.stringify(definition.name) + ' was captured twice')
    }
    if (this.tools.size >= this.cap) {
      if (!this.truncated) {
        this.truncated = true
        this.notify()
        this.hooks.warn?.('mcp-scope(' + this.hooks.serverName + '): captured tool generation reached ' + this.cap + ' entries; the rest is trimmed')
      }
      return undefined
    }
    this.tools.set(definition.name, definition)
    this.notify()
    return () => this.removeTool(definition.name)
  }

  /** Remove one captured definition by public name (idempotent). */
  removeTool(name: string): void {
    if (!this.tools.delete(name)) return
    // A whole generation swap disposes every previous tool before the next
    // generation registers, so an empty set closes the truncation window: the
    // flag describes THIS generation, not the history of the seat.
    if (this.tools.size === 0) this.truncated = false
    this.notify()
  }

  /** Capture (or replace) one prompt section; the disposer removes exactly this capture. */
  addSection(section: CapturedSection): () => void {
    const index = this.sections.findIndex((existing) => existing.name === section.name)
    if (index >= 0) this.sections.splice(index, 1)
    this.sections.push(section)
    this.notify()
    return () => {
      const current = this.sections.indexOf(section)
      if (current < 0) return
      this.sections.splice(current, 1)
      this.notify()
    }
  }

  /** Remove one captured section by name (idempotent). */
  removeSection(name: string): void {
    const index = this.sections.findIndex((existing) => existing.name === name)
    if (index < 0) return
    this.sections.splice(index, 1)
    this.notify()
  }

  /** Capture (or replace) one resource provider; the disposer removes exactly this capture. */
  setResource(server: string, provider: McpResourceProvider): () => void {
    this.resources.set(server, provider)
    this.notify()
    return () => {
      if (this.resources.get(server) !== provider) return
      this.removeResource(server)
    }
  }

  /** Remove one captured resource provider (idempotent). */
  removeResource(server: string): void {
    if (!this.resources.delete(server)) return
    this.notify()
  }

  /** Drop every capture (seat teardown) and publish the empty snapshot once. */
  clear(): void {
    const changed = this.tools.size > 0 || this.sections.length > 0 || this.resources.size > 0
    this.tools.clear()
    this.sections.length = 0
    this.resources.clear()
    this.truncated = false
    if (changed) this.notify()
  }

  /** Bump the version and hand the fresh snapshot to the contained sink. */
  private notify(): void {
    this.version += 1
    const sink = this.hooks.onCaptureChanged
    if (sink === undefined) return
    try {
      sink(() => this.snapshot())
    } catch (error) {
      this.hooks.warn?.('mcp-scope(' + this.hooks.serverName + '): capture notification failed: ' + String(error))
    }
  }
}

/** Tool façade (provides ctx.tools inside the isolated seat scope). */
class ToolsFacade extends Service {
  constructor(
    ctx: Context,
    private readonly store: CaptureStore,
    private readonly hooks: FacadeHooks,
  ) {
    super(ctx, 'tools')
  }

  /**
   * Capture a server-global registration, or route an agent-scoped one through
   * the applier's admission hook. Never fans out from here.
   *
   * @param definition - registered definition.
   * @param options - registration options (upstream passes none today; captured tools keep none).
   * @returns the disposer the registrar must call.
   * @throws SeamMismatchError for a scoped registration outside a live Agent.
   */
  register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      const remove = this.store.addTool(definition)
      if (remove === undefined) return () => {}
      return remove
    }
    const agent = this.hooks.agentOf?.(scope)
    if (agent === undefined || this.hooks.admit === undefined) {
      throw new SeamMismatchError('mcp-scope(' + this.hooks.serverName + '): refusing a scoped tool registration outside a live agent')
    }
    void options
    return this.hooks.admit(agent, definition)
  }

  /**
   * Fail-closed visibility for the upstream on-demand catalog: only a live
   * Agent the applier currently publishes this server to may resolve a name.
   *
   * @param name - public tool name.
   * @param scope - viewing scope (the assembling agent); undefined = global view.
   * @returns the captured definition, or undefined when it must stay invisible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    if (scope === undefined) return undefined
    try {
      const agent = this.hooks.agentOf?.(scope)
      if (agent === undefined) return undefined
      if (this.hooks.isApplied?.(agent, this.hooks.serverName) !== true) return undefined
      return this.store.tool(name)
    } catch (error) {
      // Fail closed: a broken visibility predicate must not expose a name (and
      // must never throw into the upstream prompt assembly path).
      this.hooks.warn?.('mcp-scope(' + this.hooks.serverName + '): catalog visibility check failed: ' + String(error))
      return undefined
    }
  }
}

/** System-prompt façade (provides ctx.systemPrompt inside the isolated seat scope). */
class SystemPromptFacade extends Service {
  constructor(
    ctx: Context,
    private readonly store: CaptureStore,
    private readonly hooks: FacadeHooks,
  ) {
    super(ctx, 'systemPrompt')
  }

  /**
   * Resolve the real registry's placement, falling back to a finite order when
   * the composition mounts no real system prompt.
   *
   * @param name - allocation key (e.g. MCP_SERVERS).
   * @returns a finite section order.
   */
  getSectionOrder(name: string): number {
    try {
      const order = this.hooks.getSectionOrder?.(name)
      if (typeof order === 'number' && Number.isFinite(order)) return order
    } catch (error) {
      this.hooks.warn?.('mcp-scope(' + this.hooks.serverName + '): prompt order lookup failed: ' + String(error))
    }
    return FALLBACK_SECTION_ORDER
  }

  /**
   * Capture one section (upstream discards the returned disposer; the store-level
   * seat effect removes it if the registrar never calls it).
   *
   * @param descriptor - section as registered by the server context.
   * @returns idempotent disposer removing the capture.
   */
  section(descriptor: PromptSection): () => void {
    const captured: CapturedSection = {
      name: descriptor.name,
      order: Number.isFinite(descriptor.order) ? descriptor.order : this.getSectionOrder(descriptor.name),
      text: typeof descriptor.text === 'string'
        ? () => descriptor.text as string
        : (scope: ScopeKey | undefined) => (descriptor.text as (context: AssembleContext) => string)(scope === undefined ? {} : { scope }),
      interpolate: descriptor.interpolate,
      complete: descriptor.complete,
      replacement: descriptor.replacement,
      retirement: descriptor.retirement,
    }
    const remove = this.store.addSection(captured)
    return remove
  }
}

/** Resource façade (provides ctx.mcpResources inside the isolated seat scope). */
class McpResourcesFacade extends Service {
  constructor(
    ctx: Context,
    private readonly store: CaptureStore,
  ) {
    super(ctx, 'mcpResources')
  }

  /**
   * Capture one server's resource provider (upstream discards the disposer).
   *
   * @param server - configured server name.
   * @param provider - connection-owned resource operations.
   * @returns idempotent disposer removing the capture.
   */
  register(server: string, provider: McpResourceProvider): () => void {
    const remove = this.store.setResource(server, provider)
    return remove
  }
}

/**
 * Credentials façade: the ONLY credential path of a mounted instance.
 *
 * Wraps the real provider captured at construction (S4). Every resolve re-checks
 * CR/LF/NUL; the per-attempt re-resolution is what closes the
 * rotate-then-reconnect window. Redaction of upstream diagnostics stays
 * upstream-owned (the mounted instance masks its own values).
 */
class CredentialsFacade extends CredentialProvider {
  constructor(
    ctx: Context,
    private readonly real: CredentialProvider,
  ) {
    super(ctx)
  }

  /** Resolve one ref, rejecting control-character values (SEC-02). */
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const resolved = await this.real.resolve(ref)
    if (resolved === undefined) return undefined
    if (INVALID_CREDENTIAL_VALUE_PATTERN.test(resolved.value)) throw new InvalidCredentialValueError(String(ref))
    return resolved
  }

  /** Describe one ref; a masked preview that fails the control-character test is dropped. */
  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const info = await this.real.describe(ref)
    if (info.masked === undefined || !INVALID_CREDENTIAL_VALUE_PATTERN.test(info.masked)) return info
    return { configured: info.configured, source: info.source, writable: info.writable }
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    return this.real.set(ref, value)
  }

  unset(ref: CredentialRef): Promise<void> {
    return this.real.unset(ref)
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.real.readRecord(key)
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return this.real.describeRecord(key)
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.real.listRecords()
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.real.modifyRecord(key, mutate)
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    return this.real.deleteRecord(key)
  }
}

/** The four façade services of one seat plus capture inspection/reset. */
export interface FacadeSet {
  readonly tools: ToolsFacade
  readonly systemPrompt: SystemPromptFacade
  readonly mcpResources: McpResourcesFacade
  readonly credentials: CredentialsFacade
  /** Fresh capture snapshot. */
  snapshot(): CaptureSnapshot
  /**
   * Drop every capture: the production `resetCapture` path (a definition-change
   * remount) and seat teardown; the services themselves die with the seat fiber.
   */
  dispose(): void
}

/**
 * Install the four capture façades into one isolated seat context.
 *
 * @param seatCtx - context whose tools/systemPrompt/mcpResources/credentials
 *   services are isolated labels; the façades provide those names there.
 * @param hooks - server identity, the real credential provider, and the
 *   applier hooks.
 * @returns the façade services plus snapshot/dispose helpers.
 */
export function createFacades(seatCtx: Context, hooks: FacadeHooks): FacadeSet {
  const store = new CaptureStore(hooks)
  // ONE effect owns the whole capture set: upstream re-registers the tool
  // generation on every connect/reconnect/list-change and drops the returned
  // disposers on its own path, so per-registration effects would accumulate
  // for the seat's whole life (measured: hundreds/thousands of dead effects).
  try {
    seatCtx.effect(() => () => store.clear(), 'mcp-scope: capture store')
  } catch (error) {
    hooks.warn?.('mcp-scope(' + hooks.serverName + '): could not own the capture set: ' + String(error))
  }
  const tools = new ToolsFacade(seatCtx, store, hooks)
  const systemPrompt = new SystemPromptFacade(seatCtx, store, hooks)
  const mcpResources = new McpResourcesFacade(seatCtx, store)
  const credentials = new CredentialsFacade(seatCtx, hooks.credentials)
  return {
    tools,
    systemPrompt,
    mcpResources,
    credentials,
    snapshot: () => store.snapshot(),
    dispose: () => store.clear(),
  }
}

/** Diagnostic sink for a contained per-agent context replay. */
interface ReplayLogger {
  warn(message: string): void
}

/**
 * Replay one capture's prompt sections and resource providers into ONE agent
 * scope (the applier owns this; the façade itself never fans out).
 *
 * Both contributions ride agentCtx.inject, so a composition without
 * systemPrompt/mcpResources degrades to a no-op. Failures are contained and
 * never thrown into an applier entry point; the returned disposer unloads the
 * contributions in reverse order and is idempotent.
 *
 * @param agentCtx - the live agent's context (the only registration scope).
 * @param snapshot - capture generation to publish.
 * @param logger - optional diagnostics sink.
 * @returns disposer of every replayed contribution.
 */
export function replayCapturedContext(
  agentCtx: Context,
  snapshot: CaptureSnapshot,
  logger?: ReplayLogger,
): () => Promise<void> {
  const created: Array<{ dispose(): Promise<void> | void }> = []
  const contain = (fiber: { dispose(): Promise<void> | void }): void => {
    void Promise.resolve(fiber).catch((error: unknown) => {
      logger?.warn('mcp-scope: a replayed context contribution failed to load: ' + String(error))
    })
    created.push(fiber)
  }
  for (const section of snapshot.sections) {
    try {
      contain(agentCtx.inject(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({
          name: section.name,
          order: section.order,
          interpolate: section.interpolate,
          complete: section.complete,
          text: (context) => section.text(context.scope),
          replacement: section.replacement,
          retirement: section.retirement,
        })
      }))
    } catch (error) {
      logger?.warn('mcp-scope: could not replay a prompt section: ' + String(error))
    }
  }
  for (const [server, provider] of snapshot.resources) {
    try {
      contain(agentCtx.inject(['mcpResources'], (inner) => {
        inner.mcpResources.register(server, provider)
      }))
    } catch (error) {
      logger?.warn('mcp-scope: could not replay a resource provider: ' + String(error))
    }
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const fiber of created.reverse()) {
      try {
        await fiber.dispose()
      } catch (error) {
        logger?.warn('mcp-scope: failed to unload a replayed context contribution: ' + String(error))
      }
    }
  }
}
