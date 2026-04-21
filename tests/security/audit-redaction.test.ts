/// <reference types="jest" />
// Tests for redactPlaintextKeys in src/security/audit-logger.ts
// Regression guard for Codex P2 (PR #28): redaction must not leak keys
// whose tenantId contains hyphens, dots, or other non-[A-Za-z0-9_] chars.

import { redactPlaintextKeys } from '../../src/security/audit-logger';

describe('redactPlaintextKeys', () => {
  it('redacts a plain key with alphanumeric tenantId', () => {
    const k = 'oc_live_acme_' + 'a'.repeat(32);
    expect(redactPlaintextKeys(k)).toBe('[REDACTED]');
  });

  it('redacts a key with hyphenated tenantId (Codex P2 regression)', () => {
    const k = 'oc_live_acme-inc_' + 'b'.repeat(32);
    const out = redactPlaintextKeys(k);
    expect(out).toBe('[REDACTED]');
    expect(out).not.toContain('inc');
    expect(out).not.toContain('b'.repeat(4));
  });

  it('redacts a key with dotted tenantId', () => {
    const k = 'oc_live_acme.prod_' + 'c'.repeat(32);
    expect(redactPlaintextKeys(k)).toBe('[REDACTED]');
  });

  it('redacts embedded keys inside JSON strings', () => {
    const raw = JSON.stringify({
      token: 'oc_live_acme-eu_' + 'd'.repeat(32),
      other: 'safe',
    });
    const out = redactPlaintextKeys(raw);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('acme-eu');
    expect(out).not.toContain('d'.repeat(4));
    expect(out).toContain('"other":"safe"');
  });

  it('redacts multiple keys in the same string', () => {
    const s = 'first=oc_live_a-b_' + 'x'.repeat(32) + ' second=oc_live_c.d_' + 'y'.repeat(32);
    const out = redactPlaintextKeys(s);
    expect(out).toBe('first=[REDACTED] second=[REDACTED]');
  });

  it('preserves surrounding content', () => {
    const k = 'oc_live_t-1_' + 'z'.repeat(32);
    const s = `before "${k}" after`;
    expect(redactPlaintextKeys(s)).toBe('before "[REDACTED]" after');
  });

  it('is a no-op when no prefix is present', () => {
    expect(redactPlaintextKeys('nothing sensitive here')).toBe('nothing sensitive here');
  });
});
