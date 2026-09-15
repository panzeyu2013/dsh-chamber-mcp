/**
 * Runtime-status store tests (src/client/runtime.ts): envelope folding,
 * degradation, in-flight dedupe and the action calls. Fetch is injected, so
 * no browser or host is involved.
 */

import { describe, expect, it } from 'vitest'
import {
  RUNTIME_ACTION_PATH,
  RUNTIME_STATUS_PATH,
  RUNTIME_TOOLS_PATH,
  RuntimeCallError,
  createRuntimeStore,
} from '../../src/client/runtime.js'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const view = (name: string, state = 'connected') => ({
  name,
  state,
  attempts: 0,
  maxAttempts: 10,
  toolCount: 2,
})

describe('runtime store refresh', () => {
  it('publishes the host view keyed by server name', async () => {
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return json({ ok: true, value: { v: 1, at: 5, servers: [view('a'), view('b', 'failed')] } })
      },
    })
    const seen: unknown[] = []
    store.subscribe(() => seen.push(store.getSnapshot()))
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.at).toBe(5)
    expect(snapshot.servers.a?.state).toBe('connected')
    expect(snapshot.servers.b?.state).toBe('failed')
    expect(seen.length).toBeGreaterThan(0)
  })

  it('degrades to unavailable when the route cannot be reached', async () => {
    const store = createRuntimeStore({
      fetchLike: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await store.refresh()
    expect(store.getSnapshot().phase).toBe('unavailable')
    expect(store.getSnapshot().error).toContain('fetch failed')
    // The document UI keeps working: running again recovers.
    const recovered = createRuntimeStore({
      fetchLike: async () => json({ ok: true, value: { v: 1, at: 1, servers: [] } }),
    })
    await recovered.refresh()
    expect(recovered.getSnapshot().phase).toBe('ready')
  })

  it('runs one trailing refresh when a poll was already in flight', async () => {
    let resolveFirst!: (response: Response) => void
    let calls = 0
    const store = createRuntimeStore({
      fetchLike: () => {
        calls += 1
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(json({ ok: true, value: { v: 1, at: 2, servers: [] } }))
      },
    })
    const first = store.refresh()
    void store.refresh({ silent: true }) // absorbed, but queues a trailing pass
    resolveFirst(json({ ok: true, value: { v: 1, at: 1, servers: [] } }))
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(2)
    expect(store.getSnapshot().at).toBe(2)
  })

  it('folds business failures into the error phase and dedupes in-flight runs', async () => {
    let resolveFetch!: (response: Response) => void
    let fetches = 0
    const store = createRuntimeStore({
      fetchLike: () => {
        fetches += 1
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      },
    })
    const first = store.refresh()
    const second = store.refresh()
    expect(fetches).toBe(1)
    resolveFetch(json({ ok: false, error: { code: 'boom', message: 'nope' } }))
    await Promise.all([first, second])
    expect(store.getSnapshot().phase).toBe('error')
    expect(store.getSnapshot().error).toBe('nope')
  })
})

describe('runtime store actions', () => {
  it('posts connect/disconnect bodies and refreshes afterwards', async () => {
    const requests: { url: string; body: unknown; method: string | undefined }[] = []
    const store = createRuntimeStore({
      fetchLike: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        })
        if (String(input) === RUNTIME_STATUS_PATH) {
          return json({ ok: true, value: { v: 1, at: 2, servers: [] } })
        }
        return json({ ok: true, value: { name: 'x', state: 'connecting' } })
      },
    })
    expect(await store.act('x', 'connect')).toEqual({ name: 'x', state: 'connecting' })
    expect(requests[0]).toEqual({
      url: RUNTIME_ACTION_PATH,
      method: 'POST',
      body: { action: 'connect', server: 'x' },
    })
    // The follow-up refresh is fire-and-forget; wait a tick for it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests.some((request) => request.url === RUNTIME_STATUS_PATH)).toBe(true)
  })

  it('returns probe results and throws typed call errors on refusals', async () => {
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        if (String(input).startsWith(RUNTIME_TOOLS_PATH)) {
          return json({ ok: true, value: { tools: [], truncated: false } })
        }
        if (String(input) === RUNTIME_ACTION_PATH) {
          return json({ ok: false, error: { code: 'disabled', message: 'server is disabled' } })
        }
        return json({ ok: true, value: { v: 1, at: 1, servers: [] } })
      },
    })
    let thrown: unknown
    try {
      await store.test('x')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RuntimeCallError)
    expect((thrown as RuntimeCallError).code).toBe('disabled')
    expect(await store.tools('a/b')).toEqual({ tools: [], truncated: false })
  })
})
