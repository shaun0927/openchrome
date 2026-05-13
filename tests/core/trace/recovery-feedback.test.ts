/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RecoveryFeedbackWriter, mapHintRuleToRecoveryCategory } from '../../../src/core/trace/recovery-feedback';

describe('RecoveryFeedbackWriter', () => {
  test('persists a bounded redacted JSONL bundle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-feedback-'));
    const writer = new RecoveryFeedbackWriter({ dirPath: dir, now: () => Date.parse('2026-05-13T00:00:00Z'), idFactory: () => 'bundle-1' });

    const bundle = writer.append({
      sessionId: 's1',
      trigger: {
        tool: 'navigate',
        category: 'blocked_page',
        errorFingerprint: 'Access denied with super-secret-fixture-password and 123456-mfa-fixture',
        resultExcerpt: 'Access denied password super-secret-fixture-password token abc',
      },
      context: { recentTools: ['navigate'], nonProgressCalls: 0 },
      hints: [{ rule: 'access-denied-detected', severity: 'info', rawHint: 'Access denied. password super-secret-fixture-password' }],
      outcome: { finalStatus: 'escalated' },
    });

    expect(bundle?.id).toBe('bundle-1');
    const file = path.join(dir, '2026-05-13.jsonl');
    const line = fs.readFileSync(file, 'utf8').trim();
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32 * 1024);
    expect(line).not.toContain('super-secret-fixture-password');
    expect(line).not.toContain('123456-mfa-fixture');
    const parsed = JSON.parse(line);
    expect(parsed.trigger.category).toBe('blocked_page');
    expect(parsed.outcome.feedback).toContain('blocked_page');
  });

  test('maps high-signal hint rules to recovery categories', () => {
    expect(mapHintRuleToRecoveryCategory('progress-tracker-stuck')).toBe('non_progress');
    expect(mapHintRuleToRecoveryCategory('captcha-detected')).toBe('blocked_page');
    expect(mapHintRuleToRecoveryCategory('error-recovery', 'stale ref')).toBe('stale_ref');
  });
});
