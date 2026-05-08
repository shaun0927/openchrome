import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AuditLogGraphEmitter,
  buildEventFromResult,
  buildEventFromError,
  emitGraphEvent,
  type GraphAuditEvent,
} from '../../src/skill/audit';
import { runSkill, type ExecutionContext, type ToolRouter } from '../../src/skill/executor';
import { SkillGraphStorage } from '../../src/skill/storage';
import type { PageSnapshot } from '../../src/skill/state';
import { __resetAuditLoggerCachesForTests } from '../../src/security/audit-logger';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-audit-'));
}

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    interactives: [{ tagName: 'button', tagPath: 'body>button', role: 'button' }],
    headings: [],
    landmarks: {},
    ...over,
  };
}

function ctxWithStates(seq: PageSnapshot[]): ExecutionContext {
  let i = 0;
  return {
    async snapshotPageState() {
      const next = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return next;
    },
  };
}

describe('buildEventFromResult — wire shape', () => {
  test('graph_hit success carries action kind, fromState, toState, ok=true', () => {
    const event = buildEventFromResult('amazon.com', {
      outcome: 'graph_hit',
      fromState: 'a',
      toState: 'b',
      action: { kind: 'click', argsNorm: 'ref:1', args: {} },
      ok: true,
      matchedExpected: true,
    });
    expect(event).toEqual({
      event: 'graph_hit',
      domain: 'amazon.com',
      fromState: 'a',
      toState: 'b',
      actionKind: 'click',
      actionArgsNorm: 'ref:1',
      ok: true,
      reason: undefined,
      matchedExpected: true,
    });
  });

  test('graph_miss without action sets actionKind=undefined and ok=false', () => {
    const event = buildEventFromResult('x.com', {
      outcome: 'graph_miss',
      fromState: 'a',
      ok: false,
      reason: 'no_action_available',
    });
    expect(event.event).toBe('graph_miss');
    expect(event.ok).toBe(false);
    expect(event.actionKind).toBeUndefined();
    expect(event.reason).toBe('no_action_available');
  });

  test('graph_fallback_promoted with action carries argsNorm', () => {
    const event = buildEventFromResult('x.com', {
      outcome: 'graph_fallback_promoted',
      fromState: 'a',
      toState: 'b',
      action: { kind: 'navigate', argsNorm: '"https://x"', args: 'https://x' },
      ok: true,
    });
    expect(event.event).toBe('graph_fallback_promoted');
    expect(event.actionArgsNorm).toBe('"https://x"');
  });
});

