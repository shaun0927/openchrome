import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runWithContract } from '../../../src/pilot/runtime';
import { resetBeforeIrreversibleHookForTests } from '../../../src/pilot/runtime/before-irreversible';
import { resetFlagsCache } from '../../../src/harness/flags';
import { readLearningEventsFromJsonl } from '../../../src/pilot/learning';
import type { EvalContext } from '../../../src/contracts/eval-context';

function ctx(bodyText: string): EvalContext {
  return {
    url: async () => 'https://example.test/',
    domText: async () => bodyText,
    domCount: async () => 0,
    networkSince: async () => [],
    screenshotPng: async () => null,
    hasOpenDialog: async () => false,
  };
}

async function waitForEvents(file: string, count: number): Promise<unknown[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await readLearningEventsFromJsonl(file);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readLearningEventsFromJsonl(file);
}

describe('learning runtime integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = ['node', 'cli/index.js', '--pilot'];
    resetFlagsCache();
    resetBeforeIrreversibleHookForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetFlagsCache();
    resetBeforeIrreversibleHookForTests();
  });

  it('writes opt-in irreversible and outcome events from the contract runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchrome-learning-runtime-contract-'));
    const store = path.join(dir, 'events.jsonl');
    process.env.OPENCHROME_LEARNING = '1';
    process.env.OPENCHROME_LEARNING_STORE = store;
    process.env.OPENCHROME_LEARNING_TASKS = 'irreversible_policy,outcome_failure_triage';

    const record = await runWithContract({
      contract: {
        id: 'contract.submit',
        action: 'submit-checkout',
        critical: true,
        post: { kind: 'dom_text', contains: 'Order Placed' },
      },
      skill: async () => 'clicked',
      snapshot: async () => ctx('Still pending'),
    });
    const events = await waitForEvents(store, 2);

    expect(record.verdict).toBe('postcondition_violation');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ task: 'irreversible_policy', final_answer: 'allow' }),
      expect.objectContaining({ task: 'outcome_failure_triage', final_answer: 'silent_click' }),
    ]));
  });

  it('does not create learning data when runtime learning is disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchrome-learning-runtime-disabled-'));
    const store = path.join(dir, 'events.jsonl');
    process.env.OPENCHROME_LEARNING_STORE = store;

    await runWithContract({
      contract: {
        id: 'contract.disabled',
        action: 'submit-disabled',
        critical: true,
        post: { kind: 'dom_text', contains: 'Done' },
      },
      skill: async () => 'clicked',
      snapshot: async () => ctx('Still pending'),
    });

    await expect(fs.readFile(store, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
