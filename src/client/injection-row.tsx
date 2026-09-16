/**
 * Conversation lane row: "MCP registered" (sources and counts live behind the
 * expanded state only).
 *
 * A UI hint only: it tells the reader which MCP tools the plugin registered for
 * the session that a request belongs to — it is not part of the prompt, the
 * request, or the conversation. The host writes NOTHING into a session for it
 * (a private required session event would make the whole log unreadable — see
 * `src/client/injection.ts`). The row is derived from the harness's own session
 * events instead, through the official conversation extension points — the same
 * two seams the shipped lanes use:
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
 * The row's form follows the shipped conversation rows rule for rule (the
 * system-prompt card and the injected-context rows): one 24px disclosure line —
 * leading box, 13px secondary title, the marked-up source summary, a
 * hover/open chevron — that a click (or Enter/Space) expands into the shipped
 * 141px code-block scrollport. That body lists each owning server and the
 * public names it contributed; the collapsed line already carries the counts,
 * so the expansion answers "which tools", not "how many". No shipped component
 * is imported (the built client bundle may require nothing but react): the
 * geometry is reproduced here against the same `--dsw-*` tokens.
 *
 * The row is positioned as a header for the model-facing input that follows
 * it: a hair BEFORE the system-prompt card that opens the request's step. The
 * card, the user message and every auto-injected context row all follow; the
 * header event that names the tools is the LAST event of that assembly, so
 * anchoring on it put the notice under all of them (see {@link anchorSeqOf}).
 *
 * @module
 */

