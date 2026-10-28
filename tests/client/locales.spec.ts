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

  it('carries the new list/detail/workspaces/editor copy in both locales', () => {
    expect(en['tab.servers']).toBe('Servers')
    expect(en['tab.workspaces']).toBe('Workspaces')
    expect(zh['section.subtitle']).toContain('MCP 服务器')
    expect(en['server.allowedLabel']).toBe('Allowed to run')
    expect(zh['server.allowedLabel']).toBe('允许运行')
    expect(en['server.allowedHint']).toContain('does not enable')
    expect(en['server.disabledNotice'].length).toBeGreaterThan(0)
    expect(zh['server.disabledNotice'].length).toBeGreaterThan(0)
    expect(en['server.clearConfirmShared']).toContain('{servers}')
    expect(en['editor.saveAndTest']).toBe('Save and test')
    expect(zh['editor.saveAndTest']).toBe('保存并测试')
    expect(en['toast.undo']).toBe('Undo')
    expect(zh['toast.scopeBulk']).toContain('{count}')
    expect(en['runtime.stale'].length).toBeGreaterThan(0)
    expect(zh['runtime.stale']).toBe('状态可能过期')
    expect(en['action.retry']).toBe('Retry')
    expect(zh['action.retry']).toBe('重试')
    // Retired card-era controls must not creep back into the dictionary.
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    for (const retired of ['row.manage', 'server.enableToggle', 'server.removeConfirmTitle', 'dirty.confirm', 'action.save']) {
      expect(enDict[retired], retired).toBeUndefined()
      expect(zhDict[retired], retired).toBeUndefined()
    }
    expect(enDict['row.allOffDefault.other']).toBeUndefined()
    expect(zhDict['row.allOffDefault.other']).toBeUndefined()
  })
})