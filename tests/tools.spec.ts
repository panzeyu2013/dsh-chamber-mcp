/**
 * Unit tests for the tool bridge (src/tools.ts): naming contract, definition
 * build, and executor mapping — mirroring the official mcp-client test cases
 * (ref-dsh mcp-client.spec.ts).
 */

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  HASH_LENGTH,
  MAX_PUBLIC_NAME_LENGTH,
  MAX_SYNC_PAGES,
  createDefinition,
  fetchToolDefinitions,
  publicToolName,
  renderResultText,
  type ListedTool,
} from '../src/tools.ts'

const testToolSignal = new AbortController().signal

function execContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    signal: testToolSignal,
    deferContext: () => {},
    concludeTurn: () => {},
    ...overrides,
  } as unknown as ToolRunContext
}

// ---- Hand-rolled mock MCP Client (official test pattern) ----

interface MockCallResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  isError?: boolean
  toolResult?: unknown
}

function createMockClient(tools: ListedTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (_params?: Record<string, unknown>): Promise<{ tools: ListedTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (_params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return listTools(request.params)
      if (request.method === 'tools/call') return callTool(request.params, undefined, options)
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const defaultOpts = { serverName: 'srv', toolCallTimeoutMs: 60_000 }

// ---- Naming (official cases) ----

describe('publicToolName', () => {
  it('joins clean names verbatim', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(publicToolName('everything', 'get-sum')).toBe('mcp__everything__get-sum')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = publicToolName('srv', 'admin.reset')
    expect(name).toMatch(/^mcp__srv__admin_reset_[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(64)
    const hash = createHash('sha256').update('srv\0admin.reset').digest('hex').slice(0, HASH_LENGTH)
    expect(name).toBe(`mcp__srv__admin_reset_${hash}`)
  })

  it('truncates over-long names and appends an identity hash', () => {
    const rawName = 'a'.repeat(80)
    const name = publicToolName('srv', rawName)
    expect(name).toHaveLength(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
    expect(name.startsWith('mcp__srv__aaa')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(MAX_PUBLIC_NAME_LENGTH)
  })

  it('is deterministic and collision-free for distinct identities', () => {
    // Two raw names that normalize to the same base must not collapse.
    const a = publicToolName('srv', 'admin.reset')
    const b = publicToolName('srv', 'admin_reset')
    expect(a).toBe(publicToolName('srv', 'admin.reset'))
    expect(a).not.toBe(b)
  })
})

// ---- Definition build ----

describe('fetchToolDefinitions', () => {
  it('sends the configured timeout on tools/list and tools/call', async () => {
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object', properties: {} } }])
    const defs = await fetchToolDefinitions(client as never, { serverName: 'srv', toolCallTimeoutMs: 1234 })
    const listCall = client.request.mock.calls.find(([request]) => request.method === 'tools/list')
    expect(listCall?.[2]).toEqual({ timeout: 1234 })
    const definition = defs.get('mcp__srv__t')!
    await definition.execute({}, execContext())
    const callCall = client.request.mock.calls.find(([request]) => request.method === 'tools/call')
    expect(callCall?.[2]).toMatchObject({ timeout: 1234 })
  })

  it('builds server-qualified definitions from the mock list', async () => {
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', inputSchema: { type: 'object', properties: {} } },
    ])
    const definitions = await fetchToolDefinitions(client as never, defaultOpts)
    expect([...definitions.keys()]).toEqual(['mcp__srv__greet', 'mcp__srv__add'])
    const greet = definitions.get('mcp__srv__greet')!
    expect(greet.description).toBe('Say hello')
    expect(greet.parameters).toEqual({ type: 'object', properties: { name: { type: 'string' } } })
    // Raw names are never public names.
    expect(definitions.has('greet')).toBe(false)
  })

  it('rejects a duplicate raw name in one list', async () => {
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])
    await expect(fetchToolDefinitions(client as never, defaultOpts)).rejects.toThrow(/more than once/)
  })

  it('refuses a server that lists more than MAX_SYNC_TOOLS tools (SEC-05 cap)', async () => {
    const big: ListedTool[] = []
    for (let i = 0; i < 2001; i++) big.push({ name: `tool-${i}`, inputSchema: { type: 'object' } })
    const client = createMockClient(big)
    await expect(fetchToolDefinitions(client as never, defaultOpts)).rejects.toThrow(/more than 2000 tools/)
  })

  it('paginates until the server stops returning a nextCursor', async () => {
    const pages: ListedTool[][] = [
      [{ name: 'a', inputSchema: { type: 'object' } }],
      [{ name: 'b', inputSchema: { type: 'object' } }],
      [],
    ]
    let page = 0
    const client = createMockClient([])
    client.listTools.mockImplementation(async (params?: Record<string, unknown>) => {
      const index = params?.cursor === undefined ? 0 : Number((params.cursor as string).split('-')[1]) + 1
      void page
      const next = pages[index]
      return { tools: next ?? [], nextCursor: index + 1 < pages.length ? `page-${index}` : undefined }
    })
    const definitions = await fetchToolDefinitions(client as never, defaultOpts)
    expect([...definitions.keys()]).toEqual(['mcp__srv__a', 'mcp__srv__b'])
  })

  it('rejects a server that repeats a tools/list continuation cursor (parity with the official bridge)', async () => {
    // A server echoing the same nextCursor can never terminate pagination.
    // Pages carry distinct names so the duplicate-name check cannot mask it.
    const client = createMockClient([])
    let page = 0
    client.listTools.mockImplementation(async () => ({
      tools: [{ name: `t${page++}`, inputSchema: { type: 'object' } }],
      nextCursor: 'stuck',
    }))
    await expect(fetchToolDefinitions(client as never, defaultOpts)).rejects.toThrow(/repeated a tools\/list continuation cursor/)
    // The loop is cut short rather than spinning: first page + the repeat.
    expect(client.listTools.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('rejects a server that keeps minting fresh cursors over empty pages (page cap)', async () => {
    // Empty pages defeat both other guards: no name repeats and no tool
    // accumulates, so without a page cap this loop never terminates.
    const client = createMockClient([])
    let page = 0
    client.listTools.mockImplementation(async () => ({ tools: [], nextCursor: `fresh-${page++}` }))
    await expect(fetchToolDefinitions(client as never, defaultOpts)).rejects.toThrow(/paginated past 2000 tools\/list pages/)
    expect(client.listTools.mock.calls.length).toBeLessThanOrEqual(MAX_SYNC_PAGES + 1)
  })

  it('accepts a longer pagination chain whose cursors are all distinct', async () => {
    const client = createMockClient([])
    client.listTools.mockImplementation(async (params?: Record<string, unknown>) => {
      const index = params?.cursor === undefined ? 0 : Number((params.cursor as string).split('-')[1]) + 1
      return {
        tools: [{ name: `t${index}`, inputSchema: { type: 'object' } }],
        nextCursor: index < 5 ? `page-${index}` : undefined,
      }
    })
    const definitions = await fetchToolDefinitions(client as never, defaultOpts)
    expect([...definitions.keys()]).toEqual(['mcp__srv__t0', 'mcp__srv__t1', 'mcp__srv__t2', 'mcp__srv__t3', 'mcp__srv__t4', 'mcp__srv__t5'])
  })
})

// ---- Executor mapping ----

describe('executor mapping', () => {
  it('sends the RAW name on the wire and returns the canonical value', async () => {
    const client = createMockClient([{ name: 'add', inputSchema: { type: 'object' } }])
    const definition = createDefinition(client as never, 'mcp__srv__add', { name: 'add', inputSchema: { type: 'object' } }, defaultOpts)
    const value = await definition.execute({ a: 1, b: 2 }, execContext())
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'add', arguments: { a: 1, b: 2 } },
      undefined,
      { signal: testToolSignal, timeout: 60_000 },
    )
    expect(value).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('forwards structuredContent when the server returns it', async () => {
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object' } }], {
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { answer: 42 },
    })
    const definition = createDefinition(client as never, 'mcp__srv__t', { name: 't', inputSchema: { type: 'object' } }, defaultOpts)
    const value = await definition.execute({}, execContext())
    expect(value).toEqual({ content: [{ type: 'text', text: 'x' }], structuredContent: { answer: 42 } })
  })

  it('throws on isError so the registry error path fires', async () => {
    const client = createMockClient([{ name: 'fail', inputSchema: { type: 'object' } }], {
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    })
    const definition = createDefinition(client as never, 'mcp__srv__fail', { name: 'fail', inputSchema: { type: 'object' } }, defaultOpts)
    await expect(definition.execute({}, execContext())).rejects.toThrow('Something went wrong')
  })

  it('rejects tools that require task-based execution at call time', async () => {
    const client = createMockClient([{ name: 'task', inputSchema: { type: 'object' } }])
    const definition = createDefinition(client as never, 'mcp__srv__task', {
      name: 'task',
      inputSchema: { type: 'object' },
      execution: { taskSupport: 'required' },
    }, defaultOpts)
    await expect(definition.execute({}, execContext())).rejects.toThrow(/task-based execution/)
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('maps non-object args to {} for the server param error', async () => {
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object' } }])
    const definition = createDefinition(client as never, 'mcp__srv__t', { name: 't', inputSchema: { type: 'object' } }, defaultOpts)
    await definition.execute('not-an-object', execContext())
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 't', arguments: {} },
      undefined,
      { signal: testToolSignal, timeout: 60_000 },
    )
  })

  it('forwards the abort signal to the SDK request', async () => {
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object' } }])
    const definition = createDefinition(client as never, 'mcp__srv__t', { name: 't', inputSchema: { type: 'object' } }, defaultOpts)
    const aborted = new AbortController()
    await definition.execute({}, execContext({ signal: aborted.signal } as never))
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 't', arguments: {} },
      undefined,
      { signal: aborted.signal, timeout: 60_000 },
    )
  })
})

// ---- render projection ----

describe('renderResultText', () => {
  it('joins text blocks with newlines', () => {
    expect(renderResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 't')).toBe('a\nb')
  })

  it('projects placeholders for image/audio/resource blocks', () => {
    const text = renderResultText([
      { type: 'text', text: 'here:' },
      { type: 'image', data: 'x', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'x', text: 'payload' } },
    ], 'img_tool')
    expect(text).toBe('here:\n[image: image/png, content discarded]\n[resource: content discarded]')
  })

  it('falls back to the no-text marker for empty content', () => {
    expect(renderResultText([], 'empty_tool')).toBe('(empty_tool returned no text content)')
  })

  it('is defensive against primitive and unknown blocks', () => {
    expect(renderResultText([42, { type: 'weird' }], 't'))
      .toBe('[unsupported content type: unknown]\n[unsupported content type: weird]')
  })
})
