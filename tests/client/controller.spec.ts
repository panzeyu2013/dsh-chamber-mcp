import { describe, expect, it } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import {
  McpScopeController,
  buildSaveOps,
  classifySaveError,
  credentialRefsOfDoc,
  decodeDoc,
  docsEqual,
  failureKey,
  normalizeDoc,
  renameOverrideKey,
  toggleOp,
  type CredentialsGateway,
  type SettingsScopePort,
} from '../../src/client/controller.js'
import { isEnabled, removeServerOverrides, type McpScopeDoc, type ServerDef, type WorkspaceOverrides } from '../../src/shared/model.js'

const stdioServer = (serverName: string, envKeys: string[] = []): ServerDef => ({
  serverName,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@some/mcp'],
  envKeys,
})

const httpServer = (serverName: string, headers: { name: string; ref: string }[] = []): ServerDef => ({
  serverName,
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8080/mcp',
  headers,
})

const doc = (servers: ServerDef[], overrides: McpScopeDoc['overrides'] = {}): McpScopeDoc => ({
  servers,
  overrides,
})

describe('decodeDoc (malformed-snapshot hardening)', () => {
  it('defaults null / non-objects to the empty document', () => {
    expect(decodeDoc(undefined)).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc(null)).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc('nope')).toEqual({ servers: [], overrides: {} })
  })

  it('guards missing arrays', () => {
    expect(decodeDoc({})).toEqual({ servers: [], overrides: {} })
    expect(decodeDoc({ servers: 'x', overrides: undefined })).toEqual({ servers: [], overrides: {} })
  })

  it('prunes empty override rows and non-true entries', () => {
    const raw = {
      servers: [],
      overrides: {
        wsA: { s1: true },
        wsB: {}, // empty → dropped
        wsC: { s1: false, s2: 'x' }, // only literal true counts → row dropped
      },
    }
    const decoded = decodeDoc(raw)
    expect(decoded.overrides).toEqual({ wsA: { s1: true } })
  })

  it('drops non-object servers but keeps valid ones', () => {
    const decoded = decodeDoc({ servers: [stdioServer('ok'), null, 'junk'] })
    expect(decoded.servers.map((s) => s.serverName)).toEqual(['ok'])
  })
})

describe('buildSaveOps', () => {
  it('returns an empty plan for identical documents', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    const plan = buildSaveOps(d, d)
    expect(plan.ops).toEqual([])
    expect(plan.unsetRefs).toEqual([])
  })

  it('adds a server with one whole-array servers op and no orphaned refs', () => {
    const prev = doc([])
    const next = doc([stdioServer('git')])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual([])
  })

  it('edits env keys: appending a key only rewrites servers', () => {
    const prev = doc([stdioServer('a', ['A'])])
    const next = doc([stdioServer('a', ['A', 'B'])])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual([])
  })

  it('edits env keys: removing a key orphans the removed credential ref', () => {
    const prev = doc([stdioServer('a', ['A', 'B'])])
    const next = doc([stdioServer('a', ['B'])])
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
    expect(plan.unsetRefs).toEqual(['A'])
  })

  it('remove-server cascade: unsets refs no remaining server references', () => {
    const shared = 'SHARED_TOKEN'
    const prev = doc([stdioServer('one', [shared, 'ONE_ONLY']), httpServer('two', [{ name: 'X-Token', ref: shared }])])
    const next = doc([prev.servers[0]!]) // server "two" removed
    const plan = buildSaveOps(prev, next)
    // 'two' referenced only the shared ref, which 'one' still uses → nothing orphaned.
    expect(plan.unsetRefs).toEqual([])
    // now remove 'one' too from the same starting doc: ONE_ONLY is orphaned,
    // while SHARED_TOKEN stays referenced by 'two'.
    const onlyTwo = doc([httpServer('two', [{ name: 'X-Token', ref: shared }])])
    const plan2 = buildSaveOps(prev, onlyTwo)
    expect(plan2.unsetRefs).toEqual(['ONE_ONLY'])
  })

  it('remove-server cascade: prunes per-workspace override rows of the removed server', () => {
    const prev = doc([stdioServer('a'), stdioServer('b')], {
      ws1: { a: true },
      ws2: { a: true, b: true },
      ws3: { b: true }, // only b off → untouched by removing a
    })
    const next = doc(prev.servers.filter((s) => s.serverName !== 'a'), removeServerOverrides(prev.overrides, 'a'))
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([
      { op: 'set', path: ['servers'], value: next.servers },
      { op: 'unset', path: ['overrides', 'ws1', 'a'] },
      { op: 'unset', path: ['overrides', 'ws1'] }, // row emptied by the removal
      { op: 'unset', path: ['overrides', 'ws2', 'a'] }, // ws2 keeps b off
    ])
  })

  it('keep-overrides rows untouched when the doc does not change them', () => {
    const prev = doc([stdioServer('a')], { ws1: { a: true } })
    const next = doc([stdioServer('a', ['NEW_ENV'])], { ws1: { a: true } })
    const plan = buildSaveOps(prev, next)
    expect(plan.ops).toEqual([{ op: 'set', path: ['servers'], value: next.servers }])
  })
})

