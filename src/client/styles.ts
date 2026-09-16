/**
 * Style seat of the mcp-scope settings surface.
 *
 * The browser half bundles to one CJS file whose runtime requires are limited
 * to `react` / `react/jsx-runtime` (the purity invariant: every `@deepseek-ai/*`
 * import is type-only), so this plugin cannot import the official CSS-module
 * bundles. What it CAN do — and what the official client plugins do — is ship
 * its own stylesheet as a string and append it to `document.head` once, under
 * the same `style[data-plugin][data-plugin-css]` tag convention the official
 * bundles use (see any upstream `lib/client.js`: the css text, a tag-id guard,
 * then a class-name map). `styles` below plays the role of that class-name map.
 *
 * Every rule mirrors the dsh design system this section is mounted into
 * (pinned generation: `packages/client/ui-theme`, `ui-primitives`,
 * `ui-settings-models`, `ui-settings-plugins`), so the page reads as part of
 * the settings panel rather than as a bolted-on page:
 *
 *   - section column: flex column / gap 12px / max-width 720px / label-primary
 *     (`ui-settings-models/ModelsSection.module.css` `.section`);
 *   - section title: 16px / line-height 24px / weight 500 (`ModelsSection`
 *     `.title`, the settings shell's `.navTitle`);
 *   - buttons: the `ui-primitives` Button capsule at `size="sm"` — 28px high,
 *     radius 14px, 12px/18px text, 0 10px padding — with the `outline`
 *     (0.5px border-l3 + transparent fill) and `primary`
 *     (button-info-fill / label-primary-foreground, the brand-blue control
 *     fill) palettes. The section
 *     header action is literally the official `settings.action` seat's
 *     `<Button variant="outline" size="sm">`;
 *   - cards: radius 14px + `elevation-stroke` + bg-layer-3, 12px/14px inset —
 *     the settings panel's 14px card recipe, where the hairline is drawn by the
 *     elevation stroke instead of a `border`, so the card never doubles an
 *     outline;
 *   - the staged add/edit form: the official editing-surface fill
 *     (bg-module-platform + radius 12px + 14px/16px padding;
 *     `ModelsSection` `.editor` / `.addCard`);
 *   - fields: label 13px/20px weight 500, input 34px high / radius 8px /
 *     0.5px border-l4 / bg-layer-1 / 13px text, focus border brand-primary,
 *     placeholder label-dimmed, disabled dimmed (`ui-settings-plugins`
 *     fields.module.css, `ModelsSection` `.input`);
 *   - credential tags and the transport choice: the `ui-primitives` Tag
 *     (999px pill, 11px/17px, `corner-shape: round`) and Pill
 *     (24px, radius 12px, ghost-active fill + inset ring when selected)
 *     geometries;
 *   - the per-workspace switch: the `ui-primitives` Switch geometry verbatim
 *     (36x20 track, radius 10px, 16px thumb, the accent when on) driven by
 *     the native checkbox's `:checked`, since this plugin owns a controlled
 *     input rather than the primitive;
 *   - notices: 12px/18px success text for the saved note, state-error text on
 *     the danger-tinted fill for failures (the chamber/upstream "risk" block).
 *
 * Colour, border, surface and type values resolve through `--dsw-alias-*` /
 * `--ds-*` tokens only — no literals anywhere, so light and dark both come
 * from the theme (the rule the chamber gates with S1–S7, see
 * `dsh-chamber/scripts/dev/verify-style-tokens.mjs`). This sheet declares no
 * custom properties of its own, so it cannot collide with a future token.
 *
 * Accent discipline: the deepseek blue is spent ONLY on interactive/selected
 * states — the switch-on track, focus rings, and the primary control fill —
 * through `--dsw-alias-state-business-primary` (deepseek-500 in light,
 * deepseek-400 in dark) and the control fill pair
 * `--dsw-alias-button-info-fill`/`-hover`. Normal state text, borders and
 * surfaces stay monochrome (`label-*`, `border-l*`). The alias was verified by
 * grepping the chamber's vendored theme
 * (`@deepseek-ai/dsh-client-ui-theme/lib/client.js`, which declares both
 * aliases over the `--dsw-static-deepseek-500/-450/-400/-600` primitives) and
 * the pinned `ui-primitives` sheets, which already read
 * `state-business-primary` for focus outlines; the concatenated alias the
 * vendored sheet also carries is deliberately not used.
 */

