/**
 * Per-CDP-target replay-artifact recorder buffer (#875).
 *
 * Action tools (`interact`, `fill_form`, `form_input`, `navigate`) call
 * `capture(targetId, step)` after a successful resolution when their caller
 * passes `capture_artifact: true`. The buffer is bounded (`MAX_STEPS`, FIFO)
 * so a long-running session can't grow unboundedly, and `flush(targetId)`
 * removes every entry destructively so artifacts never leak across skills.
 *
 * The buffer lives at module scope on purpose — a single OpenChrome process
 * supervises every CDP target it spawns and we need a one-stop sink that
 * tool dispatch can write into without re-plumbing context through every
 * action.
 *
 * Per the portability-harness contract (P2): when `capture_artifact` is
 * omitted, action tool responses are byte-identical to v1.11.0. Nothing in
 * this module mutates a tool response — it only stages a record for the
 * eventual `oc_skill_record` flush.
 */

import type { ReplayArtifactStep } from './replay-artifact';

/** Cap per target. 100 covers realistic skills (10–40 steps) with headroom. */
export const MAX_STEPS_PER_TARGET = 100;

/** Buffered entries are wall-clock-stamped so `flush()` can return ordered. */
interface BufferedStep {
  step: ReplayArtifactStep;
  capturedAt: number;
}

const buffers = new Map<string, BufferedStep[]>();

/**
 * Append a step to the buffer for the given CDP target. FIFO-evicts when the
 * buffer is at capacity. Safe to call from any action tool's success path.
 *
 * `targetId` is the CDP target id (puppeteer-core `target()._targetId`).
 * Callers pass an empty string when no target is available (e.g. host-side
 * synthetic actions) — those entries are dropped silently rather than
 * polluting an unrelated buffer.
 */
export function capture(targetId: string, step: ReplayArtifactStep): void {
  if (typeof targetId !== 'string' || targetId.length === 0) return;
  let buf = buffers.get(targetId);
  if (!buf) {
    buf = [];
    buffers.set(targetId, buf);
  }
  if (buf.length >= MAX_STEPS_PER_TARGET) {
    buf.shift();
  }
  buf.push({ step, capturedAt: Date.now() });
}

/**
 * Read-only peek used by tests and diagnostics. Returns the steps in capture
 * order; does NOT clear the buffer.
 */
export function peek(targetId: string): ReplayArtifactStep[] {
  const buf = buffers.get(targetId);
  if (!buf) return [];
  return buf.map((e) => e.step);
}

/**
 * Destructive flush. Returns every buffered step in capture order and
 * removes the buffer entry for the target. Called by `oc_skill_record`
 * after it has persisted the new skill so the next session starts clean.
 *
 * Also called from target-close hooks so a tab being destroyed releases its
 * staged steps immediately. Safe to call when there is no buffer for the id.
 */
export function flush(targetId: string): ReplayArtifactStep[] {
  if (typeof targetId !== 'string' || targetId.length === 0) return [];
  const buf = buffers.get(targetId);
  if (!buf) return [];
  buffers.delete(targetId);
  return buf.map((e) => e.step);
}

/** Test helper: drop every buffer regardless of target. */
export function resetAll(): void {
  buffers.clear();
}

/** Diagnostic helper used by `inspect`-style tools and tests. */
export function bufferSize(targetId: string): number {
  return buffers.get(targetId)?.length ?? 0;
}
