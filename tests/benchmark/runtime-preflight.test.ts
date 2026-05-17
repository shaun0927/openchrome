/// <reference types="jest" />

import { parseRuntimePreflightArgs, runRuntimePreflight } from './runtime-preflight';

describe('runtime preflight', () => {
  test('parses runtime flags and defaults', () => {
    const opts = parseRuntimePreflightArgs(['--cdp-endpoint=http://127.0.0.1:9333', '--require-live']);
    expect(opts.cdpEndpoint).toBe('http://127.0.0.1:9333');
    expect(opts.requireLive).toBe(true);
  });

  test('emits explicit rows for every required external runtime', async () => {
    const rows = await runRuntimePreflight(parseRuntimePreflightArgs(['--cdp-endpoint=http://127.0.0.1:9']));
    expect(rows.map((row) => row.runtime).sort()).toEqual(['browser-use', 'chrome-cdp', 'llm-api-key', 'playwright-mcp'].sort());
    expect(rows.find((row) => row.runtime === 'chrome-cdp')?.status).toBe('missing');
    expect(rows.every((row) => row.requiredFor.length > 0)).toBe(true);
  });
});
