/**
 * Unit tests for the tool bridge (src/tools.ts): the naming contract this
 * plugin owns, the listing/call wiring, and — since 0.0.4 — the EQUIVALENCE of
 * the two definition builders (the official `createMcpToolDefinition` adapter
 * and the local pre-2.0 fallback) plus the selection between them.
 *
 * The shared suite below runs the SAME assertions against both builders: that
 * is the anti-drift mechanism for keeping a 0.1.5 host on the old behavior and
 * a 0.1.6 host on the official one. What is NOT asserted here is the adapter's
 * own image admission (that is upstream's tested surface, and the fallback
 * deliberately lacks it).
 */

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  HASH_LENGTH,
  MAX_PUBLIC_NAME_LENGTH,
  MAX_SYNC_TOOLS,
  buildDefinitions,
  buildLocalToolDefinition,
  definitionBuilder,
  fetchToolDefinitions,
  publicToolName,
  renderResultText,
  reportSelection,
  selectDefinitionBuilder,
  type DefinitionBuilder,
  type DefinitionSelection,
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

/**
 * Bare plugin context: the composition mounts neither `attachments` nor `llm`,
 * which is exactly the shape both builders must diagnose identically for an
 * image-bearing result.
 */
const ctx = { get: () => undefined } as unknown as Context

/** One listed tool as the 2.0 client reports it. */
interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: unknown
  execution?: { taskSupport?: string }
}

interface MockCallResult {
  content: unknown
  structuredContent?: unknown
  isError?: boolean
}

function createMockClient(tools: MockTool[], capabilities: unknown = { tools: {} }, callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (_params?: unknown, _options?: unknown) => ({ tools }))
  const callTool = vi.fn(async (_params: unknown, _options?: unknown) => ({ ...callResult }))
  const getServerCapabilities = vi.fn(() => capabilities)
  return { listTools, callTool, getServerCapabilities }
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

// ---- Listing + call wiring ----

describe('fetchToolDefinitions', () => {
  it('builds server-qualified definitions from ONE aggregated listing', async () => {
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', inputSchema: { type: 'object', properties: {} } },
    ])
    const definitions = await fetchToolDefinitions(ctx, client as never, defaultOpts)
    // No caller-owned cursor loop: the 2.0 client aggregates every page itself
    // under its own non-converging-cursor defence (listMaxPages, default 64).
    expect(client.listTools).toHaveBeenCalledTimes(1)
    // The aggregated listing must carry the operator's per-server deadline:
    // HEAD passed it to every page request, and dropping it would leave a
    // handshake-then-stall server on the SDK's 60 s default.
    expect(client.listTools).toHaveBeenCalledWith(undefined, { cacheMode: 'refresh', timeout: 60_000 })
    expect([...definitions.keys()]).toEqual(['mcp__srv__greet', 'mcp__srv__add'])
    const greet = definitions.get('mcp__srv__greet')!
    expect(greet.description).toBe('Say hello')
    expect(greet.parameters).toEqual({ type: 'object', properties: { name: { type: 'string' } } })
    // Raw names are never public names.
    expect(definitions.has('greet')).toBe(false)
  })

  it('contributes no tools when the server does not advertise the tools capability', async () => {
    const client = createMockClient([{ name: 'add', inputSchema: { type: 'object' } }], {})
    const definitions = await fetchToolDefinitions(ctx, client as never, defaultOpts)
    expect(definitions.size).toBe(0)
    expect(client.listTools).not.toHaveBeenCalled()
  })

  it('rejects a duplicate raw name in one list', async () => {
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])
    await expect(fetchToolDefinitions(ctx, client as never, defaultOpts)).rejects.toThrow(/more than once/)
  })

  it('refuses a server that lists more than MAX_SYNC_TOOLS tools (SEC-05 cap)', async () => {
    const big: MockTool[] = []
    for (let i = 0; i < MAX_SYNC_TOOLS + 1; i++) big.push({ name: `tool-${i}`, inputSchema: { type: 'object' } })
    const client = createMockClient(big)
    await expect(fetchToolDefinitions(ctx, client as never, defaultOpts)).rejects.toThrow(new RegExp(`more than ${MAX_SYNC_TOOLS} tools`))
  })
})

// ---- Selection ----

