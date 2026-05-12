/**
 * request_intercept regression tests (#896).
 *
 * Verifies that the new `network_capture_lite` recorder does not corrupt
 * `request_intercept` state when both observe the same page events. The
 * recorder uses puppeteer's passive `'request'` listener; `request_intercept`
 * uses the same listener but ALSO calls `respond`/`continue`/`abort`. Both
 * must coexist: each sees every request, only `request_intercept` mutates.
 *
 * We don't drive a real Chrome here — we use a `FakePage` + `FakeRequest`
 * pair that emits the same events puppeteer would, and we register both the
 * recorder and a stand-in request_intercept listener on it. The assertion is
 * that the event count seen by each side is correct and neither side
 * observes mutation from the other.
 */

import { EventEmitter } from 'events';
import {
  NetworkCaptureRecorder,
  _resetActiveRecordersForTests,
} from '../../src/core/network-capture/recorder';

class FakeRequest {
  _url: string;
  _continued = false;
  _aborted = false;
  _respondedWith: unknown = null;
  _failure: { errorText: string } | null = null;
  constructor(url: string) {
    this._url = url;
  }
  url() { return this._url; }
  method() { return 'GET'; }
  resourceType() { return 'Image'; }
  headers(): Record<string, string> { return {}; }
  initiator() { return { type: 'other' as const }; }
  failure() { return this._failure; }
  async continue() { this._continued = true; }
  async abort(_reason?: string) { this._aborted = true; }
  async respond(payload: unknown) { this._respondedWith = payload; }
}

class FakeResponse {
  _request: FakeRequest;
  constructor(req: FakeRequest) {
    this._request = req;
  }
  request() { return this._request; }
  status() { return 200; }
  statusText() { return 'OK'; }
  headers(): Record<string, string> { return {}; }
  async buffer() { return Buffer.alloc(0); }
}

class FakePage extends EventEmitter {
  emitRequest(req: FakeRequest) { this.emit('request', req); }
  emitResponse(res: FakeResponse) { this.emit('response', res); }
  emitRequestFinished(req: FakeRequest) { this.emit('requestfinished', req); }
}

afterEach(() => {
  _resetActiveRecordersForTests();
});

describe('request_intercept + network_capture coexistence (#896)', () => {
  test('starting network_capture_lite while a request_intercept listener is active leaves both observers with the same event stream', () => {
    const page = new FakePage();

    // Stand-in for `request_intercept` enable path: it owns
    // setRequestInterception(true) in production; here we just register a
    // listener that decides per-request whether to abort/continue.
    const interceptLog: { url: string; action: 'block' | 'continue' }[] = [];
    page.on('request', async (req: FakeRequest) => {
      if (req.url().endsWith('.png')) {
        interceptLog.push({ url: req.url(), action: 'block' });
        await req.abort('blockedbyclient');
      } else {
        interceptLog.push({ url: req.url(), action: 'continue' });
        await req.continue();
      }
    });

    // Now start the recorder — passive listeners only.
    const rec = new NetworkCaptureRecorder(page as unknown as never, 'sess', 'lite');
    rec.start();

    const r1 = new FakeRequest('https://example.com/index.html');
    const r2 = new FakeRequest('https://example.com/logo.png');
    page.emitRequest(r1);
    page.emitRequest(r2);
    // Simulate response for the non-blocked one; emit failed for the blocked one.
    page.emitResponse(new FakeResponse(r1));
    page.emitRequestFinished(r1);
    // For the blocked request, request_intercept would synthesize a failed event;
    // we emit it directly to mirror the puppeteer lifecycle.
    (r2 as unknown as { _failure: { errorText: string } | null })._failure = { errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
    page.emit('requestfailed', r2);

    // request_intercept-side: both URLs observed, exactly one blocked.
    expect(interceptLog).toEqual([
      { url: 'https://example.com/index.html', action: 'continue' },
      { url: 'https://example.com/logo.png', action: 'block' },
    ]);
    expect(r2._aborted).toBe(true);

    // Recorder-side: both URLs captured; the blocked one has `failed.errorText` set.
    const logs = rec.getLogs(0);
    const byUrl = new Map(logs.map((l) => [l.url, l]));
    expect(byUrl.size).toBe(2);
    expect(byUrl.get('https://example.com/index.html')?.status).toBe(200);
    expect(byUrl.get('https://example.com/logo.png')?.failed?.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');

    // The recorder did NOT call continue/respond/abort on either request.
    // request_intercept owns those; the recorder is passive.
    expect(r1._aborted).toBe(false);
    expect(r1._respondedWith).toBeNull();
    expect(r2._respondedWith).toBeNull();
  });

  test('recorder.stop detaches its listeners without affecting the request_intercept listener', () => {
    const page = new FakePage();

    let interceptCount = 0;
    const interceptListener = () => { interceptCount++; };
    page.on('request', interceptListener);

    const rec = new NetworkCaptureRecorder(page as unknown as never, 'sess2', 'lite');
    rec.start();

    const before = page.listenerCount('request');
    expect(before).toBe(2); // request_intercept + recorder

    page.emitRequest(new FakeRequest('https://example.com/a'));
    expect(interceptCount).toBe(1);
    expect(rec.getLogs(0)).toHaveLength(1);

    // stop() must not be awaited synchronously for this assertion; the listener
    // detach happens before the body-cleanup IO.
    void rec.stop({ keepBodies: true });
    expect(page.listenerCount('request')).toBe(1); // only request_intercept remains

    page.emitRequest(new FakeRequest('https://example.com/b'));
    expect(interceptCount).toBe(2);
  });
});
