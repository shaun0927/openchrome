import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RecoveryPolicyLearner, rankRecoveryCandidates } from '../../src/recovery';

describe('RecoveryPolicyLearner', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-policy-'));
    filePath = path.join(dir, 'policies.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('promotes repeated evidence-backed recoveries and persists them', () => {
    const learner = new RecoveryPolicyLearner({ filePath, minAttempts: 3, minConfidence: 0.67 });
    for (let i = 0; i < 3; i++) {
      learner.record({
        failureFingerprint: 'stale-ref',
        domain: 'https://example.com/path',
        triggerTool: 'interact',
        recoveryTool: 'read_page',
        safetyClass: 'read_only',
        evidenceBacked: true,
        succeeded: true,
      });
    }

    const reloaded = new RecoveryPolicyLearner({ filePath, minAttempts: 3, minConfidence: 0.67 });
    const policies = reloaded.getPolicies({ failureFingerprint: 'stale-ref', domain: 'example.com' });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ recoveryTool: 'read_page', promoted: true, confidence: 1 });
  });

  it('does not promote ambiguous outcomes and downgrades confidence on failures', () => {
    const learner = new RecoveryPolicyLearner({ filePath, minAttempts: 2, minConfidence: 0.75 });
    expect(learner.record({
      failureFingerprint: 'stale-ref',
      triggerTool: 'interact',
      recoveryTool: 'read_page',
      safetyClass: 'read_only',
      evidenceBacked: false,
      succeeded: true,
    })).toBeNull();

    learner.record({ failureFingerprint: 'stale-ref', triggerTool: 'interact', recoveryTool: 'read_page', safetyClass: 'read_only', evidenceBacked: true, succeeded: true });
    learner.record({ failureFingerprint: 'stale-ref', triggerTool: 'interact', recoveryTool: 'read_page', safetyClass: 'read_only', evidenceBacked: true, succeeded: false });

    expect(learner.getPolicies({ failureFingerprint: 'stale-ref' })).toHaveLength(0);
  });

  it('biases ranking without bypassing safety gates', () => {
    const learner = new RecoveryPolicyLearner({ filePath, minAttempts: 1, minConfidence: 0.5 });
    learner.record({ failureFingerprint: 'timeout', triggerTool: 'navigate', recoveryTool: 'tabs_context', safetyClass: 'read_only', evidenceBacked: true, succeeded: true });
    const policies = learner.getPolicies({ failureFingerprint: 'timeout', triggerTool: 'navigate' });

    const candidates = rankRecoveryCandidates({
      toolName: 'navigate',
      resultText: 'Navigation timeout',
      isError: true,
      recentCalls: [{ toolName: 'navigate', result: 'error', error: 'Navigation timeout' }],
      policies,
    });

    expect(candidates[0].tool).toBe('tabs_context');
    expect(candidates[0].risk).toBe('read_only');
    expect(candidates.every((candidate) => !candidate.blockedReason || candidate.risk !== 'read_only')).toBe(true);
  });
});
