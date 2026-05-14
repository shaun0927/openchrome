/// <reference types="jest" />

import { getMetricsCollector } from '../../src/metrics/collector';
import { estimateOutputTokensFromChars, extractCacheStatus } from '../../src/mcp-server';

describe('tool output observability metrics', () => {
  afterEach(() => {
    jest.dontMock('../../src/session-manager');
    jest.dontMock('../../src/utils/ref-id-manager');
    jest.dontMock('../../src/dom');
  });

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

  test('read_page delta responses expose real compression savings metadata', async () => {
    jest.resetModules();
    const baseLines = Array.from({ length: 80 }, (_, i) => `<p>Stable copy ${i}</p>`);
    const domSnapshots = [
      ['<html>', '<body>', '<h1>Title</h1>', ...baseLines, '</body>', '</html>'].join('\n'),
      ['<html>', '<body>', '<h1>Title</h1>', ...baseLines, '<span>new</span>', '</body>', '</html>'].join('\n'),
    ];
    let callIndex = 0;

    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => ({
        getPage: jest.fn().mockResolvedValue({}),
        getAvailableTargets: jest.fn().mockResolvedValue([]),
        getCDPClient: jest.fn().mockReturnValue({ send: jest.fn() }),
      }),
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => ({}),
    }));
    jest.doMock('../../src/dom', () => ({
      serializeDOM: jest.fn().mockImplementation(async () => ({
        content: domSnapshots[Math.min(callIndex++, domSnapshots.length - 1)],
        pageStats: {
          url: 'https://example.test/page',
          title: 'Example',
          scrollX: 0,
          scrollY: 0,
          viewportWidth: 800,
          viewportHeight: 600,
          scrollWidth: 800,
          scrollHeight: 1200,
        },
      })),
    }));

    const { SnapshotStore } = await import('../../src/compression/snapshot-store');
    SnapshotStore.getInstance().clear();
    const { registerReadPageTool } = await import('../../src/tools/read-page');
    const tools = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    registerReadPageTool({
      registerTool: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        tools.set(name, handler);
      },
    } as never);
    const handler = tools.get('read_page')!;

    await handler('session-a', {
      tabId: 'tab-a',
      mode: 'dom',
      compression: 'delta',
      includePagination: false,
    });
    const deltaResult = await handler('session-a', {
      tabId: 'tab-a',
      mode: 'dom',
      compression: 'delta',
      includePagination: false,
    }) as { _compression?: { level?: string; originalChars?: number; compressedChars?: number } };

    expect(deltaResult._compression).toMatchObject({ level: 'delta' });
    expect(deltaResult._compression?.originalChars).toBeGreaterThan(deltaResult._compression?.compressedChars ?? Infinity);
  });
});
