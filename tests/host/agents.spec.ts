/**
 * THE GATING CORE — integration tests for src/agents.ts.
 *
 * Mounts a REAL ToolRuntime (official test recipe: SystemPrompt plugin +
 * ToolRuntime plugin on a root Context) plus real dsh-scope agent contexts
 * (createScope keyed by agent objects), a stubbed workspace registry over
 * real temp directories, and drives the agent applier with fake server defs:
 *
 * - tools visible only to agents whose session cwd canonicalizes to a
 *   registered workspace holding an explicit ENABLE record for the server
 *   (default off: an absent record means invisible);
 * - no enable record → invisible; cwd outside every workspace → invisible;
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

interface LoggedLine { level: 'info' | 'warn' | 'error'; message: string }

/** Live fake agents + workspace registry backed by real temp directories. */
class Harness {
  readonly ctx = new Context()
  /** The tools-injecting fiber ctx that agent scopes derive from. */
  factoryCtx!: Context
  /** The applier's own fiber ctx (listeners/effects live here). */
  hostCtx!: Context
  readonly live = new Map<string, Agent>()
  workspaces: WorkspaceLike[] = []
  /** Per-workspace explicit enables: a row exists ⇔ the server is on there. */
  overrides: WorkspaceOverrides = {}
  /** serverNames the harness reports as globally disabled (manager's live view). */
  readonly globalDisabled = new Set<string>()
  applier!: AgentApplier
  /** Captured applier log lines (apply/revoke/tracking evidence). */
  readonly lines: LoggedLine[] = []
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

  /**
   * Spawn a fake agent whose session cwd is `cwd`. `origin` mirrors
   * `session.header.origin` ('subagent' on delegation children; absent on
   * top-level agents).
   */
  spawnAgent(id: string, cwd: string | undefined, origin?: 'subagent'): Agent {
    // The agent object itself is the scope key (production: createScope(loopCtx, agent)).
    const agent = {
      id,
      session: {
    header: { cwd, origin: origin ?? undefined },
    // Spy for the session-write contract: the applier must NEVER append. A
    // third-party event type is required-on-read (the envelope's `ignorable`
    // marker has no write path in this generation), so one append would make the
    // stored session unreadable to every reader, the writing harness included.
    // The notice is derived client-side from `request/header` events instead.
    append(type: string, data: unknown): void {
      appended.push({ type, data })
    },
  },
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

  /** Push one server state through the harness applier (epoch defaults to 1). */
  push(serverName: string, syncId: number, defs: Map<string, ToolDefinition>, epoch = 1): void {
    this.applier.pushServerState(serverName, { epoch, syncId, defs })
  }

  cleanup(): void {
    for (const root of this.tempRoots) rmSync(root, { recursive: true, force: true })
  }
}

/** A minimal live-session run context for executor probes. */
function execContext(): Parameters<NonNullable<ToolDefinition['execute']>>[1] {
  return {
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as never
}

/** Mount real ToolRuntime + applier on a fresh root Context. */
async function mount(): Promise<Harness> {
  const h = new Harness()
  await h.ctx.plugin(SystemPrompt)
  await h.ctx.plugin(ToolRuntime)

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
      logger: {
        info: (message) => void h.lines.push({ level: 'info', message }),
        warn: (message) => void h.lines.push({ level: 'warn', message }),
        error: (message) => void h.lines.push({ level: 'error', message }),
      },
      agents: {
        roots: () => [...h.live.values()],
        get: (id: string) => h.live.get(id),
      },
      workspaceRegistry: { list: () => [...h.workspaces] },
      overrides: () => h.overrides,
      isDisabled: (serverName: string) => h.globalDisabled.has(serverName),
    })
  })
  return h
}

const appended: { type: string; data: unknown }[] = []

