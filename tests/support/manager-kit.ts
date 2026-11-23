/**
 * Manager test kit: the production manager driven with a deterministic fake
 * seat, a recording applier and stub services. This is the unit-level half of
 * the old "manager-*" suites; the REAL seam (official host + stdio fixture +
 * real ToolRuntime) is pinned by tests/host/upstream-mount-gate.spec.ts.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createManager, type ManagerHandle } from '../../src/manager.js'
import type { HostLogger } from '../../src/log.js'
import type { AgentApplier, ServerStateInput } from '../../src/agents.js'
import type { UpstreamMcpClient } from '../../src/upstream.js'
import type { SeatDeps, ServerSeat } from '../../src/server-fiber.js'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.js'
import type { WorkspaceLike } from '../../src/workspace.js'
import type { CaptureSnapshot } from '../../src/facade.js'
import { FakeSeat, type FakeSeatOptions } from './fake-seat.js'
import { makeLogger, type CapturingLogger, type LoggedLine } from './fixture-kit.js'
import { waitFor } from './wait.js'

export { waitFor } from './wait.js'
export type { LoggedLine } from './fixture-kit.js'

/** One published capture generation recorded by the applier stub. */
interface RecordedSync extends ServerStateInput {
  serverName: string
}

/** Applier stub: records every manager publication and revocation. */
export class RecordingApplier implements AgentApplier {
  readonly syncs: RecordedSync[] = []
  readonly removals: string[] = []
  readonly admissions: Array<{ agent: Agent; definition: ToolDefinition }> = []
  readonly captures = new Map<string, ServerStateInput>()
  reconciles = 0
  disposed = false
  /** Optional visibility override (defaults to "a capture is tracked"). */
  visible: (agent: Agent, serverName: string) => boolean = (_agent, serverName) => this.captures.has(serverName)

  syncServerState(serverName: string, state: ServerStateInput): void {
    this.captures.set(serverName, state)
    this.syncs.push({ serverName, ...state })
  }

  removeServer(serverName: string): void {
    this.captures.delete(serverName)
    this.removals.push(serverName)
  }

  admit(agent: Agent, definition: ToolDefinition): () => void {
    this.admissions.push({ agent, definition })
    return () => {}
  }

  isApplied(agent: Agent, serverName: string): boolean {
    return this.visible(agent, serverName)
  }

  reconcile(): void {
    this.reconciles += 1
  }

  dispose(): void {
    this.disposed = true
  }

  /** Captures published for one server, in order. */
  versionsOf(serverName: string): number[] {
    return this.syncs.filter((entry) => entry.serverName === serverName).map((entry) => entry.capture.version)
  }

  /** Latest recorded capture for one server. */
  latest(serverName: string): CaptureSnapshot | undefined {
    return this.captures.get(serverName)?.capture
  }
}

/** A fake upstream peer: the seat factory never constructs a real host. */
function fakeUpstream(): UpstreamMcpClient {
  return {
    McpClientHost: class {
      constructor() {
        throw new Error('the fake manager kit never constructs a real McpClientHost')
      }
    } as unknown as UpstreamMcpClient['McpClientHost'],
  }
}

/** Bare credential provider stub (never resolved by the fake seat). */
function fakeCredentials(): CredentialProvider {
  const notImplemented = async (): Promise<never> => {
    throw new Error('the fake credentials provider is not a resolution surface')
  }
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: false }),
    set: notImplemented,
    unset: notImplemented,
    readRecord: async () => undefined,
    describeRecord: async () => ({ configured: false, writable: false }),
    listRecords: async () => [],
    modifyRecord: notImplemented,
    deleteRecord: notImplemented,
  } as unknown as CredentialProvider
}

