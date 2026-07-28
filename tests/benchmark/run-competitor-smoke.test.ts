/// <reference types="jest" />

import type { MCPAdapter, MCPToolResult } from './benchmark-runner';
import packageJson from '../../package.json';
import {
  AdapterSpec,
  browserRsArgsForSharedCdp,
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

  test('maps the shared benchmark CDP endpoint to browser-rs stdio connect args', () => {
    expect(browserRsArgsForSharedCdp(' http://127.0.0.1:9222 ')).toEqual([
      '--connect',
      'http://127.0.0.1:9222',
    ]);
    expect(browserRsArgsForSharedCdp(undefined)).toEqual([]);
  });

  test('runs no-Chrome OpenChrome stub and Crawlee rows while explicitly skipping live competitors', async () => {
    const rows = await runCompetitorSmokeMatrix(parseSmokeArgs(['--library=all', '--timeout-ms=30000']));
    expect(rows.map((row) => row.library).sort()).toEqual(['Crawlee', 'OpenChrome', 'Playwright', 'Puppeteer', 'browser-rs-mcp', 'browser-use', 'playwright-mcp'].sort());
    expect(rows.find((row) => row.library === 'OpenChrome')?.status).toBe('passed');
    expect(rows.find((row) => row.library === 'Crawlee')?.status).toBe('passed');
    const playwright = rows.find((row) => row.library === 'Playwright');
    expect(playwright?.status).toBe('skipped');
    expect(playwright?.skipCategory).toBe('not_requested');
    expect(playwright?.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    expect(playwright?.versionPinned).toBe(true);
    expect(rows.find((row) => row.library === 'OpenChrome')?.version).toBe(packageJson.version);
    const browserRs = rows.find((row) => row.library === 'browser-rs-mcp');
    expect(browserRs?.status).toBe('skipped');
    expect(browserRs?.skipCategory).toBe('not_requested');
    expect(browserRs?.version).toBe('0.1.13');
    expect(browserRs?.commit).toBe('6efa54fe428f1203967a9c760a27d0647d5474ee');
    expect(browserRs?.chromeVersion).toBeTruthy();
    expect(browserRs?.os).toBeTruthy();
    if (browserRs?.expectedSha256) {
      expect(browserRs.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(rows.every((row) => row.sameTaskContract)).toBe(true);
  }, 30000);

  test('emits a structured browser-rs skip when live smoke is requested without BROWSER_RS_BIN', async () => {
    const previous = process.env.BROWSER_RS_BIN;
    delete process.env.BROWSER_RS_BIN;
    try {
      const rows = await runCompetitorSmokeMatrix(parseSmokeArgs(['--library=browser-rs-mcp', '--include-live=true', '--timeout-ms=5000']));
      expect(rows).toHaveLength(1);
      expect(rows[0].library).toBe('browser-rs-mcp');
      expect(rows[0].status).toBe('skipped');
      expect(['dependency_missing', 'unsupported_platform']).toContain(rows[0].skipCategory);
      if (rows[0].skipCategory === 'dependency_missing') {
        expect(rows[0].skipReason).toContain('BROWSER_RS_BIN');
      }
      expect(rows[0].commit).toBe('6efa54fe428f1203967a9c760a27d0647d5474ee');
    } finally {
      if (previous === undefined) delete process.env.BROWSER_RS_BIN;
      else process.env.BROWSER_RS_BIN = previous;
    }
  });

  test('fails the browser-rs row closed when external preflight reports a pin mismatch', async () => {
    const spec: AdapterSpec = {
      library: 'browser-rs-mcp',
      mode: 'a11y-snapshot-stdio',
      liveRequired: true,
      externalPreflight: () => ({
        status: 'version_mismatch',
        binaryPath: '/tmp/browser-rs',
        command: ['/tmp/browser-rs'],
        platformKey: 'linux-x64',
        expectedVersion: '0.1.13',
        actualVersion: '0.1.12',
        expectedSha256: 'a'.repeat(64),
        actualSha256: 'a'.repeat(64),
        asset: 'browser-rs-linux-x64',
        commit: '6efa54fe428f1203967a9c760a27d0647d5474ee',
        chromePath: '/tmp/chrome',
        profilePath: '/tmp/browser-rs-profile',
        message: 'browser-rs version mismatch: expected 0.1.13, got 0.1.12',
      }),
      adapterFactory: () => fakeAdapter({ content: [{ type: 'text', text: 'should not run' }] }),
    };
    const row = await runOne(spec, 'http://example.local/', { includeLive: true, library: 'browser-rs-mcp', timeoutMs: 5000 });
    expect(row.status).toBe('failed');
    expect(row.skipCategory).toBe('none');
    expect(row.failure).toContain('version mismatch');
    expect(row.actualSha256).toBe('a'.repeat(64));
  });

  test('reports browser-rs Chrome/profile/port preflight failures as structured runtime skips', async () => {
    for (const status of ['chrome_missing', 'profile_conflict', 'port_conflict'] as const) {
      const spec: AdapterSpec = {
        library: 'browser-rs-mcp',
        mode: 'a11y-snapshot-stdio',
        liveRequired: true,
        externalPreflight: () => ({
          status,
          binaryPath: '/tmp/browser-rs',
          command: ['/tmp/browser-rs'],
          platformKey: 'linux-x64',
          expectedVersion: '0.1.13',
          actualVersion: '',
          expectedSha256: 'a'.repeat(64),
          actualSha256: '',
          asset: 'browser-rs-linux-x64',
          commit: '6efa54fe428f1203967a9c760a27d0647d5474ee',
          chromePath: '',
          profilePath: '/tmp/browser-rs-profile',
          message: `${status} preflight`,
        }),
        adapterFactory: () => fakeAdapter({ content: [{ type: 'text', text: 'should not run' }] }),
      };
      const row = await runOne(spec, 'http://example.local/', {
        includeLive: true,
        library: 'browser-rs-mcp',
        timeoutMs: 5000,
      });
      expect(row.status).toBe('skipped');
      expect(row.skipCategory).toBe('runtime_missing');
      expect(row.skipReason).toContain(status);
    }
  });

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
