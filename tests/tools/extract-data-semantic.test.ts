/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/memory/domain-memory', () => ({
  extractDomainFromUrl: jest.fn(() => 'example.test'),
  getDomainMemory: jest.fn(() => ({ record: jest.fn() })),
}));

import { getSessionManager } from '../../src/session-manager';
import { extractDataHandler } from '../../src/tools/extract-data';

const schema = {
  type: 'object' as const,
  properties: {
    price: { type: 'string' },
    availability: { type: 'string' },
  },
};

function responseJson(result: Awaited<ReturnType<typeof extractDataHandler>>): Record<string, unknown> {
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

function installPage(html: string) {
  const page = {
    url: jest.fn(() => 'https://example.test/product'),
    content: jest.fn(async () => html),
    evaluate: jest.fn(async (fn: (selector: string) => string, selector: string) => {
      if (selector === 'main') return '<main><h1>Scoped</h1><p>Enterprise price is $19.</p></main>';
      return '';
    }),
  };
  (getSessionManager as jest.Mock).mockReturnValue({
    getPage: jest.fn(async () => page),
    getAvailableTargets: jest.fn(async () => []),
  });
  return page;
}

describe('extract_data semantic mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires a query before returning host extraction payload', async () => {
    installPage('<main><h1>Product</h1></main>');

    const result = await extractDataHandler('s1', { tabId: 't1', schema, mode: 'semantic' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('requires a non-empty query');
  });

  it('returns bounded host semantic extraction chunk and continuation metadata without an LLM', async () => {
    installPage(`
      <main>
        <h1>Product</h1>
        <p>Enterprise pricing is $99 and availability is in stock.</p>
        <p>Unrelated company history should be less relevant.</p>
        <p>Pricing details include annual discount and support.</p>
      </main>
    `);

    const result = await extractDataHandler('s1', {
      tabId: 't1',
      schema,
      mode: 'semantic',
      query: 'enterprise pricing availability',
      maxChars: 80,
    });
    const body = responseJson(result);

    expect(result.isError).toBeUndefined();
    expect(body.modeUsed).toBe('semantic');
    expect(body.semanticProvider).toBe('host');
    expect(body.query).toBe('enterprise pricing availability');
    expect(typeof body.nextStartChar === 'number' || body.nextStartChar === null).toBe(true);
    expect((body.chunk as string).length).toBeLessThanOrEqual(80);
    expect((body.chunk as string).toLowerCase()).toContain('pricing');
    expect((body.contentStats as Record<string, unknown>).maxChars).toBe(80);
    expect((body.hostExtraction as Record<string, unknown>).schema).toEqual(schema);
    expect(body.fieldsMissing).toEqual(['price', 'availability']);
  });

  it('continues from startFromChar and caps maxChars at the hard limit', async () => {
    installPage(`<main>${'<p>Enterprise pricing availability section.</p>'.repeat(2000)}</main>`);

    const result = await extractDataHandler('s1', {
      tabId: 't1',
      schema,
      mode: 'semantic',
      query: 'enterprise pricing availability',
      maxChars: 999999,
      startFromChar: 20,
    });
    const body = responseJson(result);
    const stats = body.contentStats as Record<string, unknown>;

    expect(stats.maxChars).toBe(50000);
    expect(stats.startFromChar).toBe(20);
    expect((body.chunk as string).length).toBeLessThanOrEqual(50000);
  });

  it('redacts password-like content before returning chunks', async () => {
    installPage(`
      <main>
        <h1>Credentials</h1>
        <p>Password: hunter2-secret</p>
        <p>API key: abcdefghijklmnopqrstuvwxyz123456</p>
        <p>Enterprise pricing remains visible.</p>
      </main>
    `);

    const result = await extractDataHandler('s1', {
      tabId: 't1',
      schema,
      mode: 'semantic',
      query: 'password api key enterprise pricing',
    });
    const text = result.content?.[0]?.text ?? '';
    const body = responseJson(result);

    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(text).toContain('[REDACTED]');
    expect((body.contentStats as Record<string, unknown>).redactions).toBeGreaterThan(0);
  });

  it('uses selector-scoped html when selector is provided', async () => {
    const page = installPage('<main><h1>Ignored</h1></main>');

    const result = await extractDataHandler('s1', {
      tabId: 't1',
      schema,
      mode: 'semantic',
      query: 'enterprise price',
      selector: 'main',
    });
    const body = responseJson(result);

    expect(page.evaluate).toHaveBeenCalled();
    expect(body.selector).toBe('main');
    expect(body.chunk).toContain('Enterprise price');
  });
});
