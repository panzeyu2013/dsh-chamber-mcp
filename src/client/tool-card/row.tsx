/**
 * The MCP tool row: one transcript row per MCP call, owned by this plugin
 * through the keyed `tool.call.toolview` slot.
 *
 * Chrome follows the official tool rows rule for rule — a 24px row with a 16px
 * leading box (14px glyphs), a 6px gap, a 13px title in the secondary label
 * colour, a 14px ellipsizing summary, the same state classification, and the
 * same disclosure behaviour (click/keyboard toggle, hover chevron, chevron
 * while open). Terminal states yield the leading slot to the shipped status
 * dot (error red, interrupted amber), which is why the title carries no state
 * colour. Every colour comes from a `--dsw-*` alias token and every string from
 * the locale seat, so the row is indistinguishable from a shipped one in either
 * theme.
 *
 * The running and settled forms are deliberately NOT alike:
 *
 * - **running** — a sweep animation crosses the row (the shipped treatment), the
 *   title takes the primary label colour, `aria-busy` is set, and an expanded
 *   body says the call is still running;
 * - **settled ok** — no animation, secondary title, and a duration appears;
 * - **settled error** — the leading slot shows the error dot and the first line
 *   of the failure rides the summary in the error colour;
 * - **interrupted** — the leading slot shows the warning dot.
 *
 * @module
 */

import { useState, type KeyboardEvent } from 'react'
import type { SectionT } from '../section.js'
import { cx, styles } from '../styles.js'
import { McpToolLeading } from './icon.js'
import {
  argsRawOf,
  durationOf,
  isSettledBlock,
  resultTextOf,
  rowStateOf,
  summarizeArgs,
  type McpToolBlockLike,
  type McpToolIdentity,
} from './names.js'

/** Props the keyed toolview owner supplies, narrowed to what this row reads. */
export interface McpToolRowProps {
  /** Display identity captured when the view was registered for this name. */
  identity: McpToolIdentity
  /** Locale seat of the plugin namespace. */
  t: SectionT
  /** Running or settled call node. */
  block: McpToolBlockLike
}

/**
 * Render one MCP tool call. The component is pure in its props: registration
 * (which name maps to which identity) happens outside, and the row derives
 * every visible value from the frozen call node.
 */
export function McpToolRow({ identity, t, block }: McpToolRowProps) {
  const [open, setOpen] = useState(false)
  const state = rowStateOf(block)
  const settled = isSettledBlock(block)
  const argsRaw = argsRawOf(block)
  const output = settled ? resultTextOf(block) : ''
  const summary = summarizeArgs(argsRaw)
  const errorLine = state === 'error' && output !== '' ? (output.split('\n', 1)[0] ?? '') : ''
  const summaryText = errorLine !== '' ? errorLine : summary
  const duration = settled ? durationOf(block) : ''
  const expandable = argsRaw !== '' || output !== ''
  // Shipped `stateStatus`: the settled-ok row needs no state word (its summary
  // already describes it), the three active/terminal ones do.
  const statusWord =
    state === 'running' ? t('tool.running') : state === 'error' ? t('tool.failed') : state === 'stopped' ? t('tool.stopped') : ''
  const transportKey = identity.transport === 'streamable-http' ? 'transport.http' : 'transport.stdio'
  const transportLabel = identity.transport === undefined ? '' : t(transportKey)

  const toggle = () => {
    if (expandable) setOpen((current) => !current)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }

  return (
    <div className={styles.toolCard} data-state={state} data-tool={identity.publicName}>
      <div
        className={styles.toolHead}
        // A row with nothing to show is not a control: no role, no tab stop,
        // no handlers — only an expandable row is a button.
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-busy={state === 'running' ? true : undefined}
        title={identity.publicName}
        data-state={state}
        data-open={open || undefined}
        onClick={expandable ? toggle : undefined}
        onKeyDown={expandable ? onKeyDown : undefined}
      >
        {statusWord !== '' && <span className={styles.toolVisuallyHidden}>{statusWord}</span>}
        <span className={styles.toolLeading}>
          <McpToolLeading open={open} state={state} expandable={expandable} />
        </span>
        <span className={styles.toolTitle}>
          {identity.serverName} · {identity.toolName}
        </span>
        {summaryText !== '' && <span className={styles.toolSep} aria-hidden="true" />}
        <span className={cx(styles.toolSummary, errorLine !== '' && styles.toolSummaryError)}>{summaryText}</span>
        {transportLabel !== '' && <span className={styles.toolTag}>{transportLabel}</span>}
        {duration !== '' && <span className={styles.toolDuration}>{duration}</span>}
      </div>
      {open && expandable && (
        <div className={styles.toolBody}>
          {identity.normalized && <div className={styles.toolEmpty}>{t('tool.normalized')}</div>}
          {argsRaw !== '' && (
            <>
              <div className={styles.toolLabel}>{t('tool.input')}</div>
              <pre className={styles.toolCode}>{argsRaw}</pre>
            </>
          )}
          <div className={styles.toolLabel}>{t('tool.output')}</div>
          {output !== '' ? (
            <pre className={cx(styles.toolCode, styles.toolCodeOutput)} data-error={state === 'error' ? '' : undefined}>
              {output}
            </pre>
          ) : (
            <div className={styles.toolEmpty}>{state === 'running' ? t('tool.running') : t('tool.noOutput')}</div>
          )}
        </div>
      )}
    </div>
  )
}
