/// <reference types="jest" />

import {
  WEBVOYAGER_LIBRARIES,
  LIBRARY_ROUTING,
  projectCost,
  formatProjection,
} from './library-routing';

describe('WebVoyager library routing', () => {
  test('exposes the three Issue #1257 libraries in stable order', () => {
    expect(WEBVOYAGER_LIBRARIES).toEqual(['openchrome', 'playwright-mcp', 'browser-use']);
  });

  test('every library has a routing entry with a non-empty pin + note', () => {
    for (const lib of WEBVOYAGER_LIBRARIES) {
      const routing = LIBRARY_ROUTING[lib];
      expect(routing.library).toBe(lib);
      expect(routing.competitorPin.length).toBeGreaterThan(0);
      expect(routing.note.length).toBeGreaterThan(0);
    }
  });

  test('every native library has an external execution descriptor and forbids fallback', () => {
    expect(WEBVOYAGER_LIBRARIES.every((lib) => LIBRARY_ROUTING[lib].nativeLoopWired)).toBe(true);
    expect(LIBRARY_ROUTING['playwright-mcp'].nativeExecution).toBe('playwright-mcp-external');
    expect(LIBRARY_ROUTING['browser-use'].nativeExecution).toBe('browser-use-python-bridge');
    expect(WEBVOYAGER_LIBRARIES.every((lib) => LIBRARY_ROUTING[lib].forbidsOpenChromeFallback)).toBe(true);
  });
});

describe('projectCost', () => {
  test('uses the WEBVOYAGER_BUDGET cap by default and multiplies through', () => {
    const p = projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 10 });
    expect(p.taskCount).toBe(60);
    expect(p.librariesRun).toBe(3);
    expect(p.repetitions).toBe(10);
    expect(p.maxUsdPerTask).toBe(0.5);
    expect(p.worstCaseUsd).toBe(60 * 3 * 10 * 0.5);
  });

  test('reports all selected native libraries as dry-run cells', () => {
    const p = projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 10 });
    expect(p.cellsWouldRunTotal).toBe(60 * 3 * 10);
    expect(p.perLibrary.filter((l) => l.wired).length).toBe(3);
  });

  test('honors a maxUsdPerTask override', () => {
    const p = projectCost({ taskCount: 10, libraries: ['openchrome'], repetitions: 5, maxUsdPerTask: 0.1 });
    expect(p.maxUsdPerTask).toBe(0.1);
    expect(p.worstCaseUsd).toBe(10 * 1 * 5 * 0.1);
  });

  test('rejects empty libraries list', () => {
    expect(() => projectCost({ taskCount: 60, libraries: [], repetitions: 10 })).toThrow(/libraries/);
  });

  test('rejects non-integer reps', () => {
    expect(() => projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 0 }))
      .toThrow(/repetitions/);
    expect(() => projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 1.5 }))
      .toThrow(/repetitions/);
  });

  test('formatProjection emits a no-API-call notice so the operator cannot mistake it for a real run', () => {
    const p = projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 10 });
    const text = formatProjection(p);
    expect(text).toContain('--dry-run');
    expect(text).toContain('No API calls');
    expect(text).toContain('OPENCHROME_BENCH_REAL=1');
    expect(text).toContain('worst-case total USD');
  });
});
