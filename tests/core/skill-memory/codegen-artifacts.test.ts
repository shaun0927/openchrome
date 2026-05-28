/**
 * Tests for the codegen artifact pointers on SkillMemoryStore (#1430 Part 1).
 *
 * Covers:
 *   - v3 records round-trip with codegenArtifacts populated;
 *   - v1 and v2 on-disk records load cleanly and normalise codegenArtifacts
 *     to `[]` in memory (back-compatibility migration);
 *   - records with no pointers preserve an empty array so writes always
 *     produce v3.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SKILL_MEMORY_SCHEMA_VERSION,
  SkillMemoryStore,
  type CodegenArtifactPointer,
  type SkillRecord,
} from '../../../src/core/skill-memory';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-codegen-'));
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

describe('SkillMemoryStore — codegen artifact pointers (#1430)', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists codegenArtifacts on record and reloads them from disk', async () => {
    const artifacts: CodegenArtifactPointer[] = [
      { kind: 'playwright', path: 'sess-1/skill.spec.ts', created_at: 1700000000 },
      { kind: 'mcp-replay', path: 'sess-1/skill.jsonl', created_at: 1700000001 },
    ];

    const recorded = await store.record({
      ...baseInput(),
      codegenArtifacts: artifacts,
    });
    expect(recorded.skill_id).toMatch(/^[a-f0-9]{16}$/);

    // Reload from disk via a fresh instance to confirm round-trip.
    const reloaded = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const fetched = reloaded.get(recorded.skill_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.codegenArtifacts).toEqual(artifacts);
  });

  it('writes a v3 schema_version on disk', async () => {
    await store.record(baseInput());
    // Find the skills.json file produced by the store (encoded domain).
    const dirs = fs.readdirSync(root);
    expect(dirs.length).toBeGreaterThan(0);
    const file = path.join(root, dirs[0], 'skills.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.schema_version).toBe(SKILL_MEMORY_SCHEMA_VERSION);
    expect(parsed.schema_version).toBe(3);
  });

  it('reads v1 on-disk records and normalises codegenArtifacts to []', async () => {
    // Write a v1 record first by going through the store at a clean root.
    // We seed by writing a synthetic v1 JSON to the exact path the store
    // will read. To discover the encoded-domain dir name, do a no-op write
    // first then overwrite with v1 content.
    await store.record(baseInput({ name: 'seed-to-discover-path' }));
    const dirs = fs.readdirSync(root);
    const dir = path.join(root, dirs[0]);
    const skillId = 'a'.repeat(16);
    const v1 = {
      schema_version: 1,
      skills: {
        [skillId]: {
          skillId,
          domain: 'amazon.com',
          name: 'legacy-skill',
          steps: [{ kind: 'click' }],
          contractId: 'contract-1',
          successCount: 0,
          lastUsedAt: 0,
          frozenSnapshotPath: null,
        },
      },
    };
    fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify(v1));

    const loaded = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const fetched = loaded.get(skillId);
    expect(fetched).not.toBeNull();
    expect(fetched!.codegenArtifacts).toEqual([]);
  });

  it('reads v2 on-disk records and normalises codegenArtifacts to []', async () => {
    await store.record(baseInput({ name: 'seed-to-discover-path' }));
    const dirs = fs.readdirSync(root);
    const dir = path.join(root, dirs[0]);
    const skillId = 'b'.repeat(16);
    const v2 = {
      schema_version: 2,
      skills: {
        [skillId]: {
          skillId,
          domain: 'amazon.com',
          name: 'v2-skill',
          steps: [{ kind: 'click', replay_artifact: null }],
          contractId: 'contract-1',
          successCount: 0,
          lastUsedAt: 0,
          frozenSnapshotPath: null,
        },
      },
    };
    fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify(v2));

    const loaded = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const fetched = loaded.get(skillId);
    expect(fetched).not.toBeNull();
    expect(fetched!.codegenArtifacts).toEqual([]);
  });

  it('preserves an empty codegenArtifacts array on records with no pointers', async () => {
    const recorded = await store.record({ ...baseInput(), codegenArtifacts: [] });
    const reloaded = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const fetched = reloaded.get(recorded.skill_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.codegenArtifacts).toEqual([]);
  });
});
