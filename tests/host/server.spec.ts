/**
 * Integration tests for the per-server supervisor (src/server.ts) against a
 * REAL MCP server over stdio: the in-repo fixture (tests/fixture/).
 *
 * Covers: connect + sync (incl. dotted-name normalization), runtime
 * `tools/list_changed` re-sync, crash → reconnect → serve again, budget
 * exhaustion → unregister, and clean disposal.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ServerDef } from '../../src/shared/model.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  EMPTY_DEFS,
  RECONNECT_DEFAULTS,
  probeServer,
  resolveReconnectPolicy,
  startServerSupervisor,
  type ServerHandle,
  type ServerSnapshot,
} from '../../src/server.js'
import { createTransport } from '../../src/transport.js'
import { renderResultText } from '../../src/tools.js'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture')
const fixtureServer = join(fixtureDir, 'mcp-fixture-server.mjs')

interface LoggedLine { level: 'info' | 'warn' | 'error'; message: string }

/** Collect the supervisor's structured log lines (stable `mcp-scope(` prefix). */
function makeLogger(): { log: (level: LoggedLine['level'], message: string) => void; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  return {
    lines,
    log: (level, message) => void lines.push({ level, message }),
  }
}

function execContext(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

const noopResolve = async () => undefined
const NO_WARN = () => {}

function stdioDef(serverName: string, extra?: Partial<Extract<ServerDef, { transport: 'stdio' }>>): Extract<ServerDef, { transport: 'stdio' }> {
  return {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: '',
    envKeys: [],
    ...extra,
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * A transport whose server is UP but never answers the MCP handshake: `start()`
 * resolves and every outgoing message is swallowed, so `initialize` simply
 * hangs. `close()` honors the Transport contract by firing `onclose` once (a
 * real transport signals closure there too), so the supervisor's close barrier
 * settles instead of falling into its 5 s generation-stuck path.
 */
function hungTransport(received: string[] = []): Transport {
  let closed = false
  const transport: Transport = {
    async start() {},
    async send(message) {
      received.push(JSON.stringify(message))
    },
    async close() {
      if (closed) return
      closed = true
      transport.onclose?.()
    },
  }
  return transport
}

/** Boot one supervisor with an in-memory log + commit collector. */
async function boot(serverName = 'fix', reconnect?: Parameters<typeof startServerSupervisor>[0]['reconnect']): Promise<{
  handle: ServerHandle
  lines: LoggedLine[]
  commits: { serverName: string; syncId: number; size: number }[]
}> {
  const { log, lines } = makeLogger()
  const commits: { serverName: string; syncId: number; size: number }[] = []
  const handle = startServerSupervisor({
    serverName,
    buildTransport: () => createTransport(stdioDef(serverName), noopResolve, NO_WARN),
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
    onDefsChanged: (name, syncId, defs) => void commits.push({ serverName: name, syncId, size: defs.size }),
    reconnect,
  })
  await handle.ready
  return { handle, lines, commits }
}

const handles: ServerHandle[] = []
afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()!
    await handle.dispose()
  }
})