/**
 * Style-tag identity. The tag is keyed the way the official bundles key
 * theirs, so a second copy of this plugin (or an HMR re-apply) finds the
 * existing tag instead of stacking another stylesheet.
 */
export const STYLE_PLUGIN = 'dsh-chamber-mcp'
export const STYLE_TAG_ID = `${STYLE_PLUGIN}/client.styles.css`

/** Class names of {@link css}. One entry per rule the components use. */
export const styles = {
  section: 'mcpScope_section',
  head: 'mcpScope_head',
  title: 'mcpScope_title',
  spacer: 'mcpScope_spacer',
  focusRing: 'mcpScope_focusRing',
  button: 'mcpScope_button',
  buttonMd: 'mcpScope_buttonMd',
  buttonOutline: 'mcpScope_buttonOutline',
  buttonPrimary: 'mcpScope_buttonPrimary',
  buttonDanger: 'mcpScope_buttonDanger',
  linkButton: 'mcpScope_linkButton',
  iconButton: 'mcpScope_iconButton',
  hint: 'mcpScope_hint',
  empty: 'mcpScope_empty',
  noticeOk: 'mcpScope_noticeOk',
  noticeError: 'mcpScope_noticeError',
  noticeText: 'mcpScope_noticeText',
  staleBanner: 'mcpScope_staleBanner',
  staleText: 'mcpScope_staleText',
  list: 'mcpScope_list',
  card: 'mcpScope_card',
  cardDisabled: 'mcpScope_cardDisabled',
  cardHead: 'mcpScope_cardHead',
  cardName: 'mcpScope_cardName',
  cardMeta: 'mcpScope_cardMeta',
  cardActions: 'mcpScope_cardActions',
  cardRefresh: 'mcpScope_cardRefresh',
  cardRefreshBusy: 'mcpScope_cardRefreshBusy',
  // registered-tools notice (conversation lane, registered through
  // `conversation.chat.node`) — the shipped disclosure-row chrome
  injectionRoot: 'mcpScope_injectionRoot',
  injectionHead: 'mcpScope_injectionHead',
  injectionLeading: 'mcpScope_injectionLeading',
  injectionGlyphIdle: 'mcpScope_injectionGlyphIdle',
  injectionGlyphHover: 'mcpScope_injectionGlyphHover',
  injectionGlyphOpen: 'mcpScope_injectionGlyphOpen',
  injectionTitle: 'mcpScope_injectionTitle',
  injectionBody: 'mcpScope_injectionBody',
  injectionSummary: 'mcpScope_injectionSummary',
  injectionServer: 'mcpScope_injectionServer',
  injectionServerHead: 'mcpScope_injectionServerHead',
  injectionServerGlyph: 'mcpScope_injectionServerGlyph',
  injectionServerName: 'mcpScope_injectionServerName',
  injectionServerTools: 'mcpScope_injectionServerTools',
  injectionToolName: 'mcpScope_injectionToolName',
  injectionOmitted: 'mcpScope_injectionOmitted',
  tag: 'mcpScope_tag',
  code: 'mcpScope_code',
  badges: 'mcpScope_badges',
  badge: 'mcpScope_badge',
  badgeOk: 'mcpScope_badgeOk',
  badgeWarn: 'mcpScope_badgeWarn',
  badgeKey: 'mcpScope_badgeKey',
  badgeRef: 'mcpScope_badgeRef',
  confirm: 'mcpScope_confirm',
  confirmText: 'mcpScope_confirmText',
  confirmActions: 'mcpScope_confirmActions',
  dialog: 'mcpScope_dialog',
  toggleRow: 'mcpScope_toggleRow',
  toggleLabel: 'mcpScope_toggleLabel',
  statusRow: 'mcpScope_statusRow',
  statusDot: 'mcpScope_statusDot',
  statusDotOk: 'mcpScope_statusDotOk',
  statusDotWarn: 'mcpScope_statusDotWarn',
  statusDotError: 'mcpScope_statusDotError',
  statusText: 'mcpScope_statusText',
  statusErrorText: 'mcpScope_statusErrorText',
  toolList: 'mcpScope_toolList',
  toolItem: 'mcpScope_toolItem',
  toolName: 'mcpScope_toolName',
  wsBlock: 'mcpScope_wsBlock',
  wsList: 'mcpScope_wsList',
  wsRow: 'mcpScope_wsRow',
  wsLabel: 'mcpScope_wsLabel',
  wsState: 'mcpScope_wsState',
  switchBox: 'mcpScope_switchBox',
  switchInput: 'mcpScope_switchInput',
  switch: 'mcpScope_switch',
  switchThumb: 'mcpScope_switchThumb',
  form: 'mcpScope_form',
  formTitle: 'mcpScope_formTitle',
  field: 'mcpScope_field',
  fieldLabel: 'mcpScope_fieldLabel',
  input: 'mcpScope_input',
  textarea: 'mcpScope_textarea',
  inputInvalid: 'mcpScope_inputInvalid',
  fieldHint: 'mcpScope_fieldHint',
  fieldProblem: 'mcpScope_fieldProblem',
  choices: 'mcpScope_choices',
  choice: 'mcpScope_choice',
  choiceInput: 'mcpScope_choiceInput',
  choicePill: 'mcpScope_choicePill',
  rowsGroup: 'mcpScope_rowsGroup',
  row: 'mcpScope_row',
  rowInput: 'mcpScope_rowInput',
  problems: 'mcpScope_problems',
  formActions: 'mcpScope_formActions',
  // MCP tool row (transcript lane, registered through `tool.call.toolview`)
  toolCard: 'mcpScope_toolCard',
  toolHead: 'mcpScope_toolHead',
  toolLeading: 'mcpScope_toolLeading',
  toolGlyphIdle: 'mcpScope_toolGlyphIdle',
  toolGlyphHover: 'mcpScope_toolGlyphHover',
  toolDot: 'mcpScope_toolDot',
  toolSep: 'mcpScope_toolSep',
  toolVisuallyHidden: 'mcpScope_toolVisuallyHidden',
  toolTitle: 'mcpScope_toolTitle',
  toolTag: 'mcpScope_toolTag',
  toolDuration: 'mcpScope_toolDuration',
  toolSummary: 'mcpScope_toolSummary',
  toolSummaryError: 'mcpScope_toolSummaryError',
  toolBody: 'mcpScope_toolBody',
  toolLabel: 'mcpScope_toolLabel',
  toolCode: 'mcpScope_toolCode',
  toolCodeOutput: 'mcpScope_toolCodeOutput',
  toolEmpty: 'mcpScope_toolEmpty',
} as const

