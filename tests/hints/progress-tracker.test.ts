/**
 * ProgressTracker unit tests
 * Verifies evaluate(), isProgressResult(), and edge cases.
 */

import { ProgressTracker, NON_PROGRESS_SIGNALS } from '../../src/hints/progress-tracker';
import type { ToolCallEvent } from '../../src/dashboard/types';

let _idCounter = 0;

const mockCall = (
  toolName: string,
  result: 'success' | 'error' = 'success',
  error?: string,
): ToolCallEvent => ({
  id: `call-${Date.now()}-${++_idCounter}`,
  toolName,
  sessionId: 'test',
  startTime: Date.now(),
  endTime: Date.now() + 1000,
  duration: 1000,
  result,
  ...(error && { error }),
});

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  describe('evaluate() — progressing', () => {
    it('returns progressing when current call is successful with no non-progress signals', () => {
      const status = tracker.evaluate([], 'navigate', 'Navigated to https://example.com', false);
      expect(status).toBe('progressing');
    });

    it('returns progressing with recent successful calls', () => {
      const recent = [
        mockCall('navigate'),
        mockCall('read_page'),
        mockCall('find'),
      ];
      const status = tracker.evaluate(recent, 'click_element', 'Clicked submit button', false);
      expect(status).toBe('progressing');
    });

    it('returns progressing with empty recentCalls and clean current result', () => {
      const status = tracker.evaluate([], 'read_page', 'Page content here', false);
      expect(status).toBe('progressing');
    });

    it('returns progressing when only 2 non-progress calls total', () => {
      const recent = [
        mockCall('navigate', 'error', 'timed out'),
      ];
      const status = tracker.evaluate(recent, 'navigate', 'timed out', true);
      expect(status).toBe('progressing');
    });
  });

  describe('evaluate() — stalling', () => {
    it('returns stalling on 3 non-progress calls where none are errors (non-progress successes)', () => {
      const recent = [
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
      ];
      // current is also a non-progress success → total 3 non-progress, 0 errors → stalling
      const status = tracker.evaluate(recent, 'navigate', 'Login page detected', false);
      expect(status).toBe('stalling');
    });

    it('returns stalling on 3 non-progress calls (mix of errors and non-progress successes)', () => {
      const recent = [
        mockCall('computer', 'error', 'not found'),
        mockCall('find', 'success'), // success but no error field → counts as progress, breaks streak
      ];
      // recent[1] is a successful call → breaks streak, so current + recent[0] = 2 non-progress → progressing
      // To get stalling we need 3 consecutive without a progress break
      const recent2 = [
        mockCall('computer', 'error', 'not found'),
        mockCall('navigate', 'error', 'timed out'),
      ];
      const status = tracker.evaluate(recent2, 'find', '0 results not found', false);
      // current: isProgressResult('0 results not found') → 'not found' in signals → non-progress
      // recent2[0]: error → non-progress
      // recent2[1]: error → non-progress
      // total consecutive non-progress = 3
      expect(status).toBe('stalling');
    });

    it('returns stalling on exactly 3 non-progress calls: 2 errors + 1 non-progress success', () => {
      const recent = [
        mockCall('click_element', 'error', 'is stale'),
        mockCall('navigate', 'success', 'Login page detected'),
      ];
      // current: non-progress success (Login page detected) → nonProgress=1, errors=0
      // recent[0]: error → nonProgress=2, errors=1
      // recent[1]: success with Login signal → nonProgress=3, errors reset to 0
      // consecutiveErrors=1 (<3), consecutiveNonProgress=3 → stalling
      const status = tracker.evaluate(recent, 'navigate', 'Login page detected', false);
      expect(status).toBe('stalling');
    });
  });

  describe('evaluate() — stuck', () => {
    it('returns stuck on 3+ consecutive errors', () => {
      const recent = [
        mockCall('navigate', 'error', 'timed out'),
        mockCall('navigate', 'error', 'timed out'),
      ];
      // current is also error → consecutiveErrors = 3
      const status = tracker.evaluate(recent, 'navigate', 'timed out', true);
      expect(status).toBe('stuck');
    });

    it('returns stuck on 5+ non-progress calls', () => {
      const recent = [
        mockCall('computer', 'error', 'not found'),
        mockCall('computer', 'error', 'not found'),
        mockCall('computer', 'error', 'not found'),
        mockCall('computer', 'error', 'not found'),
      ];
      // current is also non-progress → total 5 consecutiveNonProgress
      const status = tracker.evaluate(recent, 'computer', 'not found', true);
      expect(status).toBe('stuck');
    });

    it('returns stuck when consecutiveErrors >= 3 even with fewer total non-progress', () => {
      const recent = [
        mockCall('find', 'error', 'some error'),
        mockCall('find', 'error', 'another error'),
      ];
      const status = tracker.evaluate(recent, 'find', 'yet another error', true);
      // consecutiveErrors = 3, consecutiveNonProgress = 3 → stuck
      expect(status).toBe('stuck');
    });

    it('returns stuck on exactly 5 non-progress calls (mixed success/error)', () => {
      // Non-progress successes: calls with error field containing non-progress signals
      const recent = [
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
      ];
      // current also non-progress → total 5
      const status = tracker.evaluate(recent, 'navigate', 'Login page detected', false);
      expect(status).toBe('stuck');
    });
  });

  describe('isProgressResult()', () => {
    it('returns true for clean result text', () => {
      expect(tracker.isProgressResult('Navigated to https://example.com')).toBe(true);
      expect(tracker.isProgressResult('Clicked the submit button')).toBe(true);
      expect(tracker.isProgressResult('Page content extracted successfully')).toBe(true);
      expect(tracker.isProgressResult('')).toBe(true);
    });

    it('returns false for authRedirect signal', () => {
      expect(tracker.isProgressResult('authRedirect detected')).toBe(false);
    });

    it('returns false for not interactive signal', () => {
      expect(tracker.isProgressResult('element is not interactive')).toBe(false);
    });

    it('returns false for stale ref signal', () => {
      expect(tracker.isProgressResult('ref_123 is stale, please re-query')).toBe(false);
    });

    it('returns false for timeout signal', () => {
      expect(tracker.isProgressResult('operation timed out after 30s')).toBe(false);
    });

    it('returns false for No significant visual change', () => {
      expect(tracker.isProgressResult('No significant visual change detected')).toBe(false);
    });

    it('returns false for not found signal', () => {
      expect(tracker.isProgressResult('element not found in DOM')).toBe(false);
    });

    it('returns false for no longer available signal', () => {
      expect(tracker.isProgressResult('tab is no longer available')).toBe(false);
    });

    it('returns false for Login page detected', () => {
      expect(tracker.isProgressResult('Login page detected, credentials needed')).toBe(false);
    });

    it('returns false for CAPTCHA signal', () => {
      expect(tracker.isProgressResult('CAPTCHA challenge presented')).toBe(false);
    });

    it('returns false for 404 signal', () => {
      expect(tracker.isProgressResult('Page returned 404')).toBe(false);
    });

    it('returns false for Access Denied signal', () => {
      expect(tracker.isProgressResult('Access Denied by server')).toBe(false);
    });

    it('returns false for Forbidden signal', () => {
      expect(tracker.isProgressResult('Forbidden resource')).toBe(false);
    });

    it('checks all NON_PROGRESS_SIGNALS are covered', () => {
      for (const signal of NON_PROGRESS_SIGNALS) {
        expect(tracker.isProgressResult(`prefix ${signal} suffix`)).toBe(false);
      }
    });
  });

  describe('evaluate() — recovery after stall', () => {
    it('returns progressing after a stall when current call is successful', () => {
      // The current successful call breaks the streak at the start
      const recent = [
        mockCall('navigate', 'error', 'timed out'),
        mockCall('navigate', 'error', 'timed out'),
      ];
      // Current call is a success with no non-progress signals → streak breaks immediately
      const status = tracker.evaluate(recent, 'navigate', 'Navigated successfully to dashboard', false);
      // current is progress (no signal) → consecutiveNonProgress starts at 0, breaks streak
      expect(status).toBe('progressing');
    });

    it('returns progressing when a successful call interrupts the error streak in recentCalls', () => {
      const recent = [
        mockCall('navigate', 'error', 'timed out'),
        mockCall('find', 'success'), // No error field → isLikelyProgressCall = true → breaks streak
        mockCall('navigate', 'error', 'timed out'),
        mockCall('navigate', 'error', 'timed out'),
      ];
      // current is error → consecutiveErrors = 1, nonProgress = 1
      // recent[0] is error → consecutiveErrors = 2, nonProgress = 2
      // recent[1] is success with no error field → isLikelyProgressCall = true → break
      // total nonProgress = 2, errors = 2 → progressing
      const status = tracker.evaluate(recent, 'navigate', 'timed out', true);
      expect(status).toBe('progressing');
    });
  });

  describe('evaluate() — empty recentCalls', () => {
    it('returns progressing with no history and clean current result', () => {
      const status = tracker.evaluate([], 'read_page', 'DOM content retrieved', false);
      expect(status).toBe('progressing');
    });

    it('returns progressing with no history and errored current call (1 error < threshold)', () => {
      const status = tracker.evaluate([], 'navigate', 'timed out', true);
      expect(status).toBe('progressing');
    });
  });

  describe('evaluate() — mixed calls', () => {
    it('returns progressing when progress calls interrupt non-progress streak', () => {
      const recent = [
        mockCall('navigate', 'error', 'timed out'),
        mockCall('read_page', 'success'), // progress → breaks streak
        mockCall('find', 'error', 'not found'),
      ];
      // current: success, clean → nonProgress = 0
      // recent[0]: error → nonProgress = 1
      // recent[1]: success no error → progress → break
      // nonProgress = 1 → progressing
      const status = tracker.evaluate(recent, 'click_element', 'Clicked successfully', false);
      expect(status).toBe('progressing');
    });

    it('returns stalling when non-progress calls include both errors and non-progress successes', () => {
      const recent = [
        mockCall('navigate', 'success', 'Login page detected'), // non-progress success
        mockCall('navigate', 'error', 'timed out'),             // error
      ];
      // current: non-progress (error) → nonProgress = 1, errors = 1
      // recent[0]: success with error='Login page detected' → isLikelyProgressCall = false → nonProgress = 2, errors reset to 0
      // recent[1]: error → errors = 1, nonProgress = 3
      // nonProgress = 3 → stalling
      const status = tracker.evaluate(recent, 'navigate', 'Access Denied', true);
      expect(status).toBe('stalling');
    });

    it('returns stuck when 5 consecutive non-progress calls even with successes', () => {
      const recent = [
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'success', 'Login page detected'),
        mockCall('navigate', 'error', 'timed out'),
      ];
      // current: non-progress error → errors=1, nonProgress=1
      // recent[0]: success with Login signal → nonProgress=2, errors reset=0
      // recent[1]: success with Login signal → nonProgress=3, errors reset=0
      // recent[2]: success with Login signal → nonProgress=4, errors reset=0
      // recent[3]: error → errors=1, nonProgress=5
      // nonProgress=5 → stuck
      const status = tracker.evaluate(recent, 'navigate', 'not found', true);
      expect(status).toBe('stuck');
    });
  });

  describe('NON_PROGRESS_SIGNALS export', () => {
    it('exports a non-empty array', () => {
      expect(Array.isArray(NON_PROGRESS_SIGNALS)).toBe(true);
      expect(NON_PROGRESS_SIGNALS.length).toBeGreaterThan(0);
    });

    it('contains expected key signals', () => {
      expect(NON_PROGRESS_SIGNALS).toContain('authRedirect');
      expect(NON_PROGRESS_SIGNALS).toContain('timed out');
      expect(NON_PROGRESS_SIGNALS).toContain('not found');
      expect(NON_PROGRESS_SIGNALS).toContain('CAPTCHA');
      expect(NON_PROGRESS_SIGNALS).toContain('Login page detected');
    });
  });
});
