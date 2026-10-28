/** Shared real-stdio supervisor fixtures for the split server suites. */
import { vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Transport } from '@modelcontextprotocol/client'
import { startServerSupervisor, type ServerHandle } from '../../src/server.ts'
import { createTransport } from '../../src/transport.ts'
import type { ServerDef } from '../../src/shared/model.ts'

// The supervisor builds definitions through the official adapter, which
// resolves attachments/llm from this context only for image-bearing results.
export const ctx = new Context()

export const fixtureServer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixture',
  'mcp-fixture-server.mjs',
)

export interface LoggedLine {
  level: 'info' | 'warn' | 'error'
  message: string
}

export function makeLogger(): {
  log: (level: LoggedLine['level'], message: string) => void
  lines: LoggedLine[]
} {
  const lines: LoggedLine[] = []
  return { lines, log: (level, message) => void lines.push({ level, message }) }
}

export function execContext(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

export const noopResolve = async (): Promise<undefined> => undefined
export const NO_WARN = (): void => {}

export function stdioDef(
  serverName: string,
  extra?: Partial<Extract<ServerDef, { transport: 'stdio' }>>,
): Extract<ServerDef, { transport: 'stdio' }> {
  return {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: '',
    envKeys: [],
    ...extra,
  }
}

// One polling helper for the whole suite (tests/support/wait.ts); the interval
// is timing-only, so the shared default is what every host suite wants.
export { waitFor } from './wait.ts'

/**
 * A transport whose server is UP but never answers the MCP handshake: start()
 * resolves and every outgoing message is swallowed, so initialize hangs.
 * close() honors the Transport contract by firing onclose once.
 */
export function hungTransport(received: string[] = []): Transport {
  let closed = false
  const transport: Transport = {
    async start() {},
    async send(message) {
      received.push(JSON.stringify(message))
    },
    async close() {
      if (closed) return
      closed = true
      transport.onclose?.()
    },
  }
  return transport
}

/** Wrap a real transport whose close() refuses to confirm (late-close generation). */
export function hangingCloseTransport(base: Transport): Transport {
  const hang = async (): Promise<void> => {
    throw new Error('close refused')
  }
  return new Proxy(base, {
    get(target, property) {
      if (property === 'close') return hang
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value)
    },
  }) as Transport
}

/** Boot one supervisor with an in-memory log + commit collector. */
export async function boot(
  serverName = 'fix',
  reconnect?: Parameters<typeof startServerSupervisor>[0]['reconnect'],
): Promise<{
  handle: ServerHandle
  lines: LoggedLine[]
  commits: { serverName: string; syncId: number; size: number }[]
}> {
  const { log, lines } = makeLogger()
  const commits: { serverName: string; syncId: number; size: number }[] = []
  const handle = startServerSupervisor({
    ctx,
    serverName,
    buildTransport: () => createTransport(stdioDef(serverName), noopResolve, NO_WARN),
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
    onDefsChanged: (name, syncId, defs) => void commits.push({ serverName: name, syncId, size: defs.size }),
    reconnect,
  })
  await handle.ready
  return { handle, lines, commits }
}

/** Boot one supervisor whose fixture child sees exactly one envKey override. */
export async function bootWithEnv(
  serverName: string,
  envKey: string,
): Promise<{ handle: ServerHandle; lines: LoggedLine[] }> {
  const { log, lines } = makeLogger()
  const handle = startServerSupervisor({
    ctx,
    serverName,
    buildTransport: () => createTransport(
      stdioDef(serverName, { envKeys: [envKey] }),
      async (ref) => (ref === envKey ? { value: '1', source: 'test' } : undefined),
      NO_WARN,
    ),
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
    onDefsChanged: () => {},
    reconnect: { enabled: false },
  })
  handles.push(handle)
  await handle.ready
  return { handle, lines }
}

export const handles: ServerHandle[] = []

export async function disposeHandles(): Promise<void> {
  while (handles.length > 0) await handles.pop()!.dispose()
  // vitest.config.ts sets no restoreMocks: prototype spies must not outlive a test.
  vi.restoreAllMocks()
}
