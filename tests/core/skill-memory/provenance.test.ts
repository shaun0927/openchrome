/**
 * Tests for explicit skill provenance on SkillMemoryStore (#1457 PR-4).
 *
 * Covers:
 *   - a record written without provenance defaults to source `unknown` with a
 *     contractRef mirrored from contractId;
 *   - caller-supplied provenance (e.g. a host write) round-trips through disk;
 *   - the first-record timestamp is preserved across idempotent re-records,
 *     even when the re-record supplies a different recordedAt;
 *   - a curator `verified: true` write round-trips through disk without the
 *     core store altering it (P4/P7 — core never sets/clears verified);
 *   - a legacy record persisted without provenance reads back with the field
 *     absent (consumers treat absence as `source: 'unknown'`).
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

  it('round-trips a curator verified:true write through disk without core downgrading it', async () => {
    const { skill_id } = await store.record(
      baseInput({
        provenance: { source: 'curator', recordedAt: 1700000000001, contractRef: 'contract-1', verified: true },
      }),
    );
    const reopened = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const rec = reopened.get(skill_id);
    // The core store records what the writer claimed; it neither sets nor clears
    // `verified` on its own (P4/P7) — a verified extractor write survives intact.
    expect(rec?.provenance?.source).toBe('curator');
    expect(rec?.provenance?.verified).toBe(true);
  });

  it('reads a legacy record (persisted without provenance) back with provenance absent', async () => {
    // Persist a record, then rewrite skills.json as a pre-provenance v2 file
    // with the field stripped, to mimic data written before #1457 PR-4.
    const { skill_id } = await store.record(baseInput());
    const skillsJson = findSkillsJson(root);
    const file = JSON.parse(fs.readFileSync(skillsJson, 'utf8')) as {
      schema_version: number;
      skills: Record<string, Record<string, unknown>>;
    };
    for (const rec of Object.values(file.skills)) {
      delete rec.provenance;
      delete rec.codegenArtifacts;
    }
    file.schema_version = 2; // pre-provenance, pre-codegen on-disk shape
    fs.writeFileSync(skillsJson, JSON.stringify(file), 'utf8');

    const reopened = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    // Documented contract: absent provenance reads back as undefined and
    // consumers treat it as `source: 'unknown'`.
    expect(reopened.get(skill_id)?.provenance).toBeUndefined();
  });
});

/** Locate the single per-domain skills.json under a freshly-created root. */
function findSkillsJson(rootDir: string): string {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'skills.json') return full;
    }
  }
  throw new Error(`skills.json not found under ${rootDir}`);
}