describe('server supervisor with a real stdio MCP server', () => {
  it('connects, syncs expected defs with normalized names, and serves calls', async () => {
    const { handle, lines, commits } = await boot()
    handles.push(handle)
    expect(handle.state.connected).toBe(true)
    expect(handle.state.generation).toBe(1)
    expect(handle.state.syncId).toBe(1)

    const defs = handle.state.defs
    expect(defs.get('mcp__fix__add')?.description).toBe('Adds two numbers.')
    expect(defs.has('mcp__fix__greet')).toBe(true)
    expect(defs.has('mcp__fix__fail')).toBe(true)
    expect(defs.has('mcp__fix__crash')).toBe(true)
    expect(defs.has('mcp__fix__dyn_add')).toBe(true)
    // Dotted raw name → normalized public name with the identity hash.
    const dottedName = [...defs.keys()].find((k) => k.startsWith('mcp__fix__admin_reset_'))
    expect(dottedName).toMatch(/^mcp__fix__admin_reset_[0-9a-f]{12}$/)
    // Raw names are never registered.
    expect(defs.has('admin.reset')).toBe(false)

    // Executor round trip through the real child.
    const add = defs.get('mcp__fix__add')!
    const value = await add.execute({ a: 3, b: 4 }, execContext())
    expect(value).toEqual({ content: [{ type: 'text', text: '7' }] })

    // isError propagates as a throw.
    const fail = defs.get('mcp__fix__fail')!
    await expect(fail.execute({}, execContext())).rejects.toThrow('Something went wrong')

    // Image content degrades to placeholder text in the render projection.
    const image = defs.get('mcp__fix__image')!
    const imageValue = await image.execute({}, execContext()) as { content: unknown[] }
    expect(renderResultText(imageValue.content as never, 'image'))
      .toBe('Here is an image:\n[image: image/png, content discarded]\nEnd of image.')

    // Structured lifecycle log lines carry the stable prefix.
    expect(lines.some((l) => l.level === 'info' && l.message.includes('mcp-scope(fix)') && l.message.includes('synced 8 tools'))).toBe(true)
    expect(commits).toEqual([{ serverName: 'fix', syncId: 1, size: 8 }])
  })

  it('re-syncs when the server announces tools/list_changed', async () => {
    const { handle, lines } = await boot()
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync')

    const dynAdd = handle.state.defs.get('mcp__fix__dyn_add')!
    const result = await dynAdd.execute({ name: 'extra_tool' }, execContext())
    expect(result).toEqual({ content: [{ type: 'text', text: 'added extra_tool' }] })

    // list_changed → serialized re-sync commits generation 2.
    await waitFor(() => handle.state.syncId === 2, 're-sync after list_changed')
    expect(handle.state.defs.has('mcp__fix__extra_tool')).toBe(true)
    expect(lines.some((l) => l.level === 'info' && l.message.includes('tool list changed, re-syncing'))).toBe(true)

    // The new dynamic tool is servable end to end.
    const dynamic = handle.state.defs.get('mcp__fix__extra_tool')!
    const dynamicValue = await dynamic.execute({}, execContext())
    expect(dynamicValue).toEqual({ content: [{ type: 'text', text: 'dynamic result from extra_tool' }] })
  })

  it('reconnects after a crash and serves again', async () => {
    const { handle, lines, commits } = await boot('fix', {
      enabled: true,
      initialDelayMs: 100,
      maxDelayMs: 500,
      maxAttempts: 5,
    })
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync')

    const crash = handle.state.defs.get('mcp__fix__crash')!
    const result = await crash.execute({}, execContext())
    expect(result).toEqual({ content: [{ type: 'text', text: 'crashing' }] })

    // Child exits → transport closes → supervisor schedules a reconnect.
    await waitFor(() => handle.state.syncId === 2, 're-sync after crash reconnect')
    expect(handle.state.connected).toBe(true)
    expect(handle.state.generation).toBe(2)
    // A connected snapshot describes the CURRENT outage: counters are reset.
    expect(handle.snapshot().attempts).toBe(0)
    expect(handle.state.defs.has('mcp__fix__add')).toBe(true)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('connection lost; reconnecting'))).toBe(true)
    expect(lines.some((l) => l.level === 'info' && l.message.includes('reconnected and re-synced tools'))).toBe(true)
    expect(commits.length).toBe(2)

    // The restarted server serves again.
    const add = handle.state.defs.get('mcp__fix__add')!
    const value = await add.execute({ a: 1, b: 2 }, execContext())
    expect(value).toEqual({ content: [{ type: 'text', text: '3' }] })
  })

  it('exhausts the reconnect budget and unregisters with an empty commit', async () => {
    // A server that can never spawn (missing executable) exhausts the budget:
    // startup attempt + 3 retries → give-up pushes an empty defs map so the
    // manager revokes live agents. The unregister commit must NOT read as a
    // sync: no "synced 0 tools" info line and no generation/syncId inflation
    // for a server that never listed (IMPL-4).
    const { log, lines } = makeLogger()
    const commits: { serverName: string; syncId: number; size: number }[] = []
    const handle = startServerSupervisor({
      serverName: 'ghost',
      buildTransport: async () => createTransport(stdioDef('ghost', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: (name, syncId, defs) => void commits.push({ serverName: name, syncId, size: defs.size }),
      reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 60, maxAttempts: 3 },
    })
    handles.push(handle)
    await handle.ready
    await waitFor(() => commits.some((c) => c.size === 0), 'give-up empty commit')
    expect(handle.state.defs).toBe(EMPTY_DEFS)
    expect(handle.state.connected).toBe(false)
    // A never-synced server must not report a successful-looking generation.
    expect(handle.state.generation).toBe(0)
    expect(handle.state.syncId).toBe(0)
    expect(commits).toEqual([{ serverName: 'ghost', syncId: 0, size: 0 }])
    expect(lines.some((l) => l.level === 'info' && l.message.includes('synced 0 tools'))).toBe(false)
    expect(lines.some((l) => l.level === 'error' && l.message.includes('giving up after 3 consecutive failed reconnect attempts'))).toBe(true)
    // No further activity after the give-up commit.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(commits.length).toBe(1)
  })

  it('does not launder the budget when a reconnect crashes again inside the stability window', async () => {
    // Upstream mcp-client pins this: "a crash loop with briefly successful
    // connects still exhausts the cap". A successful connect is NOT an end of
    // the outage — only uptime past the stability window (= maxDelayMs) is.
    const { handle, lines, commits } = await boot('fix', { initialDelayMs: 20, maxDelayMs: 10_000, maxAttempts: 1 })
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync')

    await handle.state.defs.get('mcp__fix__crash')!.execute({}, execContext())
    await waitFor(() => handle.state.syncId === 2, 'reconnect after the first crash')
    // Crash AGAIN immediately: with the budget laundered this reconnects
    // forever and the give-up commit never arrives.
    await handle.state.defs.get('mcp__fix__crash')!.execute({}, execContext())

    await waitFor(() => commits.some((commit) => commit.size === 0), 'give-up empty commit')
    expect(handle.state.defs).toBe(EMPTY_DEFS)
    expect(handle.state.connected).toBe(false)
    expect(handle.snapshot().phase).toBe('failed')
    expect(lines.some((line) => line.level === 'error' && line.message.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
    const settled = commits.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(commits.length).toBe(settled)
  })

  it('resets the attempt budget once a connection outlives the stability window', async () => {
    const { handle, lines, commits } = await boot('fix', { initialDelayMs: 20, maxDelayMs: 120, maxAttempts: 1 })
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync')
    // Stay up past the stability window, then crash: the outage counter starts
    // fresh, so maxAttempts=1 still allows this single reconnect.
    await new Promise((resolve) => setTimeout(resolve, 220))
    await handle.state.defs.get('mcp__fix__crash')!.execute({}, execContext())

    await waitFor(() => handle.state.syncId === 2, 'reconnect after a stable uptime')
    expect(handle.state.connected).toBe(true)
    expect(commits.some((commit) => commit.size === 0)).toBe(false)
    expect(lines.some((line) => line.level === 'error' && line.message.includes('giving up'))).toBe(false)
  })

  it('contains a throwing unregister push instead of rejecting unhandled', async () => {
    // The give-up continuation pushes an empty generation through the caller's
    // applier: a throw there used to become an unhandled rejection, which takes
    // the whole Host down (Node's default). It must be reported instead.
    const { log, lines } = makeLogger()
    const handle = startServerSupervisor({
      serverName: 'ghost',
      buildTransport: async () => createTransport(stdioDef('ghost', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {
        throw new Error('applier push failed')
      },
      reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 60, maxAttempts: 1 },
    })
    handles.push(handle)
    await handle.ready
    await waitFor(
      () => lines.some((line) => line.level === 'error' && line.message.includes('unregister push after giving up failed')),
      'contained unregister failure',
    )
    expect(handle.state.defs).toBe(EMPTY_DEFS)
    expect(handle.state.connected).toBe(false)
  })

  it('dispose quiesces and stops; no commits follow disposal', async () => {
    const { handle, lines } = await boot('fix', { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 5 })
    await waitFor(() => handle.state.syncId === 1, 'initial sync')
    const logCount = () => lines.length
    const before = logCount()
    await handle.dispose()
    expect(handle.state.connected).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(logCount()).toBe(before)
  })

  it('does not overlap generations when a failed generation closes late', async () => {
    // Non-crashing startup failure is hard to stage with the fixture; instead
    // assert the policy validation surface and the ready contract on a
    // missing executable.
    const { log, lines } = makeLogger()
    const commits: string[] = []
    const handle = startServerSupervisor({
      serverName: 'ghost',
      buildTransport: async () => createTransport(stdioDef('ghost', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => void commits.push('commit'),
      reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 60, maxAttempts: 3 },
    })
    handles.push(handle)
    await handle.ready
    expect(commits.length).toBe(0)
    await waitFor(() => lines.some((l) => l.message.includes('connection failed; retrying')), 'retry log')
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('attempt 1/3'))).toBe(true)
  })
})

describe('bounded connect against a server that never answers the handshake', () => {
  it('bounds the hung attempt with the configured timeout, not the SDK 60 s default', async () => {
    const { log, lines } = makeLogger()
    const received: string[][] = []
    const handle = startServerSupervisor({
      serverName: 'hung',
      buildTransport: async () => {
        const messages: string[] = []
        received.push(messages)
        return hungTransport(messages)
      },
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      toolCallTimeoutMs: 100,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 },
    })
    handles.push(handle)
    const started = Date.now()
    await waitFor(() => handle.snapshot().error !== undefined, 'bounded handshake failure', 5000)
    const elapsed = Date.now() - started
    // The SDK really issued the handshake and the attempt really failed on the
    // operator's 100 ms bound: with the SDK's silent 60 s default this poll
    // would never observe an error and the test would fail on its timeout.
    expect(received[0]?.some((message) => message.includes('initialize'))).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(5000)
    const snap = handle.snapshot()
    expect(snap.phase === 'reconnecting' || snap.phase === 'failed').toBe(true)
    expect(snap.error).toMatch(/timed out/i)
    expect(lines.some((line) => line.level === 'warn' && line.message.includes('connection attempt failed') && /timed out/i.test(line.message))).toBe(true)
  })

  it('keeps the failure reason visible while the next attempt is in flight', async () => {
    const { log } = makeLogger()
    const handle = startServerSupervisor({
      serverName: 'hung',
      buildTransport: async () => hungTransport(),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      toolCallTimeoutMs: 300,
      reconnect: { enabled: true, initialDelayMs: 200, maxDelayMs: 400, maxAttempts: 5 },
    })
    handles.push(handle)
    // Attempt 1 fails on its bound and arms the reconnect timer: the reason is
    // on the snapshot during the backoff window.
    await waitFor(
      () => handle.snapshot().phase === 'reconnecting' && handle.snapshot().error !== undefined,
      'first bounded failure visible during backoff',
    )
    expect(handle.snapshot().error).toMatch(/timed out/i)
    // The timer fires and attempt 2 is in flight: 'connecting' with no armed
    // retry and no connection. The previous reason must STILL be there — before
    // the fix this snapshot carried no error, so the card read a bare
    // "connecting…" for the whole outage.
    let inFlight: ServerSnapshot | undefined
    await waitFor(() => {
      const snap = handle.snapshot()
      if (snap.phase !== 'connecting' || snap.error === undefined) return false
      inFlight = snap
      return true
    }, 'error retained on the next in-flight attempt', 5000)
    expect(inFlight?.error).toMatch(/timed out/i)
    expect(inFlight?.nextRetryAt).toBeUndefined()
    expect(inFlight?.attempts).toBe(1)
  })

  it('retires the retained error once a generation is established', async () => {
    const { log, lines } = makeLogger()
    let attempts = 0
    const handle = startServerSupervisor({
      serverName: 'fix',
      buildTransport: async () => {
        attempts += 1
        // Attempt 1: the server never answers the handshake. Attempt 2: the
        // real fixture comes up, so the outage genuinely ends.
        return attempts === 1 ? hungTransport() : createTransport(stdioDef('fix'), noopResolve, NO_WARN)
      },
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      toolCallTimeoutMs: 100,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 },
    })
    handles.push(handle)
    await waitFor(() => handle.snapshot().phase === 'reconnecting', 'first bounded failure')
    await waitFor(() => handle.state.connected && handle.state.syncId === 1, 'reconnect onto the real server')
    const snap = handle.snapshot()
    expect(snap.phase).toBe('connected')
    // A healthy snapshot must never carry the previous outage's reason, and the
    // case is not vacuous: a real timeout was reported first.
    expect(snap.error).toBeUndefined()
    expect(lines.some((line) => line.level === 'warn' && /timed out/i.test(line.message))).toBe(true)
  })
})

