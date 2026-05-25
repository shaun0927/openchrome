/// <reference types="jest" />

import type { MCPAdapter, MCPToolResult } from './benchmark-runner';
import {
  AdapterSpec,
  parseSmokeArgs,
  runCompetitorSmokeMatrix,
  runOne,
} from './run-competitor-smoke';

function fakeAdapter(read: MCPToolResult): MCPAdapter {
  return {
    name: 'fake',
    mode: 'fake',
    async callTool(tool: string): Promise<MCPToolResult> {
      if (tool === 'tabs_create') return { content: [{ type: 'text', text: JSON.stringify({ tabId: 'tab-1' }) }] };
      if (tool === 'read_page') return read;
      if (tool === 'tabs_close') return { content: [{ type: 'text', text: 'ok' }] };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

function specOf(adapter: MCPAdapter): AdapterSpec {
  // 'OpenChrome' as the library label is what `versionInfoFor` uses to short-
  // circuit to `dependencyAvailable: true` (it reads the repo's own
  // package.json), so the dependency-skip branch in runOne never trips and we
  // can assert payload-sanity behaviour directly.
  return {
    library: 'OpenChrome',
    mode: 'fake',
    liveRequired: false,
    adapterFactory: () => adapter,
  };
}

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

  test('demotes a three-calls-succeeded row to failed when read_page returns empty payload', async () => {
    const spec = specOf(fakeAdapter({ content: [{ type: 'text', text: '' }] }));
    const row = await runOne(spec, 'http://example.local/', { includeLive: false, library: 'all', timeoutMs: 5000 });
    expect(row.status).toBe('failed');
    expect(row.payloadChars).toBe(0);
    expect(row.failure).toMatch(/empty_payload/);
  });

  test('keeps a row passed when read_page returns non-empty payload', async () => {
    const spec = specOf(fakeAdapter({ content: [{ type: 'text', text: '<html><body>hi</body></html>' }] }));
    const row = await runOne(spec, 'http://example.local/', { includeLive: false, library: 'all', timeoutMs: 5000 });
    expect(row.status).toBe('passed');
    expect(row.payloadChars).toBeGreaterThan(0);
    expect(row.failure).toBe('');
  });
});
