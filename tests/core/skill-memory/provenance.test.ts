/**
 * Tests for explicit skill provenance on SkillMemoryStore (#1457 PR-4).
 *
 * Covers:
 *   - a record written without provenance defaults to source `unknown` with a
 *     contractRef mirrored from contractId;
 *   - caller-supplied provenance (e.g. a host write) round-trips through disk;
 *   - the first-record timestamp is preserved across idempotent re-records,
 *     even when the re-record supplies a different recordedAt.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillMemoryStore, type SkillRecord } from '../../../src/core/skill-memory';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-provenance-'));
}

function baseInput(overrides: Partial<SkillRecord> = {}) {
  return {
    domain: 'amazon.com',
    name: 'add-to-cart',
    steps: [{ kind: 'click', selector: '#buy-now' }],
    contractId: 'contract-1',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null as string | null,
    ...overrides,
  };
}

describe('SkillMemoryStore — explicit provenance (#1457 PR-4)', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults provenance to source=unknown with a mirrored contractRef when none supplied', async () => {
    const { skill_id } = await store.record(baseInput());
    const rec = store.get(skill_id);
    expect(rec?.provenance?.source).toBe('unknown');
    expect(rec?.provenance?.contractRef).toBe('contract-1');
    expect(typeof rec?.provenance?.recordedAt).toBe('number');
  });

  it('round-trips caller-supplied host provenance through disk', async () => {
    const { skill_id } = await store.record(
      baseInput({
        provenance: { source: 'host', recordedAt: 1700000000000, contractRef: 'contract-1', verified: false },
      }),
    );
    // Re-open from disk to prove persistence (not just the in-memory return).
    const reopened = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const rec = reopened.get(skill_id);
    expect(rec?.provenance).toEqual({
      source: 'host',
      recordedAt: 1700000000000,
      contractRef: 'contract-1',
      verified: false,
    });
  });

  it('preserves the first-record timestamp across idempotent re-records', async () => {
    await store.record(
      baseInput({ provenance: { source: 'host', recordedAt: 111, verified: false } }),
    );
    // Same (domain, name) → idempotent re-record with a different recordedAt.
    const { skill_id } = await store.record(
      baseInput({
        steps: [{ kind: 'click', selector: '#buy-now-v2' }],
        provenance: { source: 'host', recordedAt: 999, verified: false },
      }),
    );
    expect(store.get(skill_id)?.provenance?.recordedAt).toBe(111);
  });
});
