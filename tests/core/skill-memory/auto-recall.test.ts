/**
 * Tests for autoRecallForOrigin (#824).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { autoRecallForOrigin } from '../../../src/core/skill-memory/auto-recall';
import { SkillMemoryStore } from '../../../src/core/skill-memory';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auto-recall-'));
}

async function writeSkill(
  rootDir: string,
  domain: string,
  name: string,
  steps: unknown,
): Promise<void> {
  const store = new SkillMemoryStore({ rootDir, domain });
  await store.record({
    domain,
    name,
    steps,
    contractId: 'test-contract',
    successCount: 0,
    lastUsedAt: Date.now(),
    frozenSnapshotPath: null,
  });
}

describe('autoRecallForOrigin', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = tempRoot();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('empty domain returns empty payload', async () => {
    const result = await autoRecallForOrigin({ origin: 'unknown.example.com', rootDir });
    expect(result).toEqual({ skills: [], truncated: false, total_bytes: 0 });
  });

  test('single skill under all caps is returned verbatim', async () => {
    await writeSkill(rootDir, 'amazon.com', 'add-to-cart', [{ kind: 'click', selector: '#buy' }]);

    const result = await autoRecallForOrigin({ origin: 'amazon.com', rootDir });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('add-to-cart');
    expect(result.skills[0].domain).toBe('amazon.com');
    expect(result.skills[0].truncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.total_bytes).toBeGreaterThan(0);
  });

  test('oversized body is truncated and skill.truncated is true', async () => {
    // Create a steps payload whose JSON serialization will exceed 2048 bytes.
    const bigSteps = Array.from({ length: 200 }, (_, i) => ({ kind: 'click', selector: `#element-${i}` }));
    await writeSkill(rootDir, 'big.com', 'fat-skill', bigSteps);

    const result = await autoRecallForOrigin({
      origin: 'big.com',
      rootDir,
      maxBodyBytes: 100,
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].truncated).toBe(true);
    expect(result.truncated).toBe(true);
    // Body should be no longer than 100 bytes and remain parseable JSON.
    expect(Buffer.byteLength(result.skills[0].body, 'utf8')).toBeLessThanOrEqual(100);
    const parsed = JSON.parse(result.skills[0].body) as { truncated?: boolean; steps?: unknown[] };
    expect(parsed.truncated).toBe(true);
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  test('oversized single-step bodies stay valid JSON instead of clipped prefixes', async () => {
    await writeSkill(rootDir, 'huge-step.com', 'single-huge', [{ kind: 'note', text: 'x'.repeat(5000) }]);

    const result = await autoRecallForOrigin({
      origin: 'huge-step.com',
      rootDir,
      maxBodyBytes: 128,
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].truncated).toBe(true);
    expect(Buffer.byteLength(result.skills[0].body, 'utf8')).toBeLessThanOrEqual(128);
    expect(() => JSON.parse(result.skills[0].body)).not.toThrow();
  });

  test('UTF-8 truncation never exceeds maxBodyBytes for multibyte input', async () => {
    await writeSkill(rootDir, 'utf8.com', 'emoji-skill', [{ note: '😀'.repeat(50) }]);

    const result = await autoRecallForOrigin({
      origin: 'utf8.com',
      rootDir,
      maxBodyBytes: 101,
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].truncated).toBe(true);
    expect(Buffer.byteLength(result.skills[0].body, 'utf8')).toBeLessThanOrEqual(101);
    expect(result.skills[0].body).not.toContain('�');
  });

  test('more than 3 skills clips the list and sets payload.truncated', async () => {
    for (let i = 0; i < 5; i++) {
      await writeSkill(rootDir, 'many.com', `skill-${i}`, [{ step: i }]);
    }

    const result = await autoRecallForOrigin({ origin: 'many.com', rootDir, limit: 3 });

    expect(result.skills).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test('total_bytes ceiling clips skills and sets payload.truncated', async () => {
    // Two skills with 60-byte bodies each; total ceiling is 80 bytes.
    const steps = [{ kind: 'click', selector: '#a' }];
    await writeSkill(rootDir, 'ceil.com', 'skill-a', steps);
    await writeSkill(rootDir, 'ceil.com', 'skill-b', steps);

    // Determine the real body size for one skill.
    const singleResult = await autoRecallForOrigin({ origin: 'ceil.com', rootDir, limit: 1 });
    const singleBytes = singleResult.total_bytes;

    // Set total ceiling to just under 2x so the second skill is excluded.
    const result = await autoRecallForOrigin({
      origin: 'ceil.com',
      rootDir,
      maxTotalBytes: singleBytes + 1,
    });

    expect(result.skills).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test('invalid origin returns empty payload without throwing', async () => {
    // Empty string is an invalid domain for the store.
    const result = await autoRecallForOrigin({ origin: '', rootDir });
    expect(result).toEqual({ skills: [], truncated: false, total_bytes: 0 });
  });
});
