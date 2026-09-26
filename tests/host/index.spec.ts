/**
 * Entry-shape tests for src/index.ts: namespace-plugin exports exactly
 * `name` / `inject` / `Config` / `apply` (no default export — a default would
 * collapse the namespace through the loader), Config IS the `mcp-scope`
 * document with live (volatile) fields, inject names the services the host
 * half consumes, the entry pins itself to its custom settings page, and the
 * loader's in-place volatile commit reconciles the bridge without a remount.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../../src/index.js'
import { readDocument } from '../../src/schema.js'

// The entry owns the bridge manager; these tests pin the WIRING (route mount,
// auto-page suppression, volatile-update listener), so the manager's network
// side is mocked. `RuntimeActionError` stays real enough for routes.ts.
const managerMock = vi.hoisted(() => ({
  reconcile: vi.fn(),
  dispose: vi.fn(async () => {}),
  /** createManager options, so tests can read the live getDoc wiring. */
  options: [] as unknown[],
}))

vi.mock('../../src/manager.js', () => ({
  createManager: (options: unknown) => {
    managerMock.options.push(options)
    return {
      reconcile: managerMock.reconcile,
      dispose: managerMock.dispose,
      runtimeStatus: () => ({ v: 1, at: 0, servers: [] }),
      toolList: () => undefined,
      connect: async () => ({ ok: false, code: 'unknown', error: 'not connected' }),
      disconnect: async () => ({ ok: false, code: 'unknown', error: 'not connected' }),
      test: async () => ({ ok: false, code: 'unknown', error: 'not connected' }),
    }
  },
  RuntimeActionError: class RuntimeActionError extends Error {},
}))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface BuildOptions {
  connection?: boolean
  settings?: boolean
}

interface Built {
  ctx: Context
  routes: string[]
  configureCalls: unknown[][]
}

/** A host context with the services the entry consumes (Settings optional). */
function build(options: BuildOptions = {}): Built {
  const ctx = new Context()
  const routes: string[] = []
  const configureCalls: unknown[][] = []
  if (options.settings !== false) {
    ctx.provide('settings', {
      configure: (...args: unknown[]) => {
        configureCalls.push(args)
        return () => {}
      },
    } as never)
  }
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('tools', {} as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('agents', { roots: () => [], get: () => undefined } as never)
  if (options.connection !== false) {
    ctx.provide('connection', {
      fetch: {
        register: (route: { path: string }) => {
          routes.push(route.path)
          return async () => {}
        },
      },
    } as never)
  }
  return { ctx, routes, configureCalls }
}

describe('plugin entry shape', () => {
  it('exports exactly the namespace-plugin contract', () => {
    expect(entry.name).toBe('mcp-scope')
    expect(entry.inject).toEqual(['credentials', 'tools', 'workspaceRegistry', 'agents'])
    expect(typeof entry.apply).toBe('function')
    expect(entry.Config).toBeDefined()
    expect((entry as { default?: unknown }).default).toBeUndefined()
    expect(Object.keys(entry).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })

  it('Config resolves the mcp-scope document with live volatile fields', () => {
    const resolved = entry.Config({} as never)
    expect(readDocument(resolved)).toEqual({ servers: [], overrides: {}, disabled: {} })
    // The resolved fields are references: a settings write swaps their contents
    // in place (loader/volatile-update) instead of remounting the plugin.
    expect(typeof (resolved.servers as { get?: unknown }).get).toBe('function')
    expect(typeof (resolved.overrides as { get?: unknown }).get).toBe('function')
    expect(typeof (resolved.disabled as { get?: unknown }).get).toBe('function')
  })

  it('mounts the runtime routes and pins the entry to its custom settings page', async () => {
    const { ctx, routes, configureCalls } = build()
    const fiber = await ctx.plugin(entry)
    // The route mount and the settings child run behind nested inject
    // activations: poll for them instead of sleeping a fixed delay (which
    // flakes red under load and can pass vacuously on a fast machine).
    for (let attempt = 0; attempt < 200 && (routes.length < 3 || configureCalls.length < 1); attempt += 1) {
      await sleep(5)
    }
    expect(routes.sort()).toEqual([
      '/api/mcp-scope.action',
      '/api/mcp-scope.status',
      '/api/mcp-scope.tools',
    ])
    // { auto: false } suppresses the schema-derived form so the custom
    // settings.section page stays the entry's only editor; the second argument
    // is the owning plugin fiber.
    expect(configureCalls[0]?.[0]).toEqual({ auto: false })
    // The owner is the plugin's own fiber (it outlives the optional settings
    // child), not the settings service.
    expect(configureCalls[0]?.[1]).toBe(fiber)
  })

  it('starts configured servers at activation, then follows each in-place commit', async () => {
    const { ctx } = build()
    managerMock.reconcile.mockClear()
    managerMock.options.length = 0
    await ctx.plugin(entry, {
      servers: [{ serverName: 'boot', transport: 'stdio', command: 'node' }],
    } as never)
    // The loader applies an entry's Config by CREATING its fiber and only emits
    // loader/volatile-update for an in-place commit, so this activation pass is
    // the only thing that starts a server already configured in the profile
    // patch (boot, profile reload, HMR).
    expect(managerMock.reconcile).toHaveBeenCalledTimes(1)
    const options = managerMock.options.at(-1) as { getDoc: () => { servers: { serverName?: string }[] } }
    expect(options.getDoc().servers.map((server) => server.serverName)).toEqual(['boot'])
    // A volatile commit adds exactly one pass for the same activation.
    ctx.emit('loader/volatile-update', [['servers']])
    expect(managerMock.reconcile).toHaveBeenCalledTimes(2)
  })

  it('runs without Settings (optional child) and without a Connection carrier', async () => {
    const { ctx, routes } = build({ settings: false, connection: false })
    await ctx.plugin(entry)
    await sleep(10)
    expect(routes).toEqual([])
    managerMock.reconcile.mockClear()
    ctx.emit('loader/volatile-update', [['disabled']])
    expect(managerMock.reconcile).toHaveBeenCalledTimes(1)
  })

  // Alpha contract note for plugin authors: the runtime resolves packages at
  // load time and can UNLOAD a row again, so an activation must be reversible
  // and repeatable. src/index.ts owns everything through `ctx.effect` and keeps
  // a per-root reservation in a WeakSet — these two cases pin that discipline
  // (a leaked reservation would make the second mount throw, and a missing
  // guard would let a duplicate activation shadow the first silently).
  it('is effect-owned: disposing the activation releases the root, and the same root activates again', async () => {
    const { ctx } = build()
    const first = await ctx.plugin(entry)
    await first.dispose()
    const second = await ctx.plugin(entry)
    await second.dispose()
  })

  it('refuses a duplicate concurrent activation on the same root, loudly', async () => {
    const { ctx } = build()
    const first = await ctx.plugin(entry)
    await expect(ctx.plugin(entry)).rejects.toThrow(/already active/)
    await first.dispose()
  })
})
