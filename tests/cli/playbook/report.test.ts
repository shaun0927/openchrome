/// <reference types="jest" />

import { formatMarkdown, formatPlain, writeReport } from '../../../cli/playbook/report';
import type { RunResult } from '../../../cli/playbook/run';

const result: RunResult = {
  name: 'stable ids',
  steps: [
    {
      index: 0,
      id: 'open_home',
      verb: 'navigate',
      tool: 'navigate',
      args: { url: 'https://example.com' },
      status: 'ok',
      durationMs: 12,
    },
    {
      index: 1,
      verb: 'assert',
      tool: 'oc_assert',
      args: { contract: { kind: 'url', pattern: 'missing' } },
      status: 'failed',
      durationMs: 3,
      error: 'Step 1 (assert): assert verdict="fail"',
    },
  ],
  summary: {
    ok: false,
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
  },
};

describe('playbook report formatting', () => {
  test('plain output includes authored ids and preserves legacy index rendering when absent', () => {
    expect(formatPlain(result)).toBe([
      'Playbook: stable ids',
      '',
      '  [PASS] step 0 [open_home]: navigate (12ms)',
      '  [FAIL] step 1: assert (3ms)',
      '         Step 1 (assert): assert verdict="fail"',
      '',
      'Summary: FAIL — 1/2 passed, 1 failed, 0 skipped',
    ].join('\n'));
  });

  test('Markdown output adds a stable ID column and uses a dash when absent', () => {
    expect(formatMarkdown(result)).toBe([
      '# Playbook: stable ids',
      '',
      '| # | ID | Verb | Tool | Status | Duration |',
      '|---|----|------|------|--------|----------|',
      '| 0 | `open_home` | `navigate` | `navigate` | OK | 12ms |',
      '| 1 | - | `assert` | `oc_assert` | FAILED | 3ms |',
      '',
      '**Result:** FAIL — 1/2 passed, 1 failed, 0 skipped',
    ].join('\n'));
  });

  test('Markdown output preserves the legacy table when no step has an id', () => {
    const legacyResult: RunResult = {
      ...result,
      steps: result.steps.map(({ id: _id, ...step }) => step),
    };

    expect(formatMarkdown(legacyResult)).toBe([
      '# Playbook: stable ids',
      '',
      '| # | Verb | Tool | Status | Duration |',
      '|---|------|------|--------|----------|',
      '| 0 | `navigate` | `navigate` | OK | 12ms |',
      '| 1 | `assert` | `oc_assert` | FAILED | 3ms |',
      '',
      '**Result:** FAIL — 1/2 passed, 1 failed, 0 skipped',
    ].join('\n'));
  });

  test('JSON output serializes identified rows and omits absent ids', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      writeReport(result, { json: true });

      expect(log).toHaveBeenCalledTimes(1);
      const output = log.mock.calls[0][0] as string;
      expect(JSON.parse(output)).toEqual(result);
      expect(output).toContain('"id": "open_home"');
      expect(output).not.toContain('"id": null');
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(output).steps[1], 'id')).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
