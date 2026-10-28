/**
 * Serial document-write queue for the settings surface.
 *
 * The controller judges every save against the snapshot it read, so two
 * overlapping settings writes can report a spurious conflict. The old card
 * kept a per-card chain; the list/detail/workspace views can now originate
 * writes from several surfaces, so the section owns ONE chain for every
 * user-triggered document mutation.
 *
 * The hook is deliberately tiny and React-only (no @deepseek-ai runtime
 * import), keeping the client bundle purity invariant intact.
 */

import { useCallback, useRef, useState } from 'react'

export interface WriteQueue {
  /** Run one write after every previously queued write settled. */
  run<T>(task: () => Promise<T>): Promise<T>
  /** Number of writes currently queued or running. */
  pending: number
}

export function useWriteQueue(): WriteQueue {
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const [pending, setPending] = useState(0)

  const run = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    setPending((value) => value + 1)
    const next = chain.current.then(task, task)
    chain.current = next.then(
      () => undefined,
      () => undefined,
    )
    return next.finally(() => {
      setPending((value) => Math.max(0, value - 1))
    })
  }, [])

  return { run, pending }
}
