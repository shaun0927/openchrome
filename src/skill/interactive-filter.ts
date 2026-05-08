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
 * Common ARIA roles that explicitly DO NOT carry interactive semantics.
 * Used as a fallback-chain terminator: when a `role="X Y"` chain has X
 * recognised as one of these, we honour the user-agent rule that the
 * first valid token wins and stop without checking later tokens. This
 * keeps `role="heading button"` non-interactive (consistent with
 * browsers) instead of a false positive that would skew the state hash.
 *
 * The set is intentionally narrow — only roles common enough to appear
 * in real-world fallback chains. Truly unknown tokens fall through to
 * the next one (matches ARIA 1.2 token-resolution semantics).
 */
const NON_INTERACTIVE_ROLES = new Set([
  // Document structure
  'heading', 'list', 'listitem', 'article', 'document', 'figure', 'group',
  'separator', 'table', 'row', 'rowgroup', 'cell', 'columnheader', 'rowheader',
  'definition', 'term', 'note', 'paragraph', 'presentation', 'none',
  // Landmarks
  'banner', 'complementary', 'contentinfo', 'main', 'navigation', 'region', 'search', 'form',
  // Live regions / status
  'alert', 'log', 'marquee', 'status', 'timer', 'tooltip',
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
