/**
 * Tests for oc_skill_record and oc_skill_recall MCP tools (issue #785).
 *
 * Tests call the tool handlers directly (no MCP transport) by wiring a minimal
 * fake server and using jest.mock to inject a per-test rootDir into the
 * SkillMemoryStore constructor so fixtures land in a temp directory instead of
 * ~/.openchrome/skill-memory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── rootDir injection ─────────────────────────────────────────────────────────
// Jest module mocking must be declared before any imports that use the module.
// We store the desired rootDir in a closure variable and swap it per test.

let _testRoot = '';

jest.mock('../../../src/core/skill-memory', () => {
  // Pull in the real module but wrap SkillMemoryStore so construction always
  // uses _testRoot when no explicit rootDir is given.
  const real = jest.requireActual<typeof import('../../../src/core/skill-memory')>(
    '../../../src/core/skill-memory',
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

import { registerOcSkillRecordTool } from '../../../src/tools/oc-skill-record';
import { registerOcSkillRecallTool } from '../../../src/tools/oc-skill-recall';
import { SkillMemoryStore } from '../../../src/core/skill-memory';
import type { MCPServer } from '../../../src/mcp-server';

// ── Minimal fake MCPServer ────────────────────────────────────────────────────

type HandlerFn = (sessionId: string, args: Record<string, unknown>) => Promise<unknown>;

class FakeMCPServer {
  private handlers = new Map<string, HandlerFn>();

  registerTool(name: string, handler: HandlerFn, _definition: unknown): void {
    this.handlers.set(name, handler);
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`Unknown tool: ${name}`);
    return h('test-session', args) as Promise<Record<string, unknown>>;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-tools-'));
}

function parseResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let server: FakeMCPServer;

beforeEach(() => {
  _testRoot = tempRoot();
  server = new FakeMCPServer();
  registerOcSkillRecordTool(server as unknown as MCPServer);
  registerOcSkillRecallTool(server as unknown as MCPServer);
});

afterEach(() => {
  fs.rmSync(_testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── oc_skill_record ───────────────────────────────────────────────────────────

describe('oc_skill_record', () => {
  test('records a skill and returns skill_id + stored_at', async () => {
    const result = parseResult(
      await server.call('oc_skill_record', {
        domain: 'amazon.com',
        name: 'add-to-cart',
        steps: [{ kind: 'click', selector: '#buy' }],
        contract_id: 'c-1',
      }),
    );

    expect(typeof result.skill_id).toBe('string');
    expect((result.skill_id as string).length).toBeGreaterThan(0);
    expect(typeof result.stored_at).toBe('number');
    expect(result.error).toBeUndefined();
  });

  test('is idempotent on (domain, name) — same skill_id returned on re-record', async () => {
    const first = parseResult(
      await server.call('oc_skill_record', {
        domain: 'amazon.com',
        name: 'add-to-cart',
        steps: [{ kind: 'click', selector: '#buy' }],
        contract_id: 'c-1',
      }),
    );

    const second = parseResult(
      await server.call('oc_skill_record', {
        domain: 'amazon.com',
        name: 'add-to-cart',
        steps: [{ kind: 'click', selector: '#buy-v2' }],
        contract_id: 'c-2',
      }),
    );

    expect(second.skill_id).toBe(first.skill_id);
    expect(second.error).toBeUndefined();
  });

  test('with frozen_snapshot writes to disk and returns snapshot_path', async () => {
    const result = parseResult(
      await server.call('oc_skill_record', {
        domain: 'amazon.com',
        name: 'checkout',
        steps: [{ kind: 'navigate', url: '/checkout' }],
        contract_id: 'c-checkout',
        frozen_snapshot: { page: 'checkout', items: 3 },
      }),
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.snapshot_path).toBe('string');
    const snapshotPath = result.snapshot_path as string;
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(snapshotPath.endsWith('.json.gz')).toBe(true);
  });

  test('returns error when domain is missing', async () => {
    const result = parseResult(
      await server.call('oc_skill_record', {
        name: 'foo',
        steps: [],
        contract_id: 'c-1',
      }),
    );
    expect(typeof result.error).toBe('string');
    expect((result.error as string).toLowerCase()).toContain('domain');
  });

  test('returns error when steps is not an array', async () => {
    const result = parseResult(
      await server.call('oc_skill_record', {
        domain: 'amazon.com',
        name: 'foo',
        steps: 'not-an-array',
        contract_id: 'c-1',
      }),
    );
    expect(typeof result.error).toBe('string');
    expect((result.error as string).toLowerCase()).toContain('steps');
  });
});

// ── oc_skill_recall ───────────────────────────────────────────────────────────

describe('oc_skill_recall', () => {
  /** Seed skills with controlled lastUsedAt values via the store directly. */
  async function seedSkills(): Promise<void> {
    const store = new SkillMemoryStore({ domain: 'amazon.com', rootDir: _testRoot });
    const a = await store.record({
      domain: 'amazon.com',
      name: 'skill-a',
      steps: [],
      contractId: 'c-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    });
    await store.markUsed(a.skill_id, 3000, true);

    const b = await store.record({
      domain: 'amazon.com',
      name: 'skill-b',
      steps: [],
      contractId: 'c-2',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    });
    await store.markUsed(b.skill_id, 2000, true);

    // skill-c: never used (lastUsedAt stays 0)
    await store.record({
      domain: 'amazon.com',
      name: 'skill-c',
      steps: [],
      contractId: 'c-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    });
  }

  test('returns recent skills first (recency order)', async () => {
    await seedSkills();

    const result = parseResult(
      await server.call('oc_skill_recall', { domain: 'amazon.com' }),
    );

    expect(result.error).toBeUndefined();
    const skills = result.skills as Array<{ name: string }>;
    expect(skills.length).toBe(3);
    expect(skills[0].name).toBe('skill-a');
    expect(skills[1].name).toBe('skill-b');
    expect(skills[2].name).toBe('skill-c');
  });

  test('filtered by contract_id returns only matching skills', async () => {
    await seedSkills();

    const result = parseResult(
      await server.call('oc_skill_recall', {
        domain: 'amazon.com',
        contract_id: 'c-1',
      }),
    );

    expect(result.error).toBeUndefined();
    const skills = result.skills as Array<{ contractId: string }>;
    expect(skills.length).toBe(2);
    for (const s of skills) {
      expect(s.contractId).toBe('c-1');
    }
  });

  test('respects limit', async () => {
    await seedSkills();

    const result = parseResult(
      await server.call('oc_skill_recall', {
        domain: 'amazon.com',
        limit: 2,
      }),
    );

    expect(result.error).toBeUndefined();
    expect((result.skills as unknown[]).length).toBe(2);
  });

  test('returns empty array when domain has no skills', async () => {
    const result = parseResult(
      await server.call('oc_skill_recall', { domain: 'empty.com' }),
    );

    expect(result.error).toBeUndefined();
    expect(result.skills).toEqual([]);
  });

  test('returns error when domain is missing', async () => {
    const result = parseResult(await server.call('oc_skill_recall', {}));
    expect(typeof result.error).toBe('string');
    expect((result.error as string).toLowerCase()).toContain('domain');
  });

  test('default limit is 20 — does not return more than 20 skills', async () => {
    const store = new SkillMemoryStore({ domain: 'big.com', rootDir: _testRoot });
    for (let i = 0; i < 25; i++) {
      await store.record({
        domain: 'big.com',
        name: `skill-${i}`,
        steps: [],
        contractId: 'c-x',
        successCount: 0,
        lastUsedAt: i,
        frozenSnapshotPath: null,
      });
    }

    const result = parseResult(
      await server.call('oc_skill_recall', { domain: 'big.com' }),
    );

    expect(result.error).toBeUndefined();
    expect((result.skills as unknown[]).length).toBe(20);
  }, 30000);
});
