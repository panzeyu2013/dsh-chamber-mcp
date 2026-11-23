/**
 * On-demand admission matrix for the per-agent applier (ADR-1.3 / I2 / I3 / I4):
 * the ONLY path a loaded tool may enter an agent scope, plus the generation
 * bookkeeping that keeps a disabled server re-enableable.
 *
 * REAL ToolRuntime + real dsh-scope agent scopes + the production applier; no
 * MCP connection is needed because admission is completely synchronous.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  AgentHarness,
  captureOf,
  descriptorEvent,
  mountAgentHarness,
  toolDef,
} from '../support/agent-kit.js'

const SERVER = 'files'
const TOOL_A = 'mcp__files__read_file'
const TOOL_B = 'mcp__files__write_file'
const LOADER = 'mcp__files__load_tools'
/** A name the on-demand loader constructs later; it never enters the capture. */
const LOADED = 'mcp__files__remote_read'

function capture(tools: ToolDefinition[], version = 1, extra: { truncated?: boolean } = {}) {
  return captureOf(tools, { version, ...extra })
}

/** Boot a harness with one workspace enabling the server. */
async function bootEnabled(): Promise<{
  h: AgentHarness
  ws: { id: string; path: string }
  agent: Agent
}> {
  const h = await mountAgentHarness()
  const ws = await h.addWorkspace('a')
  const agent = h.spawnAgent('agent-a', ws.path)
  h.overrides = { [ws.id]: { [SERVER]: true } }
  h.createAgent(agent)
  return { h, ws, agent }
}

