import { describe, expect, it } from 'vitest'
import { en, zh, type SettingsKey } from '../../src/client/locales.js'

const PLACEHOLDER = /\{(\w+)\}/g

const keys = Object.keys(en) as readonly SettingsKey[]

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort()
}

describe('locales: en/zh parity', () => {
  it('carries the same key set in both built-in locales', () => {
    const enKeys = [...keys].sort()
    const zhKeys = [...Object.keys(zh) as readonly SettingsKey[]].sort()
    expect(enKeys).toEqual(zhKeys)
    expect(enKeys.length).toBeGreaterThan(0)
  })

  it('has no empty or placeholder-less values', () => {
    for (const key of keys) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(en[key].trim()).not.toBe('')
      expect(zh[key].length).toBeGreaterThan(0)
      expect(zh[key].trim()).not.toBe('')
    }
  })

  it('matches interpolation placeholders between locales per key', () => {
    for (const key of keys) {
      expect(placeholdersOf(en[key])).toEqual(placeholdersOf(zh[key]))
    }
  })

  it('declares the strings the UI semantics require', () => {
    expect(en['nav']).toBe('MCP servers')
    expect(zh['nav']).toBe('MCP 服务器')
    expect(en['row.on']).toContain('default')
    expect(zh['row.off']).toContain('关闭')
    expect(zh['add.commandUserHint']).toContain('该命令将以此 dsh 实例的用户身份直接执行。')
  })
})