describe('selectDefinitionBuilder', () => {
  it('takes the official adapter when the host namespace carries it', () => {
    expect(selectDefinitionBuilder({ createMcpToolDefinition })).not.toBe(buildLocalToolDefinition)
  })

  it('falls back when the export is absent — the 0.1.5 shape', () => {
    // 0.1.5 exports only {Config, apply, inject, name}, and a host without the
    // package at all lands in the same branch.
    expect(selectDefinitionBuilder({})).toBe(buildLocalToolDefinition)
    expect(selectDefinitionBuilder({ createMcpToolDefinition: undefined })).toBe(buildLocalToolDefinition)
    expect(selectDefinitionBuilder({ createMcpToolDefinition: 'not-a-function' })).toBe(buildLocalToolDefinition)
  })

  it('memoizes one process-wide answer and reports which path won', async () => {
    const first = await definitionBuilder()
    const second = await definitionBuilder()
    expect(first).toBe(second)
    // This dev tree installs 0.1.6, so the official path wins here.
    expect(first.official).toBe(true)
    expect(first.build).not.toBe(buildLocalToolDefinition)
  })
})

// ---- Production wiring (the builder that actually runs) ----

describe('definition wiring', () => {
  it('selects the OFFICIAL adapter on this host and uses it through the real listing path', async () => {
    // The selection itself is pinned...
    expect((await definitionBuilder()).official).toBe(true)
    // ...and the definitions the listing path produces carry the full official
    // contract (the projection hook included).
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object' } }])
    const definitions = await fetchToolDefinitions(ctx, client as never, defaultOpts)
    const definition = definitions.get('mcp__srv__t')
    expect(definition).toBeDefined()
    expect(definition!.finalizeContent).toBeTypeOf('function')
    // A silent swap to the fallback is caught BEHAVIORALLY: both builders now
    // implement the same contract, and the parity suites below hold each of
    // them to the deployed adapter's exact output.
  })

  it('drives the LOCAL fallback down the same listing path when it is selected', async () => {
    const client = createMockClient([{ name: 't', inputSchema: { type: 'object' } }])
    const definitions = await buildDefinitions(buildLocalToolDefinition, ctx, client as never, defaultOpts)
    expect(definitions.get('mcp__srv__t')).toBeDefined()
    expect(definitions.get('mcp__srv__t')!.finalizeContent).toBeTypeOf('function')
    // The 0.1.5 path keeps the same listing contract, deadline included.
    expect(client.listTools).toHaveBeenCalledWith(undefined, { cacheMode: 'refresh', timeout: 60_000 })
  })
})

