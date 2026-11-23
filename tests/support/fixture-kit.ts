/**
 * Shared host-suite fixtures for the architecture-A tree (dsh 0.2.3-alpha.2).
 *
 * The connection layer now belongs to the mounted official instance, so this
 * kit carries only document definitions, log/exec helpers, capture-snapshot
 * builders and the global-layer assertion — never a fake Transport or a
 * supervisor seam (that layer retired with src/{server,transport}.ts).
 *
 * @module
 */

import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CaptureSnapshot, CapturedSection } from '../../src/facade.js'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import type { ServerDef } from '../../src/shared/model.js'

export { waitFor } from './wait.js'

/** Absolute path of the spawnable stdio fixture server. */
const fixtureServer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixture',
  'mcp-fixture-server.mjs',
)

/** One captured log line (the manager/seat logger shape). */
export interface LoggedLine {
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Structurally logger-compatible sink that also keeps the lines for assertions. */
export interface CapturingLogger {
  lines: LoggedLine[]
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Build a logger that records every line. */
export function makeLogger(): CapturingLogger {
  const lines: LoggedLine[] = []
  const push = (level: LoggedLine['level']) => (message: string): void => void lines.push({ level, message })
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}

/** Number of log lines at the given level (optionally containing a fragment). */
function countLines(lines: readonly LoggedLine[], level: LoggedLine['level'], fragment?: string): number {
  return lines.filter((line) => line.level === level && (fragment === undefined || line.message.includes(fragment))).length
}

/** The exact "server started" line the manager emits for one transport. */
export function started(lines: readonly LoggedLine[], name: string, transport: 'stdio' | 'streamable-http' = 'stdio'): number {
  return countLines(lines, 'info', 'mcp-scope(' + name + '): server started (' + transport + ')')
}

/** The exact "server stopped" line count for one server. */
export function stopped(lines: readonly LoggedLine[], name: string): number {
  return countLines(lines, 'info', 'mcp-scope(' + name + '): server stopped')
}

/** Minimal live-session run context for executor probes. */
export function execContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
    ...overrides,
  } as unknown as ToolRunContext
}

/** One stdio document row that spawns the in-repo fixture server. */
export function stdioDef(
  serverName = 'fix',
  extra: Partial<Extract<ServerDef, { transport: 'stdio' }>> = {},
): Extract<ServerDef, { transport: 'stdio' }> {
  return {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureServer],
    cwd: '',
    ...extra,
  }
}

/** A minimal but complete tool definition (capture/applier unit tests). */
export function toolDef(name: string, reply = 'ok'): ToolDefinition {
  return {
    name,
    description: 'tool ' + name,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render() {
        return [{ type: 'text', text: reply }]
      },
    },
    async execute() {
      return { content: [{ type: 'text', text: reply }] }
    },
  }
}

/** One captured prompt section with sensible defaults. */
export function capturedSection(
  overrides: Partial<CapturedSection> & { name: string },
): CapturedSection {
  return {
    order: 3100,
    text: () => '### MCP server: ' + overrides.name,
    interpolate: false,
    ...overrides,
  }
}

/** One minimal resource provider. */
export function resourceProvider(): McpResourceProvider {
  return { request: async () => ({}) } as McpResourceProvider
}

/** Build one capture generation (tools from a definition list or a name map). */
export function captureOf(
  tools: readonly ToolDefinition[] | ReadonlyMap<string, ToolDefinition> = [],
  overrides: Partial<CaptureSnapshot> = {},
): CaptureSnapshot {
  const map = new Map<string, ToolDefinition>()
  if (Array.isArray(tools)) {
    for (const definition of tools) map.set(definition.name, definition)
  } else {
    for (const [name, definition] of tools as ReadonlyMap<string, ToolDefinition>) map.set(name, definition)
  }
  return { tools: map, sections: [], resources: new Map(), truncated: false, version: 1, ...overrides }
}

/** Invariant 2 assertion: none of these names ever landed in the global tool layer. */
export function expectGlobalEmpty(tools: { get(name: string, scope?: unknown): unknown }, names: readonly string[]): void {
  for (const name of names) {
    expect(tools.get(name), 'invariant 2: ' + name + ' must never be global').toBeUndefined()
  }
}

/** Cordis activates injected child fibers off the current tick; let them land. */
export async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}
