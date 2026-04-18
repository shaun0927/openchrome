/// <reference types="jest" />
/**
 * Tests for cookie scan outcome metrics registration.
 *
 * Issue #6 (A-6): the cookie source scan previously returned `null` for both
 * "no matching pages" and "timed out partway through" without distinguishing
 * which case applied. Now the scan emits:
 *   - openchrome_cookie_scan_total{status=complete|partial|no_candidates|no_cookies}
 *   - openchrome_cookie_scan_duration_seconds{status}
 *   - openchrome_cookie_scan_targets_scanned{status}
 *
 * This test verifies the metrics are *registered* and can accept values for
 * every documented status. Full behavior tests of _doFindAuthenticatedPageTargetId
 * would require heavy puppeteer mocks and live in tests/src/cdp-client-*.
 */

import { MetricsCollector, getMetricsCollector } from '../../src/metrics/collector';

function metricsDumpIncludes(substring: string): boolean {
  return getMetricsCollector().export().includes(substring);
}

describe('cookie scan metrics', () => {
  it('registers counter and histograms with all outcome buckets', () => {
    const m = getMetricsCollector();
    // Exercise every status to force a series per label value.
    for (const status of ['complete', 'partial', 'no_candidates', 'no_cookies']) {
      m.inc('openchrome_cookie_scan_total', { status });
      m.observe('openchrome_cookie_scan_duration_seconds', { status }, 0.42);
      m.observe('openchrome_cookie_scan_targets_scanned', { status }, 3);
    }

    const dump = m.export();
    expect(dump).toMatch(/# TYPE openchrome_cookie_scan_total counter/);
    expect(dump).toMatch(/# TYPE openchrome_cookie_scan_duration_seconds histogram/);
    expect(dump).toMatch(/# TYPE openchrome_cookie_scan_targets_scanned histogram/);

    for (const status of ['complete', 'partial', 'no_candidates', 'no_cookies']) {
      expect(dump).toContain(`openchrome_cookie_scan_total{status="${status}"}`);
    }
  });

  it('ignores unknown metric names safely (no throw, no effect)', () => {
    // inc() silently no-ops on unregistered metrics; verify that is still true
    // so the cookie-scan recordOutcome try/catch around metric access remains
    // the only line of defense for unavailable-collector edge cases.
    const isolated = new MetricsCollector();
    expect(() => isolated.inc('nonexistent_metric')).not.toThrow();
    expect(() => isolated.observe('nonexistent_histogram', {}, 1)).not.toThrow();
  });

  it('counter values monotonically increase with .inc()', () => {
    const m = getMetricsCollector();
    const dump1 = m.export();
    const before = (dump1.match(/openchrome_cookie_scan_total\{status="complete"\}\s+(\d+)/) || [])[1];
    m.inc('openchrome_cookie_scan_total', { status: 'complete' });
    const dump2 = m.export();
    const after = (dump2.match(/openchrome_cookie_scan_total\{status="complete"\}\s+(\d+)/) || [])[1];
    expect(parseInt(after, 10)).toBe(parseInt(before, 10) + 1);
  });
});
