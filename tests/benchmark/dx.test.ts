/// <reference types="jest" />

import {
  countSourceLines,
  scoreErrorActionability,
  meanActionability,
} from './dx';

describe('countSourceLines', () => {
  test('counts code lines, excluding blank and full-comment lines', () => {
    const source = [
      'const a = 1;',
      '',
      '// a line comment',
      'const b = 2;',
      '   ',
      'doThing(a, b);',
    ].join('\n');
    const result = countSourceLines(source);
    expect(result.code).toBe(3);
    expect(result.comment).toBe(1);
    expect(result.blank).toBe(2);
    expect(result.total).toBe(6);
  });

  test('a trailing comment still counts the line as code', () => {
    const result = countSourceLines('const x = 1; // assign x');
    expect(result.code).toBe(1);
    expect(result.comment).toBe(0);
  });

  test('handles multi-line block comments', () => {
    const source = [
      'const a = 1;',
      '/* this is',
      '   a block comment */',
      'const b = 2;',
    ].join('\n');
    const result = countSourceLines(source);
    expect(result.code).toBe(2);
    expect(result.comment).toBe(2);
  });

  test('code before a block comment opener still counts as code', () => {
    const result = countSourceLines('doThing(); /* trailing block');
    expect(result.code).toBe(1);
  });

  test('an empty source has zero code lines', () => {
    expect(countSourceLines('').code).toBe(0);
  });
});

describe('scoreErrorActionability', () => {
  test('a fully actionable error scores 3', () => {
    const error =
      'Click failed: selector ".submit-btn" not found on https://example.com — ' +
      'try waiting for the element or use a more specific selector';
    const result = scoreErrorActionability(error);
    expect(result.hasCause).toBe(true);
    expect(result.hasLocation).toBe(true);
    expect(result.hasNextStep).toBe(true);
    expect(result.score).toBe(3);
  });

  test('a bare error with no cause/location/next-step scores 0', () => {
    expect(scoreErrorActionability('Something went wrong').score).toBe(0);
  });

  test('cause only scores 1', () => {
    const result = scoreErrorActionability('the operation timed out');
    expect(result.hasCause).toBe(true);
    expect(result.hasLocation).toBe(false);
    expect(result.hasNextStep).toBe(false);
    expect(result.score).toBe(1);
  });

  test('detects a location from a url, selector, or file:line', () => {
    expect(scoreErrorActionability('error at https://site.test/page').hasLocation).toBe(true);
    expect(scoreErrorActionability('no node matched #main .row').hasLocation).toBe(true);
    expect(scoreErrorActionability('thrown at runner.ts:42').hasLocation).toBe(true);
  });

  test('detects a next step from rubric keywords', () => {
    expect(scoreErrorActionability('did you mean #submit?').hasNextStep).toBe(true);
    expect(scoreErrorActionability('retry the navigation').hasNextStep).toBe(true);
  });

  test('is deterministic — same input, same score', () => {
    const e = 'navigation failed: timeout at https://x.test — try increasing the wait';
    expect(scoreErrorActionability(e)).toEqual(scoreErrorActionability(e));
  });
});

describe('meanActionability', () => {
  test('averages scores across a set of induced-failure errors', () => {
    const errors = [
      'Something went wrong', // 0
      'request timed out', // 1 (cause)
      'selector ".x" not found — try a broader selector', // 3
    ];
    expect(meanActionability(errors)).toBeCloseTo((0 + 1 + 3) / 3);
  });

  test('an empty error set scores 0', () => {
    expect(meanActionability([])).toBe(0);
  });
});
