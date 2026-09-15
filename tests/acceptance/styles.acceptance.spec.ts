/**
 * INDEPENDENT acceptance suite, C4 axis 2 (COMPLETENESS): the accent token
 * drives the interactive/selected states (contract C3d), while the neutral
 * (off) state stays monochrome.
 *
 * The accepted tokens are the ones VERIFIED to resolve to the deepseek accent
 * in the pinned generation (grep of the shipped ui-theme bundle); the predicate
 * is name-based and hermetic, so it rejects an alias that resolves to neutral
 * ink (the old --dsw-alias-brand-primary) even though it contains "brand".
 */
import { describe, expect, it } from 'vitest'
import { css, styles } from '../../src/client/styles.ts'

interface Rule {
  selector: string
  body: string
}

function rules(sheet: string): Rule[] {
  const out: Rule[] = []
  for (const match of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (selector === '') continue
    out.push({ selector, body: match[2] ?? '' })
  }
  return out
}

const RULES = rules(css)

/**
 * Tokens that resolve to the deepseek accent in the PINNED generation
 * (ui-theme design-platform.css), verified against the shipped theme bundle:
 *   --dsw-static-deepseek-{400,450,500,600}
 *   --dsw-alias-state-business-primary  -> deepseek-500 (light) / deepseek-400 (dark)
 *   --dsw-alias-button-info-fill/-hover -> deepseek-500 / deepseek-400
 * Deliberately NOT accepted: --dsw-alias-brand-primary, which in this generation
 * resolves to neutral ink (bluish-1000/bluish-50), not to the accent.
 */
const ACCENT_TOKENS = new Set([
  '--dsw-alias-state-business-primary',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
])

function isAccentToken(token: string): boolean {
  return /^--dsw-static-deepseek-\d+$/.test(token) || ACCENT_TOKENS.has(token)
}

function ruleFor(selector: string): string {
  const found = RULES.find((rule) => rule.selector === selector)
  if (found === undefined) throw new Error('no CSS rule for ' + selector)
  return found.body
}

function ruleContaining(parts: readonly string[], marker: string): string {
  const found = RULES.find((rule) => parts.every((part) => rule.selector.includes(part)) && rule.selector.includes(marker))
  if (found === undefined) throw new Error('no CSS rule containing ' + parts.join(' + ') + ' with ' + marker)
  return found.body
}

function tokenOf(body: string, property: RegExp): string | undefined {
  const match = property.exec(body)
  return match?.[1]
}

describe('C4 completeness: accent token drives the interactive states', () => {
  it('[completeness] accent: the switch-on state is painted with the accent token', () => {
    const body = ruleContaining([styles.switchInput, styles.switch], ':checked')
    const token = tokenOf(body, /background(?:-color)?\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/)
    expect(token, 'background of ' + ruleContaining([styles.switchInput, styles.switch], ':checked')).toBeDefined()
    expect(isAccentToken(token as string)).toBe(true)
  })

  it('[completeness] accent: the switch focus-visible ring uses the accent token', () => {
    const body = ruleContaining([styles.switchInput, styles.switch], ':focus-visible')
    const token = tokenOf(body, /outline\s*:[^;]*var\(\s*(--[a-z0-9-]+)\s*\)/)
    expect(token).toBeDefined()
    expect(isAccentToken(token as string)).toBe(true)
  })

  it('[completeness] accent: the primary button fill uses an accent-family token', () => {
    const body = ruleFor('.' + styles.buttonPrimary)
    const token = tokenOf(body, /background(?:-color)?\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/)
    expect(token).toBeDefined()
    expect(isAccentToken(token as string)).toBe(true)
  })

  it('[completeness] accent: the neutral off switch track stays monochrome (not accent)', () => {
    const body = ruleFor('.' + styles.switch)
    const token = tokenOf(body, /background(?:-color)?\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/)
    expect(token).toBeDefined()
    expect(isAccentToken(token as string)).toBe(false)
  })
})
