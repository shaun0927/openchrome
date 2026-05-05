import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logAuditEntry, __resetAuditLoggerCachesForTests } from '../../src/security/audit-logger';
import { runWithRequestContext } from '../../src/observability/request-id';

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({
    security: {
      audit_log: true,
      audit_log_path: (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH,
    },
  }),
}));

function makeTmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-audit-'));
  return path.join(dir, 'audit.log');
}

function waitForFlush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForAuditEntries(
  logPath: string,
  expectedCount: number,
  timeoutMs = 1000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let lines: Array<Record<string, unknown>> = [];
  while (Date.now() <= deadline) {
    await waitForFlush();
    lines = readAll(logPath);
    if (lines.length >= expectedCount) return lines;
    await new Promise((r) => setTimeout(r, 25));
  }
  return lines;
}

function readAll(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('audit-logger extended fields', () => {
  beforeEach(() => {
    __resetAuditLoggerCachesForTests();
    delete process.env.OPENCHROME_AUDIT_EXTENDED;
  });

  test('extended entries include correlation fields and redacted args', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    runWithRequestContext({ requestId: 'req-abc-1', tenantId: 't_acme' }, () => {
      logAuditEntry(
        'fill_form',
        'sess_xyz',
        { username: 'u', password: 'hunter2' },
        undefined,
        { status: 'success', durationMs: 123 },
      );
    });

    const lines = await waitForAuditEntries(logPath, 1);
    expect(lines.length).toBe(1);
    const entry = lines[0];

    expect(entry.requestId).toBe('req-abc-1');
    expect(entry.tenantId).toBe('t_acme');
    expect(entry.sessionId).toBe('sess_xyz');
    expect(entry.status).toBe('success');
    expect(entry.durationMs).toBe(123);
    expect(entry.billable).toBe(true);
    expect(entry.argsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const args = entry.args as Record<string, unknown>;
    expect(args.password).toBe('[REDACTED]');
    expect(args.username).toBe('u');
  });

  test('falls back to tenant=unknown when no context', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    logAuditEntry('navigate', 'sess_1', { url: 'https://example.com' });
    const entry = (await waitForAuditEntries(logPath, 1))[0];
    expect(entry.tenantId).toBe('unknown');
    expect(entry.requestId).toBeNull();
  });

  test('OPENCHROME_AUDIT_EXTENDED=false writes legacy shape', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;
    process.env.OPENCHROME_AUDIT_EXTENDED = 'false';

    logAuditEntry('navigate', 'sess_1', { url: 'https://example.com', password: 'secret' });
    const entry = (await waitForAuditEntries(logPath, 1))[0];
    expect(entry.timestamp).toBeDefined();
    expect(entry.args_summary).toBeDefined();
    expect(entry.requestId).toBeUndefined();
    expect(entry.tenantId).toBeUndefined();

    delete process.env.OPENCHROME_AUDIT_EXTENDED;
  });

  test('cookie value is hashed via built-in rules when no external config is reachable', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    // Point env config at a path that does not exist so loadRedactionConfig
    // falls through to the built-in policy. cwd may or may not be the repo
    // root under jest; either way the built-in rules must cover cookies.
    process.env.OPENCHROME_AUDIT_REDACTION_CONFIG = path.join(
      os.tmpdir(),
      'oc-nonexistent-redaction-config.json',
    );
    const prevCwd = process.cwd();
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cwd-'));
    process.chdir(isolatedCwd);
    try {
      __resetAuditLoggerCachesForTests();
      logAuditEntry('cookies.set', 'sess_1', { name: 'session', value: 'super-secret' });
      const entry = (await waitForAuditEntries(logPath, 1))[0];
      const args = entry.args as Record<string, unknown>;
      expect(typeof args.value).toBe('string');
      expect(args.value as string).toMatch(/^sha256:/);
      expect(args.value).not.toContain('super-secret');
    } finally {
      process.chdir(prevCwd);
      delete process.env.OPENCHROME_AUDIT_REDACTION_CONFIG;
    }
  });


  test('aborted status writes abort metadata and defaults billable=false', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    runWithRequestContext({ requestId: 'req-abort-1', tenantId: 't_abort' }, () => {
      logAuditEntry('navigate', 'sess-abort', { url: 'https://example.com' }, undefined, {
        status: 'aborted',
        aborted: true,
        abortedAt: '2026-04-22T06:00:00.000Z',
        abortReason: 'client_disconnect',
      });
    });

    await waitForFlush();
    const entry = (await waitForAuditEntries(logPath, 1))[0];
    expect(entry.status).toBe('aborted');
    expect(entry.aborted).toBe(true);
    expect(entry.abortedAt).toBe('2026-04-22T06:00:00.000Z');
    expect(entry.abortReason).toBe('client_disconnect');
    expect(entry.billable).toBe(false);
  });

  test('error status marks billable=false and carries errorMessage', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    logAuditEntry('navigate', 'sess_1', { url: 'https://x.y' }, undefined, {
      status: 'error',
      durationMs: 42,
      errorMessage: 'boom',
    });
    await waitForFlush();
    const entry = (await waitForAuditEntries(logPath, 1))[0];
    expect(entry.status).toBe('error');
    expect(entry.billable).toBe(false);
    expect(entry.errorMessage).toBe('boom');
  });
});
