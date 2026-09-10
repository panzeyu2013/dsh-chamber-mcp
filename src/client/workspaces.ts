/**
 * Local, minimal workspace-list surface for the section.
 *
 * The framework's global `useWorkspaces` standard hook delivers a
 * `WorkspaceSnapshot` (0.1.5: `@deepseek-ai/dsh-api-workspace-controller/client`,
 * which also declares the `ctx.workspaces` service this plugin injects; the
 * 0.1.2-era `dsh-client-runtime` is off the upstream release train and is no
 * longer a dependency). The section narrows each row to the fields it actually
 * renders through {@link WorkspaceItem}, which `WorkspaceView` structurally
 * satisfies — no cast is needed. The list lifecycle (state/phase) is real and
 * drives the loading/error/empty gating of the per-card workspace rows (UX-18).
 */

import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Fields of one workspace row this UI consumes (a subset of `WorkspaceView`). */
export interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/** Selector-hook shape over the workspace list state. */
export type WorkspaceListHook = <T>(selector: (state: WorkspaceSnapshot) => T) => T

/** What the per-card workspace-row area may show right now. */
export type WorkspaceListStatus = 'ready' | 'loading' | 'error'

/**
 * Derive the row-area status from the real list lifecycle: `state: 'error'`
 * is a failed list, `loading` (or `idle` while the baseline has not reached
 * `phase: 'ready'`) is still arriving, everything else is settled. Cards may
 * show "no workspaces" only from a settled list (never during load/error).
 */
export function workspaceListStatusOf(state: WorkspaceSnapshot): WorkspaceListStatus {
  if (state.state === 'error') return 'error'
  if (state.state === 'loading' || state.phase !== 'ready') return 'loading'
  return 'ready'
}

/**
 * Narrow the hook's items to the row fields actually rendered. `WorkspaceView`
 * carries branded `workspaceId`/`sessionIds` plus timestamps this UI does not
 * read; both brands are string-based, so the narrower row type accepts it
 * directly.
 */
export function workspaceItemsOf(state: WorkspaceSnapshot): readonly WorkspaceItem[] {
  return state.items
}
