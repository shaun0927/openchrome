import { appendMetricsFooter, buildRawTextMetrics, buildTextMetrics, estimateTokens } from '../../../src/core/metrics/token-estimate';

describe('token metrics helpers', () => {
  test('estimates empty and ASCII text without provider-specific claims', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefghijkl')).toBe(3);
    expect(estimateTokens('abcdefghijklm')).toBe(4);
  });

  test('handles CJK and large strings deterministically', () => {
    expect(estimateTokens('한국어문장')).toBe(Math.ceil('한국어문장'.length / 4));
    expect(estimateTokens('x'.repeat(10_001))).toBe(2501);
  });

  test('builds returned text metrics', () => {
    expect(buildTextMetrics('hello world', { mode: 'dom' })).toEqual({
      returned_chars: 11,
      estimated_tokens: 3,
      truncated: false,
      mode: 'dom',
    });
  });

  test('builds raw-vs-returned compression metrics', () => {
    const metrics = buildRawTextMetrics('x'.repeat(100), 'x'.repeat(20), { mode: 'crawl' });
    expect(metrics).toMatchObject({
      raw_chars: 100,
      returned_chars: 20,
      raw_estimated_tokens: 25,
      estimated_tokens: 5,
      compression_ratio: 5,
      truncated: false,
      mode: 'crawl',
    });
  });

  test('appends a machine-readable metrics footer', () => {
    expect(appendMetricsFooter('body', { returned_chars: 4 })).toBe('body\n\n[openchrome_metrics] {"returned_chars":4}');
  });
});
