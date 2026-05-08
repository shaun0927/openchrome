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
 * chain (`role="switch checkbox"`); the user agent picks the first
 * supported token. We follow the same rule: any interactive token
 * anywhere in the chain promotes the element.
 */
function hasInteractiveRoleToken(role: string): boolean {
  for (const token of role.toLowerCase().split(/\s+/)) {
    if (token && INTERACTIVE_ROLES.has(token)) return true;
  }
  return false;
}
