// @vitest-environment jsdom
/**
 * Settings editor render evidence: add/edit forms, import candidate flows,
 * draft persistence, validation/focus, secrets, queueing and removal confirm.
 * Mount/helper plumbing lives in tests/support/section-kit.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSaveInput } from '../../src/client/controller.ts'
import { cleanupSections } from '../support/section-harness.tsx'
import {
  buttonByText,
  buttonsOf,
  CONFLICT,
  dialog,
  flush,
  mountSection,
  openServer,
  runtimeWith,
  setValue,
  stdioServer,
  t,
  WS,
  type Mounted,
} from '../support/section-kit.ts'

afterEach(() => {
  cleanupSections()
  sessionStorage.clear()
})
beforeEach(() => {
  sessionStorage.clear()
})

describe('editor', () => {
  it('keeps Save enabled and reveals the validation summary instead of failing silently', async () => {
    const calls: ServerSaveInput[] = []
    const mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          calls.push(input)
          return { ok: true }
        },
      },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const save = buttonByText(mounted.host, t('editor.saveAndTest'))!
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    expect(mounted.text()).toContain(t('editor.errorMany', { count: 2 }))
    expect(calls).toHaveLength(0)
    expect(document.activeElement?.id).toBe('mcp-scope-editor-name')
  })

  it('validates, saves, navigates to the detail and auto-tests the new server', async () => {
    const added: ServerSaveInput[] = []
    const tested: string[] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          added.push(input)
          // The real controller publishes the new document before the section
          // navigates; mirror that here so the detail is not misread as stale.
          mounted.live.doc = {
            servers: [...mounted.live.doc.servers, input.server],
            overrides: mounted.live.doc.overrides,
            disabled: mounted.live.doc.disabled,
          }
          return { ok: true }
        },
        testServer: async (name) => {
          tested.push(name)
          return { ok: true, toolCount: 2 }
        },
      },
      { wsItems: WS },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
    setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'npx')
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(added).toHaveLength(1)
    expect(added[0]!.server.serverName).toBe('github')
    expect(mounted.host.querySelector('[data-mcp-server-detail="github"]')).not.toBeNull()
    expect(tested).toEqual(['github'])
  })


  it('saving a disabled server definition preserves availability and skips auto-test', async () => {
    const replaced: unknown[][] = []
    const tested: string[] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {}, disabled: { alpha: true } },
      {
        replaceServer: async (...args) => {
          replaced.push(args)
          mounted.live.doc = {
            servers: [stdioServer('alpha')],
            overrides: {},
            disabled: { alpha: true },
          }
          return { ok: true }
        },
        testServer: async (name) => {
          tested.push(name)
          return { ok: true, toolCount: 0 }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.edit'))!.click()
    await flush()
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(replaced).toHaveLength(1)
    const input = (replaced[0] as [string, ServerSaveInput])[1]
    expect(input.enabled).toBeUndefined()
    expect(tested).toEqual([])
  })


  it('saves the HTTP branch with URL, header ref and secret', async () => {
    const added: ServerSaveInput[] = []
    const mounted = mountSection(
      { servers: [], overrides: {} },
      {
        addServer: async (input) => {
          added.push(input)
          return { ok: true }
        },
      },
      { wsItems: WS },
    )
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    document.getElementById('mcp-scope-editor-transport-http')!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'remote')
    setValue(document.getElementById('mcp-scope-editor-url') as HTMLInputElement, 'https://example.test/mcp')
    setValue(
      document.getElementById('mcp-scope-editor-header-name-0') as HTMLInputElement,
      'Authorization',
    )
    setValue(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!,
      'bearer',
    )
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(added).toHaveLength(1)
    expect(added[0]!.server).toEqual({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', ref: 'AUTHORIZATION' }],
    })
    expect(added[0]!.secrets).toEqual([{ ref: 'AUTHORIZATION', value: 'bearer' }])
  })

  it('imports a single server from a JSON snippet', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    buttonByText(mounted.host, t('add.importJson'))!.click()
    await flush()
    const textarea = dialog().querySelector('textarea')!
    setValue(textarea, JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }))
    buttonByText(dialog(), t('import.parse'))!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('github')
    expect((document.getElementById('mcp-scope-editor-command') as HTMLInputElement).value).toBe('npx')
  })


  it('opens the advanced section and focuses the timeout when that is the first invalid field', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
    setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'npx')
    const advanced = buttonByText(mounted.host, t('editor.advanced'))!
    advanced.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-timeout') as HTMLInputElement, '1')
    advanced.click()
    await flush()
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(document.activeElement?.id).toBe('mcp-scope-editor-timeout')
  })


  it('returns focus to the list after discarding the editor', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'draft')
    buttonByText(mounted.host, t('action.cancel'))!.click()
    await flush()
    buttonByText(dialog(), t('dirty.discard'))!.click()
    await flush()
    expect(mounted.host.querySelector('#mcp-scope-editor-name')).toBeNull()
    expect(document.activeElement?.textContent ?? '').toContain(t('add.add'))
  })

  it('shows and hides a typed secret value', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const secret = mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!
    expect(secret.type).toBe('password')
    buttonsOf(mounted.host)
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith(t('editor.showSecret')))!
      .click()
    await flush()
    expect(mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!.type).toBe('text')
  })


  it('restores a persisted draft without secret values', async () => {
    sessionStorage.setItem(
      'mcp-scope.draft.v2:add',
      JSON.stringify({
        name: 'restored',
        transport: 'stdio',
        command: 'node',
        cwd: '',
        args: ['server.js'],
        env: [{ key: 'TOKEN', value: '' }],
        url: '',
        headers: [{ name: '', ref: '', value: '' }],
        enabled: true,
        timeoutMs: '',
      }),
    )
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    expect(mounted.text()).toContain(t('editor.restored'))
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('restored')
    expect(mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!.value).toBe('')
  })


  it('never writes a typed secret into the persisted draft', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    const originalSet = window.setTimeout.bind(window)
    const timers: { delay: number; handler: TimerHandler }[] = []
    const setSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = originalSet(handler, delay, ...args)
      timers.push({ delay: Number(delay ?? 0), handler })
      return id
    }) as typeof window.setTimeout)
    try {
      setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'github')
      setValue(document.getElementById('mcp-scope-editor-command') as HTMLInputElement, 'node')
      setValue(
        mounted.host.querySelector<HTMLInputElement>('input[aria-label="' + t('add.secretValueLabel') + ' 1"]')!,
        'supersecret',
      )
      await flush()
      const draftTimer = [...timers].reverse().find((entry) => entry.delay === 300)
      expect(draftTimer, 'no 300ms draft debounce timer was armed').toBeDefined()
      if (typeof draftTimer!.handler === 'function') draftTimer!.handler()
      await flush()
      const raw = sessionStorage.getItem('mcp-scope.draft.v2:add')
      expect(raw).not.toBeNull()
      expect(raw).not.toContain('supersecret')
      const persisted = JSON.parse(raw!) as { command: string; env: { key: string; value: string }[] }
      expect(persisted.command).toBe('node')
      expect(persisted.env[0]!.value).toBe('')
    } finally {
      setSpy.mockRestore()
    }
  })

  it('selects one server from a multi-server JSON snippet', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    buttonByText(mounted.host, t('add.importJson'))!.click()
    await flush()
    setValue(
      dialog().querySelector('textarea')!,
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'node', args: ['a.js'] },
          beta: { command: 'node', args: ['b.js'] },
        },
      }),
    )
    buttonByText(dialog(), t('import.parse'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('editor.importCandidates'))
    buttonByText(dialog(), t('editor.importUse', { name: 'beta' }))!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('beta')
  })

  it('rolls an optimistic toggle back when the write fails', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      { toggleWorkspace: CONFLICT },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    const input = detail.querySelector<HTMLInputElement>(
      'input[aria-label="' + t('server.workspacesTitle') + ': beta"]',
    )!
    input.click()
    await flush()
    expect(
      detail.querySelector<HTMLInputElement>(
        'input[aria-label="' + t('server.workspacesTitle') + ': beta"]',
      )!.checked,
    ).toBe(false)
    expect(mounted.text()).toContain(t('error.conflict'))
    expect(buttonByText(mounted.host, t('action.retry'))).toBeDefined()
  })


  it('keeps the queue moving after a failed write and clears the saving indicator', async () => {
    let calls = 0
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async () => {
          calls += 1
          return calls === 1 ? { ok: false, reason: 'save-failed' } : { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!
      .click()
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': gamma"]')!
      .click()
    await flush()
    expect(calls).toBe(2)
    expect(mounted.text()).toContain(t('error.saveFailed'))
    expect(mounted.text()).not.toContain(t('section.saving'))
  })

  it('serializes writes from two switches through one queue', async () => {
    const order: string[] = []
    const resolvers: Array<() => void> = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        toggleWorkspace: async (workspaceId) => {
          order.push(workspaceId)
          await new Promise<void>((resolve) => resolvers.push(resolve))
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': beta"]')!
      .click()
    detail
      .querySelector<HTMLInputElement>('input[aria-label="' + t('server.workspacesTitle') + ': gamma"]')!
      .click()
    await flush()
    expect(order).toEqual(['ws-b'])
    expect(mounted.text()).toContain(t('section.saving'))
    resolvers[0]!()
    await flush()
    expect(order).toEqual(['ws-b', 'ws-c'])
    resolvers[1]!()
    await flush()
  })

  it('opens edit mode with the definition and warns on rename', async () => {
    const replaced: unknown[][] = []
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        replaceServer: async (...args) => {
          replaced.push(args)
          mounted.live.doc = {
            ...mounted.live.doc,
            servers: [stdioServer('renamed')],
          }
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.edit'))!.click()
    await flush()
    expect((document.getElementById('mcp-scope-editor-name') as HTMLInputElement).value).toBe('alpha')
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'renamed')
    await flush()
    expect(mounted.text()).toContain(t('editor.renameWarning', { old: 'alpha', new: 'renamed' }))
    buttonByText(mounted.host, t('editor.saveAndTest'))!.click()
    await flush()
    expect(replaced).toHaveLength(1)
    expect((replaced[0] as [string, ServerSaveInput])[0]).toBe('alpha')
    expect((replaced[0] as [string, ServerSaveInput])[1].server.serverName).toBe('renamed')
    expect(mounted.host.querySelector('[data-mcp-server-detail="renamed"]')).not.toBeNull()
  })

  it('searches tools and reports a no-match state instead of an empty sync claim', async () => {
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        loadTools: async () => ({
          tools: [{ publicName: 'mcp__alpha__search', rawName: 'search', description: 'Search issues' }],
          truncated: false,
          total: 1,
        }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('tools.title'))!.click()
    await flush()
    const search = detail.querySelector<HTMLInputElement>('input[aria-label="' + t('server.toolsSearch') + '"]')!
    setValue(search, 'zzz')
    await flush()
    expect(detail.textContent).toContain(t('tools.noMatch'))
  })


  it('keeps a dismiss control reachable while a destructive write is pending', async () => {
    let release!: () => void
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true })
          }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    const dismiss = buttonByText(dialog(), t('action.dismiss'))
    expect(dismiss).not.toBeNull()
    expect(dismiss!.disabled).toBe(false)
    dismiss!.click()
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    release()
    await flush()
    expect(mounted.host.querySelector('[data-mcp-server-detail="alpha"]')).not.toBeNull()
    expect(mounted.text()).toContain(t('toast.removed', { name: 'alpha' }))
  })


  it('an older pending removal never closes a newer confirmation', async () => {
    let releaseAlpha!: () => void
    const mounted = mountSection(
      { servers: [stdioServer('alpha'), stdioServer('beta')], overrides: {} },
      {
        removeServer: (name) =>
          name === 'alpha'
            ? new Promise((resolve) => {
                releaseAlpha = () => resolve({ ok: true })
              })
            : Promise.resolve({ ok: true }),
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    let detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    buttonByText(dialog(), t('action.dismiss'))!.click()
    await flush()
    buttonByText(mounted.host, t('server.back'))!.click()
    await flush()
    detail = await openServer(mounted, 'beta')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('server.removeTitle', { name: 'beta' }))
    releaseAlpha()
    await flush()
    expect(dialog().textContent).toContain(t('server.removeTitle', { name: 'beta' }))
  })

  it('retries a failed removal with the same action', async () => {
    let attempts = 0
    let mounted!: Mounted
    mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: async () => {
          attempts += 1
          if (attempts === 1) return { ok: false, reason: 'save-failed' }
          mounted.live.doc = { servers: [], overrides: {}, disabled: {} }
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    expect(attempts).toBe(1)
    buttonByText(mounted.host, t('action.retry'))!.click()
    await flush()
    expect(attempts).toBe(2)
    expect(mounted.host.querySelector('[data-server="alpha"]')).toBeNull()
    expect(document.activeElement?.textContent ?? '').toContain(t('add.add'))
  })

  it('removes a server on a successful confirmation, closes the dialog and returns to the list', async () => {
    const calls: string[] = []
    const mounted = mountSection(
      { servers: [stdioServer('alpha')], overrides: {} },
      {
        removeServer: async (name) => {
          calls.push(name)
          return { ok: true }
        },
      },
      { wsItems: WS, runtime: runtimeWith('alpha') },
    )
    await flush()
    const detail = await openServer(mounted, 'alpha')
    buttonByText(detail, t('server.remove'))!.click()
    await flush()
    expect(dialog()).toBeDefined()
    buttonByText(dialog(), t('server.removeAction'))!.click()
    await flush()
    expect(calls).toEqual(['alpha'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(mounted.host.querySelector('[data-mcp-server-detail]')).toBeNull()
    expect(mounted.text()).toContain(t('toast.removed', { name: 'alpha' }))
  })

  it('guards unsaved changes with a discard confirmation', async () => {
    const mounted = mountSection({ servers: [], overrides: {} })
    await flush()
    buttonByText(mounted.host, t('add.add'))!.click()
    await flush()
    setValue(document.getElementById('mcp-scope-editor-name') as HTMLInputElement, 'draft')
    buttonByText(mounted.host, t('action.cancel'))!.click()
    await flush()
    expect(dialog().textContent).toContain(t('editor.discardTitle'))
    buttonByText(dialog(), t('dirty.keepEditing'))!.click()
    await flush()
    expect(mounted.host.querySelector('#mcp-scope-editor-name')).not.toBeNull()
  })
})

