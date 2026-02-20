/**
 * HintEngine — evaluates rules against tool results to produce anti-삽질 hints.
 *
 * Rules are sorted by priority (lower = higher priority) and evaluated first-match-wins.
 * Uses ActivityTracker's recent calls for sequence/pattern detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolCallEvent } from '../dashboard/types';
import type { ActivityTracker } from '../dashboard/activity-tracker';
import { errorRecoveryRules } from './rules/error-recovery';
import { compositeSuggestionRules } from './rules/composite-suggestions';
import { sequenceDetectionRules } from './rules/sequence-detection';
import { repetitionDetectionRules } from './rules/repetition-detection';
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

export interface HintLogEntry {
  timestamp: number;
  toolName: string;
  isError: boolean;
  matchedRule: string | null;
  hint: string | null;
}

export class HintEngine {
  private rules: HintRule[];
  private activityTracker: ActivityTracker;
  private logFilePath: string | null = null;

  constructor(activityTracker: ActivityTracker) {
    this.activityTracker = activityTracker;

    // Collect all rules and sort by priority (ascending = highest priority first)
    this.rules = [
      ...errorRecoveryRules,
      ...compositeSuggestionRules,
      ...sequenceDetectionRules,
      ...repetitionDetectionRules,
      ...successHintRules,
    ].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Enable hit/miss logging to a JSONL file for data collection.
   */
  enableLogging(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      this.logFilePath = path.join(dirPath, `hints-${new Date().toISOString().slice(0, 10)}.jsonl`);
    } catch {
      // Best-effort logging
    }
  }

  /**
   * Evaluate rules and return the first matching hint, or null.
   */
  getHint(toolName: string, result: Record<string, unknown>, isError: boolean): string | null {
    const resultText = this.extractText(result);
    const recentCalls = this.activityTracker.getRecentCalls(5);

    const ctx: HintContext = { toolName, resultText, isError, recentCalls };

    let matchedRule: string | null = null;
    let hint: string | null = null;

    for (const rule of this.rules) {
      const h = rule.match(ctx);
      if (h) {
        matchedRule = rule.name;
        hint = h;
        break;
      }
    }

    this.log({ timestamp: Date.now(), toolName, isError, matchedRule, hint });

    return hint;
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
   * Write a log entry (best-effort, non-blocking).
   */
  private log(entry: HintLogEntry): void {
    if (!this.logFilePath) return;
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n');
    } catch {
      // Best-effort logging
    }
  }

  /**
   * Get all registered rules (for testing).
   */
  getRules(): HintRule[] {
    return this.rules;
  }
}
