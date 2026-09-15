/**
 * Conversation lane row: "MCP tools injected".
 *
 * The host writes NOTHING into a session for this notice (a private required
 * session event would make the whole log unreadable — see
 * `src/client/injection.ts`). The row is derived from the harness's own
 * `request/header` events instead, through the official conversation extension
 * points — the same two seams the shipped lanes use:
 *
 *   - `ctx.uiConversation.events.register(definition)` maps a session event to
 *     a view node (the Chat lane's `request-prompt` definition uses exactly this
 *     seam for the same event type), and
 *   - the keyed `conversation.chat.node` seat renders that node kind.
 *
 * ONE row per changed set. Every header owns its own Context (id = its seq, the
 * official `request-prompt` pattern), and `start` compares its set against the
 * nearest predecessor Context of this kind: an unchanged set renders no node at
 * all, so a session whose servers re-sync with the same tools stays quiet while
 * a real change adds one line where it took effect. Every match is a `start`
 * with a unique id, so the definition can never collide with the engine's
 * "more than one start Match" rule, and a header that is not the first in the
 * loaded window (or a header outside it) still renders correctly.
 *
 * Both seams are optional and additive: a deployment without the conversation
 * service keeps working (nothing registers, nothing throws), and a malformed
 * payload renders nothing instead of an error.
 *
 * @module
 */

import type { ReactElement } from 'react'
import { McpPlugIcon } from './tool-card/icon.js'
import { styles } from './styles.js'
import type { ServerDef } from '../shared/model.js'
import {
  MCP_INJECTION_NODE_KIND,
  injectionServersOfHeader,
  injectionSignature,
  readInjectionPayload,
  type InjectionPayload,
  type InjectionServer,
} from './injection.js'
import type { SettingsKey } from './locales.js'
import { NS } from './locales.js'

/** Locale reader handed to every seat view. */
export type InjectionTranslate = (key: SettingsKey, params?: Record<string, string | number>) => string

/** The view node this lane renders (structurally narrowed: no package import). */
export interface InjectionNodeProps {
  node?: { data?: unknown }
  t: InjectionTranslate
}

/** One line: [plug] MCP tools injected · zotero (43) · email (18) */
export function McpInjectionRow({ node, t }: InjectionNodeProps): ReactElement | null {
  const payload = readInjectionPayload(node?.data)
  if (payload === undefined) return null
  const details = payload.servers
    .map((server) => t('injection.entry', { name: server.name, count: server.toolCount }))
    .join(' · ')
  return (
    <div className={styles.injectionRow} data-mcp-injection="">
      <span className={styles.injectionIcon} aria-hidden="true">
        <McpPlugIcon />
      </span>
      <span className={styles.injectionTitle}>{t('injection.title')}</span>
      <span className={styles.injectionDetail}>{details}</span>
      <span className={styles.injectionTotal}>{t('injection.total', { count: payload.total })}</span>
    </div>
  )
}

