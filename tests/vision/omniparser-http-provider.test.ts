/// <reference types="jest" />

import { OmniParserHttpProvider } from '../../src/vision/providers/omniparser-http-provider';
import { getOmniParserProviderConfig } from '../../src/vision/config';

type MockPage = {
  viewport: jest.Mock;
  screenshot: jest.Mock;
};

function page(): MockPage {
  return {
    viewport: jest.fn(() => ({ width: 1000, height: 500 })),
    screenshot: jest.fn(async () => Buffer.from('image')),
  };
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  jest.useRealTimers();
});

describe('OmniParserHttpProvider', () => {
  test('posts a guarded screenshot and converts ratio bboxes into perception elements', async () => {
    const p = page();
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      latency: 25,
      parsed_content_list: [
        { type: 'text', content: 'Search label', bbox: [0.1, 0.2, 0.3, 0.4] },
        { type: 'icon', content: 'Continue button', bbox: [0.4, 0.1, 0.6, 0.2], interactive: true, confidence: 0.93 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const snapshot = await new OmniParserHttpProvider(p as never, {
      endpointUrl: 'http://127.0.0.1:9901/parse/',
      timeoutMs: 1000,
    }).capture('tab-1', 'https://example.test');

    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:9901/parse/', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      base64_image: Buffer.from('image').toString('base64'),
    });
    expect(snapshot.provider).toBe('omniparser-http');
    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[0]).toMatchObject({
      id: 'op1',
      type: 'text',
      label: 'Search label',
      interactive: 'unknown',
      source: 'omniparser-http',
    });
    expect(snapshot.elements[0].bbox).toMatchObject({ x: 100, y: 100, height: 100 });
    expect(snapshot.elements[0].bbox.width).toBeCloseTo(200);
    expect(snapshot.elements[0].bboxRatio).toMatchObject({ x: 0.1, y: 0.2, height: 0.2 });
    expect(snapshot.elements[0].bboxRatio.width).toBeCloseTo(0.2);
    expect(snapshot.elements[1]).toMatchObject({ type: 'control', interactive: true, confidence: 0.93 });
  });

  test('bounds labels/elements and ignores malformed entries with warnings', async () => {
    const p = page();
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      parsed_content_list: [
        { type: 'text', content: `password=super-secret-fixture-password ${'x'.repeat(50)}`, bbox: { x: 0, y: 0, width: 0.2, height: 0.1 } },
        { type: 'text', content: 'missing bbox' },
        { type: 'text', content: 'third', bbox: [0.2, 0.2, 0.3, 0.3] },
      ],
    }), { status: 200 })) as typeof fetch;

    const snapshot = await new OmniParserHttpProvider(p as never, {
      endpointUrl: 'http://local/parse',
      maxElements: 2,
      maxLabelLength: 12,
    }).capture('tab', 'https://example.test');

    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0].label).toBe('[REDACTED]…');
    expect(snapshot.warnings.join('\n')).toContain('truncated from 3 to 2');
    expect(snapshot.warnings.join('\n')).toContain('without a valid bbox');
  });

  test('throws bounded error on malformed response', async () => {
    const p = page();
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ parsed_content_list: 'bad' }), { status: 200 })) as typeof fetch;

    await expect(new OmniParserHttpProvider(p as never, {
      endpointUrl: 'http://local/parse',
    }).capture('tab', 'https://example.test')).rejects.toThrow('parsed_content_list must be an array');
  });

  test('respects timeout with abort controller', async () => {
    jest.useFakeTimers();
    const p = page();
    global.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject((init as RequestInit).signal?.reason));
    })) as typeof fetch;

    const promise = new OmniParserHttpProvider(p as never, {
      endpointUrl: 'http://local/parse',
      timeoutMs: 10,
    }).capture('tab', 'https://example.test');
    const expectation = expect(promise).rejects.toThrow('timed out after 10ms');
    await jest.advanceTimersByTimeAsync(20);

    await expectation;
  });
});

describe('getOmniParserProviderConfig', () => {
  test('keeps provider opt-in and parses bounds', () => {
    delete process.env.OPENCHROME_VISION_PROVIDER;
    expect(getOmniParserProviderConfig().provider).toBe('dom');

    process.env.OPENCHROME_VISION_PROVIDER = 'omniparser-http';
    process.env.OPENCHROME_OMNIPARSER_URL = 'http://127.0.0.1:9901/parse/';
    process.env.OPENCHROME_OMNIPARSER_TIMEOUT_MS = '1234';
    process.env.OPENCHROME_OMNIPARSER_MAX_ELEMENTS = '42';
    expect(getOmniParserProviderConfig()).toMatchObject({
      provider: 'omniparser-http',
      endpointUrl: 'http://127.0.0.1:9901/parse/',
      timeoutMs: 1234,
      maxElements: 42,
    });
  });
});
