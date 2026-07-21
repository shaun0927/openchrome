/**
 * PatternLearner event-types (mem0 idiom) tests.
 *
 * Verifies:
 *  - ADD/UPDATE/DELETE/NOOP builders produce well-shaped events.
 *  - diffPatterns returns null when identical, populated diff when changed.
 *  - PatternLearnerEventBus delivers events, unsubscribes, isolates errors.
 */

import type { LearnedPattern } from '../../src/hints/pattern-learner';
import {
  PatternLearnerEventBus,
  buildAddEvent,
  buildUpdateEvent,
  buildDeleteEvent,
  buildNoopEvent,
  diffPatterns,
  type PatternLearnerEvent,
} from '../../src/hints/pattern-learner-events';

function makePattern(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    id: 'p1',
    errorFingerprint: 'target detached',
    errorTools: ['click'],
    recoveryTool: 'reload',
    occurrences: 3,
    confidence: 0.75,
    firstSeen: 1,
    lastSeen: 2,
    hint: 'Hint: Try reload — learned from 3 previous recoveries.',
    ...overrides,
  };
}

describe('pattern-learner-events', () => {
  describe('diffPatterns', () => {
    it('returns null when nothing changed', () => {
      const p = makePattern();
      expect(diffPatterns(p, p)).toBeNull();
      expect(diffPatterns(p, { ...p })).toBeNull();
    });

    it('reports recoveryTool change', () => {
      const before = makePattern({ recoveryTool: 'reload' });
      const after = makePattern({ recoveryTool: 'navigate' });
      const diff = diffPatterns(before, after);
      expect(diff?.recoveryTool).toEqual({ from: 'reload', to: 'navigate' });
    });

    it('reports numeric field changes', () => {
      const before = makePattern({ occurrences: 3, confidence: 0.5 });
      const after = makePattern({ occurrences: 4, confidence: 0.8 });
      const diff = diffPatterns(before, after);
      expect(diff?.occurrences).toEqual({ from: 3, to: 4 });
      expect(diff?.confidence).toEqual({ from: 0.5, to: 0.8 });
    });

    it('treats errorTools as an unordered set', () => {
      const before = makePattern({ errorTools: ['click', 'type'] });
      const after = makePattern({ errorTools: ['type', 'click'] });
      expect(diffPatterns(before, after)).toBeNull();
    });

    it('reports errorTools membership change', () => {
      const before = makePattern({ errorTools: ['click'] });
      const after = makePattern({ errorTools: ['click', 'navigate'] });
      const diff = diffPatterns(before, after);
      expect(diff?.errorTools?.from).toEqual(['click']);
      expect(diff?.errorTools?.to).toEqual(['click', 'navigate']);
    });
  });

  describe('event builders', () => {
    it('buildAddEvent produces ADD with pattern metadata', () => {
      const evt = buildAddEvent(makePattern());
      expect(evt.kind).toBe('ADD');
      expect(evt.patternId).toBe('p1');
      expect(evt.errorFingerprint).toBe('target detached');
      expect(evt.recoveryTool).toBe('reload');
      expect(evt.confidence).toBe(0.75);
      expect(new Date(evt.at).toString()).not.toBe('Invalid Date');
    });

    it('buildUpdateEvent returns null when nothing changed', () => {
      const p = makePattern();
      expect(buildUpdateEvent(p, p)).toBeNull();
    });

    it('buildUpdateEvent emits UPDATE with populated diff', () => {
      const before = makePattern({ confidence: 0.6 });
      const after = makePattern({ confidence: 0.9 });
      const evt = buildUpdateEvent(before, after);
      expect(evt?.kind).toBe('UPDATE');
      expect(evt?.changed?.confidence).toEqual({ from: 0.6, to: 0.9 });
    });

    it('buildDeleteEvent produces DELETE with pattern metadata', () => {
      const evt = buildDeleteEvent(makePattern());
      expect(evt.kind).toBe('DELETE');
      expect(evt.patternId).toBe('p1');
    });

    it('buildNoopEvent carries a structured reason', () => {
      const evt = buildNoopEvent('threshold_not_met', { errorFingerprint: 'x' });
      expect(evt.kind).toBe('NOOP');
      expect(evt.reason).toBe('threshold_not_met');
      expect(evt.errorFingerprint).toBe('x');
      expect(evt.patternId).toBeUndefined();
    });
  });

  describe('PatternLearnerEventBus', () => {
    it('delivers events to every listener', () => {
      const bus = new PatternLearnerEventBus();
      const received: PatternLearnerEvent[] = [];
      bus.on((e) => received.push(e));
      bus.on((e) => received.push(e));
      bus.emit(buildAddEvent(makePattern()));
      expect(received.length).toBe(2);
      expect(received.every((e) => e.kind === 'ADD')).toBe(true);
    });

    it('unsubscribes on the returned disposer', () => {
      const bus = new PatternLearnerEventBus();
      const received: PatternLearnerEvent[] = [];
      const off = bus.on((e) => received.push(e));
      off();
      bus.emit(buildDeleteEvent(makePattern()));
      expect(received.length).toBe(0);
      expect(bus.listenerCount()).toBe(0);
    });

    it('isolates listener errors so one bad consumer cannot block the next', () => {
      const bus = new PatternLearnerEventBus();
      const received: string[] = [];
      bus.on(() => {
        throw new Error('boom');
      });
      bus.on((e) => received.push(e.kind));
      bus.emit(buildNoopEvent('no_change'));
      expect(received).toEqual(['NOOP']);
    });
  });
});
