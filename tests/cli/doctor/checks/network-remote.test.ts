/**
 * Unit tests for network-remote check
 */

describe('check: network-remote', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('skip when remote env not set (default)', async () => {
    const { checkNetworkRemote } = await import('../../../../src/cli/doctor/checks/network-remote');
    const result = await checkNetworkRemote();

    expect(result.id).toBe('network-remote');
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('--remote');
  });

  test('ok when remote probe succeeds', async () => {
    process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED = '1';
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mockFetch as unknown as typeof fetch;

    jest.resetModules();
    const { checkNetworkRemote } = await import('../../../../src/cli/doctor/checks/network-remote');
    const result = await checkNetworkRemote();

    expect(result.id).toBe('network-remote');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('HTTP 200');
  });

  test('fail when remote probe throws (network unavailable)', async () => {
    process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED = '1';
    const mockFetch = jest.fn().mockRejectedValue(new Error('fetch failed'));
    global.fetch = mockFetch as unknown as typeof fetch;

    jest.resetModules();
    const { checkNetworkRemote } = await import('../../../../src/cli/doctor/checks/network-remote');
    const result = await checkNetworkRemote();

    expect(result.id).toBe('network-remote');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('proxy');
  });

  test('warn when remote returns HTTP 5xx', async () => {
    process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED = '1';
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    global.fetch = mockFetch as unknown as typeof fetch;

    jest.resetModules();
    const { checkNetworkRemote } = await import('../../../../src/cli/doctor/checks/network-remote');
    const result = await checkNetworkRemote();

    expect(result.id).toBe('network-remote');
    expect(result.status).toBe('warn');
  });
});
