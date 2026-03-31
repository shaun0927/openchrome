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
 * Tools that are purely observational — the LLM uses them to check state,
 * not to make progress. Successful calls to these tools should NOT reset
 * the consecutive error counter, because the "try → observe → retry" loop
 * is the most common hang pattern.
 *
 * Note: `computer` tool is only observational when action is 'screenshot'.
 * Click/type actions via `computer` ARE progress and should break the streak.
 */
const OBSERVATION_TOOLS = new Set(['read_page', 'tabs_context']);

/**
 * Check if a tool call is purely observational (state-checking, not progress-making).
 */
function isObservationCall(call: ToolCallEvent): boolean {
  if (OBSERVATION_TOOLS.has(call.toolName)) return true;
  // computer tool: only screenshots are observation; clicks/typing are progress
  if (call.toolName === 'computer' && call.args?.action === 'screenshot') return true;
  return false;
}

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
  'element not found',               // Element not found (tightened from 'not found')
  'no longer available',             // Tab gone
  'Login page detected',             // Login redirect (from hint)
  'CAPTCHA',                         // CAPTCHA blocked
  '404',                             // Page not found
  'Access Denied',                   // Access denied
  'Forbidden',                       // 403
  'net::ERR_',                       // Chromium network errors
  'Navigation timeout',              // Puppeteer navigation timeout
  'Protocol error',                  // CDP-level failures
  'bot-check',                       // Bot verification page detected
  'captcha detected',                // CAPTCHA page detected
  'Blocking page detected',          // Any blocking page warning from navigate
  'blocked by',                      // Network security block (e.g. "blocked by network security")
  'network security',                // CDN/WAF network security block
  'been blocked',                    // Generic "you've been blocked" messages
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
    _currentToolName: string,
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
      } else if (isObservationCall(call) && !call.error) {
        // Observation-only tools (screenshot, read_page, tabs_context) are the LLM
        // checking state between retries. They should NOT reset the error counter
        // or count as progress — the "try → observe → retry" loop is the most
        // common hang pattern that previously went undetected.
        consecutiveNonProgress++;
      } else {
        // Check if the successful call had non-progress signals
        // We can only check error field; for successful calls we check the tool name pattern
        const wasProgress = this.isLikelyProgressCall(call);
        if (!wasProgress) {
          consecutiveNonProgress++;
          // Do NOT reset consecutiveErrors — a non-progress success
          // is not evidence that the error streak ended
        } else {
          consecutiveErrors = 0; // Only reset on genuine progress
          break; // Found progress, stop counting
        }
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
    if (!resultText || resultText.trim().length === 0) return false;
    const lower = resultText.toLowerCase();
    return !NON_PROGRESS_SIGNALS.some(signal => lower.includes(signal.toLowerCase()));
  }

  /**
   * Check if a completed tool call was likely progress-producing.
   * Used for PAST calls where we only have ToolCallEvent metadata.
   *
   * LIMITATION: For past calls with result='success' and no error field,
   * this method returns true (progress) even if the actual result text
   * contained non-progress signals. Only the CURRENT call's full result
   * text is inspected by isProgressResult(). Past call evaluation is
   * limited to the error field and tool metadata.
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
