/**
 * mcp-replay formatter (issue #836):
 *   - one JSONL line per tool call
 *   - ordering is preserved by the aggregator (covered separately in
 *     aggregator.spec.ts, smoke-tested here at the formatter level)
 *   - the entire line is valid JSON
 */

import { formatMcpReplay } from '../../../src/core/codegen/formatters/mcp-replay';

describe('formatMcpReplay', () => {
  it('produces one valid JSON object per call', () => {
    const line = formatMcpReplay('navigate', { url: 'https://example.com' }, 1731234567890);
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      ts: 1731234567890,
      tool: 'navigate',
      args: { url: 'https://example.com' },
    });
  });

  it('preserves args verbatim, including secret placeholders', () => {
    const line = formatMcpReplay('form_input', {
      selector: '#pw',
      value: '${SECRET:TEST_PW}',
    });
    expect(line).toContain('${SECRET:TEST_PW}');
  });

  it('writes a fresh ms epoch when none is supplied', () => {
    const before = Date.now();
    const line = formatMcpReplay('cookies', { action: 'list' });
    const after = Date.now();
    const parsed = JSON.parse(line) as { ts: number };
    expect(parsed.ts).toBeGreaterThanOrEqual(before);
    expect(parsed.ts).toBeLessThanOrEqual(after);
  });

  it('preserves call order when applied to a sequence', () => {
    const seq = [
      { tool: 'navigate', args: { url: 'a' } },
      { tool: 'interact', args: { selector: 'b' } },
      { tool: 'wait_for', args: { type: 'selector', value: 'c' } },
    ];
    const lines = seq.map((s) => formatMcpReplay(s.tool, s.args, 0));
    const parsed = lines.map((l) => JSON.parse(l).tool);
    expect(parsed).toEqual(['navigate', 'interact', 'wait_for']);
  });
});
