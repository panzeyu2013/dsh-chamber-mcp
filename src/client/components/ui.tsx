/**
 * Local, dependency-free primitives shared by every settings view.
 *
 * The client bundle may require only react (the official platform table and
 * this repo's purity gate), so the primitives are hand-built over the design token classes in
 * `../styles.ts` instead of importing ui-primitives. Geometry matches the
 * shipped widgets: Switch, status pills, inline notices, section headers,
 * tabs and the accessible modal/confirm dialog.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { cx, styles } from '../styles.js'

/* ------------------------------------------------------------------ switch */

export interface SwitchControlProps {
  id?: string
  checked: boolean
  disabled?: boolean
  pending?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  onChange(next: boolean): void
}

/**
 * The Switch primitive's geometry over a real checkbox. The decoration is
 * pointer-events:none (see styles.ts); the input fills the 44x28 hit box.
 */
export function SwitchControl(props: SwitchControlProps): JSX.Element {
  const generated = useId()
  const id = props.id ?? 'mcp-scope-switch' + generated
  return (
    <span className={styles.switchBox} data-pending={props.pending === true || undefined}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={styles.switchInput}
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy}
        aria-describedby={props.ariaDescribedBy}
        aria-busy={props.pending === true || undefined}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className={styles.switch} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
    </span>
  )
}

/* ------------------------------------------------------------- status pill */

export type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

export interface StatusBadgeProps {
  tone: StatusTone
  label: string
}

/** Dot + text: colour is never the only carrier of the state. */
export function StatusBadge(props: StatusBadgeProps): JSX.Element {
  return (
    <span className={cx(styles.statusPill, toneClass(props.tone))}>
      <span className={styles.statusPillDot} aria-hidden="true" />
      <span>{props.label}</span>
    </span>
  )
}

function toneClass(tone: StatusTone): string {
  switch (tone) {
    case 'ok':
      return styles.statusPillOk
    case 'warn':
      return styles.statusPillWarn
    case 'error':
      return styles.statusPillError
    default:
      return styles.statusPillIdle
  }
}

/* ----------------------------------------------------------- inline notice */

export type NoticeTone = 'info' | 'success' | 'warn' | 'error'

export interface InlineNoticeProps {
  tone: NoticeTone
  children: ReactNode
  action?: ReactNode
  onDismiss?(): void
  dismissLabel?: string
}

export function InlineNotice(props: InlineNoticeProps): JSX.Element {
  const role = props.tone === 'error' || props.tone === 'warn' ? 'alert' : 'status'
  return (
    <div role={role} className={cx(styles.inlineNotice, noticeClass(props.tone))}>
      <span className={styles.inlineNoticeMark} aria-hidden="true" />
      <div className={styles.inlineNoticeBody}>{props.children}</div>
      {props.action !== undefined && <div className={styles.inlineNoticeActions}>{props.action}</div>}
      {props.onDismiss !== undefined && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={props.dismissLabel}
          onClick={props.onDismiss}
        >
          ×
        </button>
      )}
    </div>
  )
}

function noticeClass(tone: NoticeTone): string {
  switch (tone) {
    case 'success':
      return styles.inlineNoticeSuccess
    case 'warn':
      return styles.inlineNoticeWarn
    case 'error':
      return styles.inlineNoticeError
    default:
      return styles.inlineNoticeInfo
  }
}

/* --------------------------------------------------------------- empty state */

