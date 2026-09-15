/**
 * Runtime-status store tests (src/client/runtime.ts): envelope folding,
 * degradation, stale-while-revalidate, full/per-server in-flight dedupe, merge
 * isolation for a per-server refresh, the deployment base path and the action
 * calls. Fetch is injected, so no browser or host is involved.
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

  it('keeps the stale server views when a full refresh fails', async () => {
    let mode: 'ok' | 'business' | 'transport' = 'ok'
    const store = createRuntimeStore({
      fetchLike: async () => {
        if (mode === 'transport') throw new TypeError('fetch failed')
        if (mode === 'business') return json({ ok: false, error: { code: 'boom', message: 'nope' } })
        return json({ ok: true, value: { v: 1, at: 9, servers: [view('a'), view('b', 'failed')] } })
      },
    })
    await store.refresh()
    mode = 'business'
    await store.refresh()
    expect(store.getSnapshot().phase).toBe('error')
    expect(store.getSnapshot().error).toBe('nope')
    expect(store.getSnapshot().servers.a?.name).toBe('a')
    expect(store.getSnapshot().servers.b?.state).toBe('failed')
    expect(store.getSnapshot().at).toBe(9)
    // A transport failure degrades to unavailable, still on the stale views.
    mode = 'transport'
    await store.refresh()
    expect(store.getSnapshot().phase).toBe('unavailable')
    expect(store.getSnapshot().error).toContain('fetch failed')
    expect(store.getSnapshot().servers.b?.state).toBe('failed')
    expect(store.getSnapshot().at).toBe(9)
  })
})

describe('runtime store per-server refresh', () => {
  it('merges one server view and leaves the others untouched', async () => {
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        if (String(input) === RUNTIME_STATUS_PATH) {
          return json({ ok: true, value: { v: 1, at: 10, servers: [view('a'), view('b', 'failed')] } })
        }
        return json({ ok: true, value: { v: 1, at: 11, servers: [view('a', 'connecting')] } })
      },
    })
    await store.refresh()
    const before = store.getSnapshot()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    calls.length = 0
    await store.refresh({ server: 'a' })
    // Exactly ONE request, against the per-server URL.
    expect(calls).toEqual([RUNTIME_STATUS_PATH + '?server=a'])
    // Exactly ONE notification for the merge.
    expect(notified).toBe(1)
    const after = store.getSnapshot()
    expect(after.phase).toBe('ready')
    expect(after.at).toBe(11)
    expect(after.servers.a?.state).toBe('connecting')
    // The other server's entry survives, identity included.
    expect(after.servers.b).toBe(before.servers.b)
  })

  it('URL-encodes the requested server name', async () => {
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return json({ ok: true, value: { v: 1, at: 1, servers: [view('a b/c')] } })
      },
    })
    await store.refresh({ server: 'a b/c' })
    expect(calls).toEqual([RUNTIME_STATUS_PATH + '?server=a%20b%2Fc'])
  })

  it('rejects on failure and leaves the snapshot untouched', async () => {
    let mode: 'ok' | 'business' | 'transport' = 'ok'
    const store = createRuntimeStore({
      fetchLike: async () => {
        if (mode === 'transport') throw new TypeError('fetch failed')
        if (mode === 'business') {
          return json({ ok: false, error: { code: 'not-connected', message: 'no such server' } }, 409)
        }
        return json({ ok: true, value: { v: 1, at: 3, servers: [view('a'), view('b')] } })
      },
    })
    await store.refresh()
    const before = store.getSnapshot()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    mode = 'business'
    let business: unknown
    try {
      await store.refresh({ server: 'a' })
    } catch (error) {
      business = error
    }
    expect(business).toBeInstanceOf(RuntimeCallError)
    expect((business as RuntimeCallError).code).toBe('not-connected')
    mode = 'transport'
    let transport: unknown
    try {
      await store.refresh({ server: 'a' })
    } catch (error) {
      transport = error
    }
    expect(transport).toBeInstanceOf(RuntimeCallError)
    expect((transport as RuntimeCallError).code).toBe('unavailable')
    // No phase flip, no cleared map, no notification: the card owns the error.
    expect(notified).toBe(0)
    expect(store.getSnapshot()).toBe(before)
  })

  it('dedupes concurrent per-server refreshes for the same server', async () => {
    let resolveFetch!: (response: Response) => void
    let calls = 0
    const store = createRuntimeStore({
      fetchLike: () => {
        calls += 1
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      },
    })
    const first = store.refresh({ server: 'a' })
    const second = store.refresh({ server: 'a' })
    expect(calls).toBe(1)
    resolveFetch(json({ ok: true, value: { v: 1, at: 4, servers: [view('a')] } }))
    await Promise.all([first, second])
    expect(store.getSnapshot().at).toBe(4)
  })

  it('is not absorbed into an in-flight full refresh', async () => {
    const calls: string[] = []
    let resolveFull!: (response: Response) => void
    let resolveOne!: (response: Response) => void
    const store = createRuntimeStore({
      fetchLike: (input) => {
        calls.push(String(input))
        return new Promise<Response>((resolve) => {
          if (String(input) === RUNTIME_STATUS_PATH) resolveFull = resolve
          else resolveOne = resolve
        })
      },
    })
    const full = store.refresh()
    const one = store.refresh({ server: 'a' })
    // Its own request, not a join on the pending full pass.
    expect(calls).toEqual([RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH + '?server=a'])
    resolveFull(json({ ok: true, value: { v: 1, at: 1, servers: [view('a'), view('b')] } }))
    await full
    expect(store.getSnapshot().at).toBe(1)
    resolveOne(json({ ok: true, value: { v: 1, at: 2, servers: [view('a', 'failed')] } }))
    await one
    // The per-server pass published its own merged view, not the full result.
    expect(store.getSnapshot().at).toBe(2)
    expect(store.getSnapshot().servers.a?.state).toBe('failed')
    expect(store.getSnapshot().servers.b?.name).toBe('b')
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

describe('runtime store: deployment base path', () => {
  const setBase = (value: unknown): void => {
    ;(globalThis as Record<string, unknown>).__DSH_BASE_PATH__ = value
  }
  const setLocation = (pathname: string | undefined, origin = 'http://localhost'): void => {
    Object.defineProperty(globalThis, 'location', {
      value: pathname === undefined ? undefined : { pathname, origin, href: origin + pathname },
      configurable: true,
      writable: true,
    })
  }
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__DSH_BASE_PATH__
    delete (globalThis as Record<string, unknown>).location
  })

  /** What the chamber desktop shell's static layer answers for an unknown route. */
  const shell404 = (): Response =>
    new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  const statusOk = (): Response => json({ ok: true, value: { v: 1, at: 7, servers: [view('a')] } })

  it('leaves the plain dsh web topology untouched: root-relative, one request', async () => {
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return statusOk()
      },
    })
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
  })

  it('prefixes every route when the shell publishes an instance base', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input, init) => {
        calls.push(String(input))
        if (String(input).startsWith('/api/i/local' + RUNTIME_TOOLS_PATH)) {
          return json({ ok: true, value: { tools: [], truncated: false } })
        }
        if (init?.method === 'POST') return json({ ok: true, value: { name: 'x', state: 'connecting' } })
        return statusOk()
      },
    })
    await store.refresh()
    await store.act('x', 'connect')
    await store.tools('a')
    expect(calls).toContain('/api/i/local' + RUNTIME_STATUS_PATH)
    expect(calls).toContain('/api/i/local' + RUNTIME_ACTION_PATH)
    expect(calls).toContain('/api/i/local' + RUNTIME_TOOLS_PATH + '?server=a')
    expect(calls.some((url) => url === RUNTIME_STATUS_PATH)).toBe(false)
  })

  it('normalizes a sloppy base and refuses unsafe or non-string values', () => {
    setBase('  /api/i/local/  ')
    expect(readBasePath()).toBe('/api/i/local')
    for (const unsafe of ['//evil.example/x', 'http://127.0.0.1:17510', 'api/i/local', '', '/', 42, null, undefined]) {
      setBase(unsafe)
      expect(readBasePath()).toBeUndefined()
    }
  })

  it('falls back to the root origin when the base is not mounted, then remembers it', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return String(input).startsWith('/api/i/local') ? shell404() : statusOk()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
    calls.length = 0
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
  })

  it('answers from the prefixed base without a fallback request when it works', async () => {
    setBase('/api/i/remote-1')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return String(input).startsWith('/api/i/remote-1') ? statusOk() : shell404()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/remote-1' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
  })

