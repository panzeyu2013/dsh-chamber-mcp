// Registration-lane evidence: the diff between the MCP tools a session offered
// the model and the keyed views this plugin owns, plus the session-window
// observation that feeds it. No browser needed — both pieces are driven through
// their own boundaries (a registrar stub and fake observable sources).
import { describe, expect, it, vi } from 'vitest'
import type { ServerDef } from '../../src/shared/model.ts'
import {
  DEFAULT_TOOL_VIEW_LIMIT,
  createToolCardRegistry,
  startToolCardObserver,
  type SessionsLike,
  type SnapshotSource,
} from '../../src/client/tool-card/register.ts'

const SERVERS: ServerDef[] = [
  { serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.com/x' },
  { serverName: 'fixture', transport: 'stdio', command: 'node' },
]

/** Minimal observable source with a test-only publish. */
function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** Registrar stub recording registrations and disposals in order. */
function registrar() {
  const order: string[] = []
  const live = new Set<string>()
  return {
    order,
    live,
    host: {
      register(identity: { publicName: string }) {
        order.push(`+${identity.publicName}`)
        live.add(identity.publicName)
        return () => {
          order.push(`-${identity.publicName}`)
          live.delete(identity.publicName)
        }
      },
    },
  }
}

const headerEntry = (names: readonly string[]) => ({
  type: 'event',
  event: { type: 'request/header', data: { header: { tools: names.map((name) => ({ name })) } } },
})

describe('tool view registry', () => {
  it('registers discovered MCP names once and ignores everything else', () => {
    const sink = registrar()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS })
    registry.sync(['mcp__github__search', 'bash', 'mcp__fixture__greet'])
    registry.sync(['mcp__github__search', 'bash', 'mcp__fixture__greet'])
    expect(sink.order).toEqual(['+mcp__github__search', '+mcp__fixture__greet'])
    expect(registry.size()).toBe(2)
  })

  it('disposes a name that left the window and re-registers a reshaped identity', () => {
    const sink = registrar()
    let servers: ServerDef[] = SERVERS
    const registry = createToolCardRegistry({ host: sink.host, servers: () => servers })
    registry.sync(['mcp__github__search'])
    // The document switches the server's transport: the captured identity is
    // stale, so the view is replaced.
    servers = [{ serverName: 'github', transport: 'stdio', command: 'node' }]
    registry.sync(['mcp__github__search'])
    expect(sink.order).toEqual(['+mcp__github__search', '-mcp__github__search', '+mcp__github__search'])
    // The tool disappears entirely (server removed, session revisited).
    registry.sync([])
    expect(sink.live.size).toBe(0)
    expect(registry.size()).toBe(0)
  })

  it('re-runs the last reconciliation on demand (settings commit reshaping)', () => {
    const sink = registrar()
    let servers: ServerDef[] = SERVERS
    const registry = createToolCardRegistry({ host: sink.host, servers: () => servers })
    registry.sync(['mcp__github__search'])
    servers = [{ serverName: 'github', transport: 'stdio', command: 'node' }]
    registry.resync()
    expect(sink.order).toEqual(['+mcp__github__search', '-mcp__github__search', '+mcp__github__search'])
  })

  it('leaves a refused registration unrecorded and retries it on the next pass', () => {
    const okay = registrar()
    let failFirst = true
    const host = {
      register(identity: { publicName: string }) {
        // First attempt for each name is refused (the lane's slot-registration
        // failure path), later passes succeed — the name must not be recorded
        // as applied in between.
        if (failFirst) return undefined
        return okay.host.register(identity)
      },
    }
    const registry = createToolCardRegistry({ host, servers: () => SERVERS })
    registry.sync(['mcp__github__search'])
    expect(registry.size()).toBe(0)
    failFirst = false
    registry.resync()
    expect(okay.order).toEqual(['+mcp__github__search'])
    expect(registry.size()).toBe(1)
  })

  it('caps the registered set and reports the first refused name per call', () => {
    const sink = registrar()
    const onRefuse = vi.fn()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS, limit: 1, onRefuse })
    registry.sync(['mcp__github__a', 'mcp__github__b', 'mcp__github__c'])
    expect(registry.size()).toBe(1)
    expect(sink.live.has('mcp__github__a')).toBe(true)
    expect(onRefuse.mock.calls.map(([name]) => name)).toEqual(['mcp__github__b', 'mcp__github__c'])
    expect(DEFAULT_TOOL_VIEW_LIMIT).toBeGreaterThan(1)
  })

  it('reports a failed reconciliation instead of throwing into the publisher', () => {
    // sync() runs from a session-window subscription and from the settings
    // store: a throw would surface as a broken transcript or a broken settings
    // panel, so the lane reports through onError and keeps the shipped rows.
    const onError = vi.fn()
    const registry = createToolCardRegistry({
      host: { register: () => () => {} },
      servers: () => {
        throw new Error('document unavailable')
      },
      onError,
    })
    expect(() => registry.sync(['mcp__github__search'])).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(registry.size()).toBe(0)
    expect(() => registry.resync()).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('disposes everything on teardown and ignores later syncs', () => {
    const sink = registrar()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS })
    registry.sync(['mcp__github__search', 'mcp__fixture__greet'])
    registry.dispose()
    expect(sink.live.size).toBe(0)
    registry.sync(['mcp__github__other'])
    expect(sink.live.size).toBe(0)
    registry.dispose() // idempotent
  })
})

