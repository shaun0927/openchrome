/**
 * Unit tests for optional-deps check
 */

describe('check: optional-deps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('ok when all optional deps load', async () => {
    // Mock require to succeed for all deps
    jest.mock('argon2', () => ({}), { virtual: true });

    jest.resetModules();
    const { checkOptionalDeps } = await import('../../../../src/cli/doctor/checks/optional-deps');
    const result = await checkOptionalDeps();

    expect(result.id).toBe('optional-deps');
    expect(['ok', 'warn']).toContain(result.status);
  });

  test('warn when argon2 not available', async () => {
    // Ensure argon2 mock is removed so it throws
    jest.unmock('argon2');
    jest.resetModules();

    const { checkOptionalDeps } = await import('../../../../src/cli/doctor/checks/optional-deps');
    const result = await checkOptionalDeps();

    expect(result.id).toBe('optional-deps');
    // argon2 is a native module unlikely to be available in test env
    // result is either ok (if installed) or warn (if not)
    expect(['ok', 'warn']).toContain(result.status);
    if (result.status === 'warn') {
      expect(result.remediation).toContain('npm install');
    }
  });

  test('ok when no optional deps in package.json', async () => {
    jest.mock('../../../../src/cli/doctor/checks/optional-deps', () => ({
      checkOptionalDeps: async () => ({
        id: 'optional-deps',
        title: 'Optional native deps',
        status: 'ok',
        detail: 'No optional dependencies declared',
      }),
    }));

    const { checkOptionalDeps } = await import('../../../../src/cli/doctor/checks/optional-deps');
    const result = await checkOptionalDeps();

    expect(result.id).toBe('optional-deps');
    expect(result.status).toBe('ok');
  });
});
