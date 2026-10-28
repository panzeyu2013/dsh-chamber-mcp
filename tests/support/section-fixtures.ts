/** Shared pure fixtures for the settings section suites. */
import { en, type SettingsKey } from '../../src/client/locales.ts'
import type { McpScopeDoc, ServerDef, WorkspaceOverrides } from '../../src/shared/model.ts'
import type { RuntimeSnapshot, ServerRuntimeView } from '../../src/client/runtime.ts'

/** English dictionary reader with the section's {name} interpolation. */
export function translate(dictionary: Record<string, string> = en) {
  return (key: SettingsKey, params?: Record<string, string | number>): string =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

export const t = translate()

/** Wait for React's commits/effects; a few milliseconds is enough in jsdom. */
export const flush = (ms = 2): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One stdio definition with the section tests' short argument fixture. */
export const stdioServer = (
  serverName: string,
  envKeys: string[] = [],
  extra: Partial<{ command: string; args: string[] }> = {},
): ServerDef => ({
  serverName,
  transport: 'stdio',
  command: extra.command ?? 'node',
  args: extra.args ?? ['a.js'],
  ...(envKeys.length > 0 ? { envKeys } : {}),
})

/** One Streamable HTTP definition. */
export const httpServer = (
  serverName: string,
  url: string,
  headers: { name: string; ref: string }[],
): ServerDef => ({
  serverName,
  transport: 'streamable-http',
  url,
  headers,
})

/** Build sparse enable rows from the test shorthand. */
export const overridesOf = (rows: Record<string, string[]>): WorkspaceOverrides =>
  Object.fromEntries(
    Object.entries(rows).map(([workspaceId, names]) => [
      workspaceId,
      Object.fromEntries(names.map((name) => [name, true as const])),
    ]),
  )

/** One runtime view with the fields the section renders. */
export const viewOf = (name: string, state: ServerRuntimeView['state'] = 'connected'): ServerRuntimeView => ({
  name,
  state,
  attempts: 0,
  maxAttempts: 10,
  toolCount: 2,
  syncedAt: 1_000,
})

/** One ready snapshot with a single server view. */
export const runtimeWith = (name: string, state: ServerRuntimeView['state'] = 'connected'): RuntimeSnapshot => ({
  phase: 'ready',
  servers: { [name]: viewOf(name, state) },
})

export type SectionDoc = McpScopeDoc
