/// <reference types="jest" />
/**
 * Unit tests for Outcome Classifier
 */

import {
  classifyOutcome,
  formatOutcomeLine,
  OUTCOME_LABELS,
  OUTCOME_SYMBOLS,
  InteractionOutcome,
} from '../../../src/utils/ralph/outcome-classifier';

describe('Outcome Classifier', () => {
  describe('classifyOutcome', () => {
    describe('SILENT_CLICK detection', () => {
      test('should return SILENT_CLICK for undefined delta', () => {
        expect(classifyOutcome(undefined)).toBe('SILENT_CLICK');
      });

      test('should return SILENT_CLICK for empty string delta', () => {
        expect(classifyOutcome('')).toBe('SILENT_CLICK');
      });

      test('should return SILENT_CLICK for whitespace-only delta', () => {
        expect(classifyOutcome('   \n  \t  ')).toBe('SILENT_CLICK');
      });
    });

    describe('SUCCESS detection', () => {
      test('should detect aria-checked change as SUCCESS', () => {
        const delta = '~ mat-radio-button: aria-checked null→true';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect aria-expanded change as SUCCESS', () => {
        const delta = '~ button: aria-expanded false→true';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect aria-selected change as SUCCESS', () => {
        const delta = '~ tab: aria-selected false→true';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect URL change as SUCCESS', () => {
        const delta = 'URL changed: /page1 → /page2';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect navigation as SUCCESS', () => {
        const delta = 'Navigated to https://example.com/new-page';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect title change as SUCCESS', () => {
        const delta = 'Title changed: "Old" → "New"';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect dialog/modal opening as SUCCESS', () => {
        const delta = '+ div[role="dialog"]: "Confirm action"';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect dialog closing as SUCCESS', () => {
        const delta = '- div[role="dialog"]: "Confirm action"';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect class change with active/selected as SUCCESS', () => {
        const delta = '~ div: class "tab" → "tab active selected"';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect scroll as SUCCESS', () => {
        const delta = 'scroll: 0→500';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect added/removed elements as SUCCESS', () => {
        const delta = '+ li: "New item added"\n- span: "Loading..."';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should detect form submit as SUCCESS', () => {
        const delta = 'form submit triggered';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });
    });

    describe('WRONG_ELEMENT detection', () => {
      test('should detect tooltip-only change when targeting radio as WRONG_ELEMENT', () => {
        const delta = '+ div[role="tooltip"]: "사용자 유형에 대한 설명"';
        expect(classifyOutcome(delta, 'radio')).toBe('WRONG_ELEMENT');
      });

      test('should detect mattooltip as WRONG_ELEMENT when targeting checkbox', () => {
        const delta = '+ div.matTooltip: "Help text"';
        expect(classifyOutcome(delta, 'checkbox')).toBe('WRONG_ELEMENT');
      });

      test('should detect cdk-overlay as WRONG_ELEMENT when targeting radio', () => {
        const delta = '+ div.cdk-overlay-pane: "Tooltip content"';
        expect(classifyOutcome(delta, 'radio')).toBe('WRONG_ELEMENT');
      });

      test('should NOT flag tooltip as WRONG_ELEMENT when targeting button', () => {
        // Buttons legitimately trigger tooltips
        const delta = '+ div[role="tooltip"]: "Button description"';
        expect(classifyOutcome(delta, 'button')).not.toBe('WRONG_ELEMENT');
      });

      test('should NOT flag tooltip as WRONG_ELEMENT when no target role', () => {
        const delta = '+ div[role="tooltip"]: "Some help text"';
        expect(classifyOutcome(delta)).not.toBe('WRONG_ELEMENT');
      });

      test('should detect tooltip + real change as SUCCESS (not WRONG_ELEMENT)', () => {
        const delta = '+ div[role="tooltip"]: "Help"\n~ radio: aria-checked null→true';
        expect(classifyOutcome(delta, 'radio')).toBe('SUCCESS');
      });
    });

    describe('edge cases', () => {
      test('should handle delta with only structural markers', () => {
        const delta = '+ div: "some content"';
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });

      test('should handle multiline deltas', () => {
        const delta = [
          '~ button: aria-expanded false→true',
          '+ ul[role="menu"]: "Option 1, Option 2"',
          '+ li: "Option 1"',
        ].join('\n');
        expect(classifyOutcome(delta)).toBe('SUCCESS');
      });
    });
  });

  describe('formatOutcomeLine', () => {
    test('should format SUCCESS without label suffix', () => {
      const line = formatOutcomeLine('SUCCESS', 'Clicked', 'radio "외부"', '[ref_42]', '[exact match via AX tree]');
      expect(line).toContain('\u2713');
      expect(line).toContain('Clicked');
      expect(line).toContain('radio "외부"');
      expect(line).toContain('[ref_42]');
      expect(line).not.toContain('—');
    });

    test('should format SILENT_CLICK with warning label', () => {
      const line = formatOutcomeLine('SILENT_CLICK', 'Clicked', 'button "Submit"', '[ref_1]', '[via CSS]');
      expect(line).toContain('\u26a0');
      expect(line).toContain('no DOM change detected');
    });

    test('should format WRONG_ELEMENT with warning label', () => {
      const line = formatOutcomeLine('WRONG_ELEMENT', 'Clicked', 'radio "외부"', '[ref_2]', '[via AX tree]');
      expect(line).toContain('\u26a0');
      expect(line).toContain('unexpected DOM change');
    });

    test('should format ELEMENT_NOT_FOUND with error symbol', () => {
      const line = formatOutcomeLine('ELEMENT_NOT_FOUND', 'Clicked', '"missing"', '', '');
      expect(line).toContain('\u2717');
      expect(line).toContain('no matching element found');
    });
  });

  describe('constants', () => {
    test('OUTCOME_LABELS should have entries for all outcomes', () => {
      const outcomes: InteractionOutcome[] = ['SUCCESS', 'SILENT_CLICK', 'WRONG_ELEMENT', 'ELEMENT_NOT_FOUND', 'TIMEOUT', 'EXCEPTION'];
      for (const o of outcomes) {
        expect(OUTCOME_LABELS[o]).toBeDefined();
        expect(typeof OUTCOME_LABELS[o]).toBe('string');
      }
    });

    test('OUTCOME_SYMBOLS should have entries for all outcomes', () => {
      const outcomes: InteractionOutcome[] = ['SUCCESS', 'SILENT_CLICK', 'WRONG_ELEMENT', 'ELEMENT_NOT_FOUND', 'TIMEOUT', 'EXCEPTION'];
      for (const o of outcomes) {
        expect(OUTCOME_SYMBOLS[o]).toBeDefined();
      }
    });
  });
});
