/** Shared manager fixtures for the split manager suites. */
import { Context } from '@deepseek-ai/cordis'
import { createManager, type ManagerHandle, type ManagerOptions } from '../../src/manager.ts'
import type { CredentialResolver } from '../../src/transport.ts'
import type { McpScopeDoc, ServerDef } from '../../src/shared/model.ts'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function stdioServer(
  serverName: string,
  extra: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {},
): ServerDef {
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

export async function boot(
  options: Partial<Pick<ManagerOptions, 'reconnect'>> = {},
): Promise<{
  ctx: Context
  manager: ManagerHandle
  lines: LoggedLine[]
  agentsListCalls: number[]
  setDoc(next: McpScopeDoc): void
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  let doc: McpScopeDoc = { servers: [], overrides: {} }
  const lines: LoggedLine[] = []
  const logger = {
    info: (message: string) => void lines.push({ level: 'info', message }),
    warn: (message: string) => void lines.push({ level: 'warn', message }),
    error: (message: string) => void lines.push({ level: 'error', message }),
  }
  const credentials = { resolve: (async () => undefined) as CredentialResolver }
  const agentsListCalls: number[] = []
  const disposeAgents = ctx.provide('agents', {
    roots: () => [],
    list: () => {
      agentsListCalls.push(1)
      return []
    },
    get: () => undefined,
  })
  const disposeRegistry = ctx.provide('workspaceRegistry', { list: () => [] })
  let manager: ManagerHandle | undefined
  const managerHost = function managerHost(c: Context) {
    manager = createManager({ ctx: c, logger, getDoc: () => doc, credentials, ...options })
  }
  managerHost.inject = ['agents', 'workspaceRegistry']
  await ctx.plugin(managerHost)
  void disposeAgents
  void disposeRegistry
  return {
    ctx,
    manager: manager!,
    lines,
    agentsListCalls,
    setDoc: (next) => {
      doc = next
    },
    async dispose() {
      await manager!.dispose()
    },
  }
}

export const started = (lines: LoggedLine[], name: string): number =>
  lines.filter((line) => line.message === `mcp-scope(${name}): server started (stdio)`).length

export const stopped = (lines: LoggedLine[], name: string): number =>
  lines.filter((line) => line.message === `mcp-scope(${name}): server stopped`).length
