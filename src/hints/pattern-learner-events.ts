/**
 * PatternLearner event types (mem0 idiom alignment).
 *
 * mem0 (Apache-2.0, https://github.com/mem0ai/mem0) frames every memory
 * mutation as one of four discrete events:
 *
 *   ADD    — a brand-new memory is created.
 *   UPDATE — an existing memory is refined (fields change but identity holds).
 *   DELETE — an existing memory is retired (evicted or contradicted).
 *   NOOP   — the input was observed but no mutation occurred.
 *
 * openchrome's `PatternLearner` learns error→recovery patterns and mutates a
 * durable JSON store. Prior to this pack the mutations were implicit: callers
 * had no structured way to react to "a new pattern was promoted" versus "an
 * existing pattern was refined" versus "nothing changed". This module exposes
 * the discrete event shape without altering the existing algorithm — it is a
 * clean-room re-implementation of the mem0 event taxonomy, not a copy of mem0
 * source.
 *
 * Reference: mem0 "Add Memories" and "Update Memory" flows.
 * Origin credit: the ADD/UPDATE/DELETE/NOOP quadruple originates in mem0.
 */

import type { LearnedPattern } from './pattern-learner';

/**
 * The four mem0-aligned event kinds a `PatternLearner` mutation can emit.
 */
export type PatternLearnerEventKind = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

/**
 * Metadata that accompanies every event. Kept intentionally small so it can
 * be logged, sent over the MCP transport, or fed back into the hint engine
 * without leaking large payloads.
 */
export interface PatternLearnerEvent {
  kind: PatternLearnerEventKind;
  /** ISO timestamp string. Present on every event. */
  at: string;
  /** Pattern id (present for ADD/UPDATE/DELETE, absent for NOOP). */
  patternId?: string;
  /** Error fingerprint the event was triggered by. */
  errorFingerprint?: string;
  /** Tool the recovery pattern points at. */
  recoveryTool?: string;
  /** Confidence at the time of the event (0..1). */
  confidence?: number;
  /** For UPDATE: fields that changed. */
  changed?: PatternLearnerChangeSet;
  /** For NOOP: why nothing happened. */
  reason?: string;
}

/**
 * The subset of `LearnedPattern` fields a mutation may touch. Callers get a
 * before/after view per changed field rather than a full snapshot, matching
 * the mem0 change-log shape.
 */
export interface PatternLearnerChangeSet {
  recoveryTool?: { from: string; to: string };
  occurrences?: { from: number; to: number };
  confidence?: { from: number; to: number };
  errorTools?: { from: string[]; to: string[] };
  hint?: { from: string; to: string };
}

export interface PatternLearnerEventListener {
  (event: PatternLearnerEvent): void;
}

/**
 * Reasons the learner may emit a NOOP. Kept as a closed union so downstream
 * consumers can switch exhaustively.
 */
export type PatternLearnerNoopReason =
  | 'threshold_not_met'
  | 'confidence_not_met'
  | 'duplicate_observation'
  | 'watch_window_expired'
  | 'no_change';

/**
 * Compute the diff between two learned patterns and return a change set.
 * Only fields that differ are populated. If nothing changed, returns null so
 * the caller can emit a NOOP instead of an UPDATE.
 */
export function diffPatterns(
  before: LearnedPattern,
  after: LearnedPattern,
): PatternLearnerChangeSet | null {
  const changed: PatternLearnerChangeSet = {};
  let touched = false;

  if (before.recoveryTool !== after.recoveryTool) {
    changed.recoveryTool = { from: before.recoveryTool, to: after.recoveryTool };
    touched = true;
  }
  if (before.occurrences !== after.occurrences) {
    changed.occurrences = { from: before.occurrences, to: after.occurrences };
    touched = true;
  }
  if (before.confidence !== after.confidence) {
    changed.confidence = { from: before.confidence, to: after.confidence };
    touched = true;
  }
  if (!sameStringSet(before.errorTools, after.errorTools)) {
    changed.errorTools = {
      from: [...before.errorTools],
      to: [...after.errorTools],
    };
    touched = true;
  }
  if (before.hint !== after.hint) {
    changed.hint = { from: before.hint, to: after.hint };
    touched = true;
  }

  return touched ? changed : null;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/**
 * Build an ADD event from a freshly promoted pattern.
 */
export function buildAddEvent(pattern: LearnedPattern): PatternLearnerEvent {
  return {
    kind: 'ADD',
    at: new Date().toISOString(),
    patternId: pattern.id,
    errorFingerprint: pattern.errorFingerprint,
    recoveryTool: pattern.recoveryTool,
    confidence: pattern.confidence,
  };
}

/**
 * Build an UPDATE event from a before/after pair. Returns null when the diff
 * is empty — callers should emit `buildNoopEvent('no_change')` in that case.
 */
export function buildUpdateEvent(
  before: LearnedPattern,
  after: LearnedPattern,
): PatternLearnerEvent | null {
  const changed = diffPatterns(before, after);
  if (!changed) return null;
  return {
    kind: 'UPDATE',
    at: new Date().toISOString(),
    patternId: after.id,
    errorFingerprint: after.errorFingerprint,
    recoveryTool: after.recoveryTool,
    confidence: after.confidence,
    changed,
  };
}

/**
 * Build a DELETE event for a retired pattern.
 */
export function buildDeleteEvent(pattern: LearnedPattern): PatternLearnerEvent {
  return {
    kind: 'DELETE',
    at: new Date().toISOString(),
    patternId: pattern.id,
    errorFingerprint: pattern.errorFingerprint,
    recoveryTool: pattern.recoveryTool,
    confidence: pattern.confidence,
  };
}

/**
 * Build a NOOP event with a structured reason.
 */
export function buildNoopEvent(
  reason: PatternLearnerNoopReason,
  ctx?: { errorFingerprint?: string },
): PatternLearnerEvent {
  return {
    kind: 'NOOP',
    at: new Date().toISOString(),
    errorFingerprint: ctx?.errorFingerprint,
    reason,
  };
}

/**
 * A tiny in-process emitter. The learner keeps a listener list and fans out
 * events synchronously. Kept synchronous to preserve the existing
 * single-threaded call ordering — callers that need async fan-out can wrap
 * the listener.
 */
export class PatternLearnerEventBus {
  private listeners: PatternLearnerEventListener[] = [];

  on(listener: PatternLearnerEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  emit(event: PatternLearnerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are isolated so one bad consumer cannot break
        // the learner's mutation loop.
      }
    }
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}
