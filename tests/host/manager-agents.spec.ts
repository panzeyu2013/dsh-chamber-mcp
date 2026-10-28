/**
 * The manager -> applier -> ToolRuntime seam, over a REAL manager, a real
 * supervisor, a real stdio fixture and a real dsh-scope agent scope.
 *
 * manager.spec.ts gives its manager empty agent/workspace registries, so the
 * push/revoke/epoch calls are unobservable there; agents.spec.ts drives the
 * applier with synthetic pushes. This file joins both halves and asserts the
 * tool actually appears in an enabled agent scope, disappears on disable, is
 * re-pushed after a restart, and never lands in the global layer.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createManager, type ManagerHandle } from '../../src/manager.ts'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.ts'
import { waitFor } from '../support/wait.ts'

const fixtureServer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixture',
  'mcp-fixture-server.mjs',
)

const fixtureDef = (extra: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {}): ServerDef => ({
  serverName: 'fix',
  transport: 'stdio',
  command: process.execPath,
  args: [fixtureServer],
  cwd: '',
  envKeys: [],
  ...extra,
})

const TOOL = 'mcp__fix__add'

describe('manager -> applier -> ToolRuntime (real services)', () => {
  it('pushes a committed generation into the enabled agent scope, revokes on disable, and re-pushes after restart or workspace re-add', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    let factoryCtx!: Context
    const factoryPlugin = function agentFactory(c: Context) {
      factoryCtx = c
    }
    factoryPlugin.inject = ['tools']
    await ctx.plugin(factoryPlugin)

    const work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-scope-manager-agents-')))
    const agent = {
      id: 'agent-joint',
      session: { header: { cwd: work } },
    } as unknown as Agent
    const scope = createScope(factoryCtx, agent as never)
    ;(agent as unknown as { ctx: Context }).ctx = scope.ctx

    ctx.provide('agents', {
      roots: () => [agent],
      list: () => [agent],
      get: (id: string) => (id === agent.id ? agent : undefined),
    } as never)
    let workspaces = [{ id: 'ws-joint', path: work }]
    ctx.provide('workspaceRegistry', {
      list: () => workspaces,
    } as never)

    let doc: McpScopeDoc = {
      servers: [fixtureDef()],
      overrides: { 'ws-joint': { fix: true } },
    }
    let manager!: ManagerHandle
    const managerHost = function managerHost(c: Context) {
      manager = createManager({
        ctx: c,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        getDoc: () => doc,
        credentials: { resolve: async () => undefined },
        reconnect: { enabled: false },
      })
    }
    managerHost.inject = ['agents', 'workspaceRegistry']
    await ctx.plugin(managerHost)

    try {
      manager.reconcile()
      await waitFor(
        () => manager.runtimeStatus().servers.some((server) => server.name === 'fix' && server.state === 'connected'),
        'manager to connect the real stdio fixture',
      )
      await waitFor(() => ctx.tools.get(TOOL, agent) !== undefined, 'manager push to reach the agent scope')
      // The same definition exists only in the agent scope, never globally.
      expect(ctx.tools.get(TOOL)).toBeUndefined()
      expect(manager.runtimeStatus().servers[0]?.toolCount).toBeGreaterThan(0)

      // Disable the pair: the applier must revoke the registration.
      doc = { servers: [fixtureDef()], overrides: {} }
      manager.reconcile()
      await waitFor(() => ctx.tools.get(TOOL, agent) === undefined, 'disable to revoke the scoped tool')
      expect(ctx.tools.get(TOOL)).toBeUndefined()

      // Re-enable: the retained server state is re-applied without a restart.
      doc = { servers: [fixtureDef()], overrides: { 'ws-joint': { fix: true } } }
      manager.reconcile()
      await waitFor(() => ctx.tools.get(TOOL, agent) !== undefined, 're-enable to re-register the tool')

      // A workspace-domain change re-judges membership without a manager
      // reconcile: removing the workspace revokes, re-adding re-applies.
      workspaces = []
      ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces' } as never)
      await waitFor(() => ctx.tools.get(TOOL, agent) === undefined, 'workspace removal to revoke the scoped tool')
      workspaces = [{ id: 'ws-joint', path: work }]
      ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces' } as never)
      await waitFor(() => ctx.tools.get(TOOL, agent) !== undefined, 'workspace re-add to re-register the tool')

      // A definition change restarts the supervisor under a NEW epoch; its
      // first committed generation must reach the live agent scope again.
      doc = {
        servers: [fixtureDef({ timeoutMs: 120_000 })],
        overrides: { 'ws-joint': { fix: true } },
      }
      manager.reconcile()
      await waitFor(
        () => manager.runtimeStatus().servers.some((server) => server.name === 'fix' && server.state === 'connected'),
        'manager restart to reconnect',
      )
      await waitFor(() => ctx.tools.get(TOOL, agent) !== undefined, 'restarted generation to reach the agent scope')
      expect(ctx.tools.get(TOOL)).toBeUndefined()

      // Removing the server stops the supervisor and revokes the scope entry.
      doc = { servers: [], overrides: {} }
      manager.reconcile()
      await waitFor(() => ctx.tools.get(TOOL, agent) === undefined, 'removal to revoke the scoped tool')
      expect(ctx.tools.get(TOOL)).toBeUndefined()
    } finally {
      await manager.dispose()
      await scope.dispose()
      rmSync(work, { recursive: true, force: true })
    }
  }, 20_000)
})
