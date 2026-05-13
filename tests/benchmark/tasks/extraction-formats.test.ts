import * as fs from 'fs';
import * as path from 'path';
import { measureExtractionTransform, runExtractionFormatsBenchmark } from './extraction-formats';

describe('extraction format benchmark', () => {
  test('writes fixture-based extraction report without mutating content', () => {
    const report = runExtractionFormatsBenchmark({ ciMode: true });
    expect(report.summary.fixtures).toBeGreaterThanOrEqual(6);
    expect(report.entries.length).toBeGreaterThan(report.summary.fixtures);
    expect(report.entries.every(e => e.contentMutated === false)).toBe(true);
    expect(report.entries.some(e => e.mode === 'extract_data_deterministic_static')).toBe(true);
    expect(report.entries.some(e => e.skippedReason)).toBe(true);

    const out = path.join(process.cwd(), 'benchmark', 'results', 'extraction-formats.json');
    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(parsed.summary.fixtures).toBe(report.summary.fixtures);
  });

  test('mutation guard checks the working document state', () => {
    const clean = measureExtractionTransform('<main>Stable</main>', document => document.html.toUpperCase());
    const mutated = measureExtractionTransform('<main>Stable</main>', document => {
      document.html = '<main>Changed</main>';
      return document.html;
    });

    expect(clean.contentMutated).toBe(false);
    expect(mutated.contentMutated).toBe(true);
  });
});
