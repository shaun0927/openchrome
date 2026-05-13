/// <reference types="jest" />
/**
 * Local playbook verification fixtures for issue #1044.
 *
 * These tests exercise the same fixture recipes documented for manual
 * OpenChrome smoke verification, but use an in-process client so CI can
 * validate parse/expand/fail-fast behavior without launching Chrome.
 */

import * as path from 'path';
import { loadPlaybook } from '../../../cli/playbook/parse';
import { runPlaybook, RunOptions } from '../../../cli/playbook/run';
import type { CallResult } from '../../../cli/playbook/stdio-client';

const RECIPES = path.join(__dirname, '..', '..', 'fixtures', 'playbook', 'recipes');
const LOCAL_BASE = 'http://127.0.0.1:8765';

type ToolCall = { tool: string; args: Record<string, unknown> };

function containsMissingText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes('This Text Is Intentionally Missing');
  }
  if (Array.isArray(value)) {
    return value.some(containsMissingText);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsMissingText);
  }
  return false;
}

function makeFixtureClient(): { client: RunOptions['client']; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const client: RunOptions['client'] = {
    async connect() {},
    async callTool(tool: string, args: Record<string, unknown>): Promise<CallResult> {
      calls.push({ tool, args });
      if (tool === 'oc_assert') {
        const verdict = containsMissingText(args) ? 'fail' : 'pass';
        return {
          success: verdict === 'pass',
          verdict,
          result: { verdict },
        };
      }
      if (tool === 'navigate') {
        return { success: true, result: { tabId: 'fixture-tab' } };
      }
      return { success: true, result: { ok: true } };
    },
    async disconnect() {},
  };
  return { client, calls };
}

describe('local verification playbook fixtures', () => {
  test.each([
    ['basic-navigation.yaml', 4],
    ['safe-form.yaml', 5],
  ])('%s parses and runs to completion against the fixture client', async (fileName, expectedSteps) => {
    const playbook = loadPlaybook(path.join(RECIPES, fileName));
    const { client, calls } = makeFixtureClient();

    const result = await runPlaybook(playbook, {
      reuse: false,
      varMap: playbook.vars ?? {},
      client,
    });

    expect(result.summary).toMatchObject({
      ok: true,
      total: expectedSteps,
      failed: 0,
      skipped: 0,
    });
    expect(calls).toHaveLength(expectedSteps);

    const navigateCalls = calls.filter((call) => call.tool === 'navigate');
    expect(navigateCalls.length).toBeGreaterThan(0);
    for (const call of navigateCalls) {
      expect(call.args.url).toEqual(expect.stringContaining(LOCAL_BASE));
    }

    const assertCalls = calls.filter((call) => call.tool === 'oc_assert');
    expect(assertCalls.length).toBeGreaterThan(0);
    for (const call of assertCalls) {
      expect(call.args).toHaveProperty('contract');
      expect(call.args).toHaveProperty('evidence');
    }

    if (fileName === 'safe-form.yaml') {
      expect(calls.find((call) => call.tool === 'fill_form')?.args).toMatchObject({
        tabId: 'fixture-tab',
        fields: { name: 'OpenChrome' },
      });
    }
  });

  test('failure-recovery fixture fails fast and skips the recovery-sensitive step', async () => {
    const playbook = loadPlaybook(path.join(RECIPES, 'failure-recovery.yaml'));
    const { client, calls } = makeFixtureClient();

    const result = await runPlaybook(playbook, {
      reuse: false,
      varMap: playbook.vars ?? {},
      client,
    });

    expect(result.summary).toMatchObject({
      ok: false,
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
    expect(calls.map((call) => call.tool)).toEqual(['navigate', 'oc_assert']);
    expect(result.steps[2]).toMatchObject({ verb: 'navigate', status: 'skipped' });
  });
});
