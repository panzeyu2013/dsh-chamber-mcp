/**
 * Agent/applier test harness: REAL ToolRuntime + real dsh-scope agent contexts
 * (createScope keyed by the Agent object), a stubbed workspace registry over
 * real temp directories, and the production per-agent applier or any injected
 * applier under test.
 *
 * Extracted so the gating-core spec (agents.spec.ts) and the on-demand
 * admission spec (applier-admission.spec.ts) share one definition of
 * "production-shaped agent scope" instead of two drifting copies.
 *
 * @module
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAgentApplier, type AgentApplier } from '../../src/agents.js'
import type { CaptureSnapshot } from '../../src/facade.js'
import type { WorkspaceLike } from '../../src/workspace.js'
import type { WorkspaceOverrides } from '../../src/shared/model.js'
import { mountReal } from './mount-real.js'
import { captureOf, type LoggedLine } from './fixture-kit.js'

export {
  captureOf,
  capturedSection,
  execContext,
  resourceProvider,
  settle,
  toolDef,
  type LoggedLine,
} from './fixture-kit.js'

/**
 * One durable subagent/descriptor session event, shaped like the harness's own
 * (@deepseek-ai/dsh-subagent): version 3, the envelope field is data, and only a
 * continuable child carries a toolFilter.
 */
export function descriptorEvent(toolFilter?: unknown): unknown {
  return {
    type: 'subagent/descriptor',
    seq: 0,
    time: 0,
    data: {
      version: 3,
      mode: 'continuable',
      provider: 'in-process',
      label: 'child',
      ...(toolFilter === undefined ? {} : { toolFilter }),
    },
  }
}

/** Spawn options of one fake agent. */
interface SpawnOptions {
  /** The agent's OWN event window. */
  events?: readonly unknown[]
  /** The fork-inherited prefix the session serves before the own window. */
  inheritedEvents?: readonly unknown[]
  /** Remove the session snapshot API entirely (old generation). */
  withoutSnapshotApi?: boolean
  /** Keep snapshotEvents but omit the inherited-event boundary. */
  withoutInheritedCount?: boolean
}

/**
 * Live fake agents + workspace registry backed by real temp directories plus
 * the production applier. One instance per test; call cleanup() in finally.
 */
export class AgentHarness {
  readonly ctx = new Context()
  /** The tools-injecting fiber ctx that agent scopes derive from. */
  factoryCtx!: Context
  /** The applier's own fiber ctx (listeners/effects live here). */
  hostCtx!: Context
  readonly live = new Map<string, Agent>()
  workspaces: WorkspaceLike[] = []
  /** Per-workspace explicit enables: a row exists iff the server is on there. */
  overrides: WorkspaceOverrides = {}
  /** serverNames the harness reports as globally disabled. */
  readonly globalDisabled = new Set<string>()
  applier!: AgentApplier
  readonly lines: LoggedLine[] = []
  /** Session writes observed through the append spy (must stay empty). */
  readonly sessionWrites: Array<{ type: string; data: unknown }> = []
  private readonly agentsScope = new Map<Agent, Scope>()
  private readonly tempRoots: string[] = []

  /** Mount real services and install the production applier on its own fiber. */
  async mount(): Promise<this> {
    this.factoryCtx = (await mountReal(this.ctx)).factoryCtx
    await this.ctx.plugin((c: Context) => {
      this.hostCtx = c
    })
    await this.hostCtx.plugin((c: Context) => {
      this.applier = this.createApplier(c)
    })
    return this
  }

  /** Create the production applier over this harness's live inputs. */
  createApplier(ctx: Context): AgentApplier {
    return createAgentApplier({
      ctx,
      logger: {
        info: (message) => void this.lines.push({ level: 'info', message }),
        warn: (message) => void this.lines.push({ level: 'warn', message }),
        error: (message) => void this.lines.push({ level: 'error', message }),
      },
      agents: this.registry(),
      workspaceRegistry: { list: () => [...this.workspaces] },
      overrides: () => this.overrides,
      disabled: () => {
        const rows: Record<string, true> = {}
        for (const name of this.globalDisabled) rows[name] = true
        return rows
      },
    })
  }

