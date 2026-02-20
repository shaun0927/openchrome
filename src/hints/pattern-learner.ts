/**
 * PatternLearner — Adaptive memory system that learns error→recovery patterns.
 *
 * Flow:
 * 1. Hint miss on error → start observing next 3 tool calls
 * 2. If a different tool succeeds → record as recovery pattern
 * 3. Same error→recovery seen N times → promote to learned rule
 * 4. Persisted to JSON, survives across sessions
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LearnedPattern {
  id: string;
  errorFingerprint: string;
  errorTools: string[];
  recoveryTool: string;
  occurrences: number;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  hint: string;
}

interface PendingObservation {
  errorTool: string;
  errorFingerprint: string;
  timestamp: number;
  remainingSlots: number;
}

interface RawObservation {
  errorFingerprint: string;
  errorTools: Set<string>;
  recoveryTools: Map<string, number>;
  totalObservations: number;
}

interface PatternStore {
  version: number;
  patterns: LearnedPattern[];
  updatedAt: number;
}

export class PatternLearner {
  private pending: PendingObservation[] = [];
  private rawObservations: Map<string, RawObservation> = new Map();
  private patterns: LearnedPattern[] = [];
  private filePath: string | null = null;
  private dirty = false;

  static readonly WATCH_WINDOW = 3;
  static readonly PROMOTE_THRESHOLD = 3;
  static readonly CONFIDENCE_THRESHOLD = 0.6;
  static readonly MAX_PENDING = 10;

  /**
   * Enable persistence — load existing patterns and save new ones.
   */
  enablePersistence(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      this.filePath = path.join(dirPath, 'learned-patterns.json');
      this.load();
    } catch {
      // Best-effort
    }
  }

  /**
   * Called when a hint miss occurs on an error (no static rule matched).
   * Starts observing subsequent calls to detect recovery pattern.
   */
  onMiss(toolName: string, errorText: string): void {
    const fingerprint = this.normalizeError(errorText);
    if (!fingerprint) return;

    // Limit pending observations to prevent memory buildup
    if (this.pending.length >= PatternLearner.MAX_PENDING) {
      this.pending.shift();
    }

    this.pending.push({
      errorTool: toolName,
      errorFingerprint: fingerprint,
      timestamp: Date.now(),
      remainingSlots: PatternLearner.WATCH_WINDOW,
    });
  }

  /**
   * Called on every tool completion to observe potential recovery patterns.
   */
  onToolComplete(toolName: string, isError: boolean): void {
    const resolved: number[] = [];

    for (let i = 0; i < this.pending.length; i++) {
      const obs = this.pending[i];

      if (!isError && toolName !== obs.errorTool) {
        // Success with different tool = potential recovery
        this.recordRecovery(obs.errorFingerprint, obs.errorTool, toolName);
        resolved.push(i);
      } else if (!isError && toolName === obs.errorTool) {
        // Same tool succeeded = self-resolved, discard
        resolved.push(i);
      } else {
        // Another error, keep watching
        obs.remainingSlots--;
        if (obs.remainingSlots <= 0) resolved.push(i);
      }
    }

    // Remove resolved observations (reverse order to preserve indices)
    for (let i = resolved.length - 1; i >= 0; i--) {
      this.pending.splice(resolved[i], 1);
    }
  }

  /**
   * Record an observed error→recovery correlation.
   */
  private recordRecovery(errorFingerprint: string, errorTool: string, recoveryTool: string): void {
    let raw = this.rawObservations.get(errorFingerprint);
    if (!raw) {
      raw = {
        errorFingerprint,
        errorTools: new Set(),
        recoveryTools: new Map(),
        totalObservations: 0,
      };
      this.rawObservations.set(errorFingerprint, raw);
    }

    raw.errorTools.add(errorTool);
    raw.recoveryTools.set(recoveryTool, (raw.recoveryTools.get(recoveryTool) || 0) + 1);
    raw.totalObservations++;

    this.tryPromote(raw);
  }

  /**
   * Check if a raw observation should be promoted to a learned pattern.
   */
  private tryPromote(raw: RawObservation): void {
    let bestTool = '';
    let bestCount = 0;
    for (const [tool, count] of raw.recoveryTools) {
      if (count > bestCount) {
        bestTool = tool;
        bestCount = count;
      }
    }

    const confidence = bestCount / raw.totalObservations;

    if (bestCount < PatternLearner.PROMOTE_THRESHOLD || confidence < PatternLearner.CONFIDENCE_THRESHOLD) {
      return;
    }

    const existing = this.patterns.find(p => p.errorFingerprint === raw.errorFingerprint);
    if (existing) {
      existing.occurrences = bestCount;
      existing.confidence = confidence;
      existing.recoveryTool = bestTool;
      existing.lastSeen = Date.now();
      existing.errorTools = Array.from(raw.errorTools);
      existing.hint = PatternLearner.generateHint(bestTool, bestCount);
    } else {
      this.patterns.push({
        id: `learned-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        errorFingerprint: raw.errorFingerprint,
        errorTools: Array.from(raw.errorTools),
        recoveryTool: bestTool,
        occurrences: bestCount,
        confidence,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        hint: PatternLearner.generateHint(bestTool, bestCount),
      });
    }

    this.dirty = true;
    this.save();
  }

  /**
   * Match an error against learned patterns.
   */
  matchPattern(errorText: string, toolName: string): LearnedPattern | null {
    const fingerprint = this.normalizeError(errorText);
    for (const pattern of this.patterns) {
      if (
        pattern.errorTools.includes(toolName) &&
        (fingerprint.includes(pattern.errorFingerprint) || pattern.errorFingerprint.includes(fingerprint))
      ) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Normalize error text for fingerprinting.
   * Strips dynamic values (IDs, large numbers) to group similar errors.
   */
  normalizeError(text: string): string {
    return text
      .toLowerCase()
      .replace(/\b[0-9a-f]{8,}\b/g, '{id}')
      .replace(/\d{4,}/g, '{n}')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  /**
   * Get all learned patterns (for testing/inspection).
   */
  getPatterns(): LearnedPattern[] {
    return this.patterns;
  }

  /**
   * Get pending observation count (for testing).
   */
  getPendingCount(): number {
    return this.pending.length;
  }

  static generateHint(recoveryTool: string, occurrences: number): string {
    return `Hint: Try ${recoveryTool} — learned from ${occurrences} previous recoveries.`;
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const store: PatternStore = JSON.parse(data);
      this.patterns = store.patterns || [];
    } catch {
      this.patterns = [];
    }
  }

  /**
   * Persist learned patterns to disk.
   */
  save(): void {
    if (!this.filePath || !this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const store: PatternStore = {
        version: 1,
        patterns: this.patterns,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
      this.dirty = false;
    } catch {
      // Best-effort
    }
  }
}