describe('emitGraphEvent — passthrough', () => {
  test('no-op when emitter is undefined', () => {
    expect(() =>
      emitGraphEvent(undefined, 'x.com', {
        outcome: 'graph_miss',
        fromState: 'a',
        ok: false,
      }),
    ).not.toThrow();
  });

  test('forwards built event to emitter.emit', () => {
    const captured: GraphAuditEvent[] = [];
    emitGraphEvent({ emit: (e) => captured.push(e) }, 'x.com', {
      outcome: 'graph_hit',
      fromState: 'a',
      toState: 'b',
      action: { kind: 'click', argsNorm: 'ref:1', args: {} },
      ok: true,
      matchedExpected: true,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe('graph_hit');
  });
});

/* ------------------------------------------------------------------ */
/* runSkill emits exactly one event per call                          */
/* ------------------------------------------------------------------ */

function mockRouter(behaviour: {
  fallback?: { kind: string; argsNorm: string; args: unknown } | null;
  result?: { ok: boolean; reason?: string };
} = {}): ToolRouter {
  return {
    async pickFallbackAction() {
      return behaviour.fallback ?? null;
    },
    async runAction() {
      return { ok: behaviour.result?.ok ?? true, reason: behaviour.result?.reason };
    },
  };
}

describe('runSkill — audit emission', () => {
  let root: string;
  let storage: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new SkillGraphStorage('amazon.com', { rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('emits exactly one event on graph_miss + no_action path', async () => {
    const events: GraphAuditEvent[] = [];
    const result = await runSkill({
      storage,
      router: mockRouter({ fallback: null }),
      ctx: ctxWithStates([snap()]),
      intent: {},
      audit: { emit: (e) => events.push(e) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('graph_miss');
    expect(events[0].domain).toBe('amazon.com');
    expect(events[0].ok).toBe(false);
    expect(result.outcome).toBe('graph_miss');
  });

  test('emits exactly one event on graph_fallback_promoted (success)', async () => {
    const events: GraphAuditEvent[] = [];
    await runSkill({
      storage,
      router: mockRouter({
        fallback: { kind: 'click', argsNorm: 'ref:x', args: {} },
        result: { ok: true },
      }),
      ctx: ctxWithStates([snap({ url: 'https://a' }), snap({ url: 'https://b' })]),
      intent: {},
      audit: { emit: (e) => events.push(e) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('graph_fallback_promoted');
    expect(events[0].actionKind).toBe('click');
    expect(events[0].ok).toBe(true);
  });

  test('domain field overrides storage.domain when supplied', async () => {
    const events: GraphAuditEvent[] = [];
    await runSkill({
      storage,
      router: mockRouter({ fallback: null }),
      ctx: ctxWithStates([snap()]),
      intent: {},
      audit: { emit: (e) => events.push(e) },
      domain: 'custom.example',
    });
    expect(events[0].domain).toBe('custom.example');
  });

  test('no audit emitter → no observable side effect (existing behaviour preserved)', async () => {
    const result = await runSkill({
      storage,
      router: mockRouter({ fallback: null }),
      ctx: ctxWithStates([snap()]),
      intent: {},
    });
    // The result is the same shape as without audit; no assertion failures.
    expect(result.outcome).toBe('graph_miss');
  });

  test('snapshotPageState() rejects → emits graph_error then re-throws', async () => {
    const events: GraphAuditEvent[] = [];
    const failingCtx: ExecutionContext = {
      async snapshotPageState() {
        throw new Error('cdp_disconnected');
      },
    };
    await expect(
      runSkill({
        storage,
        router: mockRouter({ fallback: null }),
        ctx: failingCtx,
        intent: {},
        audit: { emit: (e) => events.push(e) },
      }),
    ).rejects.toThrow('cdp_disconnected');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('graph_error');
    expect(events[0].ok).toBe(false);
    expect(events[0].reason).toBe('cdp_disconnected');
    // Snapshot failed before fromState was computed.
    expect(events[0].fromState).toBe('');
    expect(events[0].actionKind).toBeUndefined();
  });

  test('audit emitter throw does NOT poison a successful run', async () => {
    // Successful run + emitter that throws → caller still receives the
    // RunSkillResult (no reclassification to graph_error, no rethrow).
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runSkill({
        storage,
        router: mockRouter({
          fallback: { kind: 'click', argsNorm: 'ref:x', args: {} },
          result: { ok: true },
        }),
        ctx: ctxWithStates([snap({ url: 'https://a' }), snap({ url: 'https://b' })]),
        intent: {},
        audit: {
          emit: () => {
            throw new Error('disk_full');
          },
        },
      });
      expect(result.outcome).toBe('graph_fallback_promoted');
      expect(result.ok).toBe(true);
      // Emitter failure surfaced through console.error — observability-only.
      expect(errorSpy).toHaveBeenCalledWith(
        '[skill] graph audit emit failed:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejection with undefined value still re-throws (no silent success)', async () => {
    // `Promise.reject()` / `throw undefined` / `throw null` are legitimate
    // rejection patterns. The executor must propagate them rather than
    // swallow the failure into a `result === undefined` "success" return.
    const events: GraphAuditEvent[] = [];
    const undefinedThrowingCtx: ExecutionContext = {
      async snapshotPageState() {
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      },
    };
    let caught: unknown = 'no_catch';
    try {
      await runSkill({
        storage,
        router: mockRouter({ fallback: null }),
        ctx: undefinedThrowingCtx,
        intent: {},
        audit: { emit: (e) => events.push(e) },
      });
    } catch (err) {
      caught = err;
    }
    // Truly undefined rejection — but the executor still re-raised it.
    expect(caught).toBeUndefined();
    // Audit telemetry must still record the failure event (1:1 guarantee).
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('graph_error');
    expect(events[0].reason).toBe('unknown_error');
  });

  test('audit emitter throw on the error path does NOT mask the inner exception', async () => {
    // Inner failure + emitter that also throws → caller sees the *original*
    // error, not the emit error.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failingCtx: ExecutionContext = {
      async snapshotPageState() {
        throw new Error('cdp_disconnected');
      },
    };
    try {
      await expect(
        runSkill({
          storage,
          router: mockRouter({ fallback: null }),
          ctx: failingCtx,
          intent: {},
          audit: {
            emit: () => {
              throw new Error('disk_full');
            },
          },
        }),
      ).rejects.toThrow('cdp_disconnected');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('runAction() rejects after graph hit → graph_error carries fromState/action', async () => {
    // Seed a graph_hit candidate so runSkill takes the graph-hit path.
    const before = snap({ url: 'https://hit.example/a' });
    const after = snap({ url: 'https://hit.example/b' });
    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;
    const toHash = computeStateHash(after).hash;
    storage.upsertNode({ stateHash: fromHash });
    storage.upsertNode({ stateHash: toHash });
    storage.recordOutcome({
      fromState: fromHash,
      actionKind: 'click',
      actionArgsNorm: 'ref:hit',
      observedToState: toHash,
      success: true,
    });

    const events: GraphAuditEvent[] = [];
    const failingRouter: ToolRouter = {
      async pickFallbackAction() {
        return null;
      },
      async runAction() {
        throw new Error('tool_router_offline');
      },
    };
    await expect(
      runSkill({
        storage,
        router: failingRouter,
        ctx: ctxWithStates([before, after]),
        intent: {},
        audit: { emit: (e) => events.push(e) },
      }),
    ).rejects.toThrow('tool_router_offline');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('graph_error');
    expect(events[0].ok).toBe(false);
    expect(events[0].fromState).toBe(fromHash);
    expect(events[0].actionKind).toBe('click');
    expect(events[0].reason).toBe('tool_router_offline');
  });
});

describe('buildEventFromError — wire shape', () => {
  test('error message becomes reason; ok=false; fromState defaults to empty', () => {
    const event = buildEventFromError('amazon.com', new Error('snapshot_failed'), {});
    expect(event.event).toBe('graph_error');
    expect(event.ok).toBe(false);
    expect(event.reason).toBe('snapshot_failed');
    expect(event.fromState).toBe('');
    expect(event.actionKind).toBeUndefined();
  });

  test('captures partial trace (fromState + action) when present', () => {
    const event = buildEventFromError('x.com', new Error('boom'), {
      fromState: 'A',
      action: { kind: 'click', argsNorm: 'ref:1', args: { ref: 'a' } },
    });
    expect(event.fromState).toBe('A');
    expect(event.actionKind).toBe('click');
    expect(event.actionArgsNorm).toBe('ref:1');
  });

  test('non-Error rejection: string maps to reason; unknown type → "unknown_error"', () => {
    expect(buildEventFromError('x', 'literal_string', {}).reason).toBe('literal_string');
    expect(buildEventFromError('x', { not: 'an error' }, {}).reason).toBe('unknown_error');
    expect(buildEventFromError('x', null, {}).reason).toBe('unknown_error');
  });
});

/* ------------------------------------------------------------------ */
/* AuditLogGraphEmitter integration with audit-logger                 */
/* ------------------------------------------------------------------ */

describe('AuditLogGraphEmitter — writes through audit-logger', () => {
  const origConfig = process.env.OPENCHROME_AUDIT_LOG_PATH;
  const origEnabled = process.env.OPENCHROME_AUDIT_LOG;
  let logPath: string;

  beforeEach(() => {
    __resetAuditLoggerCachesForTests();
    const dir = tempRoot();
    logPath = path.join(dir, 'audit.jsonl');
    process.env.OPENCHROME_AUDIT_LOG = '1';
    process.env.OPENCHROME_AUDIT_LOG_PATH = logPath;
  });

  afterEach(() => {
    if (origConfig === undefined) delete process.env.OPENCHROME_AUDIT_LOG_PATH;
    else process.env.OPENCHROME_AUDIT_LOG_PATH = origConfig;
    if (origEnabled === undefined) delete process.env.OPENCHROME_AUDIT_LOG;
    else process.env.OPENCHROME_AUDIT_LOG = origEnabled;
    __resetAuditLoggerCachesForTests();
  });

  test('emit() does not throw when audit logging is disabled (config gated)', () => {
    delete process.env.OPENCHROME_AUDIT_LOG;
    __resetAuditLoggerCachesForTests();
    const emitter = new AuditLogGraphEmitter('sess1', 'amazon.com');
    expect(() =>
      emitter.emit({
        event: 'graph_hit',
        domain: 'amazon.com',
        fromState: 'a',
        toState: 'b',
        ok: true,
      }),
    ).not.toThrow();
  });
});
