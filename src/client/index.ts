/**
 * Browser half of dsh-mcp-scope: registers the `mcp-scope` settings section
 * (locale + section registration + controller wiring).
 *
 * Required cordis services (fiber inject): slots, locale, remote
 * (settings/credentials wire events + the credentials namespace), the
 * settings scope binder, and the workspaces list feed used by the section.
 *
 * FE-3 note on the inject list: rows are activation/prefetch edges for the
 * services this plugin actually CALLS. `ctx.remote.credentials.*` is called
 * (wrapped below), so `remote.credentials` is listed like official plugins
 * do. `connection` is NOT listed: grep of src/client shows no runtime access
 * to `ctx.connection` anywhere (only comments named it), and the
 * settings/credentials transport needs no handle from us — official
 * settings-general keeps `connection` because it consumes it, which we do
 * not.
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

// Type-only re-exports (FE-10): the entry is the one exported subpath, so the
// useful component/controller types are re-exported here for typed consumers.
export type { SettingsKey } from './locales.js'
export type { McpScopeDoc, ServerDef } from '../shared/model.js'
export type {
  McpScopeFace,
  McpStoreSnapshot,
  McpStoreSource,
  SaveOutcome,
  SaveFailure,
  ServerSaveInput,
  SecretWrite,
  SettingsScopePort,
  CredentialsGateway,
  RemoteResultLike,
} from './controller.js'
export type { McpScopeSectionProps, SectionT, SnapshotHook } from './section.js'
export type { ServerCardProps } from './server-card.js'
export type { AddServerFormProps, AddDraft, AddProblems } from './add-form.js'
export type { WorkspaceItem, WorkspaceListHook, WorkspaceListStatus } from './workspaces.js'

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

/**
 * Required services (cordis fiber inject names). `remote.credentials` is the
 * dotted service this plugin actually calls; see the FE-3 note at the top.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'settingsScope', 'workspaces']

export function apply(ctxInput: ClientContext): void {
  const ctx = ctxInput as FiberAwareContext
  // (a) dictionaries — one registration, both built-in locales.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-scope: dictionaries')
  const t = ctx.locale.bind(NS)

  // (b/c) controller over the bound namespace scope + the credentials wire.
  // The credentials domain is reached through `ctx.remote.credentials` in
  // rc.1 (there is no `connection.api` on this runtime).
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
