/**
 * Browser half of dsh-chamber-mcp: registers the `mcp-scope` settings section
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

import type { Context } from '@deepseek-ai/cordis'
import { registerInjectionRow, type InjectionRegistrationHost } from './injection-row.js'
import type { CredentialInfo as CredentialInfoView } from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client' // 'settings.section' SlotMap entry + ctx.settingsScope merge (type-only)
import type {} from '@deepseek-ai/dsh-client-ui-tool/client' // 'tool.call.toolview' SlotMap entry (type-only)
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client' // ctx.slots merge (type-only; the renderer owns the slot registry in the 0.1.5 generation)
import type {} from '@deepseek-ai/dsh-client-locale/client' // ctx.locale merge (type-only)
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client' // ctx.workspaces merge + WorkspaceSnapshot (type-only)
import type {} from '@deepseek-ai/dsh-client-connection/client' // 'connection/reset' event merge (type-only)
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
import { mountStyles } from './styles.js'
import { createRuntimeStore } from './runtime.js'
import { mcpToolView } from './tool-card/view.js'
import {
  DEFAULT_TOOL_VIEW_LIMIT,
  createToolCardRegistry,
  startToolCardObserver,
  type SessionsLike,
} from './tool-card/register.js'

/** Diagnostic sink the client context may carry (never required). */
interface LoggerLike {
  warn(message: string): void
}

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
 * `sessions` is the transcript lane's data source (the staged session's event
 * window), and `slots` carries both the settings section and the keyed tool
 * rows.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'settingsScope', 'workspaces', 'sessions']

/**
 * Apply the browser half. The context type is cordis `Context` — the client
 * context of the 0.1.5 generation (the 0.1.2-era `dsh-client-runtime`
 * `ClientContext` is off the upstream release train). `effect` is declared on
 * cordis's own `Context`, and the cross-package augmentations this plugin
 * calls (`ctx.slots`/`ctx.locale`/`ctx.settingsScope`/`ctx.remote`/
 * `ctx.workspaces`) merge through this module's type-only imports, so no
 * local structural patch is needed.
 */
