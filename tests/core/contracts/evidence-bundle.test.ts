/// <reference types="jest" />

/**
 * Tests for the evidence bundle helper (issue #792).
 *
 * Covers:
 *  - default include = ['dom', 'screenshot']
 *  - each include flag in isolation
 *  - missing inputs fall through gracefully (no thrown error, empty `parts`)
 *  - network slice respects `network_window_ms`
 *  - console slice keeps the most recent N entries
 *  - phash produces a 16-char lowercase hex digest
 *  - corrupt PNG does not abort the bundle when phash is requested
 *
 * Filesystem isolation: every test points `rootDir` at a unique tmp dir so
 * runs cannot collide.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_INCLUDE,
  DEFAULT_NETWORK_WINDOW_MS,
  defaultEvidenceRootDir,
  writeEvidenceBundle,
} from '../../../src/core/contracts/evidence-bundle';
import { encodeRgbaPng, gradientRgba } from '../../contracts/png-fixtures';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-bundle-test-'));
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('writeEvidenceBundle — defaults', () => {
  test('DEFAULT_INCLUDE is [dom, screenshot]', () => {
    expect([...DEFAULT_INCLUDE].sort()).toEqual(['dom', 'screenshot']);
  });

  test('DEFAULT_NETWORK_WINDOW_MS is 5000', () => {
    expect(DEFAULT_NETWORK_WINDOW_MS).toBe(5000);
  });

  test('defaultEvidenceRootDir lives under os.tmpdir()', () => {
    expect(defaultEvidenceRootDir().startsWith(os.tmpdir())).toBe(true);
  });

  test('default include captures dom + screenshot when both supplied', () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(8, 8, gradientRgba(8, 8));
    const result = writeEvidenceBundle(
      { dom: '<html>hi</html>', screenshot_png: png },
      { rootDir },
    );

    expect(result.bundle_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.path.startsWith(rootDir)).toBe(true);
    expect(result.parts.sort()).toEqual(['dom.json', 'screenshot.png']);
    expect(result.size_bytes).toBeGreaterThan(0);

    const domPath = path.join(result.path, 'dom.json');
    expect(fs.existsSync(domPath)).toBe(true);
    expect(readJson(domPath)).toEqual({ format: 'html', html: '<html>hi</html>' });

    const screenshotPath = path.join(result.path, 'screenshot.png');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    expect(fs.statSync(screenshotPath).size).toBe(png.length);
  });
});

describe('writeEvidenceBundle — individual include flags', () => {
  test("include=['dom']: writes only dom.json", () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle({ dom: { nodes: 3 } }, { rootDir, include: ['dom'] });
    expect(result.parts).toEqual(['dom.json']);
    expect(readJson(path.join(result.path, 'dom.json'))).toEqual({ nodes: 3 });
  });

  test("include=['screenshot']: writes only screenshot.png", () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(4, 4, gradientRgba(4, 4));
    const result = writeEvidenceBundle(
      { screenshot_png: png },
      { rootDir, include: ['screenshot'] },
    );
    expect(result.parts).toEqual(['screenshot.png']);
    expect(fs.statSync(path.join(result.path, 'screenshot.png')).size).toBe(png.length);
  });

  test("include=['screenshot']: accepts base64-encoded PNG", () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(4, 4, gradientRgba(4, 4));
    const result = writeEvidenceBundle(
      { screenshot_png: png.toString('base64') },
      { rootDir, include: ['screenshot'] },
    );
    expect(result.parts).toEqual(['screenshot.png']);
    const written = fs.readFileSync(path.join(result.path, 'screenshot.png'));
    expect(written.equals(png)).toBe(true);
  });

  test("include=['network']: filters by `network_window_ms`", () => {
    const rootDir = mkRoot();
    const now = 1_000_000;
    const entries = [
      { started_at: now - 10_000, url: 'old.com' }, // outside window
      { started_at: now - 1_000, url: 'recent.com' }, // inside window
      { started_at: now - 100, url: 'newest.com' }, // inside window
    ];
    const result = writeEvidenceBundle(
      { network: entries, now_ms: now },
      { rootDir, include: ['network'], networkWindowMs: 5_000 },
    );
    expect(result.parts).toEqual(['network.json']);
    const payload = readJson(path.join(result.path, 'network.json')) as {
      window_ms: number;
      captured_at: number;
      entries: Array<{ url: string }>;
    };
    expect(payload.window_ms).toBe(5_000);
    expect(payload.captured_at).toBe(now);
    expect(payload.entries.map((e) => e.url)).toEqual(['recent.com', 'newest.com']);
  });

  test("include=['console']: keeps the most recent N entries", () => {
    const rootDir = mkRoot();
    const entries = Array.from({ length: 250 }, (_, i) => ({ ts: i, text: `line-${i}` }));
    const result = writeEvidenceBundle(
      { console: entries },
      { rootDir, include: ['console'], consoleMaxEntries: 50 },
    );
    expect(result.parts).toEqual(['console.json']);
    const payload = readJson(path.join(result.path, 'console.json')) as {
      max_entries: number;
      entries: Array<{ text: string }>;
    };
    expect(payload.max_entries).toBe(50);
    expect(payload.entries).toHaveLength(50);
    expect(payload.entries[0].text).toBe('line-200');
    expect(payload.entries[49].text).toBe('line-249');
  });

  test("include=['phash']: writes a 16-char lowercase hex digest", () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const result = writeEvidenceBundle(
      { screenshot_png: png },
      { rootDir, include: ['phash'] },
    );
    expect(result.parts).toEqual(['phash.json']);
    const payload = readJson(path.join(result.path, 'phash.json')) as {
      algorithm: string;
      hash_hex: string;
    };
    expect(payload.algorithm).toBe('dct-ii-8x8');
    expect(payload.hash_hex).toMatch(/^[0-9a-f]{16}$/);
  });

  test("include=['screenshot', 'phash']: both parts written from one PNG", () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(16, 16, gradientRgba(16, 16));
    const result = writeEvidenceBundle(
      { screenshot_png: png },
      { rootDir, include: ['screenshot', 'phash'] },
    );
    expect(result.parts.sort()).toEqual(['phash.json', 'screenshot.png']);
  });
});

describe('writeEvidenceBundle — graceful fallthrough', () => {
  test('no snapshot at all: bundle dir exists but parts is empty', () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle({}, { rootDir });
    expect(result.parts).toEqual([]);
    expect(result.size_bytes).toBe(0);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("include=['phash'] without a screenshot: phash part omitted", () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle({}, { rootDir, include: ['phash'] });
    expect(result.parts).toEqual([]);
  });

  test('include with unknown items: filtered to empty (no defaults applied)', () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle(
      { dom: '<x/>' },
      { rootDir, include: ['bogus' as unknown as 'dom'] },
    );
    expect(result.parts).toEqual([]);
  });

  test('include=[] (empty array): falls back to DEFAULT_INCLUDE', () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(8, 8, gradientRgba(8, 8));
    const result = writeEvidenceBundle(
      { dom: '<x/>', screenshot_png: png },
      { rootDir, include: [] },
    );
    expect(result.parts.sort()).toEqual(['dom.json', 'screenshot.png']);
  });

  test("include=['phash'] with corrupt PNG: phash skipped, no throw", () => {
    const rootDir = mkRoot();
    const corrupt = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = writeEvidenceBundle(
      { screenshot_png: corrupt },
      { rootDir, include: ['phash'] },
    );
    expect(result.parts).toEqual([]);
  });

  test('include=["network"] with no network field: network part omitted', () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle({}, { rootDir, include: ['network'] });
    expect(result.parts).toEqual([]);
  });

  test('network entries without timestamps: kept as recent (within window)', () => {
    const rootDir = mkRoot();
    const result = writeEvidenceBundle(
      { network: [{ url: 'a.com' }, { url: 'b.com' }], now_ms: 1_000_000 },
      { rootDir, include: ['network'], networkWindowMs: 5_000 },
    );
    const payload = readJson(path.join(result.path, 'network.json')) as {
      entries: Array<{ url: string }>;
    };
    expect(payload.entries.map((e) => e.url)).toEqual(['a.com', 'b.com']);
  });
});

describe('writeEvidenceBundle — bundle metadata', () => {
  test('bundle_id is a UUID and uniqueness holds across calls', () => {
    const rootDir = mkRoot();
    const a = writeEvidenceBundle({ dom: 'a' }, { rootDir });
    const b = writeEvidenceBundle({ dom: 'b' }, { rootDir });
    expect(a.bundle_id).not.toBe(b.bundle_id);
    expect(a.bundle_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.bundle_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('size_bytes matches the sum of written file sizes', () => {
    const rootDir = mkRoot();
    const png = encodeRgbaPng(8, 8, gradientRgba(8, 8));
    const result = writeEvidenceBundle(
      { dom: 'hello', screenshot_png: png },
      { rootDir },
    );
    const onDisk = result.parts.reduce(
      (acc, part) => acc + fs.statSync(path.join(result.path, part)).size,
      0,
    );
    expect(result.size_bytes).toBe(onDisk);
  });
});
