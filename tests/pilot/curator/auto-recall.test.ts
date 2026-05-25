/**
 * Tests for `recallCuratorSkills` — surfaces promoted curator skills
 * back into the LLM-facing payload (e.g. `oc_task_run_start`).
 *
 * Coverage:
 *   - Activation chain: pilot off, curator off, auto-recall off →
 *     all return null.
 *   - Returns null when domain is empty / no promoted skills exist.
 *   - Filters out candidate / archived skills.
 *   - Ordering: verified_runs DESC, last_verified_at DESC, skill_id ASC.
 *   - Limit clamped to [1, 25].
 *   - Intent truncated to 256 chars.
 *   - `hostnameForRecall` lower-cases + handles malformed URLs.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function hexAnchor(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex').slice(0, 16);
}

import {
  computeSkillId,
  hostnameForRecall,
  recallCuratorSkills,
  recordSuccessfulRun,
} from '../../../src/pilot/curator/index.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

const DOMAIN = 'example.com';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auto-recall-test-'));
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function seed(rootDir: string, anchor: string, contract: string, opts: { runs?: number; nowMs?: number } = {}): void {
  const total = opts.runs ?? 3;
  for (let i = 0; i < total; i++) {
    recordSuccessfulRun(
      {
        txn_id: `t-${anchor}-${i}`,
        contract_id: contract,
        intent: contract,
        domain: DOMAIN,
        graph_node_anchor: anchor,
      },
      {
        rootDir,
        ...(opts.nowMs !== undefined ? { now: () => opts.nowMs! + i } : {}),
      },
    );
  }
}

let root: string;
beforeEach(() => {
  root = mkTmp();
  process.argv = ['node', 'cli/index.js', '--pilot'];
  process.env.OPENCHROME_AUTO_RECALL = '1';
  resetFlagsCache();
});

afterEach(() => {
  delete process.env.OPENCHROME_AUTO_RECALL;
  delete process.env.OPENCHROME_SKILL_CURATOR;
  process.argv = ['node', 'cli/index.js'];
  resetFlagsCache();
  rmRf(root);
});

describe('recallCuratorSkills — activation gates', () => {
  it('returns null when pilot is off', () => {
    process.argv = ['node', 'cli/index.js'];
    resetFlagsCache();
    seed(root, hexAnchor('a1'), 'cart.add');
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root })).toBeNull();
  });

  it('returns null when skill-curator family is explicitly off', () => {
    process.env.OPENCHROME_SKILL_CURATOR = '0';
    resetFlagsCache();
    seed(root, hexAnchor('a1'), 'cart.add');
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root })).toBeNull();
  });

  it('returns null when auto-recall is off', () => {
    delete process.env.OPENCHROME_AUTO_RECALL;
    resetFlagsCache();
    seed(root, hexAnchor('a1'), 'cart.add');
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root })).toBeNull();
  });

  it('returns null when domain is empty', () => {
    seed(root, hexAnchor('a1'), 'cart.add');
    expect(recallCuratorSkills({ domain: '', rootDir: root })).toBeNull();
    expect(recallCuratorSkills({ domain: '   ', rootDir: root })).toBeNull();
  });
});

describe('recallCuratorSkills — content', () => {
  it('returns promoted skills only', () => {
    // Promoted: 3+ successful runs each.
    seed(root, hexAnchor('a-promoted'), 'cart.add');
    // Candidate: only 1 run.
    seed(root, hexAnchor('a-candidate'), 'cart.empty', { runs: 1 });
    const payload = recallCuratorSkills({ domain: DOMAIN, rootDir: root });
    expect(payload).not.toBeNull();
    expect(payload!.skills.map((s) => s.skill_id)).toContain(
      computeSkillId(hexAnchor('a-promoted'), 'cart.add'),
    );
    expect(payload!.skills.map((s) => s.skill_id)).not.toContain(
      computeSkillId(hexAnchor('a-candidate'), 'cart.empty'),
    );
  });

  it('returns null when no promoted skills exist', () => {
    seed(root, hexAnchor('a-candidate'), 'cart.empty', { runs: 1 });
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root })).toBeNull();
  });

  it('orders by verified_runs DESC', () => {
    seed(root, hexAnchor('a-five'), 'cart.add', { runs: 5 });
    seed(root, hexAnchor('a-three'), 'cart.checkout', { runs: 3 });
    seed(root, hexAnchor('a-four'), 'cart.review', { runs: 4 });
    const payload = recallCuratorSkills({ domain: DOMAIN, rootDir: root });
    expect(payload).not.toBeNull();
    expect(payload!.skills.map((s) => s.verified_runs)).toEqual([5, 4, 3]);
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 7; i++) {
      seed(root, hexAnchor(`a-${i}`), `c-${i}`);
    }
    const payload = recallCuratorSkills({ domain: DOMAIN, rootDir: root, limit: 3 });
    expect(payload?.skills).toHaveLength(3);
  });

  it('clamps an out-of-range limit to [1, 25]', () => {
    for (let i = 0; i < 5; i++) {
      seed(root, hexAnchor(`a-${i}`), `c-${i}`);
    }
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root, limit: 0 })?.skills).toHaveLength(1);
    expect(recallCuratorSkills({ domain: DOMAIN, rootDir: root, limit: 9999 })?.skills.length).toBeLessThanOrEqual(25);
  });

  it('truncates intent to 256 chars', () => {
    const longIntent = 'x'.repeat(1024);
    recordSuccessfulRun(
      { txn_id: 't-1', contract_id: longIntent, intent: longIntent, domain: DOMAIN, graph_node_anchor: hexAnchor('long-a') },
      { rootDir: root },
    );
    recordSuccessfulRun(
      { txn_id: 't-2', contract_id: longIntent, intent: longIntent, domain: DOMAIN, graph_node_anchor: hexAnchor('long-a') },
      { rootDir: root },
    );
    recordSuccessfulRun(
      { txn_id: 't-3', contract_id: longIntent, intent: longIntent, domain: DOMAIN, graph_node_anchor: hexAnchor('long-a') },
      { rootDir: root },
    );
    const payload = recallCuratorSkills({ domain: DOMAIN, rootDir: root });
    expect(payload?.skills[0]?.intent.length).toBeLessThanOrEqual(256);
  });
});

describe('hostnameForRecall', () => {
  it('lower-cases the hostname', () => {
    expect(hostnameForRecall('https://Example.COM/cart')).toBe('example.com');
  });
  it('returns null for malformed URLs', () => {
    expect(hostnameForRecall('not a url')).toBeNull();
    expect(hostnameForRecall('')).toBeNull();
    expect(hostnameForRecall(null)).toBeNull();
    expect(hostnameForRecall(undefined)).toBeNull();
  });
});
