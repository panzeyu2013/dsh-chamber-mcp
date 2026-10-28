// @vitest-environment node
/** Bounded handshake behavior against servers that never answer. */
import { afterEach, describe, expect, it } from 'vitest'
import { startServerSupervisor, type ServerSnapshot } from '../../src/server.ts'
import { createTransport } from '../../src/transport.ts'
import {
  NO_WARN,
  ctx,
  disposeHandles,
  handles,
  hungTransport,
  makeLogger,
  noopResolve,
  stdioDef,
  waitFor,
} from '../support/server-fixture.ts'

afterEach(disposeHandles)

describe('bounded connect against a server that never answers the handshake', () => {
  it('bounds the hung attempt with the configured timeout, not the SDK 60 s default', async () => {
    const { log, lines } = makeLogger()
    const received: string[][] = []
    const handle = startServerSupervisor({
      ctx,
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
    // Requiring the probe is what pins `versionNegotiation: {mode:'auto'}`:
    // dropping that option would send the legacy `initialize` first and this
    // assertion would fail.
    expect(received[0]?.some((message) => message.includes('server/discover'))).toBe(true)
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
      ctx,
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
      ctx,
      serverName: 'fix',
      buildTransport: async () => {
        attempts += 1
        // Attempt 1: the server never answers the handshake. Attempt 2: the
        // real fixture comes up, so the outage genuinely ends.
        return attempts === 1 ? hungTransport() : createTransport(stdioDef('fix'), noopResolve, NO_WARN)
      },
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      onDefsChanged: () => {},
      // The operator's per-server timeout ALSO bounds the handshake, so it has to
      // cover a real `node` spawn + initialize + sync. 1.5 s keeps a comfortable
      // margin over the ~250 ms real spawn while cutting the first hung attempt
      // from 3 s to 1.5 s (the test used to fail 2/3 at a 100 ms bound).
      toolCallTimeoutMs: 1500,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 },
    })
    handles.push(handle)
    await waitFor(() => handle.snapshot().phase === 'reconnecting', 'first bounded failure')
    // Room for the backoff plus every remaining attempt's own bound.
    await waitFor(() => handle.state.connected && handle.state.syncId === 1, 'reconnect onto the real server', 15000)
    const snap = handle.snapshot()
    expect(snap.phase).toBe('connected')
    // A healthy snapshot must never carry the previous outage's reason, and the
    // case is not vacuous: a real timeout was reported first.
    expect(snap.error).toBeUndefined()
    expect(lines.some((line) => line.level === 'warn' && /timed out/i.test(line.message))).toBe(true)
  })
})
