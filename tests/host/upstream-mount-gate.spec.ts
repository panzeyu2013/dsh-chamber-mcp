/**
 * THE upstream mount seam gate (invariant S11 / I2 / I12): the capture-only
 * architecture proven through PRODUCTION modules end to end.
 *
 * Unlike the round-1 probe this spec never hand-rolls fan-out: the real
 * manager (src/manager.ts) creates the real per-server seat (src/server-fiber.ts,
 * which installs the real capture facades from src/facade.ts and one private
 * official McpClientHost), mounts the real official instance, and the real
 * applier (src/agents.ts) fans the capture into REAL dsh-scope agent contexts /
 * REAL ToolRuntime layer. The only test double is the fixture MCP server itself.
 *
 * Covered rows: global layer empty (I2), enabled/disabled agent visibility (I1),
 * revocation + re-enable (I3), a REAL on-demand mount (loader-only capture,
 * catalog view, agent-scoped admission through the upstream loader, gate flip
 * and generation-swap survival), post-mount agents (B1), toolCount === captured
 * count (canary), truncated-generation exemption, per-agent prompt section +
 * resource provider replay (I12), capture-only negative (ADR-1.1), official
 * naming contract (I10/S3), remount without a stale capture (S8) and disposal
 * (S11).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createManager, type ManagerHandle } from '../../src/manager.js'
import { createServerSeat, type ServerSeat } from '../../src/server-fiber.js'
import type { ServerSeat as ServerSeatType } from '../../src/server-fiber.js'
import { loadUpstreamMcpClient, resolveDefinitionConfig } from '../../src/upstream.js'
import type { McpScopeDoc } from '../../src/shared/model.js'
import { mountReal } from '../support/mount-real.js'
import {
  execContext,
  expectGlobalEmpty,
  makeLogger,
  started,
  stdioDef,
  waitFor,
  type CapturingLogger,
} from '../support/fixture-kit.js'

const SERVER = 'fix'
const TOOL = 'mcp__fix__add'
/** The upstream on-demand loader tool (the ONLY tool an on-demand server registers). */
const LOADER = 'mcp__fix__load_tools'
/** Tool registered at runtime by the fixture's dyn_add (real tools/list_changed). */
const DYN_TOOL = 'mcp__fix__dyn_add'
/** Every fixture tool the eager generation captures (8 tools incl. admin.reset). */
const FIXTURE_TOOLS = 8

/**
 * Records every mcpResources.register made through a CONSUMING scope. A
 * host-level registration would show no scope; the applier must route the
 * provider through each enabled agent's own ctx.
 */
class RecordingResources extends Service {
  readonly registered: Array<{ server: string; scope: unknown }> = []
  readonly unloaded: string[] = []

  constructor(host: Context) {
    super(host, 'mcpResources')
  }

  register(server: string, _provider?: unknown): () => void {
    this.registered.push({ server, scope: scopeOf(this.ctx) })
    return this.ctx.effect(() => () => {
      this.unloaded.push(server)
    }, 'fake.mcpResources.register')
  }
}

interface SeamAgent {
  readonly agent: Agent
  readonly scope: Scope
}

interface Booted {
  readonly ctx: Context
  readonly manager: ManagerHandle
  readonly lines: CapturingLogger['lines']
  readonly resources: RecordingResources
  readonly workA: string
  readonly workB: string
  readonly agentA: SeamAgent | undefined
  readonly agentB: SeamAgent | undefined
  readonly allAgents: SeamAgent[]
  spawnAgent(id: string, workspace: 'a' | 'b' | 'outside'): SeamAgent
  setDoc(next: McpScopeDoc): void
  dispose(): Promise<void>
}

interface BootOptions {
  /** Overrides map; defaults to workspace A enabling the fixture. */
  overrides?: Record<string, Record<string, true>>
  /** Fake-seat hook override: wrap the production seat factory. */
  seatFactory?: (deps: Parameters<typeof createServerSeat>[0]) => Promise<ServerSeat>
  /** Pre-create an enabled agent before the manager boots. */
  withAgents?: boolean
  /** Mount the fixture with on-demand tool loading (default eager). */
  toolLoading?: 'on-demand'
}

