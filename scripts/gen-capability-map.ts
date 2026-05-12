#!/usr/bin/env ts-node
/**
 * Capability-map generator for openchrome MCP tools.
 *
 * Introspects every tool registered by registerAllTools() in src/tools/index.ts
 * and emits docs/agent/capability-map.md — a compact, drift-guarded preamble
 * (~2–6 KB) that MCP clients can prepend to their system prompt.
 *
 * Why expand_tools is excluded:
 *   expand_tools is a synthetic, server-injected tool defined inline in
 *   src/mcp-server.ts (see the handleToolsList method). It is NOT registered
 *   via registerTool() and therefore never appears in the tool registry that
 *   registerAllTools() populates. It is a progressive-disclosure hint, not a
 *   stable MCP tool, and would mislead agents if included in the preamble.
 *
 * Pilot-only tools (oc_pilot_handoff_create, oc_pilot_handoff_redeem) are
 * registered by bootstrapPilot() via dynamic import — not by registerAllTools().
 * Their definitions are exported from src/pilot/handoff/tool.ts and imported
 * here so the generated preamble has a single source of truth.
 *
 * Implementation note:
 *   src/mcp-server.ts imports many heavy runtime modules (puppeteer-core,
 *   Chrome launcher, dashboard, etc.) that are not available in the generator
 *   context. We inject a minimal stub for 'src/mcp-server' into the Node
 *   require cache before loading the tool modules, so registerAllTools() works
 *   without requiring a running Chrome instance or built artifacts.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Minimal MCPToolDefinition type (mirrors src/types/mcp.ts).
// We define it inline so this script does not import from src/types/mcp.ts
// (which is safe, but keeps the dependency surface explicit).
// ---------------------------------------------------------------------------
interface InputSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

interface ToolDefinition {
  name: string;
  description: string;
  category?: string;
  inputSchema: InputSchema;
}

// ---------------------------------------------------------------------------
// Stub MCPServer class — satisfies the interface expected by registerAllTools.
// Only registerTool and getToolNames are used; everything else is a no-op.
// ---------------------------------------------------------------------------
class StubMCPServer {
  private _tools: Map<string, ToolDefinition> = new Map();

  registerTool(name: string, _handler: unknown, definition: ToolDefinition): void {
    this._tools.set(name, definition);
  }

  getToolNames(): string[] {
    return Array.from(this._tools.keys());
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this._tools.values());
  }
}

// ---------------------------------------------------------------------------
// Inject stub into require cache before tool modules are loaded.
// This prevents ts-node from trying to resolve src/mcp-server.ts and its
// heavy transitive dependencies (puppeteer-core, CDP, dashboard, etc.).
// ---------------------------------------------------------------------------
function injectMCPServerStub(): void {
  const stubModule = {
    id: 'stub:mcp-server',
    filename: 'stub:mcp-server',
    loaded: true,
    parent: null,
    children: [],
    paths: [],
    exports: { MCPServer: StubMCPServer },
    require: require,
    // Node ≥18: Module._extensions needs .id on the object
  };

  // Resolve the real mcp-server path so we can key the cache correctly.
  // ts-node resolves .ts files, so we look up the .ts path.
  const serverTsPath = path.resolve(__dirname, '..', 'src', 'mcp-server.ts');
  const serverJsPath = path.resolve(__dirname, '..', 'src', 'mcp-server.js');

  // Inject into require.cache under both possible keys
  (require as NodeJS.Require & { cache: Record<string, unknown> }).cache[serverTsPath] =
    stubModule as unknown as NodeJS.Module;
  (require as NodeJS.Require & { cache: Record<string, unknown> }).cache[serverJsPath] =
    stubModule as unknown as NodeJS.Module;
}

// ---------------------------------------------------------------------------
// Tool collection
// ---------------------------------------------------------------------------
function collectStandardTools(): ToolDefinition[] {
  injectMCPServerStub();

  // Now safe to require tool index — it will use the stub MCPServer
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerAllTools } = require('../src/tools/index') as {
    registerAllTools: (server: StubMCPServer) => void;
  };

  const server = new StubMCPServer();
  registerAllTools(server);
  return server.getDefinitions();
}

/**
 * Pilot-only tools registered by bootstrapPilot(), not registerAllTools().
 * Import their exported definitions directly to avoid metadata drift.
 */
