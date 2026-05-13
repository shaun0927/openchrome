/// <reference types="jest" />

/**
 * Unit tests for the WebVoyager runner helpers.
 *
 * Today this covers the `gitSha()` path-injection mitigation: the runner
 * interpolates `git rev-parse --short HEAD` into report file paths, so a
 * hostile worktree state or env that produces non-SHA output must not
 * silently land in `reports/<whatever>.json`. We validate against
 * `/^[0-9a-f]{7,40}$/` and fall back to `'unknown'`.
 */

import { gitSha } from './runner';

describe('gitSha', () => {
  const originalError = console.error;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    console.error = originalError;
  });

  test('returns the trimmed SHA when output matches /^[0-9a-f]{7,40}$/', () => {
    const exec = jest.fn().mockReturnValue('a1b2c3d\n');
    expect(gitSha(exec)).toBe('a1b2c3d');
    expect(exec).toHaveBeenCalledWith('git rev-parse --short HEAD', { encoding: 'utf8' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('accepts a full 40-char SHA', () => {
    const sha = 'a'.repeat(40);
    const exec = jest.fn().mockReturnValue(`${sha}\n`);
    expect(gitSha(exec)).toBe(sha);
  });

  test('falls back to "unknown" and warns when output is not a SHA', () => {
    const exec = jest.fn().mockReturnValue('../../../etc/passwd\n');
    expect(gitSha(exec)).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('unexpected git rev-parse output');
    expect(msg).toContain('unknown');
  });

  test('falls back to "unknown" on an empty string', () => {
    const exec = jest.fn().mockReturnValue('\n');
    expect(gitSha(exec)).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('falls back to "unknown" on uppercase / mixed-case output', () => {
    const exec = jest.fn().mockReturnValue('A1B2C3D\n');
    expect(gitSha(exec)).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('falls back to "unknown" on output with shell metacharacters', () => {
    const exec = jest.fn().mockReturnValue('a1b2c3d; rm -rf /\n');
    expect(gitSha(exec)).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('returns "unknown" silently when exec throws', () => {
    const exec = jest.fn().mockImplementation(() => {
      throw new Error('not a git repo');
    });
    expect(gitSha(exec)).toBe('unknown');
    // Throw path is silent — no console.error — because "not a git repo"
    // is a legitimate dev-machine state (e.g. running from a tarball).
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
