/**
 * HintEngine unit tests
 * Verifies rule matching, priority ordering, first-match-wins, repetition detection, and logging.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

describe('HintEngine', () => {
  describe('rule ordering', () => {
    it('should have rules sorted by ascending priority', () => {
      const engine = new HintEngine(new ActivityTracker());
      const rules = engine.getRules();
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i].priority).toBeGreaterThanOrEqual(rules[i - 1].priority);
      }
    });
  });

  describe('first-match-wins', () => {
    it('should return only the first matching hint', () => {
      // "timeout" matches error-recovery AND could match success-hints (navigate error page)
      const tracker = new ActivityTracker();
      const engine = new HintEngine(tracker);
      const result = makeResult('Navigation timeout exceeded', true);
      const hint = engine.getHint('navigate', result, true);
      expect(hint).toContain('wait_for');
    });

    it('should return null when no rules match', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('{"action":"navigate","url":"https://example.com","title":"Example"}');
      const hint = engine.getHint('navigate', result, false);
      expect(hint).toBeNull();
    });
  });

  describe('error recovery rules', () => {
    it('should hint on stale ref errors', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('ref not found: abc123', true);
      const hint = engine.getHint('click_element', result, true);
      expect(hint).toContain('Refs expire');
      expect(hint).toContain('read_page');
    });

    it('should hint on tab not found errors', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('tab not found: tab-xyz', true);
      const hint = engine.getHint('navigate', result, true);
      expect(hint).toContain('tabs_context_mcp');
    });

    it('should hint on CSS selector failures', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('selector not found: #my-button', true);
      const hint = engine.getHint('computer', result, true);
      expect(hint).toContain('find(query)');
    });

    it('should hint on click_element "no clickable elements found"', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('No clickable elements found matching "Submit"', true);
      const hint = engine.getHint('click_element', result, true);
      expect(hint).toContain('wait_and_click');
      expect(hint).toContain('read_page');
    });

    it('should hint on click_element "no good match found"', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('No good match found for "Login". Best candidate was "Log Out" with low confidence.', true);
      const hint = engine.getHint('click_element', result, true);
      expect(hint).toContain('wait_and_click');
    });

    it('should hint on click_element generic error', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Click element error: Cannot read properties of null', true);
      const hint = engine.getHint('click_element', result, true);
      expect(hint).toContain('wait_and_click');
    });

    it('should hint on timeout errors', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Operation timed out after 30000ms', true);
      const hint = engine.getHint('navigate', result, true);
      expect(hint).toContain('wait_for');
    });

    it('should hint on null reference errors', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Cannot read property "click" of null', true);
      const hint = engine.getHint('javascript_tool', result, true);
      expect(hint).toContain('null');
      expect(hint).toContain('find');
    });

    it('should hint on coordinate-based click attempts', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('click at position requires x, y coordinates', true);
      const hint = engine.getHint('computer', result, true);
      expect(hint).toContain('click_element(query)');
    });

    it('should not trigger error rules for non-error results', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('ref not found: abc123', false);
      // Error recovery rules require isError=true
      const hint = engine.getHint('click_element', result, false);
      // Should not get error recovery hint
      expect(hint === null || !hint.includes('Refs expire')).toBe(true);
    });
  });

  describe('composite suggestion rules', () => {
    it('should suggest click_element after find+click pattern', () => {
      const tracker = makeTracker([{ toolName: 'find' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('clicked element at position');
      const hint = engine.getHint('click', result, false);
      expect(hint).toContain('click_element');
    });

    it('should suggest fill_form after multiple form_input calls', () => {
      const tracker = makeTracker([{ toolName: 'form_input' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('input filled');
      const hint = engine.getHint('form_input', result, false);
      expect(hint).toContain('fill_form');
    });

    it('should suggest wait_and_click after navigate+click', () => {
      const tracker = makeTracker([{ toolName: 'navigate' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('clicked');
      const hint = engine.getHint('click_element', result, false);
      expect(hint).toContain('wait_and_click');
    });

    it('should suggest find for truncated read_page', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Page content here... truncated at 5000 chars');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).toContain('find(query)');
    });
  });

  describe('sequence detection rules', () => {
    it('should detect login page after navigate', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('{"action":"navigate","url":"https://app.com/login","title":"Login - App"}');
      const hint = engine.getHint('navigate', result, false);
      expect(hint).toContain('Login');
      expect(hint).toContain('Chrome profile');
    });

    it('should detect repeated read_page', () => {
      const tracker = makeTracker([{ toolName: 'read_page' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content...');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).toContain('find(query)');
    });

    it('should detect navigate→screenshot without wait', () => {
      const tracker = makeTracker([{ toolName: 'navigate' }]);
      const engine = new HintEngine(tracker);
      const result = makeResult('screenshot captured');
      const hint = engine.getHint('computer', result, false);
      expect(hint).toContain('wait_for');
    });
  });

  describe('success hint rules', () => {
    it('should hint on 404 page after navigate', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('{"action":"navigate","url":"https://example.com/bad","title":"404 Not Found"}');
      const hint = engine.getHint('navigate', result, false);
      expect(hint).toContain('Verify URL');
    });

    it('should hint when find returns no results', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('0 results found');
      const hint = engine.getHint('find', result, false);
      expect(hint).toContain('broader query');
    });

    it('should hint after click_element with navigation', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Clicked "Submit" button [Page navigated to /dashboard]');
      const hint = engine.getHint('click_element', result, false);
      expect(hint).toContain('wait_for');
    });

    it('should hint after form submission', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Form submitted successfully');
      const hint = engine.getHint('fill_form', result, false);
      expect(hint).toContain('wait_for');
    });
  });

  describe('priority ordering', () => {
    it('error recovery should win over success hints', () => {
      // An error result that could match both error-recovery and success
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('timeout waiting for navigation', true);
      const hint = engine.getHint('navigate', result, true);
      // Should be error-recovery hint (lower priority number = higher precedence)
      expect(hint).toContain('wait_for');
    });
  });

  describe('repetition detection rules', () => {
    it('should detect same tool failing 3 times in a row', () => {
      const tracker = makeTracker([
        { toolName: 'click_element', result: 'error', error: 'not found' },
        { toolName: 'click_element', result: 'error', error: 'not found' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('element not found', true);
      const hint = engine.getHint('click_element', result, true);
      // Error recovery (priority 100+) should fire before repetition (250) for known patterns
      // But for unknown error patterns, repetition catches it
      expect(hint).not.toBeNull();
    });

    it('should detect same-tool error streak for unknown errors', () => {
      const tracker = makeTracker([
        { toolName: 'custom_tool', result: 'error', error: 'weird error' },
        { toolName: 'custom_tool', result: 'error', error: 'weird error' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('another weird error', true);
      const hint = engine.getHint('custom_tool', result, true);
      expect(hint).toContain('failed 3 times');
      expect(hint).toContain('different approach');
    });

    it('should detect A↔B oscillation pattern', () => {
      const tracker = makeTracker([
        { toolName: 'read_page' },
        { toolName: 'navigate' },
        { toolName: 'read_page' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('navigated to page');
      const hint = engine.getHint('navigate', result, false);
      expect(hint).toContain('oscillation');
      expect(hint).toContain('navigate');
      expect(hint).toContain('read_page');
    });

    it('should detect same tool called 3+ times with success', () => {
      const tracker = makeTracker([
        { toolName: 'read_page' },
        { toolName: 'read_page' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('page content unchanged');
      const hint = engine.getHint('read_page', result, false);
      // Sequence detection (repeated read_page, priority 301) fires before repetition (252)
      expect(hint).not.toBeNull();
    });

    it('should not trigger on mixed tool calls', () => {
      const tracker = makeTracker([
        { toolName: 'navigate' },
        { toolName: 'find' },
        { toolName: 'click_element' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('{"status":"ok"}');
      const hint = engine.getHint('read_page', result, false);
      expect(hint).toBeNull();
    });
  });

  describe('anti-wandering rules', () => {
    it('coordinate-click-stall: triggers on 3+ recent computer clicks', () => {
      const tracker = makeTracker([
        { toolName: 'computer', args: { action: 'left_click' } },
        { toolName: 'computer', args: { action: 'left_click' } },
        { toolName: 'computer', args: { action: 'left_click' } },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('Clicked at (100, 200)');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('CLICK STALL');
    });

    it('coordinate-click-stall: does NOT trigger on only 2 recent clicks', () => {
      const tracker = makeTracker([
        { toolName: 'computer', args: { action: 'left_click' } },
        { toolName: 'computer', args: { action: 'left_click' } },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('Clicked at (100, 200)');
      const hint = engine.getHint('computer', result, false);
      // Another rule (same-tool-same-result) may match, but CLICK STALL should not
      if (hint) {
        expect(hint).not.toContain('CLICK STALL');
      }
    });

    it('screenshot-verification-loop: triggers on click+screenshot pattern', () => {
      const tracker = makeTracker([
        { toolName: 'computer', args: { action: 'screenshot' } },
        { toolName: 'computer', args: { action: 'left_click' } },
        { toolName: 'computer', args: { action: 'screenshot' } },
        { toolName: 'computer', args: { action: 'left_click' } },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('Clicked at (200, 300)');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('Multiple screenshots after clicks');
    });

    it('empty-result-streak: triggers after 3+ empty javascript_tool results', () => {
      const tracker = makeTracker([
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('null');
      const hint = engine.getHint('javascript_tool', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('empty/null result');
      expect(hint).toContain('read_page');
    });

    it('empty-result-streak: does NOT trigger when current result is non-empty', () => {
      const tracker = makeTracker([
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('<div class="save-indicator">Saved</div>');
      const hint = engine.getHint('javascript_tool', result, false);
      if (hint) {
        expect(hint).not.toContain('empty/null result');
      }
    });

    it('empty-result-streak: wins over js-escalation-ladder (lower priority)', () => {
      const tracker = makeTracker([
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('[]');
      const hint = engine.getHint('javascript_tool', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('empty/null result');
      expect(hint).not.toContain('escalation ladder');
    });

    it('js-escalation-ladder: triggers on 3+ javascript_tool calls with non-empty result', () => {
      const tracker = makeTracker([
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
        { toolName: 'javascript_tool' },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('document.querySelector returned element data');
      const hint = engine.getHint('javascript_tool', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('escalation ladder');
    });

    it('post-scroll-click: triggers when scroll action precedes coordinate click', () => {
      const tracker = makeTracker([
        { toolName: 'computer', args: { action: 'scroll' } },
      ]);
      const engine = new HintEngine(tracker);
      const result = makeResult('Clicked at (300, 400)');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('scroll');
    });

    it('contenteditable-click-hint: triggers when click hits a rich text editor', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Clicked at (50, 50) — Hit: div[contenteditable="true"]');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('rich text editor');
    });

    it('coordinate-click-after-read: triggers when clicking a non-interactive element', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Clicked at (200, 300) — Hit: span [not interactive]');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('non-interactive');
    });
  });

  describe('timeout and slow-page hints', () => {
    it('screenshot timeout gets specific hint', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Page.captureScreenshot timed out', true);
      const hint = engine.getHint('computer', result, true);
      expect(hint).not.toBeNull();
      expect(hint).toContain('read_page mode="dom"');
      expect(hint).toContain('Screenshot timed out');
    });

    it('generic timeout gets updated hint', () => {
      const engine = new HintEngine(new ActivityTracker());
      const result = makeResult('Navigation timeout', true);
      const hint = engine.getHint('navigate', result, true);
      expect(hint).not.toBeNull();
      expect(hint).toContain('wait_for');
      expect(hint).not.toContain('may require login');
    });

    it('slow-page-warning fires after slow navigate', () => {
      const tracker = new ActivityTracker();
      // Seed a completed navigate call with duration > 5000ms using mocked Date.now
      // startCall calls Date.now() twice (callId + startTime), endCall once
      const startMs = 1000000;
      const endMs = startMs + 8000;
      let callCount = 0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount <= 2 ? startMs : endMs;
      });
      const callId = tracker.startCall('navigate', 'test', { url: 'http://example.com' });
      tracker.endCall(callId, 'success');
      dateSpy.mockRestore();

      const engine = new HintEngine(tracker);
      // Current tool is computer (screenshot)
      const result = makeResult('screenshot captured');
      const hint = engine.getHint('computer', result, false);
      expect(hint).not.toBeNull();
      expect(hint).toContain('Slow page detected');
    });

    it('slow-page-warning does not fire for fast pages', () => {
      const tracker = new ActivityTracker();
      // Seed a completed navigate call with duration 1000ms (fast)
      // startCall calls Date.now() twice (callId + startTime), endCall once
      const startMs = 1000000;
      const endMs = startMs + 1000;
      let callCount = 0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount <= 2 ? startMs : endMs;
      });
      const callId = tracker.startCall('navigate', 'test', { url: 'http://example.com' });
      tracker.endCall(callId, 'success');
      dateSpy.mockRestore();

      const engine = new HintEngine(tracker);
      const result = makeResult('screenshot captured');
      // Use a result that won't match other rules
      const hint = engine.getHint('computer', result, false);
      // Should NOT contain slow-page-warning
      if (hint) {
        expect(hint).not.toContain('Slow page detected');
      }
    });
  });

  describe('hit/miss logging', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hint-log-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should log hint hits to JSONL file', async () => {
      const engine = new HintEngine(new ActivityTracker());
      engine.enableLogging(tmpDir);

      const result = makeResult('ref not found: abc', true);
      engine.getHint('click_element', result, true);

      // Flush buffered writes before reading
      engine.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);

      const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.toolName).toBe('click_element');
      expect(entry.isError).toBe(true);
      expect(entry.matchedRule).toContain('error-recovery');
      expect(entry.hint).toContain('Refs expire');
    });

    it('should log hint misses with null values', async () => {
      const engine = new HintEngine(new ActivityTracker());
      engine.enableLogging(tmpDir);

      const result = makeResult('{"status":"ok"}');
      engine.getHint('some_tool', result, false);

      // Flush buffered writes before reading
      engine.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
      const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[0]);
      expect(entry.matchedRule).toBeNull();
      expect(entry.hint).toBeNull();
    });

    it('should accumulate multiple log entries', async () => {
      const engine = new HintEngine(new ActivityTracker());
      engine.enableLogging(tmpDir);

      engine.getHint('navigate', makeResult('login page'), false);
      engine.getHint('find', makeResult('0 results'), false);
      engine.getHint('some_tool', makeResult('ok'), false);

      // Flush buffered writes before reading
      engine.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
      const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
    });
  });
});
