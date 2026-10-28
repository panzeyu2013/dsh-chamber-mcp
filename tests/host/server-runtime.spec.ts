// @vitest-environment node
/** Runtime snapshot, probe, resources and instructions over real stdio. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { RECONNECT_DEFAULTS, probeServer, startServerSupervisor } from '../../src/server.ts'
import { createTransport } from '../../src/transport.ts'
import {
  NO_WARN,
  boot,
  bootWithEnv,
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

  it('routes resource operations to the live generation and fails fast once it is gone', async () => {
    const { handle } = await boot()
    handles.push(handle)
    // Connected: the call must actually reach the server and come back with
    // the fixture's body. Asserting only "not our disconnected error" would
    // stay green if the provider threw anything at all.
    const read = await handle.context.resources.request(
      { method: 'resources/read', uri: 'file:///fixture-readme.txt' },
      execContext(),
    ) as { contents?: { text?: string }[] }
    expect(read.contents?.[0]?.text).toBe('fixture resource body')
    const listed = await handle.context.resources.request({ method: 'resources/list' }, execContext()) as { resources?: { uri?: string }[] }
    expect(listed.resources?.some((resource) => resource.uri === 'file:///fixture-readme.txt')).toBe(true)
    // URI TEMPLATES: the listed template has to come back with its uriTemplate,
    // and an EXPANDED uri has to read through the same provider — the two halves
    // that make a template useful.
    const templates = await handle.context.resources.request(
      { method: 'resources/templates/list' },
      execContext(),
    ) as { resourceTemplates?: { uriTemplate?: string; name?: string }[] }
    expect(templates.resourceTemplates?.map((template) => template.uriTemplate)).toEqual([
      'fixture:///greeting/{who}',
    ])
    const expanded = await handle.context.resources.request(
      { method: 'resources/read', uri: 'fixture:///greeting/ada' },
      execContext(),
    ) as { contents?: { text?: string }[] }
    expect(expanded.contents?.[0]?.text).toBe('fixture greeting for ada')
    await handle.dispose()
    await expect(handle.context.resources.request({ method: 'resources/list' }, execContext()))
      .rejects.toThrow(/server is disconnected/)
    await expect(handle.context.resources.request({ method: 'resources/templates/list' }, execContext()))
      .rejects.toThrow(/server is disconnected/)
  })

  it('answers both resource list methods with an empty page when the server declares no resources capability', async () => {
    // Official gate (0.2.1-rc.4+): an UNDECLARED resources capability is an
    // empty page answered WITHOUT asking the client. The SDK client would answer
    // empty too (plus a debug line), so the value alone cannot discriminate —
    // these prototype spies are what fail if the gate is removed.
    const listCalls = vi.spyOn(Client.prototype, 'listResources')
    const templateCalls = vi.spyOn(Client.prototype, 'listResourceTemplates')
    const { handle } = await bootWithEnv('nores', 'FIXTURE_NO_RESOURCES')
    // The gate keys on the CAPABILITY, not on the tool set: tools still sync.
    expect(handle.state.connected).toBe(true)
    expect(handle.state.defs.size).toBeGreaterThan(0)
    await expect(handle.context.resources.request({ method: 'resources/list' }, execContext()))
      .resolves.toEqual({ resources: [] })
    await expect(handle.context.resources.request({ method: 'resources/templates/list' }, execContext()))
      .resolves.toEqual({ resourceTemplates: [] })
    // A cursor is equally irrelevant when there is nothing to page through.
    await expect(handle.context.resources.request({ method: 'resources/list', cursor: 'next' }, execContext()))
      .resolves.toEqual({ resources: [] })
    // 'read' is NOT gated: an undeclared capability says nothing about URIs, so
    // the wire still answers for itself (and fails for itself).
    await expect(handle.context.resources.request(
      { method: 'resources/read', uri: 'file:///fixture-readme.txt' },
      execContext(),
    )).rejects.toThrow(/Method not found/)
    expect(listCalls).not.toHaveBeenCalled()
    expect(templateCalls).not.toHaveBeenCalled()
  })

  it('publishes the established generation instructions and clears them on disposal', async () => {
    const { handle } = await boot()
    handles.push(handle)
    expect(handle.context.instructions())
      .toBe('### MCP server: fix\n\nFixture guidance for MCP tools: call add before greet.')
    await handle.dispose()
    expect(handle.context.instructions()).toBe('')
  })

  it('fails the attempt when server instructions exceed MAX_INSTRUCTION_BYTES', async () => {
    const { handle, lines } = await bootWithEnv('huge', 'FIXTURE_HUGE_INSTRUCTIONS')
    // The oversized block fails the connect itself: no tools, no instructions,
    // and the reason names the bound.
    expect(handle.state.connected).toBe(false)
    expect(handle.state.defs.size).toBe(0)
    expect(handle.context.instructions()).toBe('')
    // The bound is the attempt's own failure text (the snapshot carries the
    // reconnect-disabled policy copy, by design).
    expect(handle.snapshot().error).toMatch(/reconnect is disabled/)
    expect(lines.some((line) => line.level === 'warn' && /MAX_INSTRUCTION_BYTES/.test(line.message))).toBe(true)
  })

  it('reports failed with the next-retry bookkeeping after the budget is exhausted', async () => {
    const { log, lines } = makeLogger()
    const handle = startServerSupervisor({
      ctx,
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
      ctx,
      serverName: 'probe',
      buildTransport: () => createTransport(stdioDef('probe'), noopResolve, NO_WARN),
    })
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBeGreaterThan(0)

    const failed = await probeServer({
      ctx,
      serverName: 'probe',
      buildTransport: () =>
        createTransport(stdioDef('probe', { command: '/nonexistent/definitely-missing', args: [] }), noopResolve, NO_WARN),
    })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeTruthy()
  })
})
