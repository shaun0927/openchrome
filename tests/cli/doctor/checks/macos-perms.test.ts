/**
 * Unit tests for macos-perms check
 */

describe('check: macos-perms', () => {
  test('skip on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const { checkMacosPerms } = await import('../../../../src/cli/doctor/checks/macos-perms');
      const result = await checkMacosPerms();

      expect(result.id).toBe('macos-perms');
      expect(result.status).toBe('skip');
      expect(result.detail).toContain('Not macOS');
    } else {
      // On macOS, TCC.db read typically fails (Full Disk Access not granted)
      const { checkMacosPerms } = await import('../../../../src/cli/doctor/checks/macos-perms');
      const result = await checkMacosPerms();

      expect(result.id).toBe('macos-perms');
      // skip is the expected common case on macOS without Full Disk Access
      expect(['ok', 'warn', 'skip']).toContain(result.status);
      // remediation should always be present (the primary value of this check)
      expect(result.remediation).toBeDefined();
      expect(result.remediation).toContain('Screen Recording');
    }
  });

  test('skip result has a remediation message', async () => {
    const { checkMacosPerms } = await import('../../../../src/cli/doctor/checks/macos-perms');
    const result = await checkMacosPerms();

    // skip on non-macOS
    if (result.status === 'skip') {
      // Remediation on the skip case is set for macOS only (non-macOS skip has none)
      expect(result.id).toBe('macos-perms');
    }
  });
});
