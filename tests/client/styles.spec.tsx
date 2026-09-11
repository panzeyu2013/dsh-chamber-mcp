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
 */
const THEME_TOKENS = new Set([
  '--ds-ease-in-out',
  '--ds-font-family-code',
  '--ds-transition-duration',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
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

  it('is balanced CSS and exports exactly the classes it styles', () => {
    expect(css.match(/\{/g)?.length).toBe(css.match(/\}/g)?.length)
    const exported = new Set<string>(Object.values(styles))
    const styled = cssClassesOf(css)
    expect([...styled].filter((name) => !exported.has(name))).toEqual([]) // no dead rule
    expect([...exported].filter((name) => !styled.has(name))).toEqual([]) // no unstyled class
    expect(cx(styles.card, false, undefined, styles.button)).toBe(`${styles.card} ${styles.button}`)
    expect(cx()).toBe('')
  })

  it('keeps the layout guards that stop hostile content from widening the column', () => {
    // jsdom cannot measure layout, so the contract is pinned lexically here and
    // measured for real in the browser harness (§6.4 of docs/ui-notes.md):
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
    expect(ruleOf('.mcpScope_wsLabel')).toMatch(/text-overflow:\s*ellipsis/)
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
        onEdit={() => {}}
        onRemove={async () => ({ ok: true })}
        onToggle={async () => ({ ok: true })}
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
      styles.wsState,
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
