/**
 * Unit tests of the capture-only facades (src/facade.ts): cordis isolation,
 * the single store-level seat effect (capture lifetime), fail-closed visibility, admission delegation,
 * the truncation flag, credential CR/LF/NUL rejection and the per-agent
 * context replay. The REAL dsh-tools ToolRuntime is mounted and used
 * for agent-scope admission; everything else is a fake applier hook, so no
 * upstream MCP connection is needed.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mountReal } from '../support/mount-real.ts'
import {
  CaptureStore,
  FALLBACK_SECTION_ORDER,
  InvalidCredentialValueError,
  SeamMismatchError,
  createFacades,
  replayCapturedContext,
  type CaptureSnapshot,
  type FacadeHooks,
  type FacadeSet,
} from '../../src/facade.ts'

/** In-memory real credential provider (the façade's constructor-injected dependency). */
class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()
  readonly records = new Map<string, CredentialRecord>()
  readonly calls = {
    resolve: 0, describe: 0, set: 0, unset: 0, readRecord: 0,
    describeRecord: 0, listRecords: 0, modifyRecord: 0, deleteRecord: 0,
  }

  constructor(ctx: Context) {
    super(ctx)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.calls.resolve += 1
    const value = this.values.get(String(ref))
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    this.calls.describe += 1
    const value = this.values.get(String(ref))
    if (value === undefined) return { configured: false, writable: true }
    return { configured: true, source: 'test', writable: true, masked: value }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.calls.set += 1
    this.values.set(String(ref), value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.calls.unset += 1
    this.values.delete(String(ref))
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.calls.readRecord += 1
    return this.records.get(String(key))
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    this.calls.describeRecord += 1
    return { configured: this.records.has(String(key)), writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    this.calls.listRecords += 1
    return [...this.records.entries()].map(([key, record]) => ({ key: key as CredentialKey, kind: record.kind }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.calls.modifyRecord += 1
    const next = await mutate(this.records.get(String(key)))
    if (next !== undefined) this.records.set(String(key), next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.calls.deleteRecord += 1
    this.records.delete(String(key))
  }
}

/** A minimal but complete tool definition (never registered for real by capture). */
function tool(name: string, description = 'description'): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
}

/** A prompt section with sensible defaults. */
function promptSection(overrides: Partial<PromptSection> & { name: string; order: number }): PromptSection {
  return { text: 'literal', ...overrides }
}

/** A minimal resource provider. */
function resourceProvider(): McpResourceProvider {
  return { request: async () => ({}) }
}

/** A capture snapshot for replay tests. */
function snapshot(overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return { tools: new Map(), sections: [], resources: new Map(), truncated: false, version: 1, ...overrides }
}

/** Cordis activates injected child fibers off the current tick; let them land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

interface Built {
  readonly root: Context
  readonly factoryCtx: Context
  readonly credentials: MemoryCredentials
  readonly seatCtx: Context
  readonly facades: FacadeSet
  readonly changes: CaptureSnapshot[]
  readonly hooks: FacadeHooks
  /** Disposes the seat fiber; the store-level capture effect must clear everything. */
  disposeSeat(): Promise<void>
}

/** Build a real-service root, a memory credential provider and an isolated seat. */
async function build(options: Partial<FacadeHooks> = {}): Promise<Built> {
  const root = new Context()
  const { factoryCtx } = await mountReal(root)
  const credentials = new MemoryCredentials(root)
  const changes: CaptureSnapshot[] = []
  const hooks: FacadeHooks = {
    serverName: 'srv',
    credentials,
    onCaptureChanged: (peek) => changes.push(peek()),
    ...options,
  }
  let seatCtx!: Context
  let facades!: FacadeSet
  const seatPlugin = (ctx: Context): void => {
    seatCtx = ctx.isolate('tools').isolate('systemPrompt').isolate('mcpResources').isolate('credentials')
    facades = createFacades(seatCtx, hooks)
  }
  const seatFiber = await root.plugin(seatPlugin)
  return { root, factoryCtx, credentials, seatCtx, facades, changes, hooks, disposeSeat: () => seatFiber.dispose() }
}

/** A disposable caller context; every effect it owns dies on dispose(). */
interface Caller {
  readonly ctx: Context
  dispose(): Promise<void>
}

async function openCaller(parent: Context): Promise<Caller> {
  let ctx!: Context
  const fiber = await parent.plugin((child: Context) => { ctx = child })
  return { ctx, dispose: () => fiber.dispose() }
}

/** Fake agent identity used as a scope key. */
function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('facade: tool capture', () => {
  it('captures server-global definitions and never touches the real layer', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    const definition = tool('mcp__srv__add')
    const dispose = caller.ctx.tools.register(definition)

    expect(built.facades.snapshot().tools.get(definition.name)).toBe(definition)
    expect(built.facades.snapshot().version).toBe(1)
    expect(built.changes).toHaveLength(1)
    expect(built.changes[0]?.tools.size).toBe(1)
    // Invariant 2: nothing reached the real global ToolRuntime.
    expect(built.factoryCtx.tools.get(definition.name)).toBeUndefined()

    const version = built.facades.snapshot().version
    dispose()
    expect(built.facades.snapshot().tools.size).toBe(0)
    expect(built.facades.snapshot().version).toBe(version + 1)
    dispose()
    expect(built.facades.snapshot().version).toBe(version + 1)
    await caller.dispose()
  })

  it('refuses a duplicate live public name', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    const definition = tool('mcp__srv__add')
    caller.ctx.tools.register(definition)
    expect(() => caller.ctx.tools.register(definition)).toThrow(/captured twice/)
    await caller.dispose()
  })

  it('keeps captures until the seat fiber unloads (store-level effect ownership)', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    caller.ctx.tools.register(tool('mcp__srv__add'))
    caller.ctx.systemPrompt.section(promptSection({ name: 'mcp:srv', order: 3100 }))
    caller.ctx.mcpResources.register('srv', resourceProvider())
    expect(built.facades.snapshot().tools.size).toBe(1)
    expect(built.facades.snapshot().sections).toHaveLength(1)
    expect(built.facades.snapshot().resources.size).toBe(1)

    await caller.dispose()
    // One effect owns the whole capture set: a registering child fiber ending
    // must not drop what the mounted instance still publishes.
    expect(built.facades.snapshot().tools.size).toBe(1)
    expect(built.facades.snapshot().sections).toHaveLength(1)
    expect(built.facades.snapshot().resources.size).toBe(1)
    await built.disposeSeat()
    expect(built.facades.snapshot().tools.size).toBe(0)
    expect(built.facades.snapshot().sections).toHaveLength(0)
    expect(built.facades.snapshot().resources.size).toBe(0)
  })

  it('trims at the cap, flags truncated and stays quiet on further entries', async () => {
    const built = await build({ maxSyncTools: 2 })
    const caller = await openCaller(built.seatCtx)
    caller.ctx.tools.register(tool('t1'))
    caller.ctx.tools.register(tool('t2'))
    const changesBefore = built.changes.length
    const disposer = caller.ctx.tools.register(tool('t3'))
    const current = built.facades.snapshot()
    expect(current.tools.size).toBe(2)
    expect(current.truncated).toBe(true)
    expect(built.changes.length).toBe(changesBefore + 1)
    // Registrations beyond the cap return a harmless disposer and do not notify again.
    disposer()
    caller.ctx.tools.register(tool('t4'))
    expect(built.facades.snapshot().tools.size).toBe(2)
    expect(built.changes.length).toBe(changesBefore + 1)
    await caller.dispose()
  })

  it('closes the truncation window when the generation empties and on seat dispose', async () => {
    const built = await build({ maxSyncTools: 2 })
    const caller = await openCaller(built.seatCtx)
    const first = caller.ctx.tools.register(tool('t1'))
    caller.ctx.tools.register(tool('t2'))
    caller.ctx.tools.register(tool('t3'))
    expect(built.facades.snapshot().truncated).toBe(true)
    first()
    expect(built.facades.snapshot().truncated).toBe(true)
    expect(built.facades.snapshot().tools.size).toBe(1)
    // The trimmed register returned a harmless no-op disposer; a later
    // generation reaches the cap again without re-notifying the flag.
    caller.ctx.tools.register(tool('t4'))
    await caller.dispose()
    expect(built.facades.snapshot().tools.size).toBe(2)
    await built.disposeSeat()
    expect(built.facades.snapshot().tools.size).toBe(0)
    expect(built.facades.snapshot().truncated).toBe(false)

    const disposed = await build()
    const lateCaller = await openCaller(disposed.seatCtx)
    lateCaller.ctx.tools.register(tool('x'))
    lateCaller.ctx.systemPrompt.section(promptSection({ name: 'mcp:srv', order: 1 }))
    expect(disposed.facades.snapshot().tools.size).toBe(1)
    disposed.facades.dispose()
    expect(disposed.facades.snapshot().tools.size).toBe(0)
    expect(disposed.facades.snapshot().sections).toHaveLength(0)
    expect(disposed.facades.snapshot().truncated).toBe(false)
    await lateCaller.dispose()
  })

  it('routes an agent-scoped registration through the admission hook into the real ToolRuntime', async () => {
    const agent = fakeAgent('a1')
    let realAdmit: ((target: Agent, definition: ToolDefinition) => () => void) | undefined
    const built = await build({
      agentOf: (scope) => (scope === agent ? agent : undefined),
      admit: (target, definition) => {
        if (realAdmit === undefined) throw new Error('admit not wired')
        return realAdmit(target, definition)
      },
    })
    let admitted: Array<[Agent, ToolDefinition]> = []
    realAdmit = (target, definition) => {
      admitted.push([target, definition])
      const scope = createScope(built.factoryCtx, target)
      return scope.ctx.tools.register(definition)
    }
    const agentScope = createScope(built.seatCtx, agent)
    const definition = tool('mcp__srv__loaded')
    const dispose = agentScope.ctx.tools.register(definition)

    expect(admitted).toEqual([[agent, definition]])
    // The real ToolRuntime owns the registration in the agent scope...
    expect(built.factoryCtx.tools.get(definition.name, agent)).toBe(definition)
    // ...and the capture layer remains empty (no fan-out from a façade).
    expect(built.facades.snapshot().tools.size).toBe(0)

    dispose()
    expect(built.factoryCtx.tools.get(definition.name, agent)).toBeUndefined()
    await agentScope.dispose()
  })

  it('fails closed for a scoped registration outside a live agent', async () => {
    const agent = fakeAgent('a1')
    const built = await build({ agentOf: (scope) => (scope === agent ? agent : undefined), admit: () => () => {} })
    const stale = createScope(built.seatCtx, {})
    expect(() => stale.ctx.tools.register(tool('mcp__srv__loaded'))).toThrow(SeamMismatchError)
    await stale.dispose()
  })

  it('hides definitions from the global and non-applied agent views', async () => {
    const agent = fakeAgent('a1')
    const other = fakeAgent('a2')
    let applied = false
    const built = await build({
      agentOf: (scope) => (scope === agent ? agent : undefined),
      isApplied: () => applied,
    })
    const caller = await openCaller(built.seatCtx)
    const definition = tool('mcp__srv__loader')
    caller.ctx.tools.register(definition)

    expect(built.facades.snapshot().tools.get(definition.name)).toBe(definition)
    expect(built.facades.tools.get(definition.name)).toBeUndefined()
    expect(built.facades.tools.get(definition.name, agent)).toBeUndefined()
    expect(built.facades.tools.get(definition.name, other)).toBeUndefined()
    applied = true
    expect(built.facades.tools.get(definition.name, agent)).toBe(definition)
    expect(built.facades.tools.get('mcp__srv__absent', agent)).toBeUndefined()
    expect(built.facades.tools.get(definition.name, other)).toBeUndefined()
    await caller.dispose()
  })

  it('captures from an already-unloaded registrar (store-level ownership, no warning)', async () => {
    const warn = vi.fn()
    const built = await build({ warn })
    const caller = await openCaller(built.seatCtx)
    await caller.dispose()
    const definition = tool('mcp__srv__late')
    caller.ctx.tools.register(definition)
    expect(built.facades.snapshot().tools.get(definition.name)).toBe(definition)
    expect(warn).not.toHaveBeenCalled()
  })

  it('contains a throwing capture notification', async () => {
    const warn = vi.fn()
    const built = await build({ warn, onCaptureChanged: () => { throw new Error('sink failed') } })
    const caller = await openCaller(built.seatCtx)
    expect(() => caller.ctx.tools.register(tool('mcp__srv__add'))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture notification failed'))
    await caller.dispose()
  })

  it('fails closed when the visibility predicate throws', async () => {
    const warn = vi.fn()
    const agent = fakeAgent('a1')
    const built = await build({
      warn,
      agentOf: (scope) => (scope === agent ? agent : undefined),
      isApplied: () => { throw new Error('applier exploded') },
    })
    const caller = await openCaller(built.seatCtx)
    caller.ctx.tools.register(tool('mcp__srv__loader'))
    expect(built.facades.tools.get('mcp__srv__loader', agent)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog visibility check failed'))
    await caller.dispose()
  })

  it('returns copied snapshot maps', async () => {
    const store = new CaptureStore({ serverName: 'srv', credentials: new MemoryCredentials(new Context()) })
    store.addTool(tool('a'))
    const first = store.snapshot()
    expect(first.tools.get('a')).toBeDefined()
    ;(first.tools as Map<string, ToolDefinition>).clear()
    expect(store.snapshot().tools.size).toBe(1)
  })
})

describe('facade: prompt sections', () => {
  it('resolves the real order and falls back to a finite order', async () => {
    const built = await build({ getSectionOrder: () => 3100 })
    expect(built.facades.systemPrompt.getSectionOrder('MCP_SERVERS')).toBe(3100)
    const plain = await build()
    expect(plain.facades.systemPrompt.getSectionOrder('MCP_SERVERS')).toBe(FALLBACK_SECTION_ORDER)
    const caller = await openCaller(built.seatCtx)
    caller.ctx.systemPrompt.section(promptSection({ name: 'mcp:srv', order: Number.NaN }))
    expect(built.facades.snapshot().sections[0]?.order).toBe(3100)
    await caller.dispose()
  })

  it('falls back to a finite order when the hook throws', async () => {
    const warn = vi.fn()
    const built = await build({
      warn,
      getSectionOrder: () => { throw new Error('no registry') },
    })
    expect(built.facades.systemPrompt.getSectionOrder('MCP_SERVERS')).toBe(FALLBACK_SECTION_ORDER)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prompt order lookup failed'))
  })

  it('captures the descriptor verbatim and keeps the text live', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    let instructions = 'one'
    caller.ctx.systemPrompt.section(promptSection({
      name: 'mcp:srv',
      order: 7,
      interpolate: false,
      replacement: 'replaced',
      retirement: 'retired',
      text: () => instructions,
    }))
    const [captured] = built.facades.snapshot().sections
    expect(captured).toMatchObject({
      name: 'mcp:srv',
      order: 7,
      interpolate: false,
      replacement: 'replaced',
      retirement: 'retired',
    })
    instructions = 'two'
    expect(captured?.text(undefined)).toBe('two')
    await caller.dispose()
  })

  it('passes the assembling scope to a functional section text', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    const agent = fakeAgent('a1')
    caller.ctx.systemPrompt.section(promptSection({
      name: 'mcp:srv:tools',
      order: 8,
      text: (context) => 'scope:' + String(context.scope),
    }))
    const [captured] = built.facades.snapshot().sections
    expect(captured?.text(agent)).toBe('scope:' + String(agent))
    expect(captured?.text(undefined)).toBe('scope:undefined')
    await caller.dispose()
  })

  it('replaces a same-name capture and removes it when the seat unloads', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    const first = caller.ctx.systemPrompt.section(promptSection({ name: 'mcp:srv', order: 1, text: 'first' }))
    caller.ctx.systemPrompt.section(promptSection({ name: 'mcp:srv', order: 2, text: 'second' }))
    const sections = built.facades.snapshot().sections
    expect(sections).toHaveLength(1)
    expect(sections[0]?.order).toBe(2)
    first() // disposing the superseded registration must not remove the newer one
    expect(built.facades.snapshot().sections[0]?.order).toBe(2)
    await caller.dispose()
    expect(built.facades.snapshot().sections).toHaveLength(1)
    await built.disposeSeat()
    expect(built.facades.snapshot().sections).toHaveLength(0)
  })
})

