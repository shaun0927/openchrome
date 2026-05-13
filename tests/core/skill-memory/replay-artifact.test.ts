/**
 * Tests for the replay-artifact validator + JSON-Schema dump (#875).
 *
 * These tests exercise `validateReplayArtifact`, `validateReplayArtifactStep`,
 * `validateReplaySelector`, and `replayArtifactJsonSchema` against malformed
 * inputs. The validator is a pure function and must never throw.
 */

import {
  REPLAY_ARTIFACT_SCHEMA_VERSION,
  REPLAY_SELECTOR_TYPES,
  REPLAY_STEP_KINDS,
  replayArtifactJsonSchema,
  validateReplayArtifact,
  validateReplayArtifactStep,
  validateReplaySelector,
  type ReplayArtifact,
} from '../../../src/core/skill-memory';

function validArtifact(): ReplayArtifact {
  return {
    schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
    recorded_at: Date.now(),
    recorder: { openchrome_version: '1.11.0' },
    steps: [
      {
        kind: 'click',
        selectors: [{ type: 'css', value: '#submit' }],
      },
    ],
  };
}

describe('validateReplayArtifact', () => {
  test('accepts a well-formed artifact', () => {
    expect(validateReplayArtifact(validArtifact())).toEqual({ ok: true });
  });

  test('rejects non-object values', () => {
    expect(validateReplayArtifact(null).ok).toBe(false);
    expect(validateReplayArtifact(undefined).ok).toBe(false);
    expect(validateReplayArtifact('artifact').ok).toBe(false);
    expect(validateReplayArtifact(42).ok).toBe(false);
  });

  test('rejects a wrong schema_version', () => {
    const a = validArtifact() as unknown as { schema_version: number };
    a.schema_version = 2;
    const r = validateReplayArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema_version/);
  });

  test('rejects non-finite recorded_at', () => {
    const a = validArtifact() as unknown as { recorded_at: number };
    a.recorded_at = Number.NaN;
    expect(validateReplayArtifact(a).ok).toBe(false);
  });

  test('rejects empty steps array', () => {
    const a = validArtifact() as unknown as { steps: unknown[] };
    a.steps = [];
    const r = validateReplayArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/steps must be a non-empty/);
  });

  test('propagates per-step path in error', () => {
    const a = validArtifact() as unknown as { steps: unknown[] };
    a.steps = [
      { kind: 'click', selectors: [{ type: 'css', value: '#a' }] },
      { kind: 'unknown', selectors: [] },
    ];
    const r = validateReplayArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^steps\[1\]:/);
  });
});

