/**
 * Browser half of dsh-mcp-scope: registers the `mcp-scope` settings section
 * (locale + section registration + controller wiring).
 *
 * Required cordis services (fiber inject): slots, locale, connection, remote
 * (settings/credentials wire events + the credentials namespace), the
 * settings scope binder, and the workspaces list feed used by the section.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { CredentialInfo as CredentialInfoView } from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client' // 'settings.section' SlotMap entry + ctx.settingsScope merge (type-only)
import type {} from '@deepseek-ai/dsh-client-locale/client' // ctx.locale merge (type-only)
import type { McpScopeDoc } from '../shared/model.js'
import { MCP_SCOPE_NAMESPACE } from '../shared/model.js'
import { en, zh, NS, type SettingsKey } from './locales.js'
import {
  McpScopeController,
  decodeDoc,
  type CredentialsGateway,
  type RemoteResultLike,
} from './controller.js'
import { McpScopeSection } from './section.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'mcp-scope.settings': SettingsKey
  }
}

/**
 * rc.1 Remote wire facts. The installed dev tree does not ship the generated
 * `dsh-api-gateway`/`dsh-api-settings-controller` type packages, so
 * `ctx.remote` collapses to `any` here; the shapes below come from the
 * anchor install's `dsh-api-settings-controller/lib/typert.remote-client.d.ts`
 * and `dsh-api-remotes/lib/types/remote-events.d.ts` (authoritative runtime).
 */
interface McpRemoteWire {
  $on(event: 'settings/document-updated', listener: (ns: string, revision: number) => void): () => void
  $on(event: 'credentials/reference-updated', listener: (ref: string) => void): () => void
  credentials: {
    describe(refs: string[]): Promise<RemoteResultLike<Record<string, CredentialInfoView>>>
    set(ref: string, value: string): Promise<RemoteResultLike<void>>
    unset(ref: string): Promise<RemoteResultLike<void>>
  }
}

export type { SettingsKey } from './locales.js'
export type { McpScopeDoc, ServerDef } from '../shared/model.js'

/**
 * cordis fiber typing note: the package augments its own `Context` with
 * `effect` through a RELATIVE module augmentation (`declare module
 * './context.ts'` inside fiber.d.ts). Against the shipped d.ts-only npm tree
 * that specifier cannot resolve to a file, so under NodeNext the merge is
 * silently lost for consumers (cross-package absolute augmentations like
 * `ctx.locale`/`ctx.settingsScope`/`ctx.slots` merge fine). Runtime behavior
 * is unaffected — `ctx.effect` is mixed onto the proxied context. This one
 * localized structural type restores the surface we call.
 */
type FiberAwareContext = ClientContext & {
  effect(execute: () => void | (() => void) | Iterable<() => void>, label?: string): unknown
}

/** Fold the Remote result union: business failures become thrown errors. */
async function unwrap<T>(result: RemoteResultLike<T>): Promise<T> {
  if (result.ok) return result.value
  const error: Error & { code?: string } = new Error(result.error?.message ?? result.error?.code ?? 'remote error')
  error.code = result.error?.code
  throw error
}

/** Adapter from the rc.1 `remote.credentials` namespace to the gateway. */
function remoteCredentials(wire: McpRemoteWire): CredentialsGateway {
  return {
    async describe(refs) {
      return unwrap(await wire.credentials.describe([...refs]))
    },
    async set(ref, value) {
      return unwrap(await wire.credentials.set(ref, value))
    },
    async unset(ref) {
      return unwrap(await wire.credentials.unset(ref))
    },
  }
}

/** Required services (cordis fiber inject names). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'workspaces']

export function apply(ctxInput: ClientContext): void {
  const ctx = ctxInput as FiberAwareContext
  // (a) dictionaries — one registration, both built-in locales.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-scope: dictionaries')
  const t = ctx.locale.bind(NS)

  // (b/c) controller over the bound namespace scope + the credentials wire.
  // The credentials domain is reached through `ctx.remote.credentials` in
  // rc.1 (there is no `connection.api` on this runtime); 'connection' stays
  // in the inject list because the settings/credentials transport lives on
  // the connection generation.
  const scope = ctx.settingsScope.bind<McpScopeDoc>({
    namespace: MCP_SCOPE_NAMESPACE,
    decode: decodeDoc,
  })
  const remote = ctx.remote as unknown as McpRemoteWire
  const controller = new McpScopeController(scope, remoteCredentials(remote))

  ctx.effect(
    () => {
      const disposers: (() => void)[] = [controller.start()]
      // Forwarded-host-event freshness (rc.1 allowlist): a settings document
      // commit re-reads the scope snapshot + credential badges; a credential
      // reference change refreshes only badges.
      disposers.push(
        remote.$on('settings/document-updated', (ns: string) => {
          if (ns === MCP_SCOPE_NAMESPACE) controller.refresh()
        }),
        remote.$on('credentials/reference-updated', (ref: string) => {
          controller.onCredentialRefUpdated(ref)
        }),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'mcp-scope: controller wiring',
  )

  // (b) settings.section registration through the declaration inject seam.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mcp-scope',
        order: 25,
        label: () => t('nav'),
        locale: NS,
        inject: () => controller.face(),
      },
      McpScopeSection,
    ),
  )
}
