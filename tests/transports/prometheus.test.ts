/// <reference types="jest" />
/**
 * Hand-rolled Prometheus exposition format tests (#839).
 */

import { renderPrometheusMetrics, type PrometheusMetric } from '../../src/transports/prometheus';

describe('renderPrometheusMetrics', () => {
  test('emits HELP, TYPE, and a single value line for a gauge', () => {
    const out = renderPrometheusMetrics([
      { name: 'openchrome_uptime_seconds', help: 'Uptime', type: 'gauge', value: 42 },
    ]);
    expect(out).toContain('# HELP openchrome_uptime_seconds Uptime');
    expect(out).toContain('# TYPE openchrome_uptime_seconds gauge');
    expect(out).toContain('openchrome_uptime_seconds 42');
  });

  test('emits a sample line per label set for a counter', () => {
    const out = renderPrometheusMetrics([
      {
        name: 'openchrome_tool_calls_total',
        help: 'Per-tool totals.',
        type: 'counter',
        samples: [
          { labels: { tool: 'navigate', result: 'success' }, value: 12 },
          { labels: { tool: 'navigate', result: 'error' }, value: 1 },
          { labels: { tool: 'read_page', result: 'success' }, value: 7 },
        ],
      },
    ]);
    expect(out).toContain('openchrome_tool_calls_total{tool="navigate",result="success"} 12');
    expect(out).toContain('openchrome_tool_calls_total{tool="navigate",result="error"} 1');
    expect(out).toContain('openchrome_tool_calls_total{tool="read_page",result="success"} 7');
  });

  test('escapes label values per spec (quotes, backslashes, newlines)', () => {
    const out = renderPrometheusMetrics([
      {
        name: 'openchrome_label_escape_demo',
        help: 'Escape demo.',
        type: 'gauge',
        samples: [
          { labels: { src: 'a"b\\c\nd' }, value: 1 },
        ],
      },
    ]);
    expect(out).toContain('openchrome_label_escape_demo{src="a\\"b\\\\c\\nd"} 1');
  });

  test('omits illegal metric names entirely (no partial leak)', () => {
    const out = renderPrometheusMetrics([
      { name: '1bad-name', help: 'Bad', type: 'gauge', value: 1 },
      { name: 'good_name', help: 'Good', type: 'gauge', value: 2 },
    ]);
    expect(out).not.toContain('1bad-name');
    expect(out).toContain('good_name 2');
  });

  test('omits illegal label keys but preserves the sample line', () => {
    const out = renderPrometheusMetrics([
      {
        name: 'm',
        help: 'X',
        type: 'gauge',
        samples: [{ labels: { 'bad-key': 'v', good_key: 'ok' }, value: 9 }],
      },
    ]);
    expect(out).toContain('m{good_key="ok"} 9');
    expect(out).not.toContain('bad-key');
  });

  test('handles NaN / Infinity per Prometheus spec', () => {
    const out = renderPrometheusMetrics([
      { name: 'nan_metric', help: 'X', type: 'gauge', value: NaN },
      { name: 'inf_metric', help: 'X', type: 'gauge', value: Infinity },
      { name: 'neg_inf_metric', help: 'X', type: 'gauge', value: -Infinity },
    ]);
    expect(out).toContain('nan_metric NaN');
    expect(out).toContain('inf_metric +Inf');
    expect(out).toContain('neg_inf_metric -Inf');
  });

  test('emits an empty samples block as just HELP + TYPE (no value line)', () => {
    const out = renderPrometheusMetrics([
      {
        name: 'empty_counter',
        help: 'No samples yet.',
        type: 'counter',
        samples: [],
      },
    ]);
    expect(out).toContain('# HELP empty_counter No samples yet.');
    expect(out).toContain('# TYPE empty_counter counter');
    expect(out).not.toMatch(/^empty_counter /m);
  });

  test('full exposition contains a trailing blank line between metrics', () => {
    const metrics: PrometheusMetric[] = [
      { name: 'a', help: 'A', type: 'gauge', value: 1 },
      { name: 'b', help: 'B', type: 'gauge', value: 2 },
    ];
    const out = renderPrometheusMetrics(metrics);
    // Each metric block is followed by a blank line; the exposition ends
    // without a stray double-blank.
    expect(out).toMatch(/a 1\n\n# HELP b/);
  });
});
