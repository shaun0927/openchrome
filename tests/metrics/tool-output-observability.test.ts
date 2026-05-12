/// <reference types="jest" />

import { getMetricsCollector } from '../../src/metrics/collector';
import { estimateOutputTokensFromChars, extractCacheStatus } from '../../src/mcp-server';

describe('tool output observability metrics', () => {
  test('registers output size, estimated token, compression, and cache metrics', () => {
    const m = getMetricsCollector();

    m.observe('openchrome_tool_output_bytes', { tool: 'read_page' }, 1024);
    m.observe('openchrome_tool_estimated_tokens', { tool: 'read_page' }, 256);
    m.observe('openchrome_tool_compression_saved_bytes', { tool: 'read_page', mode: 'delta' }, 768);
    m.inc('openchrome_cache_status_total', { tool: 'act', status: 'HIT', key_version: '2' });

    const dump = m.export();
    expect(dump).toMatch(/# TYPE openchrome_tool_output_bytes histogram/);
    expect(dump).toMatch(/# TYPE openchrome_tool_estimated_tokens histogram/);
    expect(dump).toMatch(/# TYPE openchrome_tool_compression_saved_bytes histogram/);
    expect(dump).toMatch(/# TYPE openchrome_cache_status_total counter/);
    expect(dump).toContain('openchrome_cache_status_total{tool="act",status="HIT",key_version="2"}');
  });

  test('metric label examples stay bounded and omit page-specific data', () => {
    const m = getMetricsCollector();
    m.observe('openchrome_tool_output_bytes', { tool: 'extract_data', tenant: 'unknown' }, 512);
    const dump = m.export();

    expect(dump).toContain('tool="extract_data"');
    expect(dump).not.toContain('https://');
    expect(dump).not.toContain('selector=');
    expect(dump).not.toContain('instruction=');
  });

  test('estimates tokens from characters rather than UTF-8 bytes', () => {
    const output = '測試'.repeat(4);

    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(output.length);
    expect(estimateOutputTokensFromChars(output.length)).toBe(2);
  });

  test('normalizes cache metric labels to bounded buckets', () => {
    expect(extractCacheStatus({
      content: [],
      cache: {
        status: 'hit:user-123',
        keyVersion: '2026-05-12T15:20:00.000Z-request-specific',
      },
    })).toEqual({
      status: 'UNKNOWN',
      keyVersion: 'other',
    });

    expect(extractCacheStatus({
      content: [],
      structuredContent: {
        cacheStatus: 'miss',
        cacheKeyVersion: 'v2',
      },
    })).toEqual({
      status: 'MISS',
      keyVersion: 'v2',
    });
  });
});
