import { evaluate } from '../../src/contracts/evaluator';
import type { AssertionContext } from '../../src/contracts/evaluator';

function ctx(over: Partial<AssertionContext> = {}): AssertionContext {
  return {
    url: 'https://example.com/',
    bodyText: '',
    domText: () => '',
    domCount: () => 0,
    hasDialog: false,
    ...over,
  };
}

describe('evaluate — screenshot_class assertion', () => {
  test('passed=true when distance ≤ distance_max', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'order-confirmation/v3', distance_max: 10 },
      ctx({
        screenshotPhashHex: 'aaaaaaaaaaaaaaaa',
        screenshotClassMatch: () => ({ distance: 5, closestHex: 'aaaaaaaaaaaaaaab' }),
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.assertion_kind).toBe('screenshot_class');
    expect(r.details).toMatchObject({
      distance: 5,
      distance_max: 10,
      candidate: 'aaaaaaaaaaaaaaaa',
      closest_exemplar: 'aaaaaaaaaaaaaaab',
    });
  });

  test('passed=false when distance > distance_max', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'cls', distance_max: 5 },
      ctx({
        screenshotPhashHex: 'ffffffffffffffff',
        screenshotClassMatch: () => ({ distance: 20, closestHex: 'aaaaaaaaaaaaaaaa' }),
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.details.distance).toBe(20);
  });

  test('passed=false with no_screenshot_in_context reason when ctx lacks pHash', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'cls', distance_max: 10 },
      ctx({
        screenshotClassMatch: () => ({ distance: 0 }),
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.details.reason).toBe('no_screenshot_in_context');
  });

  test('passed=false with no_class_registry reason when ctx lacks resolver', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'cls', distance_max: 10 },
      ctx({ screenshotPhashHex: 'aaaa' }),
    );
    expect(r.passed).toBe(false);
    expect(r.details.reason).toBe('no_class_registry');
  });

  test('passed=false when class is unknown (resolver returns Infinity)', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'unknown', distance_max: 10 },
      ctx({
        screenshotPhashHex: 'aaaa',
        screenshotClassMatch: () => ({ distance: Number.POSITIVE_INFINITY }),
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.details.distance).toBe(Number.POSITIVE_INFINITY);
  });
});
