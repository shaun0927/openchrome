/**
 * Aggregator behaviour (issue #836):
 *   - records every tool call to the JSONL envelope file
 *   - writes a header + footer around the .ts file for snippet-bearing tools
 *   - emits no .ts content when the format is mcp-replay
 *   - partitions output by session id
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodegenAggregator,
  parseCodegenFormat,
  setCodegenAggregator,
  getCodegenAggregator,
} from '../../../src/core/codegen/aggregator';

describe('CodegenAggregator', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-aggregator-'));
  });

  afterEach(() => {
    setCodegenAggregator(null);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('records JSONL envelopes for every tool call, regardless of supported set', () => {
    const agg = new CodegenAggregator({
      format: 'puppeteer',
      outputDir: tmpRoot,
      sessionId: 'sess-A',
    });
    agg.recordToolCall('navigate', { url: 'https://example.com' });
    agg.recordToolCall('cookies', { action: 'list' });
    agg.recordToolCall('tabs_close', { tabIds: ['t1'] });
    agg.close();

    const jsonl = fs.readFileSync(agg.jsonlFilePath, 'utf8');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ tool: 'navigate', args: { url: 'https://example.com' } });
    expect(lines[1]).toMatchObject({ tool: 'cookies', args: { action: 'list' } });
    expect(lines[2]).toMatchObject({ tool: 'tabs_close', args: { tabIds: ['t1'] } });
    for (const entry of lines) {
      expect(typeof entry.ts).toBe('number');
    }
  });

  it('writes Puppeteer header + footer when at least one snippet is emitted', () => {
    const agg = new CodegenAggregator({
      format: 'puppeteer',
      outputDir: tmpRoot,
      sessionId: 'sess-B',
    });
    agg.recordToolCall('navigate', { url: 'https://example.com' });
    agg.recordToolCall('cookies', { action: 'list' }); // non-9, no snippet
    agg.close();

    expect(agg.scriptPath).not.toBeNull();
    const ts = fs.readFileSync(agg.scriptPath as string, 'utf8');
    expect(ts).toContain("import puppeteer from 'puppeteer-core';");
    expect(ts).toContain('await page.goto("https://example.com"');
    expect(ts).toContain('main().catch');
    // ends with a closing brace + newline (the footer's last line)
    expect(ts.trimEnd()).toMatch(/\}\);$/);
  });

  it('writes Playwright header + footer when format is playwright', () => {
    const agg = new CodegenAggregator({
      format: 'playwright',
      outputDir: tmpRoot,
      sessionId: 'sess-C',
    });
    agg.recordToolCall('navigate', { url: 'https://example.com' });
    agg.close();

    const ts = fs.readFileSync(agg.scriptPath as string, 'utf8');
    expect(ts).toContain("import { chromium } from 'playwright';");
    expect(ts).toContain('chromium.connectOverCDP');
  });

  it('emits no .ts file at all under mcp-replay format', () => {
    const agg = new CodegenAggregator({
      format: 'mcp-replay',
      outputDir: tmpRoot,
      sessionId: 'sess-D',
    });
    expect(agg.scriptPath).toBeNull();
    agg.recordToolCall('navigate', { url: 'https://example.com' });
    agg.close();
    const tsCandidate = path.join(tmpRoot, 'sess-D.ts');
    expect(fs.existsSync(tsCandidate)).toBe(false);
    const jsonl = fs.readFileSync(agg.jsonlFilePath, 'utf8');
    expect(jsonl.trim().split('\n')).toHaveLength(1);
  });

  it('partitions output files by session id', () => {
    const a = new CodegenAggregator({ format: 'puppeteer', outputDir: tmpRoot, sessionId: 'alpha' });
    const b = new CodegenAggregator({ format: 'puppeteer', outputDir: tmpRoot, sessionId: 'bravo' });
    a.recordToolCall('navigate', { url: 'https://a.test/' });
    b.recordToolCall('navigate', { url: 'https://b.test/' });
    a.close();
    b.close();
    expect(fs.readFileSync(path.join(tmpRoot, 'alpha.ts'), 'utf8')).toContain('https://a.test/');
    expect(fs.readFileSync(path.join(tmpRoot, 'bravo.ts'), 'utf8')).toContain('https://b.test/');
  });

  it('buildReplay returns null for unsupported tools and respects mcp-replay format', () => {
    const pup = new CodegenAggregator({ format: 'puppeteer', outputDir: tmpRoot, sessionId: 'r1' });
    expect(pup.buildReplay('navigate', { url: 'https://example.com' })).toMatchObject({
      tool: 'navigate',
      puppeteer_snippet: expect.stringContaining('page.goto'),
    });
    expect(pup.buildReplay('cookies', { action: 'list' })).toBeNull();

    const mcp = new CodegenAggregator({ format: 'mcp-replay', outputDir: tmpRoot, sessionId: 'r2' });
    expect(mcp.buildReplay('navigate', { url: 'https://example.com' })).toBeNull();
  });

  it('parseCodegenFormat normalises CLI input', () => {
    expect(parseCodegenFormat(undefined)).toBe('off');
    expect(parseCodegenFormat('off')).toBe('off');
    expect(parseCodegenFormat('PUPPETEER')).toBe('puppeteer');
    expect(parseCodegenFormat('playwright')).toBe('playwright');
    expect(parseCodegenFormat('mcp-replay')).toBe('mcp-replay');
    expect(parseCodegenFormat('garbage')).toBe('off');
  });

  it('setCodegenAggregator/getCodegenAggregator round-trip', () => {
    expect(getCodegenAggregator()).toBeNull();
    const agg = new CodegenAggregator({ format: 'mcp-replay', outputDir: tmpRoot, sessionId: 'slot' });
    setCodegenAggregator(agg);
    expect(getCodegenAggregator()).toBe(agg);
    setCodegenAggregator(null);
    expect(getCodegenAggregator()).toBeNull();
  });
});