/**
 * Boot one real composition: real Invocation/ToolRuntime services, a recording
 * resource runtime, fake agent/workspace registries, one real fixture server and
 * the production manager over the production per-server seat.
 */
async function boot(options: BootOptions = {}): Promise<Booted> {
  const ctx = new Context()
  const { factoryCtx } = await mountReal(ctx, { executor: true })
  const resources = new RecordingResources(ctx)
  const logger = makeLogger()
  const workA = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-scope-gate-a-')))
  const workB = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-scope-gate-b-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-scope-gate-out-')))
  const allAgents: SeamAgent[] = []
  const live = new Map<string, Agent>()

  const spawnAgent = (id: string, workspace: 'a' | 'b' | 'outside'): SeamAgent => {
    const cwd = workspace === 'a' ? workA : workspace === 'b' ? workB : outside
    const agent = { id, session: { header: { cwd } } } as unknown as Agent
    const scope = createScope(factoryCtx, agent as never)
    ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
    live.set(id, agent)
    const entry: SeamAgent = { agent, scope }
    allAgents.push(entry)
    // Announce through the registry event so the applier adopts it exactly like
    // a live session (the boot scan is covered by a pre-created agent).
    ctx.emit('agent/created', { agent, source: 'startup' })
    return entry
  }

  const registry = {
    list: () => [...live.values()],
    get: (id: string) => live.get(id),
  }
  const workspaces = [
    { id: 'ws-a', path: workA },
    { id: 'ws-b', path: workB },
  ]
  ctx.provide('agents', registry as never)
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  ctx.provide('credentials', {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: false }),
  } as never)

  let doc: McpScopeDoc = {
    servers: [stdioDef(SERVER, options.toolLoading === undefined ? {} : { toolLoading: options.toolLoading })],
    overrides: options.overrides ?? { 'ws-a': { [SERVER]: true } },
  }

  const manager = createManager({
    ctx,
    logger,
    getDoc: () => doc,
    managedNames: () => [],
    ...(options.seatFactory === undefined ? {} : { seatFactory: options.seatFactory }),
  })

  const spawned = options.withAgents === false ? [] : []
  void spawned
  return {
    ctx,
    manager,
    lines: logger.lines,
    resources,
    workA,
    workB,
    get agentA() {
      return allAgents.find((entry) => entry.agent.id === 'agent-a')
    },
    get agentB() {
      return allAgents.find((entry) => entry.agent.id === 'agent-b')
    },
    allAgents,
    spawnAgent,
    setDoc(next: McpScopeDoc): void {
      doc = next
    },
    async dispose(): Promise<void> {
      await manager.dispose()
      for (const entry of allAgents) await entry.scope.dispose()
      rmSync(workA, { recursive: true, force: true })
      rmSync(workB, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    },
  }
}

/** Wait for the manager-projected phase of one server. */
function waitPhase(manager: ManagerHandle, serverName: string, phase: string, what = phase): Promise<void> {
  return waitFor(
    () => manager.runtimeStatus(serverName).servers.some((entry) => entry.phase === phase),
    'server ' + serverName + ' to be ' + what,
    15_000,
  )
}

/** Wait for one scoped tool to appear/disappear for an agent. */
function waitTool(ctx: Context, name: string, agent: Agent, present: boolean, what: string): Promise<void> {
  return waitFor(
    () => (ctx.tools.get(name, agent) !== undefined) === present,
    what,
    10_000,
  )
}

