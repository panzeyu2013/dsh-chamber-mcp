/** Shared action/mount helpers for the settings-section render suites. */
import { buttonsOf, flush, mountSection as mountShared, t, type Harness, type MountOptions } from './section-harness.tsx'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { McpScopeDoc } from '../../src/shared/model.ts'
import type { SaveOutcome, ServerSaveInput } from '../../src/client/controller.ts'
import type { RuntimeTestResult, RuntimeToolEntry } from '../../src/client/runtime.ts'

export interface Actions {
  addServer?(input: ServerSaveInput): Promise<SaveOutcome>
  replaceServer?(oldName: string, input: ServerSaveInput): Promise<SaveOutcome>
  removeServer?(name: string): Promise<SaveOutcome>
  toggleWorkspace?(workspaceId: string, serverName: string, enabled: boolean): Promise<SaveOutcome>
  toggleWorkspaces?(serverName: string, enabled: boolean, workspaceIds: readonly string[]): Promise<SaveOutcome>
  toggleWorkspaceServers?(workspaceId: string, serverNames: readonly string[], enabled: boolean): Promise<SaveOutcome>
  restoreScopeValues?(entries: readonly { workspaceId: string; serverName: string; enabled: boolean }[]): Promise<SaveOutcome>
  setServerEnabled?(serverName: string, enabled: boolean): Promise<SaveOutcome>
  unsetCredential?(ref: string): Promise<SaveOutcome>
  connectServer?(serverName: string): Promise<unknown>
  disconnectServer?(serverName: string): Promise<unknown>
  testServer?(serverName: string): Promise<RuntimeTestResult>
  loadTools?(serverName: string): Promise<{ tools: RuntimeToolEntry[]; truncated: boolean; total: number }>
  refreshRuntime?(options?: { silent?: boolean; server?: string }): Promise<void>
}

export const CONFLICT = async (): Promise<SaveOutcome> => ({ ok: false, reason: 'conflict' })

export type Mounted = Harness
type Patch = Partial<Omit<MountOptions, 'doc' | 'actions'>>

/** Positional doc/actions/patch shorthand over the shared options harness. */
export function mountSection(doc: McpScopeDoc, actions: Actions = {}, patch: Patch = {}): Mounted {
  return mountShared({
    doc,
    actions: actions as unknown as MountOptions['actions'],
    ...patch,
  })
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return buttonsOf(root).find((button) => (button.textContent ?? '').includes(text))
}

export function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function serverRow(mounted: Mounted, name: string): HTMLElement {
  const row = mounted.host.querySelector<HTMLElement>('[data-server="' + name + '"]')
  if (row === null) throw new Error('missing server row ' + name)
  return row
}

export async function openServer(mounted: Mounted, name: string): Promise<HTMLElement> {
  serverRow(mounted, name).querySelector('button')!.click()
  await flush()
  const detail = mounted.host.querySelector<HTMLElement>('[data-mcp-server-detail]')
  if (detail === null) throw new Error('missing detail for ' + name)
  return detail
}

export async function openWorkspacesTab(mounted: Mounted): Promise<void> {
  const tab = buttonsOf(mounted.host).find(
    (button) => button.getAttribute('role') === 'tab' && (button.textContent ?? '').includes(t('tab.workspaces')),
  )
  if (tab === undefined) throw new Error('missing workspaces tab')
  tab.click()
  await flush()
}

export function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('missing dialog')
  return element
}

export const view = (configured: boolean, writable = true): CredentialInfo => ({ configured, writable })

export const WS = [
  { workspaceId: 'ws-a', title: 'alpha', path: '/proj/alpha' },
  { workspaceId: 'ws-b', title: 'beta', path: '/proj/beta' },
  { workspaceId: 'ws-c', title: 'gamma', path: '/proj/gamma' },
]

export { buttonsOf, flush, httpServer, overridesOf, runtimeWith, stdioServer, t } from './section-harness.tsx'
