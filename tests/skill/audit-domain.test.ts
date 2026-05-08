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

import { AuditLogGraphEmitter, type GraphAuditEvent } from '../../src/skill/audit';
import { runSkill, type ExecutionContext, type ToolRouter } from '../../src/skill/executor';
import { SkillGraphStorage } from '../../src/skill/storage';
import type { PageSnapshot } from '../../src/skill/state';
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

  test('event.domain takes precedence over the emitter default', async () => {
    // The emitter is bound to "amazon.com" but the event came from a
    // call that overrode `RunSkillArgs.domain` to "alt.example". The
    // top-level entry.domain MUST follow the event, otherwise per-domain
    // filtering returns the wrong rows for sessions that span domains.
    const logPath = tmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    const emitter = new AuditLogGraphEmitter('sess_xyz', 'amazon.com');
    emitter.emit({
      event: 'graph_hit',
      domain: 'alt.example',
      fromState: 'A',
      toState: 'B',
      ok: true,
    });

    const [entry] = await flushAndRead(logPath, 1);
    expect(entry).toBeDefined();
    expect(entry.domain).toBe('alt.example');
    expect((entry.args as Record<string, unknown>).domain).toBe('alt.example');
  });

  test('runSkill domain override propagates end-to-end into entry.domain', async () => {
    const logPath = tmpLogPath();
    (globalThis as { __TEST_AUDIT_PATH?: string }).__TEST_AUDIT_PATH = logPath;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-domain-e2e-'));
    const storage = new SkillGraphStorage('amazon.com', { rootDir: root });
    try {
      const snap = (url: string): PageSnapshot => ({
        url,
        interactives: [{ tagName: 'button', tagPath: 'body>button', role: 'button' }],
        headings: [],
        landmarks: {},
      });
      let i = 0;
      const seq = [snap('https://amazon.com/'), snap('https://amazon.com/cart')];
      const ctx: ExecutionContext = {
        async snapshotPageState() {
          const next = seq[Math.min(i, seq.length - 1)];
          i += 1;
          return next;
        },
      };
      const router: ToolRouter = {
        async pickFallbackAction() {
          return { kind: 'click', argsNorm: 'ref:x', args: { ref: 'x' } };
        },
        async runAction() {
          return { ok: true };
        },
      };

      const emitter = new AuditLogGraphEmitter('sess_xyz', 'amazon.com');
      const events: GraphAuditEvent[] = [];
      await runSkill({
        storage,
        router,
        ctx,
        intent: {},
        domain: 'partner.example',
        audit: {
          emit(e) {
            events.push(e);
            emitter.emit(e);
          },
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].domain).toBe('partner.example');
      const [entry] = await flushAndRead(logPath, 1);
      expect(entry.domain).toBe('partner.example');
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
