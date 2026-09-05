/**
 * Local, minimal workspace-list surface for the section.
 *
 * The runtime's `useWorkspaces` standard hook delivers `WorkspaceListState`
 * (runtime/client). Its `items` members are typed through cross-package
 * re-exports (`WorkspaceView` from dsh-api-remotes/client) that resolve to
 * `any` in this dev tree (see docs/ui-notes.md), so the section narrows them
 * to the fields it actually reads through a single targeted cast. The list
 * lifecycle (state/phase) is real and drives the loading/error/empty gating
 * of the per-card workspace rows (UX-18).
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

/** What the per-card workspace-row area may show right now. */
export type WorkspaceListStatus = 'ready' | 'loading' | 'error'

/**
 * Derive the row-area status from the real list lifecycle: `state: 'error'`
 * is a failed list, `loading` (or `idle` while the baseline has not reached
 * `phase: 'ready'`) is still arriving, everything else is settled. Cards may
 * show "no workspaces" only from a settled list (never during load/error).
 */
export function workspaceListStatusOf(state: WorkspaceListState): WorkspaceListStatus {
  if (state.state === 'error') return 'error'
  if (state.state === 'loading' || state.phase !== 'ready') return 'loading'
  return 'ready'
}

/** Narrow the hook's items to the row fields actually rendered. */
export function workspaceItemsOf(state: WorkspaceListState): readonly WorkspaceItem[] {
  // WorkspaceListState is fully typed here; only the item element type rides
  // an unresolved re-export chain and collapses to `any` in this tree.
  return state.items as unknown as readonly WorkspaceItem[]
}
