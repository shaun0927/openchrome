/**
 * NetworkCaptureRecorder unit tests.
 *
 * Drives the recorder via a tiny EventEmitter-backed FakePage that emits the
 * same events puppeteer would (`'request'`, `'response'`, `'requestfailed'`,
 * `'requestfinished'`). This avoids spinning up a real Chrome and tests the
 * recorder semantics in isolation.
 *
 * Coverage:
 *   • FIFO eviction at maxEntries
 *   • Body cap enforcement (over_cap when buffer > maxBodyBytes)
 *   • Allowlist / blocklist URL matching
 *   • Redaction of allow-listed sensitive headers
 *   • Double-start guard
 *   • On-disk body cleanup on stop (full mode)
 *   • Lite-mode entries record body=omitted/lite_mode and never call response.buffer()
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NetworkCaptureRecorder,
  _resetActiveRecordersForTests,
} from '../../../src/core/network-capture/recorder';
import { getSessionBodyDir, getBodyStoreRoot } from '../../../src/core/network-capture/body-store';

// ── Test doubles ───────────────────────────────────────────────────────────

interface FakeRequestInit {
  url: string;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

class FakeRequest {
  readonly _url: string;
  readonly _method: string;
  readonly _resourceType: string;
  readonly _headers: Record<string, string>;
  readonly _initiator: { type: string; url?: string; lineNumber?: number };
  _failure: { errorText: string } | null = null;

  constructor(init: FakeRequestInit) {
    this._url = init.url;
    this._method = init.method ?? 'GET';
    this._resourceType = init.resourceType ?? 'Other';
    this._headers = init.headers ?? {};
    this._initiator = init.initiator ?? { type: 'other' };
  }
  url() { return this._url; }
  method() { return this._method; }
  resourceType() { return this._resourceType; }
  headers() { return this._headers; }
  initiator() { return this._initiator; }
  failure() { return this._failure; }
}

interface FakeResponseInit {
  request: FakeRequest;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  bufferError?: Error;
}

class FakeResponse {
  readonly _request: FakeRequest;
  readonly _status: number;
  readonly _statusText: string;
  readonly _headers: Record<string, string>;
  readonly _body: Buffer | undefined;
  readonly _bufferError: Error | undefined;

  constructor(init: FakeResponseInit) {
    this._request = init.request;
    this._status = init.status ?? 200;
    this._statusText = init.statusText ?? 'OK';
    this._headers = init.headers ?? {};
    this._body = init.body;
    this._bufferError = init.bufferError;
  }
  request() { return this._request; }
  status() { return this._status; }
  statusText() { return this._statusText; }
  headers() { return this._headers; }
  async buffer(): Promise<Buffer> {
    if (this._bufferError) throw this._bufferError;
    return this._body ?? Buffer.alloc(0);
  }
}

class FakePage extends EventEmitter {
  emitRequest(req: FakeRequest) { this.emit('request', req); }
  emitResponse(res: FakeResponse) { this.emit('response', res); }
  emitRequestFinished(req: FakeRequest) { this.emit('requestfinished', req); }
  emitRequestFailed(req: FakeRequest, errorText: string) {
    req._failure = { errorText };
    this.emit('requestfailed', req);
  }
}

// Cast helper: the recorder accepts a puppeteer Page; FakePage matches the
// subset of `on`/`off` we use.
function asPage(p: FakePage): never {
  return p as unknown as never;
}

// Use unique session ids per test so on-disk artifacts never collide and the
// cleanup step has exactly one directory to remove.
let sessionCounter = 0;
function uniqueSessionId(name: string): string {
  return `t-${name}-${process.pid}-${++sessionCounter}`;
}

/**
 * Poll until the first entry's `body` field is defined (or timeout).
 * `handleResponse` is fire-and-forget with two awaits (buffer() + writeBody),
 * so a single setImmediate is not sufficient to let it fully settle.
 */
async function waitForBody(
  rec: NetworkCaptureRecorder,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = rec.getLogs(0);
    if (logs.length > 0 && logs[logs.length - 1].body !== undefined) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitForBody: timed out waiting for body to be populated');
}

afterEach(async () => {
  _resetActiveRecordersForTests();
  // Belt-and-braces: scrub anything we might have left under the body root.
  // Individual tests assert cleanup explicitly; this is a safety net so a
  // failed test doesn't pollute the next one.
  try {
    const root = getBodyStoreRoot();
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('t-')) {
          fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        }
      }
    }
  } catch { /* ignore */ }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NetworkCaptureRecorder — lifecycle', () => {
  test('double-start throws (mutual-exclusion is enforced at the tool layer; this is the recorder-level guard)', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('double-start'), 'lite');
    rec.start();
    expect(() => rec.start()).toThrow(/already active/);
  });

  test('stop is idempotent (second call is a no-op)', async () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('stop-idem'), 'lite');
    rec.start();
    await rec.stop();
    await expect(rec.stop()).resolves.toBeUndefined();
  });
});

