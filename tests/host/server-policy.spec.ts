// @vitest-environment node
/** Pure reconnect-policy validation. */
import { describe, expect, it } from 'vitest'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy } from '../../src/server.ts'

describe('resolveReconnectPolicy', () => {
  it('returns frozen official defaults for an omitted config', () => {
    const policy = resolveReconnectPolicy(undefined, 'mcp-scope(x): reconnect')
    expect(policy).toEqual(RECONNECT_DEFAULTS)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('rejects unknown keys, out-of-range delays, and invalid attempts', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 0 } as never, 'p')).toThrow(/positive finite/)
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 } as never, 'p')).toThrow(/positive integer/)
    expect(() => resolveReconnectPolicy({ notAnOption: true } as never, 'p')).toThrow(/not a reconnect option/)
  })

  it('resolves partial overrides onto the defaults', () => {
    const policy = resolveReconnectPolicy({ initialDelayMs: 100, maxAttempts: 2 }, 'p')
    expect(policy).toEqual({ enabled: true, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 2 })
  })
})
