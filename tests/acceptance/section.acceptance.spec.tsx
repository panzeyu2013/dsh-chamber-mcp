// @vitest-environment jsdom
/**
 * INDEPENDENT acceptance suite of the settings section UI (contract C3),
 * covering C4 axes 1 CORRECTNESS, 2 COMPLETENESS and 3 OPTIMALITY.
 *
 * Every capability test is named after the user-visible capability it pins.
 * New contract copy is discovered from the shipped dictionaries (the frozen
 * zh sentences) so a missing key fails the test instead of passing vacuously.
 * Contract-first: expected to fail until C2/C3 land.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeCallError, type RuntimeSnapshot } from '../../src/client/runtime.ts'
import { styles } from '../../src/client/styles.ts'
import { en, zh, type SettingsKey } from '../../src/client/locales.ts'
import {
  accessibleName,
  buttonsOf,
  cardOf,
  checkboxCount,
  cleanupSections,
  dictOf,
  flush,
  keyByZh,
  mountSection,
  overridesOf,
  perCardRefreshButton,
  renderedWorkspaceTitles,
  stdioServer,
  templatePattern,
  viewOf,
  type Harness,
} from './harness.tsx'

afterEach(() => {
  cleanupSections()
})

const SERVER = 'alpha'
const WS_TITLES = Array.from({ length: 20 }, (_, index) => 'workspace-' + String(index + 1).padStart(2, '0'))
const WS_ITEMS = WS_TITLES.map((title) => ({ workspaceId: title, title }))
/** Workspaces whose row ENABLES the server: the only rows shown while collapsed. */
const ENABLED_TITLES = ['workspace-03', 'workspace-07', 'workspace-15']

function runtimeWith(names: readonly string[], phase: RuntimeSnapshot['phase'] = 'ready'): RuntimeSnapshot {
  const servers: Record<string, ReturnType<typeof viewOf>> = {}
  for (const name of names) servers[name] = viewOf(name)
  return { phase, servers }
}

/** Presence of a server name in a workspace row now means ENABLED there. */
function enabledOverrides(titles: readonly string[]): ReturnType<typeof overridesOf> {
  const rows: Record<string, string[]> = {}
  for (const title of titles) rows[title] = [SERVER]
  return overridesOf(rows)
}

/** The frozen-contract copy must exist; a missing key is a hard acceptance failure. */
function keyOf(pattern: RegExp, what: string): string {
  const key = keyByZh(pattern)
  if (key === undefined) throw new Error('frozen contract copy missing: ' + what)
  return key
}

function templateOf(key: string, locale: 'en' | 'zh' = 'en'): string {
  const text = dictOf(locale)[key]
  if (text === undefined) throw new Error('no text for key ' + key + ' in ' + locale)
  return text
}

/** Every en template whose zh mirror matches (plural pairs share one zh text). */


/** Smallest non-root element that both carries the text and owns a button. */
function smallestWithButton(root: HTMLElement, text: string): HTMLElement | undefined {
  const sectionRoot = root.querySelector('[data-dsh-chamber-mcp-section]')
  return Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter(
      (element) =>
        element !== sectionRoot &&
        (element.textContent ?? '').includes(text) &&
        element.querySelector('button') !== null,
    )
    .sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0]
}

/** Locale keys carrying the manage/hide workspace-rows toggle label of either state. */
function manageKeys(): string[] {
  return (Object.keys(en) as SettingsKey[]).filter(
    (key) =>
      /管理\s*workspace|收起\s*workspace/.test(zh[key] ?? '') ||
      /manage workspaces|hide workspaces/i.test(en[key] ?? ''),
  )
}

function manageToggleButton(mounted: Harness): HTMLButtonElement | undefined {
  const patterns = manageKeys().flatMap((key) =>
    (['en', 'zh'] as const).map((locale) => new RegExp(templatePattern(dictOf(locale)[key] ?? ''))),
  )
  if (patterns.length === 0) return undefined
  return buttonsOf(mounted.host).find((button) => {
    const name = accessibleName(button)
    return patterns.some((pattern) => pattern.test(name))
  })
}

function visibleCard(mounted: Harness, name = SERVER): HTMLElement {
  const card = cardOf(mounted.host, name)
  if (card === undefined) throw new Error('no card rendered for ' + name)
  return card
}

function requireButton(button: HTMLButtonElement | undefined, what: string): HTMLButtonElement {
  if (button === undefined) throw new Error('missing button: ' + what)
  return button
}

/** Visible prefix of the frozen stale-banner sentence (contract, not copy). */
function stalePrefix(): string {
  return templateOf(keyOf(/状态可能过期/, 'stale-banner sentence')).split('{')[0]!.trim()
}

