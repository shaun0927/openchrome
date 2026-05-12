import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startCuratorRunner } from '../../../src/pilot/curator/runner';
import { recordSuccessfulRun } from '../../../src/pilot/curator/extractor';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runner-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

describe('startCuratorRunner', () => {
  let root: string;
  let lockDir: string;

  beforeEach(() => {
    root = tempRoot();
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runner-lock-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  test('returns a runner with a stop() method', () => {
    const runner = startCuratorRunner({
      rootDir: root,
      lockDir,
      intervalMs: 60_000,
    });
    expect(typeof runner.stop).toBe('function');
    runner.stop();
  });

  test('stop() is idempotent', () => {
    const runner = startCuratorRunner({
      rootDir: root,
      lockDir,
      intervalMs: 60_000,
    });
    runner.stop();
    expect(() => runner.stop()).not.toThrow();
  });

  test('fires a cycle and calls onCycleComplete with empty errors for healthy tree', async () => {
    // Seed a skill so the runner has something to walk.
    const anchor = Buffer.from('C').toString('hex');
    recordSuccessfulRun(
      {
        txn_id: 'txn-r-0',
        contract_id: 'C',
        intent: 'test runner',
        domain: 'runner.test',
        graph_node_anchor: anchor,
      },
      { rootDir: root, now: () => FIXED_NOW },
    );

    const errors = await new Promise<string[]>((resolve) => {
      const runner = startCuratorRunner({
        rootDir: root,
        lockDir,
        intervalMs: 20, // fire quickly in test
        now: () => FIXED_NOW,
        onCycleComplete: (errs) => {
          runner.stop();
          resolve(errs);
        },
      });
    });

    expect(errors).toHaveLength(0);
  }, 5_000);

  test('cycle skips gracefully when another process holds the lock', async () => {
    // Plant a lock file with an arbitrary PID.
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'lock'),
      JSON.stringify({ pid: 99999, start_ts: Date.now() }),
    );

    // The runner should fire, fail to acquire (isAlive always true, TTL
    // very long so mtime reclaim doesn't fire), and still call
    // onCycleComplete with empty errors.
    const errors = await new Promise<string[]>((resolve) => {
      const runner = startCuratorRunner({
        rootDir: root,
        lockDir,
        intervalMs: 20,
        lockOptions: { isAlive: () => true, ttlMs: 24 * 60 * 60 * 1_000 },
        onCycleComplete: (errs) => {
          runner.stop();
          resolve(errs);
        },
      });
    });

    expect(errors).toHaveLength(0);
  }, 10_000);
});
