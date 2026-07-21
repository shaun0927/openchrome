import { describe, expect, it } from '@jest/globals';
import {
  createTlsFastPathAdapter,
  interpretCurlResponse,
} from '../../src/chrome/tls-fast-path.js';

describe('interpretCurlResponse', () => {
  it('parses a plain 200', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n<html>ok</html>';
    const parsed = interpretCurlResponse(raw);
    expect(parsed.kind).toBe('ok');
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe('text/html');
    expect(parsed.body).toBe('<html>ok</html>');
  });

  it('flags 403 as challenge', () => {
    const raw = 'HTTP/2 403\r\ncontent-type: text/plain\r\n\r\nforbidden';
    expect(interpretCurlResponse(raw).kind).toBe('challenge');
  });

  it('detects Cloudflare interstitial body', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n<script>window._cf_chl_opt={}</script>';
    expect(interpretCurlResponse(raw).kind).toBe('challenge');
  });
});

describe('createTlsFastPathAdapter fallback', () => {
  it('reports unavailable when binary missing and fallback disabled', async () => {
    const adapter = createTlsFastPathAdapter({
      disableFallback: true,
    });
    const result = await adapter.fetch({ url: 'https://example.invalid' });
    expect(result.kind).toBe('unavailable');
  });

  it('falls back to injected native fetch', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'hi',
    } as unknown as Response)) as typeof fetch;
    const adapter = createTlsFastPathAdapter({ fetchImpl });
    const result = await adapter.fetch({ url: 'https://example.com' });
    expect(result.kind).toBe('ok');
    expect(result.body).toBe('hi');
  });

  it('classifies fallback 429 as challenge', async () => {
    const fetchImpl = (async () => ({
      status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'rate limited',
    } as unknown as Response)) as typeof fetch;
    const adapter = createTlsFastPathAdapter({ fetchImpl });
    const result = await adapter.fetch({ url: 'https://example.com' });
    expect(result.kind).toBe('challenge');
    expect(result.status).toBe(429);
  });
});