describe('reportSelection', () => {
  it('reports a degraded selection exactly once per process', () => {
    const messages: string[] = []
    const fallback: DefinitionSelection = { build: buildLocalToolDefinition, official: false }
    reportSelection(fallback, 'srv', (message) => void messages.push(message))
    reportSelection(fallback, 'srv', (message) => void messages.push(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/does not provide createMcpToolDefinition/)
  })

  it('stays silent when the host provided the official adapter', () => {
    const messages: string[] = []
    reportSelection({ build: buildLocalToolDefinition, official: true }, 'srv', (message) => void messages.push(message))
    expect(messages).toHaveLength(0)
  })
})

// ---- Both builders, one suite (anti-drift) ----

const builders: Array<[string, DefinitionBuilder]> = [
  ['official adapter', selectDefinitionBuilder({ createMcpToolDefinition })],
  ['local fallback', buildLocalToolDefinition],
]

describe.each(builders)('definition build — %s', (_name, build) => {
  function definitionFor(tool: MockTool, client: ReturnType<typeof createMockClient>, opts = defaultOpts) {
    return build({ ctx, client: client as never, publicName: publicToolName('srv', tool.name), tool: tool as never, opts })
  }

  it('sends the RAW name, the configured timeout and the listed definition on tools/call', async () => {
    const tool: MockTool = { name: 'add', inputSchema: { type: 'object' } }
    const client = createMockClient([tool])
    const definition = definitionFor(tool, client, { serverName: 'srv', toolCallTimeoutMs: 1234 })
    const value = await definition.execute({ a: 1, b: 2 }, execContext())
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { signal: testToolSignal, timeout: 1234, toolDefinition: tool },
    )
    expect(value).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('forwards structuredContent when the server returns it', async () => {
    const tool: MockTool = { name: 't', inputSchema: { type: 'object' } }
    const client = createMockClient([tool], { tools: {} }, {
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { answer: 42 },
    })
    const value = await definitionFor(tool, client).execute({}, execContext())
    expect(value).toEqual({ content: [{ type: 'text', text: 'x' }], structuredContent: { answer: 42 } })
  })

  it('throws on isError so the registry error path fires', async () => {
    const tool: MockTool = { name: 'fail', inputSchema: { type: 'object' } }
    const client = createMockClient([tool], { tools: {} }, {
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    })
    await expect(definitionFor(tool, client).execute({}, execContext())).rejects.toThrow('Something went wrong')
  })

  it('rejects tools that require task-based execution at call time', async () => {
    const tool: MockTool = { name: 'task', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }
    const client = createMockClient([tool])
    await expect(definitionFor(tool, client).execute({}, execContext())).rejects.toThrow(/task-based execution/)
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('maps non-object args to {} for the server param error', async () => {
    const tool: MockTool = { name: 't', inputSchema: { type: 'object' } }
    const client = createMockClient([tool])
    await definitionFor(tool, client).execute('not-an-object', execContext())
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 't', arguments: {} },
      { signal: testToolSignal, timeout: 60_000, toolDefinition: tool },
    )
  })

  it('forwards the caller abort signal into the call', async () => {
    const tool: MockTool = { name: 't', inputSchema: { type: 'object' } }
    const client = createMockClient([tool])
    const aborted = new AbortController()
    await definitionFor(tool, client).execute({}, execContext({ signal: aborted.signal } as never))
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 't', arguments: {} },
      { signal: aborted.signal, timeout: 60_000, toolDefinition: tool },
    )
  })

  it('rejects a malformed result instead of projecting it', async () => {
    const tool: MockTool = { name: 't', inputSchema: { type: 'object' } }
    const client = createMockClient([tool], { tools: {} }, { content: 'not-an-array' })
    await expect(definitionFor(tool, client).execute({}, execContext())).rejects.toThrow(/invalid MCP result/)
  })

  it('declares the canonical output schema and the text projection', async () => {
    const plain: MockTool = { name: 'plain', inputSchema: { type: 'object' } }
    const plainDefinition = definitionFor(plain, createMockClient([plain]))
    expect(plainDefinition.output.schema).toEqual({
      type: 'object',
      properties: { content: { type: 'array', items: {} }, structuredContent: {} },
      required: ['content'],
      additionalProperties: false,
    })

    const structured: MockTool = {
      name: 'structured',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, additionalProperties: false },
    }
    const structuredDefinition = definitionFor(structured, createMockClient([structured]))
    expect(structuredDefinition.output.schema).toMatchObject({
      required: ['content', 'structuredContent'],
      additionalProperties: false,
    })
    expect(structuredDefinition.output.render({}, { content: [{ type: 'text', text: 'hi' }] } as never))
      .toEqual([{ type: 'text', text: 'hi' }])
  })

  it('diagnoses an image result exactly like the adapter when no store is mounted', async () => {
    const tool: MockTool = { name: 'shot', inputSchema: { type: 'object' } }
    const client = createMockClient([tool], { tools: {} }, {
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    })
    const definition = definitionFor(tool, client)
    const value = await definition.execute({}, execContext())
    // render() is a pure projection of the canonical value: the official
    // "not admitted" diagnostic, identical in both builders.
    expect(definition.output.render({}, value as never)).toEqual([{
      type: 'text',
      text: '[image unavailable: image/png; this result was not admitted to durable model context; raw image data remains available to programmatic callers]',
    }])
  })

  it('applies finalizeContent only to the exact execution that produced the value', async () => {
    const tool: MockTool = { name: 'shot', inputSchema: { type: 'object' } }
    const client = createMockClient([tool], { tools: {} }, {
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    })
    const definition = definitionFor(tool, client)
    expect(definition.finalizeContent).toBeTypeOf('function')

    // The execution's own value + its own rendered content → the admission
    // projection (here a refusal diagnostic) replaces the model-facing text.
    const ownExec = execContext()
    const ownValue = await definition.execute({}, ownExec)
    const ownRendered = definition.output.render({}, ownValue as never)
    expect(definition.finalizeContent?.(
      ownExec as never,
      { value: ownValue, content: ownRendered, isError: false } as never,
    )).toEqual([{
      type: 'text',
      text: '[image unavailable: image/png; no attachment store is mounted; raw image data remains available to programmatic callers]',
    }])

    // A foreign value from another execution → the hook stays out of the way.
    const foreignExec = execContext()
    await definition.execute({}, foreignExec)
    expect(definition.finalizeContent?.(
      foreignExec as never,
      { value: { content: [] }, content: ownRendered, isError: false } as never,
    )).toBeUndefined()
  })

  // ---- Image admission: the branch production only reaches on 0.1.5 ----

  /** A composition mounting the services admission needs, with fault knobs. */
  function admissionComposition(options: {
    refs?: unknown[] | Error
    modalities?: string[]
    route?: { provider: string; model: string }
  } = {}) {
    const saveImages = vi.fn(async (inputs: { mediaType: string }[]) => {
      if (options.refs instanceof Error) throw options.refs
      return options.refs ?? inputs.map((input, index) => ({ id: `ref-${index}`, mediaType: input.mediaType }))
    })
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: options.modalities ?? ['text', 'image'] }))
    const services = new Map<string, unknown>([['attachments', { saveImages }], ['llm', { resolveModelInfo }]])
    const route = options.route ?? { provider: 'p', model: 'm' }
    const agent = { session: { requestHeader: () => ({ config: route }) }, options: route }
    return {
      composition: { get: (name: string) => services.get(name) } as unknown as Context,
      saveImages,
      resolveModelInfo,
      exec: () => execContext({ agent } as never),
    }
  }

  const imageTool: MockTool = { name: 'shot', inputSchema: { type: 'object' } }
  const pngResult = { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] }

  function imageDefinition(composition: Context, result: typeof pngResult) {
    const client = createMockClient([imageTool], { tools: {} }, result)
    return build({
      ctx: composition,
      client: client as never,
      publicName: publicToolName('srv', 'shot'),
      tool: imageTool as never,
      opts: defaultOpts,
    })
  }

  /** Run one image result through execute + finalizeContent and return the text. */
  async function projectedImageText(composition: Context, toolless: ReturnType<typeof admissionComposition>, result = pngResult): Promise<string> {
    const definition = imageDefinition(composition, result)
    const exec = toolless.exec()
    const value = await definition.execute({}, exec)
    const rendered = definition.output.render({}, value as never)
    const finalized = definition.finalizeContent?.(
      exec as never,
      { value, content: rendered, isError: false } as never,
    ) as { text: string }[]
    return finalized.map((block) => block.text).join('\n')
  }

  it('admits an image through the store and returns image content', async () => {
    const setup = admissionComposition()
    const definition = imageDefinition(setup.composition, pngResult)
    const exec = setup.exec()
    const value = await definition.execute({}, exec)
    expect(setup.resolveModelInfo).toHaveBeenCalledWith('p', 'm', testToolSignal)
    expect(setup.saveImages).toHaveBeenCalledTimes(1)
    // calls[0] = [inputs]; [0][0] = the first decoded image handed to the store.
    const savedCalls = setup.saveImages.mock.calls as unknown as [[{ data: Buffer; mediaType: string }][]]
    const saved = savedCalls[0]![0]![0]!
    expect(saved.mediaType).toBe('image/png')
    expect(saved.data.toString('utf8')).toBe('hi')
    const rendered = definition.output.render({}, value as never)
    expect(definition.finalizeContent?.(exec as never, { value, content: rendered, isError: false } as never))
      .toEqual([{ type: 'image', attachment: { id: 'ref-0', mediaType: 'image/png' } }])
  })

  it('refuses an image media type outside the durable vocabulary', async () => {
    // The spec schema accepts any string mimeType; the durable vocabulary does
    // not — this is the reachable decodeImage branch (a plainly malformed base64
    // string never gets here: CallToolResult validation already rejects it).
    const setup = admissionComposition()
    const text = await projectedImageText(setup.composition, setup, {
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/bmp' }],
    })
    expect(setup.saveImages).not.toHaveBeenCalled()
    expect(text).toBe('[image unavailable: image/bmp; the declared media type is not PNG, JPEG, WebP, or GIF; raw image data remains available to programmatic callers]')
  })

  it('refuses base64 that is valid to the schema but not canonical', async () => {
    const setup = admissionComposition()
    const text = await projectedImageText(setup.composition, setup, {
      content: [{ type: 'image', data: 'aGk', mimeType: 'image/png' }],
    })
    expect(setup.saveImages).not.toHaveBeenCalled()
    expect(text).toMatch(/^\[image unavailable: image\/png; .*base64.*; raw image data remains available to programmatic callers\]$/)
  })

  it('marks a correctable refusal as an admission rejection', async () => {
    const refusal = Object.assign(new Error('too large'), { code: 'IMAGE_TOO_LARGE' })
    const setup = admissionComposition({ refs: refusal })
    const text = await projectedImageText(setup.composition, setup)
    expect(text).toBe('[image unavailable: image/png; image admission rejected the result: too large; raw image data remains available to programmatic callers]')
  })

  it('reports a plain storage failure without the admission prefix', async () => {
    const setup = admissionComposition({ refs: new Error('disk on fire') })
    const text = await projectedImageText(setup.composition, setup)
    expect(text).toBe('[image unavailable: image/png; durable image storage rejected the result; raw image data remains available to programmatic callers]')
  })

  it('refuses image storage when the model route declares no image input', async () => {
    const setup = admissionComposition({ modalities: ['text'] })
    const text = await projectedImageText(setup.composition, setup)
    expect(setup.saveImages).not.toHaveBeenCalled()
    expect(text).toBe('[image unavailable: image/png; model "m" does not declare image input; raw image data remains available to programmatic callers]')
  })

  it('refuses image storage when the call was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const setup = admissionComposition()
    const definition = imageDefinition(setup.composition, pngResult)
    const exec = execContext({ signal: controller.signal, agent: (setup.exec() as unknown as { agent: unknown }).agent } as never)
    const value = await definition.execute({}, exec)
    const rendered = definition.output.render({}, value as never)
    const finalized = definition.finalizeContent?.(
      exec as never,
      { value, content: rendered, isError: false } as never,
    ) as { text: string }[]
    expect(setup.saveImages).not.toHaveBeenCalled()
    expect(finalized[0]!.text).toBe('[image unavailable: image/png; the tool call was canceled before image storage; raw image data remains available to programmatic callers]')
  })
})

