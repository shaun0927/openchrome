/// <reference types="jest" />
/**
 * Egress-invariant test for oc_proxy_hook (#874, invariant I1).
 *
 * Asserts that calls to the handler (`apply`, `status`, `clear`, `rotate`)
 * never open a socket. We monkey-patch `net.Socket.prototype.connect` —
 * the single funnel every TCP/TLS/HTTP/HTTPS/HTTP2 client request in Node
 * funnels through — for the *duration of the handler call only*, then
 * restore it immediately so jest's own worker-cleanup sockets are free
 * to operate.
 *
 * jest.spyOn() cannot redefine the top-level `net.connect` getter on every
 * Node build, so we attach to the prototype slot which IS writable.
 *
 * The upstream URL points at a deliberately unreachable address
 * (`http://10.255.255.1:1`); if the invariant were violated the patched
 * connect() would throw before any real I/O completed.
 */

import * as net from 'net';

import {
  _resetProxyBindingsForTesting,
  __TEST_ONLY__,
} from '../../../src/pilot/proxy/hook';
import * as flags from '../../../src/harness/flags';

const UNREACHABLE_UPSTREAM = 'http://user:pass@10.255.255.1:1';
const FAKE_SESSION = 'sess-egress';

/**
 * Call the handler under a `Socket.prototype.connect` interceptor and
 * return both the handler's result and the number of connect attempts.
 *
 * The patch is installed *synchronously* immediately before the await
 * and removed in a `finally` block, so jest's own worker bookkeeping
 * runs against the unpatched prototype.
 */
async function callUnderEgressTrap(
  args: Record<string, unknown>,
): Promise<{ ok: boolean; connectCalls: number; rawResult: unknown }> {
  const original = net.Socket.prototype.connect;
  let connectCalls = 0;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...inputs: unknown[]) {
    connectCalls += 1;
    throw new Error(
      `Socket.connect was called during oc_proxy_hook (args=${JSON.stringify(inputs)})`,
    );
  } as typeof net.Socket.prototype.connect;

  try {
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, args);
    const text = (out.content?.[0] as { text?: string } | undefined)?.text;
    const parsed = typeof text === 'string' ? JSON.parse(text) : null;
    return {
      ok: parsed?.ok === true,
      connectCalls,
      rawResult: parsed,
    };
  } finally {
    net.Socket.prototype.connect = original;
  }
}

describe('oc_proxy_hook — egress invariant I1', () => {
  let flagSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetProxyBindingsForTesting();
    flagSpy = jest.spyOn(flags, 'isProxyHookEnabled').mockReturnValue(true);
  });

  afterEach(() => {
    flagSpy.mockRestore();
  });

  it('apply opens zero sockets to upstream', async () => {
    const r = await callUnderEgressTrap({
      action: 'apply',
      rules: [
        { originPattern: 'https://example.com', upstream: UNREACHABLE_UPSTREAM, ruleTag: 'egr-1' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.connectCalls).toBe(0);
  });

  it('status opens zero sockets', async () => {
    const r = await callUnderEgressTrap({ action: 'status' });
    expect(r.ok).toBe(true);
    expect(r.connectCalls).toBe(0);
  });

  it('clear opens zero sockets', async () => {
    const r = await callUnderEgressTrap({ action: 'clear' });
    expect(r.ok).toBe(true);
    expect(r.connectCalls).toBe(0);
  });

  it('rotate opens zero sockets (host-supplied upstream is opaque)', async () => {
    const first = await callUnderEgressTrap({
      action: 'apply',
      rules: [
        { originPattern: 'https://example.com', upstream: UNREACHABLE_UPSTREAM, ruleTag: 'r-old' },
      ],
    });
    expect(first.ok).toBe(true);
    expect(first.connectCalls).toBe(0);

    const r = await callUnderEgressTrap({
      action: 'rotate',
      rules: [
        { originPattern: 'https://example.com', upstream: UNREACHABLE_UPSTREAM, ruleTag: 'r-new' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.connectCalls).toBe(0);
  });

  it('invalid_args path opens zero sockets either', async () => {
    const r = await callUnderEgressTrap({
      action: 'apply',
      rules: [
        { originPattern: 'https://example.com', upstream: 'bogus', ruleTag: 'bad' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.connectCalls).toBe(0);
  });
});