/** The Retry button inside the section's stale banner. */
function staleRetryButton(mounted: Harness): HTMLButtonElement {
  const banner = smallestWithButton(mounted.host, stalePrefix())
  expect(banner, 'stale banner owning its retry action').toBeDefined()
  return requireButton(
    buttonsOf(banner!).find((button) => /retry|refresh|重试|刷新/i.test(accessibleName(button))),
    'retry action inside the stale banner',
  )
}

describe('C4 correctness: collapse invariants', () => {
  it('[correctness] collapse: the default renders only the ENABLED rows', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(ENABLED_TITLES) },
      wsItems: WS_ITEMS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const rendered = renderedWorkspaceTitles(mounted.host, WS_TITLES)
    expect(rendered.sort()).toEqual([...ENABLED_TITLES].sort())
    expect(rendered.length).toBeLessThan(WS_TITLES.length)
  })

  it('[correctness] collapse: zero enabled workspaces renders NO summary line', async () => {
    // A card whose server is off everywhere shows nothing where the enabled rows
    // would be: the OFF switches inside the list are the state, and the old
    // row.allOffDefault sentence is retired (no stand-in line, no count).
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      wsItems: WS_ITEMS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, WS_TITLES)).toEqual([])
    expect(mounted.host.querySelectorAll('.' + styles.hint)).toHaveLength(0)
  })

  it('[correctness] collapse: the manage-workspaces toggle reveals every workspace row and collapses again', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(ENABLED_TITLES) },
      wsItems: WS_ITEMS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const toggle = requireButton(manageToggleButton(mounted), 'manage-workspaces toggle')
    toggle.click()
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, WS_TITLES).length).toBe(WS_TITLES.length)
    const collapse = requireButton(manageToggleButton(mounted), 'manage-workspaces toggle (collapse)')
    collapse.click()
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, WS_TITLES).length).toBe(ENABLED_TITLES.length)
  })

  it('[correctness] collapse: toggling manage-workspaces performs no settings write', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(ENABLED_TITLES) },
      wsItems: WS_ITEMS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    requireButton(manageToggleButton(mounted), 'manage-workspaces toggle').click()
    await flush()
    requireButton(manageToggleButton(mounted), 'manage-workspaces toggle (collapse)').click()
    await flush()
    expect(mounted.calls.writes).toEqual([])
  })
})

