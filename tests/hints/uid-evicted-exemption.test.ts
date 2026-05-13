/**
 * Hint-engine exemption test for the backend-node uid contract (#844).
 *
 * The structured `uid_evicted:` error already informs the caller about
 * navigation-epoch rotation, so the generic stale-ref hint MUST NOT fire
 * for it. Conversely, ordinary stale-ref errors must continue to receive
 * the hint.
 */

import { errorRecoveryRules } from '../../src/hints/rules/error-recovery';
import { formatUidEvictedError } from '../../src/core/perception/node-ref';

function findStaleRefRule() {
  // The first rule (priority 100) is the stale-ref rule per the file layout.
  const rule = errorRecoveryRules.find((r) => r.name === 'error-recovery-0');
  if (!rule) throw new Error('expected error-recovery-0 to be the stale-ref rule');
  return rule;
}

const STALE_REF_HINT_FRAGMENT = 'Refs expire after page changes';

describe('hint-engine: uid_evicted suppresses the stale-ref hint (#844)', () => {
  test('plain stale-ref error still triggers the hint', () => {
    const rule = findStaleRefRule();
    const result = rule.match({
      isError: true,
      resultText: 'Error: ref ref_42 not found in target',
      toolName: 'interact',
    } as any);
    expect(result).toContain(STALE_REF_HINT_FRAGMENT);
  });

  test('uid_evicted: structured error does NOT trigger the stale-ref hint', () => {
    const rule = findStaleRefRule();
    const errText = formatUidEvictedError('n_7', 'loader-NEW');
    const result = rule.match({
      isError: true,
      resultText: errText,
      toolName: 'interact',
    } as any);
    expect(result).toBeNull();
  });

  test('uid_evicted: prefix with leading whitespace is still suppressed', () => {
    const rule = findStaleRefRule();
    const result = rule.match({
      isError: true,
      resultText: '  uid_evicted: {"uid":"n_1","currentLoaderId":"L"}',
      toolName: 'interact',
    } as any);
    expect(result).toBeNull();
  });

  test('case-insensitive uid_evicted prefix is suppressed', () => {
    const rule = findStaleRefRule();
    const result = rule.match({
      isError: true,
      resultText: 'UID_EVICTED: {"uid":"n_1"}',
      toolName: 'interact',
    } as any);
    expect(result).toBeNull();
  });

  test('non-uid_evicted error containing the literal string elsewhere still triggers hint', () => {
    // If a CDP error happens to mention "uid_evicted" mid-message but the
    // overall error is a generic stale-ref, the hint should still fire.
    const rule = findStaleRefRule();
    const result = rule.match({
      isError: true,
      resultText: 'Error: ref ref_42 is stale ref (uid_evicted earlier in transcript)',
      toolName: 'interact',
    } as any);
    expect(result).toContain(STALE_REF_HINT_FRAGMENT);
  });
});