  /** Create a workspace directory on disk and register it. */
  async addWorkspace(name: string): Promise<{ id: string; path: string }> {
    const base = mkdtempSync(join(tmpdir(), 'mcp-scope-gate-' + name + '-'))
    this.tempRoots.push(base)
    const path = realpathSync(base)
    const id = 'ws-' + name
    this.workspaces.push({ id, path })
    return { id, path }
  }

  /** Create a directory that is NOT a registered workspace. */
  makeOutsideDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-scope-outside-'))
    this.tempRoots.push(dir)
    return realpathSync(dir)
  }

  /** Spawn a fake agent whose session cwd is cwd. */
  spawnAgent(id: string, cwd: string | undefined, origin?: 'subagent', options: SpawnOptions = {}): Agent {
    const inheritedEvents = options.inheritedEvents ?? []
    const ownEvents = options.events ?? []
    const log = [...inheritedEvents, ...ownEvents]
    // Spy for the session-write contract: the applier must NEVER append.
    const session: Record<string, unknown> = {
      header: { cwd, origin: origin ?? undefined },
      append(type: string, data: unknown): void {
        writes.push({ type, data })
      },
    }
    const writes = this.sessionWrites
    if (options.withoutSnapshotApi !== true) {
      if (options.withoutInheritedCount !== true) session.inheritedEventCount = inheritedEvents.length
      session.snapshotEvents = (from = 0): readonly unknown[] => log.slice(from)
    }
    // The agent object itself is the scope key (production: createScope(loopCtx, agent)).
    const agent = { id, session } as unknown as Agent
    const scope = createScope(this.factoryCtx, agent as never)
    ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
    this.live.set(id, agent)
    this.agentsScope.set(agent, scope)
    return agent
  }

  /** Publish + announce an agent, mirroring the real registry's emits. */
  createAgent(agent: Agent): void {
    this.ctx.emit('agent/created', { agent, source: 'startup' })
  }

  disposeAgent(agent: Agent): void {
    this.ctx.emit('agent/disposed', { agent })
    this.live.delete(agent.id as unknown as string)
  }

  /** Dispose one agent's scope ctx (its scope-layer entries die with it). */
  async teardownAgent(agent: Agent): Promise<void> {
    const scope = this.agentsScope.get(agent)
    if (scope !== undefined) await scope.dispose()
  }

  /** Push one tool generation (capture version defaults to the given version). */
  push(serverName: string, version: number, defs: Map<string, ToolDefinition>, epoch = 1): void {
    this.applier.syncServerState(serverName, { epoch, capture: captureOf(defs, { version }) })
  }

  /** Push one full capture generation. */
  sync(serverName: string, capture: CaptureSnapshot, epoch = 1): void {
    this.applier.syncServerState(serverName, { epoch, capture })
  }

  /** Remove one server everywhere. */
  remove(serverName: string): void {
    this.applier.removeServer(serverName)
  }

  /** On-demand admission through the production applier. */
  admit(agent: Agent, definition: ToolDefinition): () => void {
    return this.applier.admit(agent, definition)
  }

  /** The registry projection the applier consumes, with production semantics. */
  registry(): { list(): Agent[]; get(id: string): Agent | undefined } {
    return {
      list: () => [...this.live.values()],
      get: (id: string) => this.live.get(id),
    }
  }

  cleanup(): void {
    for (const root of this.tempRoots) rmSync(root, { recursive: true, force: true })
  }
}

/** Mount one ready-to-drive harness (real ToolRuntime + production applier). */
export async function mountAgentHarness(): Promise<AgentHarness> {
  return new AgentHarness().mount()
}
