/**
 * Unit tests for src/server-context.ts: one server's contribution to the
 * OPTIONAL consumers of a composition — the literal `mcp:<server>` system-prompt
 * section and the `mcpResources` provider — plus their per-server disposal.
 *
 * Both consumers are faked as REAL cordis Services, because the property under
 * test IS the cordis ownership rule: a service instance reached through the
 * injected `inner` is bound to the CONSUMING fiber, so the
 * `this.ctx.effect(...)` registration a real consumer performs is unloaded
 * together with the injection this module hands back.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { registerServerContext, type ServerContext } from '../../src/server-context.ts'

interface FakeSection {
  name: string
  order: number
  interpolate?: boolean
  text: string | ((context: unknown) => string)
}

/**
 * Build a composition with the two optional consumers mounted.
 *
 * @param options.order - What `getSectionOrder('MCP_SERVERS')` answers: 3100 for
 * the 0.1.6 shape, `undefined` for 0.1.5 (whose SECTION_ORDERS has no such key).
 */
function makeComposition(options: { order?: number } = {}) {
  // Default to the 0.1.6 shape; a caller passes { order: undefined } to model
  // 0.1.5 explicitly (an omitted property cannot express that).
  const order = 'order' in options ? options.order : 3100
  const sections = new Map<string, FakeSection>()
  const providers = new Map<string, unknown>()
  const unloaded: string[] = []

  class FakeSystemPrompt extends Service {
    constructor(host: Context) {
      super(host, 'systemPrompt')
    }

    getSectionOrder(name: string): number {
      if (name !== 'MCP_SERVERS') throw new Error(`unknown section order ${name}`)
      return order as number
    }

    section(section: FakeSection): () => void {
      if (sections.has(section.name)) throw new Error(`duplicate section "${section.name}"`)
      return this.ctx.effect(() => {
        sections.set(section.name, section)
        return () => {
          sections.delete(section.name)
          unloaded.push(`section:${section.name}`)
        }
      }, 'fake.section')
    }
  }

  class FakeMcpResources extends Service {
    constructor(host: Context) {
      super(host, 'mcpResources')
    }

    register(server: string, provider: unknown): () => void {
      return this.ctx.effect(() => {
        providers.set(server, provider)
        return () => {
          providers.delete(server)
          unloaded.push(`provider:${server}`)
        }
      }, 'fake.register')
    }
  }

  const ctx = new Context()
  new FakeSystemPrompt(ctx)
  new FakeMcpResources(ctx)
  return { ctx, sections, providers, unloaded }
}

/** Cordis activates an `inject` fiber off the current tick; let it land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function connection(instructions = ''): ServerContext {
  return {
    instructions: () => instructions,
    resources: { request: async () => ({}) } as never,
  }
}

describe('registerServerContext', () => {
  it('publishes the literal instruction section and the resource provider', async () => {
    const { ctx, sections, providers, unloaded } = makeComposition()
    const conn = connection('### MCP server: srv\n\nuse add first')
    const unload = registerServerContext(ctx, 'srv', conn)
    await settle()

    const section = sections.get('mcp:srv')
    expect(section).toBeDefined()
    // The host's allocated placement (the 0.1.5 case below is what forbids
    // substituting a local constant).
    expect(section?.order).toBe(3100)
    // Instructions are literal text, never a {{variable}} template.
    expect(section?.interpolate).toBe(false)
    // The section text is a LIVE read of the connection, not a snapshot.
    expect(typeof section?.text).toBe('function')
    expect((section?.text as (context: unknown) => string)({})).toBe('### MCP server: srv\n\nuse add first')
    expect(providers.get('srv')).toBe(conn.resources)

    await unload()
    expect(sections.size).toBe(0)
    expect(providers.size).toBe(0)
    expect(unloaded).toEqual(['provider:srv', 'section:mcp:srv'])
  })

  it('publishes nothing when the host does not allocate MCP_SERVERS (0.1.5)', async () => {
    const { ctx, sections, providers } = makeComposition({ order: undefined })
    const unload = registerServerContext(ctx, 'srv', connection('### MCP server: srv\n\nwith {{braces}}'))
    await settle()

    // 0.1.5 has no literal-section rendering (its renderer always interpolates,
    // so "{{braces}}" would either abort the turn or be substituted with a host
    // variable). Publishing nothing is what 0.1.5 shipped — and it must not
    // throw either.
    expect(sections.size).toBe(0)
    // The resource provider is independent of the prompt contribution.
    expect(providers.has('srv')).toBe(true)

    await unload()
    expect(providers.size).toBe(0)
  })

  it('degrades silently when the composition mounts neither optional service', async () => {
    const ctx = new Context()
    const unload = registerServerContext(ctx, 'srv', connection())
    await settle()
    await unload()
  })

  it('keeps the two contributions independent', async () => {
    const { ctx, sections, providers } = makeComposition()
    // Occupy the section name first: the prompt contribution fails inside its
    // own fiber and must not take the resource provider down with it.
    sections.set('mcp:srv', { name: 'mcp:srv', order: 0, text: '' })
    const unload = registerServerContext(ctx, 'srv', connection(), { warn: () => {} })
    await settle()
    expect(providers.has('srv')).toBe(true)
    await unload()
    expect(providers.size).toBe(0)
  })
})
