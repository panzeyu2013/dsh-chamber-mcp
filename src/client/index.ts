/**
 * Browser half of dsh-chamber-mcp: registers the `mcp-scope` settings section
 * and its navigation icon (locale + section + `settings.section.icon`
 * registrations + controller wiring).
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
import type {} from '@deepseek-ai/dsh-client-ui-settings/client' // 'settings.section' SlotMap entry + ctx.configForms merge (type-only)
import type {} from '@deepseek-ai/dsh-client-ui-tool/client' // 'tool.call.toolview' SlotMap entry (type-only)
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client' // ctx.slots merge (type-only; the renderer owns the slot registry)
import type {} from '@deepseek-ai/dsh-client-locale/client' // ctx.locale merge (type-only)
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client' // ctx.workspaces merge + WorkspaceSnapshot (type-only)
import type {} from '@deepseek-ai/dsh-client-connection/client' // 'connection/reset' event merge (type-only)
import type { McpScopeDoc } from '../shared/model.js'
import { MCP_SCOPE_NAMESPACE } from '../shared/model.js'
import { en, zh, NS, type SettingsKey } from './locales.js'
import {
  McpScopeController,
  type CredentialsGateway,
  type RemoteResultLike,
} from './controller.js'
import { McpScopeSection } from './section.js'
import { mountStyles } from './styles.js'
import { createRuntimeStore, readShellBasePath } from './runtime.js'
import { McpSectionGlyph } from './tool-card/icon.js'
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
 * 0.2.2-line Remote wire facts (measured on the rc.1 anchor, re-verified against
 * rc.3 by the live smoke and jsdom flows). The installed dev tree does not ship the generated
 * `dsh-api-gateway`/`dsh-api-settings-controller` type packages, so
 * `ctx.remote` collapses to `any` here; the shapes below come from the
 * anchor install's `dsh-api-settings-controller/lib/typert.remote-client.d.ts`
 * and `dsh-api-remotes/lib/types/remote-events.d.ts` (authoritative runtime).
 */
interface McpRemoteWire {
  $on(event: 'settings/document-updated', listener: (ns: string, revision: number) => void): () => void
  $on(event: 'credentials/reference-updated', listener: (ref: string) => void): () => void
  /**
   * Forwarded credentials event (alpha.2, mode emit): a stored credential
   * RECORD changed. The OAuth grant commit lands here, which is what makes the
   * authorization pill flip without a fast poll; the store filters the
   * mcp-client/ namespace and refreshes silently.
   */
  $on(event: 'credentials/record-updated', listener: (key: string) => void): () => void
  credentials: {
    describe(refs: string[]): Promise<RemoteResultLike<Record<string, CredentialInfoView>>>
    set(ref: string, value: string): Promise<RemoteResultLike<void>>
    unset(ref: string): Promise<RemoteResultLike<void>>
  }
}

// Type-only re-exports: the entry is the one exported browser subpath
// (`dsh-chamber-mcp/client`), so only the types a typed consumer actually names
// are re-exported. The consumer-types gate (scripts/verify-package.mjs) is
// authoritative: it pins exactly the five types below, and every other
// component/controller type the browser half defines is internal.
export type { McpScopeFace, McpStoreSnapshot, SaveOutcome } from './controller.js'
export type { McpScopeSectionProps } from './section.js'
export type { AddDraft } from './draft.js'

/** Fold the Remote result union: business failures become thrown errors. */
async function unwrap<T>(result: RemoteResultLike<T>): Promise<T> {
  if (result.ok) return result.value
  const error: Error & { code?: string } = new Error(result.error?.message ?? result.error?.code ?? 'remote error')
  error.code = result.error?.code
  throw error
}

/** Adapter from the 0.2.2-generation `remote.credentials` namespace to the gateway. */
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
 * window), and `slots` carries the settings section, its nav icon and the
 * keyed tool rows.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms', 'workspaces', 'sessions']