describe('C4 completeness: one test per user-visible capability', () => {
  it('[completeness] capability: per-card status refresh is present for EVERY server card', async () => {
    const names = ['alpha', 'beta', 'gamma']
    const mounted = mountSection({
      doc: { servers: names.map((name) => stdioServer(name)), overrides: {} },
      runtime: runtimeWith(names),
    })
    await flush()
    for (const name of names) {
      const card = visibleCard(mounted, name)
      expect(perCardRefreshButton(card, dictOf('en')), name).toBeDefined()
    }
  })

  it('[completeness] capability: a per-card refresh hits only its own server', async () => {
    const names = ['alpha', 'beta']
    const mounted = mountSection({
      doc: { servers: names.map((name) => stdioServer(name)), overrides: {} },
      runtime: runtimeWith(names),
    })
    await flush()
    const before = mounted.calls.refresh.length
    requireButton(perCardRefreshButton(visibleCard(mounted, 'beta'), dictOf('en')), 'card beta refresh').click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]?.server).toBe('beta')
    expect(mounted.calls.connect).toEqual([])
    expect(mounted.calls.disconnect).toEqual([])
    expect(mounted.calls.test).toEqual([])
    expect(mounted.calls.writes).toEqual([])
  })

  it('[completeness] capability: a failed card offers reconnect', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'ready', servers: { [SERVER]: viewOf(SERVER, 'failed') } },
    })
    await flush()
    const card = visibleCard(mounted)
    const reconnect = buttonsOf(card).find((button) => accessibleName(button).includes(en['action.connect']))
    requireButton(reconnect, 'reconnect action on a failed card').click()
    await flush()
    expect(mounted.calls.connect).toEqual([SERVER])
  })

  it('[completeness] capability: the header carries only Add/Cancel; refresh is per card and from the stale banner', async () => {
    const names = ['alpha', 'beta']
    const mounted = mountSection({
      doc: { servers: names.map((name) => stdioServer(name)), overrides: {} },
      runtime: { ...runtimeWith(names), phase: 'error', error: 'boom' },
    })
    await flush()
    const header = mounted.host.querySelector('header')
    expect(header).not.toBeNull()
    // Contract: the section header offers no global refresh control any more;
    // its only action is the staged-form Add/Cancel capsule.
    const headerLabels = buttonsOf(header!).map((button) => accessibleName(button))
    expect(headerLabels.some((label) => label.includes(en['runtime.refresh']))).toBe(false)
    expect(headerLabels).toHaveLength(1)
    expect(headerLabels[0]).toContain(en['add.add'])
    // The refresh affordances that remain: one per card ...
    for (const name of names) {
      expect(perCardRefreshButton(visibleCard(mounted, name), dictOf('en')), name).toBeDefined()
    }
    // ... plus the stale banner's Retry, which re-runs the FULL refresh.
    const before = mounted.calls.refresh.length
    staleRetryButton(mounted).click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]?.server).toBeUndefined()
  })

  it('[completeness] capability: the stale banner appears when the phase is error and data exists', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'error', servers: { [SERVER]: viewOf(SERVER) }, error: 'boom' },
    })
    await flush()
    expect(mounted.text()).toContain(stalePrefix())
    const before = mounted.calls.refresh.length
    staleRetryButton(mounted).click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]?.server).toBeUndefined()
  })

  it('[completeness] capability: the stale banner appears when the phase is unavailable and data exists', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'unavailable', servers: { [SERVER]: viewOf(SERVER) }, error: 'offline' },
    })
    await flush()
    expect(mounted.text()).toContain(stalePrefix())
  })

  it('[completeness] capability: without runtime data the stale banner stays away and the degraded message remains', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'error', servers: {}, error: 'boom' },
    })
    await flush()
    expect(mounted.text()).not.toContain(stalePrefix())
    expect(mounted.text()).toContain(en['runtime.error'])
  })

  it('[completeness] capability: connect still works', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'ready', servers: { [SERVER]: viewOf(SERVER, 'failed') } },
    })
    await flush()
    requireButton(
      buttonsOf(visibleCard(mounted)).find((button) => accessibleName(button).includes(en['action.connect'])),
      'connect action',
    ).click()
    await flush()
    expect(mounted.calls.connect).toEqual([SERVER])
  })

  it('[completeness] capability: disconnect still works', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'ready', servers: { [SERVER]: viewOf(SERVER, 'connected') } },
    })
    await flush()
    requireButton(
      buttonsOf(visibleCard(mounted)).find((button) => accessibleName(button).includes(en['action.disconnect'])),
      'disconnect action',
    ).click()
    await flush()
    expect(mounted.calls.disconnect).toEqual([SERVER])
  })

  it('[completeness] capability: test connection still works', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'ready', servers: { [SERVER]: viewOf(SERVER, 'connected') } },
    })
    await flush()
    requireButton(
      buttonsOf(visibleCard(mounted)).find((button) => accessibleName(button).includes(en['action.test'])),
      'test action',
    ).click()
    await flush()
    expect(mounted.calls.test).toEqual([SERVER])
  })

  it('[completeness] capability: only enabled rows render by default (enabled-only default)', async () => {
    const titles = ['workspace-01', 'workspace-02', 'workspace-03']
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(['workspace-02']) },
      wsItems: titles.map((title) => ({ workspaceId: title, title })),
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, titles)).toEqual(['workspace-02'])
  })

  it('[completeness] capability: the manage-workspaces toggle reveals all rows and offers all-on/all-off', async () => {
    const titles = ['workspace-01', 'workspace-02']
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(['workspace-02']) },
      wsItems: titles.map((title) => ({ workspaceId: title, title })),
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    requireButton(manageToggleButton(mounted), 'manage-workspaces toggle').click()
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, titles)).toEqual(titles)
    const card = visibleCard(mounted)
    expect(buttonsOf(card).some((button) => (button.textContent ?? '').includes(en['row.allOn']))).toBe(true)
    expect(buttonsOf(card).some((button) => (button.textContent ?? '').includes(en['row.allOff']))).toBe(true)
  })

  it('[completeness] capability: a failed per-card refresh shows a localized inline error with the diagnostic in title', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: runtimeWith([SERVER]),
      actions: {
        // Only the per-card read fails: the section's own silent mount/poll
        // refresh is a full refresh, which by contract never rejects.
        refreshRuntime: async (options) => {
          if (options?.server !== undefined) throw new RuntimeCallError('unavailable', 'boom-detail')
        },
      },
    })
    await flush()
    requireButton(perCardRefreshButton(visibleCard(mounted), dictOf('en')), 'card refresh').click()
    await flush()
    const lines = Array.from(visibleCard(mounted).querySelectorAll<HTMLElement>('.' + styles.statusErrorText))
    expect(lines.length).toBeGreaterThan(0)
    const line = lines.find((element) => (element.getAttribute('title') ?? '').includes('boom-detail'))
    expect(line, 'inline refresh error carrying the RuntimeCallError message in its title').toBeDefined()
    const text = (line!.textContent ?? '').trim()
    expect(text).not.toContain('boom-detail')
    expect(text.length).toBeGreaterThan(0)
    const localized = Object.values(en).some((value) => value === text)
    expect(localized || /error|failed|失败/i.test(text), 'localized general text: ' + text).toBe(true)
  })

  it('[completeness] capability: a busy per-card refresh is disabled until it settles', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: runtimeWith([SERVER]),
      actions: { refreshRuntime: () => pending },
    })
    await flush()
    requireButton(perCardRefreshButton(visibleCard(mounted), dictOf('en')), 'card refresh').click()
    await flush()
    expect(requireButton(perCardRefreshButton(visibleCard(mounted), dictOf('en')), 'card refresh while busy').disabled).toBe(
      true,
    )
    release()
    await flush()
    expect(requireButton(perCardRefreshButton(visibleCard(mounted), dictOf('en')), 'card refresh after settle').disabled).toBe(
      false,
    )
  })

  it('[correctness] copy: the whole new UI asks for no key missing from en or zh', async () => {
    const missing: Record<'en' | 'zh', string[]> = { en: [], zh: [] }
    for (const locale of ['en', 'zh'] as const) {
      const titles = ['workspace-01', 'workspace-02']
      const mounted = mountSection({
        doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(['workspace-02']) },
        wsItems: titles.map((title) => ({ workspaceId: title, title })),
        runtime: { phase: 'error', servers: { [SERVER]: viewOf(SERVER) }, error: 'boom' },
        locale,
        missingKeys: missing[locale],
      })
      await flush()
      requireButton(manageToggleButton(mounted), 'manage-workspaces toggle in ' + locale).click()
      await flush()
      requireButton(
        perCardRefreshButton(visibleCard(mounted), dictOf(locale)),
        'per-card refresh in ' + locale,
      ).click()
      await flush()
    }
    expect(missing.en).toEqual([])
    expect(missing.zh).toEqual([])
  })
})

