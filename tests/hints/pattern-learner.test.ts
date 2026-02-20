/**
 * PatternLearner unit tests
 * Verifies adaptive error→recovery learning, promotion, persistence, and normalization.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PatternLearner } from '../../src/hints/pattern-learner';
import { ActivityTracker } from '../../src/dashboard/activity-tracker';
import { HintEngine } from '../../src/hints/hint-engine';

function makeResult(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: isError ? `Error: ${text}` : text }],
    ...(isError && { isError: true }),
  };
}

describe('PatternLearner', () => {
  describe('error normalization', () => {
    let learner: PatternLearner;

    beforeEach(() => {
      learner = new PatternLearner();
    });

    it('should lowercase and trim', () => {
      expect(learner.normalizeError('  Target DETACHED  ')).toBe('target detached');
    });

    it('should replace hex IDs', () => {
      expect(learner.normalizeError('ref not found: abc123def456')).toBe('ref not found: {id}');
    });

    it('should replace long numbers', () => {
      expect(learner.normalizeError('timeout after 30000ms')).toBe('timeout after {n}ms');
    });

    it('should collapse whitespace', () => {
      expect(learner.normalizeError('error   in   module')).toBe('error in module');
    });

    it('should truncate at 100 chars', () => {
      const long = 'g'.repeat(200); // non-hex char to avoid ID replacement
      expect(learner.normalizeError(long).length).toBe(100);
    });
  });

  describe('observation lifecycle', () => {
    let learner: PatternLearner;

    beforeEach(() => {
      learner = new PatternLearner();
    });

    it('should create pending observation on miss', () => {
      learner.onMiss('click_element', 'target detached from DOM');
      expect(learner.getPendingCount()).toBe(1);
    });

    it('should resolve pending when different tool succeeds', () => {
      learner.onMiss('click_element', 'target detached from DOM');
      expect(learner.getPendingCount()).toBe(1);

      learner.onToolComplete('read_page', false); // success with different tool
      expect(learner.getPendingCount()).toBe(0);
    });

    it('should resolve pending when same tool succeeds (self-resolved)', () => {
      learner.onMiss('click_element', 'target detached from DOM');
      learner.onToolComplete('click_element', false); // same tool succeeded
      expect(learner.getPendingCount()).toBe(0);
    });

    it('should expire pending after watch window', () => {
      learner.onMiss('click_element', 'target detached from DOM');

      // 3 consecutive errors exhaust the watch window
      learner.onToolComplete('other_tool', true);
      learner.onToolComplete('other_tool', true);
      learner.onToolComplete('other_tool', true);

      expect(learner.getPendingCount()).toBe(0);
    });

    it('should limit pending observations', () => {
      for (let i = 0; i < 15; i++) {
        learner.onMiss('tool_' + i, 'error ' + i);
      }
      expect(learner.getPendingCount()).toBeLessThanOrEqual(PatternLearner.MAX_PENDING);
    });
  });

  describe('pattern promotion', () => {
    let learner: PatternLearner;

    beforeEach(() => {
      learner = new PatternLearner();
    });

    it('should not promote with fewer than threshold observations', () => {
      // Only 2 observations (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        learner.onMiss('click_element', 'target detached');
        learner.onToolComplete('read_page', false);
      }
      expect(learner.getPatterns()).toHaveLength(0);
    });

    it('should promote after reaching threshold', () => {
      for (let i = 0; i < 3; i++) {
        learner.onMiss('click_element', 'target detached');
        learner.onToolComplete('read_page', false);
      }

      const patterns = learner.getPatterns();
      expect(patterns).toHaveLength(1);
      expect(patterns[0].recoveryTool).toBe('read_page');
      expect(patterns[0].occurrences).toBe(3);
      expect(patterns[0].errorTools).toContain('click_element');
    });

    it('should pick the most common recovery tool', () => {
      // 3x read_page, 1x find
      for (let i = 0; i < 3; i++) {
        learner.onMiss('click_element', 'target detached');
        learner.onToolComplete('read_page', false);
      }
      learner.onMiss('click_element', 'target detached');
      learner.onToolComplete('find', false);

      const patterns = learner.getPatterns();
      expect(patterns[0].recoveryTool).toBe('read_page');
    });

    it('should not promote with low confidence', () => {
      // 2x read_page, 2x find, 2x javascript_tool = no single tool hits threshold
      const tools = ['read_page', 'find', 'javascript_tool', 'read_page', 'find', 'javascript_tool'];
      for (const tool of tools) {
        learner.onMiss('click_element', 'target detached');
        learner.onToolComplete(tool, false);
      }

      // Each has 2 occurrences out of 6 total = 0.33 confidence (below 0.6)
      expect(learner.getPatterns()).toHaveLength(0);
    });

    it('should generate correct hint text', () => {
      for (let i = 0; i < 3; i++) {
        learner.onMiss('navigate', 'connection refused');
        learner.onToolComplete('wait_for', false);
      }

      const patterns = learner.getPatterns();
      expect(patterns[0].hint).toContain('wait_for');
      expect(patterns[0].hint).toContain('3 previous recoveries');
    });

    it('should update existing pattern when occurrences increase', () => {
      for (let i = 0; i < 3; i++) {
        learner.onMiss('click_element', 'target detached');
        learner.onToolComplete('read_page', false);
      }
      expect(learner.getPatterns()[0].occurrences).toBe(3);

      // More observations
      learner.onMiss('click_element', 'target detached');
      learner.onToolComplete('read_page', false);

      expect(learner.getPatterns()).toHaveLength(1); // still one pattern
      expect(learner.getPatterns()[0].occurrences).toBe(4);
    });

    it('should track multiple error tools for same fingerprint', () => {
      // Same error from different tools
      learner.onMiss('click_element', 'target detached');
      learner.onToolComplete('read_page', false);
      learner.onMiss('wait_and_click', 'target detached');
      learner.onToolComplete('read_page', false);
      learner.onMiss('click_element', 'target detached');
      learner.onToolComplete('read_page', false);

      const patterns = learner.getPatterns();
      expect(patterns[0].errorTools).toContain('click_element');
      expect(patterns[0].errorTools).toContain('wait_and_click');
    });
  });

  describe('pattern matching', () => {
    let learner: PatternLearner;

    beforeEach(() => {
      learner = new PatternLearner();
      // Build up a learned pattern
      for (let i = 0; i < 3; i++) {
        learner.onMiss('click_element', 'target detached from DOM');
        learner.onToolComplete('read_page', false);
      }
    });

    it('should match exact error text', () => {
      const match = learner.matchPattern('target detached from DOM', 'click_element');
      expect(match).not.toBeNull();
      expect(match!.recoveryTool).toBe('read_page');
    });

    it('should match similar error text (substring)', () => {
      const match = learner.matchPattern('Error: target detached from DOM tree node', 'click_element');
      expect(match).not.toBeNull();
    });

    it('should not match different tool', () => {
      const match = learner.matchPattern('target detached from DOM', 'navigate');
      expect(match).toBeNull();
    });

    it('should not match unrelated error', () => {
      const match = learner.matchPattern('completely different error', 'click_element');
      expect(match).toBeNull();
    });
  });

  describe('persistence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learner-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should persist and reload patterns', () => {
      const learner1 = new PatternLearner();
      learner1.enablePersistence(tmpDir);

      for (let i = 0; i < 3; i++) {
        learner1.onMiss('click_element', 'target detached');
        learner1.onToolComplete('read_page', false);
      }

      expect(learner1.getPatterns()).toHaveLength(1);

      // New learner loads from same file
      const learner2 = new PatternLearner();
      learner2.enablePersistence(tmpDir);

      expect(learner2.getPatterns()).toHaveLength(1);
      expect(learner2.getPatterns()[0].recoveryTool).toBe('read_page');
    });

    it('should match patterns loaded from disk', () => {
      const learner1 = new PatternLearner();
      learner1.enablePersistence(tmpDir);

      for (let i = 0; i < 3; i++) {
        learner1.onMiss('click_element', 'target detached');
        learner1.onToolComplete('read_page', false);
      }

      // New session
      const learner2 = new PatternLearner();
      learner2.enablePersistence(tmpDir);

      const match = learner2.matchPattern('target detached from DOM', 'click_element');
      expect(match).not.toBeNull();
      expect(match!.hint).toContain('read_page');
    });

    it('should handle missing file gracefully', () => {
      const learner = new PatternLearner();
      learner.enablePersistence(path.join(tmpDir, 'nonexistent'));
      expect(learner.getPatterns()).toHaveLength(0);
    });

    it('should handle corrupted file gracefully', () => {
      fs.writeFileSync(path.join(tmpDir, 'learned-patterns.json'), 'not json{{{');
      const learner = new PatternLearner();
      learner.enablePersistence(tmpDir);
      expect(learner.getPatterns()).toHaveLength(0);
    });
  });

  describe('integration with HintEngine', () => {
    it('should serve learned hints through getHint', () => {
      const tracker = new ActivityTracker();
      const engine = new HintEngine(tracker);
      const learner = engine.getLearner();

      // Simulate 3 rounds of error→recovery observation through getHint
      for (let i = 0; i < 3; i++) {
        // Error call — no static rule matches "custom weird error"
        engine.getHint('custom_tool', makeResult('strange unknown glitch', true), true);
        // Recovery call — different tool succeeds
        engine.getHint('recovery_tool', makeResult('success'), false);
      }

      // Now the learned pattern should be available
      expect(learner.getPatterns()).toHaveLength(1);
      expect(learner.getPatterns()[0].recoveryTool).toBe('recovery_tool');

      // Next time same error occurs, should get learned hint
      const hint = engine.getHint('custom_tool', makeResult('strange unknown glitch', true), true);
      expect(hint).toContain('recovery_tool');
      expect(hint).toContain('learned');
    });

    it('should not interfere with static rules', () => {
      const tracker = new ActivityTracker();
      const engine = new HintEngine(tracker);

      // Static rule should still fire (error recovery has higher priority)
      const hint = engine.getHint('navigate', makeResult('tab not found', true), true);
      expect(hint).toContain('tabs_context_mcp');
    });
  });
});