// ---- The fallback's projection is held to the adapter's exact output ----

describe('text projection parity with the official adapter', () => {
  const officialBuilder = selectDefinitionBuilder({ createMcpToolDefinition })

  function renderedBy(build: DefinitionBuilder, content: unknown[]): string {
    const tool: MockTool = { name: 't', inputSchema: { type: 'object' } }
    const client = createMockClient([tool])
    const definition = build({
      ctx,
      client: client as never,
      publicName: publicToolName('srv', 't'),
      tool: tool as never,
      opts: defaultOpts,
    })
    const rendered = definition.output.render({}, { content } as never) as { text: string }[]
    return rendered.map((block) => block.text).join('\n')
  }

  /**
   * Every case carries a literal AND is compared against the deployed adapter:
   * the fallback must not drift from it, and a future adapter change cannot
   * slip past this suite unnoticed.
   */
  const cases: Array<[string, unknown[], string]> = [
    ['joins consecutive text runs', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'a\nb'],
    ['reports an empty result with the model-visible marker', [], '(t returned no model-visible content)'],
    ['keeps an empty text block empty instead of inventing a marker', [{ type: 'text', text: '' }], ''],
    [
      'diagnoses a non-object block and an unknown type',
      [42, { type: 'weird' }],
      '[unsupported MCP content block: expected an object]\n[unsupported MCP content type: weird]',
    ],
    [
      'projects an unadmitted image with the official diagnostic',
      [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
      '[image unavailable: image/png; this result was not admitted to durable model context; raw image data remains available to programmatic callers]',
    ],
    [
      'projects an unsupported audio block',
      [{ type: 'audio', data: 'aGk=', mimeType: 'audio/mpeg' }],
      '[audio result unsupported: audio/mpeg; raw audio data remains available to programmatic callers]',
    ],
    [
      'projects an embedded resource',
      [{ type: 'resource', resource: { uri: 'x', text: 'y' } }],
      '[embedded resource unsupported; raw resource data remains available to programmatic callers]',
    ],
    [
      'names a complete resource link',
      [{ type: 'resource_link', name: 'docs', uri: 'file:///d' }],
      'Resource link: docs (file:///d)',
    ],
    [
      'diagnoses an incomplete resource link instead of naming it',
      [{ type: 'resource_link' }],
      '[resource link unavailable: the MCP block is missing its name or URI]',
    ],
    [
      'splits text runs around an image',
      [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'text', text: 'b' },
      ],
      'a\n[image unavailable: image/png; this result was not admitted to durable model context; raw image data remains available to programmatic callers]\nb',
    ],
  ]

  it.each(cases)('%s', (_label, content, expected) => {
    expect(renderedBy(buildLocalToolDefinition, content)).toBe(expected)
    expect(renderedBy(officialBuilder, content)).toBe(expected)
    expect(renderResultText(content as never, 't')).toBe(expected)
  })
})
