/// <reference types="jest" />

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '../..');
const docPath = path.join(repoRoot, 'docs/getting-started/http-daemon.md');
const readmePath = path.join(repoRoot, 'README.md');
const architecturePath = path.join(repoRoot, 'docs/architecture.md');
const sourceRoots = ['src'];

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function collectSourceText(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        chunks.push(fs.readFileSync(fullPath, 'utf8'));
      }
    }
  };

  for (const root of sourceRoots) {
    walk(path.join(repoRoot, root));
  }
  return chunks.join('\n');
}

function uniqueMatches(pattern: RegExp, text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(pattern), match => match[1]))).sort();
}

describe('HTTP daemon documentation', () => {
  const doc = fs.readFileSync(docPath, 'utf8');
  const sourceText = collectSourceText();

  it('keeps README and architecture cross-links to the daemon guide', () => {
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('docs/getting-started/http-daemon.md');
    expect(fs.readFileSync(architecturePath, 'utf8')).toContain('docs/getting-started/http-daemon.md');
  });

  it('keeps the required operator sections in the issue contract order', () => {
    const requiredHeadings = [
      '## 1. When to choose stdio vs http vs both',
      '## 2. Flag and environment-variable reference',
      '## 3. Multi-client scenario',
      '## 4. Security model',
      '## 5. Copy-pasteable curl recipe',
      '## 6. Idle-timeout behaviour',
      '## 7. Dashboard endpoint',
      '## 8. Troubleshooting',
    ];

    let previousIndex = -1;
    for (const heading of requiredHeadings) {
      const index = doc.indexOf(heading);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it('mentions only flags, env vars, and endpoints backed by source symbols', () => {
    const flags = uniqueMatches(/`(--[a-z0-9-]+)(?:\s[^`]*)?`/g, doc);
    const envVars = uniqueMatches(/`(OPENCHROME_[A-Z0-9_]+)(?:=[^`]*)?`/g, doc);
    const endpoints = uniqueMatches(/`(?:GET |POST |DELETE )?(\/[a-z0-9_\-/]+)`/g, doc);

    expect(flags).toEqual([
      '--allow-unauthenticated-http',
      '--auth-token',
      '--http',
      '--http-host',
      '--idle-timeout',
      '--transport',
    ]);
    expect(envVars).toEqual([
      'OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP',
      'OPENCHROME_AUTH_TOKEN',
      'OPENCHROME_HEALTH_BIND',
      'OPENCHROME_HEALTH_ENDPOINT',
      'OPENCHROME_HEALTH_PORT',
      'OPENCHROME_HTTP_HOST',
      'OPENCHROME_HTTP_PORT',
      'OPENCHROME_IDLE_TIMEOUT_MS',
      'OPENCHROME_PPID_WATCH',
      'OPENCHROME_PPID_WATCH_INTERVAL_MS',
      'OPENCHROME_TRANSPORT',
    ]);
    expect(endpoints).toEqual(['/api/tool-calls', '/health', '/mcp', '/metrics']);

    for (const token of [...flags, ...envVars, ...endpoints]) {
      expect(sourceText).toContain(token);
    }
  });
});