describe('runtime snapshot + probe (M3)', () => {
  it('reports connected phase, timestamps and committed tool identity after a sync', async () => {
    const { handle } = await boot()
    handles.push(handle)
    const snap = handle.snapshot()
    expect(snap.phase).toBe('connected')
    expect(snap.toolCount).toBe(handle.state.defs.size)
    expect(snap.toolCount).toBeGreaterThan(0)
    expect(snap.attempts).toBe(0)
    expect(snap.maxAttempts).toBe(RECONNECT_DEFAULTS.maxAttempts)
    expect(typeof snap.connectedAt).toBe('number')
    expect(typeof snap.syncedAt).toBe('number')
    const tools = handle.tools()
    expect(tools.map((tool) => tool.rawName)).toContain('add')
    expect(tools.find((tool) => tool.publicName === 'mcp__fix__add')?.description).toBe('Adds two numbers.')
  })

  it('reports failed with the next-retry bookkeeping after the budget is exhausted', async () => {
    const { log, lines } = makeLogger()
    const handle = startServerSupervisor({
      serverName: 'ghost',
      buildTransport: async () =>
        createTransport(stdioDef('ghost', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 },
    })
    handles.push(handle)
    await handle.ready
    // A retry is armed first: the snapshot must say so before the budget ends.
    await waitFor(() => handle.snapshot().phase === 'reconnecting' || handle.snapshot().phase === 'failed', 'retry state')
    await waitFor(() => handle.snapshot().phase === 'failed', 'failed phase')
    const snap = handle.snapshot()
    expect(snap.maxAttempts).toBe(2)
    expect(snap.attempts).toBeGreaterThan(2)
    expect(snap.toolCount).toBe(0)
    expect(snap.error).toBeTruthy()
    expect(lines.some((l) => l.message.includes('giving up'))).toBe(true)
  })

  it('probes with a throwaway connection and reports its tool count / failure', async () => {
    const result = await probeServer({
      serverName: 'probe',
      buildTransport: () => createTransport(stdioDef('probe'), noopResolve, NO_WARN),
    })
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBeGreaterThan(0)

    const failed = await probeServer({
      serverName: 'probe',
      buildTransport: () =>
        createTransport(stdioDef('probe', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
    })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeTruthy()
  })
})

describe('resolveReconnectPolicy', () => {
  it('returns frozen official defaults for an omitted config', () => {
    const policy = resolveReconnectPolicy(undefined, 'mcp-scope(x): reconnect')
    expect(policy).toEqual(RECONNECT_DEFAULTS)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('rejects unknown keys, out-of-range delays, and invalid attempts', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 0 } as never, 'p')).toThrow(/positive finite/)
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 } as never, 'p')).toThrow(/positive integer/)
    expect(() => resolveReconnectPolicy({ notAnOption: true } as never, 'p')).toThrow(/not a reconnect option/)
  })

  it('resolves partial overrides onto the defaults', () => {
    const policy = resolveReconnectPolicy({ initialDelayMs: 100, maxAttempts: 2 }, 'p')
    expect(policy).toEqual({ enabled: true, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 2 })
  })
})
