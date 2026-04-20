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

    await waitForFlush();
    await new Promise((r) => setTimeout(r, 50));
    const lines = readAll(logPath);
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
    await waitForFlush();
    await new Promise((r) => setTimeout(r, 50));
    const entry = readAll(logPath)[0];
    expect(entry.tenantId).toBe('unknown');
    expect(entry.requestId).toBeNull();
  });

  test('OPENCHROME_AUDIT_EXTENDED=false writes legacy shape', async () => {
    const logPath = makeTmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;
    process.env.OPENCHROME_AUDIT_EXTENDED = 'false';

    logAuditEntry('navigate', 'sess_1', { url: 'https://example.com', password: 'secret' });
    await waitForFlush();
    await new Promise((r) => setTimeout(r, 50));
    const entry = readAll(logPath)[0];
    expect(entry.timestamp).toBeDefined();
    expect(entry.args_summary).toBeDefined();
    expect(entry.requestId).toBeUndefined();
    expect(entry.tenantId).toBeUndefined();

    delete process.env.OPENCHROME_AUDIT_EXTENDED;
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
    await new Promise((r) => setTimeout(r, 50));
    const entry = readAll(logPath)[0];
    expect(entry.status).toBe('error');
    expect(entry.billable).toBe(false);
    expect(entry.errorMessage).toBe('boom');
  });
});
