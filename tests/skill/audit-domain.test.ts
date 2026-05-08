/**
 * Domain preservation in skill_graph audit rows.
 *
 * Lives in its own file because the existing audit-logger config plumbing
 * is module-scoped — `jest.mock('../../src/config/global')` is the
 * established pattern for tests that need extended-mode entries to land
 * on disk (see tests/security/audit-logger-extended.test.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AuditLogGraphEmitter } from '../../src/skill/audit';
import { __resetAuditLoggerCachesForTests } from '../../src/security/audit-logger';

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({
    security: {
      audit_log: true,
      audit_log_path: (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH,
    },
  }),
}));

function tmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-audit-domain-'));
  return path.join(dir, 'audit.log');
}

async function flushAndRead(p: string, expected = 1, timeoutMs = 1000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await new Promise((r) => setImmediate(r));
    if (fs.existsSync(p)) {
      const lines = fs
        .readFileSync(p, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      if (lines.length >= expected) return lines;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

describe('AuditLogGraphEmitter — preserves entry.domain', () => {
  beforeEach(() => {
    __resetAuditLoggerCachesForTests();
    delete process.env.OPENCHROME_AUDIT_EXTENDED;
  });

  test('graph_hit row carries the bound domain (extended mode)', async () => {
    const logPath = tmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    const emitter = new AuditLogGraphEmitter('sess_xyz', 'amazon.com');
    emitter.emit({
      event: 'graph_hit',
      domain: 'amazon.com',
      fromState: 'A',
      toState: 'B',
      actionKind: 'click',
      ok: true,
    });

    const [entry] = await flushAndRead(logPath, 1);
    expect(entry).toBeDefined();
    expect(entry.tool).toBe('skill_graph');
    expect(entry.domain).toBe('amazon.com');
    const args = entry.args as Record<string, unknown>;
    expect(args.event).toBe('graph_hit');
  });

  test('legacy mode (OPENCHROME_AUDIT_EXTENDED=false) also carries domain', async () => {
    const logPath = tmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;
    process.env.OPENCHROME_AUDIT_EXTENDED = 'false';

    const emitter = new AuditLogGraphEmitter('sess_xyz', 'shop.example.co.uk');
    emitter.emit({
      event: 'graph_miss',
      domain: 'shop.example.co.uk',
      fromState: 'A',
      ok: false,
      reason: 'no_action_available',
    });

    const [entry] = await flushAndRead(logPath, 1);
    expect(entry).toBeDefined();
    expect(entry.tool).toBe('skill_graph');
    expect(entry.domain).toBe('shop.example.co.uk');
  });
});
