// @vitest-environment jsdom
// Style seat evidence: the mcp-scope surface is styled through the dsh design
// system, not through literals. This suite applies the same conformance rules
// the dsh-chamber tree enforces over its own packages
// (`dsh-chamber/scripts/dev/verify-style-tokens.mjs`, S1–S7) to the ONE
// stylesheet this plugin ships, plus the two structural facts a stylesheet
// cannot check about itself: that the class map and the CSS cover each other,
// and that the injected tag is created once and disposed correctly.
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_DRAFT } from '../../src/client/draft.ts'
import { ServerListView } from '../../src/client/views/server-list.tsx'
import { ServerEditor } from '../../src/client/views/server-editor.tsx'
import {
  STYLE_PLUGIN,
  STYLE_TAG_ID,
  css,
  cx,
  mountStyles,
  styles,
} from '../../src/client/styles.ts'
import type { SectionT } from '../../src/client/section.tsx'
import { t as fixtureT } from '../support/section-fixtures.ts'
import type { McpScopeDoc } from '../../src/shared/model.ts'
import type { RuntimeSnapshot } from '../../src/client/runtime.ts'

/** Locale reader of the section namespace (en dictionary, `{name}` interpolation). */
const t = fixtureT as unknown as SectionT

/** Exact class tokens in a static markup string (substring matches hide missing roots). */
const classesOf = (markup: string): Set<string> =>
  new Set(
    Array.from(markup.matchAll(/class="([^"]*)"/g)).flatMap((match) =>
      (match[1] ?? '').split(/\s+/).filter(Boolean),
    ),
  )

afterEach(() => {
  for (const tag of Array.from(document.querySelectorAll('style[data-plugin-css]'))) tag.remove()
})

/**
 * Every `--dsw-*` / `--dsh-*` / `--ds-*` name this stylesheet is allowed to
 * reference: the token sheet of the pinned dsh generation
 * (`packages/client/ui-theme/src/styles/design-platform.css` and `base.css`).
 * A name that is not declared there resolves to nothing — the declaration is
 * dropped and the surface silently renders unthemed (upstream itself reads
 * `--dsw-alias-label-error`, which nothing declares; this sheet must not).
 *
 * The accent entries the blue interactive states use
 * (`--dsw-alias-state-business-primary`, `--dsw-alias-button-info-fill/-hover`)
 * and `--dsw-elevation-stroke` were verified against the chamber's vendored
 * theme bundle (`@deepseek-ai/dsh-client-ui-theme/lib/client.js`, which
 * declares them over the `--dsw-static-deepseek-*` primitives) and against the
 * pinned `ui-primitives` sheets, which already read them.
 */
const THEME_TOKENS = new Set([
  '--dsh-content-font-delta',
  '--dsh-content-font-size-secondary',
  '--ds-ease-in-out',
  '--ds-font-family-code',
  '--ds-transition-duration',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  // The expanded notice body is the shipped code-block scrollport; the theme
  // bundle declares this fill (verified like the accent entries above).
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  // The panel card's hairline is drawn by this elevation shorthand (declared by
  // the theme as `0 0 0 .5px var(--dsw-elevation-stroke-color)`, and already
  // read by the pinned ui-primitives sheets) — not by a `border`.
  '--dsw-elevation-panel',
  '--dsw-elevation-stroke',
])

/** Innermost `selector { body }` pairs — the same lexical rule the chamber gate uses. */
function rules(sheet: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  for (const match of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (selector === '') continue
    out.push({ selector, body: match[2] ?? '' })
  }
  return out
}

const cssClassesOf = (sheet: string): Set<string> =>
  new Set(Array.from(sheet.matchAll(/\.(mcpScope_[A-Za-z0-9_]+)/g), (match) => match[1]!))

