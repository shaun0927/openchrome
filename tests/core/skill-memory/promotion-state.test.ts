/**
 * Tests for the skill promotion state field on SkillMemoryStore
 * (#1431 Part 2). Covers:
 *   - records loaded from disk normalise to promotionState='recorded';
 *   - setPromotionState rotates state and updates timestamp;
 *   - quarantine carries a truncated reason;
 *   - oc_skill_recall filters by promotion state with safe defaults.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPServer } from '../../../src/mcp-server';
import { registerOcSkillRecallTool } from '../../../src/tools/oc-skill-recall';
import {
  SkillMemoryStore,
  type SkillRecord,
} from '../../../src/core/skill-memory';

// Redirect os.homedir() to a per-test temp root. The recall tool builds its
// own SkillMemoryStore from the default root, so a constructor rootDir on the
// test store alone is not enough; mocking homedir covers both stores and is
// portable (HOME on POSIX, USERPROFILE on Windows would otherwise diverge).
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-promotion-'));
}

function getRegisteredTool(server: MCPServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function }> | undefined;
  if (!reg) throw new Error('MCPServer has no tools map');
  const entry = reg.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry;
}

function parseResult(res: { content: Array<{ type: string; text?: string }> }) {
  const block = res.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text result block');
  }
  return JSON.parse(block.text);
}

describe('skill promotion state (#1431 Part 2)', () => {
  let root: string;
  let store: SkillMemoryStore;
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerOcSkillRecallTool(server);
  });

  beforeEach(() => {
    root = tempRoot();
    (os.homedir as jest.Mock).mockReturnValue(root);
    store = new SkillMemoryStore({ domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function record(name: string): Promise<string> {
    const r = await store.record({
      domain: 'amazon.com',
      name,
      steps: [],
      contractId: 'contract-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    } as Omit<SkillRecord, 'skillId'>);
    return r.skill_id;
  }

  it('defaults newly-loaded records to promotionState=recorded', async () => {
    const skillId = await record('a');
    const fetched = store.get(skillId);
    expect(fetched?.promotionState).toBe('recorded');
  });

  it('rotates promotionState through re_verified -> recallable', async () => {
    const skillId = await record('a');
    await store.setPromotionState(skillId, 're_verified', 1000);
    expect(store.get(skillId)?.promotionState).toBe('re_verified');
    expect(store.get(skillId)?.promotionStateAt).toBe(1000);

    await store.setPromotionState(skillId, 'recallable', 2000);
    expect(store.get(skillId)?.promotionState).toBe('recallable');
    expect(store.get(skillId)?.promotionStateAt).toBe(2000);
  });

  it('quarantine carries a truncated reason', async () => {
    const skillId = await record('a');
    const reason = 'x'.repeat(800);
    await store.setPromotionState(skillId, 'quarantined', 3000, reason);
    const fetched = store.get(skillId);
    expect(fetched?.promotionState).toBe('quarantined');
    expect(fetched?.promotionQuarantineReason?.length).toBeLessThanOrEqual(512);
  });

  it('throws on unknown skill_id', async () => {
    await expect(
      store.setPromotionState('deadbeefdeadbeef', 'recallable', 1),
    ).rejects.toThrow(/unknown skill_id/);
  });

  it('oc_skill_recall hides recorded skills by default', async () => {
    await record('a'); // stays recorded
    const promoted = await record('b');
    await store.setPromotionState(promoted, 'recallable', 1000);

    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', { domain: 'amazon.com' });
    const parsed = parseResult(res);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].promotionState).toBe('recallable');
  });

  it('oc_skill_recall surfaces recorded skills when include_unpromoted=true', async () => {
    const skillId = await record('isolated-name-for-this-test');
    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', {
      domain: 'amazon.com',
      include_unpromoted: true,
    });
    const parsed = parseResult(res);
    // Locate by skill_id rather than by total count — other tests in
    // this file may leak state if a parallel jest worker shares HOME.
    const found = parsed.skills.find(
      (s: { skillId: string }) => s.skillId === skillId,
    );
    expect(found).toBeDefined();
    expect(found.promotionState).toBe('recorded');
  });

  it('oc_skill_recall hides quarantined skills unless include_quarantined=true', async () => {
    const a = await record('a');
    const b = await record('b');
    await store.setPromotionState(a, 'recallable', 1);
    await store.setPromotionState(b, 'quarantined', 2, 'contract failed');
    const tool = getRegisteredTool(server, 'oc_skill_recall');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = parseResult(await (tool.handler as any)('test-session', { domain: 'amazon.com' }));
    expect(r1.skills).toHaveLength(1);
    expect(r1.skills[0].promotionState).toBe('recallable');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2 = parseResult(
      await (tool.handler as any)('test-session', {
        domain: 'amazon.com',
        include_quarantined: true,
      }),
    );
    expect(r2.skills.length).toBe(2);
  });

  it('clears promotionQuarantineReason when transitioning out of quarantine', async () => {
    const skillId = await record('a');
    await store.setPromotionState(skillId, 'quarantined', 1000, 'bad replay');
    expect(store.get(skillId)?.promotionQuarantineReason).toBeDefined();
    await store.setPromotionState(skillId, 're_verified', 2000);
    const fetched = store.get(skillId);
    expect(fetched?.promotionState).toBe('re_verified');
    expect(fetched?.promotionQuarantineReason).toBeUndefined();
  });

  it('preserves promotionState across idempotent re-record', async () => {
    const skillId = await record('a');
    await store.setPromotionState(skillId, 'recallable', 1000);
    await record('a'); // same domain + name → re-record
    const fetched = store.get(skillId);
    expect(fetched?.promotionState).toBe('recallable');
    expect(fetched?.promotionStateAt).toBe(1000);
  });

  it('auto-fallback: surfaces unpromoted records when no skill in domain is promoted', async () => {
    // Domain has only legacy / unpromoted records → recall keeps v1.x
    // semantics so existing deployments do not silently lose skills.
    await record('legacy-a');
    await record('legacy-b');
    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', { domain: 'amazon.com' });
    const parsed = parseResult(res);
    expect(parsed.skills.length).toBe(2);
    expect(parsed.promotion_filter_active).toBe(false);
  });

  it('promotion_filter_active reports true once any skill is promoted', async () => {
    await record('legacy');
    const promoted = await record('shiny');
    await store.setPromotionState(promoted, 'recallable', 1);
    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', { domain: 'amazon.com' });
    const parsed = parseResult(res);
    expect(parsed.promotion_filter_active).toBe(true);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].promotionState).toBe('recallable');
  });

  it('include_quarantined on an unpromoted domain surfaces recorded + quarantined (auto-fallback)', async () => {
    // No skill is promoted, so recall is in v1.x auto-fallback and recorded
    // skills surface. include_quarantined is an independent diagnostic flag, so
    // passing it alone yields recorded + quarantined together — and the filter
    // stays inactive because nothing is promoted.
    const a = await record('recorded-one');
    const q = await record('quarantined-one');
    await store.setPromotionState(q, 'quarantined', 1, 'contract failed');
    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', {
      domain: 'amazon.com',
      include_quarantined: true,
    });
    const parsed = parseResult(res);
    expect(parsed.promotion_filter_active).toBe(false);
    const states = parsed.skills
      .map((s: { skillId: string; promotionState?: string }) => s.skillId)
      .sort();
    expect(states).toEqual([a, q].sort());
  });
});
