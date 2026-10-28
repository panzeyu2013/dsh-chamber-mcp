// @vitest-environment node
/** Real stdio supervisor: connect/sync and tools/list_changed re-sync. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  boot,
  disposeHandles,
  execContext,
  handles,
  waitFor,
} from '../support/server-fixture.ts'

afterEach(disposeHandles)

describe('server supervisor with a real stdio MCP server', () => {
  it('connects, syncs expected defs with normalized names, and serves calls', async () => {
    const { handle, lines, commits } = await boot()
    handles.push(handle)
    expect(handle.state.connected).toBe(true)
    expect(handle.state.generation).toBe(1)
    expect(handle.state.syncId).toBe(1)

    const defs = handle.state.defs
    expect(defs.get('mcp__fix__add')?.description).toBe('Adds two numbers.')
    expect(defs.has('mcp__fix__greet')).toBe(true)
    expect(defs.has('mcp__fix__fail')).toBe(true)
    expect(defs.has('mcp__fix__crash')).toBe(true)
    expect(defs.has('mcp__fix__dyn_add')).toBe(true)
    // Dotted raw name → normalized public name with the identity hash.
    const dottedName = [...defs.keys()].find((k) => k.startsWith('mcp__fix__admin_reset_'))
    expect(dottedName).toMatch(/^mcp__fix__admin_reset_[0-9a-f]{12}$/)
    // Raw names are never registered.
    expect(defs.has('admin.reset')).toBe(false)

    // Executor round trip through the real child.
    const add = defs.get('mcp__fix__add')!
    const value = await add.execute({ a: 3, b: 4 }, execContext())
    expect(value).toEqual({ content: [{ type: 'text', text: '7' }] })

    // isError propagates as a throw.
    const fail = defs.get('mcp__fix__fail')!
    await expect(fail.execute({}, execContext())).rejects.toThrow('Something went wrong')

    // Image content degrades to placeholder text in the render projection.
    const image = defs.get('mcp__fix__image')!
    const imageValue = await image.execute({}, execContext()) as { content: { type: string }[] }
    // The canonical value keeps every raw block, image payload included (the
    // adapter's durable-image contract; nothing is discarded at this layer).
    expect(imageValue.content.map((block) => block.type)).toEqual(['text', 'image', 'text'])
    // The model-facing projection must never inline the base64 payload — no
    // attachment store is mounted on this context, so the block projects as a
    // diagnostic instead of an image.
    const rendered = image.output.render({}, imageValue as never) as { type: string; text?: string }[]
    const text = rendered.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('Here is an image:')
    expect(text).toContain('End of image.')
    expect(text).not.toContain('iVBORw0KGgo')

    // Structured lifecycle log lines carry the stable prefix.
    expect(lines.some((l) => l.level === 'info' && l.message.includes('mcp-scope(fix)') && l.message.includes('synced 8 tools'))).toBe(true)
    expect(commits).toEqual([{ serverName: 'fix', syncId: 1, size: 8 }])
  })

  it('re-syncs when the server announces tools/list_changed', async () => {
    const { handle, lines } = await boot()
    handles.push(handle)
    await waitFor(() => handle.state.syncId === 1, 'initial sync')

    const dynAdd = handle.state.defs.get('mcp__fix__dyn_add')!
    const result = await dynAdd.execute({ name: 'extra_tool' }, execContext())
    expect(result).toEqual({ content: [{ type: 'text', text: 'added extra_tool' }] })

    // list_changed → serialized re-sync commits generation 2.
    await waitFor(() => handle.state.syncId === 2, 're-sync after list_changed')
    expect(handle.state.defs.has('mcp__fix__extra_tool')).toBe(true)
    expect(lines.some((l) => l.level === 'info' && l.message.includes('tool list changed, re-syncing'))).toBe(true)

    // The new dynamic tool is servable end to end.
    const dynamic = handle.state.defs.get('mcp__fix__extra_tool')!
    const dynamicValue = await dynamic.execute({}, execContext())
    expect(dynamicValue).toEqual({ content: [{ type: 'text', text: 'dynamic result from extra_tool' }] })
  })

})
