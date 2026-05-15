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

  test('only openchrome is wired today; the other two ship as scaffolds', () => {
    expect(LIBRARY_ROUTING.openchrome.nativeLoopWired).toBe(true);
    expect(LIBRARY_ROUTING['playwright-mcp'].nativeLoopWired).toBe(false);
    expect(LIBRARY_ROUTING['browser-use'].nativeLoopWired).toBe(false);
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

  test('reports only wired libraries as cells that would actually run', () => {
    const p = projectCost({ taskCount: 60, libraries: WEBVOYAGER_LIBRARIES, repetitions: 10 });
    // Only openchrome is wired today; would-run = 60 * 10 = 600 cells.
    expect(p.cellsWouldRunTotal).toBe(600);
    expect(p.perLibrary.filter((l) => l.wired).length).toBe(1);
    expect(p.perLibrary.filter((l) => !l.wired).map((l) => l.library))
      .toEqual(expect.arrayContaining(['playwright-mcp', 'browser-use']));
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
