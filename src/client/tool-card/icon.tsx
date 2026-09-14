/**
 * Icons of the MCP tool row.
 *
 * The plug mark is drawn here rather than taken from the icon set: dsh ships
 * no MCP glyph, and the official MCP mark is a brand asset whose fine stroke
 * muddies at 14px. The geometry is authored on the same 24-unit canvas the
 * dsh icons use and rendered at 14px, so its visual stroke weight matches the
 * shipped set; it inherits `currentColor`, which is what lets the row tint it
 * per state (running / settled) from the design tokens alone.
 *
 * The state mark and the chevron follow the shipped rows exactly: a terminal
 * state yields the icon slot to a status dot (the tool row's own convention —
 * error = red, interrupted = amber, both as an opaque 10px core inside a 10%
 * halo), and an expandable row swaps its glyph for the chevron on hover, or
 * for good once open.
 *
 * All three glyphs are inline: the row then owns no icon-package edge at all,
 * so its unit render runs without the primitives package's own runtime
 * dependencies, and the shipped bundle stays as thin as the rest of the plugin.
 *
 * @module
 */

import { styles } from '../styles.js'
import type { McpToolRowState } from './names.js'

/** Chevron apex offsets on the shared 24-unit canvas. */
const CHEVRON = 'M6 9l6 6 6-6'

/** Plug glyph: the "attached to an external server" mark of an MCP call. */
export function McpPlugIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  )
}

/** Expand affordance: the same downward chevron the shipped rows swap in. */
export function McpChevronIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={CHEVRON} />
    </svg>
  )
}

/**
 * Terminal-state mark of one row: the shipped `StateDot` in its two solid
 * outcomes (a 10px core inside a 10% halo, coloured by the state token). The
 * dot REPLACES the tool glyph for a terminal state, exactly as the shipped
 * tool rows do — it is a status mark, not text furniture.
 */
export function McpStateDot({ state }: { state: 'error' | 'warning' }) {
  return <span className={styles.toolDot} data-state={state} aria-hidden="true" />
}

/** Leading slot of one tool row: state mark, chevron when open, else the plug. */
export function McpToolLeading({
  open,
  state,
  expandable,
}: {
  open: boolean
  state: McpToolRowState
  expandable: boolean
}) {
  if (open) return <McpChevronIcon />
  if (state === 'error') return <McpStateDot state="error" />
  if (state === 'stopped') return <McpStateDot state="warning" />
  return (
    <>
      <span className={styles.toolGlyphIdle}>
        <McpPlugIcon />
      </span>
      {expandable && (
        <span className={styles.toolGlyphHover}>
          <McpChevronIcon />
        </span>
      )}
    </>
  )
}
