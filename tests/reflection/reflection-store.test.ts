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
