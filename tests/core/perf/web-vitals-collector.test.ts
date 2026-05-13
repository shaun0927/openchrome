/// <reference types="jest" />

import {
  normalizeWebVitals,
  rateCls,
  rateFcp,
  rateInp,
  rateLcp,
  rateTtfb,
  resolveVitalsElementLabel,
} from '../../../src/core/perf/web-vitals-collector';

describe('web-vitals collector helpers', () => {
  test('rates threshold boundaries per Core Web Vitals cutoffs', () => {
    expect(rateLcp(2500)).toBe('good');
    expect(rateLcp(2501)).toBe('needs-improvement');
    expect(rateLcp(4000)).toBe('needs-improvement');
    expect(rateLcp(4001)).toBe('poor');

    expect(rateCls(0.1)).toBe('good');
    expect(rateCls(0.1001)).toBe('needs-improvement');
    expect(rateCls(0.25)).toBe('needs-improvement');
    expect(rateCls(0.2501)).toBe('poor');

    expect(rateInp(200)).toBe('good');
    expect(rateInp(201)).toBe('needs-improvement');
    expect(rateInp(500)).toBe('needs-improvement');
    expect(rateInp(501)).toBe('poor');

    expect(rateTtfb(800)).toBe('good');
    expect(rateTtfb(801)).toBe('needs-improvement');
    expect(rateTtfb(1800)).toBe('needs-improvement');
    expect(rateTtfb(1801)).toBe('poor');

    expect(rateFcp(1800)).toBe('good');
    expect(rateFcp(1801)).toBe('needs-improvement');
    expect(rateFcp(3000)).toBe('needs-improvement');
    expect(rateFcp(3001)).toBe('poor');
  });

  test('normalizes INP null with explicit no-interaction reason', () => {
    const result = normalizeWebVitals({
      lcp: null,
      cls: { value: 0, largestShift: null },
      inp: null,
      inpNullReason: 'no-interaction',
      ttfb: { valueMs: 220.2 },
      fcp: { valueMs: 900.4 },
      collectedAtMs: 123.4,
    });

    expect(result.inp).toBeNull();
    expect(result.inpNullReason).toBe('no-interaction');
    expect(result.ttfb).toEqual({ valueMs: 220, rating: 'good' });
    expect(result.fcp).toEqual({ valueMs: 900, rating: 'good' });
  });

  test('resolves LCP element aliases before fallback selectors', () => {
    expect(resolveVitalsElementLabel({ 'data-oc-ref': '@e7' }, '#hero')).toBe('@e7');
    expect(resolveVitalsElementLabel({ 'data-testid': 'hero-card' }, '#hero')).toBe('[data-testid=\"hero-card\"]');
    expect(resolveVitalsElementLabel({}, '#hero')).toBe('#hero');
  });

  test('normalizes LCP element alias and CLS largest shift', () => {
    const result = normalizeWebVitals({
      lcp: { valueMs: 1234.4, element: '@e7', occurredAtMs: 1100.2 },
      cls: { value: 0.054321, largestShift: { valueMs: 12.3, value: 0.03456 } },
      inp: { valueMs: 180.1, interactionCount: 3 },
      ttfb: { valueMs: 220 },
      fcp: { valueMs: 900 },
      collectedAtMs: 1500,
    });

    expect(result.lcp).toEqual({ valueMs: 1234, rating: 'good', element: '@e7', occurredAtMs: 1100 });
    expect(result.cls).toEqual({ value: 0.0543, rating: 'good', largestShift: { valueMs: 12, value: 0.0346 } });
    expect(result.inp).toEqual({ valueMs: 180, rating: 'good', interactionCount: 3 });
  });
});
