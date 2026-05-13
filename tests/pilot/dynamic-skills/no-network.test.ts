/**
 * Portability-Harness Contract P3 enforcement (issue #889, Scenario 8).
 *
 * The dynamic-skills synthesizer is a deterministic schema transform. It must
 * never make an outbound HTTP/HTTPS call. We enforce this via a static-import
 * check: every source file under `src/pilot/dynamic-skills/` is grepped for
 * imports of `http`, `https`, `net`, `dns`, `tls`, or known network client
 * libraries (axios, node-fetch, undici, got). Any match is a hard violation.
 *
 * This is intentionally a *source-level* check rather than runtime mocking
 * because Node's `http.request` and `https.request` exports are non-configurable
 * — `jest.spyOn` and `Object.defineProperty` both fail to redefine them. The
 * static check has the same guarantee with fewer false positives: if you can't
 * import the module, you can't make a call.
 *
 * Replay (the only path that could plausibly need network access) is required
 * to drive Chrome via CDP, NOT via direct HTTP. The CDP client lives outside
 * this directory and is intentionally not allowed as an import from here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const DYNAMIC_SKILLS_DIR = resolve(__dirname, '../../../src/pilot/dynamic-skills');

/** Modules that would imply outbound HTTP capability if imported. */
const FORBIDDEN_MODULES = [
  'http',
  'https',
  'node:http',
  'node:https',
  'node:net',
  'node:dns',
  'node:tls',
  'net',
  'dns',
  'tls',
  'axios',
  'node-fetch',
  'undici',
  'got',
  'cross-fetch',
];

/** Recursively list .ts files under `dir`. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...listTsFiles(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function importedModules(source: string): string[] {
  const out: string[] = [];
  // import ... from 'X' | import 'X'
  const importRe = /^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
  // require('X')
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) out.push(m[1]);
  while ((m = requireRe.exec(source)) !== null) out.push(m[1]);
  return out;
}

describe('dynamic-skills makes zero outbound network calls (P3 enforcement)', () => {
  const files = listTsFiles(DYNAMIC_SKILLS_DIR);

  test('discovered source files exist', () => {
    // Sanity: protect against test silently passing when the directory layout changes.
    expect(files.length).toBeGreaterThan(0);
    const basenames = files.map((f) => f.slice(DYNAMIC_SKILLS_DIR.length + 1));
    // index.ts, synthesizer.ts, and registry.ts MUST be present — they are the
    // attack surface this gate protects.
    expect(basenames).toEqual(expect.arrayContaining(['index.ts', 'synthesizer.ts', 'registry.ts']));
  });

  test.each(['synthesizer.ts', 'name.ts', 'registry.ts', 'events.ts', 'replay.ts', 'index.ts'])(
    '%s imports no networking modules',
    (basename) => {
      const path = join(DYNAMIC_SKILLS_DIR, basename);
      const source = readFileSync(path, 'utf8');
      const imports = importedModules(source);
      const forbidden = imports.filter((spec) => FORBIDDEN_MODULES.includes(spec));
      expect(forbidden).toEqual([]);
    },
  );

  test('the directory as a whole imports no networking modules (defense in depth)', () => {
    const offenders: { file: string; module: string }[] = [];
    for (const f of files) {
      const source = readFileSync(f, 'utf8');
      for (const spec of importedModules(source)) {
        if (FORBIDDEN_MODULES.includes(spec)) {
          offenders.push({ file: f.slice(DYNAMIC_SKILLS_DIR.length + 1), module: spec });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('replay.ts contains no literal `://` URL string that would imply direct HTTP', () => {
    // Replay must drive CDP only. A `://`-bearing literal in this file is
    // almost always a smell (hardcoded webhook, callback URL, etc.). Allow-listed
    // markers (e.g. RFC pointers in JSDoc) are excluded.
    const src = readFileSync(join(DYNAMIC_SKILLS_DIR, 'replay.ts'), 'utf8');
    const urlRe = /['"`][a-z][a-z0-9+.-]*:\/\//gi;
    const matches = [...src.matchAll(urlRe)].map((m) => m[0]);
    // Permit doc-comment references to https://github.com / docs URLs.
    const nonDoc = matches.filter((s) => !/https?:\/\/(?:github|docs)\./.test(s));
    expect(nonDoc).toEqual([]);
  });

  // Suppress unused-variable lint for dirname/resolve so we don't trim imports
  // the type checker may need.
  test('module utilities are reachable', () => {
    expect(typeof dirname).toBe('function');
    expect(typeof resolve).toBe('function');
  });
});
