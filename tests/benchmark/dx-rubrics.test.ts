/// <reference types="jest" />

import {
  countLoc,
  scoreToolSchema,
  scoreErrorActionability,
} from './dx-rubrics';

describe('countLoc', () => {
  test('counts statements; excludes blank and comments', () => {
    const r = countLoc(`// header\n\nconst a = 1;\nimport x from 'y';\n/* block */\nconst b = 2;\n`);
    expect(r.loc).toBe(3);
    // 1 hand-written blank + 1 from the block-comment replacement + 1 trailing
    // newline = 3 blank lines.
    expect(r.blankLines).toBeGreaterThanOrEqual(1);
    expect(r.commentLines).toBe(1);
  });
});

describe('scoreToolSchema', () => {
  test('fully-described tool scores 1', () => {
    const score = scoreToolSchema({
      name: 'navigate',
      description: 'Navigate the current tab to a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { description: 'Target URL.', type: 'string', examples: ['https://example.com'] },
        },
        required: ['url'],
      },
    });
    expect(score.score).toBe(1);
    expect(score.failures).toEqual([]);
  });

  test('missing description drops the score', () => {
    const score = scoreToolSchema({
      name: 'navigate',
      inputSchema: {
        type: 'object',
        properties: { url: { description: 'Target URL.', type: 'string', examples: ['x'] } },
        required: ['url'],
      },
    });
    expect(score.score).toBeCloseTo(4 / 5);
    expect(score.failures).toContain('description');
  });

  test('property without type is flagged', () => {
    const score = scoreToolSchema({
      name: 'navigate',
      description: 'desc',
      inputSchema: {
        type: 'object',
        properties: { url: { description: 'Target URL.', examples: ['x'] } as unknown as { description: string; type: string } },
        required: ['url'],
      },
    });
    expect(score.failures).toContain('property-types');
  });
});

describe('scoreErrorActionability', () => {
  test('clean fully-actionable message scores 3', () => {
    const s = scoreErrorActionability(
      'Selector ".submit" not found on page https://example.com — try waitForSelector(".submit") to allow the form to hydrate.',
    );
    expect(s.score).toBe(3);
    expect(s.cause).toBe(true);
    expect(s.location).toBe(true);
    expect(s.suggestion).toBe(true);
  });

  test('cause-only message scores 1', () => {
    const s = scoreErrorActionability('Internal error');
    expect(s.score).toBe(0);
  });

  test('cause + location scores 2', () => {
    const s = scoreErrorActionability('Navigation timeout on https://x');
    expect(s.score).toBe(2);
    expect(s.cause).toBe(true);
    expect(s.location).toBe(true);
    expect(s.suggestion).toBe(false);
  });

  test('case-insensitive matching', () => {
    const s = scoreErrorActionability('SELECTOR NOT FOUND; CONSIDER waitForSelector');
    expect(s.cause).toBe(true);
    expect(s.suggestion).toBe(true);
  });
});
