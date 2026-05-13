import type { SkillRecord } from '../../src/core/skill-memory';
import { buildRecallText, rankSkillsForTask } from '../../src/tools/oc-skill-recall';

const DOMAIN = 'ranking.test';

describe('rankSkillsForTask (#1009)', () => {
  test('ranks task-similar skills above unrelated skills with reasons', () => {
    const ranked = rankSkillsForTask(
      [
        skill('settings', [
          { tool: 'interact', args: { description: 'open settings panel' } },
        ]),
        skill(
          'contact form',
          [
            { tool: 'form_input', args: { label: 'email' } },
            { tool: 'interact', args: { description: 'submit contact form' } },
          ],
          { successCount: 2 },
        ),
      ],
      { task: 'submit the contact form and verify success' },
    );

    expect(ranked[0].name).toBe('contact form');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score || 0);
    expect(ranked[0].reason).toContain('task-token matches');
    expect(ranked[0].stepsPreview).toBeDefined();
  });

  test('redacts sensitive values from ranked step previews and scoring text', () => {
    const ranked = rankSkillsForTask(
      [
        skill('login', [
          {
            tool: 'form_input',
            args: { password: 'super-secret-fixture-password', token: 'abc' },
          },
        ]),
      ],
      { task: 'login form' },
    );

    const text = JSON.stringify(ranked[0].stepsPreview);
    expect(text).not.toContain('super-secret-fixture-password');
    expect(text).not.toContain('abc');
    expect(text).toContain('[REDACTED]');
    expect(buildRecallText(ranked[0])).not.toContain('super-secret-fixture-password');
    expect(buildRecallText(ranked[0])).not.toContain('abc');
  });

  test('replay and success break otherwise similar task matches deterministically', () => {
    const ranked = rankSkillsForTask(
      [
        skill('checkout flow a', [{ tool: 'click', args: { label: 'checkout' } }], {
          lastReplayPassedAt: 200,
          successCount: 1,
        }),
        skill('checkout flow b', [{ tool: 'click', args: { label: 'checkout' } }], {
          lastReplayFailedAt: 300,
          successCount: 10,
        }),
      ],
      { task: 'checkout flow' },
    );

    expect(ranked[0].name).toBe('checkout flow a');
    expect(ranked[0].replaySignal).toBe(1);
  });

  test('contract match contributes deterministic score when provided', () => {
    const ranked = rankSkillsForTask(
      [
        skill('same contract', [], { contractId: 'contract-a' }),
        skill('other contract', [], { contractId: 'contract-b' }),
      ],
      { contractId: 'contract-a' },
    );

    expect(ranked[0].name).toBe('same contract');
    expect(ranked[0].reason).toContain('contract_id=contract-a');
  });
});

function skill(
  name: string,
  steps: unknown[],
  overrides: Partial<SkillRecord> = {},
): SkillRecord {
  return {
    skillId: `${name.replace(/\W+/g, '').padEnd(16, 'x').slice(0, 16)}`,
    domain: DOMAIN,
    name,
    steps,
    contractId: 'noop',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  } as SkillRecord;
}
