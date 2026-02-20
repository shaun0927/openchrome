/**
 * HintEngine — evaluates rules against tool results to produce anti-삽질 hints.
 *
 * Rules are sorted by priority (lower = higher priority) and evaluated first-match-wins.
 * Uses ActivityTracker's recent calls for sequence/pattern detection.
 */

import type { ToolCallEvent } from '../dashboard/types';
import type { ActivityTracker } from '../dashboard/activity-tracker';
import { errorRecoveryRules } from './rules/error-recovery';
import { compositeSuggestionRules } from './rules/composite-suggestions';
import { sequenceDetectionRules } from './rules/sequence-detection';
import { successHintRules } from './rules/success-hints';

export interface HintContext {
  toolName: string;
  resultText: string;
  isError: boolean;
  recentCalls: ToolCallEvent[];
}

export interface HintRule {
  name: string;
  priority: number;
  match(ctx: HintContext): string | null;
}

export class HintEngine {
  private rules: HintRule[];
  private activityTracker: ActivityTracker;

  constructor(activityTracker: ActivityTracker) {
    this.activityTracker = activityTracker;

    // Collect all rules and sort by priority (ascending = highest priority first)
    this.rules = [
      ...errorRecoveryRules,
      ...compositeSuggestionRules,
      ...sequenceDetectionRules,
      ...successHintRules,
    ].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Evaluate rules and return the first matching hint, or null.
   */
  getHint(toolName: string, result: Record<string, unknown>, isError: boolean): string | null {
    const resultText = this.extractText(result);
    const recentCalls = this.activityTracker.getRecentCalls(5);

    const ctx: HintContext = { toolName, resultText, isError, recentCalls };

    for (const rule of this.rules) {
      const hint = rule.match(ctx);
      if (hint) return hint;
    }

    return null;
  }

  /**
   * Extract text content from an MCPResult for pattern matching.
   */
  private extractText(result: Record<string, unknown>): string {
    const content = result.content;
    if (!Array.isArray(content)) return JSON.stringify(result);

    return content
      .filter((c: Record<string, unknown>) => c.type === 'text')
      .map((c: Record<string, unknown>) => c.text as string)
      .join('\n');
  }

  /**
   * Get all registered rules (for testing).
   */
  getRules(): HintRule[] {
    return this.rules;
  }
}
