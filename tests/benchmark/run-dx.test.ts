/// <reference types="jest" />

import { runDxBenchmark } from './run-dx';

describe('DX benchmark runner', () => {
  test('fills rule-based schema and error actionability scores where fixtures exist', () => {
    const rows = runDxBenchmark();
    const openchromeRows = rows.filter((row) => row.library === 'openchrome');
    expect(openchromeRows.length).toBeGreaterThan(0);
    expect(openchromeRows.every((row) => typeof row.schemaCompleteness === 'number')).toBe(true);
    expect(openchromeRows.every((row) => typeof row.errorActionability === 'number')).toBe(true);
    expect(openchromeRows[0].schemaCompleteness).toBeGreaterThan(0.5);
    expect(openchromeRows[0].errorActionability).toBeGreaterThanOrEqual(2);
  });

  test('keeps missing fixtures explicit as null rather than invented scores', () => {
    const rows = runDxBenchmark();
    const playwrightRows = rows.filter((row) => row.library === 'playwright');
    expect(playwrightRows.length).toBeGreaterThan(0);
    expect(playwrightRows.every((row) => row.schemaCompleteness === null)).toBe(true);
    expect(playwrightRows.every((row) => typeof row.errorActionability === 'number')).toBe(true);
  });
});
