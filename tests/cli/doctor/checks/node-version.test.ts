/**
 * Unit tests for node-version check
 */

import { checkNodeVersion } from '../../../../src/cli/doctor/checks/node-version';

describe('check: node-version', () => {
  const originalVersions = process.versions;

  afterEach(() => {
    jest.resetModules();
  });

  test('ok when current Node meets minimum', async () => {
    // Current Node is always >= 18 in this project's CI
    const result = await checkNodeVersion();
    expect(result.id).toBe('node-version');
    expect(result.title).toBe('Node.js version');
    expect(['ok', 'fail']).toContain(result.status);
  });

  test('ok when major version satisfies requirement', async () => {
    // Mock process.versions.node to a known-good value
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions, node: '20.0.0' },
      configurable: true,
    });
    const result = await checkNodeVersion();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('20.0.0');
    Object.defineProperty(process, 'versions', { value: originalVersions, configurable: true });
  });

  test('fail when Node version is too old', async () => {
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions, node: '14.0.0' },
      configurable: true,
    });
    const result = await checkNodeVersion();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('14.0.0');
    expect(result.remediation).toBeDefined();
    expect(result.remediation).toContain('nodejs.org');
    Object.defineProperty(process, 'versions', { value: originalVersions, configurable: true });
  });

  test('includes required field in detail', async () => {
    const result = await checkNodeVersion();
    expect(result.detail).toContain('required:');
  });
});
