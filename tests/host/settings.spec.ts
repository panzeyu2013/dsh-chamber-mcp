/**
 * Settings-namespace integration tests: registers the REAL `mcp-scope`
 * DocumentSchema (src/schema.ts) with a REAL dsh-settings provider
 * (`FileSettingsProvider` from @deepseek-ai/dsh-settings-file) writing to a
 * temp YAML document, exactly the way the plugin entry mounts it
 * (`ctx.settings.installSection` + setSource/onChange/validate hooks).
 *
 * Asserts: hooks fire on namespace writes; the validate hook rejects a
 * duplicate-serverName write host-side; resolved documents merge schema
 * defaults; the user layer persists to the document file.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { DocumentSchema } from '../../src/schema.js'
import { EMPTY_DOC, validateDoc, type McpScopeDoc } from '../../src/shared/model.js'

const cleanups: Array<() => Promise<void>> = []

async function tempDocPath(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-scope-settings-'))
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'settings.yaml')
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, { path, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Mirror of the plugin entry's installSection wiring (same validate hook). */
function installNamespace(ctx: Context, hooks: {
  setSource(source: () => McpScopeDoc): void
  onChange(): void
  validate?: (doc: McpScopeDoc) => void
}): void {
  ctx.settings.installSection(ctx, 'mcp-scope', DocumentSchema, EMPTY_DOC, {
    setSource: hooks.setSource,
    onChange: hooks.onChange,
    validate: hooks.validate ?? ((doc) => {
      const errors = validateDoc(doc)
      if (errors.length > 0) throw new Error(`mcp-scope: refusing document write: ${errors.join('; ')}`)
    }),
  })
}

describe('mcp-scope settings namespace (real file-backed provider)', () => {
  it('fires setSource/onChange on attach and on every accepted write', async () => {
    const path = await tempDocPath()
    const ctx = await boot(path)
    let currentSource: () => McpScopeDoc = () => EMPTY_DOC
    let sourceCalls = 0
    let changes = 0
    installNamespace(ctx, {
      setSource: (source) => {
        sourceCalls += 1
        currentSource = source
      },
      onChange: () => {
        changes += 1
      },
    })
    // Attach: setSource before onChange; doc = schema defaults.
    expect(sourceCalls).toBe(1)
    expect(changes).toBe(1)
    expect(currentSource()).toEqual({ servers: [], overrides: {} })

    await ctx.settings.update('mcp-scope', {
      servers: [
        { serverName: 'files', transport: 'stdio', command: '/usr/bin/files' },
      ],
      overrides: {},
    })
    expect(changes).toBe(2)
    // Schema defaults merged into the resolved doc.
    expect(currentSource().servers).toEqual([
      { serverName: 'files', transport: 'stdio', command: '/usr/bin/files', args: [], cwd: '', envKeys: [] },
    ])

    // Overrides writes land too (dict-of-dicts of true).
    await ctx.settings.mutate('mcp-scope', [{ op: 'set', path: ['overrides', 'ws-b', 'files'], value: true }])
    expect(currentSource().overrides).toEqual({ 'ws-b': { files: true } })
    expect(changes).toBe(3)
  })

  it('refuses a duplicate-serverName write host-side via the validate hook', async () => {
    const path = await tempDocPath()
    const ctx = await boot(path)
    installNamespace(ctx, { setSource: () => {}, onChange: () => {} })
    await expect(ctx.settings.update('mcp-scope', {
      servers: [
        { serverName: 'dup', transport: 'stdio', command: 'a' },
        { serverName: 'dup', transport: 'stdio', command: 'b' },
      ],
    })).rejects.toThrow(/duplicate serverName/)
    // Rejected writes leave the stored user section untouched.
    const descriptor = ctx.settings.describe().find((d) => d.ns === 'mcp-scope')!
    expect((descriptor.user as { servers?: unknown } | undefined)?.servers ?? []).toEqual([])
  })

  it('rejects schema-invalid serverNames and empty commands before persisting', async () => {
    const path = await tempDocPath()
    const ctx = await boot(path)
    installNamespace(ctx, { setSource: () => {}, onChange: () => {} })
    await expect(ctx.settings.update('mcp-scope', {
      servers: [{ serverName: 'bad name!', transport: 'stdio', command: 'x' }],
    })).rejects.toThrow()
    await expect(ctx.settings.update('mcp-scope', {
      servers: [{ serverName: 'ok', transport: 'stdio', command: '' }],
    })).rejects.toThrow()
  })

  it('persists the user layer into the settings.yaml document', async () => {
    const path = await tempDocPath()
    const ctx = await boot(path)
    installNamespace(ctx, { setSource: () => {}, onChange: () => {} })
    await ctx.settings.update('mcp-scope', {
      servers: [
        { serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.com/x' },
      ],
      overrides: {},
    })
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/mcp-scope:/)
    expect(text).toMatch(/github/)
    expect(text).toMatch(/streamable-http/)
  })

  it('resolves defaults below the user layer and reports revision bumps', async () => {
    const path = await tempDocPath()
    const ctx = await boot(path)
    installNamespace(ctx, { setSource: () => {}, onChange: () => {} })
    const before = ctx.settings.describe().find((d) => d.ns === 'mcp-scope')!
    expect(before.revision).toBe(0)
    await ctx.settings.update('mcp-scope', {
      servers: [{ serverName: 'fs', transport: 'stdio', command: '/bin/fs', envKeys: ['FS_TOKEN'] }],
    })
    const after = ctx.settings.describe().find((d) => d.ns === 'mcp-scope')!
    expect(after.revision).toBe(1)
    const value = after.value as McpScopeDoc
    expect(value.servers).toEqual([
      { serverName: 'fs', transport: 'stdio', command: '/bin/fs', args: [], cwd: '', envKeys: ['FS_TOKEN'] },
    ])
  })
})
