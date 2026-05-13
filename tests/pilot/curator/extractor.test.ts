import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
  computeSkillId,
  listSkillsForDomain,
  recordSuccessfulRun,
} from '../../../src/pilot/curator/extractor';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skmem-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

function record(over: Partial<Parameters<typeof recordSuccessfulRun>[0]> = {}) {
  return {
    txn_id: 'txn-001',
    contract_id: 'amazon.cart-add',
    intent: 'Add specific item to cart',
    domain: 'amazon.com',
    graph_node_anchor: 'a1b2c3d4',
    ...over,
  };
}

describe('computeSkillId', () => {
  test('deterministic + stable across calls', () => {
    const a = computeSkillId('a1b2c3', 'cid');
    const b = computeSkillId('a1b2c3', 'cid');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test('different inputs → different ids', () => {
    expect(computeSkillId('a', 'cid')).not.toBe(computeSkillId('b', 'cid'));
    expect(computeSkillId('a', 'cidA')).not.toBe(computeSkillId('a', 'cidB'));
  });
});

describe('recordSuccessfulRun — first run', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates SKILL.md + sidecar with status=candidate, verified_runs=1', () => {
    const r = recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW });
    expect(r.created).toBe(true);
    expect(r.promoted).toBe(false);
    expect(r.record.frontmatter.status).toBe('candidate');
    expect(r.record.frontmatter.verified_runs).toBe(1);
    expect(fs.existsSync(r.record.filePath)).toBe(true);
    expect(fs.existsSync(r.record.sidecarPath)).toBe(true);
  });

  test('SKILL.md ends up at <rootDir>/<domain>/<skill_id>.md', () => {
    const r = recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW });
    const expectedDir = path.join(root, 'amazon.com');
    expect(r.record.filePath.startsWith(expectedDir)).toBe(true);
  });

  test('derives a kebab-cased name from intent when none supplied', () => {
    const r = recordSuccessfulRun(record({ intent: 'Click "Add to Cart" button' }), {
      rootDir: root,
      now: () => FIXED_NOW,
    });
    expect(r.record.frontmatter.name).toBe('click-add-to-cart-button');
  });

  test('honors an operator-supplied name', () => {
    const r = recordSuccessfulRun(record({ name: 'amazon.cart-add' }), {
      rootDir: root,
      now: () => FIXED_NOW,
    });
    expect(r.record.frontmatter.name).toBe('amazon.cart-add');
  });

  test('truncates intent to 512 chars', () => {
    const r = recordSuccessfulRun(record({ intent: 'x'.repeat(1000) }), {
      rootDir: root,
      now: () => FIXED_NOW,
    });
    expect(r.record.frontmatter.intent.length).toBe(512);
  });
});

