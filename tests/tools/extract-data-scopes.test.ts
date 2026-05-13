/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/memory/domain-memory', () => ({
  extractDomainFromUrl: jest.fn(() => 'example.test'),
  getDomainMemory: jest.fn(() => ({ record: jest.fn() })),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  formatStaleRefError: jest.fn((refId: string) => `STALE_REF: ref_id="${refId}" — call read_page (mode='ax') to get fresh refs`),
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';
import { extractDataHandler } from '../../src/tools/extract-data';

const schema = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' },
    price: { type: 'string' },
  },
};

function responseJson(result: Awaited<ReturnType<typeof extractDataHandler>>): Record<string, unknown> {
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

function installPage(evaluateImpl?: (script: string) => Promise<Record<string, unknown> | Record<string, unknown>[]>) {
  const evaluate = jest.fn(evaluateImpl ?? (async (script: string) => {
    if (script.includes('data-openchrome-extract-scope') || script.includes('#product')) return { title: 'Scoped title' };
    return { title: 'Document title', price: '$99' };
  }));
  const send = jest.fn(async (_page: unknown, method: string) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    return {};
  });
  const page = { url: jest.fn(() => 'https://example.test/product'), evaluate };
  (getSessionManager as jest.Mock).mockReturnValue({
    getPage: jest.fn(async () => page),
    getAvailableTargets: jest.fn(async () => []),
    getCDPClient: jest.fn(() => ({ send })),
  });
  return { page, evaluate, send };
}

