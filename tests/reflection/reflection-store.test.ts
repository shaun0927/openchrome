import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReflectionStore } from '../../src/reflection';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-store-'));
}

describe('ReflectionStore', () => {
  let dir: string;
  let store: ReflectionStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new ReflectionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates and gets a structured reflection artifact', async () => {
    const artifact = await store.create({
      scope: { domain: 'example.com', taskFingerprint: 'checkout', contractId: 'contract-1' },
      trigger: 'contract_failed',
      evidence: { lastTools: ['navigate', 'oc_assert'], failedAssertions: ['missing total'] },
      diagnosis: 'Total was not visible after checkout.',
      nextPlan: ['read page', 'assert total'],
      avoid: ['do not repeat checkout click'],
      confidence: 0.8,
    });

    expect(artifact.id).toMatch(/^refl-/);
    expect(artifact.trigger).toBe('contract_failed');
    expect(artifact.confidence).toBe(0.8);

    const loaded = await store.get(artifact.id);
    expect(loaded).toMatchObject({ id: artifact.id, trigger: 'contract_failed' });
  });

  it('lists by scope newest first and ignores corrupt files', async () => {
    const first = await store.create({
      scope: { domain: 'example.com', taskFingerprint: 'task-a' },
      trigger: 'stuck',
      evidence: { lastTools: ['read_page'] },
    });
    const second = await store.create({
      scope: { domain: 'example.com', taskFingerprint: 'task-a' },
      trigger: 'timeout',
      evidence: { lastTools: ['wait_for'] },
    });
    await store.create({
      scope: { domain: 'other.com', taskFingerprint: 'task-a' },
      trigger: 'stuck',
      evidence: { lastTools: ['read_page'] },
    });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not json');

    const listed = store.list({ domain: 'example.com', taskFingerprint: 'task-a' });
    expect(listed.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('redacts sensitive text and clamps confidence', async () => {
    const artifact = await store.create({
      scope: { domain: 'example.com', taskFingerprint: 'task-token=abc123' },
      trigger: 'plan_failed',
      evidence: { lastTools: ['execute_plan'], failedAssertions: ['password=hunter2 Bearer abc123'] },
      diagnosis: 'token=secret password=hunter2 Bearer abc123',
      confidence: 7,
    });

    expect(artifact.confidence).toBe(1);
    expect(JSON.stringify(artifact)).not.toContain('hunter2');
    expect(JSON.stringify(artifact)).not.toContain('Bearer abc123');
    expect(JSON.stringify(artifact)).toContain('[REDACTED]');
  });

  it('returns deterministic validation errors for invalid input', async () => {
    await expect(store.create({
      scope: { taskFingerprint: '' },
      trigger: 'stuck',
      evidence: { lastTools: [] },
    })).rejects.toThrow('scope.taskFingerprint is required');

    await expect(store.create({
      scope: { taskFingerprint: 'x' },
      trigger: 'bad' as any,
      evidence: { lastTools: [] },
    })).rejects.toThrow('invalid trigger');
  });
});

describe('ReflectionStore bounded recall and validation', () => {
  let dir: string;
  let store: ReflectionStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new ReflectionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recalls at most three reflections by confidence then recency and excludes expired records', async () => {
    await store.create({ scope: { domain: 'example.com', taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['a'] }, confidence: 0.4 });
    const high = await store.create({ scope: { domain: 'example.com', taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['b'] }, confidence: 0.9 });
    const mid = await store.create({ scope: { domain: 'example.com', taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['c'] }, confidence: 0.7 });
    const low = await store.create({ scope: { domain: 'example.com', taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['d'] }, confidence: 0.6 });
    await store.create({ scope: { domain: 'example.com', taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['expired'] }, confidence: 1, expiresAt: Date.now() - 1 });

    expect(store.list({ domain: 'example.com', taskFingerprint: 'task' }).map((item) => item.id)).toEqual([high.id, mid.id, low.id]);
  });

  it('updates confidence asymmetrically and prunes below threshold', async () => {
    const artifact = await store.create({ scope: { taskFingerprint: 'task' }, trigger: 'stuck', evidence: { lastTools: ['read_page'] }, confidence: 0.3 });
    const boosted = await store.validate(artifact.id, true);
    expect(boosted?.confidence).toBeCloseTo(0.4);

    const penalized = await store.validate(artifact.id, false);
    expect(penalized?.confidence).toBeCloseTo(0.2);

    const pruned = await store.validate(artifact.id, false);
    expect(pruned).toBeNull();
    expect(await store.get(artifact.id)).toBeNull();
  });
});