describe('toggleOp', () => {
  it('returns no ops when the requested state already holds', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    expect(toggleOp(d, 'ws1', 'a', true)).toEqual([]) // already off
    expect(toggleOp(d, 'ws2', 'a', false)).toEqual([]) // default on
  })

  it('turning off sets one presence op', () => {
    const d = doc([stdioServer('a')])
    expect(toggleOp(d, 'ws1', 'a', true)).toEqual([
      { op: 'set', path: ['overrides', 'ws1', 'a'], value: true },
    ])
  })

  it('turning on unsets the record and prunes the emptied row', () => {
    const d = doc([stdioServer('a')], { ws1: { a: true } })
    expect(toggleOp(d, 'ws1', 'a', false)).toEqual([
      { op: 'unset', path: ['overrides', 'ws1', 'a'] },
      { op: 'unset', path: ['overrides', 'ws1'] },
    ])
  })

  it('turning on keeps the row when other servers stay off in it', () => {
    const d = doc([stdioServer('a'), stdioServer('b')], { ws1: { a: true, b: true } })
    expect(toggleOp(d, 'ws1', 'a', false)).toEqual([{ op: 'unset', path: ['overrides', 'ws1', 'a'] }])
  })
})

describe('docsEqual (landed-write comparison)', () => {
  it('compares whole documents over normalized shape', () => {
    expect(docsEqual(doc([stdioServer('a')], { ws1: { a: true } }), doc([stdioServer('a')], { ws1: { a: true } }))).toBe(true)
    expect(docsEqual(doc([stdioServer('a')]), doc([stdioServer('a')], { ws1: { a: true } }))).toBe(false)
  })

  it('prunes empty override rows before comparing', () => {
    expect(docsEqual(doc([stdioServer('a')], { ws1: {} }), doc([stdioServer('a')]))).toBe(true)
  })

  it('server order matters (arrays), object key order does not', () => {
    const d1 = doc([stdioServer('a', ['X']), stdioServer('b')])
    const reordered = doc([stdioServer('b'), stdioServer('a', ['X'])])
    expect(docsEqual(d1, reordered)).toBe(false)
    // same servers, host returned with different object key order / cwd present
    const hostOrder: ServerDef = { args: ['-y', '@some/mcp'], command: 'npx', envKeys: ['X'], serverName: 'a', transport: 'stdio' }
    expect(docsEqual(d1, doc([hostOrder, stdioServer('b')]))).toBe(true)
    expect(docsEqual(d1, doc([{ ...hostOrder, command: 'other' }, stdioServer('b')]))).toBe(false)
  })

  it('treats absent arrays and absent cwd as empty (decoder tolerance)', () => {
    const bare: ServerDef = { serverName: 'a', transport: 'stdio', command: 'npx' }
    expect(docsEqual(doc([bare]), doc([{ ...bare, envKeys: [] }]))).toBe(true)
    expect(docsEqual(doc([bare]), doc([{ ...bare, cwd: '' }]))).toBe(true)
    expect(docsEqual(doc([bare]), doc([{ ...bare, args: ['extra'] }]))).toBe(false)
  })
})

