/**
 * Outcome Classifier — Analyzes DOM delta after interactions to determine
 * what actually happened, not just whether a click was delivered.
 *
 * This is observation-only: it adds information to responses without
 * restricting any existing behavior.
 *
 * The dominant failure mode in browser automation is not "click threw an error"
 * but "click succeeded but nothing happened" (silent failure). Skyvern proved
 * that adding outcome validation alone drove WebVoyager from 68.7% to 85.85%.
 */

/**
 * Classification of what happened after an interaction.
 */
export type InteractionOutcome =
  | 'SUCCESS'           // DOM changed in a way consistent with the interaction
  | 'SILENT_CLICK'      // Click delivered but zero meaningful DOM mutations
  | 'WRONG_ELEMENT'     // DOM changed but in an unexpected way (e.g., tooltip instead of selection)
  | 'ELEMENT_NOT_FOUND' // No candidates from any discovery strategy
  | 'TIMEOUT'           // Budget exhausted before action completed
  | 'EXCEPTION';        // Hard CDP/browser error

/**
 * Human-readable labels for each outcome.
 */
export const OUTCOME_LABELS: Record<InteractionOutcome, string> = {
  SUCCESS: 'action confirmed',
  SILENT_CLICK: 'no DOM change detected — element may not have responded',
  WRONG_ELEMENT: 'unexpected DOM change — may have interacted with wrong element',
  ELEMENT_NOT_FOUND: 'no matching element found',
  TIMEOUT: 'operation timed out',
  EXCEPTION: 'browser error occurred',
};

/**
 * Outcome symbols for compact response display.
 */
export const OUTCOME_SYMBOLS: Record<InteractionOutcome, string> = {
  SUCCESS: '\u2713',           // ✓
  SILENT_CLICK: '\u26a0',     // ⚠
  WRONG_ELEMENT: '\u26a0',   // ⚠
  ELEMENT_NOT_FOUND: '\u2717', // ✗
  TIMEOUT: '\u23f1',          // ⏱
  EXCEPTION: '\u2717',        // ✗
};

// ─── Patterns for classification ───

/**
 * DOM delta patterns that indicate a successful state change.
 * These are ARIA state changes and structural mutations consistent with
 * standard interactive element behavior.
 */
const SUCCESS_PATTERNS = [
  /aria-checked.*(?:true|false|mixed)/i,
  /aria-selected.*(?:true|false)/i,
  /aria-expanded.*(?:true|false)/i,
  /aria-pressed.*(?:true|false)/i,
  /aria-disabled.*(?:true|false)/i,
  /class.*(?:active|selected|checked|open|expanded|focused|disabled)/i,
  /\bURL changed\b/i,
  /\bnavigat/i,
  /\bnew page\b/i,
  /\btitle changed\b/i,
  /\+ .*(?:dialog|modal|drawer|panel|menu(?!item)|dropdown|popover)/i,
  /\- .*(?:dialog|modal|drawer|panel|menu(?!item)|dropdown|popover)/i,
  /\+ .*\binput\b/i,
  /\bform\b.*\bsubmit/i,
  /\bscroll\b/i,
];

/**
 * DOM delta patterns that suggest a tooltip or help popup opened
 * (common wrong-element indicator when targeting radio/checkbox/switch).
 */
const TOOLTIP_PATTERNS = [
  /\+ .*(?:tooltip|popover|help|hint)/i,
  /role="tooltip"/i,
  /mattooltip/i,
  /aria-describedby.*tooltip/i,
  /cdk-overlay/i,
];

// ─── Main Classification Function ───

/**
 * Classify the outcome of an interaction by analyzing the DOM delta.
 *
 * @param delta - The DOM delta string from withDomDelta(), or undefined/empty
 * @param targetRole - The intended element role (e.g., 'radio', 'button') for
 *                     wrong-element detection. Optional.
 * @returns The classified outcome
 */
export function classifyOutcome(
  delta: string | undefined,
  targetRole?: string,
): InteractionOutcome {
  // No delta at all — silent click
  if (!delta || delta.trim().length === 0) {
    return 'SILENT_CLICK';
  }

  const deltaLower = delta.toLowerCase();

  // Check for tooltip/popover-only changes when targeting non-tooltip elements
  if (targetRole && targetRole !== 'button') {
    const hasTooltipOnly = TOOLTIP_PATTERNS.some(p => p.test(delta));
    const hasOtherChanges = SUCCESS_PATTERNS.some(p => p.test(delta));

    if (hasTooltipOnly && !hasOtherChanges) {
      return 'WRONG_ELEMENT';
    }
  }

  // Check for success patterns
  if (SUCCESS_PATTERNS.some(p => p.test(delta))) {
    return 'SUCCESS';
  }

  // Delta exists but contains no recognized success patterns
  // If there are added/removed elements, consider it a success (some DOM change happened)
  if (/^[+\-~] /m.test(delta)) {
    return 'SUCCESS';
  }

  // Delta has only whitespace/formatting changes — treat as silent click
  return 'SILENT_CLICK';
}

/**
 * Format the outcome for inclusion in a tool response.
 *
 * @param outcome - The classified outcome
 * @param verb - The action verb (e.g., 'Clicked', 'Double-clicked')
 * @param elementDesc - Element description (e.g., 'radio "외부"')
 * @param refPart - Ref string (e.g., '[ref_42]')
 * @param sourcePart - Source string (e.g., '[exact match via AX tree]')
 * @returns Formatted response line
 */
export function formatOutcomeLine(
  outcome: InteractionOutcome,
  verb: string,
  elementDesc: string,
  refPart: string,
  sourcePart: string,
): string {
  const symbol = OUTCOME_SYMBOLS[outcome];
  const label = outcome !== 'SUCCESS' ? ` — ${OUTCOME_LABELS[outcome]}` : '';
  return `${symbol} ${verb} ${elementDesc} ${refPart} ${sourcePart}${label}`.trim();
}
