/// <reference types="jest" />
/**
 * Tests for cli/playbook/expand.ts
 *
 * Verifies that each of the 9 verbs maps to the expected tool name and args shape.
 */

import { expandStep, ExpandedStep } from '../../../cli/playbook/expand';
import type { Verb } from '../../../cli/playbook/parse';

describe('expandStep', () => {
  test('navigate → navigate tool, args pass-through', () => {
    const result = expandStep('navigate', { url: 'https://example.com' });
    expect(result.tool).toBe('navigate');
    expect(result.callArgs).toEqual({ url: 'https://example.com' });
  });

  test('interact → interact tool, args pass-through', () => {
    const result = expandStep('interact', { ref: 'Submit button' });
    expect(result.tool).toBe('interact');
    expect(result.callArgs).toEqual({ ref: 'Submit button' });
  });

  test('act → act tool, args pass-through', () => {
    const result = expandStep('act', { action: 'scroll down' });
    expect(result.tool).toBe('act');
    expect(result.callArgs).toEqual({ action: 'scroll down' });
  });

  test('fill_form → fill_form tool, args pass-through', () => {
    const result = expandStep('fill_form', { fields: { email: 'a@b.com' } });
    expect(result.tool).toBe('fill_form');
    expect(result.callArgs).toEqual({ fields: { email: 'a@b.com' } });
  });

  test('wait_for → wait_for tool, args pass-through', () => {
    const result = expandStep('wait_for', { condition: 'navigation' });
    expect(result.tool).toBe('wait_for');
    expect(result.callArgs).toEqual({ condition: 'navigation' });
  });

  test('page_screenshot → page_screenshot tool, args pass-through', () => {
    const result = expandStep('page_screenshot', { path: '/tmp/ss.png' });
    expect(result.tool).toBe('page_screenshot');
    expect(result.callArgs).toEqual({ path: '/tmp/ss.png' });
  });

  test('read_page → read_page tool, args pass-through', () => {
    const result = expandStep('read_page', { mode: 'ax' });
    expect(result.tool).toBe('read_page');
    expect(result.callArgs).toEqual({ mode: 'ax' });
  });

  test('javascript_tool → javascript_tool tool, args pass-through', () => {
    const result = expandStep('javascript_tool', { code: 'document.title' });
    expect(result.tool).toBe('javascript_tool');
    expect(result.callArgs).toEqual({ code: 'document.title' });
  });

  test('assert → oc_assert tool, YAML node wrapped in contract field', () => {
    const assertArgs = { kind: 'dom_text', selector: 'h1', pattern: 'Example' };
    const result = expandStep('assert', assertArgs);
    expect(result.tool).toBe('oc_assert');
    expect(result.callArgs).toEqual({ contract: assertArgs });
  });

  test('assert: nested and/or/not is wrapped in contract field', () => {
    const assertArgs = {
      kind: 'and',
      children: [
        { kind: 'dom_text', selector: 'h1', pattern: 'Example' },
        { kind: 'url', pattern: 'example\\.com' },
      ],
    };
    const result = expandStep('assert', assertArgs);
    expect(result.tool).toBe('oc_assert');
    expect(result.callArgs).toEqual({ contract: assertArgs });
  });

  test('assert: url pattern is wrapped in contract field', () => {
    const assertArgs = { kind: 'url', pattern: 'iana\\.org' };
    const result = expandStep('assert', assertArgs);
    expect(result.tool).toBe('oc_assert');
    expect(result.callArgs).toEqual({ contract: { kind: 'url', pattern: 'iana\\.org' } });
  });

  test('assert: explicit contract/evidence payload passes through unchanged', () => {
    const assertArgs = {
      contract: { kind: 'url', pattern: 'fixtures/playbook' },
      evidence: { snapshot: { url: 'http://127.0.0.1:8765/fixtures/playbook' } },
    };
    const result = expandStep('assert', assertArgs);
    expect(result.tool).toBe('oc_assert');
    expect(result.callArgs).toEqual(assertArgs);
  });

  test('all 9 verbs produce non-empty tool names', () => {
    const verbs: Verb[] = [
      'navigate', 'interact', 'act', 'fill_form', 'wait_for',
      'page_screenshot', 'read_page', 'javascript_tool', 'assert',
    ];
    for (const verb of verbs) {
      const result = expandStep(verb, {});
      expect(result.tool).toBeTruthy();
      expect(typeof result.callArgs).toBe('object');
    }
  });
});