describe('renameOverrideKey', () => {
  it('renames the off-switch keys of one server across rows, preserving presence', () => {
    const overrides: WorkspaceOverrides = { ws1: { a: true }, ws2: { a: true, b: true }, ws3: { b: true } }
    expect(renameOverrideKey(overrides, 'a', 'a2')).toEqual({
      ws1: { a2: true },
      ws2: { a2: true, b: true },
      ws3: { b: true },
    })
  })

  it('returns the same reference when nothing changed or names match', () => {
    const overrides: WorkspaceOverrides = { ws1: { a: true } }
    expect(renameOverrideKey(overrides, 'a', 'a')).toBe(overrides)
    expect(renameOverrideKey(overrides, 'missing', 'b')).toBe(overrides)
  })
})

describe('shared semantics alignment', () => {
  it('credentialRefsOfDoc collects env keys and header refs across servers', () => {
    const d = doc([
      stdioServer('a', ['A', 'B']),
      httpServer('b', [{ name: 'X', ref: 'A' }, { name: 'Y', ref: 'C' }]),
    ])
    expect(credentialRefsOfDoc(d)).toEqual(['A', 'B', 'C'])
  })

  it('normalizeDoc keeps semantics of isEnabled', () => {
    const d = normalizeDoc(doc([stdioServer('a')], { ws1: { a: true }, ws2: {} }))
    expect(isEnabled(d.overrides, 'ws1', 'a')).toBe(false)
    expect(isEnabled(d.overrides, 'ws2', 'a')).toBe(true)
    expect(d.overrides).toEqual({ ws1: { a: true } })
  })
})

describe('classifySaveError', () => {
  it('discriminates by the typed code first (FE-2)', () => {
    // RemoteError with the platform's wire code
    expect(classifySaveError({ code: 'settings/conflict', message: 'anything at all' })).toBe('conflict')
    expect(classifySaveError({ code: 'SETTINGS_CONFLICT', message: 'host-side class code' })).toBe('conflict')
    expect(classifySaveError({ code: 'settings/rejected', message: 'read-only refusal' })).toBe('save-failed')
    expect(classifySaveError({ code: 'credential/rejected', message: 'shadowed' })).toBe('save-failed')
  })

  it('treats any typed remote error without a conflict code as save-failed (no message scan)', () => {
    expect(classifySaveError({ code: 'gateway/unavailable', message: 'stale revision nonsense' })).toBe('save-failed')
    expect(classifySaveError({ isDSHRemoteError: true, code: 'settings/conflict' })).toBe('conflict')
    expect(classifySaveError({ isDSHRemoteError: true, message: 'changed since it was read' })).toBe('save-failed')
  })

  it('falls back to the message scan only for non-platform errors', () => {
    expect(classifySaveError(new Error('settings conflict: expected revision 3, got 5'))).toBe('conflict')
    expect(classifySaveError({ message: 'stale revision' })).toBe('conflict')
    expect(classifySaveError(new Error('boom'))).toBe('save-failed')
    expect(classifySaveError('network down')).toBe('save-failed')
  })

  it('maps failed outcomes onto the localized keys components render', () => {
    expect(failureKey({ ok: false, reason: 'conflict' })).toBe('error.conflict')
    expect(failureKey({ ok: false, reason: 'secret-write-failed', refs: ['A'] })).toBe('error.secretWriteFailed')
    expect(failureKey({ ok: false, reason: 'save-failed' })).toBe('error.saveFailed')
    expect(failureKey({ ok: false, reason: 'invalid' })).toBe('error.unexpected')
  })
})

