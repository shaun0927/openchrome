#!/usr/bin/env node
/**
 * lint-tool-schemas.mjs
 *
 * Validates MCP tool schema shapes against apify-mcp-server conventions:
 *   1. description.length <= DESCRIPTION_MAX (default 500)
 *   2. Each input property description.length <= FIELD_DESCRIPTION_MAX (default 300)
 *   3. Each enum property: JSON.stringify(values).length <= ENUM_TOTAL_MAX (default 2000)
 *   4. Each required input property description starts with "REQUIRED " (uppercase, single space)
 *   5. Tool name matches ^[a-z][a-z0-9_]{2,63}$
 *   6. No duplicate tool names
 *
 * Usage:
 *   node scripts/lint-tool-schemas.mjs <tools-list.json|-> [--update-baseline]
 *
 * The script reads violations from scripts/lint-tool-schemas.baseline.json
 * (an allowlist of known violations). Only violations NOT in the baseline cause
 * non-zero exit. With --update-baseline the baseline is rewritten, but the
 * script refuses to grow the total violation count (one-way ratchet).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── configurable limits ────────────────────────────────────────────────────
const DESCRIPTION_MAX = parseInt(process.env.OPENCHROME_LINT_DESCRIPTION_MAX || '500', 10);
const FIELD_DESCRIPTION_MAX = 300;
const ENUM_TOTAL_MAX = 2000;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

const BASELINE_PATH = resolve(__dirname, 'lint-tool-schemas.baseline.json');

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}


// ── parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const inputFile = args.find((a) => !a.startsWith('--'));

if (!inputFile) {
  process.stderr.write('Usage: node scripts/lint-tool-schemas.mjs <tools-list.json|-> [--update-baseline]\n');
  process.exit(2);
}

// ── load tools list ────────────────────────────────────────────────────────
let tools;
try {
  tools = JSON.parse(inputFile === '-' ? await readStdin() : readFileSync(resolve(inputFile), 'utf8'));
} catch (err) {
  process.stderr.write(`Error reading tools list: ${err.message}\n`);
  process.exit(2);
}

if (!Array.isArray(tools)) {
  process.stderr.write('Tools list must be a JSON array\n');
  process.exit(2);
}

// ── load baseline ──────────────────────────────────────────────────────────
let baseline = [];
const baselineExists = existsSync(BASELINE_PATH);
if (baselineExists) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error reading baseline: ${err.message}\n`);
    process.exit(2);
  }
}

// Build a Set of baseline keys for O(1) lookup: "tool:field:rule"
const baselineSet = new Set(baseline.map((e) => `${e.tool}:${e.field}:${e.rule}`));

// ── run checks ─────────────────────────────────────────────────────────────
/**
 * @typedef {{ tool: string, field: string, rule: string, value: number|string, limit: number|string }} Violation
 */

/** @type {Violation[]} */
const allViolations = [];

const seenNames = new Map(); // name -> first-seen index

for (const tool of tools) {
  const name = tool.name || '(unnamed)';

  // Rule 5: name regex
  if (!TOOL_NAME_RE.test(name)) {
    allViolations.push({ tool: name, field: 'name', rule: 'name_pattern', value: name, limit: TOOL_NAME_RE.toString() });
  }

  // Rule 6: duplicate names
  if (seenNames.has(name)) {
    allViolations.push({ tool: name, field: 'name', rule: 'duplicate_name', value: name, limit: 'unique' });
  } else {
    seenNames.set(name, true);
  }

  // Rule 1: tool description length
  const desc = typeof tool.description === 'string' ? tool.description : '';
  if (desc.length > DESCRIPTION_MAX) {
    allViolations.push({ tool: name, field: 'description', rule: 'description_length', value: desc.length, limit: DESCRIPTION_MAX });
  }

  // Per-property checks
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  for (const [fieldName, fieldDef] of Object.entries(properties)) {
    if (!fieldDef || typeof fieldDef !== 'object') continue;

    const fieldDesc = typeof fieldDef.description === 'string' ? fieldDef.description : '';

    // Rule 2: field description length
    if (fieldDesc.length > FIELD_DESCRIPTION_MAX) {
      allViolations.push({ tool: name, field: fieldName, rule: 'field_description_length', value: fieldDesc.length, limit: FIELD_DESCRIPTION_MAX });
    }

    // Rule 3: enum total length
    const enumValues = fieldDef.enum;
    if (Array.isArray(enumValues)) {
      const enumLen = JSON.stringify(enumValues).length;
      if (enumLen > ENUM_TOTAL_MAX) {
        allViolations.push({ tool: name, field: fieldName, rule: 'enum_total_length', value: enumLen, limit: ENUM_TOTAL_MAX });
      }
    }

    // Rule 4: REQUIRED prefix on required fields
    if (required.has(fieldName)) {
      if (!fieldDesc.startsWith('REQUIRED ')) {
        allViolations.push({ tool: name, field: fieldName, rule: 'required_prefix', value: fieldDesc.slice(0, 40) || '(empty)', limit: 'REQUIRED ' });
      }
    }
  }
}

// ── compute new violations (not in baseline) ───────────────────────────────
const newViolations = allViolations.filter(
  (v) => !baselineSet.has(`${v.tool}:${v.field}:${v.rule}`)
);

// ── --update-baseline mode ─────────────────────────────────────────────────
if (updateBaseline) {
  const prevCount = baseline.length;
  const newCount = allViolations.length;

  // Ratchet: refuse to grow the baseline once it exists. On the very first
  // run (no baseline file yet) we bootstrap from zero and accept whatever is
  // present so the repo can adopt this lint without a separate bootstrap step.
  if (baselineExists && newCount > prevCount) {
    process.stderr.write(
      `refused: would grow baseline from ${prevCount} to ${newCount} entries (+${newCount - prevCount}). Fix new violations before running --update-baseline.\n`
    );
    process.exit(1);
  }

  // Write new baseline (sorted for determinism)
  const sorted = [...allViolations].sort((a, b) => {
    const ka = `${a.tool}:${a.field}:${a.rule}`;
    const kb = `${b.tool}:${b.field}:${b.rule}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n');
  process.stderr.write(
    `baseline updated: ${sorted.length} entries (was ${prevCount}, delta ${sorted.length - prevCount})\n`
  );
  process.exit(0);
}

// ── report ─────────────────────────────────────────────────────────────────
for (const v of newViolations) {
  process.stdout.write(`FAIL ${v.tool}:${v.field}:${v.rule}:${v.value}:${v.limit}\n`);
}

if (newViolations.length > 0) {
  process.stderr.write(
    `lint-tool-schemas: ${newViolations.length} new violation(s) (${allViolations.length} total, ${baseline.length} baselined)\n`
  );
  process.exit(1);
}

process.stderr.write(
  `lint-tool-schemas: OK — ${allViolations.length} baselined violation(s), 0 new\n`
);
process.exit(0);
