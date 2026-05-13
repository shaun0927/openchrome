/// <reference types="jest" />

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/memory/domain-memory', () => ({
  extractDomainFromUrl: jest.fn(() => 'example.com'),
  getDomainMemory: jest.fn(() => ({ record: jest.fn() })),
}));

import { getSessionManager } from '../../src/session-manager';

describe('ExtractDataTool query mode', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getExtractDataHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/memory/domain-memory', () => ({
      extractDomainFromUrl: () => 'example.com',
      getDomainMemory: () => ({ record: jest.fn() }),
    }));

    const { registerExtractDataTool } = await import('../../src/tools/extract-data');
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerExtractDataTool(mockServer as unknown as Parameters<typeof registerExtractDataTool>[0]);
    return tools.get('extract_data')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    testSessionId = 'test-session-123';
    const { targetId, page } = await mockSessionManager.createTarget(testSessionId, 'https://example.com/products');
    testTargetId = targetId;
    (page.url as jest.Mock).mockReturnValue('https://example.com/products');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns actionable error when neither schema nor query is provided', async () => {
    const handler = await getExtractDataHandler();
    const result = await handler(testSessionId, { tabId: testTargetId }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Either schema or query is required');
  });

  test('rejects ambiguous schema and query together', async () => {
    const handler = await getExtractDataHandler();
    const result = await handler(testSessionId, {
      tabId: testTargetId,
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      query: '{ title }',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('either schema or query, not both');
  });

  test('keeps schema-only extraction behavior working', async () => {
    const handler = await getExtractDataHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.evaluate as jest.Mock).mockResolvedValueOnce({ title: 'Schema Title' });

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.title).toBe('Schema Title');
    expect(payload.fieldsFound).toBe(1);
  });

  test('extracts query-only single object through generated schema', async () => {
    const handler = await getExtractDataHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.evaluate as jest.Mock).mockResolvedValueOnce({ title: 'Query Title', price: '$12.50' });

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ title price(number) }',
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.data).toEqual({ title: 'Query Title', price: 12.5 });
    expect(payload.fieldsFound).toBe(2);
  });


  test('records bounded query debug after extraction', async () => {
    const handler = await getExtractDataHandler();
    const { clearQueryDebug, getLatestQueryDebug } = await import('../../src/query-debug/store');
    clearQueryDebug();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.evaluate as jest.Mock).mockResolvedValueOnce({ title: 'Debug Title' });

    await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ title missing_field }',
    }) as { content: Array<{ text: string }> };

    const debug = getLatestQueryDebug(testSessionId, testTargetId, 'extract');
    expect(debug).not.toBeNull();
    expect(debug?.normalized).toBe('{ title missing_field }');
    expect(debug?.schemaSummary?.fields).toEqual(['title', 'missing_field']);
    expect(debug?.fieldsFound).toEqual(['title']);
    expect(debug?.fieldsMissing).toEqual(['missing_field']);
    expect(debug?.durations?.totalMs).toEqual(expect.any(Number));
  });

  test('infers multiple extraction from list query', async () => {
    const handler = await getExtractDataHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.evaluate as jest.Mock).mockResolvedValueOnce([
      { product_name: 'A', product_price: '$10' },
      { product_name: 'B', product_price: '$12' },
    ]);

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ products[] { product_name product_price(number) } }',
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.multiple).toBe(true);
    expect(payload.queryRoot).toBe('products');
    expect(payload.items).toEqual([
      { product_name: 'A', product_price: 10 },
      { product_name: 'B', product_price: 12 },
    ]);
  });

  test('accepts fast mode placeholder without changing query extraction', async () => {
    const handler = await getExtractDataHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.evaluate as jest.Mock).mockResolvedValueOnce({ title: 'Fast Title' });

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ title }',
      mode: 'fast',
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.title).toBe('Fast Title');
  });

  test('rejects unsupported extraction mode', async () => {
    const handler = await getExtractDataHandler();
    const result = await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ title }',
      mode: 'standard',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('supports only mode="fast"');
  });



  test('records parser failure in query debug', async () => {
    const handler = await getExtractDataHandler();
    const { clearQueryDebug, getLatestQueryDebug } = await import('../../src/query-debug/store');
    clearQueryDebug();

    await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ products[] { } }',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    const debug = getLatestQueryDebug(testSessionId, testTargetId, 'extract');
    expect(debug?.notes?.[0]).toContain('parser failure');
    expect(debug?.strategies).toEqual([]);
  });

  test('returns parser error with example for invalid query', async () => {
    const handler = await getExtractDataHandler();
    const result = await handler(testSessionId, {
      tabId: testTargetId,
      query: '{ products[] { } }',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid query');
    expect(result.content[0].text).toContain('Example:');
  });
});
