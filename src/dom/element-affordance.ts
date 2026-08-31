/**
 * Compact action-affordance classification for perception output.
 *
 * The returned marker is display metadata only. It must be rendered outside
 * canonical refs/backendNodeIds so existing ref parsers keep working.
 */
export type ElementAffordance =
  | 'text-input'
  | 'link'
  | 'control'
  | 'visual'
  | 'text';

export type AffordanceMarker = '#' | '@' | '$' | '%' | '';

export interface ElementAffordanceInput {
  tagName?: string | null;
  role?: string | null;
  type?: string | null;
  href?: string | null;
  contentEditable?: boolean | string | null;
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'password',
  'email',
  'search',
  'url',
  'tel',
  'number',
]);

const TEXT_INPUT_ROLES = new Set([
  'textbox',
  'searchbox',
]);

const LINK_ROLES = new Set([
  'link',
]);

const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
]);

const VISUAL_ROLES = new Set([
  'image',
  'img',
  'graphics-symbol',
]);

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isContentEditable(value: ElementAffordanceInput['contentEditable']): boolean {
  return value === true || normalize(String(value ?? '')) === 'true' || normalize(String(value ?? '')) === 'plaintext-only';
}

export function classifyElementAffordance(input: ElementAffordanceInput): ElementAffordance {
  const tagName = normalize(input.tagName);
  const role = normalize(input.role);
  const type = normalize(input.type);

  if (isContentEditable(input.contentEditable) || TEXT_INPUT_ROLES.has(role)) {
    return 'text-input';
  }

  if (tagName === 'textarea') {
    return 'text-input';
  }

  if (tagName === 'input') {
    if (!type || TEXT_INPUT_TYPES.has(type)) return 'text-input';
    if (type === 'hidden') return 'text';
    return 'control';
  }

  if (tagName === 'a' || LINK_ROLES.has(role)) {
    return 'link';
  }

  if (tagName === 'button' || tagName === 'select' || tagName === 'details' || CONTROL_ROLES.has(role)) {
    return 'control';
  }

  if (tagName === 'img' || tagName === 'canvas' || tagName === 'video' || tagName === 'svg' || VISUAL_ROLES.has(role)) {
    return 'visual';
  }

  return 'text';
}

export function affordanceMarkerFor(kind: ElementAffordance): AffordanceMarker {
  switch (kind) {
    case 'text-input': return '#';
    case 'link': return '@';
    case 'control': return '$';
    case 'visual': return '%';
    case 'text': return '';
  }
}

export function getAffordanceMarker(input: ElementAffordanceInput): AffordanceMarker {
  return affordanceMarkerFor(classifyElementAffordance(input));
}

export function formatAffordancePrefix(input: ElementAffordanceInput): string {
  const marker = getAffordanceMarker(input);
  return marker ? `${marker} ` : '';
}
