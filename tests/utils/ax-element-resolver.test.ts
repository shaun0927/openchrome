/// <reference types="jest" />
/**
 * Unit tests for AX-First Element Resolution (cascading filter architecture)
 */

import {
  parseQueryForAX,
  cascadeFilter,
  AXNodeFlat,
  MATCH_LEVEL_LABELS,
} from '../../src/utils/ax-element-resolver';

describe('AX Element Resolver', () => {
  describe('parseQueryForAX', () => {
    test('should extract role and name from "외부 radio button"', () => {
      const result = parseQueryForAX('외부 radio button');
      expect(result.roleHint).toBe('radio');
      expect(result.nameHint).toBe('외부');
    });

    test('should extract role and name from "Submit button"', () => {
      const result = parseQueryForAX('Submit button');
      expect(result.roleHint).toBe('button');
      expect(result.nameHint).toBe('Submit');
    });

    test('should prefer longest match: "radio button" over "radio"', () => {
      const result = parseQueryForAX('외부 radio button');
      expect(result.roleHint).toBe('radio');
      expect(result.nameHint).not.toContain('button');
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

    test('should handle role keyword at beginning', () => {
      const result = parseQueryForAX('button Submit');
      expect(result.roleHint).toBe('button');
      expect(result.nameHint).toBe('Submit');
    });

    test('should handle link keyword', () => {
      const result = parseQueryForAX('Learn more link');
      expect(result.roleHint).toBe('link');
      expect(result.nameHint).toBe('Learn more');
    });
  });

  describe('cascadeFilter', () => {
    let nodeId = 100;
    const makeNode = (role: string, name: string, props: Record<string, unknown> = {}): AXNodeFlat => ({
      nodeId: nodeId++,
      backendDOMNodeId: nodeId,
      role,
      name,
      properties: props,
    });

    const nodes = [
      makeNode('radio', '외부'),
      makeNode('radio', '내부', { disabled: true }),
      makeNode('button', '외부 사용자 유형 도움말'),
      makeNode('radiogroup', '대상'),
      makeNode('button', 'Submit'),
      makeNode('link', 'Learn more'),
      makeNode('textbox', 'Search'),
      makeNode('radio', '외부 고급 설정'),
    ];

    test('Level 1: exact role + exact name', () => {
      const results = cascadeFilter(nodes, 'radio', '외부');
      expect(results.length).toBe(1);
      expect(results[0].node.role).toBe('radio');
      expect(results[0].node.name).toBe('외부');
      expect(results[0].matchLevel).toBe(1);
    });

    test('Level 2: exact role + name contains', () => {
      const results = cascadeFilter(nodes, 'radio', '고급');
      expect(results.length).toBe(1);
      expect(results[0].node.name).toBe('외부 고급 설정');
      expect(results[0].matchLevel).toBe(2);
    });

    test('Level 3: exact name without role hint', () => {
      const results = cascadeFilter(nodes, null, 'Submit');
      expect(results.length).toBe(1);
      expect(results[0].node.role).toBe('button');
      expect(results[0].node.name).toBe('Submit');
      expect(results[0].matchLevel).toBe(3);
    });

    test('Level 4: name contains without role hint', () => {
      const results = cascadeFilter(nodes, null, 'Learn');
      expect(results.length).toBe(1);
      expect(results[0].node.name).toBe('Learn more');
      expect(results[0].matchLevel).toBe(4);
    });

    test('should filter out disabled elements', () => {
      const results = cascadeFilter(nodes, 'radio', '내부');
      expect(results.length).toBe(0);
    });

    test('should filter out non-interactive roles', () => {
      const results = cascadeFilter(nodes, 'radiogroup', '대상');
      expect(results.length).toBe(0);
    });

    test('should return empty array when no match', () => {
      const results = cascadeFilter(nodes, 'slider', 'Volume');
      expect(results.length).toBe(0);
    });

    test('should return empty array for empty name hint', () => {
      const results = cascadeFilter(nodes, 'button', '');
      expect(results.length).toBe(0);
    });

    test('should be case insensitive', () => {
      const results = cascadeFilter(nodes, 'button', 'submit');
      expect(results.length).toBe(1);
      expect(results[0].node.name).toBe('Submit');
    });

    test('should respect maxResults', () => {
      const manyNodes = [
        makeNode('button', 'Action 1'),
        makeNode('button', 'Action 2'),
        makeNode('button', 'Action 3'),
        makeNode('button', 'Action 4'),
        makeNode('button', 'Action 5'),
      ];
      const results = cascadeFilter(manyNodes, null, 'Action', 2);
      expect(results.length).toBe(2);
    });

    test('should stop at first matching level (not mix levels)', () => {
      const results = cascadeFilter(nodes, 'radio', '외부');
      expect(results.every(r => r.matchLevel === 1)).toBe(true);
    });

    describe('real-world Angular Material radio button scenario', () => {
      test('should pick radio "외부" over button "외부 사용자 유형 도움말"', () => {
        const results = cascadeFilter(nodes, 'radio', '외부');
        expect(results.length).toBe(1);
        expect(results[0].node.role).toBe('radio');
        expect(results[0].node.name).toBe('외부');
      });

      test('should not return disabled "내부" radio', () => {
        const results = cascadeFilter(nodes, 'radio', '내부');
        expect(results.length).toBe(0);
      });
    });
  });

  describe('MATCH_LEVEL_LABELS', () => {
    test('should have labels for all 4 levels', () => {
      expect(MATCH_LEVEL_LABELS[1]).toBe('exact match');
      expect(MATCH_LEVEL_LABELS[2]).toBe('role match');
      expect(MATCH_LEVEL_LABELS[3]).toBe('name match');
      expect(MATCH_LEVEL_LABELS[4]).toBe('partial match');
    });
  });
});