describe('NetworkCaptureRecorder — lite mode', () => {
  test('records request metadata; body is always omitted with lite_mode', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('lite-omit'), 'lite');
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/a', resourceType: 'XHR' });
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({
      request: req,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}'),
    }));
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].url).toBe('https://example.com/a');
    expect(logs[0].method).toBe('GET');
    expect(logs[0].status).toBe(200);
    expect(logs[0].responseHeaders?.['content-type']).toBe('application/json');
    expect(logs[0].body).toEqual({ mode: 'omitted', reason: 'lite_mode' });
  });

  test('does NOT call response.buffer() in lite mode', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('lite-nobuf'), 'lite');
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/x' });
    page.emitRequest(req);

    const bufferSpy = jest.fn(() => Promise.resolve(Buffer.from('payload')));
    const res = new FakeResponse({ request: req, body: Buffer.from('payload') });
    // Replace buffer() with a spy so we can assert it isn't called.
    (res as unknown as { buffer: () => Promise<Buffer> }).buffer = bufferSpy;
    page.emitResponse(res);
    page.emitRequestFinished(req);

    expect(bufferSpy).not.toHaveBeenCalled();
  });
});

describe('NetworkCaptureRecorder — FIFO eviction', () => {
  test('drops oldest entries when maxEntries exceeded', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('fifo'), 'lite', { maxEntries: 3 });
    rec.start();

    for (let i = 0; i < 5; i++) {
      const req = new FakeRequest({ url: `https://example.com/${i}` });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    const logs = rec.getLogs(0);
    expect(logs).toHaveLength(3);
    // Newest-first ordering: most recent URL comes first.
    expect(logs[0].url).toBe('https://example.com/4');
    expect(logs[2].url).toBe('https://example.com/2');
  });
});

describe('NetworkCaptureRecorder — full mode body cap', () => {
  test('inline body when ≤ 32 KB and ≤ maxBodyBytes', async () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('full-inline'),
      'full',
      { maxBodyBytes: 64 * 1024 },
    );
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/small', resourceType: 'XHR' });
    const body = Buffer.from('hello');
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({ request: req, body }));
    await waitForBody(rec);
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs[0].body).toEqual({
      mode: 'inline',
      base64: body.toString('base64'),
      bytes: body.length,
    });
  });

  test('over-cap body recorded as omitted/over_cap (via Content-Length pre-check)', async () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('full-overcap-cl'),
      'full',
      { maxBodyBytes: 1024 },
    );
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/big' });
    const bigBody = Buffer.alloc(4096);
    const bufferSpy = jest.fn(() => Promise.resolve(bigBody));
    page.emitRequest(req);
    const res = new FakeResponse({
      request: req,
      headers: { 'content-length': '4096' },
      body: bigBody,
    });
    (res as unknown as { buffer: () => Promise<Buffer> }).buffer = bufferSpy;
    page.emitResponse(res);
    await new Promise((r) => setImmediate(r));
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs[0].body).toEqual({ mode: 'omitted', reason: 'over_cap' });
    // Content-Length pre-check means we never paid the buffer() cost.
    expect(bufferSpy).not.toHaveBeenCalled();
  });

  test('over-cap body recorded as omitted/over_cap (when buffer is fetched and exceeds cap)', async () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('full-overcap-buf'),
      'full',
      { maxBodyBytes: 1024 },
    );
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/big-nocl' });
    const bigBody = Buffer.alloc(4096);
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({ request: req, body: bigBody })); // no content-length
    await waitForBody(rec);
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs[0].body).toEqual({ mode: 'omitted', reason: 'over_cap' });
  });

  test('spills to disk when body > 32 KB but ≤ maxBodyBytes', async () => {
    const sessionId = uniqueSessionId('full-spill');
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      sessionId,
      'full',
      { maxBodyBytes: 128 * 1024 },
    );
    rec.start();

    const req = new FakeRequest({ url: 'https://example.com/med' });
    const body = Buffer.alloc(64 * 1024, 7);
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({ request: req, body }));
    await waitForBody(rec);
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs[0].body?.mode).toBe('file');
    const bodyEntry = logs[0].body as { mode: 'file'; path: string; bytes: number };
    expect(bodyEntry.bytes).toBe(64 * 1024);
    expect(fs.existsSync(bodyEntry.path)).toBe(true);
    expect(fs.readFileSync(bodyEntry.path).equals(body)).toBe(true);

    // Cleanup-on-stop should remove the directory.
    await rec.stop({ keepBodies: false });
    expect(fs.existsSync(getSessionBodyDir(sessionId))).toBe(false);
  });

  test('keepBodies:true on stop retains the session directory', async () => {
    const sessionId = uniqueSessionId('full-keep');
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), sessionId, 'full', { maxBodyBytes: 128 * 1024 });
    rec.start();
    const req = new FakeRequest({ url: 'https://example.com/keep' });
    const body = Buffer.alloc(64 * 1024, 9);
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({ request: req, body }));
    await waitForBody(rec);
    page.emitRequestFinished(req);
    await rec.stop({ keepBodies: true });
    expect(fs.existsSync(getSessionBodyDir(sessionId))).toBe(true);
    // Manually clean up so afterEach's safety-net doesn't have to.
    fs.rmSync(getSessionBodyDir(sessionId), { recursive: true, force: true });
  });

  test('falls back to omitted/fetch_failed when response.buffer() throws', async () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('full-fetcherr'), 'full');
    rec.start();
    const req = new FakeRequest({ url: 'https://example.com/err' });
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({
      request: req,
      body: Buffer.from('x'),
      bufferError: new Error('No body for redirect'),
    }));
    await waitForBody(rec);
    page.emitRequestFinished(req);

    const logs = rec.getLogs(0);
    expect(logs[0].body).toEqual({ mode: 'omitted', reason: 'fetch_failed' });
  });
});