/**
 * Apply the browser half. The context type is cordis `Context` — the client
 * context of the supported generation (the 0.1.2-era `dsh-client-runtime`
 * `ClientContext` is off the upstream release train). `effect` is declared on
 * cordis's own `Context`, and the cross-package augmentations this plugin
 * calls (`ctx.slots`/`ctx.locale`/`ctx.configForms`/`ctx.remote`/
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

  // Registration containment (ADR-10). A slot registration must degrade to the
  // shipped fallback — no section, no icon, generic tool row — instead of
  // throwing into the app: `apply` runs in the shell's mount path, where a throw
  // kills the whole browser half. A Promise returned by the registration body is
  // absorbed too, so an async failure becomes one warning instead of an
  // unhandled rejection. Each seat warns once per apply.
  const contained = new Set<string>()
  const contain = (what: string, run: () => unknown): void => {
    const report = (error: unknown): void => {
      if (contained.has(what)) return
      contained.add(what)
      logger?.warn('mcp-scope: ' + what + ' could not register — the shipped fallback stays in place: ' + String(error))
    }
    try {
      const pending = run()
      if (typeof (pending as { then?: unknown } | null | undefined)?.then === 'function') {
        void Promise.resolve(pending as PromiseLike<unknown>).catch(report)
      }
    } catch (error) {
      report(error)
    }
  }

  // (b/c) controller over the entry's own Config form + the credentials wire.
  // 0.1.7 derives settings forms from each Loader entry's Config, so the
  // document is addressed by the profile entry id — `mcp-scope` in
  // cordis.patch.yml, the same id the legacy `settings.yaml` section imports
  // into. The credentials domain is reached through `ctx.remote.credentials`
  // in this generation (there is no `connection.api`).
  const scope = ctx.configForms.get<McpScopeDoc>(MCP_SCOPE_NAMESPACE)
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
  //
  // The chamber desktop mounts this UI into the SHELL's own document: its asset
  // URLs are root-relative, no base global is injected, and a root-relative
  // plugin request is answered by the shell's static layer with
  // `404 {"error":"not_found"}` — which is why every status read "unknown" there.
  // The shell provides the instance prefix to the plugins it mounts as
  // `chamberBasePath`, so that service is the authoritative signal. It is NOT
  // reachable by property access: cordis answers a service no fiber provided —
  // and that this fiber never declared in `inject` — with a THROW, and a plain
  // `dsh web` document has no such service at all, so a bare `ctx.chamberBasePath`
  // would abort the first refresh before a single request and leave the panel
  // exactly as broken as the fix set out to repair (the shell's own plugins read
  // it the same defensive way). `readShellBasePath` is the total accessor.
  const runtime = createRuntimeStore({
    shellBasePath: () => readShellBasePath(ctx),
  })

  ctx.effect(
    () => {
      const disposers: (() => void)[] = [controller.start()]
      // Forwarded-host-event freshness (0.1.7 allowlist): the settings client
      // already reloads the SAME mirror our ConfigForm reads on
      // `settings/document-updated`, and the controller subscribes to that
      // form — so only the credential badges / runtime knowledge this plugin
      // owns needs an extra pull here.
      disposers.push(
        remote.$on('settings/document-updated', (ns: string) => {
          if (ns !== MCP_SCOPE_NAMESPACE) return
          void runtime.refresh({ silent: true })
        }),
        remote.$on('credentials/reference-updated', (ref: string) => {
          controller.onCredentialRefUpdated(ref)
        }),
        // OAuth grant commits arrive as credential-record updates; the browser
        // cannot derive the hashed per-server key, so the store filters the
        // mcp-client/ namespace and silently refreshes the whole status.
        remote.$on('credentials/record-updated', (key: string) => {
          runtime.onCredentialRecordUpdated(key)
        }),
      )
      // A fresh connection generation can mean a restarted host or a different
      // instance: forget every base proven dead by the previous generation (and
      // re-arm discovery) before re-pulling, or a page whose instance moved stays
      // dark until it is reloaded.
      const offReset = ctx.on('connection/reset', () => {
        runtime.resetBases()
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
  //
  // The registration body runs once per declaration epoch (the renderer runs
  // the injected callback inside a nested effect), so containment lives INSIDE
  // that callback as well: a throw on a LATER reconcile is rethrown by the
  // renderer in a microtask, where no caller-side catch can see it.
  contain('the settings section', () => {
    ctx.slots.inject('settings.section', () => {
      let dispose: (() => void) | undefined
      contain('the settings section', () => {
        const face = controller.face()
        dispose = ctx.slots.register(
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
              restartServer: (serverName: string) => runtime.act(serverName, 'restart'),
              testServer: (serverName: string) => runtime.test(serverName),
              authorizeServer: (serverName: string) => runtime.authorize(serverName),
              cancelAuthorization: (serverName: string, attemptId: string) =>
                runtime.cancelAuthorization(serverName, attemptId),
              signOutServer: (serverName: string) => runtime.signOut(serverName),
              loadTools: (serverName: string) => runtime.tools(serverName),
            }),
          },
          McpScopeSection,
        )
      })
      return dispose ?? (() => {})
    })
  })

  // (b1) settings.section.icon: the official seat for a section's navigation
  // mark. The shell renders every nav row through
  // `renderSlot('settings.section.icon', { size, active }, { only: row.id,
  // fallback: navIcon(row.id) })`, so a contribution whose id equals our
  // section id is the supported way to own the mark. The retired DOM patch
  // was a measured no-op on the real shell (its row is
  // `button > span.navIcon > svg` + `span.navLabel`, while the patch required a
  // first-child svg) — this seat is what actually paints the plug. The glyph
  // inherits the row's currentColor, so `active` needs no handling.
  contain('the settings sidebar icon', () => {
    ctx.slots.inject('settings.section.icon', () => {
      let dispose: (() => void) | undefined
      contain('the settings sidebar icon', () => {
        dispose = ctx.slots.register(
          { name: 'settings.section.icon', id: 'mcp-scope', locale: NS },
          McpSectionGlyph,
        )
      })
      return dispose ?? (() => {})
    })
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
    let unsupported = false
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
      onUnsupported: (reason) => {
        // The lane and the runtime disagree about the session service: nothing
        // registers and every MCP row stays generic. That is the documented
        // fallback, but it must not be INVISIBLE — report once so an unsupported
        // generation is diagnosable from the browser console.
        if (unsupported) return
        unsupported = true
        logger?.warn(
          `mcp-scope: the sessions service cannot feed the MCP tool-row lane — MCP calls keep the generic row: ${reason}`,
        )
      },
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