describe('per-agent scope gating (real ToolRuntime + dsh-scope contexts)', () => {
  it('serves tools only to enabled-workspace agents; the global layer stays empty', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const wsB = await h.addWorkspace('b')
      h.overrides = { [wsA.id]: { files: true } } // only A enables it; B has no record

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
      h.push(SERVER, 1, defs)

      // Workspace A explicitly enables the server.
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
      // Workspace B has no enable record (default off).
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

  it('never writes a session event (the notice is derived client-side)', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.overrides = { [wsA.id]: { files: true, other: true } }
      // Prove the spy is LIVE before trusting an empty result, then clear it:
      // adoption itself is part of the exercised surface.
      appended.length = 0
      ;(agentA.session as unknown as { append(type: string, data: unknown): void }).append('control/probe', {})
      expect(appended).toHaveLength(1)
      appended.length = 0
      h.createAgent(agentA)

      // Every path that used to append an injected-tools notice: adoption, first
      // sync, idempotent re-push, a second server, a settings flip, an empty
      // generation, a revoke and plugin teardown.
      h.push('files', 1, new Map<string, ToolDefinition>([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]]))
      h.applier.reconcile()
      h.push('other', 1, new Map<string, ToolDefinition>([['mcp__other__only', def('mcp__other__only')]]))
      h.overrides = { [wsA.id]: { other: true } } // settings flip: "files" no longer enabled
      h.applier.reconcile()
      h.push('files', 2, new Map())
      h.applier.revokeServer('other')
      h.applier.dispose()

      // A third-party session event carries no `ignorable` marker (the write
      // entry has no option for it in this generation) and would therefore make
      // the whole stored log REFUSE to load — including for the harness that
      // wrote it. The applier must stay a pure tool-scope writer, and the
      // conversation notice is derived from the harness's own `request/header`
      // events (src/client/injection.ts).
      expect(appended).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  it('keeps two servers side by side in one scope — including a shared tool name — and gates them independently (MULTI-2)', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.overrides = { [wsA.id]: { alpha: true, beta: true } }
      h.createAgent(agentA)

      // Public names are namespaced by server, so two servers exposing the same
      // RAW tool name ("search") stay distinct registrations.
      const ALPHA_SEARCH = 'mcp__alpha__search'
      const ALPHA_ONLY = 'mcp__alpha__only'
      const BETA_SEARCH = 'mcp__beta__search'
      const BETA_ONLY = 'mcp__beta__only'
      h.push('alpha', 1, new Map<string, ToolDefinition>([[ALPHA_SEARCH, def(ALPHA_SEARCH)], [ALPHA_ONLY, def(ALPHA_ONLY)]]))
      h.push('beta', 1, new Map<string, ToolDefinition>([[BETA_SEARCH, def(BETA_SEARCH)], [BETA_ONLY, def(BETA_ONLY)]]))

      for (const name of [ALPHA_SEARCH, ALPHA_ONLY, BETA_SEARCH, BETA_ONLY]) {
        expect(h.ctx.tools.get(name, agentA), name).toBeDefined()
      }
      expect(h.ctx.tools.get(ALPHA_SEARCH, agentA)).not.toBe(h.ctx.tools.get(BETA_SEARCH, agentA))

      // Switching ONE server off for this workspace leaves the other's tools.
      h.overrides = { [wsA.id]: { beta: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(ALPHA_SEARCH, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(ALPHA_ONLY, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(BETA_SEARCH, agentA)).toBeDefined()
      expect(h.ctx.tools.get(BETA_ONLY, agentA)).toBeDefined()

      // …and switching it back on restores exactly its own tools.
      h.overrides = { [wsA.id]: { alpha: true, beta: true } }
      h.applier.reconcile()
      for (const name of [ALPHA_SEARCH, ALPHA_ONLY, BETA_SEARCH, BETA_ONLY]) {
        expect(h.ctx.tools.get(name, agentA), name).toBeDefined()
      }
    } finally {
      h.cleanup()
    }
  })

  it('re-applies on settings reconcile (enable/disable flip) and revokes on empty sync', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.overrides = { [wsA.id]: { files: true } }
      h.createAgent(agentA)

      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Settings reconcile removes the enable record → revoked everywhere.
      h.overrides = {}
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()

      // Reconcile re-enables → re-registered from the retained server state.
      h.overrides = { [wsA.id]: { files: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Sync-driven revocation: a committed empty generation removes the tools.
      h.push(SERVER, 2, new Map())
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
      h.overrides = { [wsA.id]: { files: true } }
      h.createAgent(agentA)

      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A, 'v1')]]))
      const first = h.ctx.tools.get(TOOL_A, agentA)!
      expect(first).toBeDefined()

      // Same (epoch, syncId) re-push (e.g. a redundant reconcile) must be a no-op.
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A, 'v1-dup')]]))
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(first)

      // New syncId with a changed tool list: old tool gone, new tool visible.
      h.push(SERVER, 2, new Map([[TOOL_B, def(TOOL_B, 'v2')]]))
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
      h.overrides = { [wsA.id]: { files: true } }
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
        second.pushServerState(SERVER, { epoch: 1, syncId: 1, defs: new Map([[TOOL_A, def(TOOL_A)]]) })
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
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // agent/disposed → bookkeeping drop only: the scope-layer registrations
      // are owned by the agent ctx's fiber and survive until it tears down
      // (we never call disposers after disposal).
      h.disposeAgent(agentA)
      h.push(SERVER, 2, new Map([[TOOL_B, def(TOOL_B)]]))
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
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      // The scoped view resolves the tool for this agent scope.
      const tools = agentA.ctx.get('tools') as ToolRuntime
      expect(tools.get(TOOL_A, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('re-registers a restarted server whose fresh handle reuses syncId 1 (epoch guard, PERF-2)', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)

      // Pre-restart handle committed its first generation (epoch 1, syncId 1).
      const oldGen = def(TOOL_A, 'old-gen')
      const newGen = def(TOOL_A, 'new-gen')
      const newTool = def(TOOL_B, 'new-tool')
      h.push(SERVER, 1, new Map([[TOOL_A, oldGen]]))
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(oldGen)

      // A restart disposes the old handle and starts a FRESH one, whose first
      // commit is again syncId 1 (a fresh supervisor restarts its counter).
      // The epoch half of the idempotence guard must defeat the old same-
      // syncId absorption: the new defs land in the agent scope and the stale
      // pre-restart defs are revoked — otherwise executors bound to the
      // closed client would keep serving.
      h.push(SERVER, 1, new Map([[TOOL_A, newGen], [TOOL_B, newTool]]), 2)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(newGen)
      expect(h.ctx.tools.get(TOOL_A, agentA)).not.toBe(oldGen)
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBe(newTool)

      // The registered generation executes through the NEW definition.
      const registered = h.ctx.tools.get(TOOL_A, agentA)!
      const value = await registered.execute({}, execContext())
      expect(value).toEqual({ content: [{ type: 'text', text: 'new-gen' }] })

      // Re-pushing the same (epoch, syncId) stays a no-op.
      const current = h.ctx.tools.get(TOOL_A, agentA)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A, 'dup')]]), 2)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(current)
    } finally {
      h.cleanup()
    }
  })

  it('reconcile is a no-op for unchanged pairs and still applies real flips (PERF-1/IMPL-2)', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)

      const defs = new Map([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]])
      h.push(SERVER, 1, defs)
      const registered = h.ctx.tools.get(TOOL_A, agentA)!
      expect(registered).toBeDefined()

      // A no-op reconcile (same doc, same overrides, same workspace list)
      // must perform ZERO re-registrations: no apply and no revoke lines
      // from the applier, and the registered definition identity is intact.
      const before = h.lines.length
      h.applier.reconcile()
      expect(h.lines.length).toBe(before)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBe(registered)

      // A real OFF flip (the enable record is removed) still revokes…
      h.overrides = {}
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeUndefined()
      expect(h.lines.at(-1)?.message).toContain('revoked server "files" from agent agent-a (disabled for this workspace)')

      // …and a real ON flip still re-registers from the retained state.
      h.overrides = { [wsA.id]: { files: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
      expect(h.lines.at(-1)?.message).toContain('applied 2 tools of server "files" to agent agent-a')
    } finally {
      h.cleanup()
    }
  })

  it('a globally disabled server is revoked everywhere and re-applied on re-enable', async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      h.globalDisabled.add(SERVER)
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.lines.at(-1)?.message).toContain(
        'revoked server "files" from agent agent-a (server is disabled globally)',
      )

      h.globalDisabled.delete(SERVER)
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      expect(h.lines.at(-1)?.message).toContain('applied 1 tool of server "files" to agent agent-a')
    } finally {
      h.cleanup()
    }
  })

  it("revokes tools when the entry's workspace disappears from the registry (IMPL-1/ARCH-2)", async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // Workspace deleted from the registry while its agent lives: the next
      // reconcile must revoke — the entry is workspace-less again.
      h.workspaces = []
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.lines.at(-1)?.message).toContain('revoked server "files" from agent agent-a (agent has no workspace)')

      // A fresh push of another generation must not resurrect the tools.
      h.push(SERVER, 2, new Map([[TOOL_B, def(TOOL_B)]]), 2)
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it("revokes when the workspace's directory disappears from disk (R2I-7)", async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('dirgone')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()

      // The directory is removed while the registry row still exists: the
      // canonical-cwd resolution fails closed and the next reconcile revokes.
      rmSync(wsA.path, { recursive: true, force: true })
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.lines.at(-1)?.message).toContain('revoked server "files" from agent agent-a (agent has no workspace)')
    } finally {
      h.cleanup()
    }
  })

  it('applies tools once a workspace appears for a previously workspace-less agent (IMPL-1/ARCH-2)', async () => {
    const h = await mount()
    try {
      const dir = h.makeOutsideDir()
      const agentA = h.spawnAgent('agent-a', dir)
      h.createAgent(agentA)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()

      // The session's directory becomes a registered workspace AFTER
      // adoption, and that workspace enables the server: the next reconcile
      // resolves the entry into it and registers its tools.
      h.workspaces.push({ id: 'ws-late', path: dir })
      h.overrides = { 'ws-late': { files: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it("never adopts delegation children (header.origin === 'subagent') — listener and boot scan (ARCH-3/IMPL-6)", async () => {
    const h = await mount()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const root = h.spawnAgent('agent-root', wsA.path)
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent')
      // Listener path: both agents are published AFTER activation. The child
      // must not be adopted even though its cwd is in an enabled workspace.
      h.createAgent(root)
      h.createAgent(child)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, root)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_A, child)).toBeUndefined()
      expect(h.lines.some((l) => l.message.includes('tracking agent agent-child'))).toBe(false)
      expect(h.lines.some((l) => l.message.includes('tracking agent agent-root'))).toBe(true)

      // Boot path: a fresh applier (plugin reload) scans agents.roots(); the
      // already-live child must still be skipped, keeping the scan symmetric
      // with the agent/created listener.
      const bootLines: LoggedLine[] = []
      const second = createAgentApplier({
        ctx: h.hostCtx,
        logger: {
          info: (message) => void bootLines.push({ level: 'info', message }),
          warn: (message) => void bootLines.push({ level: 'warn', message }),
          error: (message) => void bootLines.push({ level: 'error', message }),
        },
        agents: { roots: () => [...h.live.values()], get: (id: string) => h.live.get(id) },
        workspaceRegistry: { list: () => [...h.workspaces] },
        overrides: () => h.overrides,
      })
      try {
        expect(bootLines.some((l) => l.message.includes('tracking agent agent-root'))).toBe(true)
        expect(bootLines.some((l) => l.message.includes('tracking agent agent-child'))).toBe(false)
        // The child never receives tools from any applier, and its disposal
        // is a bookkeeping no-op.
        h.disposeAgent(child)
        expect(h.ctx.tools.get(TOOL_A, child)).toBeUndefined()
      } finally {
        second.dispose()
      }
    } finally {
      h.cleanup()
    }
  })
})