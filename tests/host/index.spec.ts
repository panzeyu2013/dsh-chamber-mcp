/**
 * Entry-shape tests for src/index.ts: namespace-plugin exports exactly
 * `name` / `inject` / `Config` / `apply` (no default export — a default would
 * collapse the namespace through the loader), Config is the empty object
 * schema, and inject names the services the host half consumes.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../../src/index.js'
import z from '@deepseek-ai/schemastery'

describe('plugin entry shape', () => {
  it('exports exactly the namespace-plugin contract', () => {
    expect(entry.name).toBe('mcp-scope')
    expect(entry.inject).toEqual(['settings', 'credentials', 'tools', 'workspaceRegistry', 'agents'])
    expect(typeof entry.apply).toBe('function')
    expect(entry.Config).toBeDefined()
    expect((entry as { default?: unknown }).default).toBeUndefined()
    expect(Object.keys(entry).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })

  it('Config is the empty-object schema (no composition surface)', () => {
    const schema = entry.Config as unknown as z<object>
    expect(schema({})).toEqual({})
  })

  it('apply installs the namespace and mounts the runtime routes when connection exists', async () => {
    const ctx = new Context()
    const routes: string[] = []
    let installedNs: unknown
    ctx.provide('settings', {
      installSection: (_owner: unknown, ns: string) => {
        installedNs = ns
      },
    } as never)
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('tools', {} as never)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('agents', { roots: () => [], get: () => undefined } as never)
    ctx.provide('connection', {
      fetch: {
        register: (route: { path: string }) => {
          routes.push(route.path)
          return async () => {}
        },
      },
    } as never)
    await ctx.plugin(entry)
    // The route mount runs behind the plugin's nested inject activation: poll
    // for it instead of sleeping a fixed 30 ms (which flakes red under load and
    // can pass vacuously on a fast machine).
    for (let attempt = 0; attempt < 200 && routes.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(installedNs).toBe('mcp-scope')
    expect(routes.sort()).toEqual([
      '/api/mcp-scope.action',
      '/api/mcp-scope.status',
      '/api/mcp-scope.tools',
    ])
  })
})
