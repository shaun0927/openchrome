/// <reference types="jest" />
/**
 * Tests for issue #8 — B-2: Tool-call AbortSignal propagation.
 *
 * Verifies that the HTTP transport creates an AbortController per POST /mcp
 * request and aborts it (with ClientDisconnectError) when the client closes
 * the connection before the response is sent.
 */

import * as http from 'node:http';
import { ClientDisconnectError } from '../../src/errors/abort';

const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19887;

describe('HTTPTransport — abort-on-disconnect (issue #8)', () => {
  let transport: any;

  afterEach(async () => {
    if (transport) {
      await transport.close();
      transport = null;
    }
    delete process.env.OPENCHROME_ABORT_ON_DISCONNECT;
  });

  function startTransport(handler: (msg: any, signal?: AbortSignal) => Promise<any>) {
    transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
    transport.onMessage(handler);
    transport.start();
    return new Promise<void>((r) => setTimeout(r, 50));
  }

  async function postAndAbortAfter(
    bodyJSON: string,
    afterRequestIsInFlight: Promise<void>,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyJSON),
        },
      });
      // Swallow the inevitable "socket hang up" — we are intentionally killing the connection.
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(bodyJSON);
      req.end();

      afterRequestIsInFlight.then(() => req.destroy()).catch(() => req.destroy());
    });
  }

  test('passes an AbortSignal to the message handler', async () => {
    let receivedSignal: AbortSignal | undefined;
    await startTransport(async (msg, signal) => {
      receivedSignal = signal;
      return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
    });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  test('aborts handler signal with ClientDisconnectError when client disconnects mid-flight', async () => {
    let captureReason!: (reason: unknown) => void;
    const abortReason = new Promise<unknown>((resolve) => { captureReason = resolve; });
    let markHandlerReady!: () => void;
    const handlerReady = new Promise<void>((resolve) => { markHandlerReady = resolve; });

    await startTransport(async (_msg, signal) => {
      await new Promise<void>((handlerResolve) => {
        if (!signal) {
          markHandlerReady();
          handlerResolve();
          return;
        }
        signal.addEventListener('abort', () => {
          captureReason(signal.reason);
          handlerResolve();
        }, { once: true });
        markHandlerReady();
      });
      return null;
    });

    await postAndAbortAfter(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' }),
      handlerReady,
    );

    // The inner race timeout must absorb macOS CI event-loop jitter; the
    // abort propagation path (socket close → req.on('close') → controller
    // abort) is fast locally but can exceed 2s under loaded Actions runners.
    const reason = (await Promise.race([
      abortReason,
      new Promise<unknown>((resolve) => setTimeout(() => resolve('TIMEOUT'), 8000)),
    ])) as unknown;

    expect(reason).toBeInstanceOf(ClientDisconnectError);
  }, 15000);

  test('does NOT abort signal on normal completion', async () => {
    let signalRef: AbortSignal | undefined;
    await startTransport(async (msg, signal) => {
      signalRef = signal;
      return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }));
    });

    // Give the close listener a tick to fire if it was going to.
    await new Promise((r) => setTimeout(r, 50));
    expect(signalRef).toBeDefined();
    expect(signalRef!.aborted).toBe(false);
  });

  test('OPENCHROME_ABORT_ON_DISCONNECT=false disables the signal (legacy behaviour)', async () => {
    process.env.OPENCHROME_ABORT_ON_DISCONNECT = 'false';
    let received: AbortSignal | undefined = {} as AbortSignal;
    await startTransport(async (msg, signal) => {
      received = signal;
      return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call' }));
    });

    expect(received).toBeUndefined();
  });
});
