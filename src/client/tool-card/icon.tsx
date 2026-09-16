/**
 * Icons of the MCP tool row.
 *
 * The plug mark is drawn here rather than taken from the icon set: dsh ships
 * no MCP glyph, and the official MCP mark is a brand asset whose fine stroke
 * muddies at 14px. It is a harness-only stroke glyph on a private 24-unit
 * canvas, rendered at 14px with its visual weight tuned to sit beside the
 * shipped set, whose marks are mostly 14- and 16-unit filled paths (a few
 * 20/28-unit or stroked outlines); it inherits `currentColor`, which is what
 * lets the row tint it per state (running / settled) from the design tokens
 * alone.
 *
 * The terminal state mark mirrors the shipped `StateDot`: a terminal state
 * yields the icon slot to a status dot (the tool row's own convention —
 * error = red, interrupted = amber, both as a solid 6px core inside a 10px
 * halo at 10% opacity). The chevron is the shipped
 * `IconChevronDownOutline14` geometry inlined, so an expandable non-terminal
 * row swaps its glyph for the chevron on hover, or for good once open.
 *
 * All three glyphs are inline: the row then owns no icon-package edge at all,
 * so its unit render runs without the primitives package's own runtime
 * dependencies, and the shipped bundle stays as thin as the rest of the plugin.
 *
 * @module
 */

import { styles } from '../styles.js'
import type { McpToolRowState } from './names.js'

/**
 * Official `IconChevronDownOutline14` path data, byte-for-byte from
 * `@deepseek-ai/dsh-client-ui-primitives`: the chevron the shipped rows swap
 * in, a filled path on a 14-unit canvas.
 */
const CHEVRON_PATH_14 = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

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
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={CHEVRON_PATH_14} fill="currentColor" />
    </svg>
  )
}

/**
 * Terminal-state mark of one row: the shipped `StateDot` in its two solid
 * outcomes (a solid 6px core inside a 10px halo at 10% opacity, coloured by
 * the state token). The dot REPLACES the tool glyph for a terminal state,
 * exactly as the shipped tool rows do — it is a status mark, not text
 * furniture.
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
