/**
 * Unit tests for chrome-port check
 */

import * as net from 'net';

describe('check: chrome-port', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CHROME_PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('ok when port is free', async () => {
    // Use a port that is definitely free (ephemeral range)
    process.env.CHROME_PORT = '19222';
    const { checkChromePort } = await import('../../../../src/cli/doctor/checks/chrome-port');
    const result = await checkChromePort();

    expect(result.id).toBe('chrome-port');
    expect(result.title).toContain('CDP port');
    // Port should be free on test machine
    expect(['ok', 'warn']).toContain(result.status);
  });

  test('ok when port has a valid CDP endpoint', async () => {
    // Mock fetch to return a valid CDP response
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ Browser: 'Chrome/120.0.0.0', webSocketDebuggerUrl: 'ws://localhost:19222/devtools/browser/abc' }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    // Simulate port being in use by having a server listen
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(19223, '127.0.0.1', resolve));

    process.env.CHROME_PORT = '19223';
    jest.resetModules();
    const { checkChromePort } = await import('../../../../src/cli/doctor/checks/chrome-port');
    const result = await checkChromePort();

    server.close();
    expect(result.id).toBe('chrome-port');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('CDP endpoint');
  });

  test('warn when port is in use without CDP', async () => {
    // Simulate port in use but no CDP endpoint
    const mockFetch = jest.fn().mockRejectedValue(new Error('connection refused'));
    global.fetch = mockFetch as unknown as typeof fetch;

    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(19224, '127.0.0.1', resolve));

    process.env.CHROME_PORT = '19224';
    jest.resetModules();
    const { checkChromePort } = await import('../../../../src/cli/doctor/checks/chrome-port');
    const result = await checkChromePort();

    server.close();
    expect(result.id).toBe('chrome-port');
    expect(result.status).toBe('warn');
    expect(result.remediation).toBeDefined();
  });
});
