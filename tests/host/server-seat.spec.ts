/**
 * Per-server seat unit matrix (src/server-fiber.ts + src/upstream.ts).
 *
 * A fake upstream host registers through the seat's OWN isolated ctx (the real
 * capture façades), so the seat lifecycle is exercised without any MCP
 * connection: capture sink containment, section-order fallback/real lookup,
 * scoped admission hooks, stop/probe/authorization delegation, unconfirmed
 * teardown warnings and activation failures. The REAL official host is pinned by
 * upstream-mount-gate.spec.ts.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  Config,
  McpCloseResult,
  McpConnectionStatusHandle,
  McpOAuthAuthorization,
  McpProbeResult,
  McpServerInstance,
} from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createServerSeat } from '../../src/server-fiber.js'
import {
  disposeServerInstance,
  loadUpstreamMcpClient,
  resetUpstreamMcpClientCache,
  type UpstreamMcpClient,
} from '../../src/upstream.js'
import type { CaptureSnapshot } from '../../src/facade.js'
import { makeLogger, toolDef, type CapturingLogger } from '../support/fixture-kit.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** A status handle the fake host hands out. */
function fakeHandle(closeResult: McpCloseResult = { closeConfirmed: true }): McpConnectionStatusHandle {
  return {
    current: () => ({ state: 'connected', toolCount: 1, connectedAt: 1 }),
    closure: () => closeResult,
    onChange: () => () => {},
  }
}

/** What the fake host registered at mount time (the test's recorded side). */
interface FakeHostState {
  mountedConfigs: Config[]
  mounted: number
  disposed: McpCloseResult | undefined
  probeCalls: Array<{ config: Config; options: unknown }>
  authorizationCalls: Array<{ config: unknown; changed: () => void }>
  registrations: {
    tools: ToolDefinition[]
    sections: Array<{ name: string; order: number }>
    resources: string[]
    scopedTokens: number
  }
}

interface FakeHostOptions {
  /** Registration error thrown from mount (activation failure). */
  mountError?: Error
  /** The instance dispose result (defaults to a confirmed close). */
  disposeResult?: McpCloseResult
  /** The fake host constructor throws (seat activation failure). */
  constructorError?: Error
  /** Section order the real prompt registry would answer (NaN registrations ask). */
  sectionOrder?: number | 'throw'
  /** Probe outcome. */
  probeResult?: McpProbeResult
  /** Record a scoped (agent) registration through the seat façades at mount. */
  admitScoped?: Agent
  /** Rail: invoked after the registrations land (e.g. to change the sink). */
  afterMount?: () => void
}

/** One fake upstream package: a host class whose mount registers through ITS ctx. */
function fakeUpstream(options: FakeHostOptions = {}, state?: Partial<FakeHostState>): { upstream: UpstreamMcpClient; state: FakeHostState } {
  const hostState: FakeHostState = {
    mountedConfigs: [],
    mounted: 0,
    disposed: undefined,
    probeCalls: [],
    authorizationCalls: [],
    registrations: { tools: [], sections: [], resources: [], scopedTokens: 0 },
    ...state,
  }
  class FakeMcpClientHost {
    constructor(private readonly ctx: Context) {
      if (options.constructorError !== undefined) throw options.constructorError
    }

    validate(input: unknown): Config {
      return input as Config
    }

    mount(config: Config): McpServerInstance {
      if (options.mountError !== undefined) throw options.mountError
      hostState.mounted += 1
      hostState.mountedConfigs.push(config)
      const definition = toolDef('mcp__fake__add')
      const remove = this.ctx.tools.register(definition)
      hostState.registrations.tools.push(definition)
      const sectionDispose = this.ctx.systemPrompt.section({
        name: 'mcp:fake',
        // A non-finite order forces the façade's getSectionOrder hook.
        order: Number.NaN,
        text: () => 'fake instructions',
        interpolate: false,
      })
      hostState.registrations.sections.push({ name: 'mcp:fake', order: Number.NaN })
      this.ctx.mcpResources.register('fake', { request: async () => ({}) } as never)
      hostState.registrations.resources.push('fake')
      if (options.admitScoped !== undefined) {
        const agent = options.admitScoped
        const scope = createScope(this.ctx, agent as never)
        scope.ctx.tools.register(toolDef('mcp__fake__loaded'))
        hostState.registrations.scopedTokens += 1
      }
      options.afterMount?.()
      void remove
      void sectionDispose
      return {
        ready: Promise.resolve(fakeHandle(options.disposeResult ?? { closeConfirmed: true })),
        dispose: async () => {
          hostState.disposed = options.disposeResult ?? { closeConfirmed: true }
          return hostState.disposed
        },
      }
    }

    probe(config: Config, probeOptions?: unknown): Promise<McpProbeResult> {
      hostState.probeCalls.push({ config, options: probeOptions })
      return Promise.resolve(options.probeResult ?? { ok: true, toolNames: [], truncated: false, durationMs: 1, closeConfirmed: true })
    }

    authorization(config: unknown, changed: () => void): McpOAuthAuthorization {
      hostState.authorizationCalls.push({ config, changed })
      return { current: () => ({ id: 'attempt', phase: 'starting' }), start: async () => ({ id: 'attempt', phase: 'starting' }), cancel: async () => {}, dispose: async () => {} } as unknown as McpOAuthAuthorization
    }
  }
  return { upstream: { McpClientHost: FakeMcpClientHost as unknown as UpstreamMcpClient['McpClientHost'] }, state: hostState }
}

