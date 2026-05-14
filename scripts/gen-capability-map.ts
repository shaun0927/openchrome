#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import type { MCPToolDefinition, ToolCapability } from '../src/types/mcp';

export interface CapabilityMapEntry {
  name: string;
  capability: ToolCapability;
  description: string;
}

class CapabilityMapServer {
  readonly definitions: MCPToolDefinition[] = [];

  registerTool(
    _name: string,
    _handler: unknown,
    definition: MCPToolDefinition,
    _options?: unknown,
  ): void {
    this.definitions.push(definition);
  }

  getToolNames(): string[] {
    return this.definitions.map((definition) => definition.name);
  }
}

function installTsRelativeJsResolver(): () => void {
  // Some source files use explicit .js specifiers for ESM-compatible build
  // output. When this generator runs under ts-node, redirect relative .js
  // imports to adjacent .ts source files so the script works pre-build too.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module') as { _resolveFilename: (...args: unknown[]) => string };
  const original = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(this: unknown, request: string, parent: { filename?: string } | undefined, ...rest: unknown[]): string {
    if (request.startsWith('.') && request.endsWith('.js') && parent?.filename) {
      const tsCandidate = path.resolve(path.dirname(parent.filename), request.replace(/\.js$/, '.ts'));
      if (fs.existsSync(tsCandidate)) {
        return original.call(this, tsCandidate, parent, ...rest);
      }
    }
    return original.call(this, request, parent, ...rest);
  } as typeof original;
  return () => {
    Module._resolveFilename = original;
  };
}

function firstLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s+/)[0] || 'No description.';
}

export function collectCapabilityMapEntries(): CapabilityMapEntry[] {
  const restoreResolver = installTsRelativeJsResolver();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    // Runtime require is intentional: the resolver patch above must be active
    // before src/tools/index.ts loads its explicit .js source imports.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerAllTools, TOOL_CAPABILITY_MAP } = require('../src/tools') as typeof import('../src/tools');
    const server = new CapabilityMapServer();
    registerAllTools(server as never);
    return server.definitions
      .map((definition) => ({
        name: definition.name,
        capability: definition.capability ?? TOOL_CAPABILITY_MAP[definition.name] ?? 'core',
        description: firstLine(definition.description),
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability) || a.name.localeCompare(b.name));
  } finally {
    console.error = originalError;
    restoreResolver();
  }
}

export function renderCapabilityMap(entries: CapabilityMapEntry[]): string {
  const groups = new Map<ToolCapability, CapabilityMapEntry[]>();
  for (const entry of entries) {
    if (!groups.has(entry.capability)) groups.set(entry.capability, []);
    groups.get(entry.capability)!.push(entry);
  }
  const lines: string[] = [
    '# OpenChrome Capability Map',
    '',
    '> Generated from `src/tools/index.ts`. Do not edit by hand; run `npm run docs:capability-map`.',
    '',
    `Total tools: ${entries.length}`,
    '',
  ];
  for (const capability of Array.from(groups.keys()).sort()) {
    lines.push(`## ${capability}`, '');
    for (const entry of groups.get(capability)!) {
      lines.push(`- \`${entry.name}\` — ${entry.description}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function writeCapabilityMap(outputPath = path.join('docs', 'agent', 'capability-map.md')): string {
  const content = renderCapabilityMap(collectCapabilityMapEntries());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
  return content;
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputPath = path.join('docs', 'agent', 'capability-map.md');
  const content = renderCapabilityMap(collectCapabilityMapEntries());
  if (check) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (current !== content) {
      console.error('Capability map is out of date. Run npm run docs:capability-map.');
      process.exit(1);
    }
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
}

if (require.main === module) {
  main();
}
