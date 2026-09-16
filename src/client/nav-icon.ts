/**
 * Settings-sidebar glyph (browser half).
 *
 * The settings shell owns the nav row AND its glyph: `navIcon(id)` hardcodes one
 * mark per known section id (models / agent-presets / plugins /
 * archived-sessions) and falls back to the shipped settings gear for every other
 * id. That is true in BOTH generations this plugin supports
 * (`ui-settings-general` 0.1.5-rc.2 and 0.1.6-alpha.1), the `settings.section`
 * registration carries no icon option, and there is no icon seat — so a
 * registrant cannot supply one through an API.
 *
 * This module therefore paints the plugin's own plug mark into OUR row only. It
 * finds that row by the one fact the shell renders from our registration — the
 * localized label text — and accepts nothing but the shell's own row shape (a
 * button with exactly two element children: the glyph svg, then the label span).
 * The replacement keeps the shell glyph's class, so sizing and colour stay
 * shell-owned, and a marker attribute keeps re-application idempotent.
 *
 * Triggers: one paint at mount (the panel may already be open), a capture-phase
 * click (opening the panel renders the rows) and a childList observer scoped to
 * the row's OWN list, which repaints after a later render or a locale flip. A
 * shell that renames its DOM shape, a composition without the settings panel and
 * a different label all degrade to "no patch, the shipped gear stays": nothing
 * here throws, and no listener or observer outlives the returned disposer.
 *
 * @module
 */

import { MCP_PLUG_PATHS } from './tool-card/icon.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Marker on the node this module painted; makes re-application idempotent. */
const PAINTED_ATTR = 'data-mcp-scope-nav-glyph'

/** The shell's nav glyph element carrying this attribute is already ours. */
function alreadyPainted(glyph: Element): boolean {
  return glyph.getAttribute(PAINTED_ATTR) === '1'
}

/**
 * The shell's nav row for one label, or `undefined` when the shape is not the
 * shell's. Two element children exactly: the glyph svg first, then the label.
 */
function navRowOf(span: Element, label: string): Element | undefined {
  if (span.textContent !== label) return undefined
  const button = span.parentElement
  if (button === null || button.tagName !== 'BUTTON' || button.children.length !== 2) return undefined
  const glyph = button.firstElementChild
  if (glyph === null || glyph === span || glyph.tagName.toLowerCase() !== 'svg') return undefined
  return button
}

