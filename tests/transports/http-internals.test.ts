/// <reference types="jest" />

import type * as http from 'node:http';
import { HTTP_JSON_RPC_BATCH_MAX_SIZE } from '../../src/transports/http/config';
import { createBatchTooLargeError, mapBatchWithConcurrency } from '../../src/transports/http/batch';
import { applyCors, formatServerOriginHost, parseCorsOrigins } from '../../src/transports/http/cors';
import { resolveAuthMode, validateUnauthenticatedHttpPolicy } from '../../src/transports/http/auth';

describe('HTTP transport internals (#687 facade split)', () => {
  const previousAuthMode = process.env.OPENCHROME_AUTH_MODE;

  afterEach(() => {
    if (previousAuthMode === undefined) delete process.env.OPENCHROME_AUTH_MODE;
    else process.env.OPENCHROME_AUTH_MODE = previousAuthMode;
  });

  it('keeps auth mode precedence in the extracted auth helper', () => {
    delete process.env.OPENCHROME_AUTH_MODE;
    expect(resolveAuthMode('legacy-token', undefined).kind).toBe('legacy-shared-token');
    expect(resolveAuthMode(undefined, {} as Parameters<typeof resolveAuthMode>[1]).kind).toBe('api-key');

    process.env.OPENCHROME_AUTH_MODE = 'legacy-shared-token';
    expect(() => resolveAuthMode(undefined, undefined)).toThrow(/requires a shared token/);
  });

  it('keeps unauthenticated HTTP loopback policy fail-closed', () => {
    expect(() => validateUnauthenticatedHttpPolicy({ kind: 'disabled' }, '0.0.0.0', true)).toThrow(/non-loopback/);
    expect(() => validateUnauthenticatedHttpPolicy({ kind: 'disabled' }, '127.0.0.1', false)).toThrow(/Refusing to start/);
    expect(() => validateUnauthenticatedHttpPolicy({ kind: 'disabled' }, 'localhost', true)).not.toThrow();
  });

  it('keeps CORS same-origin and allowlist decisions in the extracted CORS helper', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: jest.fn((key: string, value: string) => { headers[key] = value; }),
      writeHead: jest.fn(),
      end: jest.fn(),
    } as unknown as http.ServerResponse;

    const allowed = parseCorsOrigins('https://app.example, http://localhost:3100');
    const sameOriginReq = { headers: { origin: 'http://127.0.0.1:3100' } } as http.IncomingMessage;
    expect(applyCors(sameOriginReq, res, '/mcp', allowed, formatServerOriginHost('127.0.0.1', 3100))).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();

    const blockedReq = { headers: { origin: 'https://evil.example' } } as http.IncomingMessage;
    expect(applyCors(blockedReq, res, '/mcp', allowed, formatServerOriginHost('127.0.0.1', 3100))).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
  });

  it('keeps batch helper error shape and bounded ordered concurrency', async () => {
    expect(createBatchTooLargeError(HTTP_JSON_RPC_BATCH_MAX_SIZE)).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { message: expect.stringContaining(`${HTTP_JSON_RPC_BATCH_MAX_SIZE}`) },
    });

    let active = 0;
    let maxActive = 0;
    const result = await mapBatchWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return item * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });
});