/** Join class names, dropping the falsy ones (`clsx`-lite, no dependency). */
export function cx(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ')
}

/**
 * The stylesheet, injected into the document by {@link mountStyles}.
 *
 * Editing hazard: this is a template literal, so the sheet must not contain a
 * backtick or a `${` — naming a declaration inside a CSS comment with
 * backticks breaks the literal and fails the typecheck. Quote declarations
 * with plain quotes instead.
 */
export const css = `
.mcpScope_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mcpScope_title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_spacer {
  flex: 1;
}

/* The card-header element receives focus after a save; keep the ring on the
   text rather than on a full-width box. */
.mcpScope_focusRing:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

/* ---- buttons (ui-primitives Button, size="sm": h28 / r14 / 12px) ---- */

.mcpScope_button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.mcpScope_button:disabled {
  opacity: 0.4;
  cursor: default;
}

.mcpScope_button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary);
}

/* The form footer's commit/dismiss pair is the full-size figma capsule
   (ui-primitives Button default: h36 / r18 / 14px), not the dense row
   capsule. */
.mcpScope_buttonMd {
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  font-size: 14px;
  line-height: 22px;
}

.mcpScope_buttonOutline {
  border: 0.5px solid var(--dsw-alias-border-l3);
}

.mcpScope_buttonOutline:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_buttonPrimary {
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

.mcpScope_buttonPrimary:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}

.mcpScope_buttonDanger {
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_buttonDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

/* Text-only affordance inside a tag (the official reset vocabulary). */
.mcpScope_linkButton {
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.mcpScope_linkButton:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}

.mcpScope_linkButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.mcpScope_linkButton:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
  border-radius: 4px;
}

.mcpScope_iconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.mcpScope_iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_iconButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.mcpScope_iconButton:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

/* ---- quiet copy ---- */

/* The anywhere overflow-wrap matters for the one interpolated value here — the
   working-directory line renders an arbitrary host path, which has no break
   opportunity and would otherwise push the card wider than the column. */
.mcpScope_hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.mcpScope_empty {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_noticeOk {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}

.mcpScope_noticeError {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 6px 8px 6px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}

.mcpScope_noticeText {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Stale-while-revalidate: the last good status stays readable behind one
   compact line. A normal (non-accent) surface — it is informational, not an
   interactive or selected state. */
.mcpScope_staleBanner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mcpScope_staleText {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ---- server cards ---- */

.mcpScope_list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mcpScope_card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-stroke);
  transition: background .16s;
}

.mcpScope_card:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* A globally disabled server keeps its card readable but visibly out of play. */
.mcpScope_cardDisabled {
  opacity: 0.6;
}

.mcpScope_cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mcpScope_cardName {
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_cardMeta {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_cardActions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* The card's own status refresh: a small icon control beside the row actions
   (the ink/geometry are the icon-button vocabulary, see .mcpScope_iconButton). */
.mcpScope_cardRefresh {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 11px;
}

.mcpScope_cardRefreshBusy {
  animation: mcpScope_spin 900ms linear infinite;
}

@keyframes mcpScope_spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- registered-tools notice (one disclosure row in the conversation lane) ----
   Chrome follows the shipped conversation rows rule for rule — the same 24px
   head with a 16px leading box (14px glyphs) and a 6px gap, the same 13px
   secondary title, the shipped 2x2 caption separator, and the same 141px
   code-block body the system-prompt and injected-context rows expand into.
   Only the glyph is this plugin's own mark: dsh ships no MCP icon. */

.mcpScope_injectionRoot {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}

.mcpScope_injectionRoot[data-open] {
  padding-bottom: 4px;
}

.mcpScope_injectionHead {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  /* Every shipped row scales with the content-font setting; the shipped rows
     add the same delta and defer to the same secondary size. */
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
  cursor: pointer;
}

.mcpScope_injectionHead:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_injectionLeading {
  position: relative;
  flex: none;
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_injectionLeading svg {
  width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px));
}

/* The open row shows the chevron in the shipped open-state colour (the hover
   swap and the closed glyph keep the tertiary leading colour). */
.mcpScope_injectionGlyphOpen {
  display: inline-flex;
  color: var(--dsw-alias-label-secondary);
}

/* Hover swap of the shipped rows: the glyph yields to the chevron; the open
   row shows the chevron outright (rendered by the component, not by CSS). */
.mcpScope_injectionGlyphIdle {
  display: inline-flex;
  transition: opacity 100ms ease;
}

.mcpScope_injectionGlyphHover {
  position: absolute;
  inset: 0;
  margin: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 100ms ease;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_injectionHead:hover .mcpScope_injectionGlyphIdle {
  opacity: 0;
}

.mcpScope_injectionHead:hover .mcpScope_injectionGlyphHover {
  opacity: 1;
}

.mcpScope_injectionTitle {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}

/* The shipped expanded-body chrome: one 141px scrollport of 11/16 monospace on
   the markdown code-block fill, indented to the title column. */
.mcpScope_injectionBody {
  box-sizing: border-box;
  width: calc(100% - 22px - var(--dsh-content-font-delta, 0px));
  max-height: 141px;
  margin: 4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px));
  padding: 10px 16px 12px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-tertiary);
  font: 400 11px/16px var(--ds-font-family-code);
  overflow: auto;
}

/* The expanded body leads with ONE line: every source and its count. */
.mcpScope_injectionSummary {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.mcpScope_injectionServer + .mcpScope_injectionServer {
  margin-top: 6px;
}

/* Each source is its own disclosure under that summary: a chevron that turns
   down when the source is open, its name and count, then (open only) that
   source's names, indented to the glyph. */
.mcpScope_injectionServerHead {
  display: flex;
  align-items: center;
  min-width: 0;
  cursor: pointer;
}

.mcpScope_injectionServerHead:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_injectionServerGlyph {
  display: inline-flex;
  flex: none;
  margin-right: 4px;
  color: var(--dsw-alias-label-caption);
  transform: rotate(-90deg);
  transition: transform 100ms ease;
}

.mcpScope_injectionServer[data-open] .mcpScope_injectionServerGlyph {
  transform: rotate(0deg);
}

.mcpScope_injectionServerName {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.mcpScope_injectionServerTools {
  padding-left: 18px;
}

.mcpScope_injectionToolName {
  overflow-wrap: anywhere;
}

.mcpScope_injectionOmitted {
  color: var(--dsw-alias-label-caption);
}

/* ---- transport tag (ui-primitives Tag, tone="outline") ---- */

.mcpScope_tag {
  display: inline-flex;
  align-items: center;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  corner-shape: round;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_code {
  display: block;
  margin: 0;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- credential refs (Tag pills, toned by the tri-state) ---- */

.mcpScope_badges {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Neither header names nor credential refs are length-capped by the document
   schema, so a pill must be able to shrink to the card instead of widening it:
   the wrap container caps the pill, and the two code parts (the only text
   without a floor) absorb the shrink and ellipsize — the state word and the
   Clear control keep their intrinsic width. Same guard upstream puts on its
   overlong badge cells. */
.mcpScope_badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  padding: 1px 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  corner-shape: round;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_badgeOk {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.mcpScope_badgeWarn {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

.mcpScope_badgeKey {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
}

/* The reference is real information (the header's env-style ref), not a
   placeholder, so it takes the secondary label tone: 'label-dimmed' is the
   disabled/placeholder step and would wash out on the light palette. */
.mcpScope_badgeRef {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
}

/* ---- remove confirmation (a nested, danger-tinted block) ---- */

.mcpScope_confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.mcpScope_confirmText {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_confirmText strong {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_confirmActions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---- import dialog (nested block inside the staged form) ---- */

.mcpScope_dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}

/* ---- enable toggle (Switch geometry in a labelled row) ---- */

.mcpScope_toggleRow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mcpScope_toggleLabel {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* ---- runtime status row (dot + phase + actions) ---- */

.mcpScope_statusRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mcpScope_statusDot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
}

.mcpScope_statusDotOk {
  background: var(--dsw-alias-state-success-primary);
}

.mcpScope_statusDotWarn {
  background: var(--dsw-alias-state-warn-primary);
}

.mcpScope_statusDotError {
  background: var(--dsw-alias-state-error-primary);
}

.mcpScope_statusText {
  /* The card is a 8px-gap flex column: a paragraph that keeps its UA margin
     doubles the rhythm around its own line (hint / empty / noticeOk reset it
     for the same reason). */
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_statusErrorText {
  /* The give-up / timeout / probe-failure line sits between two card rows: with
     the UA margin it opened ~20px above and below instead of the card's 8px
     gap, which read as an empty line. The gap owns the rhythm. */
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.mcpScope_toolList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcpScope_toolItem {
  overflow: hidden;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcpScope_toolName {
  color: var(--dsw-alias-label-primary);
}

/* ---- per-workspace rows ---- */

.mcpScope_wsBlock {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mcpScope_wsList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcpScope_wsRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mcpScope_wsLabel {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.mcpScope_wsState {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* ---- switch (ui-primitives Switch geometry over a native checkbox) ---- */

.mcpScope_switchBox {
  position: relative;
  flex: none;
  display: inline-flex;
}

.mcpScope_switchInput {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.mcpScope_switchInput:disabled {
  cursor: default;
}

.mcpScope_switch {
  box-sizing: border-box;
  display: block;
  width: 36px;
  height: 20px;
  padding: 2px;
  border-radius: 10px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  transition: background 120ms ease;
}

.mcpScope_switchInput:checked + .mcpScope_switch {
  background: var(--dsw-alias-state-business-primary);
}

.mcpScope_switchInput:focus-visible + .mcpScope_switch {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.mcpScope_switchInput:disabled + .mcpScope_switch {
  opacity: 0.5;
}

.mcpScope_switchThumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}

.mcpScope_switchInput:checked + .mcpScope_switch .mcpScope_switchThumb {
  transform: translateX(16px);
}

/* ---- staged add/edit form (the official editing-surface fill) ---- */

.mcpScope_form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform);
  animation: mcpScope_fadeIn var(--ds-transition-duration) var(--ds-ease-in-out);
}

@keyframes mcpScope_fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.mcpScope_formTitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcpScope_fieldLabel {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}

.mcpScope_input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.mcpScope_input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

.mcpScope_input:disabled {
  opacity: 0.5;
  cursor: default;
}

.mcpScope_textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 96px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
}

.mcpScope_textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.mcpScope_textarea:disabled {
  opacity: 0.5;
  cursor: default;
}

.mcpScope_inputInvalid {
  border-color: var(--dsw-alias-state-error-primary);
}

.mcpScope_fieldHint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_fieldProblem {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

/* ---- transport choice (ui-primitives Pill geometry over native radios) ---- */

.mcpScope_choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mcpScope_choice {
  position: relative;
  display: inline-flex;
}

.mcpScope_choiceInput {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.mcpScope_choiceInput:disabled {
  cursor: default;
}

/* The official interactive Pill answers the pointer; an unselected choice does
   too, while the selected one keeps its fill (the :not(:checked) guard is
   what keeps this rule from out-shouting the selected state). */
.mcpScope_choiceInput:hover:not(:disabled):not(:checked) + .mcpScope_choicePill {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_choicePill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  transition: background .16s, color .16s;
}

.mcpScope_choiceInput:checked + .mcpScope_choicePill {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}

.mcpScope_choiceInput:focus-visible + .mcpScope_choicePill {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.mcpScope_choiceInput:disabled + .mcpScope_choicePill {
  opacity: 0.4;
}

/* ---- repeatable rows (args, env keys, headers) ---- */

.mcpScope_rowsGroup {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcpScope_row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mcpScope_rowInput {
  flex: 1 1 120px;
  min-width: 0;
}

.mcpScope_problems {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_formActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

/* ---------------------------------------------------------------------------
   MCP tool row (transcript lane). Chrome mirrors the shipped tool rows rule for
   rule where the shipped rows define one: a 24px row with a 16px leading box
   (glyphs at 14px), a 6px gap, a 13px/24px title in the secondary label colour
   and a 14px/24px tertiary summary that ellipsizes. Terminal states follow the
   shipped convention too — the leading slot yields to a status dot (error red,
   interrupted amber), which is why the title itself carries no state colour.
   Running and settled rows differ on purpose: the running row carries the
   shipped sweep and a primary title, the settled row drops the animation and
   shows its duration.
   --------------------------------------------------------------------------- */

.mcpScope_toolCard {
  display: flex;
  flex-direction: column;
  margin: 2px 0;
}

.mcpScope_toolHead {
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px 0 0;
  border-radius: 8px;
  cursor: default;
  position: relative;
  overflow: hidden;
  display: flex;
}

.mcpScope_toolHead[role='button'] {
  cursor: pointer;
}

.mcpScope_toolHead[role='button']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_toolHead:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_toolHead[data-state='running']::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 300px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);
  animation: mcpScope_toolSweep 2.6s ease-out infinite;
}

@keyframes mcpScope_toolSweep {
  0% {
    left: -300px;
  }

  90%, to {
    left: 100%;
  }
}

.mcpScope_toolLeading {
  width: 16px;
  height: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
  display: inline-flex;
  position: relative;
  color: var(--dsw-alias-label-tertiary);
}

/* Running keeps the glyph — the sweep carries the in-flight signal. */
.mcpScope_toolHead[data-state='running'] .mcpScope_toolLeading {
  color: var(--dsw-alias-label-secondary);
}

/* Hover swap of the shipped rows: the glyph yields to the chevron; the open
   row shows the chevron outright (rendered by the component, not by CSS). */
.mcpScope_toolGlyphIdle {
  display: inline-flex;
  transition: opacity 100ms ease;
}

.mcpScope_toolGlyphHover {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transition: opacity 100ms ease;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_toolHead[data-open] .mcpScope_toolLeading {
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_toolHead[role='button']:hover .mcpScope_toolGlyphIdle {
  opacity: 0;
}

.mcpScope_toolHead[role='button']:hover .mcpScope_toolGlyphHover {
  opacity: 1;
}

/* Run-state word for assistive technology (the shipped rule verbatim): the dot
   and the sweep are colour-only, so the state needs text. The row keeps its own
   visible text as the accessible name — the hidden word only appends to it. */
.mcpScope_toolVisuallyHidden {
  clip: rect(0 0 0 0);
  white-space: nowrap;
  width: 1px;
  height: 1px;
  position: absolute;
  overflow: hidden;
}

/* Title/summary separator: the shipped row's 2x2 caption dot (its own rule
   verbatim, down to the 8px side margins). */
.mcpScope_toolSep {
  background: var(--dsw-alias-label-caption);
  border-radius: 1px;
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
}

/* Terminal-state mark (the shipped StateDot geometry): a 10% halo under a
   solid core at 60% scale, coloured by the state token. */
.mcpScope_toolDot {
  position: relative;
  display: inline-block;
  flex: none;
  width: 10px;
  height: 10px;
}

.mcpScope_toolDot::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
  opacity: 0.1;
}

.mcpScope_toolDot::after {
  content: '';
  position: absolute;
  inset: 20%;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
}

.mcpScope_toolDot[data-state='warning'] {
  color: var(--dsw-alias-state-warn-primary);
}

.mcpScope_toolDot[data-state='error'] {
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_toolTitle {
  /* The shipped row's title metrics: the pinned theme declares both
     --dsh-content-font tokens, so the row follows the Settings font-size axis;
     the fallbacks are the shipped defaults. */
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  flex: none;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

.mcpScope_toolHead[data-state='running'] .mcpScope_toolTitle {
  color: var(--dsw-alias-label-primary);
}

.mcpScope_toolTag {
  font-size: 11px;
  line-height: 16px;
  flex: none;
  margin-left: 6px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary);
}

/* The duration is the shipped row's summarySuffix (same size, line box and
   colour), plus tabular figures so successive rows align. */
.mcpScope_toolDuration {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  flex: none;
  margin-left: 4px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

.mcpScope_toolSummary {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
  flex: auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_toolSummaryError {
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_toolBody {
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 4px 8px;
  padding-left: 12px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
}

.mcpScope_toolLabel {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_toolCode {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  margin: 0;
  padding: 8px 10px;
  max-height: 160px;
  overflow: auto;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.mcpScope_toolCodeOutput {
  max-height: 240px;
}

.mcpScope_toolCode[data-error] {
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_toolEmpty {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-dimmed);
}

@media (prefers-reduced-motion: reduce) {
  .mcpScope_card,
  .mcpScope_switch,
  .mcpScope_switchThumb,
  .mcpScope_choicePill {
    transition: none;
  }

  .mcpScope_form,
  .mcpScope_cardRefreshBusy {
    animation: none;
  }

  .mcpScope_toolHead[data-state='running']::after {
    animation: none;
  }

  .mcpScope_toolGlyphIdle,
  .mcpScope_toolGlyphHover {
    transition: none;
  }
}
`

