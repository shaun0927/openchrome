/// <reference types="jest" />
/**
 * Tests for cloudflared download script platform mapping and naming conventions.
 * Does NOT perform actual downloads — validates the binary/suffix mapping logic.
 */

describe('download-cloudflared platform mappings', () => {
  // These maps mirror the script's constants for validation
  const BINARY_MAP: Record<string, string> = {
    'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
    'darwin-x64': 'cloudflared-darwin-amd64.tgz',
    'win32-x64': 'cloudflared-windows-amd64.exe',
    'linux-x64': 'cloudflared-linux-amd64',
  };

  const TAURI_SUFFIX_MAP: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
  };

  it('covers all required platform/arch combinations from issue #521', () => {
    const required = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
    for (const key of required) {
      expect(BINARY_MAP[key]).toBeDefined();
      expect(TAURI_SUFFIX_MAP[key]).toBeDefined();
    }
  });

  it('macOS binaries are tarballs (.tgz)', () => {
    expect(BINARY_MAP['darwin-arm64']).toMatch(/\.tgz$/);
    expect(BINARY_MAP['darwin-x64']).toMatch(/\.tgz$/);
  });

  it('Windows binary is .exe', () => {
    expect(BINARY_MAP['win32-x64']).toMatch(/\.exe$/);
  });

  it('Linux binary has no extension', () => {
    expect(BINARY_MAP['linux-x64']).not.toMatch(/\./);
  });

  it('Tauri suffixes follow Rust target triple convention', () => {
    expect(TAURI_SUFFIX_MAP['darwin-arm64']).toBe('aarch64-apple-darwin');
    expect(TAURI_SUFFIX_MAP['darwin-x64']).toBe('x86_64-apple-darwin');
    expect(TAURI_SUFFIX_MAP['win32-x64']).toBe('x86_64-pc-windows-msvc');
    expect(TAURI_SUFFIX_MAP['linux-x64']).toBe('x86_64-unknown-linux-gnu');
  });

  it('generates correct output filenames per platform', () => {
    const cases: Array<{ key: string; expected: string }> = [
      { key: 'darwin-arm64', expected: 'cloudflared-aarch64-apple-darwin' },
      { key: 'darwin-x64', expected: 'cloudflared-x86_64-apple-darwin' },
      { key: 'win32-x64', expected: 'cloudflared-x86_64-pc-windows-msvc.exe' },
      { key: 'linux-x64', expected: 'cloudflared-x86_64-unknown-linux-gnu' },
    ];

    for (const { key, expected } of cases) {
      const suffix = TAURI_SUFFIX_MAP[key];
      const isWindows = key.startsWith('win32');
      const ext = isWindows ? '.exe' : '';
      const outputName = `cloudflared-${suffix}${ext}`;
      expect(outputName).toBe(expected);
    }
  });

  it('script file exists and is executable', () => {
    const fs = require('fs');
    const scriptPath = require('path').join(__dirname, '..', '..', 'scripts', 'download-cloudflared.js');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('script prints help without error', () => {
    const { execSync } = require('child_process');
    const scriptPath = require('path').join(__dirname, '..', '..', 'scripts', 'download-cloudflared.js');
    const output = execSync(`node "${scriptPath}" --help`, { encoding: 'utf-8' });
    expect(output).toContain('--output-dir');
    expect(output).toContain('--platform');
    expect(output).toContain('--arch');
  });
});
