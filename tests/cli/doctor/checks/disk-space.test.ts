/**
 * Unit tests for disk-space check
 * Uses OPENCHROME_DOCTOR_FAKE_FREE_MB to inject fake free space values.
 */

describe('check: disk-space', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('ok when free space >= 500 MB', async () => {
    process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB = '10000';

    const { checkDiskSpace } = await import('../../../../src/cli/doctor/checks/disk-space');
    const result = await checkDiskSpace();

    expect(result.id).toBe('disk-space');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('10000 MB');
  });

  test('warn when free space is between 100 MB and 500 MB', async () => {
    process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB = '300';

    const { checkDiskSpace } = await import('../../../../src/cli/doctor/checks/disk-space');
    const result = await checkDiskSpace();

    expect(result.id).toBe('disk-space');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('300 MB');
    expect(result.remediation).toBeDefined();
  });

  test('fail when free space < 100 MB', async () => {
    process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB = '50';

    const { checkDiskSpace } = await import('../../../../src/cli/doctor/checks/disk-space');
    const result = await checkDiskSpace();

    expect(result.id).toBe('disk-space');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('50 MB');
    expect(result.remediation).toContain('disk space');
  });

  test('boundary: exactly 500 MB is ok', async () => {
    process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB = '500';

    const { checkDiskSpace } = await import('../../../../src/cli/doctor/checks/disk-space');
    const result = await checkDiskSpace();

    expect(result.id).toBe('disk-space');
    expect(result.status).toBe('ok');
  });

  test('boundary: exactly 100 MB is fail (<= 100 MB)', async () => {
    process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB = '100';

    const { checkDiskSpace } = await import('../../../../src/cli/doctor/checks/disk-space');
    const result = await checkDiskSpace();

    expect(result.id).toBe('disk-space');
    // Matches the inclusive fail boundary of the source: <= 100 → fail, > 100 → warn.
    // The 500 MB boundary test (above) remains symmetric: == 500 → ok, < 500 → warn.
    expect(result.status).toBe('fail');
  });
});
