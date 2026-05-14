/**
 * Tests for the oc_skill_replay MCP tool (#875).
 *
 * Drives the tool handler directly (no live MCP transport, no live browser
 * session). The session manager is stubbed so `getPage` returns null — replay
 * therefore exercises the artifact-resolution + envelope-emission paths
 * without needing puppeteer. Live-browser scenarios live in
 * `tests/e2e/scenarios/skill-replay.e2e.ts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let _testRoot = '';
let _mockPage: unknown = null;
let _mockTargetIds: string[] = [];

jest.mock('../../src/core/skill-memory', () => {
  const real = jest.requireActual<typeof import('../../src/core/skill-memory')>(
    '../../src/core/skill-memory',
  );
  return {
    ...real,
    SkillMemoryStore: class extends real.SkillMemoryStore {
      constructor(opts: { domain: string; rootDir?: string }) {
        super({ ...opts, rootDir: opts.rootDir ?? _testRoot });
      }
    },
  };
});

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getPage: jest.fn(async () => _mockPage),
    getSessionTargetIds: jest.fn(() => _mockTargetIds),
    getCDPClient: () => null,
  }),
}));

import { registerOcSkillReplayTool } from '../../src/tools/oc-skill-replay';
import { registerOcSkillRecordTool } from '../../src/tools/oc-skill-record';
import {
  captureReplayStep,
  recorderBufferSize,
  REPLAY_ARTIFACT_SCHEMA_VERSION,
  SkillMemoryStore,
  type ReplayArtifact,
} from '../../src/core/skill-memory';
import type { MCPServer } from '../../src/mcp-server';

type HandlerFn = (sessionId: string, args: Record<string, unknown>) => Promise<unknown>;

class FakeMCPServer {
  private handlers = new Map<string, HandlerFn>();
  registerTool(name: string, handler: HandlerFn): void {
    this.handlers.set(name, handler);
  }
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`Unknown tool: ${name}`);
    return h('test-session', args) as Promise<Record<string, unknown>>;
  }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-replay-'));
}

function parseResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function singleStepArtifact(): ReplayArtifact {
  return {
    schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
    recorded_at: Date.now(),
    recorder: { openchrome_version: '1.11.0-test' },
    steps: [
      {
        kind: 'click',
        selectors: [{ type: 'css', value: '#submit' }],
      },
    ],
  };
}

function navigateArtifact(url: string): ReplayArtifact {
  return {
    schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
    recorded_at: Date.now(),
    recorder: { openchrome_version: '1.11.0-test' },
    steps: [{ kind: 'navigate', selectors: [], args: { url } }],
  };
}

let server: FakeMCPServer;

beforeEach(() => {
  _testRoot = tempRoot();
  _mockPage = null;
  _mockTargetIds = [];
  delete process.env.OPENCHROME_SKILL_REPLAY;
  server = new FakeMCPServer();
  registerOcSkillReplayTool(server as unknown as MCPServer);
  registerOcSkillRecordTool(server as unknown as MCPServer);
});

afterEach(() => {
  fs.rmSync(_testRoot, { recursive: true, force: true });
});

describe('oc_skill_replay — envelope contract', () => {
  test('rejects missing skill_id', async () => {
    const r = parseResult(await server.call('oc_skill_replay', { domain: 'localhost' }));
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('INVALID_ARGS');
  });

  test('rejects missing domain', async () => {
    const r = parseResult(await server.call('oc_skill_replay', { skill_id: 'x' }));
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('INVALID_ARGS');
  });

  test('SKILL_NOT_FOUND when skill_id is unknown', async () => {
    const r = parseResult(
      await server.call('oc_skill_replay', { skill_id: 'missing', domain: 'localhost' }),
    );
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('SKILL_NOT_FOUND');
  });

  test('DISABLED when OPENCHROME_SKILL_REPLAY=0', async () => {
    process.env.OPENCHROME_SKILL_REPLAY = '0';
    const r = parseResult(
      await server.call('oc_skill_replay', { skill_id: 'x', domain: 'localhost' }),
    );
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('DISABLED');
  });
});

describe('oc_skill_replay — artifact handling', () => {
  test('ARTIFACT_MISSING on a record with no replay artifacts', async () => {
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const recorded = await store.record({
      domain: 'localhost',
      name: 'legacy',
      steps: [{ kind: 'click', selector: '#x' }],
      contractId: 'c1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      // intentionally omit replayArtifacts → store pads with nulls
    });
    const r = parseResult(
      await server.call('oc_skill_replay', {
        skill_id: recorded.skill_id,
        domain: 'localhost',
      }),
    );
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('ARTIFACT_MISSING');
  });

  test('ARTIFACT_RESOLUTION_FAILED when no live page is available', async () => {
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const recorded = await store.record({
      domain: 'localhost',
      name: 'click-flow',
      steps: [{ kind: 'click' }],
      contractId: 'c1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      replayArtifacts: [singleStepArtifact()],
    });
    const r = parseResult(
      await server.call('oc_skill_replay', {
        skill_id: recorded.skill_id,
        domain: 'localhost',
      }),
    );
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('ARTIFACT_RESOLUTION_FAILED');
    expect((r.failure as { step_index: number }).step_index).toBe(0);
  });

  test('navigate-only artifact requires a live page to drive', async () => {
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const recorded = await store.record({
      domain: 'localhost',
      name: 'nav-only',
      steps: [{ kind: 'navigate', url: 'http://localhost:4173/' }],
      contractId: 'c1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      replayArtifacts: [navigateArtifact('http://localhost:4173/')],
    });
    const r = parseResult(
      await server.call('oc_skill_replay', {
        skill_id: recorded.skill_id,
        domain: 'localhost',
      }),
    );
    expect(r.ok).toBe(false);
    expect((r.failure as { code: string }).code).toBe('TARGET_NAVIGATED_AWAY');
  });

  test('uses the active session tab when tabId is omitted and dispatches click', async () => {
    const calls: unknown[][] = [];
    _mockTargetIds = ['tab-a', 'tab-active'];
    _mockPage = {
      evaluate: jest.fn(async (_fn: unknown, ...args: unknown[]) => {
        calls.push(args);
        return calls.length === 1 ? true : { ok: true };
      }),
    };
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const recorded = await store.record({
      domain: 'localhost',
      name: 'active-click',
      steps: [{ kind: 'click' }],
      contractId: 'c1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      replayArtifacts: [singleStepArtifact()],
    });

    const r = parseResult(
      await server.call('oc_skill_replay', { skill_id: recorded.skill_id, domain: 'localhost' }),
    );

    expect(r.ok).toBe(true);
    expect(r.steps_executed).toBe(1);
    expect((_mockPage as { evaluate: jest.Mock }).evaluate).toHaveBeenCalledTimes(2);
    expect(calls[0][0]).toMatchObject({ type: 'css', value: '#submit' });
  });
});

describe('oc_skill_record — replay_artifacts plumb-through', () => {
  test('flushes buffered replay steps from session targets into a v2 record', async () => {
    _mockTargetIds = ['target-buffered'];
    captureReplayStep('target-buffered', {
      kind: 'click',
      selectors: [{ type: 'css', value: '#submit' }],
    });

    const r = parseResult(
      await server.call('oc_skill_record', {
        domain: 'localhost',
        name: 'buffered',
        steps: [{ kind: 'click' }],
        contract_id: 'c1',
      }),
    );

    expect(r.skill_id).not.toBe('');
    expect(recorderBufferSize('target-buffered')).toBe(0);
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const rec = store.get(r.skill_id as string);
    expect(rec?.replayArtifacts?.[0]).toMatchObject({
      schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
      steps: [{ kind: 'click', selectors: [{ type: 'css', value: '#submit' }] }],
    });
  });

  test('round-trips a single artifact via record + get', async () => {
    const r = parseResult(
      await server.call('oc_skill_record', {
        domain: 'localhost',
        name: 'plumb',
        steps: [{ kind: 'click' }],
        contract_id: 'c1',
        replay_artifacts: [singleStepArtifact()],
      }),
    );
    expect(r.skill_id).not.toBe('');
    expect(Array.isArray(r.replay_artifacts)).toBe(true);
    const store = new SkillMemoryStore({ domain: 'localhost' });
    const rec = store.get(r.skill_id as string);
    expect(rec).not.toBeNull();
    expect(rec!.replayArtifacts).toBeDefined();
    expect(rec!.replayArtifacts![0]).not.toBeNull();
  });

  test('rejects an invalid artifact (validation failure surfaces as error)', async () => {
    const r = parseResult(
      await server.call('oc_skill_record', {
        domain: 'localhost',
        name: 'bad',
        steps: [{ kind: 'click' }],
        contract_id: 'c1',
        replay_artifacts: [
          {
            schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
            recorded_at: Date.now(),
            recorder: { openchrome_version: 'x' },
            // empty steps — invalid
            steps: [],
          },
        ],
      }),
    );
    expect(r.skill_id).toBe('');
    expect(typeof r.error).toBe('string');
  });

  test('feature-off forces null replay_artifacts on the response', async () => {
    process.env.OPENCHROME_SKILL_REPLAY = '0';
    const r = parseResult(
      await server.call('oc_skill_record', {
        domain: 'localhost',
        name: 'gate-off',
        steps: [{ kind: 'click' }],
        contract_id: 'c1',
        replay_artifacts: [singleStepArtifact()],
      }),
    );
    expect(r.replay_artifacts).toBeNull();
  });
});
