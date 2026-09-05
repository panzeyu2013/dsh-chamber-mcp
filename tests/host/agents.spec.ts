/**
 * THE GATING CORE — integration tests for src/agents.ts.
 *
 * Mounts a REAL ToolRuntime (official test recipe: SystemPrompt plugin +
 * ToolRuntime plugin on a root Context) plus real dsh-scope agent contexts
 * (createScope keyed by agent objects), a stubbed workspace registry over
 * real temp directories, and drives the agent applier with fake server defs:
 *
 * - tools visible only to agents whose session cwd canonicalizes to a
 *   registered workspace with the server enabled (default on);
 * - overrides off → invisible; cwd outside every workspace → invisible;
 * - settings reconcile + sync-driven revocation; nothing ever lands in the
 *   global layer.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAgentApplier, type AgentApplier } from '../../src/agents.js'
import type { WorkspaceLike } from '../../src/workspace.js'
import type { WorkspaceOverrides } from '../../src/shared/model.js'

/** A minimal ToolDefinition with a canned executor. */
function def(name: string, reply = 'ok'): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
        },
        required: ['content'],
        additionalProperties: false,
      },
      render() {
        return [{ type: 'text', text: reply }]
      },
    },
    async execute() {
      return { content: [{ type: 'text', text: reply }] }
    },
  }
}

const SERVER = 'files'
const TOOL_A = 'mcp__files__read_file'
const TOOL_B = 'mcp__files__write_file'

/** Live fake agents + workspace registry backed by real temp directories. */
class Harness {
  readonly ctx = new Context()
  /** The tools-injecting fiber ctx that agent scopes derive from. */
  factoryCtx!: Context
  /** The applier's own fiber ctx (listeners/effects live here). */
  hostCtx!: Context
  readonly live = new Map<string, Agent>()
  workspaces: WorkspaceLike[] = []
  overrides: WorkspaceOverrides = {}
  applier!: AgentApplier
  private readonly agentsScope = new Map<Agent, Scope>()
  private readonly tempRoots: string[] = []

  /** Create a workspace directory on disk and register it. */
  async addWorkspace(name: string): Promise<{ id: string; path: string }> {
    const base = mkdtempSync(join(tmpdir(), `mcp-scope-gate-${name}-`))
    this.tempRoots.push(base)
    const path = realpathSync(base)
    const id = `ws-${name}`
    this.workspaces.push({ id, path })
    return { id, path }
  }

  /** Create a directory that is NOT a registered workspace. */
  makeOutsideDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-scope-outside-'))
    this.tempRoots.push(dir)
    return realpathSync(dir)
  }

  /** Spawn a fake agent whose session cwd is `cwd`; returns the agent. */
  spawnAgent(id: string, cwd: string | undefined): Agent {
    // The agent object itself is the scope key (production: createScope(loopCtx, agent)).
    const agent = {
      id,
      session: { header: { cwd } },
    } as unknown as Agent
    const scope = createScope(this.factoryCtx, agent as never)
    ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
    this.live.set(id, agent)
    this.agentsScope.set(agent, scope)
    return agent
  }

  /** Publish + announce an agent, mirroring the real registry's emits. */
  createAgent(agent: Agent): void {
    this.ctx.emit('agent/created', { agent })
  }

  disposeAgent(agent: Agent): void {
    this.ctx.emit('agent/disposed', { agent })
    this.live.delete(agent.id)
  }

  /** Dispose one agent's scope ctx (its scope-layer entries die with it). */
  async teardownAgent(agent: Agent): Promise<void> {
    const scope = this.agentsScope.get(agent)
    if (scope !== undefined) await scope.dispose()
  }

  cleanup(): void {
    for (const root of this.tempRoots) rmSync(root, { recursive: true, force: true })
  }
}

/** Mount real ToolRuntime + applier on a fresh root Context. */
async function mount(): Promise<Harness> {
  const h = new Harness()
  await h.ctx.plugin(SystemPrompt)
  await h.ctx.plugin(ToolRuntime)
  const agentViews: Agent[] = []
  void agentViews

  // The applier's own fiber ctx.
  await h.ctx.plugin(function applierHost(c: Context) {
    h.hostCtx = c
  })
  // The tools-injecting fiber ctx under which agent scopes are created —
  // mirrors production: agent scopes derive from the agent-loop ctx whose
  // fiber injected `tools`, which is what makes agent.ctx.tools resolvable.
  const factoryPlugin = function agentFactory(c: Context) {
    h.factoryCtx = c
  }
  factoryPlugin.inject = ['tools']
  await h.ctx.plugin(factoryPlugin)

  await h.hostCtx.plugin(function installApplier(c: Context) {
    h.applier = createAgentApplier({
      ctx: c,
      logger: c.logger,
      agents: {
        roots: () => [...h.live.values()],
        get: (id: string) => h.live.get(id),
      },
      workspaceRegistry: { list: () => [...h.workspaces] },
      overrides: () => h.overrides,
    })
  })
  return h
}

