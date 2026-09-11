/**
 * Settings-namespace integration tests: registers the REAL `mcp-scope`
 * DocumentSchema (src/schema.ts) with a REAL dsh-settings provider
 * (`FileSettingsProvider` from @deepseek-ai/dsh-settings-file) writing to a
 * temp YAML document, exactly the way the plugin entry mounts it
 * (`ctx.settings.installSection` + setSource/onChange/validate hooks).
 *
 * Asserts: hooks fire on namespace writes; the validate hook rejects a
 * duplicate-serverName write host-side; resolved documents merge schema
 * defaults; the user layer persists to the document file; and — with the
 * watcher on, as in a real deployment — a hand-written document is loaded at
 * boot, an external edit is published live, and an edit that violates the
 * cross-field rules is NOT published (the running instance keeps the last good
 * document, per the provider's "boot fails loud, reload keeps last good" rule).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Boot the real provider over a temp document. `watch` stays off for the
 * deterministic write tests and is turned on only by the hot-reload test
 * (watching is the deployment default; off keeps the other tests free of
 * watcher timing).
 */
async function boot(path: string, options: { watch?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, { path, watch: options.watch ?? false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `condition` holds (watcher settle is debounce + fs event). */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A hand-written document: the shape a user edits outside the UI. */
const HAND_WRITTEN = `# hand-written document
mcp-scope:
  servers:
    - serverName: byhand
      transport: stdio
      command: node
      args: [server.js]
      cwd: ""
      envKeys: [HAND_TOKEN]
  overrides:
    ws-b:
      byhand: true
`

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

  it('loads a hand-written document at boot, hot-reloads external edits, and refuses an invalid one', async () => {
    const path = await tempDocPath()
    writeFileSync(path, HAND_WRITTEN)
    const ctx = await boot(path, { watch: true })
    let currentSource: () => McpScopeDoc = () => EMPTY_DOC
    let changes = 0
    installNamespace(ctx, {
      setSource: (source) => {
        currentSource = source
      },
      onChange: () => {
        changes += 1
      },
    })

    // Boot load: the document that was on disk is the resolved document.
    expect(currentSource().servers.map((s) => s.serverName)).toEqual(['byhand'])
    expect(currentSource().overrides).toEqual({ 'ws-b': { byhand: true } })

    // External edit while the instance runs: published without a restart.
    const beforeEdit = changes
    writeFileSync(path, HAND_WRITTEN.replace('byhand', 'renamed').replace('    ws-b:\n      byhand: true', '    ws-b: {}'))
    await waitUntil(() => changes > beforeEdit, 'external edit to be published')
    expect(currentSource().servers.map((s) => s.serverName)).toEqual(['renamed'])
    expect(currentSource().overrides).toEqual({ 'ws-b': {} })

    // A service write is a leaf-level YAML diff: the hand-written comment and
    // the untouched nodes survive.
    await ctx.settings.update('mcp-scope', {
      servers: [
        ...currentSource().servers,
        { serverName: 'fromui', transport: 'streamable-http', url: 'https://mcp.example.test/x' },
      ],
      overrides: currentSource().overrides,
    })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# hand-written document')
    expect(text).toContain('fromui')
    expect(text).toContain('streamable-http')

    // An external edit that breaks a cross-field rule (duplicate serverName) is
    // NOT published: the running instance keeps the last good document.
    const beforeInvalid = changes
    const lastGood = currentSource()
    writeFileSync(path, `mcp-scope:\n  servers:\n    - {serverName: dup, transport: stdio, command: node}\n    - {serverName: dup, transport: stdio, command: node}\n`)
    await sleep(600)
    expect(changes).toBe(beforeInvalid)
    expect(currentSource()).toEqual(lastGood)
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
