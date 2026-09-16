/**
 * INDEPENDENT acceptance suite, C4 axis 1 (CORRECTNESS): locale copy.
 *
 * The frozen contract requires every key to exist in en AND zh with identical
 * placeholders. The per-row state words (row.on / row.off) were retired when the
 * switch became the only state carrier, and the card's server.defaultOff note
 * line followed them: no server-level default-off sentence survives.
 */
import { describe, expect, it } from 'vitest'
import { en, zh, type SettingsKey } from '../../src/client/locales.ts'

const keys = Object.keys(en) as readonly SettingsKey[]
const PLACEHOLDER = /\{(\w+)\}/g

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort()
}

/** Runtime-safe read: contract keys may legitimately be deleted by the fix. */
const lookup = (dictionary: unknown, key: string): string | undefined =>
  (dictionary as Record<string, string | undefined>)[key]

describe('C4 correctness: locale copy', () => {
  it('[correctness] copy: every key exists in en AND zh with identical placeholders', () => {
    expect([...Object.keys(zh)].sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect((en[key] ?? '').length, key).toBeGreaterThan(0)
      expect((zh[key] ?? '').length, key).toBeGreaterThan(0)
      expect(placeholdersOf(zh[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('[correctness] copy: no server-level default-off sentence survives', () => {
    // The card's note line is retired: the enable switch (off by default) is the
    // copy surface, and a collapsed card with nothing enabled renders no rows at
    // all — there is no summary sentence left to pin.
    expect(lookup(en, 'server.defaultOff')).toBeUndefined()
    expect(lookup(zh, 'server.defaultOff')).toBeUndefined()
    // Exactly ONE server-level default sentence per locale (the plural
    // (the retired row.allOffDefault pair used to be the collapsed summary).
    const serverKeys = keys.filter((key) => key.startsWith('server.'))
    expect(serverKeys.filter((key) => /default/i.test(en[key] ?? '') && /off/i.test(en[key] ?? ''))).toEqual([])
    expect(serverKeys.filter((key) => /默认/.test(zh[key] ?? '') && /关闭/.test(zh[key] ?? ''))).toEqual([])
    // No default-ON copy may survive the flip: the old canonical key is gone
    // and no key adds a new-workspace default-ON sentence.
    expect(lookup(en, 'server.defaultOn')).toBeUndefined()
    expect(lookup(zh, 'server.defaultOn')).toBeUndefined()
    const legacyEn = lookup(en, 'server.newWorkspaceDefault')
    const legacyZh = lookup(zh, 'server.newWorkspaceDefault')
    if (legacyEn !== undefined) {
      expect(legacyEn, 'server.newWorkspaceDefault must not stay a second default sentence').not.toMatch(
        /new workspaces?/i,
      )
      expect(legacyEn, 'server.newWorkspaceDefault must not stay a second default sentence').not.toMatch(/default/i)
      expect(legacyZh ?? '').not.toMatch(/新\s*workspace/i)
    }
    const survivors = keys.filter((key) => /new workspaces?/i.test(en[key] ?? '') && /default/i.test(en[key] ?? ''))
    expect(survivors).toEqual([])
  })

  it('[correctness] copy: row.on is retired with the per-row state word', () => {
    // The workspace row is the switch plus the name: neither "On" nor "Off" is
    // spelled out any more, so both keys are gone rather than dead contract copy.
    expect(lookup(en, 'row.on')).toBeUndefined()
    expect(lookup(zh, 'row.on')).toBeUndefined()
  })

  it('[correctness] copy: row.off is retired with the On-only state word', () => {
    // The rows spell ONLY the ON state now (a column of "Off" beside a switch
    // that already reads off was noise), so the key is gone from both locales
    // rather than left as dead copy for this contract to pin.
    expect(lookup(en, 'row.off')).toBeUndefined()
    expect(lookup(zh, 'row.off')).toBeUndefined()
  })
})
