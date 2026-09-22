import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildShadowLearningEvent, exportLearningDataset, splitLearningDataset, evaluateLearningPredictions, sha256,
  promoteAdapter, writeAdapterRegistry, choicesForLearningTask, combineAssistDecision } from '../../../src/pilot/learning';
import { runLearningAction } from '../../../src/pilot/learning/cli';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-learning-pipeline-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test('export excludes invalid, unlabeled, sensitive and heuristic records by default', async () => {
  const base = buildShadowLearningEvent({ question: { id: 'private', instructions: '', choices: [], state: { retries: 1 } },
    task: 'irreversible_policy', deterministicAnswer: 'blocked', finalAnswer: 'blocked' });
  const labeled = { ...base, label: { answer: 'blocked', source: 'host', created_at: base.created_at } };
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, [base, labeled, { ...labeled, privacy: { redacted: false } },
    { ...labeled, choices: ['forged'], label: { ...labeled.label, answer: 'forged' } },
    { ...labeled, privacy: { redacted: true, contains_sensitive: true } },
    { ...labeled, state: { rawDOM: 'secret' } }, { ...labeled, label: { ...labeled.label, source: 'heuristic' } }].map((row) => JSON.stringify(row)).join('\n') + '\nbad json\n');
  const result = await exportLearningDataset({ inputPath: file, outDir: dir, task: 'irreversible_policy', holdoutRatio: 0.2 });
  expect(result.report).toMatchObject({ total_events: 8, labeled_examples: 1, skipped_unlabeled: 1, skipped_invalid_choice: 1, skipped_sensitive: 2, skipped_label_source: 1, skipped_invalid_record: 2 });
});

test('same state stays on the same split despite different event IDs and labels', () => {
  const base = { id: 'a', task: 'irreversible_policy' as const, state: { retries: 1 }, choices: choicesForLearningTask('irreversible_policy'), label: 'allow', label_source: 'host' as const, deterministic_answer: 'blocked', model_answer: null };
  const examples = [base, { ...base, id: 'b', label: 'blocked' }];
  const a = splitLearningDataset({ examples, holdoutRatio: 0.5 });
  const b = splitLearningDataset({ examples: [...examples].reverse(), holdoutRatio: 0.5 });
  expect(a.train.length).toBe(b.train.length);
  expect([0, 2]).toContain(a.train.length);
});

async function evaluationFixture() {
  const task = 'irreversible_policy';
  const choices = choicesForLearningTask(task);
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), task, state: { retries: i }, choices, label: choices[i % choices.length], label_source: 'host', deterministic_answer: 'blocked' }));
  const datasetPath = path.join(dir, 'holdout.jsonl');
  const predictionsPath = path.join(dir, 'predictions.json');
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const artifactSha256 = 'a'.repeat(64);
  await fs.writeFile(datasetPath, text);
  await fs.writeFile(predictionsPath, JSON.stringify({ adapter_id: 'adapter', artifact_sha256: artifactSha256, dataset_sha256: sha256(text), answers: rows.map((row) => ({ id: row.id, answer: row.label, confidence: 0.99 })) }));
  return { datasetPath, predictionsPath, adapterId: 'adapter', artifactSha256 };
}

test('eval scores predictions and promotion recomputes evidence bound to adapter and dataset', async () => {
  const input = await evaluationFixture();
  const report = await evaluateLearningPredictions(input);
  expect(report).toMatchObject({ ok_to_promote: true, accuracy: 1, examples: 50 });
  const registryPath = path.join(dir, 'registry.json');
  const evalReportPath = path.join(dir, 'report.json');
  await writeAdapterRegistry(registryPath, { schema_version: 1, adapters: [{ id: 'adapter', task: 'irreversible_policy', base_model: 'laya', status: 'candidate', artifact_sha256: input.artifactSha256, created_at: new Date().toISOString(), metrics: { accuracy: 0, highConfidencePrecision: 0, abstainRate: 0 } }] });
  const promotion = { registryPath, evalReportPath, adapterId: 'adapter', status: 'assist' as const, datasetPath: input.datasetPath, predictionsPath: input.predictionsPath };
  await fs.writeFile(evalReportPath, JSON.stringify({ ok_to_promote: true, verdict: 'pass' }));
  await expect(promoteAdapter(promotion)).rejects.toThrow('mismatch');
  await fs.writeFile(evalReportPath, JSON.stringify(report));
  expect((await promoteAdapter(promotion)).adapters[0].status).toBe('assist');
  await fs.appendFile(input.datasetPath, '\n');
  await expect(promoteAdapter(promotion)).rejects.toThrow('manifest');
});

test('CLI refuses empty evaluation evidence and finetune remains explicit scaffold', async () => {
  await expect(runLearningAction('eval', { dataset: path.join(dir, 'missing') })).rejects.toThrow('predictions');
  await expect(runLearningAction('export', { task: 'typo' })).rejects.toThrow('task');
  expect(await runLearningAction('finetune', { outDir: dir })).toMatchObject({ status: 'blocked_scaffold' });
});

test('model-only allow and nonfinite confidence cannot weaken policy', () => {
  expect(combineAssistDecision({ task: 'irreversible_policy', deterministicAnswer: 'blocked', modelAnswer: { provider: 'local', answer: 'allow', confidence: 1, abstain: false } })).toBe('blocked');
  expect(combineAssistDecision({ task: 'irreversible_policy', deterministicAnswer: 'allow', modelAnswer: { provider: 'local', answer: 'blocked', confidence: NaN, abstain: false } })).toBe('allow');
});
