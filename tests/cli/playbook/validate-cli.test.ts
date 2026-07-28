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
