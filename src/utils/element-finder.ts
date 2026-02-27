/**
 * Element Finder - Shared element search and scoring utilities
 *
 * Used by click-element, interact, and find tools to locate elements
 * by natural language query with consistent scoring logic.
 */

/**
 * Represents a found element with its properties and match score.
 */
export interface FoundElement {
  backendDOMNodeId: number;
  role: string;
  name: string;
  tagName: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  textContent?: string;
  rect: { x: number; y: number; width: number; height: number };
  score: number;
}

/**
 * Stop words filtered out when tokenizing queries.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or',
]);

/**
 * Tokenize a query string into meaningful search tokens.
 * Filters out stop words and single-character tokens.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .filter(t => !STOP_WORDS.has(t));
}

/**
 * Score an element based on how well it matches the query.
 *
 * Scoring priorities:
 * - Exact name/text match: +100
 * - Exact aria-label match: +90
 * - Contains full query: +50/+45
 * - Token matches: +15 per token
 * - Role match bonus: +30
 * - Interactive element bonus: +20
 * - Size bonuses/penalties: +10/-20
 */
export function scoreElement(
  element: FoundElement,
  queryLower: string,
  queryTokens: string[],
): number {
  let score = 0;
  const nameLower = element.name.toLowerCase();
  const textLower = element.textContent?.toLowerCase() || '';
  const ariaLower = element.ariaLabel?.toLowerCase() || '';
  const placeholderLower = element.placeholder?.toLowerCase() || '';

  // Exact match bonus (highest priority)
  if (nameLower === queryLower || textLower === queryLower) {
    score += 100;
  }

  // Aria label exact match
  if (ariaLower === queryLower) {
    score += 90;
  }

  // Contains full query
  if (nameLower.includes(queryLower) || textLower.includes(queryLower)) {
    score += 50;
  }
  if (ariaLower.includes(queryLower)) {
    score += 45;
  }

  // Token matching (partial match for multi-word queries)
  const combinedText = `${nameLower} ${textLower} ${ariaLower} ${placeholderLower}`;
  const matchedTokens = queryTokens.filter(token => combinedText.includes(token));
  score += matchedTokens.length * 15;

  // Role matching bonus - if query mentions role
  const roleMatches: Array<[string, () => boolean]> = [
    ['button', () => element.role === 'button' || element.tagName === 'button'],
    ['link', () => element.role === 'link' || element.tagName === 'a'],
    ['radio', () => element.role === 'radio' || element.type === 'radio'],
    ['checkbox', () => element.role === 'checkbox' || element.type === 'checkbox'],
    ['input', () => element.tagName === 'input' || element.tagName === 'textarea'],
    ['switch', () => element.role === 'switch'],
    ['toggle', () => element.role === 'switch'],
    ['dropdown', () => element.role === 'combobox' || element.role === 'listbox'],
    ['select', () => element.role === 'combobox' || element.role === 'listbox'],
    ['slider', () => element.role === 'slider'],
  ];

  for (const [keyword, matcher] of roleMatches) {
    if (queryLower.includes(keyword) && matcher()) {
      score += 30;
    }
  }

  // Interactive element bonus
  if (
    [
      'button', 'link', 'checkbox', 'radio', 'menuitem', 'tab',
      'option', 'switch', 'combobox', 'listbox', 'slider', 'treeitem',
    ].includes(element.role)
  ) {
    score += 20;
  }

  // Visible size bonus (larger elements are usually more important)
  if (element.rect.width > 50 && element.rect.height > 20) {
    score += 10;
  }

  // Penalty for very small elements (likely icons or hidden)
  if (element.rect.width < 10 || element.rect.height < 10) {
    score -= 20;
  }

  return score;
}

/**
 * CSS selectors for interactive elements, used by in-page search.
 */
export const INTERACTIVE_SELECTORS = [
  'button',
  '[role="button"]',
  'a',
  '[role="link"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="radio"]',
  'input[type="checkbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[onclick]',
  '[tabindex]',
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="treeitem"]',
  '[role="dialog"] [aria-label]',
  '[role="alertdialog"] [aria-label]',
  '[data-testid]',
];
