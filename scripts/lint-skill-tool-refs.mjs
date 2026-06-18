#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const skillPath = process.argv[2] ?? 'skills/openchrome/SKILL.md';
const toolIndexPath = 'src/tools/index.ts';

function fail(message) {
  console.error(`[lint-skill-tool-refs] ${message}`);
  process.exitCode = 1;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const skill = read(skillPath);
const toolIndex = read(toolIndexPath);

const knownTools = new Set();
for (const match of toolIndex.matchAll(/^\s*([a-z][a-z0-9_]*):\s*'[^']+',/gm)) {
  knownTools.add(match[1]);
}

const routingStart = skill.indexOf('## First tool by intent');
if (routingStart === -1) {
  fail(`${skillPath} is missing "## First tool by intent"`);
  process.exit();
}
const nextSection = skill.indexOf('\n## ', routingStart + 1);
const routingSection = skill.slice(routingStart, nextSection === -1 ? undefined : nextSection);

const allowedCommands = new Set(['openchrome doctor', 'openchrome check']);
const referenced = new Set();
for (const line of routingSection.split('\n')) {
  if (!line.startsWith('|') || line.includes('---')) continue;
  for (const match of line.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim();
    if (!raw || allowedCommands.has(raw)) continue;
    const tool = raw.split(/\s+/)[0];
    if (tool.startsWith('--')) continue;
    referenced.add(tool);
  }
}

if (referenced.size === 0) {
  fail('No tool references found in routing card');
}

for (const tool of referenced) {
  if (!knownTools.has(tool)) {
    fail(`Unknown OpenChrome tool referenced in routing card: ${tool}`);
  }
}

if (!process.exitCode) {
  console.log(`Checked ${referenced.size} OpenChrome tool references in ${path.relative(process.cwd(), skillPath)}.`);
}