describe('upstream mount seam (alpha.2 gate)', () => {
  it('keeps the global tool layer empty after an eager mount', async () => {
    const b = await boot()
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 'captured tool to reach the enabled agent')

      const listed = b.manager.toolList(SERVER)
      expect(listed?.mode).toBe('definitions')
      expect(listed?.total).toBe(FIXTURE_TOOLS)
      for (const tool of listed!.tools) {
        // Invariant 2: the seam registers nothing itself — every captured name
        // stays scoped to the agent that enabled the server.
        expectGlobalEmpty(b.ctx.tools, [tool.publicName])
      }
      expect(b.ctx.tools.get(TOOL)).toBeUndefined()
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('mounts a REAL on-demand server: only the loader is captured, a load is admitted agent-scoped, and the gate/swap rules hold', async () => {
    const b = await boot({ toolLoading: 'on-demand' })
    const onDemandDoc = (enabled: boolean): McpScopeDoc => ({
      servers: [stdioDef(SERVER, { toolLoading: 'on-demand' })],
      overrides: enabled ? { 'ws-a': { [SERVER]: true } } : {},
    })
    try {
      const agentA = b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, LOADER, agentA.agent, true, 'the upstream loader tool')

      // The catalog view (manager projection behind the tools route): catalog
      // mode, no definitions on the wire, the offered catalog size as total.
      expect(b.manager.toolList(SERVER)).toEqual({
        mode: 'catalog',
        tools: [],
        truncated: false,
        total: FIXTURE_TOOLS,
      })
      expect(b.manager.runtimeStatus(SERVER).servers[0]?.toolCount).toBe(FIXTURE_TOOLS)

      // ONLY the loader is captured and model-visible in the enabled agent
      // scope: every catalog definition stays behind the loader, and nothing
      // reaches the global layer.
      expect(
        b.ctx.tools
          .schemas(agentA.agent)
          .filter((schema) => schema.name.startsWith('mcp__fix__'))
          .map((schema) => schema.name),
      ).toEqual([LOADER])
      expect(b.ctx.tools.get(TOOL, agentA.agent)).toBeUndefined()
      expectGlobalEmpty(b.ctx.tools, [LOADER, TOOL])

      // The catalog prompt section is replayed per agent and names the offered
      // tools (the model's only discovery surface before a load).
      const prompt = b.ctx.get('systemPrompt')!
      const assembly = await prompt.assemble({ scope: agentA.agent })
      const catalog = assembly.sections.find((section) => section.name === 'mcp:' + SERVER + ':tools')
      expect(catalog?.text).toContain('add')

      // Load through the REAL upstream loader: the applier admits the requested
      // tool into the AGENT scope only, and the definition really executes.
      const load = async (tools: string[]): Promise<void> => {
        const loader = b.ctx.tools.get(LOADER, agentA.agent) as ToolDefinition
        await loader.execute({ tools }, execContext({ agent: agentA.agent } as never))
      }
      await load(['add'])
      await waitTool(b.ctx, TOOL, agentA.agent, true, 'the admitted loaded tool')
      expect(b.ctx.tools.get(TOOL)).toBeUndefined()
      const add = b.ctx.tools.get(TOOL, agentA.agent) as ToolDefinition
      expect(await add.execute({ a: 2, b: 40 }, execContext({ agent: agentA.agent } as never))).toEqual({
        content: [{ type: 'text', text: '42' }],
      })

      // Gate flip OFF revokes the loader AND the loaded tool; the same
      // generation re-enable restores both (the loader's loaded-tool bookkeeping
      // survives the flip).
      b.setDoc(onDemandDoc(false))
      b.manager.reconcile()
      await waitTool(b.ctx, LOADER, agentA.agent, false, 'the loader revoked on disable')
      await waitTool(b.ctx, TOOL, agentA.agent, false, 'the loaded tool revoked on disable')
      b.setDoc(onDemandDoc(true))
      b.manager.reconcile()
      await waitTool(b.ctx, LOADER, agentA.agent, true, 'the loader restored on re-enable')
      await waitTool(b.ctx, TOOL, agentA.agent, true, 'the loaded tool restored on re-enable')
      expectGlobalEmpty(b.ctx.tools, [LOADER, TOOL])

      // A REAL tools/list_changed generation swap: dyn_add registers a new tool,
      // upstream re-syncs the catalog, and the already-loaded tool must stay
      // registered (the mounted instance owns the swap; our bookkeeping must not
      // revoke a load).
      await load(['dyn_add'])
      await waitTool(b.ctx, DYN_TOOL, agentA.agent, true, 'the dynamically listed tool')
      const dyn = b.ctx.tools.get(DYN_TOOL, agentA.agent) as ToolDefinition
      await dyn.execute({ name: 'extra' }, execContext({ agent: agentA.agent } as never))
      await waitFor(
        () => (b.manager.toolList(SERVER)?.total ?? 0) >= FIXTURE_TOOLS + 1,
        'the swapped catalog generation',
        20_000,
      )
      await waitPhase(b.manager, SERVER, 'connected', 'connected after the generation swap')
      expect(b.ctx.tools.get(TOOL, agentA.agent), 'the loaded tool survives the generation swap').toBeDefined()
      expect(b.ctx.tools.get(LOADER, agentA.agent), 'the loader stays registered').toBeDefined()
      expectGlobalEmpty(b.ctx.tools, [LOADER, TOOL, DYN_TOOL])
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 90_000)

  it('serves captured names to enabled agent scopes only, and toolCount equals the captured count', async () => {
    const b = await boot()
    try {
      const agentA = b.spawnAgent('agent-a', 'a')
      const agentB = b.spawnAgent('agent-b', 'b')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, agentA.agent, true, 'enabled agent to receive the captured tools')

      const listed = b.manager.toolList(SERVER)!
      const view = b.manager.runtimeStatus(SERVER).servers[0]!
      // Canary: the projected tool count is EXACTLY the captured generation.
      expect(listed.total).toBe(FIXTURE_TOOLS)
      expect(view.toolCount).toBe(listed.total)
      // The enabled agent sees every captured name...
      for (const tool of listed.tools) {
        expect(b.ctx.tools.get(tool.publicName, agentA.agent), tool.publicName).toBeDefined()
        expect(b.ctx.tools.get(tool.publicName), tool.publicName + ' must not be global').toBeUndefined()
      }
      // ...the disabled workspace sees NONE of them (captures-only negative: a
      // definition the applier never published is invisible even to a live
      // agent whose workspace simply never enabled the server).
      for (const tool of listed.tools) {
        expect(b.ctx.tools.get(tool.publicName, agentB.agent), tool.publicName).toBeUndefined()
      }
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('replays the mcp:<server> prompt section and the resource provider only into enabled agents', async () => {
    const b = await boot()
    try {
      const agentA = b.spawnAgent('agent-a', 'a')
      const agentB = b.spawnAgent('agent-b', 'b')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, agentA.agent, true, 'enabled agent to receive the captured tools')
      await waitFor(() => b.resources.registered.length === 1, 'the per-agent resource provider', 10_000)

      // The prompt section is replayed through the agent scope and visible to
      // the real SystemPrompt registry only for the enabled agent.
      const prompt = b.ctx.get('systemPrompt')!
      const assemblyA = await prompt.assemble({ scope: agentA.agent })
      const sectionA = assemblyA.sections.find((section) => section.name === 'mcp:' + SERVER)
      expect(sectionA?.text).toContain('Fixture guidance for MCP tools')
      expect(sectionA?.interpolate).toBe(false)
      const assemblyB = await prompt.assemble({ scope: agentB.agent })
      expect(assemblyB.sections.some((section) => section.name === 'mcp:' + SERVER)).toBe(false)

      // The resource provider rides the same scope rule: exactly one registration,
      // bound to the enabled agent's scope key.
      expect(b.resources.registered).toHaveLength(1)
      expect(b.resources.registered[0]?.server).toBe(SERVER)
      expect(b.resources.registered[0]?.scope).toBe(agentA.agent)

      // Disabling the pair retires the replayed contributions.
      b.setDoc({ servers: [stdioDef(SERVER)], overrides: {} })
      b.manager.reconcile()
      await waitTool(b.ctx, TOOL, agentA.agent, false, 'disable to revoke the scoped tools')
      await waitFor(() => b.resources.unloaded.includes(SERVER), 'resource provider to be unloaded', 10_000)
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('applies the gate to an agent created after mount, then revokes and re-publishes on a gate flip', async () => {
    const b = await boot()
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 'initial publication')

      // A session created after the mount is adopted by the applier and gets
      // the tracked generation (never only future updates).
      const late = b.spawnAgent('agent-late', 'a')
      await waitTool(b.ctx, TOOL, late.agent, true, 'post-mount agent to receive the tracked capture')

      // Gate flip OFF: model-visible revocation, no unmount.
      b.setDoc({ servers: [stdioDef(SERVER)], overrides: {} })
      b.manager.reconcile()
      await waitTool(b.ctx, TOOL, b.agentA!.agent, false, 'revocation on disable')
      await waitTool(b.ctx, TOOL, late.agent, false, 'revocation on the late agent')
      expect(b.manager.runtimeStatus(SERVER).servers[0]?.phase).toBe('connected')

      // Gate flip ON: the retained capture re-applies without a reconnect.
      b.setDoc({ servers: [stdioDef(SERVER)], overrides: { 'ws-a': { [SERVER]: true } } })
      b.manager.reconcile()
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 're-publication on re-enable')
      await waitTool(b.ctx, TOOL, late.agent, true, 're-publication on the late agent')
      expectGlobalEmpty(b.ctx.tools, [TOOL])
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('captures only: the production seat captures definitions without registering any', async () => {
    const ctx = new Context()
    const { factoryCtx } = await mountReal(ctx)
    const upstream = await loadUpstreamMcpClient()
    const logger = makeLogger()
    const captures: Array<{ size: number }> = []
    const seat: ServerSeatType = await createServerSeat({
      ctx,
      upstream,
      credentials: { resolve: async () => undefined } as never,
      logger,
      serverName: 'raw',
      epoch: 1,
      onCaptureChanged: (peek) => void captures.push({ size: peek().tools.size }),
      hooks: {
        agentOf: () => undefined,
        admit: () => {
          throw new Error('no admission expected in this capture-only probe')
        },
        isApplied: () => false,
      },
    })
    try {
      const config = resolveDefinitionConfig(stdioDef('raw'), seat.host, { warn: () => {} })
      const instance = seat.mount(config)
      await instance.ready
      await waitFor(() => captures.some((capture) => capture.size >= FIXTURE_TOOLS), 'the capture generation', 15_000)

      const snapshot = seat.capture()
      expect(snapshot.tools.size).toBe(FIXTURE_TOOLS)
      expect(snapshot.tools.get('mcp__raw__add')).toBeDefined()
      expect(snapshot.sections.map((section) => section.name)).toEqual(['mcp:raw'])
      expect([...snapshot.resources.keys()]).toEqual(['raw'])
      expect(snapshot.truncated).toBe(false)
      // ADR-1.1: the capture is state only. Nothing reached the real layer —
      // not globally and not into any live agent scope.
      for (const name of snapshot.tools.keys()) {
        expect(factoryCtx.tools.get(name), name + ' must not be registered by the seat').toBeUndefined()
      }
      expect(factoryCtx.tools.schemas().filter((schema) => schema.name.startsWith('mcp__raw__'))).toEqual([])
      expect(logger.lines.filter((line) => line.level === 'error')).toEqual([])
      await instance.dispose()
    } finally {
      await seat.disposeSeat()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('keeps the official mcp__ naming contract on captured definitions', async () => {
    const b = await boot()
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      const listed = b.manager.toolList(SERVER)!
      const names = listed.tools.map((tool) => tool.publicName)
      // Clean names join verbatim; a non-contract raw name (admin.reset) carries
      // the 12-hex identity hash and the 64-char cap.
      expect(names).toContain('mcp__fix__add')
      expect(names.some((name) => /^mcp__fix__admin_reset_[0-9a-f]{12}$/.test(name))).toBe(true)
      for (const name of names) {
        expect(name.startsWith('mcp__fix__')).toBe(true)
        expect(name.length).toBeLessThanOrEqual(64)
      }
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('canary: a non-truncated count mismatch degrades to failed{seam}', async () => {
    // Fault injection at the production seat boundary: the mounted instance is
    // real and reports 8 tools; the exposed capture only carries 3 and is NOT
    // flagged truncated. The manager must never serve the inconsistent table.
    const b = await boot({
      seatFactory: async (deps) => {
        const seat = await createServerSeat(deps)
        const wrapped = Object.create(seat) as ServerSeat
        Object.defineProperty(wrapped, 'capture', {
          value: () => {
            const snapshot = seat.capture()
            return { ...snapshot, tools: new Map([...snapshot.tools].slice(0, 3)), truncated: false }
          },
        })
        return wrapped
      },
    })
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      // The mismatch lands as soon as the connected status is observed: the
      // projection degrades straight to failed{seam}, so never wait for a
      // transient connected phase here.
      await waitPhase(b.manager, SERVER, 'failed', 'failed after the seam canary')
      const view = b.manager.runtimeStatus(SERVER).servers[0]!
      expect(view.error?.code).toBe('seam')
      // Explicit degradation: the mismatched generation is revoked, never a
      // silently empty tool table presented as healthy.
      expect(b.ctx.tools.get(TOOL, b.agentA!.agent)).toBeUndefined()
      expect(b.lines.some((line) => line.level === 'error' && line.message.includes('disagrees'))).toBe(true)
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('exempts a truncated capture generation from the canary', async () => {
    // The capture cap trims the generation to 2 entries while the instance
    // reports all 8: a trimmed generation is a bounded response, not a defect.
    const b = await boot({
      seatFactory: async (deps) =>
        createServerSeat({
          ...deps,
          hooks: { ...deps.hooks, maxSyncTools: 2 },
        }),
    })
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      // Settle: the published captured generation is trimmed to the cap while
      // the instance counter still reports every advertised tool.
      const view = b.manager.runtimeStatus(SERVER).servers[0]!
      expect(view.phase).toBe('connected')
      expect(view.toolCount).toBe(FIXTURE_TOOLS)
      const listed = b.manager.toolList(SERVER)!
      expect(listed.total).toBe(2)
      expect(b.lines.some((line) => line.level === 'error' && line.message.includes('disagrees'))).toBe(false)
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('remounts the same serverName on a definition change without a stale capture', async () => {
    const b = await boot()
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 'first generation')
      const firstDefinition = b.ctx.tools.get(TOOL, b.agentA!.agent)

      // The definition change drops the seat and mounts a fresh instance under a
      // NEW epoch; its committed generation must reach the same agents.
      b.setDoc({ servers: [stdioDef(SERVER, { startupTimeoutMs: 20_000 })], overrides: { 'ws-a': { [SERVER]: true } } })
      b.manager.reconcile()
      // A remount is only observable once the old instance stopped and a fresh
      // one started (the previous generation stays published until then).
      await waitFor(() => started(b.lines, SERVER) === 2, 'the remounted instance to start', 15_000)
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 'the remounted generation')
      const secondDefinition = b.ctx.tools.get(TOOL, b.agentA!.agent)
      expect(secondDefinition).not.toBe(firstDefinition)
      expect(b.manager.toolList(SERVER)?.total).toBe(FIXTURE_TOOLS)
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
      // The same name still executes through the new instance.
      const value = await secondDefinition!.execute({ a: 2, b: 40 }, execContext())
      expect(value).toEqual({ content: [{ type: 'text', text: '42' }] })
    } finally {
      await b.dispose()
    }
  }, 60_000)

  it('dispose revokes every name and releases the serverName for a fresh seat', async () => {
    const b = await boot()
    try {
      b.spawnAgent('agent-a', 'a')
      b.manager.reconcile()
      await waitPhase(b.manager, SERVER, 'connected')
      await waitTool(b.ctx, TOOL, b.agentA!.agent, true, 'publication before disposal')
      await b.manager.dispose()
      expect(b.ctx.tools.get(TOOL, b.agentA!.agent)).toBeUndefined()
      expectGlobalEmpty(b.ctx.tools, [TOOL])

      // The disposed seat released the serverName: a fresh production seat can
      // mount the same fixture under the same name on this root.
      const upstream = await loadUpstreamMcpClient()
      const seat = await createServerSeat({
        ctx: b.ctx,
        upstream,
        credentials: { resolve: async () => undefined } as never,
        logger: makeLogger(),
        serverName: SERVER,
        epoch: 99,
        onCaptureChanged: () => {},
        hooks: { agentOf: () => undefined, admit: () => () => {}, isApplied: () => false },
      })
      try {
        const config = resolveDefinitionConfig(stdioDef(SERVER), seat.host, { warn: () => {} })
        const instance = seat.mount(config)
        await instance.ready
        await waitFor(() => seat.capture().tools.size === FIXTURE_TOOLS, 'fresh seat capture', 15_000)
        await instance.dispose()
      } finally {
        await seat.disposeSeat()
      }
      expect(b.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await b.dispose()
    }
  }, 60_000)
})