// ---------------------------------------------------------------------------
// FE-4 async pipeline tests: real controller methods over in-memory fakes of
// the settings-scope port and the credentials gateway.
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

class FakeCredentials implements CredentialsGateway {
  readonly values = new Map<string, string>()
  readonly setFail = new Set<string>()
  /** When non-empty, describe returns these promises in FIFO order. */
  readonly describeDeferred: Deferred<Record<string, CredentialInfo>>[] = []
  readonly setCalls: { ref: string; value: string }[] = []
  readonly unsetCalls: string[] = []
  readonly describeCalls: string[][] = []
  /** Ref → gate: set(ref) waits for the gate before applying (mid-save races). */
  readonly setGates = new Map<string, Deferred<void>>()
  private readonly log: string[] | undefined

  constructor(log?: string[]) {
    this.log = log
  }

  buildViews(refs: readonly string[]): Record<string, CredentialInfo> {
    const views: Record<string, CredentialInfo> = {}
    for (const ref of refs) {
      views[ref] = { configured: this.values.has(ref), writable: true }
    }
    return views
  }

  async describe(refs: readonly string[]): Promise<Readonly<Record<string, CredentialInfo>>> {
    this.describeCalls.push([...refs])
    const next = this.describeDeferred.shift()
    if (next !== undefined) return next.promise
    return this.buildViews(refs)
  }

  async set(ref: string, value: string): Promise<void> {
    this.log?.push(`set:${ref}`)
    this.setCalls.push({ ref, value })
    const gate = this.setGates.get(ref)
    if (gate !== undefined) await gate.promise
    if (this.setFail.has(ref)) throw new Error(`set refused: ${ref}`)
    this.values.set(ref, value)
  }

  async unset(ref: string): Promise<void> {
    this.log?.push(`unset:${ref}`)
    this.unsetCalls.push(ref)
    this.values.delete(ref)
  }
}

class FakeScope implements SettingsScopePort {
  mirror: McpScopeDoc
  revision = 1
  writable = true
  /** When true, the next mutate RESOLVES without applying (host refusal). */
  refuseNext = false
  readonly mutateCalls: { ops: SettingsPathOpView[]; expectedRevision: number | undefined }[] = []
  private readonly listeners = new Set<() => void>()
  private readonly log: string[] | undefined

  constructor(initial: McpScopeDoc = doc([]), log?: string[]) {
    this.mirror = structuredClone(initial)
    this.log = log
  }