describe('validateReplayArtifactStep', () => {
  test('navigate may have empty selectors when args.url is supplied', () => {
    const r = validateReplayArtifactStep({
      kind: 'navigate',
      selectors: [],
      args: { url: 'https://example.com' },
    });
    expect(r.ok).toBe(true);
  });

  test('navigate without args.url is rejected', () => {
    const r = validateReplayArtifactStep({ kind: 'navigate', selectors: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/navigate step requires args.url/);
  });

  test('fill requires args.value', () => {
    const r = validateReplayArtifactStep({
      kind: 'fill',
      selectors: [{ type: 'css', value: '#email' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fill step requires args.value/);
  });

  test('non-navigate kinds need at least one selector', () => {
    for (const kind of REPLAY_STEP_KINDS.filter((k) => k !== 'navigate')) {
      const args = kind === 'fill' ? { value: 'x' } : undefined;
      const r = validateReplayArtifactStep({ kind, selectors: [], args });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/non-empty/);
    }
  });

  test('rejects negative or fractional frameOrdinal', () => {
    const base = { kind: 'click' as const, selectors: [{ type: 'css' as const, value: '#x' }] };
    expect(validateReplayArtifactStep({ ...base, frameOrdinal: -1 }).ok).toBe(false);
    expect(validateReplayArtifactStep({ ...base, frameOrdinal: 1.5 }).ok).toBe(false);
    expect(validateReplayArtifactStep({ ...base, frameOrdinal: 0 }).ok).toBe(true);
    expect(validateReplayArtifactStep({ ...base, frameOrdinal: 7 }).ok).toBe(true);
  });

  test('rejects empty post_assert.contract_id', () => {
    const r = validateReplayArtifactStep({
      kind: 'click',
      selectors: [{ type: 'css', value: '#x' }],
      post_assert: { contract_id: '' },
    });
    expect(r.ok).toBe(false);
  });

  test('rejects non-object args', () => {
    const r = validateReplayArtifactStep({
      kind: 'click',
      selectors: [{ type: 'css', value: '#x' }],
      // The runtime guard test passes an array where the runtime expects an
      // object. With develop's tightened input typing the cast is now
      // explicit so TS no longer flags it (the prior `@ts-expect-error`
      // directive is unused).
      args: [] as unknown as Record<string, unknown>,
    });
    expect(r.ok).toBe(false);
  });

  test('rejects action kinds whose required args are missing', () => {
    expect(validateReplayArtifactStep({ kind: 'press', selectors: [{ type: 'css', value: 'body' }] }).ok).toBe(false);
    expect(validateReplayArtifactStep({ kind: 'select', selectors: [{ type: 'css', value: 'select' }] }).ok).toBe(false);
    expect(validateReplayArtifactStep({ kind: 'scroll', selectors: [{ type: 'css', value: 'body' }], args: { y: 'down' } }).ok).toBe(false);
  });

  test('accepts press, select, and scroll steps with valid args', () => {
    expect(validateReplayArtifactStep({ kind: 'press', selectors: [{ type: 'css', value: 'body' }], args: { key: 'Enter' } }).ok).toBe(true);
    expect(validateReplayArtifactStep({ kind: 'select', selectors: [{ type: 'css', value: 'select' }], args: { value: 'US' } }).ok).toBe(true);
    expect(validateReplayArtifactStep({ kind: 'scroll', selectors: [{ type: 'css', value: 'body' }], args: { y: 300 } }).ok).toBe(true);
  });
});

describe('validateReplaySelector', () => {
  test('accepts live-resolvable selector types and rejects node_ref until resolved', () => {
    expect(validateReplaySelector({ type: 'css', value: '#x' }).ok).toBe(true);
    expect(validateReplaySelector({ type: 'xpath', value: '//div' }).ok).toBe(true);
    expect(validateReplaySelector({ type: 'text', value: 'Submit' }).ok).toBe(true);
    expect(validateReplaySelector({ type: 'node_ref', value: 'n1' }).ok).toBe(false);
    expect(validateReplaySelector({ type: 'accessible_name', value: 'Submit' }).ok).toBe(true);
    expect(
      validateReplaySelector({ type: 'role_name', role: 'button', name: 'Submit' }).ok,
    ).toBe(true);
  });

  test('rejects unknown selector type', () => {
    const r = validateReplaySelector({ type: 'data-testid', value: 'x' });
    expect(r.ok).toBe(false);
  });

  test('rejects empty selector value', () => {
    expect(validateReplaySelector({ type: 'css', value: '' }).ok).toBe(false);
    expect(validateReplaySelector({ type: 'xpath', value: '' }).ok).toBe(false);
  });

  test('rejects role_name with empty role', () => {
    expect(validateReplaySelector({ type: 'role_name', role: '', name: 'x' }).ok).toBe(false);
  });

  test('every type appears in REPLAY_SELECTOR_TYPES', () => {
    for (const t of REPLAY_SELECTOR_TYPES) {
      expect(typeof t).toBe('string');
    }
  });
});

describe('replayArtifactJsonSchema', () => {
  test('schema_version is locked to constant', () => {
    const s = replayArtifactJsonSchema();
    expect((s.properties as Record<string, { const?: number }>).schema_version.const).toBe(
      REPLAY_ARTIFACT_SCHEMA_VERSION,
    );
  });

  test('lists every step kind in the enum', () => {
    const s = replayArtifactJsonSchema();
    const stepsItems = ((s.properties as Record<string, Record<string, unknown>>).steps as {
      items: { properties: { kind: { enum: string[] } } };
    }).items.properties.kind.enum;
    for (const k of REPLAY_STEP_KINDS) {
      expect(stepsItems).toContain(k);
    }
  });
});
