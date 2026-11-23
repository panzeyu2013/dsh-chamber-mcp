/**
 * Deterministic fake per-server seat for manager-level unit tests.
 *
 * The seat is the production seam (src/server-fiber.ts) with the mounted
 * official instance replaced by a controllable handle: tests decide when an
 * activation settles, which status the instance reports and what cleanup a stop
 * confirms. Everything ABOVE the seat (manager mount/publish/status/guards) and
 * the real ToolRuntime path are exercised by other specs (upstream-mount-gate);
 * this fake keeps the manager matrix fast and race-free.
 *
 * @module
 */

import type { Fiber } from '@deepseek-ai/cordis'
import type {
  Config,
  McpCloseResult,
  McpConnectionStatus,
  McpConnectionStatusHandle,
  McpOAuthAuthorization,
  McpOAuthConfig,
  McpProbeOptions,
  McpProbeResult,
  McpServerInstance,
  StreamableHttpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import type { CaptureSnapshot } from '../../src/facade.js'
import type { ServerSeat } from '../../src/server-fiber.js'

/** Deferred settled by the test to model one activation's outcome. */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  // The manager always observes ready; a test that rejects must not surface an
  // unhandled rejection before the continuation attaches.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Writable status handle the fake instance publishes through. */
class FakeStatusHandle implements McpConnectionStatusHandle {
  private status: McpConnectionStatus = { state: 'connecting', attempt: 0 }
  private closeResult: McpCloseResult = { closeConfirmed: true }
  private readonly listeners = new Set<(status: McpConnectionStatus) => void | Promise<void>>()

  current(): McpConnectionStatus {
    return this.status
  }

  closure(): McpCloseResult {
    return this.closeResult
  }

  setClosure(result: McpCloseResult): void {
    this.closeResult = result
  }

  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void {
    this.listeners.add(callback)
    return () => void this.listeners.delete(callback)
  }

  /** Publish one status transition to the manager's observer. */
  update(next: McpConnectionStatus): void {
    this.status = next
    for (const listener of [...this.listeners]) void listener(next)
  }
}

/** One fake mounted instance: the test decides when ready settles. */
export class FakeInstance implements McpServerInstance {
  readonly ready: Promise<McpConnectionStatusHandle>
  readonly status = new FakeStatusHandle()
  readonly config: Config
  private readonly settled = defer<McpConnectionStatusHandle>()
  private activated = false
  disposeCalls = 0
  disposed = false

  constructor(
    config: Config,
    private readonly closeResult: McpCloseResult | undefined,
    private readonly onDispose: () => void = () => undefined,
  ) {
    this.config = config
    this.ready = this.settled.promise
  }

  /** Settle activation with the given status (default: connected, 0 tools). */
  resolveReady(next?: McpConnectionStatus): void {
    this.activated = true
    this.status.update(next ?? { state: 'connected', toolCount: 0, connectedAt: Date.now() })
    this.settled.resolve(this.status)
  }

  /** Settle activation as a rejection (the manager classifies it). */
  rejectReady(error: unknown): void {
    this.activated = true
    this.settled.reject(error)
  }

  /** Publish a status transition through an already-settled instance. */
  emit(next: McpConnectionStatus): void {
    if (!this.activated) throw new Error('the fake instance is not activated yet')
    this.status.update(next)
  }

  async dispose(): Promise<McpCloseResult | undefined> {
    this.disposed = true
    this.disposeCalls += 1
    this.onDispose()
    return this.closeResult
  }
}

/** Authorization verb of the fake host: owner double supplied by the test. */
export type FakeAuthorizationFactory = (
  config: StreamableHttpConfig & { oauth: McpOAuthConfig },
  changed: () => void,
) => McpOAuthAuthorization

/** Construction options of one fake host (only the seat constructs one). */
interface FakeHostOptions {
  /** The resolved config is refused by `host.validate`. */
  validateError?: Error
  /**
   * Explicit authorization factory. Absent: the host (and the seat) refuse
   * authorization with the same fixed error a non-OAuth fake has always thrown.
   */
  authorization?: FakeAuthorizationFactory
}

/** Construction options of one fake seat. */
export interface FakeSeatOptions {
  /** The resolved config is refused by FakeSeat.host.validate. */
  validateError?: Error
  /** seat.mount throws instead of returning an instance. */
  mountError?: Error
  /** Cleanup result every instance reports on dispose. */
  disposeResult?: McpCloseResult
  /** Outcome of an explicit probe; an error is thrown instead. */
  probeResult?: McpProbeResult
  probeError?: Error
  /**
   * Initial activation status: `mount()` settles ready with it immediately
   * (the manager's activation continuation runs without a test-driven resolve).
   */
  readyStatus?: McpConnectionStatus
  /** Activation rejection: `mount()` rejects ready immediately. */
  readyError?: unknown
  /** Mount/unmount sink, in call order (the OAuth sign-out ordering assertion). */
  events?: string[]
  /** Explicit authorization factory for the seat's private host. */
  authorization?: FakeAuthorizationFactory
  /**
   * Forward the capture version with every capture notification. Default: omit
   * it, so the manager exercises its snapshot-version fallback; set it to pin
   * the cheap version-first skip (H5).
   */
  forwardCaptureVersion?: boolean
}

/** Structural fake of the upstream host's four verbs. */
export class FakeHost {
  readonly validations: Array<{ input: unknown; path: readonly string[] }> = []
  /** `authorization` calls (the OAuth specs assert ONE owner per seat host). */
  authorizations = 0

  constructor(private readonly options: FakeHostOptions = {}) {}

  validate(input: unknown, path: readonly string[]): Config {
    this.validations.push({ input, path })
    const error = this.options.validateError
    if (error !== undefined) throw error
    return input as Config
  }

  mount(): McpServerInstance {
    throw new Error('the fake host is only a validation surface; the seat owns mounting')
  }

  probe(): Promise<McpProbeResult> {
    throw new Error('the fake host is only a validation surface; the seat owns probing')
  }

  authorization(
    config: StreamableHttpConfig & { oauth: McpOAuthConfig },
    changed: () => void,
  ): McpOAuthAuthorization {
    this.authorizations += 1
    const factory = this.options.authorization
    if (factory === undefined) {
      throw new Error('the fake seat does not implement explicit authorization')
    }
    return factory(config, changed)
  }
}

/**
 * One fake seat owning a controllable capture generation, instance and probe.
 */
export class FakeSeat implements ServerSeat {
  readonly serverName: string
  readonly epoch: number
  readonly fiber: Fiber
  readonly host: FakeHost
  readonly options: FakeSeatOptions
  readonly configs: Config[] = []
  readonly instances: FakeInstance[] = []
  readonly probeCalls: Array<{ config: Config; options?: McpProbeOptions }> = []
  readonly authorizationCalls: Array<{ config: StreamableHttpConfig & { oauth: McpOAuthConfig }; changed: () => void }> = []
  /** Successful mount calls (instance creation; a mountError throw is not counted). */
  mounts = 0
  /** `capture()` reads (the H5 snapshot-consumption assertion). */
  captureCalls = 0
  resetCaptureCalls = 0
  disposeSeatCalls = 0
  private captureState: CaptureSnapshot = { tools: new Map(), sections: [], resources: new Map(), truncated: false, version: 0 }
  private closed = false

  constructor(
    serverName: string,
    epoch: number,
    options: FakeSeatOptions = {},
    private readonly onCaptureChanged: (peek: () => CaptureSnapshot, version?: number) => void = () => {},
  ) {
    this.serverName = serverName
    this.epoch = epoch
    this.options = options
    this.host = new FakeHost({
      ...(options.validateError === undefined ? {} : { validateError: options.validateError }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    })
    // Only uid !== null is read by the manager's guards.
    this.fiber = { uid: epoch } as unknown as Fiber
  }

  /** The capture generation this seat currently exposes. */
  get captureStateValue(): CaptureSnapshot {
    return this.captureState
  }

  capture(): CaptureSnapshot {
    this.captureCalls += 1
    return this.captureState
  }

  /** Replace the capture generation and notify the manager (one facade change). */
  setCapture(next: CaptureSnapshot): void {
    this.captureState = next
    // A production seat forwards its notification counter; the fake omits it by
    // default so the manager's snapshot-version fallback stays covered.
    this.onCaptureChanged(() => next, this.options.forwardCaptureVersion === true ? next.version : undefined)
  }

  resetCapture(): void {
    this.resetCaptureCalls += 1
    this.captureState = { tools: new Map(), sections: [], resources: new Map(), truncated: false, version: this.captureState.version + 1 }
  }

  mount(config: Config): McpServerInstance {
    const error = this.options.mountError
    if (error !== undefined) throw error
    this.configs.push(config)
    this.mounts += 1
    this.options.events?.push('mount')
    const instance = new FakeInstance(
      config,
      this.options.disposeResult,
      () => this.options.events?.push('unmount'),
    )
    this.instances.push(instance)
    // Immediate settlement for suites that drive the manager without a
    // test-owned ready deferred (every OAuth manager integration test).
    if (this.options.readyError !== undefined) instance.rejectReady(this.options.readyError)
    else if (this.options.readyStatus !== undefined) instance.resolveReady(this.options.readyStatus)
    return instance
  }

  /** The most recently mounted instance (assertions on activation/disposal). */
  get instance(): FakeInstance | undefined {
    return this.instances.at(-1)
  }

  async stopInstance(): Promise<McpCloseResult | undefined> {
    return this.instance?.dispose()
  }

  authorization(config: StreamableHttpConfig & { oauth: McpOAuthConfig }, changed: () => void): McpOAuthAuthorization {
    this.authorizationCalls.push({ config, changed })
    return this.host.authorization(config, changed)
  }

  probe(config: Config, probeOptions?: McpProbeOptions): Promise<McpProbeResult> {
    this.probeCalls.push({ config, options: probeOptions })
    const error = this.options.probeError
    if (error !== undefined) return Promise.reject(error)
    return Promise.resolve(this.options.probeResult ?? { ok: true, toolNames: [], truncated: false, durationMs: 1, closeConfirmed: true })
  }

  async disposeSeat(): Promise<void> {
    this.disposeSeatCalls += 1
    this.closed = true
    ;(this.fiber as unknown as { uid: number | null }).uid = null
    if (this.instance !== undefined && !this.instance.disposed) await this.instance.dispose()
  }

  get alive(): boolean {
    return !this.closed && (this.fiber as unknown as { uid: number | null }).uid !== null
  }
}
