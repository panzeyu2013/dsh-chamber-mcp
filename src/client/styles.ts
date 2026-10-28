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
 *   - server rows: radius 12px + `elevation-stroke` + bg-layer-3, 10px/12px
 *     inset — the settings panel's row recipe, where the hairline is drawn by
 *     the elevation stroke instead of a `border`, so the row never doubles an
 *     outline;
 *   - the detail sections and the add/edit editor: hairline separators for the
 *     former, the official editing-surface fill (bg-module-platform + radius
 *     12px + 14px/16px padding) for the latter (`ModelsSection` `.editor`);
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
 *   - notices: 12px/18px inline strips (info/success/warn/error) with a mark,
 *     a persistent body and an action slot; success also rides a transient
 *     toast. Failures never auto-retire.
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
  button: 'mcpScope_button',
  buttonMd: 'mcpScope_buttonMd',
  buttonOutline: 'mcpScope_buttonOutline',
  buttonPrimary: 'mcpScope_buttonPrimary',
  buttonDanger: 'mcpScope_buttonDanger',
  iconButton: 'mcpScope_iconButton',
  hint: 'mcpScope_hint',
  empty: 'mcpScope_empty',
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
  toolList: 'mcpScope_toolList',
  switchBox: 'mcpScope_switchBox',
  switchInput: 'mcpScope_switchInput',
  switch: 'mcpScope_switch',
  switchThumb: 'mcpScope_switchThumb',
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
  // settings shell (Phase 0-4 information architecture)
  subtitle: 'mcpScope_subtitle',
  summary: 'mcpScope_summary',
  headActions: 'mcpScope_headActions',
  searchToolbar: 'mcpScope_searchToolbar',
  searchField: 'mcpScope_searchField',
  searchInput: 'mcpScope_searchInput',
  filterChips: 'mcpScope_filterChips',
  filterChip: 'mcpScope_filterChip',
  filterChipActive: 'mcpScope_filterChipActive',
  serverList: 'mcpScope_serverList',
  serverRow: 'mcpScope_serverRow',
  serverRowButton: 'mcpScope_serverRowButton',
  serverRowTop: 'mcpScope_serverRowTop',
  serverRowName: 'mcpScope_serverRowName',
  serverRowTags: 'mcpScope_serverRowTags',
  serverRowMeta: 'mcpScope_serverRowMeta',
  serverRowStats: 'mcpScope_serverRowStats',
  serverRowChevron: 'mcpScope_serverRowChevron',
  serverRowUnused: 'mcpScope_serverRowUnused',
  scopeText: 'mcpScope_scopeText',
  detail: 'mcpScope_detail',
  detailBack: 'mcpScope_detailBack',
  detailHead: 'mcpScope_detailHead',
  detailTitleGroup: 'mcpScope_detailTitleGroup',
  detailTitle: 'mcpScope_detailTitle',
  detailSub: 'mcpScope_detailSub',
  detailActions: 'mcpScope_detailActions',
  detailBody: 'mcpScope_detailBody',
  detailStatusRow: 'mcpScope_detailStatusRow',
  scopeGrid: 'mcpScope_scopeGrid',
  scopeRow: 'mcpScope_scopeRow',
  scopeName: 'mcpScope_scopeName',
  scopePath: 'mcpScope_scopePath',
  toolPanel: 'mcpScope_toolPanel',
  toolDisclosure: 'mcpScope_toolDisclosure',
  toolBody2: 'mcpScope_toolBody2',
  toolSearchRow: 'mcpScope_toolSearchRow',
  toolRow: 'mcpScope_toolRow',
  toolRowName: 'mcpScope_toolRowName',
  toolRowDesc: 'mcpScope_toolRowDesc',
  toolTruncate: 'mcpScope_toolTruncate',
  configGrid: 'mcpScope_configGrid',
  configItem: 'mcpScope_configItem',
  configLabel: 'mcpScope_configLabel',
  configValue: 'mcpScope_configValue',
  credentialList: 'mcpScope_credentialList',
  credentialRow: 'mcpScope_credentialRow',
  credentialMain: 'mcpScope_credentialMain',
  credentialName: 'mcpScope_credentialName',
  credentialState: 'mcpScope_credentialState',
  credentialActions: 'mcpScope_credentialActions',
  credentialShared: 'mcpScope_credentialShared',
  availabilityRow: 'mcpScope_availabilityRow',
  availabilityBody: 'mcpScope_availabilityBody',
  availabilityHint: 'mcpScope_availabilityHint',
  dangerZone: 'mcpScope_dangerZone',
  dangerHint: 'mcpScope_dangerHint',
  dangerActions: 'mcpScope_dangerActions',
  editor: 'mcpScope_editor',
  editorHead: 'mcpScope_editorHead',
  editorTitle: 'mcpScope_editorTitle',
  editorSub: 'mcpScope_editorSub',
  editorSource: 'mcpScope_editorSource',
  editorGrid: 'mcpScope_editorGrid',
  editorField: 'mcpScope_editorField',
  editorSection: 'mcpScope_editorSection',
  editorSectionTitle: 'mcpScope_editorSectionTitle',
  editorAdvanced: 'mcpScope_editorAdvanced',
  editorAdvancedBody: 'mcpScope_editorAdvancedBody',
  editorFooter: 'mcpScope_editorFooter',
  editorFooterHint: 'mcpScope_editorFooterHint',
  editorErrorSummary: 'mcpScope_editorErrorSummary',
  editorErrorTitle: 'mcpScope_editorErrorTitle',
  editorErrorList: 'mcpScope_editorErrorList',
  editorErrorLink: 'mcpScope_editorErrorLink',
  secretInputWrap: 'mcpScope_secretInputWrap',
  revealButton: 'mcpScope_revealButton',
  rowRemove: 'mcpScope_rowRemove',
  keyValueRow: 'mcpScope_keyValueRow',
  keyValueCell: 'mcpScope_keyValueCell',
  editorNote: 'mcpScope_editorNote',
  candidateList: 'mcpScope_candidateList',
  toast: 'mcpScope_toast',
  toastText: 'mcpScope_toastText',
  toastAction: 'mcpScope_toastAction',
  toastClose: 'mcpScope_toastClose',
  statusPill: 'mcpScope_statusPill',
  statusPillOk: 'mcpScope_statusPillOk',
  statusPillWarn: 'mcpScope_statusPillWarn',
  statusPillError: 'mcpScope_statusPillError',
  statusPillIdle: 'mcpScope_statusPillIdle',
  statusPillDot: 'mcpScope_statusPillDot',
  inlineNotice: 'mcpScope_inlineNotice',
  inlineNoticeInfo: 'mcpScope_inlineNoticeInfo',
  inlineNoticeSuccess: 'mcpScope_inlineNoticeSuccess',
  inlineNoticeWarn: 'mcpScope_inlineNoticeWarn',
  inlineNoticeError: 'mcpScope_inlineNoticeError',
  inlineNoticeMark: 'mcpScope_inlineNoticeMark',
  inlineNoticeBody: 'mcpScope_inlineNoticeBody',
  inlineNoticeActions: 'mcpScope_inlineNoticeActions',
  emptyState: 'mcpScope_emptyState',
  emptyStateCompact: 'mcpScope_emptyStateCompact',
  emptyTitle: 'mcpScope_emptyTitle',
  emptyBody: 'mcpScope_emptyBody',
  emptyActions: 'mcpScope_emptyActions',
  detailSection: 'mcpScope_detailSection',
  detailSectionDanger: 'mcpScope_detailSectionDanger',
  detailSectionHead: 'mcpScope_detailSectionHead',
  detailSectionHeading: 'mcpScope_detailSectionHeading',
  detailSectionTitle: 'mcpScope_detailSectionTitle',
  detailSectionHint: 'mcpScope_detailSectionHint',
  detailSectionActions: 'mcpScope_detailSectionActions',
  tabs: 'mcpScope_tabs',
  tab: 'mcpScope_tab',
  tabActive: 'mcpScope_tabActive',
  tabCount: 'mcpScope_tabCount',
  modalBackdrop: 'mcpScope_modalBackdrop',
  modal: 'mcpScope_modal',
  modalWide: 'mcpScope_modalWide',
  modalHead: 'mcpScope_modalHead',
  modalTitle: 'mcpScope_modalTitle',
  modalBody: 'mcpScope_modalBody',
  modalActions: 'mcpScope_modalActions',
  buttonPrimaryDanger: 'mcpScope_buttonPrimaryDanger',
  confirmBody: 'mcpScope_confirmBody',
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
   opportunity and would otherwise push the column wider. */
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