describe('NetworkCaptureRecorder — URL filtering', () => {
  test('urlAllowlist: only matching URLs are recorded', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('allow'),
      'lite',
      { urlAllowlist: ['https://api.example.com/*'] },
    );
    rec.start();
    for (const url of [
      'https://api.example.com/a',
      'https://cdn.example.com/b',
      'https://api.example.com/c',
    ]) {
      const req = new FakeRequest({ url });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    const logs = rec.getLogs(0);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.url.startsWith('https://api.example.com/'))).toBe(true);
  });

  test('urlBlocklist: matching URLs are dropped', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('block'),
      'lite',
      { urlBlocklist: ['*.png', '*.jpg'] },
    );
    rec.start();
    for (const url of [
      'https://example.com/a.html',
      'https://example.com/b.png',
      'https://example.com/c.jpg',
    ]) {
      const req = new FakeRequest({ url });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    const logs = rec.getLogs(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].url).toBe('https://example.com/a.html');
  });

  test('resourceTypes restricts to listed types only', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      asPage(page),
      uniqueSessionId('rt'),
      'lite',
      { resourceTypes: ['XHR', 'Fetch'] },
    );
    rec.start();
    for (const [url, rt] of [
      ['https://example.com/doc', 'Document'],
      ['https://example.com/api', 'XHR'],
      ['https://example.com/img', 'Image'],
    ] as Array<[string, string]>) {
      const req = new FakeRequest({ url, resourceType: rt });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    const logs = rec.getLogs(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].resourceType).toBe('XHR');
  });
});

describe('NetworkCaptureRecorder — redaction', () => {
  test('Authorization header value is redacted in requestHeaders', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('redact'), 'lite');
    rec.start();
    const req = new FakeRequest({
      url: 'https://example.com/secure',
      headers: {
        Authorization: 'Bearer super-secret-token-1234567890',
        'X-Other': 'plain',
      },
    });
    page.emitRequest(req);
    page.emitRequestFinished(req);

    const log = rec.getLogs(0)[0];
    const authVal = log.requestHeaders.Authorization;
    expect(authVal).toMatch(/REDACTED/);
    expect(authVal).not.toContain('super-secret-token');
    expect(log.requestHeaders['X-Other']).toBe('plain');
  });

  test('Set-Cookie response header is redacted', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('redact-resp'), 'lite');
    rec.start();
    const req = new FakeRequest({ url: 'https://example.com/setck' });
    page.emitRequest(req);
    page.emitResponse(new FakeResponse({
      request: req,
      headers: { 'set-cookie': 'session=abc123def456789012345678901234567890' },
    }));
    page.emitRequestFinished(req);

    const log = rec.getLogs(0)[0];
    expect(log.responseHeaders?.['set-cookie']).toMatch(/REDACTED/);
  });
});

describe('NetworkCaptureRecorder — failure handling', () => {
  test('requestfailed populates failed.errorText and finishedAt', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('fail'), 'lite');
    rec.start();
    const req = new FakeRequest({ url: 'https://example.com/blocked' });
    page.emitRequest(req);
    page.emitRequestFailed(req, 'net::ERR_BLOCKED_BY_CLIENT');
    const log = rec.getLogs(0)[0];
    expect(log.failed).toEqual({ errorText: 'net::ERR_BLOCKED_BY_CLIENT', canceled: false });
    expect(log.timing.finishedAt).toBeDefined();
  });
});

describe('NetworkCaptureRecorder — getLogs ordering and limit', () => {
  test('default limit is 100', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('limit'), 'lite');
    rec.start();
    for (let i = 0; i < 150; i++) {
      const req = new FakeRequest({ url: `https://example.com/${i}` });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    expect(rec.getLogs()).toHaveLength(100);
    expect(rec.getLogs(0)).toHaveLength(150);
  });

  test('newest-first ordering by timing.startedAt', () => {
    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(asPage(page), uniqueSessionId('order'), 'lite');
    rec.start();
    for (let i = 0; i < 5; i++) {
      const req = new FakeRequest({ url: `https://example.com/${i}` });
      page.emitRequest(req);
      page.emitRequestFinished(req);
    }
    const logs = rec.getLogs(5);
    expect(logs[0].url).toBe('https://example.com/4');
    expect(logs[4].url).toBe('https://example.com/0');
  });
});

// Sanity: the body store root is a child of the user's home directory, not
// some temp dir we accidentally injected.
test('body store root resolves under os.homedir()/.openchrome', () => {
  expect(getBodyStoreRoot()).toBe(path.join(os.homedir(), '.openchrome', 'network-bodies'));
});
