/// <reference types="jest" />
/**
 * Unit tests for AX-First Element Resolution
 */

import {
  parseQueryForAX,
  scoreAXNode,
  AXNodeFlat,
} from '../../src/utils/ax-element-resolver';

describe('AX Element Resolver', () => {
  describe('parseQueryForAX', () => {
    test('should extract role and name from "외부 radio button"', () => {
      const result = parseQueryForAX('외부 radio button');
      expect(result.roleHint).toBe('radio');
      expect(result.nameHint).toBe('외부');
      expect(result.nameTokens).toEqual(['외부']);
    });

    test('should extract role and name from "Submit button"', () => {
      const result = parseQueryForAX('Submit button');
      expect(result.roleHint).toBe('button');
      expect(result.nameHint).toBe('Submit');
    });

    test('should prefer longest match: "radio button" over "radio"', () => {
      const result = parseQueryForAX('외부 radio button');
      expect(result.roleHint).toBe('radio');
      // "radio button" extracted, not just "radio" leaving "button" in name
      expect(result.nameHint).not.toContain('button');
    });

    test('should extract role from "search input"', () => {
      const result = parseQueryForAX('search input');
      // "input" matches before "search" in ROLE_KEYWORDS → textbox
      expect(result.roleHint).toBe('textbox');
      expect(result.nameHint).toBe('search');
    });

    test('should handle query with no role keyword', () => {
      const result = parseQueryForAX('로그인');
      expect(result.roleHint).toBeNull();
      expect(result.nameHint).toBe('로그인');
    });

    test('should handle "dropdown" keyword', () => {
      const result = parseQueryForAX('Country dropdown');
      expect(result.roleHint).toBe('combobox');
      expect(result.nameHint).toBe('Country');
    });

    test('should handle "toggle" keyword as switch', () => {
      const result = parseQueryForAX('Dark mode toggle');
      expect(result.roleHint).toBe('switch');
      expect(result.nameHint).toBe('Dark mode');
    });

    test('should handle "check box" (two words)', () => {
      const result = parseQueryForAX('Agree check box');
      expect(result.roleHint).toBe('checkbox');
      expect(result.nameHint).toBe('Agree');
    });

    test('should handle role keyword at beginning of query', () => {
      const result = parseQueryForAX('button Submit');
      expect(result.roleHint).toBe('button');
      expect(result.nameHint).toBe('Submit');
    });

    test('should return full query as name when only role keyword', () => {
      const result = parseQueryForAX('button');
      expect(result.roleHint).toBe('button');
      expect(result.nameHint).toBe('button');
    });

    test('should handle link keyword', () => {
      const result = parseQueryForAX('Learn more link');
      expect(result.roleHint).toBe('link');
      expect(result.nameHint).toBe('Learn more');
    });

    test('should generate name tokens', () => {
      const result = parseQueryForAX('first name text field');
      expect(result.roleHint).toBe('textbox');
      expect(result.nameTokens).toEqual(['first', 'name']);
    });
  });

  describe('scoreAXNode', () => {
    const makeNode = (role: string, name: string, props: Record<string, unknown> = {}): AXNodeFlat => ({
      nodeId: 1,
      backendDOMNodeId: 100,
      role,
      name,
      properties: props,
    });

    test('should give 100 for exact role + exact name match', () => {
      const node = makeNode('radio', '외부');
      const score = scoreAXNode(node, 'radio', '외부', ['외부']);
      expect(score).toBe(110); // 100 + 10 interactive bonus
    });

    test('should give 80+ for exact role + name contains match', () => {
      const node = makeNode('radio', '외부 사용자');
      const score = scoreAXNode(node, 'radio', '외부', ['외부']);
      expect(score).toBeGreaterThanOrEqual(80);
    });

    test('should give low score for role mismatch and name mismatch', () => {
      const node = makeNode('button', '도움말');
      const score = scoreAXNode(node, 'radio', '외부', ['외부']);
      // Score is only the interactive bonus (10) — no role or name match
      expect(score).toBeLessThanOrEqual(10);
    });

    test('should give 75+ for exact name match without role hint', () => {
      const node = makeNode('radio', '외부');
      const score = scoreAXNode(node, null, '외부', ['외부']);
      expect(score).toBeGreaterThanOrEqual(75);
    });

    test('should give 50+ for name contains without role hint', () => {
      const node = makeNode('button', 'Submit 외부');
      const score = scoreAXNode(node, null, '외부', ['외부']);
      expect(score).toBeGreaterThanOrEqual(50);
    });

    test('should give role-match-only score of 30+ when name empty', () => {
      const node = makeNode('button', '');
      const score = scoreAXNode(node, 'button', '', []);
      expect(score).toBeGreaterThanOrEqual(30);
    });

    test('should add interactive role bonus', () => {
      const interactive = makeNode('button', 'Click');
      const nonInteractive = makeNode('heading', 'Click');
      const scoreI = scoreAXNode(interactive, null, 'Click', ['click']);
      const scoreN = scoreAXNode(nonInteractive, null, 'Click', ['click']);
      expect(scoreI).toBeGreaterThan(scoreN);
    });

    test('should penalize disabled elements', () => {
      const enabled = makeNode('radio', '내부');
      const disabled = makeNode('radio', '내부', { disabled: true });
      const scoreE = scoreAXNode(enabled, 'radio', '내부', ['내부']);
      const scoreD = scoreAXNode(disabled, 'radio', '내부', ['내부']);
      expect(scoreE).toBeGreaterThan(scoreD);
    });

    test('should handle token overlap scoring', () => {
      const node = makeNode('generic', 'first name label');
      const score = scoreAXNode(node, null, 'first name', ['first', 'name']);
      expect(score).toBeGreaterThan(0);
    });

    test('should return 0 for empty name and no role hint', () => {
      const node = makeNode('generic', '');
      const score = scoreAXNode(node, null, 'test', ['test']);
      expect(score).toBe(0);
    });

    test('should handle case insensitivity', () => {
      const node = makeNode('Button', 'SUBMIT');
      const score = scoreAXNode(node, 'button', 'submit', ['submit']);
      expect(score).toBeGreaterThanOrEqual(100);
    });

    describe('real-world Angular Material radio button scenario', () => {
      test('should score radio "외부" highest for query "외부 radio button"', () => {
        const radio = makeNode('radio', '외부');
        const helpButton = makeNode('button', '외부 사용자 유형 도움말');
        const container = makeNode('radiogroup', '대상');

        const radioScore = scoreAXNode(radio, 'radio', '외부', ['외부']);
        const helpScore = scoreAXNode(helpButton, 'radio', '외부', ['외부']);
        const containerScore = scoreAXNode(container, 'radio', '외부', ['외부']);

        // Radio should win decisively
        expect(radioScore).toBeGreaterThan(helpScore);
        expect(radioScore).toBeGreaterThan(containerScore);
        expect(radioScore).toBeGreaterThanOrEqual(100);
      });

      test('should handle disabled "내부" radio with penalty', () => {
        const internal = makeNode('radio', '내부', { disabled: true });
        const external = makeNode('radio', '외부');

        const internalScore = scoreAXNode(internal, 'radio', '외부', ['외부']);
        const externalScore = scoreAXNode(external, 'radio', '외부', ['외부']);

        expect(externalScore).toBeGreaterThan(internalScore);
      });
    });
  });
});