describe('applier fan-out and on-demand admission', () => {
  it('applies a capture set once; the same (epoch, version) is idempotent', async () => {
    const { h, agent } = await bootEnabled()
    try {
      const first = toolDef(TOOL_A, 'v1')
      h.push(SERVER, 1, new Map([[TOOL_A, first]]))
      expect(h.ctx.tools.get(TOOL_A, agent)).toBe(first)
      const lines = h.lines.length
      // Same generation with a different definition object: no re-registration.
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A, 'v1-dup')]]))
      expect(h.ctx.tools.get(TOOL_A, agent)).toBe(first)
      expect(h.lines.length).toBe(lines)
    } finally {
      h.cleanup()
    }
  })

  it('ignores a stale epoch/version push after a remount', async () => {
    const { h, agent } = await bootEnabled()
    try {
      h.sync(SERVER, capture([toolDef(TOOL_A, 'old')]), 1)
      const current = toolDef(TOOL_A, 'new')
      h.sync(SERVER, capture([current], 1), 2)
      expect(h.ctx.tools.get(TOOL_A, agent)).toBe(current)
      // A late notification from the superseded instance must never resurrect
      // the old generation: lower epoch and same-epoch lower version are floored.
      h.sync(SERVER, capture([toolDef(TOOL_A, 'stale-old'), toolDef(TOOL_B)], 9), 1)
      h.sync(SERVER, capture([toolDef(TOOL_A, 'stale-version')], 0), 2)
      expect(h.ctx.tools.get(TOOL_A, agent)).toBe(current)
      expect(h.ctx.tools.get(TOOL_B, agent)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('admits a loaded tool for an enabled agent and its disposer removes exactly that name', async () => {
    const { h, agent } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      const loaded = toolDef(LOADED)
      const dispose = h.admit(agent, loaded)
      expect(h.ctx.tools.get(LOADED, agent)).toBe(loaded)
      // Invariant 2: the loaded definition is agent-scoped only.
      expect(h.ctx.tools.get(LOADED)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeDefined()
      dispose()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      // Exactly the loaded name: the eager generation is untouched.
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeDefined()
      dispose() // idempotent
    } finally {
      h.cleanup()
    }
  })

  it('refuses admission when the workspace never enabled the server (default OFF)', async () => {
    const h = await mountAgentHarness()
    try {
      const ws = await h.addWorkspace('a')
      const agent = h.spawnAgent('agent-a', ws.path)
      h.createAgent(agent)
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)]]))
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeUndefined()
      expect(() => h.admit(agent, toolDef(LOADED))).toThrow(/is not enabled for this agent/)
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('refuses a loaded name outside a subagent allow list and a deny list', async () => {
    const h = await mountAgentHarness()
    try {
      const ws = await h.addWorkspace('a')
      h.overrides = { [ws.id]: { [SERVER]: true } }
      // Allow list admits one capture name (the server is not withheld), but
      // never the lazily-constructed loaded name.
      const allowed = h.spawnAgent('agent-allow', ws.path, 'subagent', {
        events: [descriptorEvent({ allow: [TOOL_A] })],
      })
      const denied = h.spawnAgent('agent-deny', ws.path, 'subagent', {
        events: [descriptorEvent({ deny: [LOADED] })],
      })
      h.createAgent(allowed)
      h.createAgent(denied)
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [TOOL_B, toolDef(TOOL_B)], [LOADER, toolDef(LOADER)]]))
      expect(h.ctx.tools.get(TOOL_A, allowed)).toBeDefined()
      expect(() => h.admit(allowed, toolDef(LOADED))).toThrow(/is not permitted for this agent/)
      // A deny list keeps every non-denied name loadable but refuses the denied one.
      expect(h.ctx.tools.get(TOOL_A, denied)).toBeDefined()
      expect(() => h.admit(denied, toolDef(LOADED))).toThrow(/is not permitted for this agent/)
      const other = toolDef('mcp__files__remote_other')
      h.admit(denied, other)
      expect(h.ctx.tools.get(other.name, denied)).toBe(other)
    } finally {
      h.cleanup()
    }
  })

  it('re-registers a loaded tool on re-enable when the capture generation is unchanged', async () => {
    const { h, agent, ws } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))
      expect(h.ctx.tools.get(LOADED, agent)).toBeDefined()

      // Gate close: model-visible revocation, the record survives.
      h.overrides = {}
      h.applier.reconcile()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()

      // Re-enable with the SAME (epoch, version): restore the registration so the
      // upstream loader's "already loaded" bookkeeping stays coherent.
      h.overrides = { [ws.id]: { [SERVER]: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(LOADED, agent)).toBeDefined()
      expect(h.ctx.tools.get(LOADED)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('forgets loaded records when the capture generation changed while disabled', async () => {
    const { h, agent, ws } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))
      h.overrides = {}
      h.applier.reconcile()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()

      // Upstream prunes its loaded bookkeeping across a generation while the
      // gate is off; our records must not resurrect an invisible name.
      h.push(SERVER, 2, new Map([[TOOL_A, toolDef(TOOL_A)] , [LOADER, toolDef(LOADER)]]))
      h.overrides = { [ws.id]: { [SERVER]: true } }
      h.applier.reconcile()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('revokes admitted names on workspace loss, server removal and plugin teardown', async () => {
    const { h, agent, ws } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))

      // 1. Workspace disappears from the registry.
      h.workspaces = []
      h.applier.reconcile()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeUndefined()

      // 2. Server removal (the workspace comes back, so the pair is enabled again).
      h.workspaces = [ws]
      h.overrides = { [ws.id]: { [SERVER]: true } }
      h.push(SERVER, 2, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))
      expect(h.ctx.tools.get(LOADED, agent)).toBeDefined()
      h.remove(SERVER)
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeUndefined()

      // 3. Plugin teardown.
      h.push(SERVER, 3, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))
      h.applier.dispose()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      expect(h.ctx.tools.get(TOOL_A, agent)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('fails closed for a non-live or undiscovered agent scope', async () => {
    const { h, agent } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)]]))
      // agent/disposed drops bookkeeping: admission must refuse, not register.
      h.disposeAgent(agent)
      expect(() => h.admit(agent, toolDef(LOADED))).toThrow(/could not be loaded/)
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      // A forged Agent that the applier never adopted is refused the same way.
      const forged = { id: 'agent-forged', session: { header: { cwd: '/' } } } as unknown as Agent
      expect(() => h.admit(forged, toolDef(LOADED))).toThrow(/could not be loaded/)
      // A definition attributable to no tracked server cannot be admitted.
      expect(() => h.admit(agent, toolDef('mcp__ghost__x'))).toThrow(/could not be loaded/)
    } finally {
      h.cleanup()
    }
  })

  it('never lands an admitted or loader name in the global layer', async () => {
    const { h, agent } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      h.admit(agent, toolDef(LOADED))
      for (const name of [TOOL_A, LOADER, LOADED]) {
        expect(h.ctx.tools.get(name), name + ' must never be global').toBeUndefined()
      }
      expect(h.ctx.tools.schemas().some((schema) => schema.name.startsWith('mcp__files__'))).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('refuses admission when the server capture was never published to this agent', async () => {
    const { h } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)]]))
      // A second agent in a workspace with no enable record: the server is not
      // published there, so a load from that scope fails closed.
      const wsB = await h.addWorkspace('b')
      const agentB = h.spawnAgent('agent-b', wsB.path)
      h.createAgent(agentB)
      expect(() => h.admit(agentB, toolDef(LOADED))).toThrow(/is not enabled for this agent/)
      expect(h.ctx.tools.get(LOADED, agentB)).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })
})

describe('loaded-name bookkeeping edge paths', () => {
  it('re-loading an already loaded name revokes the previous registration and retries once', async () => {
    const { h, agent } = await bootEnabled()
    try {
      h.push(SERVER, 1, new Map([[TOOL_A, toolDef(TOOL_A)], [LOADER, toolDef(LOADER)]]))
      const first = h.admit(agent, toolDef(LOADED))
      const firstDefinition = h.ctx.tools.get(LOADED, agent)
      expect(firstDefinition).toBeDefined()
      // A second load of the same public name must not wedge on the duplicate:
      // the stale registration is revoked and the new definition registered.
      const replacement = toolDef(LOADED, 'reloaded')
      const second = h.admit(agent, replacement)
      expect(h.ctx.tools.get(LOADED, agent)).toBe(replacement)
      // Both stable tokens remain coherent: disposing the first retires the name.
      first()
      expect(h.ctx.tools.get(LOADED, agent)).toBeUndefined()
      second()
    } finally {
      h.cleanup()
    }
  })
})