describe('facade: resources', () => {
  it('captures, replaces and removes a provider', async () => {
    const built = await build()
    const caller = await openCaller(built.seatCtx)
    const first = resourceProvider()
    const second = resourceProvider()
    caller.ctx.mcpResources.register('srv', first)
    expect(built.facades.snapshot().resources.get('srv')).toBe(first)
    caller.ctx.mcpResources.register('srv', second)
    expect(built.facades.snapshot().resources.get('srv')).toBe(second)
    expect(built.facades.snapshot().resources.size).toBe(1)
    caller.ctx.mcpResources.register('other', first)
    expect(built.facades.snapshot().resources.size).toBe(2)
    await caller.dispose()
    expect(built.facades.snapshot().resources.size).toBe(2)
    await built.disposeSeat()
    expect(built.facades.snapshot().resources.size).toBe(0)
  })
})

describe('facade: credentials', () => {
  it('provides the façade service and resolves through the real provider', async () => {
    const built = await build()
    built.credentials.values.set('TOKEN', 's3cret')
    const resolved = await built.seatCtx.credentials.resolve('TOKEN' as CredentialRef)
    expect(resolved).toEqual({ value: 's3cret', source: 'test' })
    expect(await built.seatCtx.credentials.resolve('MISSING' as CredentialRef)).toBeUndefined()
    expect(built.credentials.calls.resolve).toBe(2)
  })

  it('rejects CR/LF/NUL values on every resolve (including after rotation) without leaking the value', async () => {
    const built = await build()
    const ref = 'TOKEN' as CredentialRef
    built.credentials.values.set(String(ref), 'clean')
    expect(await built.seatCtx.credentials.resolve(ref)).toEqual({ value: 'clean', source: 'test' })
    built.credentials.values.set(String(ref), 'bad' + String.fromCharCode(13) + 'value')
    const error = await built.seatCtx.credentials.resolve(ref).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(InvalidCredentialValueError)
    expect((error as InvalidCredentialValueError).ref).toBe('TOKEN')
    expect((error as Error).message).not.toContain('bad')
  })

  it('drops a control-character masked preview from describe', async () => {
    const built = await build()
    built.credentials.values.set('TOKEN', 'value' + String.fromCharCode(10) + 'x')
    const info = await built.seatCtx.credentials.describe('TOKEN' as CredentialRef)
    expect(info.configured).toBe(true)
    expect(info.masked).toBeUndefined()
    built.credentials.values.set('CLEAN', 'clean')
    expect((await built.seatCtx.credentials.describe('CLEAN' as CredentialRef)).masked).toBe('clean')
  })

  it('delegates the whole record surface to the real provider', async () => {
    const built = await build()
    const facade = built.seatCtx.credentials
    const key = 'mcp-client/mcp-scope-test' as CredentialKey
    await facade.set('TOKEN' as CredentialRef, 'v1')
    expect(built.credentials.values.get('TOKEN')).toBe('v1')
    await facade.unset('TOKEN' as CredentialRef)
    expect(built.credentials.values.has('TOKEN')).toBe(false)
    await facade.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: 'x' } }))
    expect((await facade.readRecord(key))?.kind).toBe('grant')
    expect((await facade.describeRecord(key)).configured).toBe(true)
    expect((await facade.listRecords()).map((entry) => String(entry.key))).toEqual([String(key)])
    await facade.deleteRecord(key)
    expect(await facade.readRecord(key)).toBeUndefined()
    expect(built.credentials.calls).toMatchObject({ set: 1, unset: 1, modifyRecord: 1, readRecord: 2, describeRecord: 1, listRecords: 1, deleteRecord: 1 })
  })
})