  getSnapshot(): { status: 'ready'; value: McpScopeDoc; revision: number; writable: boolean } {
    return { status: 'ready', value: structuredClone(this.mirror), revision: this.revision, writable: this.writable }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<void> {
    this.mutateCalls.push({ ops: ops.map((op) => ({ ...op, path: [...op.path] })), expectedRevision })
    this.log?.push(`mutate:${expectedRevision ?? '?'}`)
    // Host revision fence: a stale writer is refused (the real scope client
    // then recovers with a mirror reload and RESOLVES — modelled below).
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return
    if (this.refuseNext) {
      this.refuseNext = false
      return // refusal also resolves without writing and without notifying
    }
    for (const op of ops) this.applyOp(op)
    this.revision += 1
    this.notify()
  }

  private applyOp(op: SettingsPathOpView): void {
    const [section, workspaceId, name] = op.path as [string, string?, string?]
    if (section === 'servers') {
      if (op.op === 'set') {
        this.mirror = { ...this.mirror, servers: structuredClone(op.value) as unknown as ServerDef[] }
      }
      return
    }
    if (section !== 'overrides' || workspaceId === undefined) return
    if (name === undefined) {
      if (op.op === 'unset') {
        const overrides = { ...this.mirror.overrides }
        delete overrides[workspaceId]
        this.mirror = { ...this.mirror, overrides }
      }
      return
    }
    const row = this.mirror.overrides[workspaceId] ?? {}
    if (op.op === 'set') {
      this.mirror = { ...this.mirror, overrides: { ...this.mirror.overrides, [workspaceId]: { ...row, [name]: true } } }
      return
    }
    const rest = { ...row }
    delete rest[name]
    if (Object.keys(rest).length === 0) {
      const overrides = { ...this.mirror.overrides }
      delete overrides[workspaceId]
      this.mirror = { ...this.mirror, overrides }
    } else {
      this.mirror = { ...this.mirror, overrides: { ...this.mirror.overrides, [workspaceId]: rest } }
    }
  }

  /** Host-side change from elsewhere (bumps the revision like a real commit). */
  applyExternal(next: McpScopeDoc): void {
    this.mirror = structuredClone(next)
    this.revision += 1
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function makePipeline(initial: McpScopeDoc, log?: string[]) {
  const scope = new FakeScope(initial, log)
  const creds = new FakeCredentials(log)
  const controller = new McpScopeController(scope, creds)
  const stop = controller.start()
  return { scope, creds, controller, stop }
}

describe('McpScopeController save pipeline (FE-4)', () => {
  it('writes secrets before the document mutation on a successful add', async () => {
    const log: string[] = []
    const { scope, creds, controller, stop } = makePipeline(doc([]), log)
    try {
      const outcome = await controller.addServer({
        server: stdioServer('git', ['A', 'B']),
        secrets: [
          { ref: 'A', value: 'a' },
          { ref: 'B', value: 'b' },
        ],
      })
      expect(outcome).toEqual({ ok: true })
      expect(scope.mirror.servers.map((s) => s.serverName)).toEqual(['git'])
      expect(log.indexOf('set:A')).toBeGreaterThanOrEqual(0)
      expect(log.indexOf('set:B')).toBeGreaterThanOrEqual(0)
      expect(log.indexOf('set:A')).toBeLessThan(log.indexOf('mutate:1'))
      expect(log.indexOf('set:B')).toBeLessThan(log.indexOf('mutate:1'))
      expect(creds.values.get('A')).toBe('a')
      // successful add leaves stored credentials in place (no cleanup unsets)
      expect(creds.unsetCalls).toEqual([])
    } finally {
      stop()
    }
  })

  it('aborts on a secret write failure BEFORE the doc write and auto-unsets the new refs stored by this attempt', async () => {
    const log: string[] = []
    const { scope, creds, controller, stop } = makePipeline(doc([]), log)
    try {
      creds.setFail.add('B')
      const outcome = await controller.addServer({
        server: stdioServer('git', ['A', 'B']),
        secrets: [
          { ref: 'A', value: 'a' },
          { ref: 'B', value: 'b' },
        ],
      })
      expect(outcome).toEqual({ ok: false, reason: 'secret-write-failed', refs: ['B'] })
      // no document write happened
      expect(scope.mutateCalls.length).toBe(0)
      expect(scope.mirror.servers).toEqual([])
      // the ref this attempt DID store (A, new) was cleaned up; B never stored
      expect(creds.unsetCalls).toEqual(['A'])
      expect(creds.values.has('A')).toBe(false)
      expect(creds.values.has('B')).toBe(false)
    } finally {
      stop()
    }
  })

  it('never reports ok for a mutate that resolves without writing — conflict, plus new-secret cleanup', async () => {
    const { scope, creds, controller, stop } = makePipeline(doc([]))
    try {
      scope.refuseNext = true
      const outcome = await controller.addServer({
        server: stdioServer('git', ['A']),
        secrets: [{ ref: 'A', value: 'a' }],
      })
      expect(outcome).toEqual({ ok: false, reason: 'conflict' })
      expect(scope.mirror.servers).toEqual([]) // the write did not land
      expect(creds.unsetCalls).toEqual(['A']) // new secret auto-cleaned
      expect(creds.values.has('A')).toBe(false)
    } finally {
      stop()
    }
  })

  it('the same refusal path applies to toggles: a resolved-but-unlanded toggle is a conflict, never ok', async () => {
    const { scope, controller, stop } = makePipeline(doc([stdioServer('a')]))
    try {
      scope.refuseNext = true
      const outcome = await controller.toggleWorkspace('ws1', 'a', true)
      expect(outcome).toEqual({ ok: false, reason: 'conflict' })
      expect(scope.mirror.overrides).toEqual({})
    } finally {
      stop()
    }
  })

  it('an overlapping host commit mid-save fences the write: conflict + new-secret cleanup', async () => {
    const gate = deferred<void>()
    const { scope, creds, controller, stop } = makePipeline(doc([]))
    try {
      creds.setGates.set('A', gate)
      const pending = controller.addServer({
        server: stdioServer('git', ['A', 'B']),
        secrets: [
          { ref: 'A', value: 'a' },
          { ref: 'B', value: 'b' },
        ],
      })
      await flush() // let set(A) reach its gate
      // another writer commits while this save is mid-flight (revision 1 → 2)
      scope.applyExternal(doc([stdioServer('other')]))
      gate.resolve()
      const outcome = await pending
      expect(outcome).toEqual({ ok: false, reason: 'conflict' })
      expect(scope.mirror.servers.map((s) => s.serverName)).toEqual(['other'])
      // both secrets were new to this attempt and are cleaned up
      expect(creds.unsetCalls.sort()).toEqual(['A', 'B'])
    } finally {
      stop()
    }
  })

  it('a conflict never unsets a ref that had a stored value before the save', async () => {
    const existing = stdioServer('existing', ['OLD'])
    const scope = new FakeScope(doc([existing]))
    const creds = new FakeCredentials()
    // stored BEFORE the initial describe so the badge map proves it configured
    creds.values.set('OLD', 'v1')
    const controller = new McpScopeController(scope, creds)
    const stop = controller.start()
    try {
      await flush()
      expect(controller.store.getSnapshot().credentials['OLD']?.configured).toBe(true)
      scope.refuseNext = true
      const outcome = await controller.addServer({
        server: stdioServer('git', ['OLD']),
        secrets: [{ ref: 'OLD', value: 'v2' }], // overwrites the stored value
      })
      expect(outcome).toEqual({ ok: false, reason: 'conflict', keptSecretRefs: ['OLD'] })
      // OLD had a stored value before the save: it must NOT be unset (the old
      // value cannot be restored) and the kept literal is SURFACED so the UI
      // can tell the user the truth about what stayed stored.
      expect(creds.unsetCalls).toEqual([])
      expect(creds.values.get('OLD')).toBe('v2')
    } finally {
      stop()
    }
  })

  it('a removal success applies the orphaned-ref unsets only after the doc write', async () => {
    const log: string[] = []
    const removed = stdioServer('gone', ['X'])
    const { scope, creds, controller, stop } = makePipeline(doc([removed]), log)
    try {
      creds.values.set('X', 'x')
      await flush()
      const outcome = await controller.removeServer('gone')
      expect(outcome).toEqual({ ok: true })
      expect(scope.mirror.servers).toEqual([])
      expect(creds.unsetCalls).toEqual(['X'])
      expect(log.indexOf('mutate:1')).toBeLessThan(log.indexOf('unset:X'))
    } finally {
      stop()
    }
  })

  it('toggle works for a serverName colliding with an Object.prototype member (F1)', async () => {
    const { scope, controller, stop } = makePipeline(doc([stdioServer('toString')]))
    try {
      await flush()
      // Turning OFF writes an OWN row and flips the read.
      const off = await controller.toggleWorkspace('ws1', 'toString', true)
      expect(off).toEqual({ ok: true })
      expect(scope.mirror.overrides.ws1).toEqual({ toString: true })
      // Turning ON again removes the own row (no phantom inherited reads).
      const on = await controller.toggleWorkspace('ws1', 'toString', false)
      expect(on).toEqual({ ok: true })
      expect(scope.mirror.overrides.ws1).toBeUndefined()
      // isEnabled agrees with the mirror at both ends.
      expect(isEnabled(scope.mirror.overrides, 'ws1', 'toString')).toBe(true)
    } finally {
      stop()
    }
  })

  it('a removal prunes the removed server from every workspace override row', async () => {
    const removed = stdioServer('gone', ['X'])
    const keep = stdioServer('keep')
    const { scope, creds, controller, stop } = makePipeline(
      doc([removed, keep], { ws1: { gone: true, keep: true }, ws2: { gone: true } }),
    )
    try {
      await flush()
      const outcome = await controller.removeServer('gone')
      expect(outcome).toEqual({ ok: true })
      // ws1 keeps its 'keep' row; ws2's row was emptied by the prune and dropped.
      expect(scope.mirror.overrides).toEqual({ ws1: { keep: true } })
      // X leaves the document with the removal: the cascade attempts its unset
      // (idempotent when nothing was stored).
      expect(creds.unsetCalls).toEqual(['X'])
    } finally {
      stop()
    }
  })

  it('a refused write never unsets a ref the live document still references', async () => {
    // 'SHARED' is referenced by an EXISTING server but has no stored value yet.
    const existing = stdioServer('existing', ['SHARED'])
    const { scope, creds, controller, stop } = makePipeline(doc([existing]))
    try {
      await flush()
      scope.refuseNext = true
      const outcome = await controller.addServer({
        server: stdioServer('git'),
        secrets: [{ ref: 'SHARED', value: 'v' }],
      })
      expect(outcome).toEqual({ ok: false, reason: 'conflict' })
      // The live doc references SHARED: unsetting it could destroy a value a
      // concurrent winning writer just committed for that ref — cleanup must
      // skip it (R2S-1).
      expect(creds.unsetCalls).toEqual([])
      expect(creds.values.get('SHARED')).toBe('v')
    } finally {
      stop()
    }
  })

  it('passes the snapshot revision through as the mutate fence on every write path', async () => {
    const { scope, controller, stop } = makePipeline(doc([]))
    try {
      await controller.addServer({ server: stdioServer('a'), secrets: [] })
      expect(scope.mutateCalls[0]?.expectedRevision).toBe(1)
      expect(scope.revision).toBe(2)
      await controller.toggleWorkspace('ws1', 'a', true)
      expect(scope.mutateCalls[1]?.expectedRevision).toBe(2)
      await controller.removeServer('a')
      expect(scope.mutateCalls[2]?.expectedRevision).toBe(3)
    } finally {
      stop()
    }
  })

  it('replaceServer swaps the server in place and keeps everything else through the same pipeline', async () => {
    const { scope, creds, controller, stop } = makePipeline(doc([stdioServer('a', ['X']), stdioServer('b')]))
    try {
      creds.values.set('X', 'x')
      await flush()
      const outcome = await controller.replaceServer('a', {
        server: stdioServer('a', ['X', 'Y']),
        secrets: [{ ref: 'Y', value: 'y' }],
      })
      expect(outcome).toEqual({ ok: true })
      expect(scope.mirror.servers.map((s) => s.serverName)).toEqual(['a', 'b'])
      expect(credentialRefsOfDoc(scope.mirror)).toEqual(['X', 'Y'])
      expect(creds.unsetCalls).toEqual([])
    } finally {
      stop()
    }
  })

  it('replaceServer with a rename migrates per-workspace off-switch rows', async () => {
    const { scope, controller, stop } = makePipeline(
      doc([stdioServer('old'), stdioServer('keep')], { ws1: { old: true }, ws2: { old: true, keep: true } }),
    )
    try {
      const outcome = await controller.replaceServer('old', { server: stdioServer('new'), secrets: [] })
      expect(outcome).toEqual({ ok: true })
      expect(scope.mirror.servers.map((s) => s.serverName)).toEqual(['new', 'keep'])
      expect(scope.mirror.overrides).toEqual({ ws1: { new: true }, ws2: { new: true, keep: true } })
    } finally {
      stop()
    }
  })

  it('replaceServer refuses with conflict when the target no longer exists', async () => {
    const { scope, controller, stop } = makePipeline(doc([stdioServer('a')]))
    try {
      scope.applyExternal(doc([stdioServer('b')])) // 'a' vanished elsewhere
      const outcome = await controller.replaceServer('a', { server: stdioServer('a2'), secrets: [] })
      expect(outcome).toEqual({ ok: false, reason: 'conflict' })
      expect(scope.mutateCalls.length).toBe(0)
    } finally {
      stop()
    }
  })

  it('replaceServer rejects an edit that collides with an existing server name (invalid, no write)', async () => {
    const { scope, controller, stop } = makePipeline(doc([stdioServer('a'), stdioServer('b')]))
    try {
      const outcome = await controller.replaceServer('a', { server: stdioServer('b'), secrets: [] })
      expect(outcome).toEqual({ ok: false, reason: 'invalid' })
      expect(scope.mutateCalls.length).toBe(0)
    } finally {
      stop()
    }
  })
})

describe('McpScopeController credential refresh (FE-6)', () => {
  it('discards an out-of-order describe result: only the newest run publishes', async () => {
    const aView = { configured: true, writable: true }
    const bView = { configured: true, writable: true }
    const { scope, creds, controller, stop } = makePipeline(doc([]))
    try {
      const first = deferred<Record<string, CredentialInfo>>()
      creds.describeDeferred.push(first)
      // doc change → run 1 describes [A]
      scope.applyExternal(doc([stdioServer('s', ['A'])]))
      await flush()
      expect(creds.describeCalls.at(-1)).toEqual(['A'])

      const second = deferred<Record<string, CredentialInfo>>()
      creds.describeDeferred.push(second)
      // doc moves again while run 1 is in flight → run 2 describes [A, B]
      scope.applyExternal(doc([stdioServer('s', ['A', 'B'])]))
      await flush()
      expect(creds.describeCalls.at(-1)).toEqual(['A', 'B'])

      // run 2 settles first with both views
      second.resolve({ A: aView, B: bView })
      await flush()
      let snapshot = controller.store.getSnapshot()
      expect(Object.keys(snapshot.credentials).sort()).toEqual(['A', 'B'])
      expect(snapshot.credentialsAt).toBe(1)

      // run 1 settles late with the stale [A]-only view: it must NOT publish
      first.resolve({ A: aView })
      await flush()
      snapshot = controller.store.getSnapshot()
      expect(Object.keys(snapshot.credentials).sort()).toEqual(['A', 'B'])
      expect(snapshot.credentialsAt).toBe(1) // stale run did not bump the counter
    } finally {
      stop()
    }
  })

  it('a credential reference event retries describe even when the ref is missing from the badge map', async () => {
    const { creds, controller, stop } = makePipeline(doc([stdioServer('s', ['A'])]))
    try {
      const before = creds.describeCalls.length
      controller.onCredentialRefUpdated('A') // not in the map yet (describe pending/failed)
      await flush()
      expect(creds.describeCalls.length).toBeGreaterThan(before)
      const unrelated = creds.describeCalls.length
      controller.onCredentialRefUpdated('UNRELATED') // not referenced by the doc
      await flush()
      expect(creds.describeCalls.length).toBe(unrelated)
    } finally {
      stop()
    }
  })
})
