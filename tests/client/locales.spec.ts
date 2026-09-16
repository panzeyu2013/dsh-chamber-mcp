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

  it('keeps NO server-level default sentence and no default-ON copy', () => {
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    // The card-level note is retired: the switches (OFF by default) carry it,
    // and the collapsed card simply renders no rows.
    expect(enDict['server.defaultOff']).toBeUndefined()
    expect(zhDict['server.defaultOff']).toBeUndefined()
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
    // The enable switch is the default-off copy surface now.
    expect(en['server.enableToggle']).toBe('Allow server')
    expect(zh['server.enableToggle']).toBe('允许使用该服务器')
    // No default-off summary pair survives either: the collapsed card renders
    // nothing when the server is off everywhere (row.allOffDefault retired).
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    expect(enDict['row.allOffDefault.other']).toBeUndefined()
    expect(zhDict['row.allOffDefault.other']).toBeUndefined()
    expect(enDict['row.allOffDefault.one']).toBeUndefined()
    // The count-plural machinery itself still works on a live family: the
    // singular form is its own sentence with the same placeholder contract.
    expect(countKey('server.enabledWorkspaces', 2)).toBe('server.enabledWorkspaces.other')
    expect(placeholdersOf(en['server.enabledWorkspaces.one'])).toEqual(['count'])
    expect(en['server.enabledWorkspaces.one']).not.toBe(en['server.enabledWorkspaces.other'])
  })
})