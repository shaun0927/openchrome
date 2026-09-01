import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { parse } from 'yaml';

const targets = require('../../scripts/standalone/targets.cjs') as {
  PINNED_BUN_VERSION: string;
  TARGETS: Record<string, { bunTarget: string; standaloneAsset: string }>;
  resolveTarget: (input: string) => { target: string; standaloneAsset: string };
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

  test('build script documents fail-closed target, tag, and output controls', () => {
    const script = path.join(process.cwd(), 'scripts', 'build-standalone-cli.cjs');
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(output).toContain('--target <target>');
    expect(output).toContain('--tag <vX.Y.Z>');
    expect(output).toContain('--output-dir <path>');
  });

  test('CLI release workflow uses the canonical builder and certified browser smoke', () => {
    const cliWorkflow = readFileSync(path.join(process.cwd(), '.github', 'workflows', 'cli-release.yml'), 'utf8');
    const workflow = parse(cliWorkflow);
    const matrix = workflow.jobs.build.strategy.matrix.include;
    const steps = workflow.jobs.build.steps;

    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.push.tags).toEqual(['v*']);
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.env.BUN_VERSION).toBe(targets.PINNED_BUN_VERSION);
    expect(matrix.map((entry: { target: string }) => entry.target).sort()).toEqual(Object.keys(targets.TARGETS).sort());
    expect(matrix.find((entry: { platform_name: string }) => entry.platform_name === 'macos-x64').os).toBe('macos-15-intel');
    expect(steps.find((step: { name: string }) => step.name === 'Setup Bun ${{ env.BUN_VERSION }}')).toMatchObject({
      uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      with: { 'bun-version': '${{ env.BUN_VERSION }}' },
    });
    expect(steps.find((step: { name: string }) => step.name === 'Build standalone executable').run).toContain(
      'scripts/build-standalone-cli.cjs',
    );
    expect(steps.find((step: { name: string }) => step.name === 'Install Chrome for live standalone smoke')).toMatchObject({
      uses: 'browser-actions/setup-chrome@e574b4b3a21156ab45dd6b5f67e884fd26eed829',
      with: { 'chrome-version': '131.0.6778.87' },
    });
    expect(steps.find((step: { name: string }) => step.name === 'Verify standalone navigate and read_page against real Chrome').run).toContain(
      'scripts/verify-standalone-browser-smoke.cjs',
    );
  });
});
