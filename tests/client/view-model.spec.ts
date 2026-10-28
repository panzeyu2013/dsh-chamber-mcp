import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot, ServerRuntimeView } from '../../src/client/runtime.js'
import { runtimeSnapshotsEqual } from '../../src/client/view-model.js'

const view = (patch: Partial<ServerRuntimeView> = {}): ServerRuntimeView => ({
  name: 'alpha',
  state: 'connected',
  attempts: 1,
  maxAttempts: 5,
  toolCount: 2,
  ...patch,
})

const snapshot = (patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  phase: 'ready',
  servers: { alpha: view() },
  ...patch,
})

describe('runtimeSnapshotsEqual', () => {
  it('ignores the sampling timestamp but compares every visible field', () => {
    expect(runtimeSnapshotsEqual(snapshot(), { ...snapshot(), at: 999 })).toBe(true)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ phase: 'error' }))).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ error: 'boom' }))).toBe(false)
    expect(
      runtimeSnapshotsEqual(
        snapshot(),
        snapshot({ servers: { alpha: view({ toolCount: 3 }) } }),
      ),
    ).toBe(false)
    expect(
      runtimeSnapshotsEqual(
        snapshot(),
        snapshot({ servers: { alpha: view({ error: { code: 'timeout', message: 'x' } }) } }),
      ),
    ).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot({ servers: {} }))).toBe(false)
    expect(runtimeSnapshotsEqual(snapshot(), snapshot())).toBe(true)
  })
})