describe('recordSuccessfulRun — re-runs (dedup)', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('same (graph_node_anchor, contract_id) increments verified_runs in place', () => {
    const a = recordSuccessfulRun(record({ txn_id: 't1' }), { rootDir: root, now: () => FIXED_NOW });
    const b = recordSuccessfulRun(record({ txn_id: 't2' }), {
      rootDir: root,
      now: () => FIXED_NOW + 60_000,
    });
    expect(a.record.skill_id).toBe(b.record.skill_id);
    expect(b.record.frontmatter.verified_runs).toBe(2);
    expect(b.record.frontmatter.contract_ref).toBe('t2');
    expect(b.created).toBe(false);
    // Still only ONE SKILL.md on disk for this domain.
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(1);
  });

  test('promotes from candidate → promoted at threshold (default 3)', () => {
    let t = FIXED_NOW;
    const ids: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = recordSuccessfulRun(record({ txn_id: `t${i}` }), {
        rootDir: root,
        now: () => (t += 60_000),
      });
      ids.push(r.promoted);
    }
    // Transition fires on the third run; subsequent runs report promoted=false.
    expect(ids).toEqual([false, false, true, false]);
    const final = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    expect(final.frontmatter.status).toBe('promoted');
    expect(final.frontmatter.verified_runs).toBe(4);
  });

  test('different contract_id → distinct skill files', () => {
    recordSuccessfulRun(record({ contract_id: 'A' }), { rootDir: root, now: () => FIXED_NOW });
    recordSuccessfulRun(record({ contract_id: 'B' }), { rootDir: root, now: () => FIXED_NOW });
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(2);
  });

  test('different graph_node_anchor → distinct skill files', () => {
    recordSuccessfulRun(record({ graph_node_anchor: 'aaaa' }), { rootDir: root, now: () => FIXED_NOW });
    recordSuccessfulRun(record({ graph_node_anchor: 'bbbb' }), { rootDir: root, now: () => FIXED_NOW });
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(2);
  });

  test('rolling 30-day window: a run outside the window does NOT count toward promotion', () => {
    const old = FIXED_NOW - 31 * 24 * 60 * 60 * 1000;
    recordSuccessfulRun(record({ txn_id: 'old' }), { rootDir: root, now: () => old });
    recordSuccessfulRun(record({ txn_id: 'fresh' }), { rootDir: root, now: () => FIXED_NOW });
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.verified_runs).toBe(1);
    expect(list[0].frontmatter.status).toBe('candidate');
  });

  test('archived skill stays archived even when re-run succeeds', () => {
    // First run creates it as candidate, then we archive it manually.
    const first = recordSuccessfulRun(record({ txn_id: 't1' }), { rootDir: root, now: () => FIXED_NOW });
    const archived = first.record.frontmatter;
    fs.writeFileSync(
      first.record.filePath,
      fs.readFileSync(first.record.filePath, 'utf8').replace('status: candidate', 'status: archived'),
    );
    const second = recordSuccessfulRun(record({ txn_id: 't2' }), {
      rootDir: root,
      now: () => FIXED_NOW + 60_000,
      promotionThreshold: 1,
    });
    expect(second.record.frontmatter.status).toBe('archived');
    expect(archived.status).toBe('candidate'); // sanity — original was candidate
  });

  test('preserves an existing distilled body when a re-run omits body', () => {
    const distilledBody = '## Steps\n\n1. Open cart.\n2. Confirm the saved item.\n';
    const first = recordSuccessfulRun(record({ txn_id: 't1', body: distilledBody }), {
      rootDir: root,
      now: () => FIXED_NOW,
    });

    const second = recordSuccessfulRun(record({ txn_id: 't2' }), {
      rootDir: root,
      now: () => FIXED_NOW + 60_000,
    });

    expect(second.created).toBe(false);
    expect(fs.readFileSync(first.record.filePath, 'utf8')).toContain(distilledBody.trim());
    expect(fs.readFileSync(first.record.filePath, 'utf8')).not.toContain(
      'LLM distillation lands in PR-20b',
    );
  });
});

describe('recordSuccessfulRun — sidecar recovery', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('preserves verified_runs when sidecar disappears between runs', () => {
    // First two runs to build up verified_runs=2.
    let t = FIXED_NOW;
    recordSuccessfulRun(record({ txn_id: 't1' }), { rootDir: root, now: () => t });
    t += 60_000;
    const second = recordSuccessfulRun(record({ txn_id: 't2' }), { rootDir: root, now: () => t });
    expect(second.record.frontmatter.verified_runs).toBe(2);

    // Sidecar is lost (e.g., partial fs sync, accidental delete).
    fs.rmSync(second.record.sidecarPath);

    // Next run must NOT reset to 1 — it should rebuild from frontmatter.
    t += 60_000;
    const third = recordSuccessfulRun(record({ txn_id: 't3' }), { rootDir: root, now: () => t });
    expect(third.created).toBe(false);
    expect(third.record.frontmatter.verified_runs).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(third.record.sidecarPath)).toBe(true);
  });

  test('structurally malformed sidecar is treated as missing (no crash)', () => {
    let t = FIXED_NOW;
    const first = recordSuccessfulRun(record({ txn_id: 't1' }), { rootDir: root, now: () => t });
    expect(first.record.frontmatter.verified_runs).toBe(1);

    // Sidecar exists but is structurally invalid (older schema, partial write, etc.).
    fs.writeFileSync(first.record.sidecarPath, '{}');

    t += 60_000;
    expect(() => recordSuccessfulRun(record({ txn_id: 't2' }), { rootDir: root, now: () => t })).not.toThrow();
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.verified_runs).toBeGreaterThanOrEqual(1);
  });

  test('preserves promoted status when sidecar is missing', () => {
    let t = FIXED_NOW;
    // 3 runs → promoted at default threshold.
    for (let i = 1; i <= 3; i++) {
      recordSuccessfulRun(record({ txn_id: `t${i}` }), { rootDir: root, now: () => t });
      t += 60_000;
    }
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list[0].frontmatter.status).toBe('promoted');
    fs.rmSync(list[0].sidecarPath);

    const next = recordSuccessfulRun(record({ txn_id: 't4' }), { rootDir: root, now: () => t });
    expect(next.record.frontmatter.status).toBe('promoted');
  });
});