.mcpScope_toolList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 280px;
  overflow: auto;
}

/* ---- switch (ui-primitives Switch geometry over a native checkbox) ---- */

/* The native checkbox fills this box, so the box IS the hit area: the slop
   below grows it to 44x28 around the unchanged 36x20 track, and the negative
   margin cancels the padding in layout (nothing moves, only the target does).
   The detail scope rows, workspace rows and the editor use it. */
/* Hit box = track + 4px on every side (36x20 -> 44x28), laid out at the track's
   own 20px via the cancelling margin. INVARIANT for every container of a switch:
   it must be at least 28px tall, or the slop leaves the container and the
   absolutely positioned inputs of two neighbours overlap — the later one paints
   on top and steals the band. Containers that WRAP need a row-gap above 4px for
   the same reason. */
.mcpScope_switchBox {
  position: relative;
  flex: none;
  display: inline-flex;
  padding: 4px;
  margin: -4px;
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

/* Optimistic writes keep the switch interactive but visibly in flight. */
.mcpScope_switchBox[data-pending] .mcpScope_switch {
  opacity: 0.6;
}

/* The track and its thumb are DECORATION: the hit target is the absolutely
   positioned input above. pointer-events: none is load-bearing, not polish —
   the ON-state thumb carries a transform (see the :checked rule below), which
   makes it a stacking context painted in the positioned layer, and it follows
   the input in DOM order, so a hit test over the knob lands on the thumb instead
   of the input and the click goes nowhere. Measured in a real browser:
   elementFromPoint at the knob's centre returned the thumb while checked, and a
   real click there left the checkbox unchanged; this line restores it. */
.mcpScope_switch {
  box-sizing: border-box;
  display: block;
  pointer-events: none;
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
  /* 2px offset + the ring's own 2px puts its OUTER edge exactly on the hit box
     (36+4+4 by 20+4+4), so what the keyboard shows is what the pointer hits. */
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

/* ===========================================================================
   Phase 0-4 settings surface: list, detail, workspaces, editor and dialogs.
   Token-only declarations. The legacy card/form rules were removed with the
   components; the transcript-lane rules stay above and are shared by design.
   =========================================================================== */

.mcpScope_subtitle {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_summary {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_headActions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* ---- tabs (compact segmented control) ---- */

.mcpScope_tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  align-self: flex-start;
}

.mcpScope_tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.mcpScope_tab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_tab:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_tabActive {
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_tabCount {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ---- list toolbar ---- */

.mcpScope_searchToolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.mcpScope_searchField {
  flex: 1 1 220px;
  min-width: 0;
}

.mcpScope_searchInput {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
}

.mcpScope_searchInput::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 1;
}

.mcpScope_searchInput:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.mcpScope_filterChips {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.mcpScope_filterChip {
  height: 24px;
  padding: 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}

.mcpScope_filterChip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_filterChip:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_filterChipActive {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
  border-color: transparent;
}

/* ---- server list ---- */

.mcpScope_serverList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcpScope_serverRow {
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-stroke);
  transition: background .16s;
}

.mcpScope_serverRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_serverRowButton {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mcpScope_serverRowButton:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_serverRowTop {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.mcpScope_serverRowName {
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42%;
}

.mcpScope_serverRowTags {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.mcpScope_serverRowStats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

.mcpScope_serverRowMeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_serverRowChevron {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 14px;
  line-height: 17px;
}

.mcpScope_serverRowUnused {
  color: var(--dsw-alias-state-warn-primary);
}

.mcpScope_scopeText {
  font-variant-numeric: tabular-nums;
}

/* ---- detail ---- */

.mcpScope_detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.mcpScope_detailBack {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.mcpScope_detailBack:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_detailBack:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_detailHead {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}

.mcpScope_detailTitleGroup {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 260px;
  min-width: 0;
}

.mcpScope_detailTitle {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.mcpScope_detailSub {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.mcpScope_detailActions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}

.mcpScope_detailStatusRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_detailBody {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* ---- section block ---- */

.mcpScope_detailSection {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  min-width: 0;
}

.mcpScope_detailBody > .mcpScope_detailSection:first-child {
  padding-top: 0;
  border-top: none;
}

.mcpScope_detailSectionDanger {
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.mcpScope_detailSectionHead {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}

.mcpScope_detailSectionHeading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 220px;
  min-width: 0;
}

.mcpScope_detailSectionTitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_detailSectionHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_detailSectionActions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mcpScope_scopeGrid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 2px 16px;
}

.mcpScope_scopeRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  min-width: 0;
}

.mcpScope_scopeName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

.mcpScope_scopePath {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* ---- tools panel ---- */

.mcpScope_toolPanel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcpScope_toolDisclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.mcpScope_toolDisclosure:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_toolDisclosure:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_toolBody2 {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mcpScope_toolSearchRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mcpScope_toolRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  min-width: 0;
}

.mcpScope_toolRowName {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_toolRowDesc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_toolTruncate {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* ---- configuration / credentials ---- */

.mcpScope_configGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px 16px;
}

.mcpScope_configItem {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mcpScope_configLabel {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_configValue {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.mcpScope_credentialList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mcpScope_credentialRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  min-width: 0;
}

.mcpScope_credentialRow:first-child {
  border-top: none;
}

.mcpScope_credentialMain {
  flex: 1 1 200px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.mcpScope_credentialName {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.mcpScope_credentialState {
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_credentialActions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mcpScope_credentialShared {
  flex-basis: 100%;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

/* ---- availability / danger ---- */

.mcpScope_availabilityRow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.mcpScope_availabilityBody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mcpScope_availabilityHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_dangerZone {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcpScope_dangerHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_dangerActions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---- editor ---- */

.mcpScope_editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform);
  min-width: 0;
}

.mcpScope_editorHead {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcpScope_editorTitle {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_editorSub {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_editorSource {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mcpScope_editorGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
}

.mcpScope_editorField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mcpScope_editorSection {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  min-width: 0;
}

.mcpScope_editorSectionTitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_editorAdvanced {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.mcpScope_editorAdvanced:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_editorAdvanced:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_editorAdvancedBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mcpScope_editorFooter {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform);
}

.mcpScope_editorFooterHint {
  flex: 1 1 200px;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_editorErrorSummary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_editorErrorTitle {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}

.mcpScope_editorErrorList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcpScope_editorErrorLink {
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-state-error-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  text-decoration: underline;
  cursor: pointer;
}

.mcpScope_editorErrorLink:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
  border-radius: 4px;
}

.mcpScope_secretInputWrap {
  position: relative;
  display: flex;
  min-width: 0;
}

.mcpScope_secretInputWrap > input {
  flex: 1;
  padding-right: 38px;
}

.mcpScope_revealButton {
  position: absolute;
  top: 50%;
  right: 3px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}

.mcpScope_revealButton:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mcpScope_revealButton:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.mcpScope_rowRemove {
  flex: none;
}

.mcpScope_keyValueRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.mcpScope_keyValueCell {
  flex: 1 1 120px;
  min-width: 0;
}

.mcpScope_editorNote {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_candidateList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

/* ---- toast ---- */

.mcpScope_toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mcpScope_toastText {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mcpScope_toastAction {
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}

.mcpScope_toastAction:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mcpScope_toastClose {
  flex: none;
}

/* ---- status pill ---- */

.mcpScope_statusPill {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 0.5px solid transparent;
  border-radius: 999px;
  corner-shape: round;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}

.mcpScope_statusPillDot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
}

.mcpScope_statusPillOk {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.mcpScope_statusPillWarn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

.mcpScope_statusPillError {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.mcpScope_statusPillIdle {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-tertiary);
}

/* ---- inline notice ---- */

.mcpScope_inlineNotice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  min-width: 0;
}

.mcpScope_inlineNoticeMark {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
}

.mcpScope_inlineNoticeBody {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mcpScope_inlineNoticeActions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mcpScope_inlineNoticeInfo {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_inlineNoticeSuccess {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.mcpScope_inlineNoticeWarn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

.mcpScope_inlineNoticeError {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

/* ---- empty state ---- */

.mcpScope_emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 20px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 12px;
  text-align: center;
}

.mcpScope_emptyStateCompact {
  padding: 12px;
  border: none;
  align-items: flex-start;
  text-align: left;
}

.mcpScope_emptyTitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_emptyBody {
  margin: 0;
  max-width: 460px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mcpScope_emptyActions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}

.mcpScope_emptyStateCompact .mcpScope_emptyActions {
  justify-content: flex-start;
}

/* ---- dialog ---- */

.mcpScope_modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1);
}

.mcpScope_modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 100%);
  max-height: min(680px, calc(100vh - 48px));
  padding: 16px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-panel);
}

.mcpScope_modalWide {
  width: min(560px, 100%);
}

.mcpScope_modalHead {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.mcpScope_modalTitle {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mcpScope_modalBody {
  min-height: 0;
  overflow: auto;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.mcpScope_modalActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.mcpScope_confirmBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-wrap: anywhere;
}

.mcpScope_buttonPrimaryDanger {
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

.mcpScope_buttonPrimaryDanger:hover:not(:disabled) {
  background: var(--dsw-alias-state-error-primary);
  opacity: 0.9;
}

@media (max-width: 560px) {
.mcpScope_serverRowName {
    max-width: 100%;
  }

.mcpScope_serverRowStats {
    margin-left: 0;
  }

.mcpScope_detailActions {
    margin-left: 0;
  }

.mcpScope_editor {
    padding: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
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