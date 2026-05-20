/// <reference types="jest" />

import { parseSmokeArgs, runCompetitorSmokeMatrix } from './run-competitor-smoke';

describe('competitor smoke matrix', () => {
  test('parses defaults as CI-safe all-library matrix', () => {
    const opts = parseSmokeArgs([]);
    expect(opts.library).toBe('all');
    expect(opts.includeLive).toBe(false);
    expect(opts.timeoutMs).toBe(30000);
  });

  test('runs no-Chrome OpenChrome stub and Crawlee rows while explicitly skipping live competitors', async () => {
    const rows = await runCompetitorSmokeMatrix(parseSmokeArgs(['--library=all', '--timeout-ms=30000']));
    expect(rows.map((row) => row.library).sort()).toEqual(['Crawlee', 'OpenChrome', 'Playwright', 'Puppeteer', 'browser-use', 'playwright-mcp'].sort());
    expect(rows.find((row) => row.library === 'OpenChrome')?.status).toBe('passed');
    expect(rows.find((row) => row.library === 'Crawlee')?.status).toBe('passed');
    const playwright = rows.find((row) => row.library === 'Playwright');
    expect(playwright?.status).toBe('skipped');
    expect(playwright?.skipCategory).toBe('not_requested');
    expect(playwright?.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    expect(playwright?.versionPinned).toBe(true);
    expect(rows.find((row) => row.library === 'OpenChrome')?.version).toBe('1.12.4');
    expect(rows.every((row) => row.sameTaskContract)).toBe(true);
  }, 30000);
});