describe('session window observer', () => {
  it('feeds the registry from the staged session and follows the stage', () => {
    const sink = registrar()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS })
    const first = source({ entries: [headerEntry(['mcp__github__search'])] })
    const second = source({ entries: [headerEntry(['mcp__fixture__greet'])] })
    const list = source<{ current?: unknown }>({ current: 's1' })
    const sessions: SessionsLike = {
      list,
      binding: (id) => (id === 's1' ? { eventSource: first } : id === 's2' ? { eventSource: second } : undefined),
    }
    const stop = startToolCardObserver({ sessions, registry })
    expect(sink.order).toEqual(['+mcp__github__search'])

    // Switching the stage keeps the earlier registrations (a revisited session
    // must not lose its rows) and adds the new session's tools.
    list.publish({ current: 's2' })
    expect(sink.order).toEqual(['+mcp__github__search', '+mcp__fixture__greet'])
    expect(first.listenerCount()).toBe(0)

    // A later header in the same session adds the tools it offered.
    second.publish({ entries: [headerEntry(['mcp__fixture__greet', 'mcp__fixture__echo'])] })
    expect(sink.live.has('mcp__fixture__echo')).toBe(true)

    // An unknown/absent stage keeps the registered set (rows in history stay
    // custom) and detaches the previous window.
    list.publish({ current: 'missing' })
    expect(second.listenerCount()).toBe(0)
    expect(registry.size()).toBe(3)

    stop()
    expect(list.listenerCount()).toBe(0)
  })

  it('is a no-op without the sessions service (feature degrades, nothing throws)', () => {
    const sink = registrar()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS })
    const stop = startToolCardObserver({ sessions: undefined, registry })
    expect(sink.order).toEqual([])
    stop()
  })

  it('tolerates a session whose binding or window is not there yet', () => {
    const sink = registrar()
    const registry = createToolCardRegistry({ host: sink.host, servers: () => SERVERS })
    const list = source<{ current?: unknown }>({ current: undefined })
    const sessions: SessionsLike = { list, binding: () => undefined }
    const stop = startToolCardObserver({ sessions, registry })
    list.publish({ current: 's1' })
    expect(sink.order).toEqual([])
    stop()
  })
})

describe('observable source typing', () => {
  it('exposes the snapshot/subscribe pair the observer consumes', () => {
    const list: SnapshotSource<{ current?: unknown }> = source({ current: 's1' })
    expect(list.getSnapshot().current).toBe('s1')
  })
})