it('takes the prefix from the serving location when no global is published', async () => {
    setLocation('/api/i/local/')
    expect(readBasePath()).toBe('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return statusOk()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('ready')
  })

  it('reads the location prefix without a trailing slash and for other instance ids', () => {
    setLocation('/api/i/local')
    expect(readBasePath()).toBe('/api/i/local')
    setLocation('/api/i/remote-7/assets/index.html')
    expect(readBasePath()).toBe('/api/i/remote-7')
  })

  it('leaves a plain document and unrelated paths alone', () => {
    for (const pathname of ['/', '/index.html', '/api/settings/describe', '/api/i/', '/api/instances/local']) {
      setLocation(pathname)
      expect(readBasePath()).toBeUndefined()
    }
    setLocation(undefined)
    expect(readBasePath()).toBeUndefined()
  })

  /** Stub the resource timeline / DOM lookups this discovery walks. */
  const setSources = (resources: string[], attributes: string[] = []): (() => void) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    Object.defineProperty(globalThis, 'performance', {
      value: { getEntriesByType: (type: string) => (type === 'resource' ? resources.map((name) => ({ name })) : []) },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: {
        querySelectorAll: () =>
          attributes.map((attribute) => ({
            getAttribute: (name: string) => (name === 'src' || name === 'href' ? attribute : null),
          })),
      },
      configurable: true,
      writable: true,
    })
    return () => {
      if (original !== undefined) Object.defineProperty(globalThis, 'performance', original)
      delete (globalThis as Record<string, unknown>).document
    }
  }

  it('discovers the instance prefix from already-loaded resources', () => {
    // The chamber shell serves the dsh UI into its own document at "/" and
    // fetches every module and API through the instance proxy, so the prefix is
    // observable only in the resource timeline (this plugin's own bundle is
    // fetched from /api/i/<id>/plugins/...).
    const restore = setSources(['/api/i/local/plugins/??dsh-chamber-mcp/client.js&rev=abc-53'])
    try {
      expect(readBasePath()).toBe('/api/i/local')
    } finally {
      restore()
    }
  })

  it('reads the prefix from script/link tags when the timeline has none', () => {
    const restore = setSources([], ['/api/i/tagged-1/assets/index.js'])
    try {
      expect(readBasePath()).toBe('/api/i/tagged-1')
    } finally {
      restore()
    }
  })

  it('ignores a cross-origin resource that happens to carry the prefix shape', () => {
    setLocation('/', 'http://127.0.0.1:17500')
    const restore = setSources(['https://cdn.example.com/api/i/local/asset.js'])
    try {
      expect(readBasePath()).toBeUndefined()
    } finally {
      restore()
      delete (globalThis as Record<string, unknown>).location
    }
  })

  it('reads the prefix from fully qualified URLs and ignores prefixless ones', () => {
    setLocation('/', 'http://127.0.0.1:17500')
    let restore = setSources(['http://127.0.0.1:17500/api/i/remote-9/plugins/x.js?rev=1'])
    try {
      expect(readBasePath()).toBe('/api/i/remote-9')
    } finally {
      restore()
      delete (globalThis as Record<string, unknown>).location
    }
    restore = setSources(['/plugins/x/client.js', '/api/i/', '/api/instances/local'])
    try {
      expect(readBasePath()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('prefers a freshly detected base over the remembered one (instance switch)', async () => {
    setBase('/api/i/A')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.startsWith('/api/i/A')) return json({ ok: true, value: { v: 1, at: 1, servers: [view('from-A')] } })
        if (url.startsWith('/api/i/B')) return json({ ok: true, value: { v: 1, at: 2, servers: [view('from-B')] } })
        return shell404()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/A' + RUNTIME_STATUS_PATH])
    // The page switches instance: the document now publishes B, and A still
    // answers — the remembered base must NOT win over the fresh signal.
    setBase('/api/i/B')
    calls.length = 0
    await store.refresh()
    expect(calls).toEqual(['/api/i/B' + RUNTIME_STATUS_PATH])
    expect(Object.keys(store.getSnapshot().servers)).toEqual(['from-B'])
  })

  it('never retries a base that answered without the wire envelope', async () => {
    setBase('/api/i/dead')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        const url = String(input)
        calls.push(url)
        return url.startsWith('/api/i/dead') ? shell404() : statusOk()
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/dead' + RUNTIME_STATUS_PATH, RUNTIME_STATUS_PATH])
    calls.length = 0
    await store.refresh()
    expect(calls).toEqual([RUNTIME_STATUS_PATH])
  })

  it('takes the NEWEST matching prefix when the timeline carries several instances', () => {
    const restore = setSources([
      'http://localhost/api/i/OLD/plugins/a.js',
      'http://localhost/api/i/OLD/api/session/list',
      'http://localhost/api/i/NEW/plugins/b.js',
    ])
    try {
      expect(readBasePath()).toBe('/api/i/NEW')
    } finally {
      restore()
    }
  })

  it('keeps the stale signal truthful after a per-server success', async () => {
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        const url = String(input)
        if (url.includes('?server=a')) return json({ ok: true, value: { v: 1, at: 3, servers: [view('a')] } })
        throw new TypeError('fetch failed')
      },
    })
    await store.refresh()
    expect(store.getSnapshot().phase).toBe('unavailable')
    await store.refresh({ server: 'a' })
    // One server answering does not prove the rest are fresh: the banner must stay.
    expect(store.getSnapshot().phase).toBe('unavailable')
    expect(store.getSnapshot().error).toContain('fetch failed')
    expect(store.getSnapshot().servers.a?.state).toBe('connected')
  })

  it('prefers an explicit global and ignores a malformed one', () => {
    setLocation('/api/i/local/')
    setBase('/api/i/global-1/')
    expect(readBasePath()).toBe('/api/i/global-1')
    setBase('//evil.example/x')
    expect(readBasePath()).toBe('/api/i/local')
  })

  it('never retries a business 404 that carries the wire envelope', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return new Response(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'no such server' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    await store.refresh()
    expect(calls).toEqual(['/api/i/local' + RUNTIME_STATUS_PATH])
    expect(store.getSnapshot().phase).toBe('error')
    expect(store.getSnapshot().error).toBe('no such server')
  })

  it('prefixes a per-server refresh and falls back from an unmounted base', async () => {
    setBase('/api/i/local')
    const calls: string[] = []
    const store = createRuntimeStore({
      fetchLike: async (input) => {
        calls.push(String(input))
        return String(input).startsWith('/api/i/local') ? shell404() : statusOk()
      },
    })
    await store.refresh({ server: 'a' })
    expect(calls).toEqual([
      '/api/i/local' + RUNTIME_STATUS_PATH + '?server=a',
      RUNTIME_STATUS_PATH + '?server=a',
    ])
    expect(store.getSnapshot().phase).toBe('ready')
    expect(store.getSnapshot().servers.a?.name).toBe('a')
    // The remembered root base answers directly afterwards.
    calls.length = 0
    await store.refresh({ server: 'a' })
    expect(calls).toEqual([RUNTIME_STATUS_PATH + '?server=a'])
  })
})