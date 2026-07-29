/// <reference types="jest" />

import {
  MAX_CONSOLE_FACT_CAPTURE_TYPES,
  MAX_CONSOLE_FACT_ENTRIES,
  MAX_CONSOLE_FACT_MESSAGE_CHARS,
  buildConsoleContractFact,
  buildPerformanceContractFacts,
  decodeConsoleContractFactMessage,
  isContractFact,
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
        navigation: { duration: 123.4, loadEventEnd: 150 },
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

  test('performance facts suppress incomplete or negative navigation timing', () => {
    const facts = buildPerformanceContractFacts({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      metrics: {
        navigation: {
          duration: 0,
          loadEventEnd: 0,
          requestTime: -5,
        },
        puppeteer: { Documents: 1 },
      },
    });

    expect(facts.some((fact) => fact.metric.startsWith('navigation.'))).toBe(false);
    expect(facts).toContainEqual(expect.objectContaining({
      metric: 'puppeteer.Documents',
      value: 1,
    }));
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
    const originalMessage = 'close </oc:console> then';
    const fact = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{ type: 'log', text: originalMessage, count: 1 }],
      capturedTypes: null,
      messageEncoding: 'oc_boundary_v1',
    });

    expect(fact.entries[0].message).toBe(
      '<oc:console>close <\u200B/oc:console> then</oc:console>',
    );
    expect(decodeConsoleContractFactMessage(
      fact.entries[0].message,
      fact.message_encoding,
    )).toBe(originalMessage);
  });

  test('console facts deduplicate capture filters without claiming evidence loss', () => {
    const fact = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{ type: 'error', text: 'checkout failed', count: 1 }],
      capturedTypes: ['error', 'error'],
      messageEncoding: 'plain',
    });

    expect(fact.captured_types).toEqual(['error']);
    expect(fact.truncated).toBe(false);
    expect(isContractFact(fact)).toBe(true);
  });

  test('console capture filters distinguish duplicate-at-cap from unique overflow', () => {
    const capturedTypes = Array.from(
      { length: MAX_CONSOLE_FACT_CAPTURE_TYPES },
      (_, index) => `type-${index}`,
    );
    const duplicateAtCap = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [],
      capturedTypes: [...capturedTypes, capturedTypes[0]],
      messageEncoding: 'plain',
    });
    const uniqueOverflow = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [],
      capturedTypes: [...capturedTypes, 'type-overflow'],
      messageEncoding: 'plain',
    });

    expect(duplicateAtCap.captured_types).toEqual(capturedTypes);
    expect(duplicateAtCap.truncated).toBe(false);
    expect(isContractFact(duplicateAtCap)).toBe(true);
    expect(uniqueOverflow.captured_types).toEqual(capturedTypes);
    expect(uniqueOverflow.truncated).toBe(true);
    expect(isContractFact(uniqueOverflow)).toBe(true);
  });

  test('console facts cap boundary-expanded messages as valid truncated evidence', () => {
    const fact = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{ type: 'log', text: '<oc:x>'.repeat(170), count: 1 }],
      capturedTypes: null,
      messageEncoding: 'oc_boundary_v1',
    });
    const decoded = decodeConsoleContractFactMessage(
      fact.entries[0].message,
      fact.message_encoding,
    );
    const encodedBody = fact.entries[0].message.slice(
      '<oc:console>'.length,
      -'</oc:console>'.length,
    );

    expect(encodedBody).toHaveLength(MAX_CONSOLE_FACT_MESSAGE_CHARS);
    expect(decoded?.length).toBeLessThanOrEqual(MAX_CONSOLE_FACT_MESSAGE_CHARS);
    expect(fact.truncated).toBe(true);
    expect(isContractFact(fact)).toBe(true);
  });

  test('console facts enforce the encoded boundary at exactly 1024 characters', () => {
    const marker = '<oc:x>';
    const atLimitText = marker
      + 'a'.repeat(MAX_CONSOLE_FACT_MESSAGE_CHARS - marker.length - 1);
    const overLimitText = marker
      + 'a'.repeat(MAX_CONSOLE_FACT_MESSAGE_CHARS - marker.length);
    const atLimit = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{
        type: 'log',
        text: atLimitText,
        count: 1,
      }],
      capturedTypes: null,
      messageEncoding: 'oc_boundary_v1',
    });
    const overLimit = buildConsoleContractFact({
      sessionId: 'session-a',
      targetId: 'tab-a',
      capturedAt: '2026-07-28T12:00:00.000Z',
      entries: [{
        type: 'log',
        text: overLimitText,
        count: 1,
      }],
      capturedTypes: null,
      messageEncoding: 'oc_boundary_v1',
    });
    const atLimitBody = decodeConsoleContractFactMessage(
      atLimit.entries[0].message,
      atLimit.message_encoding,
    );
    const overLimitBody = decodeConsoleContractFactMessage(
      overLimit.entries[0].message,
      overLimit.message_encoding,
    );
    const atLimitEncodedBody = atLimit.entries[0].message.slice(
      '<oc:console>'.length,
      -'</oc:console>'.length,
    );
    const overLimitEncodedBody = overLimit.entries[0].message.slice(
      '<oc:console>'.length,
      -'</oc:console>'.length,
    );

    expect(atLimitEncodedBody).toHaveLength(MAX_CONSOLE_FACT_MESSAGE_CHARS);
    expect(atLimitBody).toBe(atLimitText);
    expect(atLimit.truncated).toBe(false);
    expect(isContractFact(atLimit)).toBe(true);
    expect(overLimitEncodedBody).toHaveLength(MAX_CONSOLE_FACT_MESSAGE_CHARS);
    expect(overLimitBody).toBe(overLimitText.slice(0, -1));
    expect(overLimit.truncated).toBe(true);
    expect(isContractFact(overLimit)).toBe(true);
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

  test('fact selection requires a timezone-qualified captured_at', () => {
    const base = {
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      metric: 'navigation.duration',
      unit: 'ms',
      value: 500,
    };
    const scope = {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms' as const,
    };

    expect(selectPerformanceContractFact([{
      ...base,
      captured_at: '2026-07-28T11:59:59.000',
    }], scope)).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_MALFORMED',
    });
    expect(selectPerformanceContractFact([{
      ...base,
      captured_at: '2026-07-28T13:59:59.123456+02:00',
    }], scope)).toMatchObject({
      ok: true,
      fact: { captured_at: '2026-07-28T11:59:59.123Z' },
    });
    expect(selectPerformanceContractFact([{
      ...base,
      captured_at: '2026-07-28T11:59:59.123456789Z',
    }], scope)).toMatchObject({
      ok: true,
      fact: { captured_at: '2026-07-28T11:59:59.123Z' },
    });
    for (const capturedAt of [
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '0000-01-01T00:00:00+23:59',
      '9999-12-31T23:59:59-23:59',
      '2026-07-28T11:59:59.1234567890Z',
      '2026-07-28T11:59:59.1234567890+00:00',
    ]) {
      expect(selectPerformanceContractFact([{
        ...base,
        captured_at: capturedAt,
      }], scope)).toMatchObject({
        ok: false,
        code: 'CONTRACT_FACT_MALFORMED',
      });
    }
  });

  test('fact selection does not fall back past the freshest invalid observation', () => {
    const performanceBase = {
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      metric: 'navigation.duration',
      unit: 'ms',
      value: 500,
    };
    const performance = selectPerformanceContractFact([
      { ...performanceBase, captured_at: '2026-07-28T11:59:50.000Z' },
      {
        ...performanceBase,
        schema_version: 2,
        captured_at: '2026-07-28T11:59:59.000Z',
      },
    ], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms',
    });
    const consoleFactBase = {
      schema_version: 1,
      kind: 'console',
      source_tool: 'console_capture',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_types: null,
      message_encoding: 'plain',
      truncated: false,
    };
    const consoleSelection = selectConsoleContractFact([
      {
        ...consoleFactBase,
        captured_at: '2026-07-28T11:59:50.000Z',
        entries: [{ type: 'error', message: 'older', count: 1, uncaught: false }],
      },
      {
        ...consoleFactBase,
        captured_at: '2026-07-28T11:59:59.000Z',
        entries: [{ type: 'error', message: 'newer', count: 0, uncaught: false }],
      },
    ], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
    });

    expect(performance).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_SCHEMA_UNSUPPORTED',
    });
    expect(consoleSelection).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_MALFORMED',
    });
  });

  test('fact selection rejects ambiguous freshest timestamp groups', () => {
    const equivalentTimestamps = [
      '2026-07-28T11:59:59.000Z',
      '2026-07-28T13:59:59.000+02:00',
    ];
    const performanceFacts = [500, 900].map((value, index) => ({
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: equivalentTimestamps[index],
      metric: 'navigation.duration',
      unit: value === 500 ? 'ms' : 'seconds',
      value,
    }));
    const consoleFacts = [false, true].map((truncated, index) => ({
      schema_version: 1,
      kind: 'console',
      source_tool: 'console_capture',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: equivalentTimestamps[index],
      entries: [{ type: 'error', message: 'same-time', count: 1, uncaught: false }],
      captured_types: null,
      message_encoding: 'plain',
      truncated,
    }));

    for (const facts of [performanceFacts, [...performanceFacts].reverse()]) {
      expect(selectPerformanceContractFact(facts, {
        sessionId: 'session-a',
        targetId: 'tab-a',
        nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
        maxAgeMs: 30000,
        metric: 'navigation.duration',
        unit: 'ms',
      })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_MALFORMED' });
    }
    for (const facts of [consoleFacts, [...consoleFacts].reverse()]) {
      expect(selectConsoleContractFact(facts, {
        sessionId: 'session-a',
        targetId: 'tab-a',
        nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
        maxAgeMs: 30000,
      })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_MALFORMED' });
    }
  });

  test('fact selection keeps malformed scope and temporal candidates fail-closed', () => {
    const valid = {
      schema_version: 1,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: '2026-07-28T11:59:59.000Z',
      metric: 'navigation.duration',
      unit: 'ms',
      value: 500,
    };
    const scope = {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxAgeMs: 30000,
      metric: 'navigation.duration',
      unit: 'ms' as const,
    };
    const crossScopeMalformed = selectPerformanceContractFact([
      valid,
      { ...valid, session_id: 'session-b', captured_at: 'not-a-date', value: Number.NaN },
    ], scope);
    const futureUnsupported = selectPerformanceContractFact([
      valid,
      { ...valid, schema_version: 2, captured_at: '2026-07-28T12:00:01.000Z' },
    ], scope);
    const malformedTimestamp = selectPerformanceContractFact([
      valid,
      { ...valid, captured_at: 'not-a-date', value: 1 },
    ], scope);
    const staleUnsupported = selectPerformanceContractFact([{
      ...valid,
      schema_version: 2,
      captured_at: '2026-07-28T11:00:00.000Z',
    }], scope);

    expect(crossScopeMalformed).toMatchObject({ ok: true, fact: { value: 500 } });
    expect(futureUnsupported).toMatchObject({ ok: true, fact: { value: 500 } });
    expect(malformedTimestamp).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_MALFORMED',
    });
    expect(staleUnsupported).toMatchObject({
      ok: false,
      code: 'CONTRACT_FACT_SCHEMA_UNSUPPORTED',
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

  test('console selection rejects over-cap encoded bodies even after unescaping', () => {
    const selected = selectConsoleContractFact([{
      schema_version: 1,
      kind: 'console',
      source_tool: 'console_capture',
      session_id: 'session-a',
      target_id: 'tab-a',
      captured_at: '2026-07-28T12:00:00.000Z',
      entries: [{
        type: 'error',
        message: `<oc:console>${'<\u200Boc:x>'.repeat(147)}</oc:console>`,
        count: 1,
        uncaught: false,
      }],
      captured_types: null,
      message_encoding: 'oc_boundary_v1',
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
