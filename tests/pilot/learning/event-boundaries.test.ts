import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildShadowLearningEvent, JsonlLearningEventStore, recordIrreversiblePolicyLearning, resolveLearningSettings } from '../../../src/pilot/learning';
import { MemoryLearningEventStore } from '../../../src/pilot/learning';
import { createHostDecisionProvider, createNoopDecisionProvider, decideWithBudget, OutboundDecisionBudget } from '../../../src/pilot/decider';

test('shadow runner requires consent and preserves deterministic final evidence', async () => {
  const store = new MemoryLearningEventStore();
  for (const enabled of [false, true]) {
    const result = await decideWithBudget({ id: 'private', state: {}, instructions: '', choices: [{ id: 'allow', label: 'Allow' }] }, {
      primary: createHostDecisionProvider(async () => ({ answer: 'allow', confidence: 1, abstain: false })),
      fallback: createNoopDecisionProvider(), budget: new OutboundDecisionBudget(1),
      shadowLearning: { task: 'irreversible_policy', deterministicAnswer: 'blocked', store, config: { enabled } },
    });
    expect(result.answer).toBe('allow');
    expect(store.events).toHaveLength(enabled ? 1 : 0);
  }
  expect(store.events[0].final_answer).toBe('blocked');
});

test('invalid mode and task allowlists fail closed', () => {
  expect(resolveLearningSettings({ env: { OPENCHROME_LEARNING: '1', OPENCHROME_LEARNING_MODE: 'remote' } }).enabled).toBe(false);
  expect(resolveLearningSettings({ enabled: true, tasks: [] }).tasks).toEqual([]);
  expect(resolveLearningSettings({ enabled: true, tasks: ['misspelled'] }).tasks).toEqual([]);
});

test('all persistence paths omit browser payloads and arbitrary strings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-safe-learning-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const event = buildShadowLearningEvent({ task: 'irreversible_policy', deterministicAnswer: 'blocked', finalAnswer: 'blocked',
      question: { id: 'secret-question', instructions: '', choices: [], state: {
        password: 'secret-password', DOM: '<input value="secret-value">', screenshotPng: 'secret-pixels',
        verdict: 'secret-verdict', retries: 1, pre_evidence: { passed: true, details: 'secret-details' },
      } }, actualResult: 'secret-result' });
    await new JsonlLearningEventStore(file).append(event);
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('secret-');
    expect(JSON.parse(text).state).toEqual({ verdict: '[redacted]', retries: 1, pre_evidence: { passed: true } });
    await expect(new JsonlLearningEventStore(file).append({ ...event, privacy: { redacted: false, contains_sensitive: true } })).rejects.toThrow('unredacted');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('disabled recording creates no directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-disabled-learning-'));
  try {
    const file = path.join(dir, 'absent', 'events.jsonl');
    expect(await recordIrreversiblePolicyLearning({ contractId: 'private', action: 'private', decision: { proceed: true }, config: { enabled: false, storePath: file } })).toBe(false);
    await expect(fs.access(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
