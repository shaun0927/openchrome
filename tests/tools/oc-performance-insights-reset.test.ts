/// <reference types="jest" />

/**
 * Emulation-reset test for oc_performance_insights (#846, P1 codex finding).
 *
 * Asserts that CPU / network throttling overrides are always reset on
 * the error path. If `Tracing.end` throws mid-collection, the handler
 * must still issue the corresponding `Emulation.setCPUThrottlingRate`
 * (with `rate: 1`) and `Network.emulateNetworkConditions` (with the
 * `NETWORK_PRESETS.none` reset payload) before rejecting — otherwise
 * the tab stays throttled for subsequent tool calls in the same
 * session.
 *
 * The test uses jest.mock on `../../src/session-manager` so we never
 * touch a real Chrome process; we feed our own stub page + stub CDP
 * session in.
 */

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { registerOcPerformanceInsightsTool } from '../../src/tools/oc-performance-insights';

interface RegisteredTool {
  handler: (sessionId: string, args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
    [key: string]: unknown;
  }>;
}

class StubServer {
  tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: RegisteredTool['handler']): void {
    this.tools.set(name, { handler });
  }
}

interface SendCall {
  method: string;
  params: unknown;
}

function makeStubCdp(opts: { throwOn?: string } = {}) {
  const calls: SendCall[] = [];
  const cdp = {
    calls,
    send: jest.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params: params ?? null });
      if (opts.throwOn && method === opts.throwOn) {
        throw new Error(`stub CDP: forced throw on ${method}`);
      }
      return undefined as unknown;
    }),
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    detach: jest.fn(async () => undefined),
  };
  return cdp;
}

function makeStubPage(cdp: ReturnType<typeof makeStubCdp>) {
  return {
    createCDPSession: jest.fn(async () => cdp),
    goto: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    waitForNavigation: jest.fn(async () => undefined),
  };
}

describe('oc_performance_insights emulation reset on error path', () => {
  let server: StubServer;
  let handler: RegisteredTool['handler'];

  beforeEach(() => {
    server = new StubServer();
    registerOcPerformanceInsightsTool(server as unknown as Parameters<typeof registerOcPerformanceInsightsTool>[0]);
    handler = server.tools.get('oc_performance_insights')!.handler;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('resets CPU + network overrides when Tracing.end throws mid-collection', async () => {
    const cdp = makeStubCdp({ throwOn: 'Tracing.end' });
    const page = makeStubPage(cdp);
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn(async () => page),
    });

    const result = await handler('s-1', {
      tabId: 'tab-1',
      cpuThrottling: 4,
      network: 'slow-3g',
      autoStop: { ms: 1 },
    });

    // The handler returns a structured error (not a throw) — but the
    // important assertion is that emulation overrides are reset.
    expect(result.isError).toBe(true);

    const sentMethods = cdp.calls.map((c) => c.method);
    // CPU + network were applied at the top of the try block.
    expect(sentMethods).toContain('Emulation.setCPUThrottlingRate');
    expect(sentMethods).toContain('Network.emulateNetworkConditions');

    // The final cleanup must have been sent even though Tracing.end threw.
    const cpuResetCall = [...cdp.calls]
      .reverse()
      .find((c) => c.method === 'Emulation.setCPUThrottlingRate');
    expect(cpuResetCall).toBeDefined();
    expect(cpuResetCall!.params).toEqual({ rate: 1 });

    const netResetCall = [...cdp.calls]
      .reverse()
      .find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(netResetCall).toBeDefined();
    expect(netResetCall!.params).toEqual({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  test('does NOT issue resets that were never applied', async () => {
    // No cpuThrottling, no network — both overrides stay un-applied.
    // A throw mid-trace must not surface phantom resets.
    const cdp = makeStubCdp({ throwOn: 'Tracing.end' });
    const page = makeStubPage(cdp);
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn(async () => page),
    });

    const result = await handler('s-1', {
      tabId: 'tab-1',
      autoStop: { ms: 1 },
    });

    expect(result.isError).toBe(true);
    const sentMethods = cdp.calls.map((c) => c.method);
    expect(sentMethods).not.toContain('Emulation.setCPUThrottlingRate');
    expect(sentMethods).not.toContain('Network.emulateNetworkConditions');
  });

  test('resets ONLY CPU when only CPU throttling was applied', async () => {
    const cdp = makeStubCdp({ throwOn: 'Tracing.end' });
    const page = makeStubPage(cdp);
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn(async () => page),
    });

    const result = await handler('s-1', {
      tabId: 'tab-1',
      cpuThrottling: 4,
      autoStop: { ms: 1 },
    });

    expect(result.isError).toBe(true);
    const sentMethods = cdp.calls.map((c) => c.method);
    expect(sentMethods).toContain('Emulation.setCPUThrottlingRate');
    expect(sentMethods).not.toContain('Network.emulateNetworkConditions');

    const cpuResetCall = [...cdp.calls]
      .reverse()
      .find((c) => c.method === 'Emulation.setCPUThrottlingRate');
    expect(cpuResetCall!.params).toEqual({ rate: 1 });
  });
});
