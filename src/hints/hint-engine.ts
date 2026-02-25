/**
 * HintEngine — evaluates rules against tool results to produce proactive hints.
 *
 * Rules are sorted by priority (lower = higher priority) and evaluated first-match-wins.
 * Uses ActivityTracker's recent calls for sequence/pattern detection.
 * Integrates PatternLearner for adaptive error→recovery learning.
 *
 * Escalation system (issue #71):
 * - Fire count 1-2: info severity (original hint text)
 * - Fire count 3-4: warning severity (⚠️ WARNING prefix)
 * - Fire count 5+:  critical severity (🛑 CRITICAL prefix + action history)
 * Fire counts accumulate per rule across the session and never reset.
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
import { paginationDetectionRules } from './rules/pagination-detection';
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

export type HintSeverity = 'info' | 'warning' | 'critical';

export interface HintLogEntry {
  timestamp: number;
  toolName: string;
  isError: boolean;
  matchedRule: string | null;
  hint: string | null;
  severity: HintSeverity | null;
  fireCount: number;
}

export interface HintResult {
  severity: HintSeverity;
  rule: string;
  fireCount: number;
  hint: string;       // formatted hint with severity prefix
  rawHint: string;    // original hint from rule match
  suggestion?: {
    tool?: string;
    reason: string;
  };
  context?: {
    element?: string;
    coordinates?: string;
    ref?: string;
  };
}

export class HintEngine {
  private rules: HintRule[];
  private activityTracker: ActivityTracker;
  private learner: PatternLearner;
  private logFilePath: string | null = null;
  private hintEscalation: Map<string, number> = new Map(); // ruleName -> session fire count

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
      ...errorRecoveryRules,        // priority 100-108
      ...paginationDetectionRules,   // priority 190-192
      ...compositeSuggestionRules,   // priority 200-203
      ...repetitionDetectionRules,   // priority 245-252
      ...sequenceDetectionRules,     // priority 300-304
      ...createLearnedRules(this.learner), // priority 350
      ...successHintRules,           // priority 400-403
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
   * Evaluate rules and return the first matching structured hint, or null.
   * Also feeds the learner for adaptive pattern detection.
   *
   * Returns HintResult with escalating severity based on per-rule fire count:
   * - 1-2 firings: info (original hint text)
   * - 3-4 firings: warning (⚠️ WARNING prefix)
   * - 5+ firings:  critical (🛑 CRITICAL prefix + action history)
   */
  getHint(toolName: string, result: Record<string, unknown>, isError: boolean): HintResult | null {
    const resultText = this.extractText(result);
    const recentCalls = this.activityTracker.getRecentCalls(5);

    const ctx: HintContext = { toolName, resultText, isError, recentCalls };

    let matchedRule: string | null = null;
    let rawHint: string | null = null;

    for (const rule of this.rules) {
      const h = rule.match(ctx);
      if (h) {
        matchedRule = rule.name;
        rawHint = h;
        break;
      }
    }

    if (!rawHint || !matchedRule) {
      // Feed the learner even on miss
      this.learner.onToolComplete(toolName, isError);
      if (isError) {
        this.learner.onMiss(toolName, resultText);
      }
      this.log({ timestamp: Date.now(), toolName, isError, matchedRule: null, hint: null, severity: null, fireCount: 0 });
      return null;
    }

    // Track fire count per rule (accumulates across session, never resets)
    const fireCount = (this.hintEscalation.get(matchedRule) || 0) + 1;
    this.hintEscalation.set(matchedRule, fireCount);

    const severity = this.getSeverity(fireCount);
    let formattedHint = this.formatHintMessage(severity, rawHint, fireCount);

    // Context-aware: extract element/coordinate info from result
    const context = this.extractContext(resultText);

    // For critical hints (5+), add action history to force strategy change
    if (severity === 'critical') {
      const recentTools = recentCalls.slice(0, 5).map(c => c.toolName);
      const toolCounts = recentTools.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {} as Record<string, number>);
      const summary = Object.entries(toolCounts).map(([t, c]) => `${t}×${c}`).join(', ');
      formattedHint += ` Previous actions: [${summary}].`;

      if (context?.coordinates) {
        formattedHint += ` Last coordinates: ${context.coordinates}.`;
      }
      if (context?.element) {
        formattedHint += ` Hit element: ${context.element}.`;
      }
    }

    const suggestion = this.extractSuggestion(rawHint);

    const hintResult: HintResult = {
      severity,
      rule: matchedRule,
      fireCount,
      hint: formattedHint,
      rawHint,
      ...(suggestion && { suggestion }),
      ...(context && { context }),
    };

    // Feed the learner
    this.learner.onToolComplete(toolName, isError);

    this.log({ timestamp: Date.now(), toolName, isError, matchedRule, hint: formattedHint, severity, fireCount });

    return hintResult;
  }

  private getSeverity(fireCount: number): HintSeverity {
    if (fireCount <= 2) return 'info';
    if (fireCount <= 4) return 'warning';
    return 'critical';
  }

  private formatHintMessage(severity: HintSeverity, rawHint: string, fireCount: number): string {
    switch (severity) {
      case 'info':
        return rawHint;  // Keep original text (already has "Hint:" prefix from rules)
      case 'warning':
        return `⚠️ WARNING (${fireCount}x): ${rawHint}`;
      case 'critical':
        return `🛑 CRITICAL (${fireCount}x — you MUST change approach): ${rawHint}`;
    }
  }

  private extractContext(resultText: string): HintResult['context'] | undefined {
    const context: NonNullable<HintResult['context']> = {};

    // Extract coordinates from "Clicked at (X, Y)" or "(X,Y)" patterns
    const coordMatch = resultText.match(/\((\d+),?\s*(\d+)\)/);
    if (coordMatch) context.coordinates = `(${coordMatch[1]}, ${coordMatch[2]})`;

    // Extract element info from "Hit: ..." line
    const hitMatch = resultText.match(/Hit:\s*(.+?)(?:\n|$)/);
    if (hitMatch) context.element = hitMatch[1].trim();

    // Extract ref ID
    const refMatch = resultText.match(/ref[_=]["']?(\w+)/i);
    if (refMatch) context.ref = refMatch[1];

    return Object.keys(context).length > 0 ? context : undefined;
  }

  private extractSuggestion(rawHint: string): HintResult['suggestion'] | undefined {
    // Extract tool name from common patterns like "Use X", "Try X", "Prefer X"
    const toolMatch = rawHint.match(/(?:Use|Try|Prefer)\s+(\w+)(?:\(|[\s,.])/i);
    if (toolMatch) {
      return {
        tool: toolMatch[1],
        reason: rawHint,
      };
    }
    return undefined;
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