const credentials = { resolve: async () => undefined } as never

interface SeatFixture {
  ctx: Context
  logger: CapturingLogger
  captures: CaptureSnapshot[]
  /** Cheap capture version forwarded with each capture notification (H5). */
  versions: Array<number | undefined>
  seat: Awaited<ReturnType<typeof createServerSeat>> | undefined
  dispose(): Promise<void>
}

/** Start one seat over a fake host on a throwaway root context. */
async function startSeat(
  upstream: UpstreamMcpClient,
  options: {
    onCaptureChanged?: (peek: () => CaptureSnapshot) => void
    hooks?: Parameters<typeof createServerSeat>[0]['hooks']
    sectionOrderCtx?: Context
  } = {},
): Promise<SeatFixture> {
  const ctx = new Context()
  const logger = makeLogger()
  const captures: CaptureSnapshot[] = []
  const versions: Array<number | undefined> = []
  const fixture: SeatFixture = {
    ctx,
    logger,
    captures,
    versions,
    seat: undefined,
    async dispose() {
      await fixture.seat?.disposeSeat().catch(() => {})
      await ctx.fiber.dispose()
    },
  }
  const seat = await createServerSeat({
    ctx: options.sectionOrderCtx ?? ctx,
    upstream,
    credentials,
    logger,
    serverName: 'fake',
    epoch: 1,
    onCaptureChanged: (peek, version) => {
      captures.push(peek())
      versions.push(version)
      options.onCaptureChanged?.(peek)
    },
    hooks: options.hooks ?? {
      agentOf: () => undefined,
      admit: () => () => {},
      isApplied: () => false,
    },
  })
  fixture.seat = seat
  return fixture
}

/** One mount config (the seat only forwards it). */
const config = { transport: 'stdio', serverName: 'fake', command: 'x' } as unknown as Config