/** Construction options of a booted fake manager. */
interface BootManagerOptions {
  doc?: McpScopeDoc
  agents?: Agent[]
  workspaces?: readonly WorkspaceLike[]
  /** Per-server fake-seat behavior. */
  seat?: FakeSeatOptions | ((serverName: string) => FakeSeatOptions)
  /** Read-only official-plane conflict pre-check. */
  managedNames?: () => readonly string[]
  /** Applier override (defaults to a fresh RecordingApplier). */
  applier?: AgentApplier
  /** Logger override (defaults to a capturing logger). */
  logger?: HostLogger
  /** Seat-factory override (defaults to a FakeSeat per deps). */
  seatFactory?: (deps: SeatDeps) => Promise<ServerSeat>
}

/** One booted manager plus its controllable inputs. */
export interface BootedManager {
  ctx: Context
  manager: ManagerHandle
  logger: CapturingLogger
  lines: LoggedLine[]
  seats: Map<string, FakeSeat>
  /** Every seat ever created, in creation order (remount history). */
  seatHistory: FakeSeat[]
  applier: RecordingApplier
  docs: McpScopeDoc[]
  setDoc(next: McpScopeDoc): void
  setAgents(next: Agent[]): void
  setWorkspaces(next: readonly WorkspaceLike[]): void
  /** Wait until the manager created the seat of one server. */
  waitSeat(serverName: string): Promise<FakeSeat>
  dispose(): Promise<void>
}

function emptyDoc(): McpScopeDoc {
  return { servers: [], overrides: {} }
}

/**
 * Boot the real manager over a fake seat. All services the manager lazily
 * reads (agents/workspaceRegistry/credentials) are provided on the same root.
 */
export async function bootManager(options: BootManagerOptions = {}): Promise<BootedManager> {
  const ctx = new Context()
  const logger = (options.logger ?? makeLogger()) as CapturingLogger
  const lines = logger.lines
  let doc = options.doc ?? emptyDoc()
  let agents = options.agents ?? []
  let workspaces = options.workspaces ?? []
  const seats = new Map<string, FakeSeat>()
  const seatHistory: FakeSeat[] = []
  const applier = (options.applier ?? new RecordingApplier()) as RecordingApplier
  const docs: McpScopeDoc[] = [doc]

  ctx.provide('agents', {
    list: () => [...agents],
    get: (id: string) => agents.find((agent) => agent.id === id),
  } as never)
  ctx.provide('workspaceRegistry', { list: () => [...workspaces] } as never)
  ctx.provide('credentials', fakeCredentials() as never)

  const manager = createManager({
    ctx,
    logger,
    getDoc: () => doc,
    upstream: async () => fakeUpstream(),
    ...(options.managedNames === undefined ? {} : { managedNames: options.managedNames }),
    applier,
    seatFactory: async (deps: SeatDeps) => {
      if (options.seatFactory !== undefined) {
        const seat = await options.seatFactory(deps)
        seatHistory.push(seat as FakeSeat)
        return seat
      }
      const factory = typeof options.seat === 'function' ? options.seat(deps.serverName) : options.seat
      const seat = new FakeSeat(deps.serverName, deps.epoch, factory, deps.onCaptureChanged)
      seats.set(deps.serverName, seat)
      seatHistory.push(seat)
      return seat
    },
  })

  return {
    ctx,
    manager,
    logger,
    lines,
    seats,
    seatHistory,
    applier,
    docs,
    setDoc(next: McpScopeDoc): void {
      doc = next
      docs.push(next)
    },
    setAgents(next: Agent[]): void {
      agents = next
    },
    setWorkspaces(next: readonly WorkspaceLike[]): void {
      workspaces = next
    },
    async waitSeat(serverName: string): Promise<FakeSeat> {
      await waitFor(() => seats.has(serverName), 'seat for ' + serverName)
      return seats.get(serverName)!
    },
    async dispose(): Promise<void> {
      await manager.dispose()
    },
  }
}

/** One server document row for the fake-seat manager suites. */
export function stdioRow(
  serverName: string,
  extra: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {},
): ServerDef {
  return { serverName, transport: 'stdio', command: process.execPath, args: ['fixture.mjs'], cwd: '', ...extra }
}
