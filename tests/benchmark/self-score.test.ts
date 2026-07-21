/**
 * Self-scoring (faithfulness-NLI) contract tests.
 */

import {
  LexicalOverlapNliGrader,
  runSelfScore,
  type FaithfulnessGrader,
  type SelfScoreInput,
} from './self-score';

describe('LexicalOverlapNliGrader', () => {
  const grader = new LexicalOverlapNliGrader();

  it('flags supported extraction when every token appears in source', () => {
    const result = grader.grade(
      'The capital of France is Paris and it sits on the Seine river.',
      'Paris capital France',
    );
    expect(result.verdict).toBe('supported');
    expect(result.score).toBe(1);
  });

  it('flags contradicted extraction when no tokens match', () => {
    const result = grader.grade(
      'The capital of France is Paris and it sits on the Seine river.',
      'Tokyo baseball stadium',
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.score).toBe(0);
  });

  it('flags unsupported in the middle band', () => {
    const result = grader.grade(
      'Paris capital France capital city Europe monument tower.',
      'Paris tower baseball stadium',
    );
    expect(result.verdict).toBe('unsupported');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(0.7);
  });

  it('returns insufficient when the source is too small', () => {
    const result = grader.grade('Paris.', 'Paris capital France');
    expect(result.verdict).toBe('insufficient');
  });

  it('returns insufficient when the extraction is empty', () => {
    const result = grader.grade(
      'The capital of France is Paris and it sits on the Seine river.',
      '',
    );
    expect(result.verdict).toBe('insufficient');
  });

  it('honours a custom support threshold', () => {
    const strict = new LexicalOverlapNliGrader({ supportThreshold: 0.99 });
    const loose = new LexicalOverlapNliGrader({ supportThreshold: 0.4 });
    const src = 'apple banana cherry date elderberry fig grape';
    const ext = 'apple banana cherry tokyo';
    expect(strict.grade(src, ext).verdict).not.toBe('supported');
    expect(loose.grade(src, ext).verdict).toBe('supported');
  });
});

describe('runSelfScore', () => {
  const grader = new LexicalOverlapNliGrader();

  const batch: SelfScoreInput[] = [
    {
      id: 'a',
      source: 'The capital of France is Paris and it sits on the Seine river.',
      extracted: 'Paris capital France',
    },
    {
      id: 'b',
      source: 'The capital of France is Paris and it sits on the Seine river.',
      extracted: 'Tokyo baseball stadium',
    },
    {
      id: 'c',
      source: 'Paris.',
      extracted: 'Paris',
    },
  ];

  it('produces a well-shaped report envelope', async () => {
    const report = await runSelfScore(grader, batch);
    expect(report.grader).toBe('lexical-nli');
    expect(report.graderLabel).toBe('Lexical Overlap (baseline)');
    expect(new Date(report.generatedAt).toString()).not.toBe('Invalid Date');
    expect(report.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('rolls verdict counts up into the summary', async () => {
    const report = await runSelfScore(grader, batch);
    expect(report.summary.total).toBe(3);
    expect(report.summary.supported).toBe(1);
    expect(report.summary.contradicted).toBe(1);
    expect(report.summary.insufficient).toBe(1);
    // mean is over grade-able entries only.
    expect(report.summary.meanScore).toBeCloseTo(0.5, 5);
  });

  it('supports async graders', async () => {
    const asyncGrader: FaithfulnessGrader = {
      id: 'stub-async',
      label: 'Stub',
      async grade() {
        return { verdict: 'supported', score: 1 } as const;
      },
    };
    const report = await runSelfScore(asyncGrader, [
      { id: 'x', source: 'a b c d e f', extracted: 'a b c' },
    ]);
    expect(report.summary.supported).toBe(1);
    expect(report.grader).toBe('stub-async');
  });
});
