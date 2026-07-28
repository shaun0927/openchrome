/// <reference types="jest" />

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIST_CLI = path.join(process.cwd(), 'dist', 'cli', 'index.js');
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'playbook');
const describeBuiltCli = fs.existsSync(DIST_CLI) ? describe : describe.skip;

function runValidate(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [DIST_CLI, 'playbook', 'validate', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OPENCHROME_UPDATE_CHECK: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
}

describeBuiltCli('oc playbook validate built CLI', () => {
  test('returns 0 for schema-conforming playbooks without starting Chrome', () => {
    const result = runValidate([path.join(FIXTURES, 'sanity.yaml'), '--json']);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { summary: { ok: boolean; errors: number } };
    expect(report.summary).toMatchObject({ ok: true, errors: 0 });
    expect(result.stderr).not.toContain('Chrome debugging port');
    expect(result.stderr).not.toContain('[CDPClient] Connected');
  });

  test('returns 1 with stable ids for registered-schema failures', () => {
    const result = runValidate([path.join(FIXTURES, 'schema-invalid.yaml'), '--json']);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ id?: string; code: string }>;
      summary: { ok: boolean; errors: number };
    };
    expect(report.summary.ok).toBe(false);
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wait_navigation', code: 'schema.required' }),
      expect.objectContaining({ id: 'perform_action', code: 'schema.required' }),
      expect.objectContaining({ id: 'read_html', code: 'schema.enum' }),
    ]));
  });

  test('discovers the manifest without writing runtime state', () => {
    const readOnlyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-validate-readonly-'));
    try {
      fs.chmodSync(readOnlyCwd, 0o555);
      const result = runValidate([path.join(FIXTURES, 'sanity.yaml'), '--json'], readOnlyCwd);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(readOnlyCwd, '.openchrome'))).toBe(false);
    } finally {
      fs.chmodSync(readOnlyCwd, 0o755);
      fs.rmSync(readOnlyCwd, { recursive: true, force: true });
    }
  });

  test('flushes large JSON validation reports before exiting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-validate-large-'));
    const filePath = path.join(tempDir, 'large-invalid.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        name: 'large invalid report',
        steps: Array.from({ length: 2_000 }, () => ({
          wait_for: { condition: 'navigation' },
        })),
      }));

      const result = runValidate([filePath, '--json']);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout.length).toBeGreaterThan(64 * 1024);
      const report = JSON.parse(result.stdout) as {
        diagnostics: unknown[];
        summary: { total: number; ok: boolean };
      };
      expect(report.summary).toMatchObject({ total: 2_000, ok: false });
      expect(report.diagnostics.length).toBeGreaterThan(2_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    [[], /missing required argument 'file'/i],
    [['--bogus'], /unknown option '--bogus'/i],
    [[path.join(FIXTURES, 'sanity.yaml'), '--reuse'], /--reuse is not supported/i],
    [['/tmp/openchrome-playbook-does-not-exist.yaml'], /cannot read file/i],
  ])('returns 2 for usage or file errors: %j', (args, message) => {
    const result = runValidate(args as string[]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message as RegExp);
  });
});