export interface EmptyStateProps {
  title: string
  body?: string
  actions?: ReactNode
  compact?: boolean
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div className={cx(styles.emptyState, props.compact === true && styles.emptyStateCompact)}>
      <p className={styles.emptyTitle}>{props.title}</p>
      {props.body !== undefined && <p className={styles.emptyBody}>{props.body}</p>}
      {props.actions !== undefined && <div className={styles.emptyActions}>{props.actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------ section block */

export interface SectionBlockProps {
  title: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
  tone?: 'default' | 'danger'
}

export function SectionBlock(props: SectionBlockProps): JSX.Element {
  const titleId = useId()
  return (
    <section
      className={cx(styles.detailSection, props.tone === 'danger' && styles.detailSectionDanger)}
      aria-labelledby={titleId}
    >
      <div className={styles.detailSectionHead}>
        <div className={styles.detailSectionHeading}>
          <h3 id={titleId} className={styles.detailSectionTitle}>
            {props.title}
          </h3>
          {props.hint !== undefined && <p className={styles.detailSectionHint}>{props.hint}</p>}
        </div>
        {props.actions !== undefined && <div className={styles.detailSectionActions}>{props.actions}</div>}
      </div>
      {props.children}
    </section>
  )
}

/* --------------------------------------------------------------------- tabs */

export interface TabItem {
  id: string
  label: string
  count?: number
}

export interface TabsProps {
  ariaLabel: string
  items: readonly TabItem[]
  active: string
  onSelect(id: string): void
}

export function Tabs(props: TabsProps): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = (index + delta + props.items.length) % props.items.length
    buttons.current[next]?.focus()
    props.onSelect(props.items[next]!.id)
  }
  return (
    <div role="tablist" aria-label={props.ariaLabel} className={styles.tabs}>
      {props.items.map((item, index) => {
        const selected = item.id === props.active
        return (
          <button
            key={item.id}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="tab"
            id={'mcp-scope-tab-' + item.id}
            aria-selected={selected}
            aria-controls={'mcp-scope-panel-' + item.id}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.tab, selected && styles.tabActive)}
            onKeyDown={(event) => move(event, index)}
            onClick={() => props.onSelect(item.id)}
          >
            <span>{item.label}</span>
            {item.count !== undefined && <span className={styles.tabCount}>{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------- modal */

export interface ModalProps {
  open: boolean
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose(): void
  closeLabel: string
  wide?: boolean
  pending?: boolean
}

/**
 * Accessible modal rendered INLINE (the purity invariant forbids react-dom's
 * portal API): fixed-position backdrop, Escape closes (while not pending),
 * focus moves in and returns to the trigger, Tab is trapped, backdrop clicks
 * cancel. The settings shell is already a modal, so the dialog is intentionally
 * light (one surface, no second overlay).
 */
export function Modal(props: ModalProps): JSX.Element | null {
  const titleId = useId()
  const surface = useRef<HTMLDivElement | null>(null)
  const restore = useRef<HTMLElement | null>(null)
  const closeRef = useRef(props.onClose)
  const pendingRef = useRef(props.pending === true)
  closeRef.current = props.onClose
  pendingRef.current = props.pending === true

  useEffect(() => {
    if (!props.open) return undefined
    restore.current = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
    const node = surface.current
    // jsdom has no layout (offsetParent is always null), so visibility is
    // approximated by the hidden attribute; the dialog only contains the
    // controls it actually renders.
    const focusables = (): HTMLElement[] => {
      if (node === null) return []
      return Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('hidden'))
    }
    const first = focusables().find((element) => element.hasAttribute('data-autofocus')) ?? focusables()[0]
    ;(first ?? surface.current)?.focus()
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !pendingRef.current) {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) {
        // Pending confirmation disables every action: keep focus on the
        // dialog surface instead of letting Tab walk the background form.
        event.preventDefault()
        surface.current?.focus()
        return
      }
      const firstElement = list[0]!
      const lastElement = list[list.length - 1]!
      // A disabled control can remain document.activeElement (a pending
      // confirmation disables Confirm). Recover whenever focus is not on a
      // currently focusable element, not merely outside the surface.
      if (surface.current !== null && !list.includes(document.activeElement as HTMLElement)) {
        event.preventDefault()
        firstElement.focus()
        return
      }
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      restore.current?.focus?.()
    }
  }, [props.open])

  if (!props.open || typeof document === 'undefined') return null
  return (
    <div
      className={styles.modalBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && props.pending !== true) props.onClose()
      }}
    >
      <div
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={props.pending === true}
        tabIndex={-1}
        className={cx(styles.modal, props.wide === true && styles.modalWide)}
      >
        <div className={styles.modalHead}>
          <h2 id={titleId} className={styles.modalTitle}>
            {props.title}
          </h2>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={props.closeLabel}
            disabled={props.pending === true}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>{props.children}</div>
        {props.actions !== undefined && <div className={styles.modalActions}>{props.actions}</div>}
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel: string
  closeLabel: string
  danger?: boolean
  pending?: boolean
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null {
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      closeLabel={props.closeLabel}
      pending={props.pending}
      actions={
        <>
          <button
            type="button"
            className={cx(styles.button, styles.buttonOutline)}
            data-autofocus
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            type="button"
            className={cx(
              styles.button,
              props.danger === true ? styles.buttonPrimaryDanger : styles.buttonPrimary,
            )}
            disabled={props.pending === true}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className={styles.confirmBody}>{props.body}</div>
    </Modal>
  )
}

/* --------------------------------------------------------------- small bits */

/** A button that copies text and reports the outcome locally. */
export interface CopyButtonProps {
  text: string
  label: string
  copiedLabel: string
  failedLabel: string
  className?: string
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )
  const { text } = props
  const copy = useCallback(async (): Promise<void> => {
    let ok = false
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    setState(ok ? 'ok' : 'fail')
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 4000)
  }, [text])
  const label = state === 'ok' ? props.copiedLabel : state === 'fail' ? props.failedLabel : props.label
  return (
    <button
      type="button"
      className={props.className ?? cx(styles.button, styles.buttonOutline)}
      onClick={() => void copy()}
    >
      {label}
    </button>
  )
}