describe('mcp-scope stylesheet', () => {
  it('references only tokens the pinned dsh theme declares (S1) and declares none of its own (S2/S6)', () => {
    const refs = Array.from(css.matchAll(/var\(\s*(--[a-z0-9-]+)/g), (match) => match[1]!)
    expect(refs.length).toBeGreaterThan(0)
    const unknown = refs.filter((token) => !THEME_TOKENS.has(token))
    expect(unknown, `unknown token reference(s): ${unknown.join(', ')}`).toEqual([])
    // Namespace discipline: this sheet must not invent a `--dsw-*` name (nor
    // declare any custom property at all — a declaration nothing reads is a
    // knob the next author would trust).
    expect(css).not.toMatch(/(?:^|[{;])\s*--[a-z0-9-]+\s*:/m)
  })

  it('carries no literal colour and no colour fallback on a token (S4)', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/i)
    // `var(--dsw-alias-…, <fallback>)`: a fallback would defeat the token.
    expect(css).not.toMatch(/var\(\s*--dsw-alias-[a-z0-9-]+\s*,/)
  })

  it('draws every neutral border as a 0.5px hairline and no 1px filled divider (S3)', () => {
    for (const rule of rules(css)) {
      for (const match of rule.body.matchAll(
        /border(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)px\s+solid\s+var\(\s*(--dsw-alias-[a-z0-9-]+)/g,
      )) {
        const width = Number(match[1])
        const token = match[2]!
        if (token.startsWith('--dsw-alias-state-')) {
          expect(width, `${rule.selector}: state borders stay 1px`).toBe(1)
          continue
        }
        expect(width, `${rule.selector}: neutral border on ${token} must be 0.5px`).toBe(0.5)
      }
      if (/background(?:-color)?\s*:\s*var\(--dsw-alias-border-/.test(rule.body)) {
        expect(rule.body, `${rule.selector}: hairline painted as a filled box`).not.toMatch(
          /(?:^|;)\s*(?:height|width)\s*:\s*1px\s*(?:;|$)/,
        )
      }
    }
  })

  it('pairs every full-round radius with corner-shape: round (S7)', () => {
    for (const rule of rules(css)) {
      const radii = Array.from(rule.body.matchAll(/border-radius\s*:\s*([^;]+)/g), (match) => match[1]!.trim())
      const fullRound = radii.some((value) =>
        value.split(/\s+/).some((part) =>
          part === '50%' || part === '100%' || (part.endsWith('px') && Number.parseFloat(part) >= 99),
        ),
      )
      if (fullRound) {
        expect(rule.body, `${rule.selector} is full-round without corner-shape: round`).toMatch(
          /corner-shape\s*:\s*round/,
        )
      }
    }
  })

  it('keeps every card action on one capsule and marks the destructive one by its label', () => {
    const capsule = rules(css).find((rule) => rule.selector === '.mcpScope_button')
    expect(capsule, 'no rule for .mcpScope_button').toBeDefined()
    // One shared recipe for Edit / Remove / Disconnect / Test (and the Tools
    // disclosure): the official Button `.sm` outline capsule.
    for (const declaration of [
      /height:\s*28px/,
      /border-radius:\s*14px/,
      /padding:\s*0 10px/,
      /font-size:\s*12px/,
      /background:\s*transparent/,
    ]) {
      expect(capsule!.body, `capsule lost ${declaration}`).toMatch(declaration)
    }
    // ONE frame for all four: the neutral 0.5px hairline. Nothing gives the
    // destructive variant a border of its own — its colour rides the LABEL, so
    // the control group keeps a single border weight.
    expect(rules(css).find((rule) => rule.selector === '.mcpScope_buttonOutline')!.body).toContain(
      'border: 0.5px solid var(--dsw-alias-border-l3)',
    )
    const dangerRules = rules(css).filter((rule) => rule.selector.includes('buttonDanger'))
    expect(dangerRules.length).toBeGreaterThan(0)
    for (const rule of dangerRules) {
      expect(rule.body, `${rule.selector} must not paint a frame`).not.toMatch(/border(?!-radius)/)
    }
    // The plain danger treatment (confirm CTA, form discard) keeps its red label.
    expect(rules(css).find((rule) => rule.selector === '.mcpScope_buttonDanger')!.body).toContain(
      'color: var(--dsw-alias-state-error-primary)',
    )
  })

  it('lets the section gap own the vertical rhythm: every paragraph resets its margin', () => {
    // The detail/list/editor surfaces are flex columns whose gap owns the
    // rhythm; a paragraph that keeps the UA margin doubles the space around its
    // own line. Every paragraph class those views render resets it.
    for (const selector of [
      '.mcpScope_detailSectionHint',
      '.mcpScope_hint',
      '.mcpScope_empty',
      '.mcpScope_emptyBody',
      '.mcpScope_editorNote',
      '.mcpScope_availabilityHint',
      '.mcpScope_dangerHint',
      '.mcpScope_toolTruncate',
    ]) {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      expect(rule, `no rule for ${selector}`).toBeDefined()
      expect(rule!.body, `${selector} keeps a UA margin inside the flex column`).toMatch(
        /(?:^|[;{\s])margin:\s*0\s*;/,
      )
    }
  })

  it('paints the row surface recipe: r12 + elevation stroke, no border', () => {
    const row = rules(css).find((rule) => rule.selector === '.mcpScope_serverRow')
    expect(row, 'no rule for .mcpScope_serverRow').toBeDefined()
    expect(row!.body).toMatch(/border-radius:\s*12px/)
    expect(row!.body).toMatch(/box-shadow:\s*var\(--dsw-elevation-stroke\)/)
    // The hairline is the elevation stroke now — a border would double it.
    expect(row!.body).not.toMatch(/border\s*:/)
  })

  it('spends the deepseek accent only on interactive and selected states', () => {
    const bodyOf = (selector: string): string => {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      if (rule === undefined) throw new Error(`no rule for ${selector}`)
      return rule.body
    }
    const accent = 'var(--dsw-alias-state-business-primary)'
    // selected + focused controls (the accent states)
    expect(bodyOf('.mcpScope_switchInput:checked + .mcpScope_switch')).toContain(`background: ${accent}`)
    expect(bodyOf('.mcpScope_switchInput:focus-visible + .mcpScope_switch')).toContain(accent)
    // primary control fill
    expect(bodyOf('.mcpScope_buttonPrimary')).toContain('var(--dsw-alias-button-info-fill)')
    expect(bodyOf('.mcpScope_buttonPrimary:hover:not(:disabled)')).toContain('var(--dsw-alias-button-info-hover)')
    // normal state (scope labels, notice strip, row surface) stays monochrome
    expect(bodyOf('.mcpScope_scopeName')).toContain('var(--dsw-alias-label-primary)')
    expect(bodyOf('.mcpScope_inlineNoticeInfo')).not.toContain(accent)
    expect(bodyOf('.mcpScope_serverRow')).not.toContain('state-business-primary')
    expect(bodyOf('.mcpScope_serverRow')).not.toContain('button-info')
    // and no rule outside the interactive set paints it
    const accentRules = rules(css)
      .filter((rule) => /--dsw-alias-(?:state-business-primary|button-info-(?:fill|hover))/.test(rule.body))
      .map((rule) => rule.selector)
      .sort()
    expect(accentRules).toEqual(
      [
        '.mcpScope_button:focus-visible',
        '.mcpScope_buttonPrimary',
        '.mcpScope_buttonPrimary:hover:not(:disabled)',
        '.mcpScope_choiceInput:focus-visible + .mcpScope_choicePill',
        '.mcpScope_detailBack:focus-visible',
        '.mcpScope_editorAdvanced:focus-visible',
        '.mcpScope_editorErrorLink:focus-visible',
        '.mcpScope_filterChip:focus-visible',
        '.mcpScope_iconButton:focus-visible',
        // the registered-tools notice is a shipped-chrome disclosure row: only
        // its keyboard focus rings (the row's and each source's) spend the
        // accent, like every other control
        '.mcpScope_injectionHead:focus-visible',
        '.mcpScope_injectionServerHead:focus-visible',
        '.mcpScope_input:focus',
        '.mcpScope_revealButton:focus-visible',
        '.mcpScope_searchInput:focus',
        '.mcpScope_serverRowButton:focus-visible',
        '.mcpScope_switchInput:checked + .mcpScope_switch',
        '.mcpScope_switchInput:focus-visible + .mcpScope_switch',
        '.mcpScope_tab:focus-visible',
        '.mcpScope_textarea:focus',
        '.mcpScope_toolDisclosure:focus-visible',
        '.mcpScope_toolHead:focus-visible',
      ].sort(),
    )
  })

  it('is balanced CSS and exports exactly the classes it styles', () => {
    expect(css.match(/\{/g)?.length).toBe(css.match(/\}/g)?.length)
    const exported = new Set<string>(Object.values(styles))
    const styled = cssClassesOf(css)
    expect([...styled].filter((name) => !exported.has(name))).toEqual([]) // no dead rule
    expect([...exported].filter((name) => !styled.has(name))).toEqual([]) // no unstyled class
    expect(cx(styles.serverRow, false, undefined, styles.button)).toBe(`${styles.serverRow} ${styles.button}`)
    expect(cx()).toBe('')
  })

  it('scales the notice chrome with the shipped content-font variables', () => {
    // The shipped disclosure rows size themselves as
    // `calc(<px> + var(--dsh-content-font-delta, 0px))` and defer their label to
    // `--dsh-content-font-size-secondary`; a hardcoded px row stops lining up
    // with the adjacent cards as soon as the content font changes.
    const ruleOf = (selector: string): string => {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      if (rule === undefined) throw new Error(`no rule for ${selector}`)
      return rule.body
    }
    const has = (selector: string, fragment: string): void => {
      expect(ruleOf(selector), selector + ' must declare ' + fragment).toContain(fragment)
    }
    has('.mcpScope_injectionHead', 'height: calc(24px + var(--dsh-content-font-delta, 0px))')
    has('.mcpScope_injectionLeading', 'width: calc(16px + var(--dsh-content-font-delta, 0px))')
    has('.mcpScope_injectionLeading svg', 'width: calc(14px + var(--dsh-content-font-delta, 0px))')
    has('.mcpScope_injectionTitle', 'font-size: var(--dsh-content-font-size-secondary, 13px)')
    // The body keeps the shipped fixed 11/16 metrics and its 22px indent.
    has('.mcpScope_injectionBody', 'max-height: 141px')
    has('.mcpScope_injectionBody', 'margin: 4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px))')
  })

  it('keeps the layout guards that stop hostile content from widening the column', () => {
    // jsdom cannot measure layout, so the contract is pinned lexically here.
    const ruleOf = (selector: string): string => {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      if (rule === undefined) throw new Error('no rule for ' + selector)
      return rule.body
    }
    // Long server names, workspace titles, credential refs and host paths must
    // truncate or wrap instead of widening the 720px settings column.
    expect(ruleOf('.mcpScope_serverRowName')).toMatch(/text-overflow:\s*ellipsis/)
    expect(ruleOf('.mcpScope_serverRowName')).toMatch(/max-width:\s*42%/)
    expect(ruleOf('.mcpScope_scopeName')).toMatch(/min-width:\s*0/)
    expect(ruleOf('.mcpScope_scopeName')).toMatch(/text-overflow:\s*ellipsis/)
    expect(ruleOf('.mcpScope_configValue')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleOf('.mcpScope_hint')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleOf('.mcpScope_detailTitle')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleOf('.mcpScope_credentialName')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleOf('.mcpScope_searchField')).toMatch(/min-width:\s*0/)
    expect(ruleOf('.mcpScope_searchInput')).toMatch(/width:\s*100%/)
    // The scope rows are a responsive grid: one column in a narrow panel, more
    // as it widens, so a long workspace list is not a 20-row stack.
    expect(ruleOf('.mcpScope_scopeGrid')).toMatch(/display:\s*grid/)
    expect(ruleOf('.mcpScope_scopeGrid')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(220px,\s*1fr\)\)/,
    )
    // The switch's native input fills its box, so the box's slop IS the hit
    // area: 44x28 around the unchanged 36x20 track.
    expect(ruleOf('.mcpScope_switchBox')).toMatch(/padding:\s*4px/)
    expect(ruleOf('.mcpScope_switchBox')).toMatch(/margin:\s*-4px/)
    expect(ruleOf('.mcpScope_switch')).toMatch(/width:\s*36px/)
    expect(ruleOf('.mcpScope_switch')).toMatch(/height:\s*20px/)
    expect(ruleOf('.mcpScope_switch')).toMatch(/pointer-events:\s*none/)
    // The scope row is 30px tall so the whole 28px hit box stays inside it.
    expect(ruleOf('.mcpScope_scopeRow')).toMatch(/min-height:\s*30px/)
    // The keyboard ring's OUTER edge lands exactly on the hit box.
    expect(ruleOf('.mcpScope_switchInput:focus-visible + .mcpScope_switch')).toMatch(/outline-offset:\s*2px/)
    // The row and its top line wrap rather than overflow on a narrow panel.
    expect(ruleOf('.mcpScope_serverRowTop')).toMatch(/flex-wrap:\s*wrap/)
    expect(ruleOf('.mcpScope_serverRowButton')).toMatch(/width:\s*100%/)
    // The editor footer stays reachable in a long form, and the dialog stays
    // inside the viewport.
    expect(ruleOf('.mcpScope_editorFooter')).toMatch(/position:\s*sticky/)
    expect(ruleOf('.mcpScope_editorFooter')).toMatch(/bottom:\s*0/)
    expect(ruleOf('.mcpScope_modal')).toMatch(/max-height:/)
    expect(ruleOf('.mcpScope_modalActions')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('mounts one style tag with the official tag convention, idempotently, and disposes it', () => {
    expect(css.length).toBeGreaterThan(1000)
    const dispose = mountStyles()
    const tags = document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
    expect(tags.length).toBe(1)
    const tag = tags[0] as HTMLStyleElement
    expect(tag.dataset.plugin).toBe(STYLE_PLUGIN)
    expect(tag.textContent).toBe(css)
    // A second mount (HMR re-apply, a second copy of the plugin in the same
    // document) reuses the tag and shares its ownership count.
    const second = mountStyles()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`).length).toBe(1)
    second()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`).length).toBe(1)
    dispose()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`).length).toBe(0)
  })

  it('keeps the sheet alive for a co-mounted owner and refreshes a stale tag (HMR order)', () => {
    // Order A: mount → mount → dispose → dispose (one instance unloads first).
    const first = mountStyles()
    const second = mountStyles()
    first()
    const survivor = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
    expect(survivor, 'the surviving owner must keep its stylesheet').not.toBeNull()
    expect(survivor!.textContent).toBe(css)
    second()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`).length).toBe(0)

    // Order B: an apply that runs BEFORE the outgoing fiber's disposer finds a
    // tag from the previous revision — it must repaint the current sheet.
    const stale = mountStyles()
    const tag = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_TAG_ID}"]`)!
    tag.textContent = '/* previous revision */'
    const fresh = mountStyles()
    expect(tag.textContent).toBe(css)
    fresh()
    stale()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`).length).toBe(0)
  })
})

describe('components consume the style seat', () => {
  it('renders the server list, its status pills and scope summary from the class map', () => {
    const doc: McpScopeDoc = {
      servers: [{ serverName: 'fixture', transport: 'stdio', command: 'node', args: ['a.js'], envKeys: ['TOK'] }],
      overrides: { 'ws-1': { fixture: true } },
    }
    const runtime: RuntimeSnapshot = {
      phase: 'ready',
      servers: { fixture: { name: 'fixture', state: 'connected', attempts: 0, maxAttempts: 10, toolCount: 3 } },
    }
    const markup = renderToStaticMarkup(
      <ServerListView
        t={t}
        doc={doc}
        runtime={runtime}
        runtimePhase="ready"
        workspaceStatus="ready"
        workspaces={[{ workspaceId: 'ws-1', path: '/w', title: 'work', sessionIds: [] }]}
        query=""
        onQueryChange={() => {}}
        filter="all"
        onFilterChange={() => {}}
        onOpen={() => {}}
        onAdd={() => {}}
        onImport={() => {}}
        writable
      />,
    )
    const classes = classesOf(markup)
    for (const name of [
      styles.section,
      styles.searchToolbar,
      styles.filterChips,
      styles.filterChip,
      styles.filterChipActive,
      styles.serverList,
      styles.serverRow,
      styles.serverRowButton,
      styles.serverRowTop,
      styles.serverRowName,
      styles.tag,
      styles.serverRowStats,
      styles.serverRowMeta,
      styles.statusPill,
      styles.statusPillDot,
      styles.statusPillOk,
      styles.serverRowChevron,
    ]) {
      expect(classes.has(name), 'missing ' + name).toBe(true)
    }
    expect(markup).toContain(t('server.scopeCount', { enabled: 1, total: 1 }))
  })

  it('renders the editor, its grouped fields, choices and sticky footer from the class map', () => {
    const markup = renderToStaticMarkup(
      <ServerEditor
        t={t}
        mode="add"
        initial={EMPTY_DRAFT}
        existingNames={[]}
        backLabel="All servers"
        writable
        credentials={{}}
        onSave={async () => ({ ok: true })}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    )
    const classes = classesOf(markup)
    for (const name of [
      styles.editor,
      styles.editorHead,
      styles.editorTitle,
      styles.editorSub,
      styles.editorSource,
      styles.editorGrid,
      styles.editorField,
      styles.fieldLabel,
      styles.input,
      styles.choices,
      styles.choice,
      styles.choiceInput,
      styles.choicePill,
      styles.editorSection,
      styles.editorSectionTitle,
      styles.editorFooter,
      styles.button,
      styles.buttonOutline,
      styles.buttonMd,
      styles.buttonPrimary,
    ]) {
      expect(classes.has(name), 'missing ' + name).toBe(true)
    }
    expect(markup).toContain('mcp-scope-editor-name')
    expect(markup).toContain(t('editor.saveAndTest'))
  })
})