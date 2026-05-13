/// <reference types="jest" />

import { clearQueryDebug, getLatestQueryDebug, recordQueryDebug, sanitizeDebugText } from '../../src/query-debug/store';

describe('query debug store', () => {
  beforeEach(() => clearQueryDebug());

  test('stores latest bounded record by session tab and kind', () => {
    for (let i = 0; i < 7; i++) {
      recordQueryDebug({ kind: 'extract', sessionId: 's1', tabId: 't1', timestamp: `2026-01-01T00:00:0${i}Z`, normalized: `{ title${i} }` });
    }

    const latest = getLatestQueryDebug('s1', 't1', 'extract');
    expect(latest?.normalized).toBe('{ title6 }');
    expect(getLatestQueryDebug('s1', 'missing', 'extract')).toBeNull();
  });

  test('redacts token-like text and caps long strings', () => {
    const text = sanitizeDebugText(`token=secret ${'x'.repeat(400)}`);
    expect(text).toContain('[REDACTED]');
    expect(text.length).toBeLessThanOrEqual(240);
  });
});
