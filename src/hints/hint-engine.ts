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
import { buildFailureEpisodeContext, type FailureEpisodeContext } from './failure-episode-store';
import { ProgressTracker } from './progress-tracker.js';
import { RepeatedCallDetector } from './repeated-call-detector.js';
import { errorRecoveryRules } from './rules/error-recovery';
import { blockingPageRules } from './rules/blocking-page';
import { compositeSuggestionRules } from './rules/composite-suggestions';
import { sequenceDetectionRules } from './rules/sequence-detection';
import { repetitionDetectionRules } from './rules/repetition-detection';
import { paginationDetectionRules } from './rules/pagination-detection';
import { snapshotStaleRules } from './rules/snapshot-stale';
import { createLearnedRules } from './rules/learned-rules';
import { successHintRules } from './rules/success-hints';
import { setupHintRules } from './rules/setup-hints';
import { consoleBufferPressureRules } from './rules/console-buffer-pressure';
import {
  mapHintRuleToRecoveryCategory,
  RecoveryFeedbackWriter,
} from '../core/trace/recovery-feedback';
import {
  getTaskDriftLedger,
  isTaskDriftLedgerEnabled,
  type TaskDriftLedgerStore,
  type TaskLedger,
} from '../harness/task-ledger';

export interface HintContext {
  toolName: string;
  resultText: string;
  isError: boolean;
  recentCalls: ToolCallEvent[];
  fireCounts: Map<string, number>;
  episodeContext?: FailureEpisodeContext;
}

export interface HintRule {
  name: string;
  priority: number;
  maxSeverity?: HintSeverity;
  /**
   * When true, this rule duplicates guidance already embedded in a tool
   * description's "When to use / When NOT to use" block. If the client has
   * consumed tools/list (i.e. descriptions have been delivered), the rule
   * is suppressed to avoid redundant output.
   */
  redundant_with_description?: boolean;
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
  private progressTracker: ProgressTracker;
  private repeatedCallDetector: RepeatedCallDetector;
  private taskLedger: TaskDriftLedgerStore;
  private logFilePath: string | null = null;
  /** Session IDs for which tools/list has been served — suppresses rules tagged redundant_with_description */
  private toolsListServedSessions: Set<string> = new Set();
  private hintEscalation: Map<string, number> = new Map(); // ruleName -> session fire count
  private missCounts: Map<string, number> = new Map(); // ruleName -> consecutive miss count

  // Buffered async write stream
  private logStream: fs.WriteStream | null = null;
  private logBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private recoveryFeedback: RecoveryFeedbackWriter | null = null;
  private static readonly FLUSH_INTERVAL = 200; // ms

