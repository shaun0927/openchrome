/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/memory/domain-memory', () => ({
  extractDomainFromUrl: jest.fn(() => 'example.test'),
  getDomainMemory: jest.fn(() => ({ record: jest.fn() })),
}));

import { getSessionManager } from '../../src/session-manager';
import { parseExtractionMode, EXTRACTION_MODE_BUDGETS } from '../../src/extraction';
import { extractDataHandler } from '../../src/tools/extract-data';

const schema = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' },
    price: { type: 'string' },
  },
  required: ['title', 'price'],
};

function responseJson(result: Awaited<ReturnType<typeof extractDataHandler>>): Record<string, unknown> {
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('extract_data modes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates and defaults extraction mode to fast', () => {
    expect(parseExtractionMode(undefined)).toEqual({ ok: true, mode: 'fast' });
    expect(parseExtractionMode('fast')).toEqual({ ok: true, mode: 'fast' });
    expect(parseExtractionMode('standard')).toEqual({ ok: true, mode: 'standard' });
    expect(parseExtractionMode('deep')).toEqual({ ok: false, error: 'Invalid mode. Use "fast" or "standard".' });
    expect(EXTRACTION_MODE_BUDGETS.fast.maxStandardDomNodes).toBe(0);
    expect(EXTRACTION_MODE_BUDGETS.standard.maxStandardDomNodes).toBeGreaterThan(EXTRACTION_MODE_BUDGETS.fast.maxStandardDomNodes);
  });

  it('rejects invalid mode with an actionable error before touching the browser', async () => {
    const result = await extractDataHandler('s1', { tabId: 't1', schema, mode: 'deep' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('Invalid mode');
    expect(getSessionManager).not.toHaveBeenCalled();
  });

  it('uses fast mode by default and does not invoke the standard-only DOM pass', async () => {
    const evaluate = jest.fn(async (script: string) => {
      expect(script).not.toContain('maxNodes');
      if (script.includes('application/ld+json')) return { title: 'Fast title' };
      return {};
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn(async () => ({ url: () => 'https://example.test/product', evaluate })),
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema });
    const body = responseJson(result);

    expect(body.modeUsed).toBe('fast');
    expect((body.data as Record<string, unknown>).title).toBe('Fast title');
    expect(body.fieldsMissing).toEqual(['price']);
    expect(body.strategies).toEqual(['json-ld']);
    expect((body.metrics as Record<string, unknown>).mode).toBe('fast');
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it('standard mode runs the broader DOM pass and can recover fields fast missed', async () => {
    const evaluate = jest.fn(async (script: string) => {
      if (script.includes('application/ld+json')) return { title: 'Fast title' };
      if (script.includes('maxNodes')) return { price: '$19.99' };
      return {};
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn(async () => ({ url: () => 'https://example.test/product', evaluate })),
    });

    const result = await extractDataHandler('s1', { tabId: 't1', schema, mode: 'standard' });
    const body = responseJson(result);

    expect(body.modeUsed).toBe('standard');
    expect(body.fieldsMissing).toBeUndefined();
    expect((body.data as Record<string, unknown>).title).toBe('Fast title');
    expect((body.data as Record<string, unknown>).price).toBe('$19.99');
    expect(body.strategies).toEqual(['json-ld', 'standard-dom']);
    expect((body.metrics as Record<string, unknown>).outputChars).toBeGreaterThan(0);
    expect(evaluate).toHaveBeenCalledTimes(5);
  });
});
