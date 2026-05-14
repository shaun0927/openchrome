/**
 * Memory regression test for NetworkCaptureRecorder (#896).
 *
 * Skipped on CI by default — gated by `RUN_PERF_TESTS=1`. The recorder is
 * stress-tested with 1000 synthetic requests whose body sizes are uniformly
 * distributed in [0, 1 MB]:
 *
 *   • lite mode: no body fetch is ever performed. RSS growth must stay
 *     under 50 MB.
 *   • full mode with maxBodyBytes=262144 (256 KB): bodies up to 32 KB are
 *     inlined as base64; bodies between 32 KB and 256 KB are spilled to disk;
 *     bodies over 256 KB are recorded as `omitted/over_cap` and never
 *     buffered into memory. RSS growth must stay under 350 MB.
 *
 * The assertions use deltas from the start of the run, not absolute RSS, so
 * the test is robust to whatever the test runner is already holding.
 */

import { EventEmitter } from 'events';
import {
  NetworkCaptureRecorder,
  _resetActiveRecordersForTests,
} from '../../src/core/network-capture/recorder';

const RUN = process.env.RUN_PERF_TESTS === '1';
const describeMaybe = RUN ? describe : describe.skip;

class FakeRequest {
  _url: string;
  constructor(url: string) { this._url = url; }
  url() { return this._url; }
  method() { return 'GET'; }
  resourceType() { return 'XHR'; }
  headers(): Record<string, string> { return {}; }
  initiator() { return { type: 'other' as const }; }
  failure() { return null; }
}

class FakeResponse {
  _request: FakeRequest;
  _body: Buffer;
  _headers: Record<string, string>;
  constructor(req: FakeRequest, body: Buffer) {
    this._request = req;
    this._body = body;
    this._headers = { 'content-length': String(body.length) };
  }
  request() { return this._request; }
  status() { return 200; }
  statusText() { return 'OK'; }
  headers() { return this._headers; }
  async buffer() { return this._body; }
}

class FakePage extends EventEmitter {
  emitRequest(req: FakeRequest) { this.emit('request', req); }
  emitResponse(res: FakeResponse) { this.emit('response', res); }
  emitRequestFinished(req: FakeRequest) { this.emit('requestfinished', req); }
}

function randomBytes(min: number, max: number): Buffer {
  const len = Math.floor(min + Math.random() * (max - min));
  return Buffer.alloc(len, 0x55);
}

afterEach(() => {
  _resetActiveRecordersForTests();
});

describeMaybe('NetworkCaptureRecorder — memory regression', () => {
  test('lite mode: 1000 requests with bodies in [0, 1 MB] grows RSS < 50 MB', async () => {
    if (global.gc) global.gc();
    const baseline = process.memoryUsage().rss;

    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(page as unknown as never, 'perf-lite', 'lite');
    rec.start();

    for (let i = 0; i < 1000; i++) {
      const req = new FakeRequest(`https://example.com/${i}`);
      const body = randomBytes(0, 1024 * 1024);
      page.emitRequest(req);
      page.emitResponse(new FakeResponse(req, body));
      page.emitRequestFinished(req);
    }

    if (global.gc) global.gc();
    const grown = process.memoryUsage().rss - baseline;
    expect(grown).toBeLessThan(50 * 1024 * 1024);
    await rec.stop();
  }, 60_000);

  test('full mode with 256 KB cap: 1000 requests with bodies in [0, 1 MB] grows RSS < 350 MB', async () => {
    if (global.gc) global.gc();
    const baseline = process.memoryUsage().rss;

    const page = new FakePage();
    const rec = new NetworkCaptureRecorder(
      page as unknown as never,
      'perf-full',
      'full',
      { maxBodyBytes: 262144 },
    );
    rec.start();

    for (let i = 0; i < 1000; i++) {
      const req = new FakeRequest(`https://example.com/${i}`);
      const body = randomBytes(0, 1024 * 1024);
      page.emitRequest(req);
      page.emitResponse(new FakeResponse(req, body));
      // Let microtasks settle so handleResponse's await runs before next iter.
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
      page.emitRequestFinished(req);
    }

    if (global.gc) global.gc();
    const grown = process.memoryUsage().rss - baseline;
    expect(grown).toBeLessThan(350 * 1024 * 1024);
    await rec.stop();
  }, 120_000);
});
