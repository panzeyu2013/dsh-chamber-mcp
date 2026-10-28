// @vitest-environment jsdom
/**
 * A settings update must DIFF IN PLACE. The reported symptom ("enabling a
 * server flashes the whole panel") can only come from a re-render that throws
 * the subtree away and rebuilds it, so this pins the property that rules our
 * section out: one settings commit may touch text and attributes, but it must
 * add and remove NO node.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { styles } from '../../src/client/styles.ts'
import {
  cleanupSections,
  flush,
  mountSection,
  overridesOf,
  stdioServer,
  t,
} from '../support/section-harness.tsx'

afterEach(() => {
  cleanupSections()
})

const WS = [
  { workspaceId: 'ws-1', title: 'tmp', path: '/tmp' },
  { workspaceId: 'ws-2', title: 'daily', path: '/daily' },
  { workspaceId: 'ws-3', title: 'quant', path: '/quant' },
  { workspaceId: 'ws-4', title: 'perf', path: '/perf' },
  { workspaceId: 'ws-5', title: 'literature', path: '/lit' },
]

describe('section repaint discipline', () => {
  it('diffs a settings commit in place: no node is added or removed', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer('alpha'), stdioServer('beta')], overrides: {} },
      wsItems: WS,
      runtime: { phase: 'ready', servers: {} },
    })
    await flush(20)
    // Open the server detail so the largest subtree (workspace switches) is on
    // screen; the commit then changes one switch and nothing else.
    mounted.host.querySelector<HTMLElement>('[data-server="alpha"] button')!.click()
    await flush(20)
    const switches = mounted.host.querySelectorAll('.' + styles.scopeRow).length
    expect(switches).toBe(5)
    const counts = { added: 0, removed: 0 }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        counts.added += record.addedNodes.length
        counts.removed += record.removedNodes.length
      }
    })
    observer.observe(mounted.host, { childList: true, subtree: true, attributes: true, characterData: true })
    // ONE settings commit: a workspace enable plus a revision bump.
    mounted.commitDoc({
      ...mounted.live.doc,
      overrides: overridesOf({ 'ws-1': ['alpha'] }),
    })
    await flush(20)
    observer.disconnect()
    expect(counts).toEqual({ added: 0, removed: 0 })
    expect(
      mounted.host.querySelector<HTMLInputElement>(
        'input[aria-label="' + t('server.workspacesTitle') + ': tmp"]',
      )!.checked,
    ).toBe(true)
  })
})
