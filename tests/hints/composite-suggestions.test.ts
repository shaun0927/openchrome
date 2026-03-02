/**
 * Composite Suggestions — tests for inspect-tool suggestion rules (issue #132).
 */

import { ActivityTracker } from '../../src/dashboard/activity-tracker';
import { HintEngine } from '../../src/hints/hint-engine';

function makeResult(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: isError ? `Error: ${text}` : text }],
    ...(isError && { isError: true }),
  };
}

function makeTracker(
  calls: Array<{ toolName: string; args?: Record<string, unknown>; result?: 'success' | 'error'; error?: string }> = []
): ActivityTracker {
  const tracker = new ActivityTracker();
  // Seed completed calls (most recent first in getRecentCalls)
  for (const call of [...calls].reverse()) {
    const id = tracker.startCall(call.toolName, 'test', call.args);
    tracker.endCall(id, call.result || 'success', call.error);
  }
  return tracker;
}

describe('composite-suggestions: inspect-tool rules', () => {
  describe('Rule A: state-check-after-action (priority 206)', () => {
    it('navigate → read_page should trigger inspect hint', () => {
      const tracker = makeTracker([{ toolName: 'navigate' }]);
      const engine = new HintEngine(tracker);
      // Warm up to consume setup-permission-hint (priority 90, fires once)
      engine.getHint('navigate', makeResult('warmup'), false);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.rule).toBe('state-check-after-action');
      expect(hint!.hint).toContain('inspect(query)');
      expect(hint!.hint).toContain('after actions');
    });

    it('click_element → read_page should trigger inspect hint', () => {
      const tracker = makeTracker([{ toolName: 'click_element' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.rule).toBe('state-check-after-action');
      expect(hint!.hint).toContain('inspect(query)');
    });

    it('wait_and_click → read_page should trigger inspect hint', () => {
      const tracker = makeTracker([{ toolName: 'wait_and_click' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.rule).toBe('state-check-after-action');
      expect(hint!.hint).toContain('inspect(query)');
    });

    it('interact → read_page should trigger inspect hint', () => {
      const tracker = makeTracker([{ toolName: 'interact' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.rule).toBe('state-check-after-action');
      expect(hint!.hint).toContain('inspect(query)');
    });

    it('read_page without prior navigation/action should NOT trigger state-check-after-action', () => {
      const tracker = makeTracker([{ toolName: 'find' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      // state-check-after-action should not fire — find is not a triggering action
      if (hint) {
        expect(hint.rule).not.toBe('state-check-after-action');
      }
    });

    it('read_page with no prior calls should NOT trigger state-check-after-action', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      if (hint) {
        expect(hint.rule).not.toBe('state-check-after-action');
      }
    });
  });

  describe('Rule B: repeated-read-page (priority 207)', () => {
    it('3rd read_page call should trigger repeated-read-page hint', () => {
      const tracker = makeTracker([
        { toolName: 'read_page' },
        { toolName: 'read_page' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.hint).toContain('inspect(query)');
      expect(hint!.hint).toContain('repeated full page reads');
    });

    it('1st read_page call should NOT trigger repeated-read-page hint', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      if (hint) {
        expect(hint.rule).not.toBe('repeated-read-page');
      }
    });

    it('2nd read_page call (1 in history) should NOT trigger repeated-read-page', () => {
      const tracker = makeTracker([{ toolName: 'read_page' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      // state-check-after-action fires if prior tool was read_page? No — read_page is not in action list.
      // repeated-read-page requires >= 2 in recent history (the current call is not yet in tracker).
      if (hint) {
        expect(hint.rule).not.toBe('repeated-read-page');
      }
    });

    it('repeated-read-page hint includes inspect usage examples', () => {
      const tracker = makeTracker([
        { toolName: 'read_page' },
        { toolName: 'read_page' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content here');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.hint).toContain('inspect("what tabs are active")');
      expect(hint!.hint).toContain('inspect("visible errors")');
    });
  });

  describe('Rule C: read-page-truncated (priority 203) — enhanced', () => {
    it('truncated read_page should mention inspect AND find AND dom', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Page content here... truncated at 5000 chars');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.rule).toBe('read-page-truncated');
      expect(hint!.hint).toContain('inspect(query)');
      expect(hint!.hint).toContain('find(query)');
      expect(hint!.hint).toContain('mode="dom"');
    });

    it('truncated read_page hint mentions "targeted state checks"', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('content too large to display');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).not.toBeNull();
      expect(hint!.hint).toContain('targeted state checks');
    });

    it('non-truncated read_page should NOT trigger read-page-truncated', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Normal page content that fits fine');
      const hint = engine.getHint('read_page', result, false);
      if (hint) {
        expect(hint.rule).not.toBe('read-page-truncated');
      }
    });
  });
});
