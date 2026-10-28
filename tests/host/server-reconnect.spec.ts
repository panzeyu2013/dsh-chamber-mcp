// @vitest-environment node
/** Real stdio supervisor: crash/reconnect, budget exhaustion and laundering. */
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_DEFS, startServerSupervisor } from '../../src/server.ts'
import { createTransport } from '../../src/transport.ts'
import {
  NO_WARN,
  boot,
  ctx,
  disposeHandles,
  execContext,
  handles,
  makeLogger,
  noopResolve,
  stdioDef,
  waitFor,
} from '../support/server-fixture.ts'

afterEach(disposeHandles)

describe('server supervisor with a real stdio MCP server', () => {
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
      ctx,
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
    // The give-up retracts the INSTRUCTIONS too, not just the tools: the
    // prompt section is live, so leaving it up would keep telling the model to
    // use mcp__fix__* names that no longer exist.
    expect(handle.context.instructions()).toBe('')
    const settled = commits.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(commits.length).toBe(settled)
  })

  it('resets the attempt budget once a connection outlives the stability window', async () => {
    const { log, lines } = makeLogger()
    const commits: { serverName: string; syncId: number; size: number }[] = []
    let attempts = 0
    const handle = startServerSupervisor({
      ctx,
      serverName: 'fix',
      buildTransport: async () => {
        attempts += 1
        // The FIRST attempt fails; the reconnect succeeds. That leaves the
        // outage counter at 1 before the server ever becomes stable, which is
        // what makes the stability-window reset observable: without it the
        // post-crash reconnect would be attempt 2 of maxAttempts=1 and give up.
        if (attempts === 1) throw new Error('first attempt fails')
        return createTransport(stdioDef('fix'), noopResolve, NO_WARN)
      },
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: (name, syncId, defs) => void commits.push({ serverName: name, syncId, size: defs.size }),
      reconnect: { initialDelayMs: 20, maxDelayMs: 120, maxAttempts: 1 },
    })
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync after the retry')
    expect(attempts).toBe(2)
    // Stay up past the stability window, then crash: the outage counter starts
    // fresh, so maxAttempts=1 still allows this single reconnect.
    await new Promise((resolve) => setTimeout(resolve, 220))
    await handle.state.defs.get('mcp__fix__crash')!.execute({}, execContext())

    await waitFor(() => handle.state.syncId === 2, 'reconnect after a stable uptime')
    expect(handle.state.connected).toBe(true)
    expect(commits.some((commit) => commit.size === 0)).toBe(false)
    expect(lines.some((line) => line.level === 'error' && line.message.includes('giving up'))).toBe(false)
  })

  it('retries a failed startup and reports the attempt budget', async () => {
    const { log, lines } = makeLogger()
    const commits: string[] = []
    const handle = startServerSupervisor({
      ctx,
      serverName: 'ghost',
      buildTransport: async () => createTransport(
        stdioDef('ghost', { command: '/nonexistent/definitely-missing', args: [] }),
        noopResolve,
        NO_WARN,
      ),
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => void commits.push('commit'),
      reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 60, maxAttempts: 3 },
    })
    handles.push(handle)
    await handle.ready
    expect(commits.length).toBe(0)
    await waitFor(() => lines.some((line) => line.message.includes('connection failed; retrying')), 'retry log')
    expect(lines.some((line) => line.level === 'warn' && line.message.includes('attempt 1/3'))).toBe(true)
  })
})