describe('C4 optimality: request counts, timers and node counts', () => {
  it('[optimality] a per-card refresh issues exactly one store call and never refetches the table', async () => {
    const names = ['alpha', 'beta']
    const mounted = mountSection({
      doc: { servers: names.map((name) => stdioServer(name)), overrides: {} },
      runtime: runtimeWith(names),
    })
    await flush()
    const before = mounted.calls.refresh.length
    requireButton(perCardRefreshButton(visibleCard(mounted, 'alpha'), dictOf('en')), 'card alpha refresh').click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]?.server).toBe('alpha')
    expect(added.some((call) => call.server === undefined)).toBe(false)
  })

  it('[optimality] the stale-banner Retry issues exactly one full-refresh store call', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: { phase: 'error', servers: { [SERVER]: viewOf(SERVER) }, error: 'boom' },
    })
    await flush()
    // The mount pass is the only full refresh so far; the manual one is the banner.
    expect(mounted.calls.refresh.filter((call) => call.server === undefined)).toHaveLength(1)
    const before = mounted.calls.refresh.length
    staleRetryButton(mounted).click()
    await flush()
    const added = mounted.calls.refresh.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]?.server).toBeUndefined()
    expect(added.some((call) => call.server !== undefined)).toBe(false)
  })

  it('[optimality] an ordinary re-render issues no extra store call', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: {} },
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    const afterMount = mounted.calls.refresh.length
    expect(afterMount).toBe(1)
    mounted.rerender()
    await flush()
    expect(mounted.calls.refresh).toHaveLength(afterMount)
  })

  it('[optimality] unmounting the section leaves no interval behind', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const baseline = vi.getTimerCount()
      const mounted = mountSection({
        doc: { servers: [stdioServer(SERVER)], overrides: {} },
        runtime: runtimeWith([SERVER]),
      })
      await flush()
      expect(vi.getTimerCount()).toBe(baseline + 1)
      const before = mounted.calls.refresh.length
      vi.advanceTimersByTime(5000)
      expect(mounted.calls.refresh.length).toBeGreaterThan(before)
      mounted.unmount()
      await flush()
      expect(vi.getTimerCount()).toBe(baseline)
    } finally {
      vi.useRealTimers()
    }
  })

  it('[optimality] the collapse default renders O(ENABLED) workspace rows, not O(all workspaces)', async () => {
    const mounted = mountSection({
      doc: { servers: [stdioServer(SERVER)], overrides: enabledOverrides(ENABLED_TITLES) },
      wsItems: WS_ITEMS,
      runtime: runtimeWith([SERVER]),
    })
    await flush()
    expect(renderedWorkspaceTitles(mounted.host, WS_TITLES).length).toBe(ENABLED_TITLES.length)
    expect(checkboxCount(visibleCard(mounted))).toBe(ENABLED_TITLES.length + 1)
    requireButton(manageToggleButton(mounted), 'manage-workspaces toggle').click()
    await flush()
    expect(checkboxCount(visibleCard(mounted))).toBe(WS_TITLES.length + 1)
  })
})