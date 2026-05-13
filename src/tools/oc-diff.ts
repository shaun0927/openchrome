/** oc_diff — deterministic diff of two evidence bundles (#832). */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { defaultEvidenceRootDir } from '../core/contracts/evidence-bundle';
import { diffDom, normalizeDomInput } from '../core/contracts/dom-normalize';
import { hammingDistance } from '../core/perception/cache';
import { getMetricsCollector } from '../metrics/collector';

const VALID_KINDS = ['dom', 'screenshot', 'url', 'console', 'network'] as const;
type DiffKind = typeof VALID_KINDS[number];

const definition: MCPToolDefinition = {
  name: 'oc_diff',
  annotations: TOOL_ANNOTATIONS.oc_diff,
  description: 'Compare two evidence-bundle IDs or paths and return deterministic DOM, screenshot phash, URL, console, and network diff facts.',
  inputSchema: {
    type: 'object',
    properties: {
      before: { type: 'string', description: 'REQUIRED Before evidence bundle ID or absolute bundle path.' },
      after: { type: 'string', description: 'REQUIRED After evidence bundle ID or absolute bundle path.' },
      kinds: {
        type: 'array',
        description: 'Kinds to compare. Default: dom, screenshot, url, console, network.',
        items: { type: 'string', enum: VALID_KINDS as unknown as string[] },
      },
    },
    required: ['before', 'after'],
  },
  outputSchema: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'] },
};

function recordDiff(kind: string, domEntries?: number): void {
  try {
    const metrics = getMetricsCollector();
    metrics.inc('openchrome_diff_total', { kind });
    if (kind === 'dom' && typeof domEntries === 'number') metrics.observe('openchrome_diff_dom_entries', {}, domEntries);
  } catch { /* best-effort */ }
}

function parseKinds(raw: unknown): DiffKind[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...VALID_KINDS];
  return raw.filter((kind): kind is DiffKind => typeof kind === 'string' && (VALID_KINDS as readonly string[]).includes(kind));
}

function bundlePath(idOrPath: string): string { return path.isAbsolute(idOrPath) ? idOrPath : path.join(defaultEvidenceRootDir(), idOrPath); }
function readJson(file: string): unknown | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readDom(dir: string): unknown | null { return readJson(path.join(dir, 'dom.json')); }
function extractUrl(dom: unknown): string | null {
  if (!dom || typeof dom !== 'object') return null;
  const obj = dom as Record<string, unknown>;
  for (const key of ['url', 'href', 'pageUrl']) if (typeof obj[key] === 'string') return obj[key] as string;
  return null;
}

function diffScreenshot(beforeDir: string, afterDir: string): Record<string, unknown> {
  const before = readJson(path.join(beforeDir, 'phash.json')) as { hash_hex?: unknown } | null;
  const after = readJson(path.join(afterDir, 'phash.json')) as { hash_hex?: unknown } | null;
  const a = typeof before?.hash_hex === 'string' ? before.hash_hex : '';
  const b = typeof after?.hash_hex === 'string' ? after.hash_hex : '';
  if (!a || !b) return { phashHamming: null, totalBits: 64, ratio: null, inconclusive_reason: 'missing phash.json' };
  const distance = hammingDistance(a, b);
  const totalBits = Math.max(a.length, b.length) * 4;
  return { phashHamming: distance, totalBits, ratio: totalBits > 0 ? Math.round((distance / totalBits) * 1000) / 1000 : 0 };
}

function readEntries(dir: string, filename: string): Record<string, unknown>[] {
  const json = readJson(path.join(dir, filename));
  if (!json || typeof json !== 'object') return [];
  const entries = (json as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
}

function stableEntryKey(entry: Record<string, unknown>): string { return JSON.stringify(entry, Object.keys(entry).sort()); }

function diffConsole(beforeDir: string, afterDir: string): Record<string, unknown> {
  const before = new Set(readEntries(beforeDir, 'console.json').map(stableEntryKey));
  const added = readEntries(afterDir, 'console.json').filter((entry) => !before.has(stableEntryKey(entry)));
  const byLevel: Record<string, number> = {};
  for (const entry of added) { const level = typeof entry.level === 'string' ? entry.level : 'unknown'; byLevel[level] = (byLevel[level] || 0) + 1; }
  return { addedMessages: added.length, byLevel };
}

function diffNetwork(beforeDir: string, afterDir: string): Record<string, unknown> {
  const before = new Set(readEntries(beforeDir, 'network.json').map(stableEntryKey));
  const added = readEntries(afterDir, 'network.json').filter((entry) => !before.has(stableEntryKey(entry)));
  const byStatus: Record<string, number> = {};
  for (const entry of added) { const status = typeof entry.status === 'number' ? String(entry.status) : 'unknown'; byStatus[status] = (byStatus[status] || 0) + 1; }
  return { addedRequests: added.length, byStatus };
}

const handler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const before = args.before as string | undefined;
  const after = args.after as string | undefined;
  if (!before || !after) return { content: [{ type: 'text', text: 'Error: before and after are required' }], isError: true };
  const beforeDir = bundlePath(before);
  const afterDir = bundlePath(after);
  const kinds = parseKinds(args.kinds);
  const beforeDom = readDom(beforeDir);
  const afterDom = readDom(afterDir);
  const output: Record<string, unknown> = { before, after };
  if (kinds.includes('dom')) { const dom = diffDom(normalizeDomInput(beforeDom), normalizeDomInput(afterDom)); output.dom = dom; recordDiff('dom', dom.entries.length); }
  if (kinds.includes('screenshot')) { output.screenshot = diffScreenshot(beforeDir, afterDir); recordDiff('screenshot'); }
  if (kinds.includes('url')) { const from = extractUrl(beforeDom); const to = extractUrl(afterDom); output.url = { changed: from !== to, from, to }; recordDiff('url'); }
  if (kinds.includes('console')) { output.console = diffConsole(beforeDir, afterDir); recordDiff('console'); }
  if (kinds.includes('network')) { output.network = diffNetwork(beforeDir, afterDir); recordDiff('network'); }
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
};

export function registerOcDiffTool(server: MCPServer): void { server.registerTool(definition.name, handler, definition); }
