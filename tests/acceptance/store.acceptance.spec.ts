/**
 * INDEPENDENT acceptance suite, C4 axis 1 (CORRECTNESS) and axis 3
 * (OPTIMALITY) for the browser-side runtime store (src/client/runtime.ts).
 *
 * Contract-first: these tests encode the FROZEN contracts (C2 + the
 * deployment-base matrix) and are expected to fail until the implementation
 * lands. Fetch is injected, so no browser or host is involved; every
 * request-count assertion reads the injected transport call log.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_ACTION_PATH,
  RUNTIME_STATUS_PATH,
  RUNTIME_TOOLS_PATH,
  RuntimeCallError,
  createRuntimeStore,
  readBasePath,
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

/** The chamber desktop shell's static layer answer for an unmounted route. */
const shell404 = (): Response =>
  new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })

/** OUR wire envelope carrying a business failure (404 not-found). */
const business404 = (message = 'no such server'): Response =>
  json({ ok: false, error: { code: 'not-found', message } }, 404)

const setBase = (value: unknown): void => {
  ;(globalThis as Record<string, unknown>).__DSH_BASE_PATH__ = value
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__DSH_BASE_PATH__
})

describe('C4 correctness: deployment-base matrix', () => {
  it('[correctness] deployment-base matrix: no global means one root-relative request', async () => {
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return statusOk(1, [view('a')])
      },
    })
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
  })

  it('[correctness] deployment-base matrix: a global /api/i/<id> prefixes every route', async () => {
    setBase('/api/i/instance-7')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input, init) => {
        const url = String(input)
        calls.push(url)
        if (init?.method === 'POST') return json({ ok: true, value: { name: 'a', state: 'connecting' } })
        if (url.includes(RUNTIME_TOOLS_PATH)) {
          return json({ ok: true, value: { tools: [], truncated: false, total: 0 } })
        }
        return statusOk(3, [view('a')])
      },
    })
    await store.refresh()
    await store.refresh({ server: 'a' })
    await store.act('a', 'connect')
    void store.tools('a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toContain('/api/i/instance-7' + RUNTIME_STATUS_PATH)
    expect(calls).toContain('/api/i/instance-7' + RUNTIME_STATUS_PATH + '?server=a')
    expect(calls).toContain('/api/i/instance-7' + RUNTIME_ACTION_PATH)
    expect(calls).toContain('/api/i/instance-7' + RUNTIME_TOOLS_PATH + '?server=a')
    expect(calls.some((url) => url === RUNTIME_STATUS_PATH)).toBe(false)
  })

  it('[correctness] deployment-base matrix: sloppy values are refused or normalized', async () => {
    const normalized: [unknown, string | undefined][] = [
      ['  /api/i/local/  ', '/api/i/local'],
      ['/api/i/local//', '/api/i/local'],
      ['/api/i/local', '/api/i/local'],
    ]
    for (const [value, expected] of normalized) {
      setBase(value)
      expect(readBasePath(), JSON.stringify(value)).toBe(expected)
    }
    const refused: unknown[] = [
      '//evil.example/x',
      'http://127.0.0.1:17510',
      'https://evil.example/api/i/1',
      'api/i/local',
      '',
      '/',
      '///triple',
      42,
      null,
      undefined,
      {},
      ['/api/i/x'],
    ]
    for (const value of refused) {
      setBase(value)
      expect(readBasePath(), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('[correctness] deployment-base matrix: an unsafe global never changes the request path', async () => {
    for (const value of ['//evil.example/x', 'http://127.0.0.1:17510', 42, '/', 'api/i/relative'] as const) {
      setBase(value)
      const calls: string[] = []
      const store = createRuntimeStore({
        fetchLike: async (input) => {
          calls.push(String(input))
          return statusOk(1, [])
        },
      })
      await store.refresh()
      expect(calls, JSON.stringify(value)).toEqual([RUNTIME_STATUS_PATH])
    }
  })

  it('[correctness] deployment-base matrix: a sloppy base is normalized before it is used', async () => {
    setBase('  /api/i/local/  ')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return statusOk(1, [])
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
  })

  it('[correctness] deployment-base matrix: origin 404 without envelope falls back once and is remembered', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return String(input).startsWith('/api/i/local') ? shell404() : statusOk(5, [view('a')])
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
    calls.length = 0
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
    calls.length = 0
    await store.refresh({ server: 'a' })
    expect(calls).toEqual([RUNTIME_STATUS_PATH + '?server=a'])
  })

  it('[correctness] deployment-base matrix: OUR business 404 envelope is never retried', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return business404()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('error')
    expect(store.getSnapshot().error).toBe('no such server')
    calls.length = 0
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
  })

  it('[correctness] deployment-base matrix: a transport error never falls back', async () => {
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

  it('[correctness] deployment-base matrix: a non-404 origin answer without the envelope is reported, not retried', async () => {
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

describe('C4 correctness: per-server refresh', () => {
  it('[correctness] per-server refresh issues exactly one request at the encoded ?server= URL', async () => {
    const serverName = 'a b&c=d'
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return statusOk(4, [view('a b&c=d')])
      },
    })
    await store.refresh({ server: serverName })
    expect(calls).toEqual([RUNTIME_STATUS_PATH + '?server=' + encodeURIComponent(serverName)])
    expect(store.getSnapshot().phase).toBe('ready')
    expect(store.getSnapshot().servers[serverName]?.name).toBe(serverName)
  })

  it('[correctness] per-server refresh merges one entry and leaves every other entry and field intact', async () => {
    const calls: string[] = []
    let callsSoFar = 0
    const beta = view('beta', 'failed', {
      attempts: 4,
      nextRetryAt: 1_234,
      toolCount: 0,
      error: { code: 'connection-failed', message: 'Connection failed' },
    })
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        callsSoFar += 1
        if (callsSoFar === 1) return statusOk(10, [view('alpha'), beta])
        return statusOk(20, [view('alpha', 'stopped', { toolCount: 7 })])
      },
    })
    await store.refresh()
    await store.refresh({ server: 'alpha' })
    expect(calls).toEqual([RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH + '?server=alpha'])
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.at).toBe(20)
    expect(snapshot.servers.alpha).toEqual(view('alpha', 'stopped', { toolCount: 7 }))
    expect(snapshot.servers.beta).toEqual(beta)
  })

  it('[correctness] per-server refresh failure rejects and leaves the snapshot untouched', async () => {
    let callsSoFar = 0
    const store = createRuntimeStore({
      fetchLike: async () => {
        callsSoFar += 1
        return callsSoFar === 1 ? statusOk(10, [view('alpha'), view('beta')]) : business404('alpha vanished')
      },
    })
    await store.refresh()
    const before = store.getSnapshot()
    let thrown: unknown
    try {
      await store.refresh({ server: 'alpha' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RuntimeCallError)
    expect((thrown as RuntimeCallError).code).toBe('not-found')
    expect((thrown as RuntimeCallError).message).toBe('alpha vanished')
    expect(store.getSnapshot()).toEqual(before)
    expect(store.getSnapshot().phase).toBe('ready')
    expect(Object.keys(store.getSnapshot().servers).sort()).toEqual(['alpha', 'beta'])
  })

  it('[correctness] per-server refresh keeps its reject semantics with silent:true (the card call shape)', async () => {
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

  it('[correctness] a failed full refresh keeps the stale entries', async () => {
    let callsSoFar = 0
    const beta = view('beta', 'failed', { error: { code: 'gave-up', message: 'Reconnect attempts exhausted' } })
    const store = createRuntimeStore({
      fetchLike: async () => {
        callsSoFar += 1
        if (callsSoFar === 1) return statusOk(10, [view('alpha'), beta])
        throw new TypeError('fetch failed')
      },
    })
    await store.refresh()
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.servers.alpha).toEqual(view('alpha'))
    expect(snapshot.servers.beta).toEqual(beta)
    expect(snapshot.phase).toBe('unavailable')
    expect(snapshot.error).toContain('fetch failed')
  })

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

  it('[correctness] a per-server refresh is not silently absorbed by an in-flight full refresh', async () => {
    const calls: string[] = []
    let releaseFirst!: (response: Response) => void
    const store = createRuntimeStore({
      fetchLike: (input) => {
        const url = String(input)
        calls.push(url)
        if (calls.length === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve
          })
        }
        const server = url.includes('?server=') ? decodeURIComponent(url.split('?server=')[1] ?? '') : undefined
        return Promise.resolve(statusOk(9, server === undefined ? [view('alpha'), view('beta')] : [view(server)]))
      },
    })
    const full = store.refresh()
    const perServer = store.refresh({ server: 'alpha' })
    releaseFirst(statusOk(1, [view('alpha'), view('beta')]))
    await full
    await perServer
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toContain(RUNTIME_STATUS_PATH + '?server=alpha')
    expect(store.getSnapshot().servers.alpha).toBeDefined()
  })
})

describe('C4 optimality: publishes and notifications', () => {
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

  it('[optimality] one per-server refresh publishes exactly one snapshot', async () => {
    let callsSoFar = 0
    const store = createRuntimeStore({
      fetchLike: async () => {
        callsSoFar += 1
        return statusOk(callsSoFar, [view('alpha'), view('beta')])
      },
    })
    await store.refresh()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    // The card's real call shape (silent:true) still publishes exactly once.
    await store.refresh({ server: 'alpha', silent: true })
    expect(notifications).toBe(1)
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