describe('per-server seat (src/server-fiber.ts)', () => {
  it('captures its fake host registrations and resolves the fallback section order', async () => {
    const { upstream, state } = fakeUpstream()
    const fixture = await startSeat(upstream)
    try {
      const instance = fixture.seat!.mount(config)
      await instance.ready
      const snapshot = fixture.seat!.capture()
      expect(snapshot.tools.size).toBe(1)
      expect(snapshot.tools.get('mcp__fake__add')).toBeDefined()
      expect(snapshot.sections.map((section) => section.name)).toEqual(['mcp:fake'])
      // No real prompt registry in this composition: finite fallback order.
      expect(snapshot.sections[0]?.order).toBe(0)
      expect([...snapshot.resources.keys()]).toEqual(['fake'])
      expect(fixture.captures.length).toBeGreaterThanOrEqual(3)
      expect(state.mounted).toBe(1)
      expect(fixture.logger.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })

  it('uses the real registry order and survives a throwing order lookup', async () => {
    const withOrder = new Context()
    withOrder.provide('systemPrompt', { getSectionOrder: () => 3100 } as never)
    const first = await startSeat(fakeUpstream().upstream, { sectionOrderCtx: withOrder })
    try {
      first.seat!.mount(config)
      await flush()
      expect(first.seat!.capture().sections[0]?.order).toBe(3100)
    } finally {
      await first.dispose()
      await withOrder.fiber.dispose()
    }

    const throwing = new Context()
    throwing.provide('systemPrompt', { getSectionOrder: () => { throw new Error('registry exploded') } } as never)
    const second = await startSeat(fakeUpstream().upstream, { sectionOrderCtx: throwing })
    try {
      second.seat!.mount(config)
      await flush()
      expect(second.seat!.capture().sections[0]?.order).toBe(0)
      expect(second.logger.lines.some((line) => line.level === 'warn' && line.message.includes('prompt order lookup failed'))).toBe(true)
    } finally {
      await second.dispose()
      await throwing.fiber.dispose()
    }
  })

  it('routes a scoped registration through the applier hooks and contains sink failures', async () => {
    const admitted: Agent[] = []
    const agent = { id: 'agent-fake' } as unknown as Agent
    const { upstream } = fakeUpstream({ admitScoped: agent })
    const fixture = await startSeat(upstream, {
      onCaptureChanged: () => {
        throw new Error('sink exploded')
      },
      hooks: {
        agentOf: (scope) => (scope === (agent as never) ? agent : undefined),
        admit: (target) => {
          admitted.push(target)
          return () => {}
        },
        isApplied: () => true,
      },
    })
    try {
      fixture.seat!.mount(config)
      await flush()
      // The scoped registration went through the admission hook, never the
      // capture store, and the throwing sink was contained with a warning.
      expect(admitted).toHaveLength(1)
      expect(fixture.seat!.capture().tools.has('mcp__fake__loaded')).toBe(false)
      expect(fixture.logger.lines.some((line) => line.level === 'warn' && line.message.includes('capture sink failed'))).toBe(true)
      expect(fixture.logger.lines.filter((line) => line.level === 'error')).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })

  it('forwards a cheap increasing capture version with every change', async () => {
    const fixture = await startSeat(fakeUpstream().upstream)
    try {
      fixture.seat!.mount(config)
      await flush()
      // H5: the seat hands the manager a notification counter (the store's
      // version) so publishCaptures can skip the snapshot copy. The real seat
      // must ALWAYS supply it; the values are consecutive from 1.
      expect(fixture.versions.length).toBeGreaterThanOrEqual(3)
      const versions = fixture.versions.filter((value): value is number => typeof value === 'number')
      expect(versions).toHaveLength(fixture.versions.length)
      expect(versions).toEqual(versions.map((_, index) => index + 1))
      // The peek is lazy: the captured snapshots still carry those versions.
      expect(fixture.captures.at(-1)?.version).toBe(versions.at(-1))
    } finally {
      await fixture.dispose()
    }
  })

  it('delegates probe/authorization and warns on an unconfirmed teardown', async () => {
    const { upstream, state } = fakeUpstream({ disposeResult: { closeConfirmed: false, cleanupError: 'close hung' } })
    const fixture = await startSeat(upstream)
    try {
      const instance = fixture.seat!.mount(config)
      await instance.ready
      const probe = await fixture.seat!.probe(config, { timeoutMs: 10 })
      expect(probe.ok).toBe(true)
      expect(state.probeCalls).toHaveLength(1)
      fixture.seat!.authorization(
        { transport: 'streamable-http', serverName: 'fake', url: 'https://x', oauth: { credentialKey: 'mcp-client/x' } } as never,
        () => {},
      )
      expect(state.authorizationCalls).toHaveLength(1)
      // Seat teardown owns the leftover instance disposal and must warn when
      // that close cannot be confirmed.
      await fixture.seat!.disposeSeat()
      expect(fixture.seat!.alive).toBe(false)
      expect(fixture.logger.lines.some((line) => line.level === 'warn' && line.message.includes('not confirmed'))).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  it('fails activation cleanly when the host constructor or mount throws', async () => {
    const constructorFailure = await startSeat(fakeUpstream({ constructorError: new Error('no host') }).upstream).catch(
      (error: unknown) => error,
    )
    // createServerSeat rejects and leaves no half-built seat behind.
    expect(constructorFailure).toBeInstanceOf(Error)
    expect(String(constructorFailure)).toMatch(/capture façades could not be installed|could not be created|no host/i)

    const mountFailure = await startSeat(fakeUpstream({ mountError: new Error('mount refused') }).upstream)
    try {
      expect(() => mountFailure.seat!.mount(config)).toThrow(/mount refused/)
    } finally {
      await mountFailure.dispose()
    }
  })
})

describe('upstream peer acquisition (src/upstream.ts)', () => {
  it('rejects with a fixed diagnostic when the peer exports no host, and never caches the failure', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-mcp-client', () => ({ McpClientHost: undefined }))
    try {
      const fresh = (await import('../../src/upstream.ts')) as typeof import('../../src/upstream.ts')
      await expect(fresh.loadUpstreamMcpClient()).rejects.toThrow(fresh.UPSTREAM_UNAVAILABLE_MESSAGE)
      // NOT memoized: the next call retries the import and fails the same way.
      const failure = await fresh.loadUpstreamMcpClient().catch((error: unknown) => error)
      expect((failure as Error).message).toBe(fresh.UPSTREAM_UNAVAILABLE_MESSAGE)
      expect(String((failure as { cause?: unknown }).cause)).toContain('does not export McpClientHost')
      fresh.resetUpstreamMcpClientCache()
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-mcp-client')
      vi.resetModules()
    }
  })

  it('loads the installed peer once and reuses the same namespace', async () => {
    resetUpstreamMcpClientCache()
    const first = await loadUpstreamMcpClient()
    const second = await loadUpstreamMcpClient()
    expect(first).toBe(second)
    expect(typeof first.McpClientHost).toBe('function')
  })

  it('folds a throwing instance dispose into an unconfirmed cleanup result', async () => {
    expect(await disposeServerInstance(undefined)).toBeUndefined()
    const clean = await disposeServerInstance({ ready: Promise.resolve(fakeHandle()), dispose: async () => ({ closeConfirmed: true }) })
    expect(clean).toEqual({ closeConfirmed: true })
    const broken = await disposeServerInstance({
      ready: Promise.resolve(fakeHandle()),
      dispose: async () => {
        throw new Error('dispose exploded')
      },
    })
    expect(broken?.closeConfirmed).toBe(false)
    expect(broken?.cleanupError).toContain('dispose exploded')
  })
})
