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
    // Both state words retired with the per-row state text: the switch carries
    // the state on its own, so On/开启 would be dead copy too.
    expect(Object.keys(en)).not.toContain('row.on')
    expect(Object.keys(en)).not.toContain('row.off')
    expect(zh['add.commandUserHint']).toContain('该命令将以此 dsh 实例的用户身份直接执行。')
  })

  it('keeps exactly ONE workspace default-off sentence', () => {
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    // The single kept sentence lives on the server card / workspace panel: the
    // default flipped OFF, so this is the only server-level default sentence.
    expect(enDict['server.defaultOff']).toBeDefined()
    expect(zhDict['server.defaultOff']).toBeDefined()
    // The old default-ON sentence and its duplicate are gone from both halves.
    expect(enDict['server.defaultOn']).toBeUndefined()
    expect(zhDict['server.defaultOn']).toBeUndefined()
    expect(enDict['server.newWorkspaceDefault']).toBeUndefined()
    expect(zhDict['server.newWorkspaceDefault']).toBeUndefined()
  })

  it('carries the card-retry, stale-banner and default-off panel copy in both locales', () => {
    expect(zh['runtime.stale']).toBe('状态可能过期')
    expect(en['runtime.stale'].length).toBeGreaterThan(0)
    expect(en['action.retry']).toBe('Retry')
    expect(zh['action.retry']).toBe('重试')
    // The manage control counts the ENABLED workspaces; both labels are new.
    expect(en['row.manage']).toContain('Manage workspaces')
    expect(en['row.manage']).toContain('{count}')
    expect(zh['row.manage']).toContain('管理 workspace')
    expect(zh['row.manage']).toContain('{count}')
    expect(en['row.manageHide'].length).toBeGreaterThan(0)
    // The enable switch and the panel hint are the default-off copy surface.
    expect(en['server.enableToggle']).toBe('Allow server')
    expect(zh['server.enableToggle']).toBe('允许使用该服务器')
    expect(en['server.defaultOff'].length).toBeGreaterThan(0)
    expect(zh['server.defaultOff'].length).toBeGreaterThan(0)
    // The all-off summary is a plural pair with the same placeholder order.
    expect(countKey('row.allOffDefault', 1)).toBe('row.allOffDefault.one')
    expect(countKey('row.allOffDefault', 2)).toBe('row.allOffDefault.other')
    expect(placeholdersOf(en['row.allOffDefault.one'])).toEqual(placeholdersOf(zh['row.allOffDefault.one']))
    expect(placeholdersOf(en['row.allOffDefault.other'])).toEqual(placeholdersOf(zh['row.allOffDefault.other']))
    // The singular copy must be its own sentence (a single-workspace user sees
  // exactly this line) while keeping the placeholder contract.
  expect(placeholdersOf(zh['row.allOffDefault.one'])).toEqual(['count'])
  expect(zh['row.allOffDefault.one']).not.toBe(zh['row.allOffDefault.other'])
  })
})