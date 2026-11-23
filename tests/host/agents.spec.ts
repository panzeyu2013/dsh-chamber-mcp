/**
 * THE GATING CORE — integration tests for src/agents.ts (the per-agent applier).
 *
 * Mounts the REAL ToolRuntime (0.2.3 recipe: SessionProjections -> SystemPrompt
 * -> ToolRuntime -> the tools-injecting factory ctx), real dsh-scope agent
 * contexts (createScope keyed by agent objects), a stubbed workspace registry
 * over real temp directories, and drives the production applier with capture
 * snapshots:
 *
 * - tools visible only to agents whose session cwd canonicalizes to a
 *   registered workspace holding an explicit ENABLE record for the server
 *   (default off: an absent record means invisible);
 * - no enable record -> invisible; cwd outside every workspace -> invisible;
 * - settings reconcile + capture-driven revocation; nothing ever lands in the
 *   global layer; context (sections/resources) follows the same gate once per
 *   epoch and survives a same-epoch tool generation swap (A2/A4).
 */

import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAgentApplier } from '../../src/agents.js'
import { mountReal } from '../support/mount-real.js'
import type { CaptureSnapshot } from '../../src/facade.js'
import {
  captureOf,
  capturedSection,
  descriptorEvent,
  execContext,
  mountAgentHarness,
  resourceProvider,
  settle,
  toolDef as def,
  type LoggedLine,
} from '../support/agent-kit.js'

const SERVER = 'files'
const TOOL_A = 'mcp__files__read_file'
const TOOL_B = 'mcp__files__write_file'

/** One capture carrying a prompt section + resource provider (context facets). */
function contextCapture(defs: Map<string, ToolDefinition>, version = 1): CaptureSnapshot {
  return captureOf(defs, {
    version,
    sections: [
      capturedSection({ name: 'mcp:files', order: 3100, text: () => '### use add first' }),
    ],
    resources: new Map([[SERVER, resourceProvider()]]),
  })
}

