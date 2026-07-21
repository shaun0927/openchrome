import { describe, expect, it } from '@jest/globals';
import { PatternLearner } from '../../src/hints/pattern-learner';
import type { PatternLearnerEvent } from '../../src/hints/pattern-learner-events';

/**
 * Wiring test for the mem0-idiom event bus inside PatternLearner (#25 pack).
 *
 * The events module used to be dead code — the learner mutated `patterns`
 * without emitting anything. These tests exercise the real learner and assert
 * that every mutation path (promote-new, refine-existing, no-op below
 * threshold, forget) fires the correct event kind.
 */
describe('PatternLearner event wiring (mem0 idiom)', () => {
  function driveObservations(learner: PatternLearner, errorFingerprintText: string, recoveryTool: string, times: number) {
    for (let i = 0; i < times; i++) {
      learner.onMiss('errTool', errorFingerprintText);
      // A successful call with a DIFFERENT tool is what counts as a recovery.
      learner.onToolComplete(recoveryTool, false);
    }
  }

  it('emits ADD when a new pattern crosses the promotion threshold', () => {
    const learner = new PatternLearner();
    const events: PatternLearnerEvent[] = [];
    learner.onPatternEvent((e) => events.push(e));

    // Need 3 successful recoveries to promote (PROMOTE_THRESHOLD = 3).
    driveObservations(learner, 'connection timed out', 'reconnect', 3);

    const adds = events.filter((e) => e.kind === 'ADD');
    expect(adds.length).toBe(1);
    expect(adds[0].recoveryTool).toBe('reconnect');
    expect(adds[0].patternId).toBeDefined();
  });

  it('emits NOOP with threshold_not_met before the promotion threshold', () => {
    const learner = new PatternLearner();
    const events: PatternLearnerEvent[] = [];
    learner.onPatternEvent((e) => events.push(e));

    driveObservations(learner, 'net idle failed', 'wait_for_selector', 2);

    const noops = events.filter((e) => e.kind === 'NOOP');
    expect(noops.length).toBeGreaterThanOrEqual(1);
    expect(noops.every((e) => e.reason === 'threshold_not_met')).toBe(true);
    expect(events.some((e) => e.kind === 'ADD')).toBe(false);
  });

  it('emits UPDATE when an existing pattern is refined by additional observations', () => {
    const learner = new PatternLearner();
    // Promote first.
    driveObservations(learner, 'nav race', 'retry_nav', 3);
    // Now attach the listener so we only see the refinement events.
    const events: PatternLearnerEvent[] = [];
    learner.onPatternEvent((e) => events.push(e));
    // Two more recoveries should refine the same pattern.
    driveObservations(learner, 'nav race', 'retry_nav', 2);
    const updates = events.filter((e) => e.kind === 'UPDATE');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].changed).toBeDefined();
  });

  it('emits DELETE via forgetPattern and NOOP(not_found) for unknown ids', () => {
    const learner = new PatternLearner();
    driveObservations(learner, 'auth expired', 're_login', 3);
    const events: PatternLearnerEvent[] = [];
    learner.onPatternEvent((e) => events.push(e));

    // Grab the id from the exported patterns.
    const patterns = (learner as any).patterns as Array<{ id: string; errorFingerprint: string }>;
    const target = patterns.find((p) => p.errorFingerprint.includes('auth'));
    expect(target).toBeDefined();
    const removed = learner.forgetPattern(target!.id);
    expect(removed).toBe(true);
    expect(events.some((e) => e.kind === 'DELETE')).toBe(true);

    const missing = learner.forgetPattern('bogus-id');
    expect(missing).toBe(false);
    expect(events.some((e) => e.kind === 'NOOP' && e.reason === 'not_found')).toBe(true);
  });

  it('unsubscribes cleanly and reports listener count', () => {
    const learner = new PatternLearner();
    expect(learner.patternEventListenerCount()).toBe(0);
    const off1 = learner.onPatternEvent(() => {});
    const off2 = learner.onPatternEvent(() => {});
    expect(learner.patternEventListenerCount()).toBe(2);
    off1();
    expect(learner.patternEventListenerCount()).toBe(1);
    off2();
    expect(learner.patternEventListenerCount()).toBe(0);
  });
});
