/**
 * Acceptance checks for runtime-store behaviors that are NOT already covered
 * by tests/client/runtime.spec.ts: transport-error and non-envelope base
 * handling, old-host version skew, the silent per-server reject shape, and
 * publish/notification counts. The full deployment-base matrix and the normal
 * per-server merge/failure cases live in the owner suite.
 *
 * Traceability: E3 runtime route, E8 degradation/base-path behavior.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_STATUS_PATH,
  RuntimeCallError,
  createRuntimeStore,
} from '../../src/client/runtime.js'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface View {
  name: string
  state: string
  attempts: number
  maxAttempts: number
  nextRetryAt?: number
  toolCount: number
  error?: { code: string; message: string }
}

const view = (name: string, state = 'connected', patch: Partial<View> = {}): View => ({
  name,
  state,
  attempts: 0,
  maxAttempts: 10,
  toolCount: 2,
  ...patch,
})

const statusOk = (at: number, servers: View[]): Response =>
  json({ ok: true, value: { v: 1, at, servers } })

/** OUR wire envelope carrying a business failure (404 not-found). */
const business404 = (message = 'no such server'): Response =>
  json({ ok: false, error: { code: 'not-found', message } }, 404)

const setBase = (value: unknown): void => {
  ;(globalThis as Record<string, unknown>).__DSH_BASE_PATH__ = value
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__DSH_BASE_PATH__
})

describe('acceptance correctness: base-path failure semantics', () => {
  it('[correctness] a transport error never falls back to another base', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        throw new TypeError('fetch failed')
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('unavailable')
    expect(store.getSnapshot().error).toContain('fetch failed')
  })

  it('[correctness] a non-404 origin answer without the envelope is reported, not retried', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return new Response('<html>gateway error</html>', { status: 500 })
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('unavailable')
  })
})

describe('acceptance correctness: version skew and silent per-server refresh', () => {
  it('[correctness] version skew: an OLD host that ignores ?server= returns the full view and the merge still lands', async () => {
    // A host from before this contract has no idea about the param: it answers
    // the full view. The client must merge whatever entries arrive (no 400/404
    // dependency) and keep the snapshot coherent.
    const calls: string[] = []
    let callsSoFar = 0
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        callsSoFar += 1
        if (callsSoFar === 1) return statusOk(10, [view('alpha'), view('beta')])
        return statusOk(30, [view('alpha', 'stopped'), view('beta', 'failed')])
      },
    })
    await store.refresh()
    await store.refresh({ server: 'alpha' })
    expect(calls).toEqual([RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH + '?server=alpha'])
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.at).toBe(30)
    expect(snapshot.servers.alpha?.state).toBe('stopped')
    expect(snapshot.servers.beta?.state).toBe('failed')
    expect(snapshot.error).toBeUndefined()
  })

  it('[correctness] per-server refresh keeps its reject semantics with silent:true', async () => {
    let callsSoFar = 0
    const store = createRuntimeStore({
      fetchLike: async () => {
        callsSoFar += 1
        return callsSoFar === 1 ? statusOk(10, [view('alpha')]) : business404('alpha vanished')
      },
    })
    await store.refresh()
    const before = store.getSnapshot()
    await expect(store.refresh({ server: 'alpha', silent: true })).rejects.toBeInstanceOf(RuntimeCallError)
    expect(store.getSnapshot()).toEqual(before)
  })
})

describe('acceptance optimality: publishes and notifications', () => {
  it('[optimality] one silent refresh publishes exactly one snapshot per subscriber', async () => {
    const store = createRuntimeStore({
      fetchLike: async () => statusOk(2, [view('a')]),
    })
    await store.refresh()
    const notifications: string[] = []
    store.subscribe(() => {
      notifications.push(JSON.stringify(store.getSnapshot()))
    })
    await store.refresh({ silent: true })
    expect(notifications).toHaveLength(1)
    expect(store.getSnapshot().phase).toBe('ready')
  })

  it('[optimality] one failed silent refresh publishes exactly one snapshot and keeps the stale entries', async () => {
    let callsSoFar = 0
    const store = createRuntimeStore({
      fetchLike: async () => {
        callsSoFar += 1
        if (callsSoFar === 1) return statusOk(5, [view('alpha')])
        throw new TypeError('fetch failed')
      },
    })
    await store.refresh()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    await store.refresh({ silent: true })
    expect(notifications).toBe(1)
    expect(store.getSnapshot().servers.alpha).toEqual(view('alpha'))
  })

  it('[optimality] an unsubscribed listener is never notified again', async () => {
    const store = createRuntimeStore({
      fetchLike: async () => statusOk(2, [view('a')]),
    })
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    unsubscribe()
    await store.refresh()
    expect(notifications).toBe(0)
  })
})
