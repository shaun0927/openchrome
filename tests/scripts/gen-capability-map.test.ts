/// <reference types="jest" />

import { collectCapabilityMapEntries, renderCapabilityMap } from '../../scripts/gen-capability-map';

describe('capability map generator', () => {
  test('collects registered tools with bounded descriptions and capabilities', () => {
    const entries = collectCapabilityMapEntries();
    const names = entries.map((entry) => entry.name);

    expect(names).toContain('navigate');
    expect(names).toContain('read_page');
    expect(names).toContain('oc_normalize_action');
    expect(entries.length).toBeGreaterThan(80);
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
