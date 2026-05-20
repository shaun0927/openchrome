/**
 * Tests for `buildSkillBody` — the deterministic SKILL.md body
 * distiller that replaces the placeholder body when journal entries
 * are available.
 */

import { buildSkillBody } from '../../../src/pilot/curator/index.js';
import type { JournalLikeEntry } from '../../../src/pilot/curator/index.js';

function entry(over: Partial<JournalLikeEntry> & { tool: string; ts: number }): JournalLikeEntry {
  return {
    ts: over.ts,
    tool: over.tool,
    args: over.args ?? {},
    ok: over.ok ?? true,
    ...(over.summary !== undefined ? { summary: over.summary } : {}),
  };
}

describe('buildSkillBody', () => {
  it('emits a Steps section with retained tool calls in order', () => {
    const body = buildSkillBody([
      entry({ ts: 1, tool: 'navigate', args: { url: 'https://example.com/cart' }, summary: 'Cart page' }),
      entry({ ts: 2, tool: 'fill_form', args: { selector: '#qty', value: '2' } }),
      entry({ ts: 3, tool: 'click', args: { label: 'Add to cart' } }),
    ]);
    expect(body).toMatch(/## Steps/);
    expect(body).toMatch(/1\. \*\*navigate\*\*\(url=https:\/\/example.com\/cart\) — Cart page/);
    expect(body).toMatch(/2\. \*\*fill_form\*\*\(selector=#qty\)/);
    expect(body).toMatch(/3\. \*\*click\*\*\(label=Add to cart\)/);
  });

  it('drops read-only observation tools', () => {
    const body = buildSkillBody([
      entry({ ts: 1, tool: 'read_page' }),
      entry({ ts: 2, tool: 'query_dom' }),
      entry({ ts: 3, tool: 'navigate', args: { url: 'x' } }),
    ]);
    expect(body).toMatch(/skipped 2 read-only/);
    expect(body).not.toMatch(/read_page/);
    expect(body).not.toMatch(/query_dom/);
    expect(body).toMatch(/\*\*navigate\*\*/);
  });

  it('drops failed entries', () => {
    const body = buildSkillBody([
      entry({ ts: 1, tool: 'navigate', args: { url: 'x' } }),
      entry({ ts: 2, tool: 'click', ok: false }),
      entry({ ts: 3, tool: 'fill_form', args: { selector: 'a' } }),
    ]);
    expect(body).toMatch(/skipped 1 failed/);
    expect(body.match(/\*\*click\*\*/)).toBeNull();
  });

  it('caps the step count via maxSteps and reports truncation', () => {
    const entries: JournalLikeEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(entry({ ts: i, tool: 'click', args: { label: `btn-${i}` } }));
    }
    const body = buildSkillBody(entries, { maxSteps: 3 });
    expect(body.split('\n').filter((l) => /^\d+\.\s\*\*/.test(l))).toHaveLength(3);
    expect(body).toMatch(/truncated 17 extra steps/);
  });

  it('escapes backticks and newlines in tool / args / summary', () => {
    const body = buildSkillBody([
      entry({
        ts: 1,
        tool: 'navigate',
        args: { url: 'https://example.com/`weird`' },
        summary: 'line1\nline2',
      }),
    ]);
    expect(body).not.toMatch(/`weird`/);
    expect(body).not.toMatch(/line1\nline2/);
  });

  it('returns a stable placeholder when zero actionable entries survive', () => {
    const body = buildSkillBody([
      entry({ ts: 1, tool: 'read_page' }),
      entry({ ts: 2, tool: 'inspect' }),
    ]);
    expect(body).toMatch(/No actionable journal entries survived/);
    // Still a valid markdown body with the canonical header.
    expect(body).toMatch(/## Steps/);
  });

  it('includes the intent in the intro when supplied', () => {
    const body = buildSkillBody(
      [entry({ ts: 1, tool: 'navigate', args: { url: 'x' } })],
      { intent: 'cart.add' },
    );
    expect(body).toMatch(/contract-verified successful trajectory for "cart.add"/);
  });

  it('produces byte-identical output for the same input twice (determinism)', () => {
    const entries = [
      entry({ ts: 1, tool: 'navigate', args: { url: 'x' }, summary: 'A' }),
      entry({ ts: 2, tool: 'click', args: { label: 'btn' } }),
    ];
    expect(buildSkillBody(entries)).toBe(buildSkillBody(entries));
  });

  it('picks args in lexical key order so the preview is stable', () => {
    const a = buildSkillBody([entry({ ts: 1, tool: 'navigate', args: { url: 'x', timeout: 5 } })]);
    const b = buildSkillBody([entry({ ts: 1, tool: 'navigate', args: { timeout: 5, url: 'x' } })]);
    expect(a).toBe(b);
  });
});
