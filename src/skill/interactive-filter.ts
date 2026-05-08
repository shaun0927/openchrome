/**
 * Canonical "is this an interactive element?" predicate.
 *
 * Shared by #702 (state hashing — must be deterministic across runs) and
 * #709 (perceptual metadata — must annotate the same set). Defined once
 * here so the two consumers don't drift.
 *
 * The set is intentionally narrow: only nodes a user could plausibly
 * interact with via click/type/select. Excludes labels, headings, lists.
 */

const INTERACTIVE_TAG_NAMES = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'option',
  'summary',
  'video',
  'audio',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'switch',
  'option',
  'combobox',
  'searchbox',
  'textbox',
  'slider',
  'spinbutton',
  'menuitemcheckbox',
  'menuitemradio',
]);

/**
 * ARIA roles that are recognised but do NOT carry interactive
 * semantics. Together with `INTERACTIVE_ROLES`, this set forms the
 * "known role" universe. ARIA 1.2 fallback semantics resolve a
 * `role="X Y"` chain to the first **recognised** token; an unknown
 * token is skipped to the next one. Without a complete known-role
 * universe, valid roles outside this set leak through the unknown
 * fallback path and a later interactive token wrongly wins.
 *
 * This list mirrors the WAI-ARIA 1.2 role taxonomy (document
 * structure, landmark, live region, window, and abstract container
 * roles) excluding the widget roles already in `INTERACTIVE_ROLES`.
 */
const NON_INTERACTIVE_ROLES = new Set([
  // Document structure
  'article', 'blockquote', 'caption', 'cell', 'code', 'columnheader',
  'definition', 'deletion', 'directory', 'document', 'emphasis', 'feed',
  'figure', 'generic', 'group', 'heading', 'image', 'img', 'insertion',
  'list', 'listitem', 'mark', 'math', 'meter', 'none', 'note', 'paragraph',
  'presentation', 'row', 'rowgroup', 'rowheader', 'separator', 'strong',
  'subscript', 'superscript', 'table', 'term', 'time', 'toolbar', 'tooltip',
  // Landmark
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation',
  'region', 'search',
  // Live region / status
  'alert', 'alertdialog', 'dialog', 'log', 'marquee', 'status', 'timer',
  // Composite container (the focusable child carries interactivity, not
  // the container itself, so it does not promote when it appears as
  // the first token of a fallback chain).
  'grid', 'listbox', 'menu', 'menubar', 'radiogroup', 'tablist',
  'tabpanel', 'tree', 'treegrid', 'treeitem',
]);

/** Subset of an element/node descriptor sufficient for the predicate. */
export interface InteractiveProbe {
  /** Lowercased tag name (e.g. "button", "a"). */
  tagName: string;
  /** ARIA role attribute, lowercased. */
  role?: string;
  /** Presence of href on `<a>`. Anchors without href are not interactive. */
  hasHref?: boolean;
  /** Presence of contenteditable. Treated as interactive textbox-equivalent. */
  contentEditable?: boolean;
  /** tabindex >= 0 makes any element focusable. */
  tabIndex?: number;
}

export function isInteractiveNode(probe: InteractiveProbe): boolean {
  const tag = probe.tagName.toLowerCase();

  // Anchors with `href` are interactive on the strength of the tag alone.
  // Anchors without `href` (name-anchors) are NOT interactive on tag alone,
  // but may still be promoted by an ARIA role / contentEditable / tabindex
  // — common SPA pattern: `<a role="button" tabindex="0">…</a>`. We
  // therefore fall through to the role/focus checks below instead of
  // short-circuiting.
  if (tag === 'a') {
    if (probe.hasHref) return true;
  } else if (INTERACTIVE_TAG_NAMES.has(tag)) {
    return true;
  }

  if (probe.role && hasInteractiveRoleToken(probe.role)) return true;

  if (probe.contentEditable) return true;

  if (typeof probe.tabIndex === 'number' && probe.tabIndex >= 0) return true;

  return false;
}

/**
 * ARIA permits the `role` attribute to be a space-separated fallback
 * chain (`role="switch checkbox"`); per ARIA 1.2, the user agent
 * resolves the element as the FIRST recognised token, not the first
 * interactive one. We follow the same precedence:
 *
 *   • Walk tokens left-to-right.
 *   • A token in `INTERACTIVE_ROLES` → interactive (return true).
 *   • A token in `NON_INTERACTIVE_ROLES` → not interactive (return
 *     false), even if a later token is interactive — this keeps
 *     `role="heading button"` consistent with the browser, which
 *     resolves it as `heading`.
 *   • An unrecognised token is skipped, mirroring the user-agent
 *     fallback (`role="weirdname button"` → `button`).
 *
 * If no recognised token is found, the role chain is treated as
 * non-interactive (the caller may still promote via tabIndex /
 * contentEditable / native tag).
 */
function hasInteractiveRoleToken(role: string): boolean {
  for (const token of role.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    if (INTERACTIVE_ROLES.has(token)) return true;
    if (NON_INTERACTIVE_ROLES.has(token)) return false;
  }
  return false;
}
