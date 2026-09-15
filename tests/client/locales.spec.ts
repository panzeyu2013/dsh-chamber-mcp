import { describe, expect, it } from 'vitest'
import { countKey, en, zh, type SettingsKey } from '../../src/client/locales.js'

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
    expect(en['row.on']).toBe('On')
    expect(zh['row.on']).toBe('开启')
    expect(en['row.on']).not.toContain('default')
    expect(zh['row.off']).toContain('关闭')
    expect(zh['add.commandUserHint']).toContain('该命令将以此 dsh 实例的用户身份直接执行。')
  })

  it('keeps exactly ONE workspace default-on sentence', () => {
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    // The single kept sentence lives on the server card / exceptions panel.
    expect(enDict['server.defaultOn']).toBeDefined()
    expect(zhDict['server.defaultOn']).toBeDefined()
    // Its duplicate is gone from both halves (the meaning moved into the panel).
    expect(enDict['server.newWorkspaceDefault']).toBeUndefined()
    expect(zhDict['server.newWorkspaceDefault']).toBeUndefined()
  })

  it('carries the card-retry, stale-banner and exceptions-panel copy in both locales', () => {
    expect(zh['runtime.stale']).toBe('状态可能过期')
    expect(en['runtime.stale'].length).toBeGreaterThan(0)
    expect(en['action.retry']).toBe('Retry')
    expect(zh['action.retry']).toBe('重试')
    expect(en['row.manage']).toContain('{count}')
    expect(zh['row.manage']).toContain('管理例外')
    expect(en['row.manageHide'].length).toBeGreaterThan(0)
    // The all-on summary is a plural pair with the same placeholder order.
    expect(countKey('row.allOnDefault', 1)).toBe('row.allOnDefault.one')
    expect(countKey('row.allOnDefault', 2)).toBe('row.allOnDefault.other')
    expect(placeholdersOf(en['row.allOnDefault.one'])).toEqual(placeholdersOf(zh['row.allOnDefault.one']))
    expect(placeholdersOf(en['row.allOnDefault.other'])).toEqual(placeholdersOf(zh['row.allOnDefault.other']))
    // The singular copy must be its own sentence (a single-workspace user sees
  // exactly this line) while keeping the placeholder contract.
  expect(placeholdersOf(zh['row.allOnDefault.one'])).toEqual(['count'])
  expect(zh['row.allOnDefault.one']).not.toBe(zh['row.allOnDefault.other'])
  })
})