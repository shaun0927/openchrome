/// <reference types="jest" />

describe('oc_query_debug tool', () => {
  const getHandler = async () => {
    jest.resetModules();
    const { registerOcQueryDebugTool } = await import('../../src/tools/oc-query-debug');
    const tools = new Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>();
    registerOcQueryDebugTool({
      registerTool: (name: string, handler: unknown) => tools.set(name, { handler: handler as never }),
    } as never);
    return tools.get('oc_query_debug')!.handler;
  };

  beforeEach(async () => {
    jest.resetModules();
    const { clearQueryDebug } = await import('../../src/query-debug/store');
    clearQueryDebug();
  });

  test('returns not found for unknown tab', async () => {
    const handler = await getHandler();
    const result = await handler('s1', { tabId: 't1' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.found).toBe(false);
  });

  test('returns latest extract debug record', async () => {
    const handler = await getHandler();
    const { recordQueryDebug } = await import('../../src/query-debug/store');
    recordQueryDebug({ kind: 'extract', sessionId: 's1', tabId: 't1', timestamp: new Date().toISOString(), normalized: '{ title }', fieldsFound: ['title'] });
    const result = await handler('s1', { tabId: 't1', kind: 'extract' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.found).toBe(true);
    expect(payload.record.normalized).toBe('{ title }');
  });
});