/** Session events this definition accepts (structural: no package import). */
export interface InjectionEventLike {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

/** Resolved location of one match (structural: no package import). */
export interface InjectionLocationLike {
  kind?: unknown
  turn?: { turn?: unknown; start?: { seq?: unknown } }
  step?: { start?: { seq?: unknown } }
}

/** Accepted match handed back to `start`. */
export interface InjectionMatchLike {
  event: InjectionEventLike
  location?: InjectionLocationLike
}

/** Strictly-backward Context lookup the engine offers while a start is evaluated. */
export interface InjectionContextReaderLike {
  previous<State>(kind: string): { readonly state: Readonly<State> } | undefined
}

/** Context view handed to `start` / `buildViewNode` (only what this row reads). */
export interface InjectionNodeContextLike<State> {
  key: string
  id: string
  state?: State
  start?: InjectionMatchLike
  matches?: readonly InjectionMatchLike[]
  /**
   * Latest node this Context materialized per view target (the engine sets it
   * after every build). Read only to honor the engine's "a Definition must never
   * withdraw a materialized target" rule.
   */
  current?: ReadonlyMap<string, unknown>
}

/** State carried from one header's `start` to `buildViewNode`. */
export interface InjectionRowState extends InjectionPayload {
  /** Change key of this set; equal to the predecessor's ⇒ no row. */
  signature: string
  /** Render position (the header's own seq neighborhood). */
  anchorSeq: number
  /** Whether the nearest earlier header offered the same set. */
  unchanged: boolean
}

/**
 * Render position of one header's row: just before the header event's own row
 * (`processControl` neighborhood), so the notice lands inside the step whose
 * request carried the tools.
 */
const INJECTION_ANCHOR_OFFSET = -0.1

/** Construction options of the notice definition. */
export interface InjectionRowOptions {
  /**
   * Live configured servers (read per match, never cached). Absent in a test or
   * a composition without the settings document: the row then falls back to the
   * first `__` boundary of a public name for ownership.
   */
  servers?: () => readonly ServerDef[]
  /**
   * Called (at most once) when the lane could not register at all — a double
   * apply on HMR, a duplicate Definition kind, or a keyed-slot collision. The
   * lane then stays OFF instead of failing the plugin's own apply.
   */
  onError?: (error: unknown) => void
}

/** One accepted match; the engine reads role and identity from the event only. */
export interface InjectionNodeDefinition {
  kind: string
  target: string
  match(event: InjectionEventLike): { id: string; role: 'start' } | null
  start(context: unknown, match: InjectionMatchLike, reader?: InjectionContextReaderLike): InjectionRowState
  update(context: { state: InjectionRowState }): InjectionRowState
  buildViewNode(context: InjectionNodeContextLike<InjectionRowState>): Record<string, unknown> | null
}

/** Best currently loaded location, mirroring the Chat lane's own helper. */
function locationOf(context: InjectionNodeContextLike<InjectionRowState>): unknown {
  return context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
}

/** Sequence of one structurally narrowed event, or 0 when it is unusable. */
function seqOf(event: InjectionEventLike): number {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0
}

/**
 * Build the notice definition.
 *
 * @param options - live server source for longest-prefix ownership.
 * @returns the Conversation Node Definition registered for the chat target.
 */
export function createInjectionNodeDefinition(options: InjectionRowOptions = {}): InjectionNodeDefinition {
  const serversOf = (): readonly ServerDef[] => options.servers?.() ?? []
  return {
    kind: MCP_INJECTION_NODE_KIND,
    target: 'chat',
    /**
     * Every `request/header` opens its own Context, identified by its own seq:
     * the engine requires exactly one `start` per Context id, and a per-event id
     * makes that structural rather than dependent on which header the bounded
     * window happens to contain.
     */
    match(event: InjectionEventLike): { id: string; role: 'start' } | null {
      if (event === null || typeof event !== 'object') return null
      if (event.type !== 'request/header') return null
      return { id: String(seqOf(event)), role: 'start' }
    },
    start(_context, match: InjectionMatchLike, reader?: InjectionContextReaderLike): InjectionRowState {
      const servers: InjectionServer[] = injectionServersOfHeader(match.event.data, serversOf())
      const signature = injectionSignature(servers)
      const previous = reader?.previous<InjectionRowState>(MCP_INJECTION_NODE_KIND)?.state
      return {
        servers,
        total: servers.reduce((sum, server) => sum + server.toolCount, 0),
        signature,
        anchorSeq: seqOf(match.event) + INJECTION_ANCHOR_OFFSET,
        unchanged: previous !== undefined && previous.signature === signature,
      }
    },
    /** Every match starts its own Context; an update only preserves the state. */
    update(context: { state: InjectionRowState }): InjectionRowState {
      return context.state
    },
    buildViewNode(context: InjectionNodeContextLike<InjectionRowState>): Record<string, unknown> | null {
      const state = context.state
      if (state === undefined) return null
      // An unchanged set adds no row, and an empty set has nothing to announce.
      const visible = !state.unchanged && state.servers.length > 0
      // A LATER evaluation can flip this Context to unchanged/empty: a prepended
      // history page supplies the predecessor the first pass could not see, or a
      // live settings edit re-shapes server ownership. The engine REJECTS a
      // Definition that withdraws a materialized target ("return the same key
      // with hidden visibility instead" — assembler.ts buildTargetUpserts, the
      // rule the shipped `request-prompt` definition follows), so a context that
      // already materialized its row re-emits the same Key HIDDEN instead of
      // returning null.
      const materialized = (context.current?.get('chat') ?? null) !== null
      if (!visible && !materialized) return null
      return {
        key: context.key,
        kind: MCP_INJECTION_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: state.anchorSeq,
        location: locationOf(context),
        visibility: visible ? 'visible' : 'hidden',
        data: { servers: state.servers, total: state.total },
      }
    },
  }
}

/** The bits of the client context this lane needs (injectable, optional). */
export interface InjectionRegistrationHost {
  inject(names: readonly string[], apply: (scope: InjectionScope) => void): void
}

/** Scope of the `uiConversation` injection. */
export interface InjectionScope {
  effect(callback: () => void | (() => void), label?: string): void
  slots: {
    inject(seat: string, callback: () => void | (() => void)): void
  }
  uiConversation: {
    events: { register(definition: unknown): void | (() => void) }
  }
}

/**
 * Register the event definition and the keyed chat-node view. Called from the
 * plugin's own apply; the nested inject keeps hosts without the conversation
 * service fully functional.
 *
 * @param ctx - client context carrying the optional `inject` seam.
 * @param options - live server source for longest-prefix ownership.
 */
export function registerInjectionRow(ctx: InjectionRegistrationHost, options: InjectionRowOptions = {}): void {
  // Degradable by construction: a host (or a test harness) whose context has no
  // optional-service inject simply never gets the row. Registration failures are
  // contained the same way the sibling tool-row lane contains them — a duplicate
  // Definition kind (a second apply without disposal) or a keyed-slot collision
  // must degrade the ROW, never fail the plugin's own apply.
  if (typeof ctx.inject !== 'function') return
  let reported = false
  const report = (error: unknown): void => {
    if (reported) return
    reported = true
    options.onError?.(error)
  }
  try {
    ctx.inject(['uiConversation'], (scope) => {
      try {
        scope.effect(() => {
          const disposeDefinition = scope.uiConversation.events.register(createInjectionNodeDefinition(options))
          scope.slots.inject('conversation.chat.node', () =>
            (scope as unknown as {
              slots: { register(options: Record<string, unknown>, view: unknown): void | (() => void) }
            }).slots.register(
              { name: 'conversation.chat.node', key: MCP_INJECTION_NODE_KIND, locale: NS },
              McpInjectionRow,
            ),
          )
          return () => {
            if (typeof disposeDefinition === 'function') disposeDefinition()
          }
        }, 'mcp-scope: injected-tools row')
      } catch (error) {
        report(error)
      }
    })
  } catch (error) {
    report(error)
  }
}
