/**
 * HintEngine — evaluates rules against tool results to produce proactive hints.
 *
 * Rules are sorted by priority (lower = higher priority) and evaluated first-match-wins.
 * Uses ActivityTracker's recent calls for sequence/pattern detection.
 * Integrates PatternLearner for adaptive error→recovery learning.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolCallEvent } from '../dashboard/types';
import type { ActivityTracker } from '../dashboard/activity-tracker';
import { PatternLearner } from './pattern-learner';
import { errorRecoveryRules } from './rules/error-recovery';
import { compositeSuggestionRules } from './rules/composite-suggestions';
import { sequenceDetectionRules } from './rules/sequence-detection';
import { repetitionDetectionRules } from './rules/repetition-detection';
import { createLearnedRules } from './rules/learned-rules';
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
  private learner: PatternLearner;
  private logFilePath: string | null = null;

  // Buffered async write stream
  private logStream: fs.WriteStream | null = null;
  private logBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private static readonly FLUSH_INTERVAL = 200; // ms

  constructor(activityTracker: ActivityTracker) {
    this.activityTracker = activityTracker;
    this.learner = new PatternLearner();

    // Collect all rules and sort by priority (ascending = highest priority first)
    // Learned rules (350) sit between repetition (250) and success hints (400)
    this.rules = [
      ...errorRecoveryRules,
      ...compositeSuggestionRules,
      ...sequenceDetectionRules,
      ...repetitionDetectionRules,
      ...createLearnedRules(this.learner),
      ...successHintRules,
    ].sort((a, b) => a.priority - b.priority);

    // Flush remaining buffer on process exit
    process.on('exit', () => {
      this.flushBuffer();
    });
  }

  /**
   * Enable hit/miss logging to a JSONL file for data collection.
   */
  enableLogging(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      this.logFilePath = path.join(dirPath, `hints-${new Date().toISOString().slice(0, 10)}.jsonl`);
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
    } catch {
      // Best-effort logging
    }
  }

  /**
   * Enable adaptive learning — load existing patterns and persist new ones.
   */
  enableLearning(dirPath: string): void {
    this.learner.enablePersistence(dirPath);
  }

  /**
   * Evaluate rules and return the first matching hint, or null.
   * Also feeds the learner for adaptive pattern detection.
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

    // Feed the learner: observe every completion for recovery detection
    this.learner.onToolComplete(toolName, isError);

    // If no rule matched an error, start learning observation
    if (hint === null && isError) {
      this.learner.onMiss(toolName, resultText);
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
   * Write a log entry via buffered async stream (best-effort, non-blocking).
   */
  private log(entry: HintLogEntry): void {
    if (!this.logStream) return;
    this.logBuffer.push(JSON.stringify(entry) + '\n');
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushBuffer();
      }, HintEngine.FLUSH_INTERVAL);
    }
  }

  /**
   * Flush buffered log entries to the write stream.
   */
  private flushBuffer(): void {
    if (this.logBuffer.length > 0 && this.logStream) {
      const data = this.logBuffer.join('');
      this.logStream.write(data);
      this.logBuffer = [];
    }
    this.flushTimer = null;
  }

  /**
   * Flush pending writes and close the log stream. Call on shutdown.
   */
  destroy(): void {
    this.flushBuffer();
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Get all registered rules (for testing).
   */
  getRules(): HintRule[] {
    return this.rules;
  }

  /**
   * Get the pattern learner (for testing).
   */
  getLearner(): PatternLearner {
    return this.learner;
  }
}
