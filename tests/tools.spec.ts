/**
 * Captured-definition contract: the official mcp__ naming identity and the
 * upstream tool adapter whose ToolDefinition objects the capture facades carry
 * verbatim and the applier re-registers per agent scope.
 *
 * The retired bridge surface (definitionBuilder / fetchToolDefinitions /
 * buildDefinitions) belonged to src/tools.ts and is now upstream-owned; the
 * listing/call wiring itself is pinned through the REAL mounted instance by
 * tests/host/upstream-mount-gate.spec.ts. What remains here is the contract the
 * seam depends on: the official naming math and the canonical definition shape.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mountReal } from './support/mount-real.ts'

const signal = new AbortController().signal

function execContext(): ToolRunContext {
  return {
    signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

/** One listed MCP tool as the 2.0 client reports it. */
interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: unknown
}

/** A call recorder + canned raw MCP result. */
function adapter(tool: MockTool, result: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] }) {
  const calls: Array<{ args: Record<string, unknown>; execution: ToolExecution }> = []
  const definition = createMcpToolDefinition({ get: () => undefined } as unknown as Context, {
    name: 'mcp__srv__' + tool.name.replace(/[^A-Za-z0-9_-]/g, '_'),
    rawName: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    call: async (args, execution) => {
      calls.push({ args, execution })
      return result
    },
  })
  return { definition, calls }
}

describe('captured definition contract (upstream adapter)', () => {
  it('sends the raw arguments through the call callback and returns the canonical value', async () => {
    const { definition, calls } = adapter({ name: 'add', inputSchema: { type: 'object', properties: {} } })
    const value = await definition.execute({ a: 1, b: 2 }, execContext())
    expect(calls[0]?.args).toEqual({ a: 1, b: 2 })
    expect(calls[0]?.execution.signal).toBe(signal)
    expect(value).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('forwards structuredContent when the server returns it', async () => {
    const { definition } = adapter(
      { name: 't', inputSchema: { type: 'object' } },
      { content: [{ type: 'text', text: 'x' }], structuredContent: { answer: 42 } },
    )
    const value = (await definition.execute({}, execContext())) as { structuredContent?: unknown }
    expect(value.structuredContent).toEqual({ answer: 42 })
  })

  it('throws on isError so the ToolRuntime error path fires', async () => {
    const { definition } = adapter(
      { name: 'fail', inputSchema: { type: 'object' } },
      { content: [{ type: 'text', text: 'Something went wrong' }], isError: true },
    )
    await expect(definition.execute({}, execContext())).rejects.toThrow('Something went wrong')
  })

  it('rejects tools requiring task-based execution at call time', async () => {
    const definition = createMcpToolDefinition({ get: () => undefined } as unknown as Context, {
      name: 'mcp__srv__task',
      rawName: 'task',
      description: '',
      inputSchema: { type: 'object' },
      taskRequired: true,
      call: async () => ({ content: [] }),
    })
    await expect(definition.execute({}, execContext())).rejects.toThrow(/task-based execution/)
  })

  it('rejects a malformed result and declares the canonical output schema', async () => {
    const bad = adapter({ name: 't', inputSchema: { type: 'object' } }, { content: 'not-an-array' })
    await expect(bad.definition.execute({}, execContext())).rejects.toThrow(/invalid MCP result/)
    const { definition } = adapter({ name: 'plain', inputSchema: { type: 'object' } })
    expect(definition.output.schema).toEqual({
      type: 'object',
      properties: {
        content: {
          type: 'array',
          items: {},
          description:
            'MCP content blocks in order. An image block is an Image when the program can read it; otherwise it is the raw MCP block.',
        },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    })
  })

  it('renders an unadmitted image as the fixed diagnostic (never base64 in model text)', async () => {
    const { definition } = adapter(
      { name: 'shot', inputSchema: { type: 'object' } },
      { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
    )
    const value = await definition.execute({}, execContext())
    const rendered = definition.output.render({}, value as never)
    expect(rendered).toEqual([
      {
        type: 'text',
        text: '[image unavailable: image/png; this result was not admitted to durable model context; raw image data remains available to programmatic callers]',
      },
    ])
    expect(JSON.stringify(rendered)).not.toContain('aGk=')
  })

  it('keeps the definition object identical when registered (the facade/applier catalog invariant)', async () => {
    const ctx = new Context()
    const { factoryCtx } = await mountReal(ctx)
    const { definition } = adapter({ name: 'echo', inputSchema: { type: 'object' } })
    try {
      const dispose = factoryCtx.tools.register(definition)
      // The ToolRuntime returns the EXACT registered object; the on-demand
      // catalog gate and the applier re-registration rely on this identity.
      expect(factoryCtx.tools.get(definition.name)).toBe(definition)
      dispose()
      expect(factoryCtx.tools.get(definition.name)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
