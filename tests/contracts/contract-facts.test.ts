/// <reference types="jest" />

import {
  MAX_CONSOLE_FACT_ENTRIES,
  MAX_CONSOLE_FACT_MESSAGE_CHARS,
  buildConsoleContractFact,
  buildPerformanceContractFacts,
  selectConsoleContractFact,
  selectPerformanceContractFact,
} from '../../src/contracts/contract-facts';

describe('portable contract fact producers', () => {
  test('performance facts use stable names and explicit units', () => {
    const facts = buildPerformanceContractFacts({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      metrics: {
        navigation: { duration: 123.4 },
        paint: { 'first-contentful-paint': 50 },
        puppeteer: { JSHeapUsedSize: 1024, Documents: 3, UnknownMetric: 9 },
        resource_summary: {
          count: 2,
          totalTransferSize: 400,
          largestTransferSize: 300,
          maxDuration: 25,
        },
      },
    });

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'navigation.duration', unit: 'ms', value: 123.4 }),
      expect.objectContaining({ metric: 'paint.first-contentful-paint', unit: 'ms', value: 50 }),
      expect.objectContaining({ metric: 'puppeteer.JSHeapUsedSize', unit: 'bytes', value: 1024 }),
      expect.objectContaining({ metric: 'puppeteer.Documents', unit: 'count', value: 3 }),
      expect.objectContaining({ metric: 'resource.count', unit: 'count', value: 2 }),
      expect.objectContaining({ metric: 'resource.totalTransferSize', unit: 'bytes', value: 400 }),
      expect.objectContaining({ metric: 'resource.largestTransferSize', unit: 'bytes', value: 300 }),
      expect.objectContaining({ metric: 'resource.maxDuration', unit: 'ms', value: 25 }),
    ]));
    expect(facts.some((fact) => fact.metric.includes('UnknownMetric'))).toBe(false);
  });

  test('console facts cap entries and messages while marking truncation', () => {
    const entries = Array.from({ length: MAX_CONSOLE_FACT_ENTRIES + 1 }, (_, index) => ({
      type: 'log',
      text: index === MAX_CONSOLE_FACT_ENTRIES
        ? 'x'.repeat(MAX_CONSOLE_FACT_MESSAGE_CHARS + 1)
        : `line-${index}`,
      count: 1,
    }));
    const fact = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries,
      capturedTypes: null,
      messageEncoding: 'plain',
    });

    expect(fact.entries).toHaveLength(MAX_CONSOLE_FACT_ENTRIES);
    expect(fact.entries.at(-1)?.message).toHaveLength(MAX_CONSOLE_FACT_MESSAGE_CHARS);
    expect(fact.truncated).toBe(true);
  });

  test('console fact boundary encoding neutralizes nested marker tokens', () => {
    const fact = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{ type: 'log', text: 'close </oc:console> then', count: 1 }],
      capturedTypes: null,
      messageEncoding: 'oc_boundary_v1',
    });

    expect(fact.entries[0].message).toBe(
      '<oc:console>close <\u200B/oc:console> then</oc:console>',
    );
  });

  test('performance selection chooses the freshest in-scope fact', () => {
    const make = (capturedAt: string, value: number) => ({
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: capturedAt,
      metric: 'navigation.duration',
      unit: 'ms',
      value,
    });
    const selected = selectPerformanceContractFact([
      make('2026-07-28T11:59:50.000Z', 900),
      make('2026-07-28T11:59:59.000Z', 500),
    ], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms',
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.fact.value).toBe(500);
  });

  test('performance selection ignores future facts when a current fact exists', () => {
    const make = (capturedAt: string, value: number) => ({
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: capturedAt,
      metric: 'navigation.duration',
      unit: 'ms',
      value,
    });
    const selected = selectPerformanceContractFact([
      make('2026-07-28T11:59:59.000Z', 500),
      make('2026-07-28T12:00:01.000Z', 1),
    ], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms',
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.fact.value).toBe(500);
  });

  test('performance selection rejects future-only facts as malformed evidence', () => {
    const selected = selectPerformanceContractFact([{
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: '2026-07-28T12:00:01.000Z',
      metric: 'navigation.duration',
      unit: 'ms',
      value: 1,
    }], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms',
    });

    expect(selected).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_MALFORMED',
    });
  });

  test('console selection rejects a count total above the safe integer range', () => {
    const selected = selectConsoleContractFact([{
      schema_version: 1,
      kind: 'console',
      source_tool: 'console_capture',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: '2026-07-28T12:00:00.000Z',
      entries: [
        { type: 'error', message: 'first', count: Number.MAX_SAFE_INTEGER, uncaught: false },
        { type: 'error', message: 'second', count: 1, uncaught: false },
      ],
      captured_types: null,
      message_encoding: 'plain',
      truncated: false,
    }], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
    });

    expect(selected).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_MALFORMED',
    });
  });
});