describe('per-agent scope gating (real ToolRuntime + dsh-scope contexts)', () => {
  it('serves tools only to enabled-workspace agents; the global layer stays empty', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const wsB = await h.addWorkspace('b')
      h.overrides = { [wsB.id]: { files: true } } // B explicitly OFF

      const agentA = h.spawnAgent('agent-a', wsA.path)
      const agentB = h.spawnAgent('agent-b', wsB.path)
      const agentOut = h.spawnAgent('agent-out', h.makeOutsideDir())
      const agentNone = h.spawnAgent('agent-none', undefined)
      h.createAgent(agentA)
      h.createAgent(agentB)
      h.createAgent(agentOut)
      h.createAgent(agentNone)

      const defs = new Map<string, ToolDefinition>([
        [TOOL_A, def(TOOL_A)],
        [TOOL_B, def(TOOL_B)],
      ])
      h.applier.pushServerState(SERVER, { syncId: 1, defs })

      // Enabled workspace agent (default on).
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
      // Workspace B has the server switched off.
      expect(h.ctx.tools.get(TOOL_A, agentB)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, agentB)).toBeUndefined()
      // Cwd outside every registered workspace.
      expect(h.ctx.tools.get(TOOL_A, agentOut)).toBeUndefined()
      // No cwd at all.
      expect(h.ctx.tools.get(TOOL_A, agentNone)).toBeUndefined()
      // The global layer NEVER received them.
      expect(h.ctx.tools.get(TOOL_A)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B)).toBeUndefined()
      // A scope with no key (unscoped read) must not see them either.
      expect(h.ctx.tools.schemas().some((s) => s.name === TOOL_A)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('re-applies on settings reconcile (enable/disable flip) and revokes on empty sync', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)

      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.applier.pushServerState(SERVER, { syncId: 1, defs })
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Settings reconcile disables the workspace → revoked everywhere.
      h.overrides = { [wsA.id]: { files: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()

      // Reconcile re-enables → re-registered from the retained server state.
      h.overrides = {}
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Sync-driven revocation: a committed empty generation removes the tools.
      h.applier.pushServerState(SERVER, { syncId: 2, defs: new Map() })
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('swaps generations on defsChanged; same-syncId pushes are idempotent', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)

      h.applier.pushServerState(SERVER, { syncId: 1, defs: new Map([[TOOL_A, def(TOOL_A, 'v1')]]) })
      const first = h.ctx.tools.get(TOOL_A, agentA)!
      expect(first).toBeDefined()

      // Same syncId re-push (e.g. a redundant reconcile) must be a no-op.
      h.applier.pushServerState(SERVER, { syncId: 1, defs: new Map([[TOOL_A, def(TOOL_A, 'v1-dup')]]) })
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(first)

      // New syncId with a changed tool list: old tool gone, new tool visible.
      h.applier.pushServerState(SERVER, {
        syncId: 2,
        defs: new Map([[TOOL_B, def(TOOL_B, 'v2')]]),
      })
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('adopts pre-existing root agents at startup (roots scan)', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      // A second applier instance simulates a plugin (re)load AFTER the
      // agent was already published.
      const second = createAgentApplier({
        ctx: h.hostCtx,
        logger: h.hostCtx.logger,
        agents: { roots: () => [...h.live.values()], get: (id: string) => h.live.get(id) },
        workspaceRegistry: { list: () => [...h.workspaces] },
        overrides: () => h.overrides,
      })
      try {
        second.pushServerState(SERVER, { syncId: 1, defs: new Map([[TOOL_A, def(TOOL_A)]]) })
        expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      } finally {
        second.dispose()
      }
    } finally {
      h.cleanup()
    }
  })

  it('drops bookkeeping on agent/disposed; scope entries die with the agent ctx', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.applier.pushServerState(SERVER, { syncId: 1, defs: new Map([[TOOL_A, def(TOOL_A)]]) })
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // agent/disposed → bookkeeping drop only: the scope-layer registrations
      // are owned by the agent ctx's fiber and survive until it tears down
      // (we never call disposers after disposal).
      h.disposeAgent(agentA)
      h.applier.pushServerState(SERVER, { syncId: 2, defs: new Map([[TOOL_B, def(TOOL_B)]]) })
      h.applier.revokeServer(SERVER)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Disposing the agent scope ctx removes its scope-layer entries.
      await h.teardownAgent(agentA)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('registers through agent.ctx so the agent scope itself sees the tools', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.applier.pushServerState(SERVER, { syncId: 1, defs })
      // The scoped view resolves the tool for this agent scope.
      const tools = agentA.ctx.get('tools') as ToolRuntime
      expect(tools.get(TOOL_A, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })
})
