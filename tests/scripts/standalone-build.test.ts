import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const targets = require('../../scripts/standalone/targets.cjs') as {
  PINNED_BUN_VERSION: string;
  TARGETS: Record<string, { bunTarget: string; standaloneAsset: string }>;
  resolveTarget: (input: string) => { target: string; standaloneAsset: string };
  outputName: (target: { target: string; standaloneAsset: string; extension: string }, kind: string) => string;
};

describe('standalone CLI build contract', () => {
  test('pins Bun and covers the certified release matrix', () => {
    expect(targets.PINNED_BUN_VERSION).toBe('1.3.14');
    expect(Object.keys(targets.TARGETS).sort()).toEqual([
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
    ]);
  });

  test.each([
    ['macos-arm64', 'openchrome-macos-arm64'],
    ['macos-x64', 'openchrome-macos-x64'],
    ['windows-x64', 'openchrome-windows-x64.exe'],
    ['linux-x64', 'openchrome-linux-x64'],
  ])('maps %s to release asset %s', (alias, expected) => {
    expect(targets.resolveTarget(alias).standaloneAsset).toBe(expected);
  });

  test('sidecar naming stays compatible with Tauri externalBin', () => {
    const target = targets.resolveTarget('windows-x64') as { target: string; standaloneAsset: string; extension: string };
    expect(targets.outputName(target, 'sidecar')).toBe('openchrome-sidecar-x86_64-pc-windows-msvc.exe');
  });

  test('build script documents fail-closed target, tag, and output controls', () => {
    const script = path.join(process.cwd(), 'scripts', 'build-standalone-cli.cjs');
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(output).toContain('--target <target>');
    expect(output).toContain('--tag <vX.Y.Z>');
    expect(output).toContain('--output-dir <path>');
  });

  test('desktop and release workflows share the canonical builder', () => {
    const desktopScript = fs.readFileSync(path.join(process.cwd(), 'desktop', 'scripts', 'build-sidecar.js'), 'utf8');
    const desktopWorkflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'desktop-release.yml'), 'utf8');
    const cliWorkflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'cli-release.yml'), 'utf8');
    expect(desktopScript).toContain('build-standalone-cli.cjs');
    expect(desktopWorkflow).toContain('build-standalone-cli.cjs');
    expect(desktopWorkflow).toContain('npm run build');
    expect(desktopWorkflow.indexOf('npm run build')).toBeLessThan(
      desktopWorkflow.indexOf('build-standalone-cli.cjs'),
    );
    expect(cliWorkflow).toContain('build-standalone-cli.cjs');
    expect(cliWorkflow).toContain('macos-15-intel');
    expect(cliWorkflow).toContain("bun-version: ${{ env.BUN_VERSION }}");
    expect(cliWorkflow).toContain('verify-standalone-browser-smoke.cjs');
    expect(cliWorkflow).toContain('browser-actions/setup-chrome@e574b4b3a21156ab45dd6b5f67e884fd26eed829');
    expect(cliWorkflow).toContain('chrome-version: 131.0.6778.87');
    expect(cliWorkflow).toContain('workflow_dispatch:');
    expect(cliWorkflow).toContain('tags:');
    expect(cliWorkflow).not.toContain('pull_request:');
  });
});
