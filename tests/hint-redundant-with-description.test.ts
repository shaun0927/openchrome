/// <reference types="jest" />
/**
 * Issue #841 — hint engine suppresses rules tagged `redundant_with_description`
 * once the client has consumed tools/list (descriptions delivered).
 *
 * Uses the live `find-then-click` composite-suggestion rule (which is tagged
 * `redundant_with_description: true` by this PR) and a stub ActivityTracker
 * that yields a synthetic call history.
 */

import { HintEngine } from '../src/hints/hint-engine';
import type { ActivityTracker } from '../src/dashboard/activity-tracker';

interface ToolCallEvent {
  callId: string;
  toolName: string;
  sessionId?: string;
  startTime: number;
  endTime?: number;
  isError?: boolean;
}

/**
 * Minimal stub: only `getRecentCalls` is used by HintEngine. Other methods
 * are no-ops to satisfy the ActivityTracker type at the cast site.
 */
function makeStubTracker(recent: ToolCallEvent[]): ActivityTracker {
  const stub: Partial<ActivityTracker> = {
    getRecentCalls: () => recent as unknown as ToolCallEvent[] as any,
  };
  return stub as ActivityTracker;
}

describe('Hint engine — redundant_with_description suppression (#841)', () => {
  const findCall: ToolCallEvent = {
    callId: 'c1',
    toolName: 'find',
    startTime: Date.now() - 1000,
    endTime: Date.now() - 500,
    isError: false,
  };

  test('find-then-click rule is registered and tagged redundant_with_description', () => {
    // Sanity precondition for the suppression test below: the rule must exist
    // and carry the tag. Without this, the suppression test could pass
    // vacuously if the rule were removed or renamed.
    const tracker = makeStubTracker([findCall]);
    const engine = new HintEngine(tracker);

    const rule = engine.getRules().find((r) => r.name === 'find-then-click');
    expect(rule).toBeDefined();
    expect(rule!.redundant_with_description).toBe(true);
  });

  test('hasServedToolsList starts false', () => {
    const tracker = makeStubTracker([findCall]);
    const engine = new HintEngine(tracker);
    expect(engine.hasServedToolsList()).toBe(false);
  });

  test('find-then-click rule is suppressed AFTER markToolsListServed()', () => {
    const tracker = makeStubTracker([findCall]);
    const engine = new HintEngine(tracker);

    engine.markToolsListServed();
    expect(engine.hasServedToolsList()).toBe(true);

    const result = engine.getHint(
      'computer',
      { content: [{ type: 'text', text: 'clicked at (10, 10)' }] },
      false,
    );

    // The rule that would have fired is now suppressed. Some lower-priority
    // rule MAY match, but it must not be `find-then-click`.
    if (result !== null) {
      expect(result.rule).not.toBe('find-then-click');
    }
  });

  test('tools/list suppression is scoped to the session that consumed descriptions', () => {
    const tracker = makeStubTracker([findCall]);
    const engine = new HintEngine(tracker);

    engine.markToolsListServed('session-a');
    expect(engine.hasServedToolsList('session-a')).toBe(true);
    expect(engine.hasServedToolsList('session-b')).toBe(false);

    const suppressed = engine.getHint(
      'computer',
      { content: [{ type: 'text', text: 'clicked at (10, 10)' }] },
      false,
      'session-a',
    );
    if (suppressed !== null) {
      expect(suppressed.rule).not.toBe('find-then-click');
    }

    const visible = engine.getHint(
      'computer',
      { content: [{ type: 'text', text: 'clicked at (10, 10)' }] },
      false,
      'session-b',
    );
    expect(visible).not.toBeNull();
    expect(visible!.rule).toBe('find-then-click');
  });

  test('rules WITHOUT redundant_with_description still fire after markToolsListServed', () => {
    // Drive a scenario where progress-tracker emits "stalling" / a non-tagged
    // rule fires. The simplest is the multiple-form-input rule — it is
    // tagged in this PR, so we use coordinate-click-after-read instead
    // (NOT tagged). Setup: a computer call whose resultText contains the
    // hot phrases from rule body.
    const tracker = makeStubTracker([]);
    const engine = new HintEngine(tracker);
    engine.markToolsListServed();

    const result = engine.getHint(
      'computer',
      {
        content: [
          {
            type: 'text',
            text: 'Clicked at (50, 100) [not interactive]',
          },
        ],
      },
      false,
    );

    expect(result).not.toBeNull();
    expect(result!.rule).toBe('coordinate-click-after-read');
  });

  test('exactly 4 rules carry the redundant_with_description tag in this PR', () => {
    // Sanity check: the tag is rare and intentional. Regressions that
    // accidentally tag too many rules will fail this assertion.
    const tracker = makeStubTracker([]);
    const engine = new HintEngine(tracker);
    const taggedCount = engine
      .getRules()
      .filter((r) => r.redundant_with_description === true).length;
    expect(taggedCount).toBe(4);
  });
});
