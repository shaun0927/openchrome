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
    const adapter: MCPAdapter = { name: 'mock', mode: 'live', kind: 'library', setup: jest.fn(), teardown: jest.fn(), callTool: jest.fn(async (tool: string) => tool === 'tabs_create' ? { content: [{ type: 'text', text: '{"tabId":"t"}' }] } : { content: [{ type: 'text', text: 'Hello payload' }] }) };
    const result = await extractLiveMcpPayload({ library: 'openchrome', mode: 'dom', adapterFactory: () => adapter }, 'http://x', ctx);
    expect(result.payload).toContain('Hello');
    expect(result.extracted.title).toBe('Hello');
    expect(adapter.callTool).toHaveBeenCalledWith('read_page', { tabId: 't' });
  });
});
