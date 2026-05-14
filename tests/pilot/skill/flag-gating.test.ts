/**
 * Verifies that the pilot-tier skill module is not exposed when the
 * `--pilot` flag is closed, and that the per-family `OPENCHROME_STATE_GRAPH`
 * flag correctly gates the family within an opened pilot tier.
 *
 * The module is technically reachable via direct `import` in tests once
 * the file system path resolves, but call sites in product code must go
 * through `bootstrapPilot()` which honours the gate. This file pins the
 * flag contract so future refactors can't silently drop the gating.
 */

import {
  bootstrapPilot,
  isPilotEnabled,
  isStateGraphEnabled,
  resetFlagsCache,
} from '../../../src/harness/flags.js';

const ORIGINAL_ARGV = process.argv;
const ORIGINAL_PILOT_ENV = process.env.OPENCHROME_PILOT;
const ORIGINAL_STATE_GRAPH_ENV = process.env.OPENCHROME_STATE_GRAPH;

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  if (ORIGINAL_PILOT_ENV === undefined) {
    delete process.env.OPENCHROME_PILOT;
  } else {
    process.env.OPENCHROME_PILOT = ORIGINAL_PILOT_ENV;
  }
  if (ORIGINAL_STATE_GRAPH_ENV === undefined) {
    delete process.env.OPENCHROME_STATE_GRAPH;
  } else {
    process.env.OPENCHROME_STATE_GRAPH = ORIGINAL_STATE_GRAPH_ENV;
  }
  resetFlagsCache();
});

describe('skill executor — flag gating', () => {
  test('pilot closed → state_graph also closed', () => {
    process.argv = ['node', 'cli/index.js'];
    delete process.env.OPENCHROME_PILOT;
    delete process.env.OPENCHROME_STATE_GRAPH;
    resetFlagsCache();
    expect(isPilotEnabled()).toBe(false);
    expect(isStateGraphEnabled()).toBe(false);
  });

  test('pilot open + state_graph default (unset) → state_graph active', () => {
    process.argv = ['node', 'cli/index.js', '--pilot'];
    delete process.env.OPENCHROME_STATE_GRAPH;
    resetFlagsCache();
    expect(isPilotEnabled()).toBe(true);
    expect(isStateGraphEnabled()).toBe(true);
  });

  test('pilot open + state_graph=0 → state_graph closed even within pilot', () => {
    process.argv = ['node', 'cli/index.js', '--pilot'];
    process.env.OPENCHROME_STATE_GRAPH = '0';
    resetFlagsCache();
    expect(isPilotEnabled()).toBe(true);
    expect(isStateGraphEnabled()).toBe(false);
  });

  test('bootstrapPilot() returns null when --pilot is closed (no dynamic import)', async () => {
    process.argv = ['node', 'cli/index.js'];
    delete process.env.OPENCHROME_PILOT;
    resetFlagsCache();
    const result = await bootstrapPilot();
    expect(result).toBeNull();
  });

  test('bootstrapPilot() resolves the pilot namespace with the skill submodule when open', async () => {
    process.argv = ['node', 'cli/index.js', '--pilot'];
    resetFlagsCache();
    const ns = (await bootstrapPilot()) as {
      skill?: { decide?: unknown };
    } | null;
    expect(ns).not.toBeNull();
    expect(ns?.skill).toBeDefined();
    expect(typeof ns?.skill?.decide).toBe('function');
  });
});