function collectPilotTools(): ToolDefinition[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PILOT_HANDOFF_TOOL_DEFINITIONS } = require('../src/pilot/handoff/definitions') as {
    PILOT_HANDOFF_TOOL_DEFINITIONS: readonly ToolDefinition[];
  };
  return [...PILOT_HANDOFF_TOOL_DEFINITIONS];
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------
function categoryOf(def: ToolDefinition): string {
  return def.category ?? 'misc';
}

function formatParams(def: ToolDefinition): string {
  const props = def.inputSchema?.properties ?? {};
  const required = new Set(def.inputSchema?.required ?? []);
  return Object.entries(props)
    .map(([name, schema]) => {
      const s = schema as Record<string, unknown>;
      const type = typeof s.type === 'string' ? s.type : 'any';
      return required.has(name) ? `${name}:${type}` : `${name}?:${type}`;
    })
    .join(', ');
}

const CATEGORY_ORDER: string[] = [
  'dom',
  'evidence',
  'forms',
  'interact',
  'js',
  'lifecycle',
  'misc',
  'navigation',
  'observability',
  'pilot',
  'profile',
  'recording',
  'storage',
  'tabs',
];

function truncateDesc(desc: string, maxLen: number): string {
  const oneLine = desc.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}

function buildMarkdown(
  tools: ToolDefinition[],
  includeParams: boolean,
  descMaxLen: number = Infinity
): string {
  const sorted = [...tools].sort((a, b) => {
    const ca = categoryOf(a);
    const cb = categoryOf(b);
    if (ca !== cb) return ca.localeCompare(cb);
    return a.name.localeCompare(b.name);
  });

  const grouped = new Map<string, ToolDefinition[]>();
  for (const def of sorted) {
    const cat = categoryOf(def);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(def);
  }

  const categoryKeys = [
    ...CATEGORY_ORDER.filter(c => grouped.has(c)),
    ...[...grouped.keys()].filter(c => !CATEGORY_ORDER.includes(c)).sort(),
  ];

  const lines: string[] = [
    '<!-- generated by scripts/gen-capability-map.ts from src/tools/index.ts — do not edit -->',
    '# openchrome MCP tools (auto-generated)',
    '',
  ];

  for (const cat of categoryKeys) {
    const catTools = grouped.get(cat) ?? [];
    lines.push(`## ${cat}`);
    for (const def of catTools) {
      const pilotMarker = categoryOf(def) === 'pilot' ? ' — pilot' : '';
      const desc = truncateDesc(def.description, descMaxLen);
      lines.push(`- \`${def.name}\`${pilotMarker}: ${desc}`);
      if (includeParams) {
        const params = formatParams(def);
        if (params) {
          lines.push(`  - params: \`${params}\``);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'agent', 'capability-map.md');
const MAX_BYTES = 6144;

function main(): void {
  const standardTools = collectStandardTools();
  const pilotTools = collectPilotTools();
  const allTools = [...standardTools, ...pilotTools];

  // Progressive fallback to stay within MAX_BYTES:
  // 1. Full output with params sub-lines
  // 2. Drop params, keep full descriptions
  // 3. Drop params, truncate descriptions to 120 chars
  // 4. Drop params, truncate descriptions to 80 chars
  // 5. Drop params, truncate descriptions to 40 chars
  // 6. Drop params, truncate descriptions to 30 chars
  const attempts: Array<[boolean, number]> = [
    [true, Infinity],
    [false, Infinity],
    [false, 120],
    [false, 80],
    [false, 40],
    [false, 30],
  ];

  let content = '';
  for (const [includeParams, descMaxLen] of attempts) {
    content = buildMarkdown(allTools, includeParams, descMaxLen);
    if (Buffer.byteLength(content, 'utf8') <= MAX_BYTES) break;
  }

  const byteSize = Buffer.byteLength(content, 'utf8');
  if (byteSize > MAX_BYTES) {
    throw new Error(
      `capability-map.md exceeds ${MAX_BYTES} bytes (got ${byteSize}) even after truncation. ` +
        `The tool count or description lengths are too large.`
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, content, 'utf8');
  console.error(
    `[gen-capability-map] Wrote ${byteSize} bytes to ${path.relative(process.cwd(), OUTPUT_PATH)}`
  );
}

main();
