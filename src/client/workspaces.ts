/**
 * Local, minimal workspace-list surface for the section.
 *
 * The runtime's `useWorkspaces` standard hook delivers `WorkspaceListState`
 * (runtime/client). Its `items` members are typed through cross-package
 * re-exports (`WorkspaceView` from dsh-api-remotes/client) that resolve to
 * `any` in this dev tree (see docs/ui-notes.md), so the section narrows them
 * to the fields it actually reads through a single targeted cast.
 */

import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'

/** Fields of one workspace row this UI consumes. */
export interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/** Selector-hook shape over the workspace list state. */
export type WorkspaceListHook = <T>(selector: (state: WorkspaceListState) => T) => T

/** Narrow the hook's items to the row fields actually rendered. */
export function workspaceItemsOf(state: WorkspaceListState): readonly WorkspaceItem[] {
  // WorkspaceListState is fully typed here; only the item element type rides
  // an unresolved re-export chain and collapses to `any` in this tree.
  return state.items as unknown as readonly WorkspaceItem[]
}
