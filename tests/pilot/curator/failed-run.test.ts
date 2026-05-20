/**
 * Tests for `recordFailedRun` — the symmetric failure-side logger
 * that gives the curator's prune sub-pass real fail-rate data.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  recordFailedRun,
  recordSuccessfulRun,
  computeSkillId,
} from '../../../src/pilot/curator/index.js';
import type { SkillSidecar } from '../../../src/pilot/curator/index.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curator-failed-run-test-'));
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

const DOMAIN = 'example.com';
const ANCHOR = 'deadbeefcafef00d';
const CONTRACT = 'cart.add';

function seedSkill(rootDir: string): string {
  recordSuccessfulRun(
    {
      txn_id: 't-success-0',
      contract_id: CONTRACT,
      intent: CONTRACT,
      domain: DOMAIN,
      graph_node_anchor: ANCHOR,
    },
    { rootDir },
  );
  const id = computeSkillId(ANCHOR, CONTRACT);
  return path.join(rootDir, DOMAIN, `${id}.json`);
}

function readSidecar(p: string): SkillSidecar {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SkillSidecar;
}

let root: string;
beforeEach(() => { root = mkTmp(); });
afterEach(() => { rmRf(root); });

describe('recordFailedRun', () => {
  it('is a no-op when no matching skill exists', () => {
    const result = recordFailedRun(
      { txn_id: 't-1', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    expect(result.recorded).toBe(false);
    expect(fs.existsSync(path.join(root, DOMAIN))).toBe(false);
  });

  it('appends ok=false on the sidecar for an existing skill', () => {
    const sidecarPath = seedSkill(root);
    const before = readSidecar(sidecarPath);
    expect(before.runs.recent.every((e) => e.ok)).toBe(true);

    const result = recordFailedRun(
      { txn_id: 't-fail-1', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    expect(result.recorded).toBe(true);

    const after = readSidecar(sidecarPath);
    const failures = after.runs.recent.filter((e) => e.ok === false);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.txn_id).toBe('t-fail-1');
  });

  it('does not change frontmatter (verified_runs, status, last_verified_at)', () => {
    seedSkill(root);
    const id = computeSkillId(ANCHOR, CONTRACT);
    const mdPath = path.join(root, DOMAIN, `${id}.md`);
    const before = fs.readFileSync(mdPath, 'utf8');
    recordFailedRun(
      { txn_id: 't-fail-2', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    const after = fs.readFileSync(mdPath, 'utf8');
    expect(after).toBe(before);
  });

  it('is idempotent on duplicate txn_id', () => {
    const sidecarPath = seedSkill(root);
    const first = recordFailedRun(
      { txn_id: 't-fail-dup', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    const second = recordFailedRun(
      { txn_id: 't-fail-dup', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    const failures = readSidecar(sidecarPath).runs.recent.filter((e) => e.ok === false);
    expect(failures).toHaveLength(1);
  });

  it('runs.count remains the success-only counter after a failure', () => {
    const sidecarPath = seedSkill(root);
    const before = readSidecar(sidecarPath);
    recordFailedRun(
      { txn_id: 't-fail-3', contract_id: CONTRACT, domain: DOMAIN, graph_node_anchor: ANCHOR },
      { rootDir: root },
    );
    const after = readSidecar(sidecarPath);
    expect(after.runs.count).toBe(before.runs.count);
  });
});