describe('extract_data scoped extraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRefIdManager as jest.Mock).mockReturnValue({
      isRefStale: jest.fn(() => false),
      getRef: jest.fn((_sessionId: string, _tabId: string, refId: string) => refId === 'ref_7' ? { backendDOMNodeId: 321, frameId: 'frame-1' } : undefined),
      resolveToBackendNodeId: jest.fn(() => 321),
    });
  });

  it('rejects mutually exclusive scope arguments before browser access', async () => {
    const result = await extractDataHandler('s1', {
      tabId: 't1',
      schema,
      selector: '#product',
      backendNodeId: 123,
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('exactly one of selector, ref_id, backendNodeId');
    expect(getSessionManager).not.toHaveBeenCalled();
  });


  it('returns document scope metadata by default', async () => {
    installPage(async (script: string) => {
      if (script.includes('application/ld+json')) return { title: 'Document title', price: '$99' };
      return {};
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema });
    const body = responseJson(result);

    expect(body.scope).toEqual({ type: 'document', resolved: true });
    expect(body.strategies).toEqual(['json-ld']);
  });

  it('returns a smaller scoped payload than document extraction for the same field', async () => {
    const wideSchema = {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        price: { type: 'string' },
        description: { type: 'string' },
      },
    };
    installPage(async (script: string) => {
      if (script.includes('application/ld+json')) {
        return {
          title: 'Target item',
          price: '$19',
          description: 'global page metadata that should not be present in the scoped response'.repeat(20),
        };
      }
      if (script.includes('#target-card')) return { title: 'Target item', price: '$19' };
      return {};
    });

    const full = await extractDataHandler('s1', { tabId: 't1', schema: wideSchema });
    const scoped = await extractDataHandler('s1', { tabId: 't1', schema: wideSchema, selector: '#target-card' });
    const fullText = full.content?.[0]?.text ?? '';
    const scopedText = scoped.content?.[0]?.text ?? '';
    const scopedBody = responseJson(scoped);

    expect(scopedBody.scope).toEqual({ type: 'selector', resolved: true, selector: '#target-card' });
    expect((scopedBody.data as Record<string, unknown>).title).toBe('Target item');
    expect(scopedText.length).toBeLessThan(fullText.length);
  });

  it('reports selector scope metadata and applies the selector to scoped strategies', async () => {
    const { evaluate } = installPage(async (script: string) => {
      if (script.includes('application/ld+json')) return { title: 'Document JSON-LD' };
      if (script.includes('#product')) return { price: '$19' };
      return {};
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema, selector: '#product' });
    const body = responseJson(result);

    expect(body.scope).toEqual({ type: 'selector', resolved: true, selector: '#product' });
    expect(body.strategies).toEqual(['css-heuristic']);
    expect((body.data as Record<string, unknown>).price).toBe('$19');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((evaluate.mock.calls[0][0] as string)).toContain('#product');
  });

  it('resolves ref_id to a backend node scope and returns ref scope metadata', async () => {
    const { evaluate, send } = installPage(async (script: string) => {
      if (script.includes('data-openchrome-extract-scope')) return { title: 'Scoped ref title' };
      return {};
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema, ref_id: 'ref_7' });
    const body = responseJson(result);

    expect(getRefIdManager().getRef).toHaveBeenCalledWith('s1', 't1', 'ref_7');
    expect(getRefIdManager().resolveToBackendNodeId).not.toHaveBeenCalled();
    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), 'DOM.resolveNode', { backendNodeId: 321 });
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Runtime.callFunctionOn', expect.objectContaining({
      objectId: 'obj-1',
      returnByValue: true,
    }));
    expect(body.scope).toEqual({ type: 'ref_id', resolved: true, ref_id: 'ref_7', backendNodeId: 321, frameId: 'frame-1' });
    expect((body.data as Record<string, unknown>).title).toBe('Scoped ref title');
    expect((evaluate.mock.calls[0][0] as string)).toContain('data-openchrome-extract-scope');
  });

  it('returns actionable stale ref guidance when ref_id is expired', async () => {
    (getRefIdManager as jest.Mock).mockReturnValue({
      isRefStale: jest.fn(() => true),
      resolveToBackendNodeId: jest.fn(() => 321),
    });
    installPage();

    const result = await extractDataHandler('s1', { tabId: 't1', schema, ref_id: 'ref_old' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('STALE_REF');
    expect(result.content?.[0]?.text).toContain('read_page');
    expect(result.content?.[0]?.text).toContain('oc_observe');
    expect(getRefIdManager().resolveToBackendNodeId).not.toHaveBeenCalled();
  });

  it('returns actionable stale ref guidance when ref_id cannot be resolved', async () => {
    (getRefIdManager as jest.Mock).mockReturnValue({
      isRefStale: jest.fn(() => false),
      resolveToBackendNodeId: jest.fn(() => undefined),
    });
    installPage();

    const result = await extractDataHandler('s1', { tabId: 't1', schema, ref_id: 'ref_missing' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('STALE_REF');
    expect(result.content?.[0]?.text).toContain('read_page');
    expect(result.content?.[0]?.text).toContain('oc_observe');
  });


  it('does not fall back to document extraction when a scoped marker is unavailable', async () => {
    installPage(async (script: string) => {
      if (script.includes('data-openchrome-extract-scope')) return {};
      if (script.includes('application/ld+json')) return { title: 'Global leaked title', price: '$99' };
      return { title: 'Global leaked title' };
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema, backendNodeId: 654 });
    const body = responseJson(result);

    expect(body.scope).toEqual({ type: 'backendNodeId', resolved: true, backendNodeId: 654 });
    expect(body.data).toEqual({ title: null, price: null });
  });

  it('resolves backendNodeId scopes without document-level structured-data leakage', async () => {
    const { evaluate } = installPage(async (script: string) => {
      if (script.includes('application/ld+json')) return { title: 'Global title', price: '$99' };
      if (script.includes('data-openchrome-extract-scope')) return { title: 'Scoped backend title' };
      return {};
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema, backendNodeId: 654 });
    const body = responseJson(result);

    expect(body.scope).toEqual({ type: 'backendNodeId', resolved: true, backendNodeId: 654 });
    expect(body.strategies).toEqual(['css-heuristic']);
    expect((body.data as Record<string, unknown>).title).toBe('Scoped backend title');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