describe('per-agent scope gating (real ToolRuntime + dsh-scope contexts)', () => {
  it('serves tools only to enabled-workspace agents; the global layer stays empty', async () => {
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.overrides = { [wsA.id]: { files: true, other: true } }
      // Prove the spy is LIVE before trusting an empty result, then clear it:
      // adoption itself is part of the exercised surface.
      h.sessionWrites.length = 0
      ;(agentA.session as unknown as { append(type: string, data: unknown): void }).append('control/probe', {})
      expect(h.sessionWrites).toHaveLength(1)
      h.sessionWrites.length = 0
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
      h.remove('other')
      h.applier.dispose()

      // A third-party session event carries no `ignorable` marker (the write
      // entry has no option for it in this generation) and would therefore make
      // the whole stored log REFUSE to load — including for the harness that
      // wrote it. The applier must stay a pure tool-scope writer, and the
      // conversation notice is derived from the harness's own `request/header`
      // events (src/client/injection.ts).
      expect(h.sessionWrites).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  it('keeps two servers side by side in one scope — including a shared tool name — and gates them independently (MULTI-2)', async () => {
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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

  it('adopts pre-existing agents from the list() registry (0.2.2-rc.3 shape)', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.overrides = { [wsA.id]: { files: true } }
      h.createAgent(agentA)
      // dsh 0.2.2-rc.3 removed AgentRegistry.roots(): the registry exposes
      // list()+get() only, and the production manager adapter reads list().
      const second = createAgentApplier({
        ctx: h.hostCtx,
        logger: h.hostCtx.logger,
        agents: { list: () => [...h.live.values()], get: (id: string) => h.live.get(id) },
        workspaceRegistry: { list: () => [...h.workspaces] },
        overrides: () => h.overrides,
        disabled: () => ({}),
      })
      try {
        second.syncServerState(SERVER, { epoch: 1, capture: captureOf(new Map([[TOOL_A, def(TOOL_A)]]), { version: 1 }) })
        expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      } finally {
        second.dispose()
      }
    } finally {
      h.cleanup()
    }
  })

  it('drops bookkeeping on agent/disposed; scope entries die with the agent ctx', async () => {
    const h = await mountAgentHarness()
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
      h.remove(SERVER)
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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
    const h = await mountAgentHarness()
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

  it('adopts delegation children: the workspace MCP tools reach a subagent (listener + boot scan)', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const root = h.spawnAgent('agent-root', wsA.path)
      // A continuable child whose descriptor declares no narrowing: nothing to mirror.
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', { events: [descriptorEvent()] })
      // A one-shot child has no descriptor at this point at all (upstream appends
      // it at its first `agent/pre-step`): absent must behave like unnarrowed.
      const oneShot = h.spawnAgent('agent-one-shot', wsA.path, 'subagent', { events: [] })
      h.createAgent(oneShot)
      h.createAgent(root)
      h.createAgent(child)
      const defs = new Map([[TOOL_A, def(TOOL_A)]])
      h.push(SERVER, 1, defs)
      expect(h.ctx.tools.get(TOOL_A, root)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.lines.some((l) => l.message.includes('tracking agent agent-child'))).toBe(true)
      expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('agent-child'))).toBe(false)
      expect(h.ctx.tools.get(TOOL_A, oneShot)).toBeDefined()
      expect(
        h.lines.some(
          (l) => l.level === 'info' && l.message.includes('agent-one-shot') && l.message.includes('no descriptor yet'),
        ),
      ).toBe(true)

      // Boot path: a fresh applier (plugin reload) adopts every live agent the
      // registry reports — a running child during an HMR reload included, which
      // a top-level-only projection would miss.
      const bootLines: LoggedLine[] = []
      const second = createAgentApplier({
        ctx: h.hostCtx,
        logger: {
          info: (message) => void bootLines.push({ level: 'info', message }),
          warn: (message) => void bootLines.push({ level: 'warn', message }),
          error: (message) => void bootLines.push({ level: 'error', message }),
        },
        agents: h.registry(),
        workspaceRegistry: { list: () => [...h.workspaces] },
        overrides: () => h.overrides,
        disabled: () => ({}),
      })
      try {
        expect(bootLines.some((l) => l.message.includes('tracking agent agent-root'))).toBe(true)
        expect(bootLines.some((l) => l.message.includes('tracking agent agent-child'))).toBe(true)
        // The reload must restore the LIVE child's tools, not just log a line:
        // the previous applier releases its registrations (what a plugin reload
        // does) and a push through the reloaded one must reach the child's scope.
        h.applier.dispose()
        second.syncServerState(SERVER, { epoch: 2, capture: captureOf(defs, { version: 1 }) })
        expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
        expect(bootLines.some((l) => l.level === 'error')).toBe(false)
      } finally {
        second.dispose()
      }
    } finally {
      h.cleanup()
    }
  })

  it("mirrors a continuable child's allow list: only admitted names register", async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        events: [descriptorEvent({ allow: [TOOL_A] })],
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_B, child)).toBeUndefined()
      expect(h.lines.some((l) => l.message.includes('narrowed by its delegator (allow 1, deny 0)'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('mirrors a deny list per name', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        events: [descriptorEvent({ deny: [TOOL_B] })],
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.ctx.tools.get(TOOL_B, child)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('withholds the whole server — tools AND context — when the filter admits none of it', async () => {
    const h = await mountAgentHarness()
    try {
      const resources = new RecordingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const parent = h.spawnAgent('agent-parent', wsA.path)
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        events: [descriptorEvent({ allow: ['fs_read'] })],
      })
      h.createAgent(parent)
      h.createAgent(child)
      h.sync(SERVER, contextCapture(new Map([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]])))
      await settle()
      expect(h.ctx.tools.get(TOOL_A, child)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, child)).toBeUndefined()
      // The parent is not a delegation child: its enabled behaviour is unchanged.
      expect(h.ctx.tools.get(TOOL_A, parent)).toBeDefined()
      expect(resources.registered).toHaveLength(1)
      expect(h.lines.some((l) => l.message.includes('withheld from agent agent-child'))).toBe(true)

      // The decision is recorded as a generation: an identical push is a no-op.
      const withheld = h.lines.filter((l) => l.message.includes('withheld from agent agent-child')).length
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)], [TOOL_B, def(TOOL_B)]]))
      expect(h.lines.filter((l) => l.message.includes('withheld from agent agent-child'))).toHaveLength(withheld)

      // The recorded suppression is invisible state: a repeated OFF decision for
      // the same generation is a no-op (nothing was ever registered), while
      // removing the server revokes the record like any other generation.
      h.overrides = {}
      h.applier.reconcile()
      expect(h.lines.some((l) => l.message.includes('revoked server "files" from agent agent-child'))).toBe(false)
      h.remove(SERVER)
      expect(h.lines.some((l) => l.message.includes('revoked server "files" from agent agent-child'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('fails open with a warning when the descriptor is unreadable (unknown version)', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        events: [{ type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 4, mode: 'continuable' } }],
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('descriptor is unreadable'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('fails open when the descriptor payload or its filter is malformed', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        events: [descriptorEvent({ allow: 'fs_read' })],
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(
        h.lines.some((l) => l.level === 'warn' && l.message.includes('toolFilter.allow is not an array')),
      ).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it("ignores a descriptor inherited from a forked parent's prefix", async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      // The parent was itself a narrowed child: its descriptor sits in the
      // fork-inherited prefix of this child's log, which is NOT this child's.
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        inheritedEvents: [descriptorEvent({ allow: ['fs_read'] })],
        events: [descriptorEvent()],
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.lines.some((l) => l.message.includes('narrowed by its delegator'))).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('fails open when the read API exists without the inherited-event boundary', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      // A seeded fork's parent descriptor sits in the inherited prefix: without
      // the boundary that separates it from the child's own events, folding it
      // would withhold tools the child was never denied.
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', {
        inheritedEvents: [descriptorEvent({ allow: ['fs_read'] })],
        withoutInheritedCount: true,
      })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(
        h.lines.some((l) => l.level === 'warn' && l.message.includes('inheritedEventCount is unavailable')),
      ).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('fails open when the generation has no session snapshot API', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const child = h.spawnAgent('agent-child', wsA.path, 'subagent', { withoutSnapshotApi: true })
      h.createAgent(child)
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, child)).toBeDefined()
      expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('unavailable in this generation'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})
/**
 * Records every `mcpResources.register` the applier routes through an agent
 * scope. A host-level registration would call this exactly once per server,
 * whatever the agents say; per-agent registration calls it only for the agents
 * whose workspace enabled the pair.
 */
class RecordingResources extends Service {
  readonly registered: { server: string; scope: unknown }[] = []
  readonly unloaded: string[] = []

  constructor(host: Context) {
    super(host, 'mcpResources')
  }

  register(server: string, _provider?: unknown): () => void {
    // `this` is bound to the CONSUMING fiber, exactly like the upstream
    // service: a registration made through a host ctx has NO scope
    // (`scopeOf` undefined) and the consumer then installs its three shared
    // tools in the GLOBAL layer.
    this.registered.push({ server, scope: scopeOf(this.ctx) })
    return this.ctx.effect(() => () => {
      this.unloaded.push(server)
    }, 'fake.mcpResources.register')
  }
}

describe('server context publication (per enabled agent)', () => {
  it('registers the context through the agent scope, never host-level', async () => {
    const h = await mountAgentHarness()
    try {
      const resources = new RecordingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      const wsB = await h.addWorkspace('b')

      // Only workspace B has a live agent, and it has NO enable record.
      const agentB = h.spawnAgent('agent-b', wsB.path)
      h.createAgent(agentB)

      const defs = new Map<string, ToolDefinition>([[TOOL_A, def(TOOL_A)]])
      h.sync(SERVER, contextCapture(defs))
      await settle()
      // Default off: a host-level registration would have published the three
      // shared resource tools to this agent (and to the global layer) here.
      expect(resources.registered).toEqual([])

      // Workspace A enables the pair -> exactly its agent gets the context.
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.applier.reconcile()
      await settle()
      expect(resources.registered).toEqual([{ server: SERVER, scope: expect.anything() }])
      expect(resources.registered[0]?.scope).toBeDefined()

      // Disabling the pair unloads that agent's copy again.
      h.overrides = {}
      h.applier.reconcile()
      await settle()
      expect(resources.unloaded).toEqual([SERVER])
    } finally {
      h.cleanup()
    }
  })
})

describe('capture facets and generation semantics (A2/A4)', () => {
  it("serves a tool-less capture's prompt section and resource to an enabled agent", async () => {
    const h = await mountAgentHarness()
    try {
      const resources = new RecordingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      // Enablement is decided by the workspace pair, never by tool count: a
      // server that lists no tools still publishes its context facets.
      h.sync(SERVER, contextCapture(new Map()))
      await settle()
      expect(resources.registered).toHaveLength(1)
      expect(resources.registered[0]?.server).toBe(SERVER)
      expect(h.lines.some((l) => l.message.includes('applied 0 tools of server "files"'))).toBe(true)
      expect(h.ctx.tools.get(TOOL_A)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('keeps the replayed context across a same-epoch tool generation swap', async () => {
    const h = await mountAgentHarness()
    try {
      const resources = new RecordingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.sync(SERVER, contextCapture(new Map([[TOOL_A, def(TOOL_A)]]), 1))
      await settle()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      expect(resources.registered).toHaveLength(1)

      // Same instance (epoch), new tool generation: only the tools swap; the
      // sections/resources are NOT re-registered (no retirement churn).
      h.push(SERVER, 2, new Map([[TOOL_B, def(TOOL_B)]]))
      await settle()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
      expect(resources.registered).toHaveLength(1)
      expect(resources.unloaded).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  it('replays the context once per epoch after an instance change', async () => {
    const h = await mountAgentHarness()
    try {
      const resources = new RecordingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.sync(SERVER, contextCapture(new Map([[TOOL_A, def(TOOL_A)]]), 1), 1)
      await settle()
      expect(resources.registered).toHaveLength(1)

      // A new epoch is a new instance: the previous context is disposed and the
      // capture's facets are replayed exactly once for the new generation.
      h.sync(SERVER, contextCapture(new Map([[TOOL_A, def(TOOL_A)]]), 1), 2)
      await settle()
      expect(resources.unloaded).toEqual([SERVER])
      expect(resources.registered).toHaveLength(2)
      expect([...new Set(resources.registered.map((entry) => entry.server))]).toEqual([SERVER])
    } finally {
      h.cleanup()
    }
  })
})


describe('applier failure containment', () => {
  it('rolls a tool generation back when a registration conflicts, and retries next generation', async () => {
    const h = await mountAgentHarness()
    try {
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      // A foreign registration occupies the name inside the SAME agent scope:
      // registering the captured generation must fail and roll the whole set back.
      const tools = agentA.ctx.get('tools') as ToolRuntime
      tools.register(def(TOOL_A, 'foreign'))
      h.push(SERVER, 1, new Map([[TOOL_A, def(TOOL_A)] , [TOOL_B, def(TOOL_B)]]))
      expect(h.lines.some((line) => line.level === 'error' && line.message.includes('tool registration failed'))).toBe(true)
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeUndefined()
      // The next generation (without the conflicting name) applies normally.
      h.push(SERVER, 2, new Map([[TOOL_B, def(TOOL_B)]]))
      expect(h.ctx.tools.get(TOOL_B, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('contains a throwing replayed-context disposer and keeps the tools path alive', async () => {
    const h = await mountAgentHarness()
    try {
      class ThrowingResources extends Service {
        constructor(ctx: Context) {
          super(ctx, 'mcpResources')
        }
        register(): () => void {
          return this.ctx.effect(() => () => {
            throw new Error('context cleanup exploded')
          }, 'fake.throwing.register')
        }
      }
      new ThrowingResources(h.ctx)
      const wsA = await h.addWorkspace('a')
      h.overrides = { [wsA.id]: { files: true } }
      const agentA = h.spawnAgent('agent-a', wsA.path)
      h.createAgent(agentA)
      h.sync(SERVER, contextCapture(new Map([[TOOL_A, def(TOOL_A)]])))
      await settle()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
      h.overrides = {}
      h.applier.reconcile()
      await settle()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeUndefined()
      // The throwing cleanup stays contained: no unhandled rejection reaches the
      // suite, and the applier keeps serving other facets afterwards.
      h.overrides = { [wsA.id]: { files: true } }
      h.applier.reconcile()
      await settle()
      expect(h.ctx.tools.get(TOOL_A, agentA)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('contains a malformed agent adoption without vetoing agent/created', async () => {
    const h = await mountAgentHarness()
    try {
      const broken = { id: 'agent-broken' } as unknown as Agent
      Object.defineProperty(broken, 'session', {
        get() {
          throw new Error('session exploded')
        },
      })
      h.live.set('agent-broken', broken)
      expect(() => h.createAgent(broken)).not.toThrow()
      expect(h.lines.some((line) => line.level === 'error' && line.message.includes('could not adopt agent agent-broken'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('contains a throwing agent scan and a throwing live-doc source', async () => {
    const ctx = new Context()
    const { factoryCtx } = await mountReal(ctx)
    void factoryCtx
    const lines: LoggedLine[] = []
    const logger = {
      info: (message: string) => void lines.push({ level: 'info', message }),
      warn: (message: string) => void lines.push({ level: 'warn', message }),
      error: (message: string) => void lines.push({ level: 'error', message }),
    }
    const applier = createAgentApplier({
      ctx,
      logger,
      agents: {
        list: () => {
          throw new Error('registry exploded')
        },
        get: () => undefined,
      },
      workspaceRegistry: { list: () => [] },
      overrides: () => {
        throw new Error('doc exploded')
      },
      disabled: () => ({}),
    })
    await settle()
    expect(lines.some((line) => line.level === 'error' && line.message.includes('agent scan failed'))).toBe(true)
    // A capture push whose live-doc read throws is contained to one error line.
    expect(() => applier.syncServerState(SERVER, { epoch: 1, capture: captureOf(new Map([[TOOL_A, def(TOOL_A)]])) })).not.toThrow()
    expect(lines.some((line) => line.level === 'error' && line.message.includes('could not publish server'))).toBe(true)
    applier.dispose()
    await ctx.fiber.dispose()
  })
})
