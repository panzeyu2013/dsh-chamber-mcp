// @vitest-environment node
/** Real stdio supervisor: superseded/throwing generations, disposal, retry. */
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_DEFS, startServerSupervisor } from '../../src/server.ts'
import { createTransport } from '../../src/transport.ts'
import {
  NO_WARN,
  boot,
  ctx,
  disposeHandles,
  handles,
  hangingCloseTransport,
  makeLogger,
  noopResolve,
  stdioDef,
  waitFor,
} from '../support/server-fixture.ts'

afterEach(disposeHandles)

describe('server supervisor with a real stdio MCP server', () => {
  it('closes a generation that disposal superseded while the transport was being built', async () => {
    // dispose() during `await buildTransport()` sees an UNATTACHED client and
    // confirms a close that never happened. Without the post-connect ownership
    // check the attempt then attaches and returns, leaving a live child process
    // nobody will reap (the official supervisor closes it there).
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let transportClosed = false
    const { log } = makeLogger()
    const handle = startServerSupervisor({
      ctx,
      serverName: 'fix',
      buildTransport: async () => {
        await gate
        const transport = await createTransport(stdioDef('fix'), noopResolve, NO_WARN)
        const close = transport.close.bind(transport)
        transport.close = async () => {
          transportClosed = true
          await close()
        }
        return transport
      },
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      reconnect: { enabled: false },
    })
    handles.push(handle)

    const disposal = handle.dispose()
    release?.()
    await disposal

    await waitFor(() => transportClosed, 'superseded generation closed')
    expect(handle.state.connected).toBe(false)
    expect(handle.state.defs).toBe(EMPTY_DEFS)
  })

  it('contains a throwing unregister push instead of rejecting unhandled', async () => {
    // The give-up continuation pushes an empty generation through the caller's
    // applier: a throw there used to become an unhandled rejection, which takes
    // the whole Host down (Node's default). It must be reported instead.
    const { log, lines } = makeLogger()
    const handle = startServerSupervisor({
      ctx,
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

  it('bounds a generation that never confirms close and reports it during disposal', async () => {
    const base = await createTransport(stdioDef('fix'), noopResolve, NO_WARN)
    const hanging = hangingCloseTransport(base)
    const { log, lines } = makeLogger()
    const handle = startServerSupervisor({
      ctx,
      serverName: 'fix',
      buildTransport: async () => hanging,
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      reconnect: { enabled: false },
      generationCloseTimeoutMs: 100,
    })
    try {
      await waitFor(() => handle.state.syncId === 1, 'initial sync before late close')
      const started = Date.now()
      await handle.dispose()
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(handle.snapshot().phase).toBe('stopped')
      expect(
        lines.some((line) => line.level === 'error' && line.message.includes('did not close within 100ms')),
      ).toBe(true)
    } finally {
      await handle.dispose().catch(() => {})
      // The wrapped transport never confirmed close, so the real child may
      // still be alive; close it directly and let the process exit.
      await base.close().catch(() => {})
    }
  })

})