describe('recordSuccessfulRun — concurrent writes', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('parallel calls for the same skill do not collide on a shared .tmp file', async () => {
    // Drive several concurrent record calls. With a fixed `.tmp`
    // path, two writers could clobber each other and at least one
    // rename would either fail or destroy the other writer's data.
    // With per-call unique temp paths, all calls succeed and the
    // final state is consistent with N completed runs.
    const N = 12;
    const t = FIXED_NOW;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        Promise.resolve().then(() =>
          recordSuccessfulRun(record({ txn_id: `t${i}` }), {
            rootDir: root,
            now: () => t + i,
          }),
        ),
      );
    }
    const results = await Promise.all(promises);
    expect(results).toHaveLength(N);
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.verified_runs).toBe(N);
    // No stray `.tmp` files left in the domain dir.
    const dir = path.dirname(list[0].filePath);
    const stragglers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  test('separate writer processes serialize read/merge/write updates', async () => {
    const N = 8;
    const script = `
      const { recordSuccessfulRun } = require('./src/pilot/curator/extractor');
      const [root, txn, now] = process.argv.slice(1);
      recordSuccessfulRun({
        txn_id: txn,
        contract_id: 'amazon.cart-add',
        intent: 'Add specific item to cart',
        domain: 'amazon.com',
        graph_node_anchor: 'a1b2c3d4',
      }, { rootDir: root, now: () => Number(now) });
    `;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '-r',
              'ts-node/register/transpile-only',
              '-e',
              script,
              root,
              `process-${i}`,
              String(FIXED_NOW + i),
            ],
            { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `child exited ${code}`));
          });
        }),
      ),
    );

    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.verified_runs).toBe(N);
    // Bumped from the default 10s timeout. Spawning 8 ts-node processes on a
    // hosted Windows-22 runner can comfortably take 12–15s before the first
    // child even reaches recordSuccessfulRun, so the default deadline trips
    // before the cross-process write lock can finish serializing N writers.
  }, 60_000);
});

describe('recordSuccessfulRun — domain validation', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['../escape'],
    ['..'],
    ['amazon.com/../etc'],
    ['amazon.com/sub'],
    ['amazon.com\\sub'],
    ['has spaces'],
    [''],
  ])('rejects malformed domain "%s"', (badDomain) => {
    expect(() =>
      recordSuccessfulRun(record({ domain: badDomain }), { rootDir: root, now: () => FIXED_NOW }),
    ).toThrow();
    // No state should be left on disk for a rejected domain.
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('listSkillsForDomain rejects malformed domain', () => {
    expect(() => listSkillsForDomain('../escape', { rootDir: root })).toThrow();
  });
});

describe('recordSuccessfulRun — sidecar entry validation', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('sidecar with malformed recent entries is treated as missing (no crash)', () => {
    let t = FIXED_NOW;
    const first = recordSuccessfulRun(record({ txn_id: 't1' }), { rootDir: root, now: () => t });

    // Corrupt the sidecar so the array is present but contains garbage.
    fs.writeFileSync(
      first.record.sidecarPath,
      JSON.stringify({
        schema_version: 1,
        skill_id: first.record.skill_id,
        graph_node_anchor: 'a1b2c3d4',
        contract_id: 'amazon.cart-add',
        runs: {
          count: 5,
          window_start: '2026-04-01T00:00:00Z',
          recent: [null, {}, { txn_id: 'no-ts', ok: true }],
        },
      }),
    );

    t += 60_000;
    expect(() => recordSuccessfulRun(record({ txn_id: 't2' }), { rootDir: root, now: () => t })).not.toThrow();
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
  });
});

describe('recordSuccessfulRun — promotionThreshold bounds', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects threshold above SKILL_RUN_LOG_MAX (would never promote)', () => {
    expect(() =>
      recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW, promotionThreshold: 51 }),
    ).toThrow();
  });

  test('rejects threshold below 1', () => {
    expect(() =>
      recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW, promotionThreshold: 0 }),
    ).toThrow();
  });

  test('accepts threshold equal to SKILL_RUN_LOG_MAX', () => {
    expect(() =>
      recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW, promotionThreshold: 50 }),
    ).not.toThrow();
  });
});

describe('listSkillsForDomain', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns [] for an unseen domain', () => {
    expect(listSkillsForDomain('nope.example', { rootDir: root })).toEqual([]);
  });

  test('skips files whose sidecar is missing or malformed', () => {
    recordSuccessfulRun(record(), { rootDir: root, now: () => FIXED_NOW });
    // Corrupt the sidecar
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    fs.writeFileSync(list[0].sidecarPath, '{not json');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toEqual([]);
  });
});