/** Build the plug mark as a DOM node, reusing the shell glyph's own class. */
function plugGlyph(doc: Document, size: number, className: string | null): Element {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute(PAINTED_ATTR, '1')
  if (className !== null) svg.setAttribute('class', className)
  for (const d of MCP_PLUG_PATHS) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/**
 * The scan scope: the settings panel when it is on the page (both generations
 * render it as `[role="dialog"]`), else the whole document. Scoping keeps the
 * sweep off the chat DOM and stops a same-labelled control elsewhere from
 * matching.
 */
function navScope(doc: Document): ParentNode {
  return doc.querySelector('[role="dialog"]') ?? doc
}

/** Paint every row carrying this label; report the count and the first row. */
function paintRows(doc: Document, label: string, size: number): { painted: number; row: Element | undefined } {
  if (label === '') return { painted: 0, row: undefined }
  let painted = 0
  let first: Element | undefined
  // `button > span` is the shell's own row shape and the cheapest selector that
  // can match it: a document-wide `span` sweep would grow with the chat DOM.
  for (const span of Array.from(navScope(doc).querySelectorAll('button > span'))) {
    const row = navRowOf(span, label)
    if (row === undefined) continue
    first ??= row
    const glyph = row.firstElementChild
    if (glyph === null || alreadyPainted(glyph)) continue
    glyph.replaceWith(plugGlyph(doc, size, glyph.getAttribute('class')))
    painted += 1
  }
  return { painted, row: first }
}

/**
 * Paint the plug into every nav row carrying this label.
 *
 * @param doc - the document to patch.
 * @param label - this plugin's current localized nav label.
 * @param size - glyph size in px (the shell's own nav glyphs are 16).
 * @returns how many rows were painted (0 = already ours, or no such row).
 */
export function paintNavGlyph(doc: Document, label: string, size = 16): number {
  return paintRows(doc, label, size).painted
}

/** Options of {@link mountNavGlyph}. */
export interface NavGlyphOptions {
  /** Current localized label of this plugin's settings section. */
  label: () => string
  /**
   * Optional change feed (e.g. `ctx.locale.subscribe`): a flip re-renders the
   * rows, so the patch waits for the next paint.
   */
  subscribe?: (onChange: () => void) => () => void
  /** Glyph size in px; the shell's own nav glyphs are 16. */
  size?: number
  /** Test seam; defaults to the ambient document. */
  doc?: Document
}

/**
 * Keep this plugin's settings nav row on its own glyph.
 *
 * @param options - see {@link NavGlyphOptions}.
 * @returns disposer that removes the listener, the observer and the subscription.
 */
export function mountNavGlyph(options: NavGlyphOptions): () => void {
  const doc = options.doc ?? (typeof document === 'undefined' ? undefined : document)
  if (doc === undefined || doc.body === null) return () => {}
  const size = options.size ?? 16
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let rowObserver: MutationObserver | undefined
  let observedList: Element | undefined
  let bodyObserver: MutationObserver | undefined
  let disposed = false

  const schedule = (): void => {
    if (disposed || scheduled !== undefined) return
    scheduled = setTimeout(run, 0)
  }

  function run(): void {
    scheduled = undefined
    if (disposed) return
    let row: Element | undefined
    try {
      // ONE sweep: the scan reports the row it matched, so the observer does not
      // walk the panel twice.
      row = paintRows(doc as Document, options.label(), size).row
    } catch {
      return // a shell change must never surface from here
    }
    if (row === undefined) return
    // The row is on the page: the panel-wide observer has done its job (it
    // covers a panel opened WITHOUT a click — a programmatic/onboarding open),
    // and the row-scoped one takes over for later re-renders.
    bodyObserver?.disconnect()
    bodyObserver = undefined
    const list = row.parentElement
    if (list === null || list === observedList) return
    // A composition (or a test harness) without MutationObserver keeps the
    // click/change triggers and simply never re-observes the list.
    if (typeof MutationObserver !== 'function') return
    rowObserver?.disconnect()
    rowObserver = new MutationObserver(() => schedule())
    try {
      rowObserver.observe(list, { childList: true, subtree: true })
      observedList = list
    } catch {
      rowObserver = undefined
      observedList = undefined
    }
  }

  const onClick = (): void => schedule()
  doc.addEventListener('click', onClick, true)
  // The change feed is optional in practice as well as in signature: a face
  // without `subscribe` (a fake composition, an older host) must not make the
  // mount throw — the click and mount triggers still patch the row.
  let offChange: (() => void) | undefined
  try {
    offChange = options.subscribe?.(() => schedule())
  } catch {
    offChange = undefined
  }
  // Until our row is on the page, watch the document itself: that covers a panel
  // opened without a click, and it is disconnected the moment the row is found
  // (so the steady-state cost is the row's own list, not the whole app).
  try {
    if (typeof MutationObserver === 'function') {
      bodyObserver = new MutationObserver(() => {
        // Only the settings panel can hold our row, so a mutation batch with no
        // panel on the page (a streaming chat, a transcript update) costs one
        // cheap `[role="dialog"]` probe instead of a scan.
        try {
          if ((doc as Document).querySelector('[role="dialog"]') !== null) schedule()
        } catch {
          /* a shell change must never surface from here */
        }
      })
      bodyObserver.observe(doc.body, { childList: true, subtree: true })
    }
  } catch {
    bodyObserver = undefined
  }
  run()
  return () => {
    disposed = true
    doc.removeEventListener('click', onClick, true)
    offChange?.()
    bodyObserver?.disconnect()
    rowObserver?.disconnect()
    if (scheduled !== undefined) clearTimeout(scheduled)
  }
}