import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { McpChevronIcon, McpPlugIcon } from './tool-card/icon.js'
import { styles } from './styles.js'
import type { ServerDef } from '../shared/model.js'
import {
  MCP_INJECTION_NODE_KIND,
  injectionOmittedOf,
  injectionServersOfRequest,
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

/** Enter/Space activate a disclosure row, exactly like the shipped rows. */
function onDisclosureKey(event: KeyboardEvent<HTMLDivElement>, toggle: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  toggle()
}

/**
 * One disclosure line reading **MCP registered** — no source, no count: the
 * summary belongs to the expanded state, not to the transcript. Click (or
 * Enter/Space) opens the shipped code-block scrollport, which leads with ONE
 * line naming every source and its count and then gives each source its own
 * disclosure; a source's tool names appear only once that source is opened.
 */
export function McpInjectionRow({ node, t }: InjectionNodeProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [openServers, setOpenServers] = useState<readonly string[]>([])
  const payload = readInjectionPayload(node?.data)
  if (payload === undefined) return null
  const summary = payload.servers
    .map((server) => t('injection.entry', { name: server.name, count: server.toolCount }))
    .join(' · ')
  const toggle = (): void => setOpen((current) => !current)
  const toggleServer = (name: string): void => {
    setOpenServers((current) =>
      current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
    )
  }
  return (
    <div className={styles.injectionRoot} data-open={open || undefined} data-mcp-injection="">
      <div
        className={styles.injectionHead}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => onDisclosureKey(event, toggle)}
      >
        <span className={styles.injectionLeading}>
          {open ? (
            <span className={styles.injectionGlyphOpen}>
              <McpChevronIcon />
            </span>
          ) : (
            <>
              <span className={styles.injectionGlyphIdle}>
                <McpPlugIcon />
              </span>
              <span className={styles.injectionGlyphHover}>
                <McpChevronIcon />
              </span>
            </>
          )}
        </span>
        <span className={styles.injectionTitle}>{t('injection.title')}</span>
      </div>
      {open && (
        <div className={styles.injectionBody} data-injection-body="">
          {/* First line: every source with its count, on one line. */}
          <div className={styles.injectionSummary} data-injection-summary="">
            {summary}
          </div>
          {payload.servers.map((server) => {
            const serverOpen = openServers.includes(server.name)
            const serverOmitted = injectionOmittedOf(server)
            return (
              <div
                key={server.name}
                className={styles.injectionServer}
                data-injection-server={server.name}
                data-open={serverOpen || undefined}
              >
                <div
                  className={styles.injectionServerHead}
                  role="button"
                  tabIndex={0}
                  aria-expanded={serverOpen}
                  data-injection-server-head={server.name}
                  onClick={() => toggleServer(server.name)}
                  onKeyDown={(event) => onDisclosureKey(event, () => toggleServer(server.name))}
                >
                  <span className={styles.injectionServerGlyph}>
                    <McpChevronIcon size={12} />
                  </span>
                  <span className={styles.injectionServerName}>
                    {t('injection.entry', { name: server.name, count: server.toolCount })}
                  </span>
                </div>
                {serverOpen && (
                  <div className={styles.injectionServerTools} data-injection-server-tools="">
                    {server.tools.map((name, index) => (
                      // A repeated name is legal in a hostile header: index-qualify
                      // the key so React never sees a duplicate.
                      <div
                        key={name + '#' + String(index)}
                        className={styles.injectionToolName}
                        data-injection-tool={name}
                      >
                        {name}
                      </div>
                    ))}
                    {serverOmitted > 0 && (
                      <div className={styles.injectionOmitted}>{t('injection.omitted', { count: serverOmitted })}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
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
  step?: { step?: unknown; start?: { seq?: unknown } }
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
  /** Render position (a hair before the request's system-prompt card). */
  anchorSeq: number
  /** Whether the nearest earlier header offered the same set. */
  unchanged: boolean
}

/**
 * Render position of one header's row: a hair BEFORE the system-prompt card
 * that opens the request's step, so the notice reads as a header for the
 * model-facing input that follows it.
 *
 * The Chat lane's own `request-prompt` definition anchors that card on the
 * turn start for the first step of a turn and on the step start afterwards, so
 * the row mirrors that anchor and subtracts a hair. Everything the request
 * carries — the user message, the auto-injected context rows (workspace
 * instructions, runtime snapshot) — follows the card in seq order, and the
 * header event itself is the LAST event of the assembly; anchoring on the
 * header therefore rendered the notice under all of them (and anchoring after
 * the card put it between the card and the user's message). Before the card is
 * where a row about what the request carries belongs: it is not part of the
 * prompt, the request, or the conversation.
 */
const INJECTION_CARD_OFFSET = -0.1

/** Fallback for a window with no resolved step location: just before the header. */
const INJECTION_HEADER_OFFSET = -0.1

/** Sequence of one structurally narrowed location field, or undefined. */
function locationSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Anchor facts one earlier `request-prompt` Context publishes. */
interface PromptAnchorLike {
  turn?: unknown
  step?: unknown
}

/**
 * Render position of one header's row: immediately before the system-prompt
 * card, by mirroring the official `requestPromptAnchor` rule for rule and
 * subtracting a hair.
 *
 * The official rule is what the Chat lane uses to place the card, so copying it
 * — rather than only its common branch — keeps the row on the card's left in
 * every window shape: an unresolved location, a series that started before the
 * loaded window (no predecessor, and not an `initial` reason), and a header
 * that repeats the turn/step of its predecessor all anchor the card on the
 * header event itself, and the row follows at `header.seq - 0.1`.
 *
 * @param match - the accepted match (event plus resolved location).
 * @param previous - state of the nearest earlier `request-prompt` Context.
 * @param isInitial - whether the header's own reason is `initial`.
 * @returns the row's render position.
 */
function anchorSeqOf(match: InjectionMatchLike, previous: PromptAnchorLike | undefined, isInitial: boolean): number {
  const location = match.location
  if (location?.kind !== 'step') return seqOf(match.event) + INJECTION_HEADER_OFFSET
  if (previous === undefined && !isInitial) return seqOf(match.event) + INJECTION_HEADER_OFFSET
  if (previous?.turn === location.turn?.turn && previous?.step === location.step?.step) {
    return seqOf(match.event) + INJECTION_HEADER_OFFSET
  }
  const turnStart = locationSeq(location.turn?.start?.seq)
  const stepStart = locationSeq(location.step?.start?.seq)
  const firstStep = location.step?.step === 1
  const cardAnchor = firstStep
    ? (turnStart ?? stepStart ?? seqOf(match.event))
    : (stepStart ?? seqOf(match.event))
  return cardAnchor + INJECTION_CARD_OFFSET
}

/**
 * State of the nearest strictly-earlier Context of one kind, or undefined.
 *
 * Every read this lane performs goes through here: a composition without the
 * Chat lane, a window whose page left the bounded window, an unknown kind and a
 * hostile reader that throws all collapse to "absent", so `start()` can never
 * throw into a session.
 *
 * @param reader - the strict-backward Context reader, when the engine passes one.
 * @param kind - Definition kind whose predecessor state is wanted.
 * @returns the state, or undefined.
 */
function previousStateOf<State>(reader: InjectionContextReaderLike | undefined, kind: string): Readonly<State> | undefined {
  try {
    return reader?.previous<State>(kind)?.state
  } catch {
    return undefined
  }
}

/**
 * Effective rendered system prompt of the loaded window, read through the Chat
 * lane's own `system-message` Context — the same lookup its `request-prompt`
 * definition performs. Absent for the same reasons as {@link previousStateOf}:
 * the row then falls back to the header's tool array.
 *
 * @param reader - the strict-backward Context reader, when the engine passes one.
 * @returns the prompt text, or undefined.
 */
function effectivePromptOf(reader?: InjectionContextReaderLike): string | undefined {
  const state = previousStateOf<{ effective?: { text?: unknown } }>(reader, 'system-message')
  const text = state?.effective?.text
  return typeof text === 'string' && text !== '' ? text : undefined
}

/** Construction options of the notice definition. */
export interface InjectionRowOptions {
  /**
   * Live configured servers (read per match, never cached). Ownership is STRICT:
   * a name no configured server owns is not a registration and is dropped, so an
   * unloaded or unavailable settings document (the store reports an empty list
   * while loading) yields an empty set and that header's Context renders no row.
   * The next request assembles a new Context with the loaded list and emits the
   * row, so the gap lasts at most one request; a server removed from the
   * settings drops out of later rows the same way.
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

/**
 * Location this row declares on its node.
 *
 * Deliberately NOT the request's own step location, even though the Context has
 * one. The Chat lane orders visible nodes by `anchorSeq` and then applies TWO
 * turn-process rules to every node whose location is a turn or a step
 * (`@deepseek-ai/dsh-client-ui-chat`):
 *
 *  - `presentationPosition` re-anchors a node that sits BEFORE the turn's
 *    opening human input onto that input at rank 2 — i.e. renders it after the
 *    user message and after the collapsed process control, exactly where this
 *    hint must not go;
 *  - `ChatNodeSeat` folds a PROCESS WINDOW member away in the compact view, and
 *    membership is decided from `kind` plus `anchorSeq` alone (`processStartSeq`
 *    is the turn start) — a row anchored before its step would fall inside that
 *    window for every step but the first.
 *
 * A session-level location opts out of both. The first rule short-circuits on
 * `location.kind !== 'turn' && !== 'step'`, and the second never sees a
 * presentation at all: `ChatTurnProcessProjector.get(node)` resolves it through
 * `nodeTurn(node)`, which is `undefined` for this location, so
 * `useChatNodeProcess` yields nothing and `processWindowReady` is false. The
 * harness gives the same shape to events that carry no turn, and the row is
 * session-scoped by nature — it summarizes what the plugin registered, not
 * something the step produced.
 */
const INJECTION_NODE_LOCATION = { kind: 'session' } as const

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
      const servers: InjectionServer[] = injectionServersOfRequest(
        { header: match.event.data, prompt: effectivePromptOf(reader) },
        serversOf(),
      )
      const signature = injectionSignature(servers)
      const previous = previousStateOf<InjectionRowState>(reader, MCP_INJECTION_NODE_KIND)
      const promptAnchor = previousStateOf<PromptAnchorLike>(reader, 'request-prompt')
      const reason = (match.event.data as { reason?: unknown } | undefined)?.reason
      return {
        servers,
        signature,
        anchorSeq: anchorSeqOf(match, promptAnchor, reason === 'initial'),
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
      const current = context.current?.get('chat') as { anchorSeq?: unknown } | null | undefined
      const materialized = (current ?? null) !== null
      if (!visible && !materialized) return null
      // Keep the anchor the row was FIRST materialized with: the engine replays a
      // prepended history page through `start()` again, and without this a row
      // anchored at header - 0.1 could jump to card - 0.1 once its predecessor
      // page arrives (the official card stabilizes the same way, through
      // `stableRequestPromptAnchor`).
      const anchorSeq = typeof current?.anchorSeq === 'number' ? current.anchorSeq : state.anchorSeq
      return {
        key: context.key,
        kind: MCP_INJECTION_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq,
        location: INJECTION_NODE_LOCATION,
        visibility: visible ? 'visible' : 'hidden',
        data: { servers: state.servers },
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
        }, 'mcp-scope: registered-tools row')
      } catch (error) {
        report(error)
      }
    })
  } catch (error) {
    report(error)
  }
}