  constructor(activityTracker: ActivityTracker, progressTracker?: ProgressTracker, repeatedCallDetector?: RepeatedCallDetector) {
    this.activityTracker = activityTracker;
    this.progressTracker = progressTracker ?? new ProgressTracker();
    this.repeatedCallDetector = repeatedCallDetector ?? new RepeatedCallDetector();
    this.taskLedger = getTaskDriftLedger();
    this.learner = new PatternLearner();

    // Collect all rules and sort by priority (ascending = highest priority first)
    // Learned rules (350) sit between repetition (250) and success hints (400)
    this.rules = [
      ...setupHintRules,             // priority 90
      ...consoleBufferPressureRules, // priority 95
      ...errorRecoveryRules,         // priority 100-108
      ...blockingPageRules,          // priority 120-122
      ...paginationDetectionRules,   // priority 190-192
      ...compositeSuggestionRules,   // priority 200-203
      ...repetitionDetectionRules,   // priority 245-252
      ...sequenceDetectionRules,     // priority 300-304
      ...createLearnedRules(this.learner), // priority 350
      ...snapshotStaleRules,         // priority 395 (#831)
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

  /** Enable best-effort recovery feedback JSONL bundles (#1048). */
  enableRecoveryFeedback(dirPath: string): void {
    this.recoveryFeedback = new RecoveryFeedbackWriter({ dirPath });
  }

  /**
   * Signal that tools/list has been served to a client this session.
   * Rules tagged `redundant_with_description: true` will be suppressed
   * thereafter to avoid duplicating guidance already embedded in tool
   * descriptions.
   */
  markToolsListServed(sessionId = 'default'): void {
    this.toolsListServedSessions.add(sessionId);
  }

  /**
   * Whether tools/list has been served for a session. Exposed for tests.
   */
  hasServedToolsList(sessionId = 'default'): boolean {
    return this.toolsListServedSessions.has(sessionId);
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
  getHint(
    toolName: string,
    result: Record<string, unknown>,
    isError: boolean,
    sessionId?: string,
    currentArgs?: Record<string, unknown>,
    currentCallId?: string,
  ): HintResult | null {
    const resultText = this.extractText(result);
    const episodeContext = buildFailureEpisodeContext({ args: currentArgs, resultText });
    const hintSessionId = sessionId ?? 'default';
    const recentCalls = this.activityTracker
      .getRecentCalls(6, sessionId)
      .filter((call) => {
        if (currentCallId === undefined) return true;
        const callId = (call as ToolCallEvent & { callId?: string }).id ?? (call as ToolCallEvent & { callId?: string }).callId;
        return callId !== currentCallId;
      })
      .slice(0, 5);

    // Priority 50: Progress tracking (highest priority, runs before all rules)
    // NOTE: ProgressTracker returns early before the rule loop. Miss-count decay
    // for individual rules is intentionally frozen during stuck/stalling phases —
    // we don't want to spuriously reset escalating rule fire counts while the
    // agent is not making progress.
    const ledger = isTaskDriftLedgerEnabled()
      ? this.taskLedger.updateFromToolResult({
          sessionId: hintSessionId,
          tabId: typeof currentArgs?.tabId === 'string' ? currentArgs.tabId : undefined,
          toolName,
          args: currentArgs,
          resultText,
          isError,
          recentCalls,
        })
      : null;
    const ledgerHint = ledger ? this.formatLedgerHint(ledger) : null;
    const status = this.progressTracker.evaluate(recentCalls, toolName, resultText, isError);

    // Scope escalation keys by sessionId when available to prevent cross-session pollution
    const escalationKey = (ruleName: string) =>
      sessionId !== undefined ? `${sessionId}:${ruleName}` : ruleName;

    if (status === 'stuck') {
      const key = escalationKey('progress-tracker-stuck');
      const fireCount = (this.hintEscalation.get(key) || 0) + 1;
      this.hintEscalation.set(key, fireCount);
      const rawHintText = 'STOP — you are stuck. The last several tool calls made no meaningful progress ' +
        '(errors, stale refs, auth redirects, or timeouts). ' +
        'Step back and try a completely different approach, or ask the user for help.' +
        (ledgerHint ? ` ${ledgerHint}` : '');
      const severity = fireCount >= 2 ? 'critical' as const : 'warning' as const;
      this.log({ timestamp: Date.now(), toolName, isError, matchedRule: 'progress-tracker-stuck', hint: rawHintText, severity, fireCount });
      this.recordRecoveryFeedback('progress-tracker-stuck', rawHintText, severity, fireCount, toolName, resultText, isError, hintSessionId, recentCalls);
      return {
        severity,
        rule: 'progress-tracker-stuck',
        fireCount,
        hint: this.formatHintMessage(severity, rawHintText, fireCount),
        rawHint: rawHintText,
      };
    }

    if (status === 'stalling') {
      const key = escalationKey('progress-tracker-stalling');
      const fireCount = (this.hintEscalation.get(key) || 0) + 1;
      this.hintEscalation.set(key, fireCount);
      const rawHintText = 'Warning: recent tool calls are not making progress. ' +
        'Consider trying a different approach before getting stuck.' +
        (ledgerHint ? ` ${ledgerHint}` : '');
      const severity = this.getSeverity(fireCount);
      this.log({ timestamp: Date.now(), toolName, isError, matchedRule: 'progress-tracker-stalling', hint: rawHintText, severity, fireCount });
      this.recordRecoveryFeedback('progress-tracker-stalling', rawHintText, severity, fireCount, toolName, resultText, isError, hintSessionId, recentCalls);
      return {
        severity,
        rule: 'progress-tracker-stalling',
        fireCount,
        hint: this.formatHintMessage(severity, rawHintText, fireCount),
        rawHint: rawHintText,
      };
    }

    const ctx: HintContext = {
      toolName,
      resultText,
      isError,
      recentCalls,
      fireCounts: this.hintEscalation,
      episodeContext,
    };

    let matchedRule: string | null = null;
    let rawHint: string | null = null;
    let matchedMaxSeverity: HintSeverity | undefined;

    const evaluateRule = (rule: HintRule): boolean => {
      // Suppress rules whose guidance is duplicated by an embedded tool
      // description "When to use / When NOT to use" block, once the client
      // has consumed tools/list.
      if (rule.redundant_with_description && this.hasServedToolsList(hintSessionId)) {
        return false;
      }
      const h = rule.match(ctx);
      if (h) {
        matchedRule = rule.name;
        rawHint = h;
        matchedMaxSeverity = rule.maxSeverity;
        // Reset miss count on match
        this.missCounts.set(rule.name, 0);
        return true;
      } else {
        // Increment miss count; after 10 consecutive misses, decay fire count to 0
        const misses = (this.missCounts.get(rule.name) || 0) + 1;
        this.missCounts.set(rule.name, misses);
        if (misses >= 10) {
          this.hintEscalation.set(escalationKey(rule.name), 0);
          this.missCounts.set(rule.name, 0);
        }
      }
      return false;
    };

    // Evaluate higher-signal recovery/composite/repetition rules before exact
    // repeated-call detection. The exact detector is intentionally inserted
    // before lower-priority sequence/learned/success hints, but it must not
    // preempt more specific guidance such as "find then click" or
    // "repeated read_page -> inspect".
    const repeatedDetectorPriority = 260;
    for (const rule of this.rules) {
      if (rule.priority >= repeatedDetectorPriority) break;
      if (evaluateRule(rule)) break;
    }

    if (!rawHint) {
      // Exact repeated-call detection. This catches syntactic
      // wandering (same tool + same effective args) even when individual results
      // look successful enough that ProgressTracker has not yet marked stuck.
      const repeated = this.repeatedCallDetector.evaluate(recentCalls, toolName, currentArgs);
      if (repeated) {
        const key = escalationKey('repeated-identical-tool-call');
        const fireCount = (this.hintEscalation.get(key) || 0) + 1;
        this.hintEscalation.set(key, fireCount);
        const severity = repeated.severity;
        this.log({ timestamp: Date.now(), toolName, isError, matchedRule: 'repeated-identical-tool-call', hint: repeated.hint, severity, fireCount });
        this.recordRecoveryFeedback('repeated-identical-tool-call', repeated.hint, severity, fireCount, toolName, resultText, isError, hintSessionId, recentCalls);
        return {
          severity,
          rule: 'repeated-identical-tool-call',
          fireCount,
          hint: this.formatHintMessage(severity, repeated.hint, fireCount),
          rawHint: repeated.hint,
        };
      }
    }

    if (!rawHint && ledger && ledgerHint) {
      const key = escalationKey('task-ledger-drift');
      const fireCount = (this.hintEscalation.get(key) || 0) + 1;
      this.hintEscalation.set(key, fireCount);
      const severity = fireCount >= 2 || ledger.stopCondition ? 'warning' as const : 'info' as const;
      this.log({ timestamp: Date.now(), toolName, isError, matchedRule: 'task-ledger-drift', hint: ledgerHint, severity, fireCount });
      this.recordRecoveryFeedback('task-ledger-drift', ledgerHint, severity, fireCount, toolName, resultText, isError, hintSessionId, recentCalls);
      return {
        severity,
        rule: 'task-ledger-drift',
        fireCount,
        hint: this.formatHintMessage(severity, ledgerHint, fireCount),
        rawHint: ledgerHint,
        ...(ledger.suggestedNextStep && { suggestion: ledger.suggestedNextStep }),
      };
    }

    if (!rawHint) {
      for (const rule of this.rules) {
        if (rule.priority < repeatedDetectorPriority) continue;
        if (evaluateRule(rule)) break;
      }
    }

    if (!rawHint || !matchedRule) {
      // Feed the learner even on miss
      this.learner.onToolComplete(toolName, isError, episodeContext);
      if (isError) {
        this.learner.onMiss(toolName, resultText, episodeContext);
      }
      this.log({ timestamp: Date.now(), toolName, isError, matchedRule: null, hint: null, severity: null, fireCount: 0 });
      return null;
    }

    // Track fire count per rule, scoped by sessionId when available
    const matchedKey = escalationKey(matchedRule);
    const fireCount = (this.hintEscalation.get(matchedKey) || 0) + 1;
    this.hintEscalation.set(matchedKey, fireCount);

    const severity = this.getSeverity(fireCount, matchedMaxSeverity);
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

    // Feed the learner. Learned episode hints are advisory, so keep watching
    // whether the caller's next different successful tool verifies that
    // recovery path again. Static rules remain non-authoritative hints only.
    this.learner.onToolComplete(toolName, isError, episodeContext);
    if (isError && matchedRule === 'learned-pattern') {
      this.learner.onMiss(toolName, resultText, episodeContext);
    }

    this.log({ timestamp: Date.now(), toolName, isError, matchedRule, hint: formattedHint, severity, fireCount });
    if (mapHintRuleToRecoveryCategory(matchedRule, resultText) !== 'unknown') {
      this.recordRecoveryFeedback(matchedRule, rawHint, severity, fireCount, toolName, resultText, isError, hintSessionId, recentCalls);
    }

    return hintResult;
  }

  private recordRecoveryFeedback(
    rule: string,
    rawHint: string,
    severity: HintSeverity,
    fireCount: number,
    toolName: string,
    resultText: string,
    isError: boolean,
    sessionId: string,
    recentCalls: ToolCallEvent[],
  ): void {
    if (!this.recoveryFeedback) return;
    const now = Date.now();
    const category = mapHintRuleToRecoveryCategory(rule, resultText);
    this.recoveryFeedback.append({
      sessionId,
      startedAt: now,
      endedAt: now,
      trigger: {
        tool: toolName,
        category,
        errorFingerprint: resultText,
        resultExcerpt: resultText,
      },
      context: {
        recentTools: recentCalls.map((call) => call.toolName),
        nonProgressCalls: category === 'non_progress' ? fireCount : 0,
      },
      hints: [{ rule, severity, rawHint }],
      recovery: {
        attemptedTools: [],
        succeeded: false,
        attempts: 0,
        durationMs: 0,
      },
      outcome: {
        finalStatus: isError || category === 'non_progress' ? 'failed' : 'escalated',
        feedback: category === 'blocked_page'
          ? 'blocked_page detected; no recovery attempted; escalated to host/user'
          : undefined,
      },
      traceRefs: [],
    });
  }

  private formatLedgerHint(ledger: TaskLedger): string | null {
    return this.taskLedger.buildHint(ledger);
  }

  private getSeverity(fireCount: number, maxSeverity?: HintSeverity): HintSeverity {
    const raw: HintSeverity = fireCount <= 2 ? 'info' : fireCount <= 4 ? 'warning' : 'critical';
    if (!maxSeverity) return raw;
    const order: HintSeverity[] = ['info', 'warning', 'critical'];
    return order.indexOf(raw) <= order.indexOf(maxSeverity) ? raw : maxSeverity;
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
    const coordMatch = resultText.match(/\((\d+),\s*(\d+)\)/);
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
    const toolMatch = rawHint.match(/\b(?:Use|Try|Prefer)\s+(\w+)(?:\(|[\s,.])/i);
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
    if (!this.logFilePath) return;
    this.logBuffer.push(JSON.stringify(entry) + '\n');
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushBuffer();
      }, HintEngine.FLUSH_INTERVAL);
    }
  }

  /**
   * Flush buffered log entries to disk.
   *
   * Use a synchronous append for the tiny buffered JSONL payloads so destroy()
   * is deterministic for shutdown and tests. A WriteStream may acknowledge
   * end() asynchronously, which can leave readers racing an empty/missing file.
   */
  private flushBuffer(): void {
    if (this.logBuffer.length > 0 && this.logFilePath) {
      const data = this.logBuffer.join('');
      fs.appendFileSync(this.logFilePath, data, 'utf-8');
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
