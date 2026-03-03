/**
 * ProgressTracker — Detects when the LLM agent is not making meaningful progress.
 *
 * Instead of matching specific error patterns, measures whether recent tool calls
 * represent meaningful progress (URL change, content extraction, successful interaction)
 * or spinning (auth redirects, stale refs, non-interactive clicks, timeouts).
 */

import type { ToolCallEvent } from '../dashboard/types.js';

export type ProgressStatus = 'progressing' | 'stalling' | 'stuck';

/**
 * Signals in tool results that indicate NO meaningful progress was made,
 * even if the tool call technically "succeeded".
 */
const NON_PROGRESS_SIGNALS = [
  'authRedirect',                    // Auth redirect detected
  'not interactive',                 // Clicked non-interactive element
  'is stale',                        // Stale ref
  'timed out',                       // Timeout
  'No significant visual change',    // Screenshot unchanged
  'not found',                       // Element not found
  'no longer available',             // Tab gone
  'Login page detected',             // Login redirect (from hint)
  'CAPTCHA',                         // CAPTCHA blocked
  '404',                             // Page not found
  'Access Denied',                   // Access denied
  'Forbidden',                       // 403
];

export class ProgressTracker {
  /**
   * Evaluate recent tool calls to determine if the agent is making progress.
   *
   * @param recentCalls - Last 5 tool calls from ActivityTracker (newest first)
   * @param currentToolName - Current tool being evaluated
   * @param currentResultText - Text content of current tool result
   * @param currentIsError - Whether current tool call errored
   * @returns ProgressStatus
   */
  evaluate(
    recentCalls: ToolCallEvent[],
    currentToolName: string,
    currentResultText: string,
    currentIsError: boolean,
  ): ProgressStatus {
    // Build a list of recent "progress" assessments including the current call
    const currentIsProgress = !currentIsError && this.isProgressResult(currentResultText);

    let consecutiveNonProgress = currentIsProgress ? 0 : 1;
    let consecutiveErrors = currentIsError ? 1 : 0;

    // Walk backward through recent calls
    for (const call of recentCalls) {
      if (call.result === 'error') {
        consecutiveErrors++;
        consecutiveNonProgress++;
      } else {
        // Check if the successful call had non-progress signals
        // We can only check error field; for successful calls we check the tool name pattern
        const wasProgress = this.isLikelyProgressCall(call);
        if (!wasProgress) {
          consecutiveNonProgress++;
        } else {
          break; // Found progress, stop counting
        }
        consecutiveErrors = 0; // Reset error streak on success
      }
    }

    // Stuck: 3+ consecutive errors, or 5+ non-progress calls
    if (consecutiveErrors >= 3 || consecutiveNonProgress >= 5) {
      return 'stuck';
    }

    // Stalling: 3+ non-progress calls (mix of errors and non-progress successes)
    if (consecutiveNonProgress >= 3) {
      return 'stalling';
    }

    return 'progressing';
  }

  /**
   * Check if a tool result text contains non-progress signals.
   * Used for the CURRENT tool call where we have the full result text.
   */
  isProgressResult(resultText: string): boolean {
    return !NON_PROGRESS_SIGNALS.some(signal => resultText.includes(signal));
  }

  /**
   * Check if a completed tool call was likely progress-producing.
   * Used for PAST calls where we only have ToolCallEvent metadata.
   *
   * Heuristic: successful calls are progress unless they errored,
   * had very short duration (likely a non-progress response), or
   * are known non-progress patterns.
   */
  private isLikelyProgressCall(call: ToolCallEvent): boolean {
    // Errors are never progress
    if (call.result === 'error') return false;

    // If error field is set (even on "success"), check for non-progress signals
    if (call.error) {
      return !NON_PROGRESS_SIGNALS.some(signal => call.error!.includes(signal));
    }

    // Tool-based heuristics for past calls without full result text:
    // - navigate with very fast completion (~<500ms) might be a redirect
    // - computer/click calls without errors are usually progress
    // - read_page/find calls are usually progress (information gathering)
    return true;
  }
}

// Export NON_PROGRESS_SIGNALS for testing
export { NON_PROGRESS_SIGNALS };
