import { describe, expect, it } from '@jest/globals';
import { createReviseHook } from '../../src/recovery/revise.js';

interface Invoice { total: number; currency: string; }

describe('createReviseHook', () => {
  it('returns no-findings when nothing to fix', async () => {
    const hook = createReviseHook<Invoice>({ revisers: {} });
    const result = await hook({ payload: { total: 10, currency: 'USD' }, findings: [] });
    expect(result.status).toBe('no-findings');
  });

  it('applies matched revisers and reports patches', async () => {
    const hook = createReviseHook<Invoice>({
      revisers: {
        'stale-value': async ({ payload }) => ({ ...payload, total: 42 }),
      },
    });
    const result = await hook({
      payload: { total: 10, currency: 'USD' },
      findings: [{ kind: 'stale-value', locus: 'invoice.total' }],
    });
    expect(result.status).toBe('revised');
    if (result.status === 'revised') {
      expect(result.payload.total).toBe(42);
      expect(result.patches[0]!.status).toBe('applied');
    }
  });

  it('skips findings with no matching reviser', async () => {
    const hook = createReviseHook<Invoice>({ revisers: {} });
    const result = await hook({
      payload: { total: 10, currency: 'USD' },
      findings: [{ kind: 'schema-violation', locus: 'invoice.total' }],
    });
    expect(result.status).toBe('revised'); // skipped-only still counts as processed
    expect(result.patches[0]!.status).toBe('skipped');
  });

  it('surfaces unrecoverable when all revisers throw', async () => {
    const hook = createReviseHook<Invoice>({
      revisers: {
        boom: async () => { throw new Error('nope'); },
      },
    });
    const result = await hook({
      payload: { total: 10, currency: 'USD' },
      findings: [{ kind: 'boom', locus: 'x' }],
    });
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') {
      expect(result.patches[0]!.status).toBe('failed');
    }
  });

  it('honours maxFindings cap', async () => {
    let calls = 0;
    const hook = createReviseHook<Invoice>({
      revisers: {
        touch: async ({ payload }) => { calls++; return payload; },
      },
      maxFindings: 2,
    });
    await hook({
      payload: { total: 0, currency: 'USD' },
      findings: [
        { kind: 'touch', locus: 'a' },
        { kind: 'touch', locus: 'b' },
        { kind: 'touch', locus: 'c' },
      ],
    });
    expect(calls).toBe(2);
  });
});