export function apply(ctx: Context): void {
  const logger = (ctx as unknown as { logger?: LoggerLike }).logger
  // (0) stylesheet: one <style data-plugin-css> tag appended to the document
  // (the official bundles' own convention — the built client may require
  // nothing but react, so the sheet ships as a string). Fiber-owned, so an
  // unload removes the tag it created.
  ctx.effect(() => mountStyles(), 'mcp-scope: styles')

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
  // (a2) conversation-lane notice: "MCP tools registered" (optional seat — a
  // deployment without the conversation service simply never renders it). The
  // row is DERIVED from the session's own events — the request tool array and
  // the rendered system prompt — so neither half writes a private session event
  // (see `src/client/injection.ts`); the settings document supplies the server
  // identity each public name belongs to.
  registerInjectionRow(ctx as unknown as InjectionRegistrationHost, {
    servers: () => controller.store.getSnapshot().doc.servers,
    onError: (error) => {
      // Contained like the tool-row lane: the notice stays off, the plugin apply
      // and the rest of the UI keep working.
      logger?.warn(`mcp-scope: conversation-lane notice could not register — the registered-tools row stays off: ${String(error)}`)
    },
  })
  // Live runtime status/actions over the Connection carrier's JSON routes.
  // Degradable by construction: without the route the store reports
  // "unavailable" and the document UI keeps working.
  const runtime = createRuntimeStore()

  ctx.effect(
    () => {
      const disposers: (() => void)[] = [controller.start()]
      // Forwarded-host-event freshness (rc.1 allowlist): a settings document
      // commit re-reads the scope snapshot + credential badges; a credential
      // reference change refreshes only badges.
      disposers.push(
        remote.$on('settings/document-updated', (ns: string) => {
          if (ns !== MCP_SCOPE_NAMESPACE) return
          controller.refresh()
          void runtime.refresh({ silent: true })
        }),
        remote.$on('credentials/reference-updated', (ref: string) => {
          controller.onCredentialRefUpdated(ref)
        }),
      )
      // A fresh connection generation can mean a restarted host: re-pull.
      const offReset = ctx.on('connection/reset', () => {
        void runtime.refresh({ silent: true })
      })
      disposers.push(offReset)
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'mcp-scope: controller wiring',
  )

  // (b) settings.section registration through the declaration inject seam.
  // The runtime store joins the same inject face: the section receives a
  // `useRuntime` hook seat plus the action callbacks.
  ctx.slots.inject('settings.section', () => {
    const face = controller.face()
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mcp-scope',
        order: 25,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({
          ...face,
          hooks: { ...face.hooks, runtime },
          refreshRuntime: (options?: { silent?: boolean; server?: string }) => runtime.refresh(options),
          connectServer: (serverName: string) => runtime.act(serverName, 'connect'),
          disconnectServer: (serverName: string) => runtime.act(serverName, 'disconnect'),
          testServer: (serverName: string) => runtime.test(serverName),
          loadTools: (serverName: string) => runtime.tools(serverName),
        }),
      },
      McpScopeSection,
    )
  })

  // (d) transcript lane: one keyed tool view per MCP tool the model was
  // actually offered. The name set is discovered from the staged session's own
  // event window (`request/header` carries the model-facing tool array), so
  // this lane needs NO host API — and a composition without the sessions
  // service simply leaves every MCP call on the shipped generic row. The
  // settings document supplies the server identity each public name belongs to
  // (serverName can itself contain '_', so the owning server is matched by the
  // longest configured prefix, never by splitting the name).
  ctx.effect(() => {
    let refused = false
    let registrationFailed = false
    let reconcileFailed = false
    const registry = createToolCardRegistry({
      host: {
        register(identity) {
          // `inject` waits for the slot declaration (the chat UI may compose
          // after this plugin) and returns the disposer that removes the row.
          // Registration runs from a session subscription, so a failure here
          // must NOT propagate into the transcript stream: it degrades to the
          // shipped row and is reported once (the lane's documented fallback).
          // `undefined` tells the reconciler the name is still unregistered,
          // so a later discovery/settings pass retries it.
          try {
            return ctx.slots.inject('tool.call.toolview', () =>
              ctx.slots.register(
                {
                  name: 'tool.call.toolview',
                  key: identity.publicName,
                  locale: NS,
                  // Shadowing rank 1 (lowest renders). A future official row
                  // for the same wire name wins, and a same-key/same-priority
                  // pair — which THROWS in the slot core, hitting whichever
                  // package registers second — is impossible by construction.
                  priority: 1,
                },
                mcpToolView(identity),
              ),
            )
          } catch (error) {
            if (!registrationFailed) {
              registrationFailed = true
              logger?.warn(
                `mcp-scope: could not register the MCP tool row for "${identity.publicName}" — MCP calls keep the generic row: ${String(error)}`,
              )
            }
            return undefined
          }
        },
      },
      servers: () => controller.store.getSnapshot().doc.servers,
      onRefuse: (name) => {
        if (refused) return
        refused = true
        // The cap protects the keyed dispatch, which scans the slot's entries
        // per row render; names past it keep the shipped generic row.
        logger?.warn(
          `mcp-scope: more than ${DEFAULT_TOOL_VIEW_LIMIT} MCP tools discovered — remaining MCP calls render as the generic tool row (first refused: ${name})`,
        )
      },
      onError: (error) => {
        // Reconciliation runs inside framework publish paths (session window,
        // settings commit): report once and keep the shipped rows.
        if (reconcileFailed) return
        reconcileFailed = true
        logger?.warn(`mcp-scope: MCP tool-row reconciliation failed — MCP calls keep the generic row: ${String(error)}`)
      },
    })
    const stop = startToolCardObserver({
      sessions: (ctx as unknown as { sessions?: SessionsLike }).sessions,
      registry,
    })
    // A settings commit can re-shape an identity (server renamed, transport
    // switched, server removed): re-run the diff against the new document
    // instead of waiting for the next discovery.
    const offDoc = controller.store.subscribe(() => registry.resync())
    return () => {
      stop()
      offDoc()
      registry.dispose()
    }
  }, 'mcp-scope: tool rows')
}