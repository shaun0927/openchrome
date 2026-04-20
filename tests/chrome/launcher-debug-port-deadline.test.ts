/**
 * Tests for waitForDebugPort monotonic deadline behavior.
 *
 * Issue #2 (A-2): waitForDebugPort에 monotonic deadline 가드 추가
 *
 * Verifies:
 * 1. Unreachable port → throws DebugPortTimeoutError within the requested
 *    deadline (no overshoot from a trailing slow HTTP probe).
 * 2. Error type is DebugPortTimeoutError with attempt counter populated,
 *    distinct from the generic "Chrome exited" error.
 * 3. Instant-success path returns quickly without waiting for backoff.
 * 4. chromeProcess fast-fail path still throws with "exited with code" and
 *    is NOT a DebugPortTimeoutError.
 */

// Override the global mock from tests/setup.ts that replaces ChromeLauncher
jest.unmock('../../src/chrome/launcher');

import * as http from 'http';
import type { AddressInfo } from 'net';
import { ChildProcess } from 'child_process';

import { waitForDebugPort, DebugPortTimeoutError } from '../../src/chrome/launcher';

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({}),
}));

describe('waitForDebugPort monotonic deadline', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('throws DebugPortTimeoutError within the requested deadline for an unreachable port', async () => {
    // Use a port we know is closed by binding+releasing one.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closedPort = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const timeoutMs = 1500;
    const start = Date.now();
    await expect(waitForDebugPort(closedPort, timeoutMs)).rejects.toBeInstanceOf(
      DebugPortTimeoutError,
    );
    const elapsed = Date.now() - start;

    // Must exit within timeout ± 500ms slack. The critical assertion is the
    // upper bound: prior implementation could overshoot by 2.5s+ on a slow
    // final HTTP probe. A 500ms slack is safer than a tight bound across CI
    // environments while still catching the pre-fix regression class.
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 200);
    expect(elapsed).toBeLessThanOrEqual(timeoutMs + 500);
  }, 10_000);

  it('DebugPortTimeoutError carries port, timeout, and positive attempts', async () => {
    const timeoutMs = 500;
    let thrown: unknown;
    try {
      await waitForDebugPort(1 /* reserved; will refuse */, timeoutMs);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DebugPortTimeoutError);
    const err = thrown as DebugPortTimeoutError;
    expect(err.port).toBe(1);
    expect(err.timeoutMs).toBe(timeoutMs);
    expect(err.attempts).toBeGreaterThan(0);
    expect(err.name).toBe('DebugPortTimeoutError');
  }, 10_000);

  it('returns quickly when debug port is already serving', async () => {
    // Serve a minimal /json/version response
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/test' }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const start = Date.now();
      const ws = await waitForDebugPort(port, 5000);
      const elapsed = Date.now() - start;
      expect(ws).toBe('ws://127.0.0.1:0/devtools/browser/test');
      // First probe should succeed; allow 250ms for test host scheduler noise
      expect(elapsed).toBeLessThan(250);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it('succeeds with sub-100ms timeout when port is already serving', async () => {
    // Regression: the previous implementation floored the HTTP probe timeout
    // at 100ms and threw DebugPortTimeoutError whenever the remaining budget
    // fell below 100ms, so callers passing timeout < 100ms failed
    // deterministically even though localhost probes usually complete in
    // under 10ms. See Codex review on PR #11.
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/tiny' }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const ws = await waitForDebugPort(port, 75);
      expect(ws).toBe('ws://127.0.0.1:0/devtools/browser/tiny');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it('catches a port that starts serving in the last sliver of the deadline', async () => {
    // Regression: without the short-circuit guard, waitForDebugPort must still
    // probe when only tens of milliseconds remain, so Chrome instances that
    // come online near the deadline are not falsely timed out. See Codex
    // review on PR #11.
    //
    // Timing: with DEBUG_PORT_INITIAL_BACKOFF_MS=200 and factor=1.5, probes
    // land at ~t=0, ~t=210, ~t=510. Server starts at 250ms and timeout is
    // 600ms, so the t=510 probe is the one that succeeds with only ~90ms of
    // budget left (< DEBUG_PORT_MIN_HTTP_TIMEOUT_MS=100). Under the previous
    // implementation's short-circuit, that third probe would have been
    // skipped and the call would have thrown DebugPortTimeoutError.
    let server: http.Server | null = null;

    const startDelayMs = 250;
    const timeoutMs = 600;
    // Reserve a port first, then close-and-reopen so we can control when it
    // actually begins answering.
    const reserver = http.createServer();
    await new Promise<void>((resolve) => reserver.listen(0, '127.0.0.1', resolve));
    const port = (reserver.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserver.close(() => resolve()));

    const startServerTimer = setTimeout(() => {
      server = http.createServer((req, res) => {
        if (req.url === '/json/version') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/late' }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      server.listen(port, '127.0.0.1');
    }, startDelayMs);

    try {
      const start = Date.now();
      const ws = await waitForDebugPort(port, timeoutMs);
      const elapsed = Date.now() - start;
      expect(ws).toBe('ws://127.0.0.1:0/devtools/browser/late');
      // Success must land after the backoff-induced delay that puts the
      // probe near the deadline — if the old short-circuit returned, this
      // elapsed time would be unreachable because the call would have
      // thrown at t~300ms (remaining < MIN_HTTP).
      expect(elapsed).toBeGreaterThanOrEqual(startDelayMs);
      // And the call must still respect the outer deadline (plus small slack
      // for one final HTTP timeout; MAX_HTTP is 2s but the probeTimeout is
      // clamped to remaining, so worst case is timeoutMs + ~50ms CI jitter).
      expect(elapsed).toBeLessThanOrEqual(timeoutMs + 300);
    } finally {
      clearTimeout(startServerTimer);
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }
  }, 15_000);

  it('throws DebugPortTimeoutError immediately when timeout is NaN', async () => {
    // Regression (Codex P2): a malformed env var run through parseInt yields
    // NaN. Previously `Date.now() + NaN = NaN`, so `remaining <= 0` never
    // fired and probeTimeout also became NaN, causing http.request to throw
    // ERR_OUT_OF_RANGE instead of the documented DebugPortTimeoutError shape.
    // We now normalize non-finite inputs at the top of waitForDebugPort.
    let thrown: unknown;
    try {
      await waitForDebugPort(9999, Number.NaN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DebugPortTimeoutError);
    expect((thrown as DebugPortTimeoutError).timeoutMs).toBe(0);
  }, 5_000);

  it('throws DebugPortTimeoutError immediately when timeout is negative', async () => {
    let thrown: unknown;
    try {
      await waitForDebugPort(9999, -1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DebugPortTimeoutError);
  }, 5_000);

  it('fast-fails with a non-DebugPortTimeoutError when chromeProcess has exited', async () => {
    const fakeProcess = {
      exitCode: 1,
    } as unknown as ChildProcess;

    let thrown: unknown;
    try {
      // Use a closed port so probes fail; the exitCode gate should fire before timeout.
      await waitForDebugPort(1, 5000, fakeProcess);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(DebugPortTimeoutError);
    expect((thrown as Error).message).toMatch(/exited with code 1/);
  }, 10_000);
});
