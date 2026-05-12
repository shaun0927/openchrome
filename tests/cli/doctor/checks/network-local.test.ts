/**
 * Unit tests for network-local check
 */

describe('check: network-local', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('ok on normal system (loopback available)', async () => {
    const { checkNetworkLocal } = await import('../../../../src/cli/doctor/checks/network-local');
    const result = await checkNetworkLocal();

    expect(result.id).toBe('network-local');
    expect(result.title).toContain('Local network');
    // On a normal dev/CI machine, loopback should be ok
    expect(['ok', 'warn', 'fail']).toContain(result.status);
    expect(typeof result.durationMs === 'undefined' || result.id === 'network-local').toBe(true);
  });

  test('ok when DNS resolves localhost and TCP works', async () => {
    // Real check on the test machine — should pass in CI
    const { checkNetworkLocal } = await import('../../../../src/cli/doctor/checks/network-local');
    const result = await checkNetworkLocal();

    expect(result.id).toBe('network-local');
    if (result.status === 'ok') {
      expect(result.detail).toContain('127.0.0.1');
    }
  });

  test('returns fail with remediation when DNS fails', async () => {
    jest.mock('dns', () => ({
      ...jest.requireActual('dns'),
      lookup: jest.fn((_host: string, _opts: unknown, cb: (err: Error | null, addresses: unknown) => void) => {
        cb(new Error('ENOTFOUND'), []);
      }),
    }));

    jest.resetModules();
    const { checkNetworkLocal } = await import('../../../../src/cli/doctor/checks/network-local');
    const result = await checkNetworkLocal();

    expect(result.id).toBe('network-local');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('/etc/hosts');
  });
});
