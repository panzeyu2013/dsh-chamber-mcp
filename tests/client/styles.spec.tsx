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
import { AddServerForm, EMPTY_DRAFT } from '../../src/client/add-form.tsx'
import { ServerCard } from '../../src/client/server-card.tsx'
import {
  STYLE_PLUGIN,
  STYLE_TAG_ID,
  css,
  cx,
  mountStyles,
  styles,
} from '../../src/client/styles.ts'
import { en } from '../../src/client/locales.ts'
import type { SettingsKey } from '../../src/client/locales.ts'
import type { SectionT } from '../../src/client/section.tsx'
import type { McpScopeDoc } from '../../src/shared/model.ts'

/** Locale reader of the section namespace (en dictionary, `{name}` interpolation). */
const t = ((key: SettingsKey, params?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))) as unknown as SectionT

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

  it('lets the card gap own the vertical rhythm: every card paragraph resets its margin', () => {
    // The card is a `gap: 8px` flex column; a paragraph that keeps the UA margin
    // doubles the space around its own line (the reported give-up line opened
    // ~20px instead of 8px). Every paragraph class the card renders must reset it.
    for (const selector of [
      '.mcpScope_statusText',
      '.mcpScope_statusErrorText',
      '.mcpScope_hint',
      '.mcpScope_noticeOk',
      '.mcpScope_confirmText',
      '.mcpScope_empty',
    ]) {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      expect(rule, `no rule for ${selector}`).toBeDefined()
      expect(rule!.body, `${selector} keeps a UA margin inside the 8px-gap card`).toMatch(
        /(?:^|[;{\s])margin:\s*0\s*;/,
      )
    }
  })

  it('paints the official panel card recipe: r14 + elevation stroke + 12/14 inset, no border', () => {
    const card = rules(css).find((rule) => rule.selector === '.mcpScope_card')
    expect(card, 'no rule for .mcpScope_card').toBeDefined()
    expect(card!.body).toMatch(/border-radius:\s*14px/)
    expect(card!.body).toMatch(/box-shadow:\s*var\(--dsw-elevation-stroke\)/)
    expect(card!.body).toMatch(/padding:\s*12px 14px/)
    // The hairline is the elevation stroke now — a border would double it.
    expect(card!.body).not.toMatch(/border\s*:/)
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
    expect(bodyOf('.mcpScope_focusRing:focus-visible')).toContain(accent)
    // primary control fill
    expect(bodyOf('.mcpScope_buttonPrimary')).toContain('var(--dsw-alias-button-info-fill)')
    expect(bodyOf('.mcpScope_buttonPrimary:hover:not(:disabled)')).toContain('var(--dsw-alias-button-info-hover)')
    // normal state (rows, banner, card surface) stays monochrome
    expect(bodyOf('.mcpScope_wsLabel')).toContain('var(--dsw-alias-label-primary)')
    expect(bodyOf('.mcpScope_staleBanner')).not.toContain(accent)
    expect(bodyOf('.mcpScope_card')).not.toContain('state-business-primary')
    expect(bodyOf('.mcpScope_card')).not.toContain('button-info')
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
        '.mcpScope_focusRing:focus-visible',
        '.mcpScope_iconButton:focus-visible',
        // the registered-tools notice is a shipped-chrome disclosure row: only
        // its keyboard focus rings (the row's and each source's) spend the
        // accent, like every other control
        '.mcpScope_injectionHead:focus-visible',
        '.mcpScope_injectionServerHead:focus-visible',
        '.mcpScope_input:focus',
        '.mcpScope_linkButton:focus-visible',
        '.mcpScope_switchInput:checked + .mcpScope_switch',
        // the card-local workspace filter keeps the brand focus border
        '.mcpScope_wsFilterInput:focus',
        '.mcpScope_switchInput:focus-visible + .mcpScope_switch',
        '.mcpScope_textarea:focus',
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
    expect(cx(styles.card, false, undefined, styles.button)).toBe(`${styles.card} ${styles.button}`)
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
    // jsdom cannot measure layout, so the contract is pinned lexically here and
    // measured for real in the browser harness (§9.4 of docs/design.md):
    // header names and credential refs are not length-capped by the document
    // schema, and a working directory is an arbitrary host path.
    const ruleOf = (selector: string): string => {
      const rule = rules(css).find((candidate) => candidate.selector === selector)
      if (rule === undefined) throw new Error(`no rule for ${selector}`)
      return rule.body
    }
    expect(ruleOf('.mcpScope_badges')).toMatch(/flex-wrap:\s*wrap/)
    expect(ruleOf('.mcpScope_badge')).toMatch(/max-width:\s*100%/)
    for (const part of ['.mcpScope_badgeKey', '.mcpScope_badgeRef']) {
      expect(ruleOf(part), `${part} must be able to truncate`).toMatch(/min-width:\s*0/)
      expect(ruleOf(part)).toMatch(/text-overflow:\s*ellipsis/)
    }
    expect(ruleOf('.mcpScope_code')).toMatch(/text-overflow:\s*ellipsis/)
    expect(ruleOf('.mcpScope_hint')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(ruleOf('.mcpScope_noticeText')).toMatch(/overflow-wrap:\s*anywhere/)
    // The label is the whole text RUN (name + state word) so every pixel of it
    // toggles; the name itself carries the truncation.
    expect(ruleOf('.mcpScope_wsLabel')).toMatch(/display:\s*flex/)
    expect(ruleOf('.mcpScope_wsLabel')).toMatch(/cursor:\s*pointer/)
    // The label fills the row's full 28px band: no dead strip beside the switch.
    expect(ruleOf('.mcpScope_wsLabel')).toMatch(/align-self:\s*stretch/)
    expect(ruleOf('.mcpScope_wsName')).toMatch(/text-overflow:\s*ellipsis/)
    // The card-local filter keeps the field geometry but not the official field
    // fill: bg-layer-1 reads as a white slab against the card's bg-layer-3.
    expect(ruleOf('.mcpScope_wsFilterInput')).toMatch(/background:\s*transparent/)
    expect(ruleOf('.mcpScope_wsFilterInput')).toMatch(/border-color:\s*var\(--dsw-alias-border-l3\)/)
    // The rows are a responsive grid: one column in a narrow panel, more as the
    // settings panel widens, so a long workspace list is not a 20-row stack.
    expect(ruleOf('.mcpScope_wsList')).toMatch(/display:\s*grid/)
    expect(ruleOf('.mcpScope_wsList')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(200px,\s*1fr\)\)/,
    )
    // The switch's native input fills its box, so the box's slop IS the hit
    // area: 44x28 around the unchanged 36x20 track.
    expect(ruleOf('.mcpScope_switchBox')).toMatch(/padding:\s*4px/)
    expect(ruleOf('.mcpScope_switchBox')).toMatch(/margin:\s*-4px/)
    expect(ruleOf('.mcpScope_switch')).toMatch(/width:\s*36px/)
    expect(ruleOf('.mcpScope_switch')).toMatch(/height:\s*20px/)
    // The row holds the whole 28px hit box (4 + 20 + 4): anything shorter lets
    // two rows' hit boxes overlap, and the lower input wins that band.
    expect(ruleOf('.mcpScope_wsRow')).toMatch(/min-height:\s*28px/)
    // The keyboard ring draws the hit box, not the bare track.
    expect(ruleOf('.mcpScope_switchInput:focus-visible + .mcpScope_switch')).toMatch(/outline-offset:\s*4px/)
    expect(ruleOf('.mcpScope_rowInput')).toMatch(/min-width:\s*0/)
    expect(ruleOf('.mcpScope_cardHead')).toMatch(/flex-wrap:\s*wrap/)
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
  it('renders the card, its capsule actions, tags, badges and switch from the class map', () => {
    const doc: McpScopeDoc = {
      servers: [],
      overrides: { 'ws-1': { fixture: true } },
    }
    const markup = renderToStaticMarkup(
      <ServerCard
        t={t}
        server={{ serverName: 'fixture', transport: 'stdio', command: 'node', args: ['a.js'], envKeys: ['TOK'] }}
        doc={doc}
        credentials={{ TOK: { configured: true, writable: true } }}
        writable
        workspaceStatus="ready"
        workspaces={[{ workspaceId: 'ws-1', path: '/w', title: 'work', sessionIds: [] }]}
        onRefresh={async () => {}}
        onEdit={() => {}}
        onRemove={async () => ({ ok: true })}
        onToggle={async () => ({ ok: true })}
        onToggleAll={async () => ({ ok: true })}
        onSetEnabled={async () => ({ ok: true })}
        onUnsetCredential={async () => ({ ok: true })}
      />,
    )
    for (const name of [
      styles.card,
      styles.cardHead,
      styles.cardName,
      styles.tag,
      styles.cardMeta,
      styles.cardActions,
      styles.cardRefresh,
      styles.button,
      styles.buttonDanger,
      styles.buttonOutline,
      styles.code,
      styles.badges,
      styles.badge,
      styles.badgeOk,
      styles.badgeKey,
      styles.linkButton,
      styles.wsBlock,
      styles.wsList,
      styles.wsRow,
      styles.switchBox,
      styles.switchInput,
      styles.switch,
      styles.switchThumb,
      styles.wsLabel,
      styles.wsName,
    ]) {
      expect(markup, `missing ${name}`).toContain(name)
    }
    // the switch stays a real, controlled checkbox behind its painted track
    expect(markup).toMatch(/<input[^>]*role="switch"[^>]*>/)
  })

  it('renders the staged form, its fields, choice pills and footer from the class map', () => {
    const markup = renderToStaticMarkup(
      <AddServerForm
        t={t}
        titleKey="add.title"
        initial={EMPTY_DRAFT}
        existingNames={[]}
        writable
        onSave={async () => ({ ok: true })}
        onClose={() => {}}
      />,
    )
    for (const name of [
      styles.form,
      styles.formTitle,
      styles.field,
      styles.fieldLabel,
      styles.fieldHint,
      styles.input,
      styles.choices,
      styles.choice,
      styles.choiceInput,
      styles.choicePill,
      styles.rowsGroup,
      styles.row,
      styles.rowInput,
      styles.button,
      styles.buttonOutline,
      styles.buttonMd,
      styles.buttonPrimary,
      styles.formActions,
    ]) {
      expect(markup, `missing ${name}`).toContain(name)
    }
  })
})