/**
 * INDEPENDENT acceptance suite, C4 axis 1 (CORRECTNESS): locale copy.
 *
 * The frozen contract keeps exactly ONE default-on sentence
 * (server.defaultOn), narrows row.on to a plain On/开启, and requires every
 * key to exist in en AND zh with identical placeholders.
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

  it('[correctness] copy: exactly one default-on sentence per locale', () => {
    expect(en['server.defaultOn']).toMatch(/default/i)
    expect(zh['server.defaultOn']).toMatch(/默认/)
    // The redundant per-card second sentence must be gone or repurposed: no
    // remaining new-workspace-default-on copy anywhere in the dictionary.
    const legacyEn = lookup(en, 'server.newWorkspaceDefault')
    const legacyZh = lookup(zh, 'server.newWorkspaceDefault')
    if (legacyEn !== undefined) {
      expect(legacyEn, 'server.newWorkspaceDefault must not stay a second default-on sentence').not.toMatch(
        /new workspaces?/i,
      )
      expect(legacyEn, 'server.newWorkspaceDefault must not stay a second default-on sentence').not.toMatch(/default/i)
      expect(legacyZh ?? '').not.toMatch(/新\s*workspace/i)
    }
    const survivors = keys.filter((key) => /new workspaces?/i.test(en[key] ?? '') && /default/i.test(en[key] ?? ''))
    expect(survivors).toEqual([])
  })

  it('[correctness] copy: row.on is the plain On/开启 label (no default marker)', () => {
    expect((en['row.on'] ?? '').trim()).toBe('On')
    expect((zh['row.on'] ?? '').trim()).toBe('开启')
  })

  it('[correctness] copy: row.off keeps its plain Off/已关闭 label', () => {
    expect((en['row.off'] ?? '').trim()).toBe('Off')
    expect((zh['row.off'] ?? '').trim()).toBe('已关闭')
  })
})
