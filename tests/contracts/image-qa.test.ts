/**
 * Tests for the image_qa contract evaluator + validator (#1432 Part 2).
 */
import { validateAssertion } from '../../src/contracts/validator';
import { evaluate } from '../../src/contracts/evaluate';
import { evaluateImageQa } from '../../src/contracts/evaluators/image-qa';
import type { EvalContext } from '../../src/contracts/eval-context';
import type { ImageQaAssertion } from '../../src/contracts/types';

function stubCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    url: async () => 'https://example.com/',
    domText: async () => null,
    domCount: async () => 0,
    networkSince: async () => [],
    screenshotPng: async () => Buffer.from([0xde, 0xad]),
    hasOpenDialog: async () => false,
    ...overrides,
  } as EvalContext;
}

describe('image_qa contract DSL (#1432 Part 2)', () => {
  describe('validator', () => {
    it('accepts a well-formed image_qa assertion', () => {
      const result = validateAssertion({
        kind: 'image_qa',
        question: 'is the page in dark mode?',
        expected_pattern: '^yes',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          kind: 'image_qa',
          question: 'is the page in dark mode?',
          expected_pattern: '^yes',
        });
      }
    });

    it('rejects when question is missing', () => {
      const result = validateAssertion({
        kind: 'image_qa',
        expected_pattern: '^yes',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].path).toMatch(/question/);
      }
    });

    it('rejects when expected_pattern is missing', () => {
      const result = validateAssertion({
        kind: 'image_qa',
        question: 'q',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /expected_pattern/.test(e.path))).toBe(true);
      }
    });

    it('rejects an unsafe expected_pattern', () => {
      const result = validateAssertion({
        kind: 'image_qa',
        question: 'q',
        expected_pattern: '(a+)+', // catastrophic-backtrack candidate per safe-regex guard
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('evaluator', () => {
    it('returns inconclusive when ctx has no imageQaSample hook', async () => {
      const a: ImageQaAssertion = {
        kind: 'image_qa',
        question: 'q',
        expected_pattern: '.',
      };
      const r = await evaluateImageQa(a, stubCtx());
      expect(r.passed).toBe(false);
      expect(r.evidence.details).toMatchObject({
        reason: 'host_runtime_did_not_wire_imageQaSample',
      });
    });

    it('returns inconclusive when the host reports unsupported_by_host', async () => {
      const a: ImageQaAssertion = {
        kind: 'image_qa',
        question: 'q',
        expected_pattern: '.',
      };
      const r = await evaluateImageQa(
        a,
        stubCtx({
          imageQaSample: async () => ({
            status: 'unsupported_by_host',
            reason: 'no sampling cap',
          }),
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.evidence.details).toMatchObject({ reason: 'unsupported_by_host' });
    });

    it('passes when the host answer matches the expected pattern', async () => {
      const a: ImageQaAssertion = {
        kind: 'image_qa',
        question: 'dark mode?',
        expected_pattern: '^yes',
      };
      const r = await evaluateImageQa(
        a,
        stubCtx({
          imageQaSample: async () => ({ status: 'ok', answer: 'yes, dark mode is on' }),
        }),
      );
      expect(r.passed).toBe(true);
      expect(r.evidence.details).toMatchObject({
        question: 'dark mode?',
        answer: 'yes, dark mode is on',
      });
    });

    it('fails when the host answer does not match', async () => {
      const a: ImageQaAssertion = {
        kind: 'image_qa',
        question: 'q',
        expected_pattern: '^yes',
      };
      const r = await evaluateImageQa(
        a,
        stubCtx({
          imageQaSample: async () => ({ status: 'ok', answer: 'no, light mode' }),
        }),
      );
      expect(r.passed).toBe(false);
    });

    it('returns no_screenshot_available when ctx.screenshotPng() returns null', async () => {
      const a: ImageQaAssertion = {
        kind: 'image_qa',
        question: 'q',
        expected_pattern: '.',
      };
      const r = await evaluateImageQa(
        a,
        stubCtx({
          screenshotPng: async () => null,
          imageQaSample: async () => ({ status: 'ok', answer: 'whatever' }),
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.evidence.details).toMatchObject({ reason: 'no_screenshot_available' });
    });
  });

  it('dispatches through evaluate() with the canonical assertion kind', async () => {
    const r = await evaluate(
      { kind: 'image_qa', question: 'q', expected_pattern: '^ok$' },
      stubCtx({ imageQaSample: async () => ({ status: 'ok', answer: 'ok' }) }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.assertion_kind).toBe('image_qa');
  });
});
