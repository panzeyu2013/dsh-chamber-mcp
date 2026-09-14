/**
 * Registrable view factory of the MCP tool row.
 *
 * The keyed `tool.call.toolview` seat supplies the call node (and the locale
 * seat declared at registration), not the tool identity — the identity is what
 * the key stands for, so it is captured here when the view is registered for
 * one exact wire name.
 *
 * @module
 */

import type { SectionT } from '../section.js'
import { McpToolRow } from './row.js'
import type { McpToolBlockLike, McpToolIdentity } from './names.js'

/** Props the toolview seat hands one row: the call node + the locale seat. */
export interface McpToolSeatProps {
  /** Locale seat of the plugin's dictionary namespace. */
  t: SectionT
  /** Running or settled call node, structurally narrowed by the row. */
  block: McpToolBlockLike
}

/**
 * Build the component to register for one tool name.
 *
 * @param identity - display identity captured for this registration.
 * @returns the slot component.
 */
export function mcpToolView(identity: McpToolIdentity) {
  return function McpToolView(props: McpToolSeatProps) {
    return <McpToolRow identity={identity} t={props.t} block={props.block} />
  }
}
