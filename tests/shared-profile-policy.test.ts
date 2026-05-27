import {
  assertSharedProfileAllowed,
  canAccessLeaseDiagnostic,
  getSharedProfilePolicy,
  redactLeaseDiagnostic,
} from '../src/security/shared-profile-policy';
import type { TargetLeaseRecord } from '../src/session/target-lease-registry';

const lease: TargetLeaseRecord = {
  targetId: 't1',
  sessionId: 's1',
  clientId: 'c1',
  workerId: 'w1',
  createdAt: 1,
  lastActivityAt: 2,
  cleanupPolicy: 'close-on-session-end',
};

describe('shared profile policy', () => {
  test('defaults to same-trust-zone with redacted diagnostics', () => {
    const policy = getSharedProfilePolicy({});
    expect(policy).toMatchObject({ trustMode: 'same-trust-zone', redactUrls: true, redactTitles: true });
    expect(() => assertSharedProfileAllowed(policy)).not.toThrow();
  });

  test('rejects shared profile when untrusted mode is declared', () => {
    const policy = getSharedProfilePolicy({ OPENCHROME_SHARED_PROFILE_UNTRUSTED: '1' });
    expect(policy.trustMode).toBe('isolated-required');
    expect(() => assertSharedProfileAllowed(policy)).toThrow('same-trust-zone only');
  });

  test('limits lease diagnostics to same session/client unless explicitly allowed', () => {
    expect(canAccessLeaseDiagnostic(lease, { sessionId: 's1' }, getSharedProfilePolicy({}))).toBe(true);
    expect(canAccessLeaseDiagnostic(lease, { clientId: 'c1' }, getSharedProfilePolicy({}))).toBe(true);
    expect(canAccessLeaseDiagnostic(lease, { sessionId: 'other' }, getSharedProfilePolicy({}))).toBe(false);
    expect(canAccessLeaseDiagnostic(lease, { sessionId: 'other' }, getSharedProfilePolicy({ OPENCHROME_SHARED_PROFILE_CROSS_TENANT_DIAGNOSTICS: '1' }))).toBe(true);
  });

  test('redacted lease diagnostics omit URL/title-shaped sensitive fields', () => {
    const diagnostic = redactLeaseDiagnostic(lease, { sessionId: 's1' }, getSharedProfilePolicy({}));
    expect(diagnostic).toEqual(expect.objectContaining({ targetId: 't1', sessionId: 's1', redacted: true }));
    expect(diagnostic).not.toHaveProperty('url');
    expect(diagnostic).not.toHaveProperty('title');
    expect(redactLeaseDiagnostic(lease, { sessionId: 'other' }, getSharedProfilePolicy({}))).toBeNull();
  });
});
