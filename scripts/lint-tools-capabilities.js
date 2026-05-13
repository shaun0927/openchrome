#!/usr/bin/env node
'use strict';

/**
 * lint:tools-capabilities (#829)
 *
 * Verifies that every tool registered via registerAllTools() has an entry in
 * TOOL_CAPABILITY_MAP (src/tools/index.ts) and therefore gets a `capability`
 * field on its MCPToolDefinition.
 *
 * Fails with exit code 1 if any registered tool name is missing from the map.
 *
 * Usage: node scripts/lint-tools-capabilities.js
 *        npm run lint:tools-capabilities
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TOOLS_INDEX = path.join(ROOT, 'src', 'tools', 'index.ts');

// ---------------------------------------------------------------------------
// Parse TOOL_CAPABILITY_MAP from the TypeScript source via simple regex.
// We do not compile the TS here — the map is a plain object literal with
// string keys so a regex scan is reliable and fast.
// ---------------------------------------------------------------------------

function parseCapabilityMap(src) {
  // Match the TOOL_CAPABILITY_MAP object literal
  const mapMatch = src.match(/export const TOOL_CAPABILITY_MAP[^=]*=\s*\{([^}]+)\}/s);
  if (!mapMatch) {
    throw new Error('Could not find TOOL_CAPABILITY_MAP in src/tools/index.ts');
  }

  const body = mapMatch[1];
  const entries = {};
  // Match lines like:  navigate: 'core',
  const lineRe = /^\s+(\w+):\s*'(\w+)',?/gm;
  let m;
  while ((m = lineRe.exec(body)) !== null) {
    entries[m[1]] = m[2];
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Parse the list of tools that are actually registered by scanning for
// server.registerTool( calls in all src/**/*.ts production sources.
//
// Two call patterns exist:
//   1. server.registerTool('literal_name', ...)
//   2. server.registerTool(someVar.name, ...)  — name defined elsewhere as name: 'literal'
//
// For pattern 2 we also scan the file for MCPToolDefinition `name:` fields.
// ---------------------------------------------------------------------------

function collectRegisteredSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'index.ts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRegisteredSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      if (/\.registerTool\(/.test(src)) {
        out.push({ file: full, src });
      }
    }
  }
  return out;
}

function collectRegisteredToolNames() {
  const files = collectRegisteredSourceFiles(path.join(ROOT, 'src'));

  const names = new Set();

  // Pattern 1: .registerTool('literal_name', ...)
  const literalRe = /\.registerTool\(\s*['"](\w+)['"]/g;

  // Pattern 2: name: 'tool_name'  (inside MCPToolDefinition objects)
  // We capture all name: 'value' assignments in files that also call registerTool
  const nameFieldRe = /^\s+name:\s*['"](\w+)['"]/gm;

  for (const { src } of files) {

    // Pattern 1: direct `name: 'value'` inside a registerTool() definition.
    literalRe.lastIndex = 0;
    let m;
    while ((m = literalRe.exec(src)) !== null) {
      names.add(m[1]);
    }

    // Pattern 2: if file uses .registerTool(varExpr.name, ...) scan for name: 'value'
    if (/\.registerTool\(\s*\w+\.\w+/.test(src)) {
      nameFieldRe.lastIndex = 0;
      while ((m = nameFieldRe.exec(src)) !== null) {
        names.add(m[1]);
      }
    }
  }

  return names;
}

function main() {
  let indexSrc;
  try {
    indexSrc = fs.readFileSync(TOOLS_INDEX, 'utf8');
  } catch (err) {
    console.error(`lint:tools-capabilities: cannot read ${TOOLS_INDEX}: ${err.message}`);
    process.exit(1);
  }

  let capMap;
  try {
    capMap = parseCapabilityMap(indexSrc);
  } catch (err) {
    console.error(`lint:tools-capabilities: ${err.message}`);
    process.exit(1);
  }

  const registered = collectRegisteredToolNames();

  const missing = [];
  for (const name of [...registered].sort()) {
    if (!(name in capMap)) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.error('lint:tools-capabilities FAILED');
    console.error(`The following ${missing.length} tool(s) are registered but have no entry in TOOL_CAPABILITY_MAP:`);
    for (const name of missing) {
      console.error(`  - ${name}`);
    }
    console.error('\nAdd each tool to TOOL_CAPABILITY_MAP in src/tools/index.ts.');
    process.exit(1);
  }

  const mapKeys = Object.keys(capMap).sort();
  const unregistered = mapKeys.filter(k => k !== 'expand_tools' && !registered.has(k));
  if (unregistered.length > 0) {
    console.warn('lint:tools-capabilities WARNING: TOOL_CAPABILITY_MAP has entries for unregistered tools:');
    for (const name of unregistered) {
      console.warn(`  - ${name}`);
    }
  }

  const total = registered.size;
  console.log(`lint:tools-capabilities OK — ${total} tool(s) all have capability tags (${Object.keys(capMap).length} entries in map).`);
  process.exit(0);
}

main();
