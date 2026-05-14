/// <reference types="jest" />

import {
  buildAutoSnapshotArgs,
  markAutoSnapshotRecorded,
  normalizeAutoSnapshotPolicy,
  redactSnapshotText,
  shouldTakeAutoSnapshot,
} from '../../src/session-snapshot-policy';

describe('auto session snapshot policy', () => {
  test('is disabled by default', () => {
    expect(normalizeAutoSnapshotPolicy(undefined)).toEqual({
      enabled: false,
      mode: 'best-effort',
      everyToolCalls: 0,
      everyMs: 0,
      maxSnapshots: 10,
    });

    expect(shouldTakeAutoSnapshot(undefined, 'start')).toMatchObject({
      shouldSnapshot: false,
      trigger: null,
      reason: 'auto snapshot policy disabled',
    });
  });

  test.each(['start', 'retry', 'reconnect', 'final'] as const)(
    'fires explicit %s trigger when enabled',
    (trigger) => {
      expect(shouldTakeAutoSnapshot({ enabled: true }, trigger)).toEqual({
        shouldSnapshot: true,
        trigger,
        mode: 'best-effort',
        reason: `${trigger} snapshot trigger`,
      });
    },
  );

  test('fires tool-count interval only after configured threshold', () => {
    expect(
      shouldTakeAutoSnapshot(
        { enabled: true, everyToolCalls: 3 },
        'tool-count',
        { toolCallsSinceSnapshot: 2 },
      ),
    ).toMatchObject({
      shouldSnapshot: false,
      reason: 'tool-call interval not reached (2/3)',
    });

    expect(
      shouldTakeAutoSnapshot(
        { enabled: true, everyToolCalls: 3 },
        'tool-count',
        { toolCallsSinceSnapshot: 3 },
      ),
    ).toMatchObject({
      shouldSnapshot: true,
      trigger: 'tool-count',
      reason: 'tool-call interval reached (3/3)',
    });
  });

  test('fires elapsed interval based on last snapshot timestamp', () => {
    expect(
      shouldTakeAutoSnapshot(
        { enabled: true, everyMs: 1000 },
        'elapsed',
        { lastSnapshotAt: 5000, now: 5500 },
      ),
    ).toMatchObject({
      shouldSnapshot: false,
      reason: 'elapsed interval not reached (500ms/1000ms)',
    });

    expect(
      shouldTakeAutoSnapshot(
        { enabled: true, everyMs: 1000 },
        'elapsed',
        { lastSnapshotAt: 5000, now: 6000 },
      ),
    ).toMatchObject({
      shouldSnapshot: true,
      trigger: 'elapsed',
      reason: 'elapsed interval reached (1000ms/1000ms)',
    });
  });

  test('normalizes invalid numeric options into safe bounds', () => {
    expect(
      normalizeAutoSnapshotPolicy({
        enabled: true,
        mode: 'strict',
        everyToolCalls: 2.9,
        everyMs: -1,
        maxSnapshots: 1000,
      }),
    ).toEqual({
      enabled: true,
      mode: 'strict',
      everyToolCalls: 2,
      everyMs: 0,
      maxSnapshots: 100,
    });
  });

  test('builds compact redacted oc_session_snapshot args', () => {
    const args = buildAutoSnapshotArgs(
      {
        objective: 'Log in with password: hunter2 and submit report',
        currentStep: 'Use token=abc123 on confirmation',
        nextActions: ['Click submit with api_key=secret-value', 'Verify success banner'],
        completedSteps: ['Opened page with Authorization: Bearer eyJhbGciOiJI'],
        notes: 'secret=my-secret should not persist',
      },
      'retry',
    );

    expect(args).toEqual({
      objective: 'Log in with password=<redacted> and submit report',
      currentStep: 'Use token=<redacted> on confirmation',
      nextActions: ['Click submit with api_key=<redacted>', 'Verify success banner'],
      completedSteps: ['Opened page with Authorization=<redacted>'],
      notes: 'secret=<redacted> should not persist',
      label: 'auto-retry',
    });
  });

  test('redacts bearer tokens without mutating harmless text', () => {
    expect(redactSnapshotText('Authorization Bearer abc.def.ghi')).toBe('Authorization Bearer=<redacted>');
    expect(redactSnapshotText('Verify success banner')).toBe('Verify success banner');
  });

  test('markAutoSnapshotRecorded resets interval state', () => {
    expect(markAutoSnapshotRecorded({ toolCallsSinceSnapshot: 5, lastSnapshotAt: 1 }, 42)).toEqual({
      toolCallsSinceSnapshot: 0,
      lastSnapshotAt: 42,
    });
  });
});
