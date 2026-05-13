/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPServer } from '../../src/mcp-server';
import { registerOcDiffTool } from '../../src/tools/oc-diff';

function writeBundle(root: string, id: string, files: Record<string, unknown>): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
  return dir;
}

function handler(): Function {
  const server = new MCPServer({} as any);
  registerOcDiffTool(server);
  return server.getToolHandler('oc_diff')!;
}

describe('oc_diff', () => {
  test('returns all-zero deterministic fact for identical bundles', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-diff-'));
    const files = {
      'dom.json': { html: '<html><body><p>Hello</p></body></html>', url: 'https://example.test/a' },
      'phash.json': { hash_hex: 'ffff' },
      'console.json': { entries: [{ level: 'error', text: 'same' }] },
      'network.json': { entries: [{ status: 200, url: '/a' }] },
    };
    const a = writeBundle(root, 'a', files);
    const b = writeBundle(root, 'b', files);
    const result = await handler()('session', { before: a, after: b });
    const data = JSON.parse(result.content[0].text);
    expect(data.dom).toMatchObject({ added: 0, removed: 0, modified: 0 });
    expect(data.screenshot).toMatchObject({ phashHamming: 0, totalBits: 16, ratio: 0 });
    expect(data.url.changed).toBe(false);
    expect(data.console.addedMessages).toBe(0);
    expect(data.network.addedRequests).toBe(0);
    expect(result.structuredContent).toEqual(data);
  });

  test('reports changed DOM, URL, console, network, and phash distance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-diff-'));
    const a = writeBundle(root, 'a', {
      'dom.json': { html: '<html><body><button>Old</button></body></html>', url: 'https://example.test/a' },
      'phash.json': { hash_hex: 'ffff' },
      'console.json': { entries: [] },
      'network.json': { entries: [] },
    });
    const b = writeBundle(root, 'b', {
      'dom.json': { html: '<html><body><button>New</button></body></html>', url: 'https://example.test/b' },
      'phash.json': { hash_hex: 'fffe' },
      'console.json': { entries: [{ level: 'error', text: 'boom' }, { level: 'warn', text: 'careful' }] },
      'network.json': { entries: [{ status: 200, url: '/ok' }, { status: 404, url: '/missing' }] },
    });
    const result = await handler()('session', { before: a, after: b, kinds: ['dom', 'screenshot', 'url', 'console', 'network'] });
    const data = JSON.parse(result.content[0].text);
    expect(data.dom.modified).toBeGreaterThan(0);
    expect(data.screenshot.phashHamming).toBe(1);
    expect(data.url).toMatchObject({ changed: true, from: 'https://example.test/a', to: 'https://example.test/b' });
    expect(data.console).toMatchObject({ addedMessages: 2, byLevel: { error: 1, warn: 1 } });
    expect(data.network).toMatchObject({ addedRequests: 2, byStatus: { '200': 1, '404': 1 } });
  });
});
