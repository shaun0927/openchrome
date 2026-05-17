/// <reference types="jest" />
import type { MCPAdapter } from '../benchmark-runner';
import { createLiveMcpExtractor, extractLiveMcpPayload } from './live-token-wiring';

describe('live token extractor wiring', () => {
  const ctx = { html: '<html></html>', fixtureName: 'f', archetype: 'a', liveAllowed: true, groundTruth: { fixture: 'f', fields: [{ key: 'title', expected: 'Hello' }] } };
  test('sync extractor remains live-gated', () => {
    const extractor = createLiveMcpExtractor({ library: 'openchrome-readpage-dom', mode: 'dom', adapterFactory: jest.fn() });
    expect(extractor.extract({ ...ctx, liveAllowed: false })).toBeNull();
    expect(() => extractor.extract(ctx)).toThrow(/async live extraction/);
  });
  test('async live extraction drives adapter create/read/close', async () => {
    const adapter: MCPAdapter = { name: 'mock', mode: 'live', kind: 'library', setup: jest.fn(), teardown: jest.fn(), callTool: jest.fn(async (tool: string) => tool === 'tabs_create' ? { content: [{ type: 'text', text: '{"tabId":"t"}' }] } : { content: [{ type: 'text', text: '<main><h1 data-field="title">Hello</h1><p>Hello elsewhere</p></main>' }] }) };
    const result = await extractLiveMcpPayload({ library: 'openchrome', mode: 'dom', adapterFactory: () => adapter }, 'http://x', ctx);
    expect(result.payload).toContain('Hello');
    expect(result.extracted.title).toBe('Hello');
    expect(adapter.callTool).toHaveBeenCalledWith('read_page', { tabId: 't', mode: 'dom' });
    expect(adapter.callTool).toHaveBeenCalledWith('tabs_close', { tabId: 't' });
  });

  test('does not treat raw substring matches as structured extraction', async () => {
    const adapter: MCPAdapter = { name: 'mock', mode: 'live', kind: 'library', callTool: jest.fn(async (tool: string) => tool === 'tabs_create' ? { content: [{ type: 'text', text: '{\"tabId\":\"t\"}' }] } : { content: [{ type: 'text', text: 'Hello appears in an unstructured blob' }] }) };

    const result = await extractLiveMcpPayload({ library: 'openchrome', mode: 'ax', adapterFactory: () => adapter }, 'http://x', ctx);

    expect(result.payload).toContain('Hello');
    expect(result.extracted.title).toBeNull();
  });

  test('extracts structured JSON fields when a live adapter returns JSON', async () => {
    const adapter: MCPAdapter = { name: 'mock', mode: 'live', kind: 'library', callTool: jest.fn(async (tool: string) => tool === 'tabs_create' ? { content: [{ type: 'text', text: '{\"tabId\":\"t\"}' }] } : { content: [{ type: 'text', text: '{\"title\":\"Hello\"}' }] }) };

    const result = await extractLiveMcpPayload({ library: 'openchrome', mode: 'dom', adapterFactory: () => adapter }, 'http://x', ctx);

    expect(result.extracted.title).toBe('Hello');
  });

  test('closes created tabs when read_page fails', async () => {
    const adapter: MCPAdapter = {
      name: 'mock',
      mode: 'live',
      kind: 'library',
      teardown: jest.fn(),
      callTool: jest.fn(async (tool: string) => {
        if (tool === 'tabs_create') return { content: [{ type: 'text', text: '{\"tabId\":\"t\"}' }] };
        if (tool === 'read_page') return { isError: true, content: [{ type: 'text', text: 'read failed' }] };
        return { content: [{ type: 'text', text: 'closed' }] };
      }),
    };

    await expect(extractLiveMcpPayload({ library: 'openchrome', mode: 'ax', adapterFactory: () => adapter }, 'http://x', ctx)).rejects.toThrow(/read failed/);

    expect(adapter.callTool).toHaveBeenCalledWith('tabs_close', { tabId: 't' });
    expect(adapter.teardown).toHaveBeenCalled();
  });
});
