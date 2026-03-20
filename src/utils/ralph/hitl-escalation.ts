/**
 * HITL Escalation — structured human-in-the-loop context
 *
 * When all automated strategies (S1-S6) fail, provides the LLM with
 * enough diagnostic context to ask the user for help effectively.
 *
 * This is the last resort (S7) in the ralph engine. It's informational,
 * not blocking — the LLM decides how to use this information.
 */

import type { InteractionOutcome } from './outcome-classifier';

// ─── Types ───

/** Record of a single strategy attempt */
export interface StrategyAttempt {
  strategy: string;     // human-readable label (e.g., "AX tree", "CDP coordinates")
  strategyId: string;   // machine ID (e.g., "S1_AX", "S3_CDP_COORD")
  outcome: InteractionOutcome;
  durationMs?: number;
}

/** Structured context for human intervention */
export interface HitlContext {
  /** The original query that failed */
  query: string;
  /** Current page URL */
  url: string;
  /** Tab ID for reference */
  tabId: string;
  /** All strategies tried with their outcomes */
  strategiesTried: StrategyAttempt[];
  /** Last DOM delta observed (if any) */
  lastDelta?: string;
  /** Human-readable diagnosis of why automation failed */
  diagnosis: string;
  /** Suggested action for the user */
  suggestion: string;
  /** Total time spent trying */
  totalDurationMs: number;
}

// ─── Diagnosis Logic ───

/**
 * Analyze strategy attempts to produce a human-readable diagnosis.
 */
function diagnose(attempts: StrategyAttempt[]): string {
  if (attempts.length === 0) {
    return 'No element matching the query was found on the page.';
  }

  const outcomes = attempts.map(a => a.outcome);

  // All ELEMENT_NOT_FOUND
  if (outcomes.every(o => o === 'ELEMENT_NOT_FOUND')) {
    return 'The element could not be found by any discovery method (AX tree or CSS). It may be inside an iframe, dynamically loaded, or hidden.';
  }

  // All SILENT_CLICK
  if (outcomes.every(o => o === 'SILENT_CLICK')) {
    return 'The element was found and clicked via multiple delivery methods, but none produced a DOM change. This typically indicates a custom framework component that intercepts standard click events, or an overlay blocking the element.';
  }

  // Mix of SILENT_CLICK and WRONG_ELEMENT
  const hasSilent = outcomes.includes('SILENT_CLICK');
  const hasWrong = outcomes.includes('WRONG_ELEMENT');
  if (hasSilent && hasWrong) {
    return 'Some click attempts hit the wrong element (e.g., a tooltip trigger instead of the target), and others produced no response. The target element likely shares visual space with nearby interactive elements.';
  }

  // All WRONG_ELEMENT
  if (outcomes.every(o => o === 'WRONG_ELEMENT')) {
    return 'Every click attempt interacted with the wrong element. The target is likely obscured by an overlapping element or has ambiguous positioning.';
  }

  // Mix of EXCEPTION and others
  if (outcomes.includes('EXCEPTION')) {
    return 'Some strategies failed with browser errors. The page may have restrictive security policies (CORS, CSP) that block automated interaction.';
  }

  // All TIMEOUT
  if (outcomes.every(o => o === 'TIMEOUT')) {
    return 'All strategies timed out. The page may be unresponsive or under heavy load.';
  }

  return 'Multiple interaction strategies failed for different reasons. The element may require manual interaction.';
}

/**
 * Generate a suggested action based on the failure pattern.
 */
function suggest(attempts: StrategyAttempt[], query: string): string {
  const outcomes = attempts.map(a => a.outcome);

  if (outcomes.every(o => o === 'ELEMENT_NOT_FOUND')) {
    return `The element "${query}" was not found. Please verify it exists on the current page, or try scrolling to make it visible.`;
  }

  if (outcomes.every(o => o === 'SILENT_CLICK')) {
    return `Please click "${query}" manually in the browser. The element doesn't respond to automated clicks.`;
  }

  if (outcomes.includes('WRONG_ELEMENT')) {
    return `Please click "${query}" manually — automated targeting keeps hitting an adjacent element instead.`;
  }

  return `Please interact with "${query}" manually in the browser, then I'll continue with the next step.`;
}

// ─── Main Function ───

/**
 * Build a structured HITL context from strategy attempts.
 *
 * Called by ralph-engine when all S1-S6 strategies fail (S7).
 * Returns structured context that the LLM can use to:
 * 1. Ask the user to click manually
 * 2. Try a completely different approach
 * 3. Skip this step and continue
 */
export function buildHitlContext(
  query: string,
  url: string,
  tabId: string,
  attempts: StrategyAttempt[],
  lastDelta: string | undefined,
  totalDurationMs: number,
): HitlContext {
  return {
    query,
    url,
    tabId,
    strategiesTried: attempts,
    lastDelta,
    diagnosis: diagnose(attempts),
    suggestion: suggest(attempts, query),
    totalDurationMs,
  };
}

/**
 * Format HITL context into a human-readable response for the LLM.
 */
export function formatHitlResponse(ctx: HitlContext): string {
  const lines: string[] = [];

  lines.push(`\u26a0 ALL AUTOMATION STRATEGIES EXHAUSTED for "${ctx.query}"`);
  lines.push('');

  // Strategy summary
  lines.push('Strategies tried:');
  for (const attempt of ctx.strategiesTried) {
    const duration = attempt.durationMs ? ` (${attempt.durationMs}ms)` : '';
    lines.push(`  ${attempt.strategy}: ${attempt.outcome}${duration}`);
  }
  lines.push('');

  // Diagnosis
  lines.push(`Diagnosis: ${ctx.diagnosis}`);
  lines.push('');

  // Suggestion
  lines.push(`Suggestion: ${ctx.suggestion}`);
  lines.push('');

  // Context
  lines.push(`Page: ${ctx.url}`);
  lines.push(`Total time: ${ctx.totalDurationMs}ms`);

  return lines.join('\n');
}