/** Fake optional consumers, used to observe replay registration/disposal order. */
function fakeComposition(options: { failSection?: boolean } = {}) {
  const sections = new Map<string, PromptSection>()
  const providers = new Map<string, McpResourceProvider>()
  const order: string[] = []
  class FakeSystemPrompt extends Service {
    constructor(ctx: Context) {
      super(ctx, 'systemPrompt')
    }

    getSectionOrder(): number {
      return 3100
    }

    section(definition: PromptSection): () => void {
      if (options.failSection === true) throw new Error('section failed')
      return this.ctx.effect(() => {
        sections.set(definition.name, definition)
        return () => {
          sections.delete(definition.name)
          order.push('section:' + definition.name)
        }
      })
    }
  }
  class FakeMcpResources extends Service {
    constructor(ctx: Context) {
      super(ctx, 'mcpResources')
    }

    register(server: string, provider: McpResourceProvider): () => void {
      return this.ctx.effect(() => {
        providers.set(server, provider)
        return () => {
          providers.delete(server)
          order.push('provider:' + server)
        }
      })
    }
  }
  const ctx = new Context()
  new FakeSystemPrompt(ctx)
  new FakeMcpResources(ctx)
  return { ctx, sections, providers, order }
}

describe('facade: replayCapturedContext', () => {
  it('publishes both contributions into one agent scope and disposes in reverse order', async () => {
    const composition = fakeComposition()
    const agent = fakeAgent('a1')
    const agentScope = createScope(composition.ctx, agent)
    const provider = resourceProvider()
    const dispose = replayCapturedContext(agentScope.ctx, snapshot({
      sections: [{ name: 'mcp:srv', order: 3100, text: () => 'instructions' }],
      resources: new Map([['srv', provider]]),
    }))
    await settle()
    const section = composition.sections.get('mcp:srv')
    const text = section?.text
    expect(section?.order).toBe(3100)
    expect(typeof text === 'function' ? text({}) : text).toBe('instructions')
    expect(composition.providers.get('srv')).toBe(provider)
    await dispose()
    expect(composition.sections.size).toBe(0)
    expect(composition.providers.size).toBe(0)
    expect(composition.order).toEqual(['provider:srv', 'section:mcp:srv'])
    await dispose()
    expect(composition.order).toEqual(['provider:srv', 'section:mcp:srv'])
    await agentScope.dispose()
  })

  it('is a no-op when the composition mounts neither consumer', async () => {
    const ctx = new Context()
    const agentScope = createScope(ctx, fakeAgent('a1'))
    const dispose = replayCapturedContext(agentScope.ctx, snapshot({
      sections: [{ name: 'mcp:srv', order: 3100, text: () => 'x' }],
      resources: new Map([['srv', resourceProvider()]]),
    }))
    await settle()
    await dispose()
    await agentScope.dispose()
  })

  it('contains a failing contribution and still replays the resource provider', async () => {
    const composition = fakeComposition({ failSection: true })
    const warn = vi.fn()
    const agentScope = createScope(composition.ctx, fakeAgent('a1'))
    const dispose = replayCapturedContext(agentScope.ctx, snapshot({
      sections: [{ name: 'mcp:srv', order: 3100, text: () => 'x' }],
      resources: new Map([['srv', resourceProvider()]]),
    }), { warn })
    await settle()
    expect(composition.providers.size).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to load'))
    await dispose()
    await agentScope.dispose()
  })
})