/**
 * Append this plugin's stylesheet to the document, once per live owner.
 *
 * Mirrors the official bundles' guard-and-append (the tag is looked up by its
 * `data-plugin-css` id, so a re-apply reuses the tag instead of stacking
 * another stylesheet) and adds the two things a bare guard gets wrong:
 *
 * - **refresh**: a tag left by an earlier revision is re-filled with the
 *   current sheet, so an HMR cycle that applies before disposing still paints
 *   the new styles instead of the ones the tag was born with;
 * - **ownership count**: the number of live mounts is kept ON THE TAG, so a
 *   second copy of this plugin in the same document (the chamber shell can
 *   host more than one instance per page) shares one stylesheet with the
 *   first, and whichever of them unloads first cannot strip the sheet out
 *   from under the other. The tag is removed by the LAST disposer.
 * @returns disposer releasing this mount's claim (no-op without a document).
 */
export function mountStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`
  const existing = document.querySelector<HTMLStyleElement>(selector)
  const tag = existing ?? document.createElement('style')
  if (existing === null) {
    tag.dataset.plugin = STYLE_PLUGIN
    tag.dataset.pluginCss = STYLE_TAG_ID
    tag.textContent = css
    document.head.appendChild(tag)
  } else if (tag.textContent !== css) {
    tag.textContent = css
  }
  tag.dataset.refs = String(Number(tag.dataset.refs ?? '0') + 1)
  return () => {
    const left = Number(tag.dataset.refs ?? '1') - 1
    if (left > 0) {
      tag.dataset.refs = String(left)
      return
    }
    delete tag.dataset.refs
    tag.remove()
  }
}