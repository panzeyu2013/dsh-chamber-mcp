// @vitest-environment jsdom
// The settings shell owns the nav row glyph (a map by section id, gear
// fallback) and offers no icon seat, so the plugin patches ITS OWN row: paint
// the plug mark into the row whose label is ours, accept nothing but the
// shell's row shape, stay idempotent, and never throw. These tests drive the
// real DOM helper against a document shaped like the shell's nav.
import { beforeEach, describe, expect, it } from 'vitest'
import { mountNavGlyph, paintNavGlyph } from '../../src/client/nav-icon.ts'
import { MCP_PLUG_PATHS } from '../../src/client/tool-card/icon.tsx'

const LABEL = 'MCP 服务器'
const OTHER = '模型'

/** One shell-shaped nav row: <button><svg class=hash/><span>label</span></button>. */
function navRow(label: string, options: { children?: number; glyphFirst?: boolean } = {}) {
  const button = document.createElement('button')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('class', 'Shell_navIcon__abc')
  const span = document.createElement('span')
  span.textContent = label
  if (options.glyphFirst === false) button.append(span, svg)
  else button.append(svg, span)
  for (let extra = (options.children ?? 2) - 2; extra > 0; extra -= 1) button.append(document.createElement('i'))
  document.body.append(button)
  return { button, svg, span }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => {
  document.body.replaceChildren()
})

describe('paintNavGlyph', () => {
  it('paints the plug into our row and leaves every other row alone', () => {
    const ours = navRow(LABEL)
    const theirs = navRow(OTHER)
    expect(paintNavGlyph(document, LABEL)).toBe(1)
    const glyph = ours.button.firstElementChild as Element
    expect(glyph.getAttribute('data-mcp-scope-nav-glyph')).toBe('1')
    expect(glyph.getAttribute('viewBox')).toBe('0 0 24 24')
    // The shell's own class rides along: sizing and colour stay shell-owned.
    expect(glyph.getAttribute('class')).toBe('Shell_navIcon__abc')
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.querySelectorAll('path').length).toBe(MCP_PLUG_PATHS.length)
    expect(glyph.querySelector('path')?.getAttribute('d')).toBe(MCP_PLUG_PATHS[0])
    // The section label is untouched, and the neighbour keeps the shipped glyph.
    expect(ours.span.textContent).toBe(LABEL)
    expect(theirs.button.firstElementChild).toBe(theirs.svg)
  })

  it('is idempotent', () => {
    navRow(LABEL)
    expect(paintNavGlyph(document, LABEL)).toBe(1)
    const painted = document.querySelector('[data-mcp-scope-nav-glyph]')
    expect(paintNavGlyph(document, LABEL)).toBe(0)
    expect(document.querySelectorAll('[data-mcp-scope-nav-glyph]').length).toBe(1)
    expect(document.querySelector('[data-mcp-scope-nav-glyph]')).toBe(painted)
  })

  it('accepts nothing but the shell row shape, and never throws', () => {
    // A span with our text that is not a nav row: free-standing, in a div, in a
    // button with three children, or with the glyph after the label.
    const loose = document.createElement('span')
    loose.textContent = LABEL
    document.body.append(loose)
    const wrapper = document.createElement('div')
    const wrapped = document.createElement('span')
    wrapped.textContent = LABEL
    wrapper.append(wrapped)
    document.body.append(wrapper)
    navRow(LABEL, { children: 3 })
    navRow(LABEL, { glyphFirst: false })
    expect(paintNavGlyph(document, LABEL)).toBe(0)
    expect(paintNavGlyph(document, '')).toBe(0)
    expect(document.querySelectorAll('[data-mcp-scope-nav-glyph]').length).toBe(0)
  })
})

describe('mountNavGlyph', () => {
  it('paints after the panel renders, repaints after a re-render, and stops on dispose', async () => {
    const dispose = mountNavGlyph({ label: () => LABEL })
    try {
      // The panel opens after mount: a click is what triggers the scan.
      const ours = navRow(LABEL)
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await tick()
      expect(ours.button.firstElementChild?.getAttribute('data-mcp-scope-nav-glyph')).toBe('1')

      // The shell re-renders the row (React owns it) and restores its glyph.
      const restored = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      restored.setAttribute('viewBox', '0 0 16 16')
      ours.button.firstElementChild?.replaceWith(restored)
      await tick()
      expect(ours.button.firstElementChild?.getAttribute('data-mcp-scope-nav-glyph')).toBe('1')
    } finally {
      dispose()
    }

    // Disposed: a new panel open is not patched any more.
    const after = navRow(LABEL)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(after.button.firstElementChild?.getAttribute('data-mcp-scope-nav-glyph')).toBeNull()
  })

  it('repaints on the change feed (locale flip) and survives an absent document', async () => {
    let notify: (() => void) | undefined
    const dispose = mountNavGlyph({
      label: () => LABEL,
      subscribe: (onChange) => {
        notify = onChange
        return () => {
          notify = undefined
        }
      },
    })
    try {
      const ours = navRow(LABEL)
      notify?.()
      await tick()
      expect(ours.button.firstElementChild?.getAttribute('data-mcp-scope-nav-glyph')).toBe('1')
    } finally {
      dispose()
    }
    expect(notify).toBeUndefined()
    // A composition without a document is a silent no-op.
    expect(() => mountNavGlyph({ label: () => LABEL, doc: undefined })).not.toThrow()
  })
})
