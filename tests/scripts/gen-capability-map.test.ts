/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCapabilityMapEntries, renderCapabilityMap } from '../../scripts/gen-capability-map';

describe('capability map generator', () => {
  test('collects registered tools with bounded descriptions and capabilities', () => {
    const entries = collectCapabilityMapEntries();
    const names = entries.map((entry) => entry.name);

    expect(names).toContain('navigate');
    expect(names).toContain('read_page');
    expect(names).toContain('oc_normalize_action');

    // Exact sync: the committed capability map header must match the live tool
    // surface (mirrors the docs:capability-map:check CI gate; replaces the old
    // `> 80` smoke bound that let the documented count drift to 107 vs 118).
    const committed = readFileSync(
      join(__dirname, '..', '..', 'docs', 'agent', 'capability-map.md'),
      'utf8',
    );
    const totalToolsHeader = committed.match(/Total tools:\s*(\d+)/);
    expect(totalToolsHeader).not.toBeNull();
    expect(Number(totalToolsHeader?.[1])).toBe(entries.length);
    expect(entries.every((entry) => entry.description.length > 0 && !entry.description.includes('\n'))).toBe(true);
    expect(entries.every((entry) => typeof entry.capability === 'string')).toBe(true);
  });

  test('renders deterministic grouped markdown', () => {
    const markdown = renderCapabilityMap([
      { name: 'b_tool', capability: 'storage', description: 'B.' },
      { name: 'a_tool', capability: 'core', description: 'A.' },
    ]);

    expect(markdown).toContain('# OpenChrome Capability Map');
    expect(markdown.indexOf('## core')).toBeLessThan(markdown.indexOf('## storage'));
    expect(markdown).toContain('- `a_tool` — A.');
    expect(markdown).toContain('- `b_tool` — B.');
  });
});
