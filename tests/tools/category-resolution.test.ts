/// <reference types="jest" />
/**
 * Resolution-rules tests for tool category selection (#847).
 *
 * Pins the four rules from src/tools/_shared/category.ts::resolveEnabledCategories:
 *   1. slim → SLIM_CATEGORIES + always-on
 *   2. enabled subset → only those + always-on
 *   3. disabled → those subtracted (but always-on still wins)
 *   4. ALWAYS_ON_CATEGORIES (reliability + observe) is unconditional
 *
 * The order check matters: the resolver re-emits in canonical order so
 * snapshot consumers (the disabled-tools resource, the registration snapshot
 * test) get a stable serialization regardless of input order.
 *
 * Also covers per-tool registration filtering for registrars that emit
 * tools across multiple categories (regression for PR #944 / Codex P1).
 */

// ─── Mocks (mirrors tests/tools/registration-default.snapshot.test.ts) ──────
// Required because the per-tool filtering regression suite below constructs
// a real MCPServer and invokes registerAllTools, which transitively touches
// the session manager and chrome launcher singletons.

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => ({
    getAllSessionInfos: jest.fn().mockReturnValue([]),
    getOrCreateSession: jest.fn().mockResolvedValue({}),
    cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    addEventListener: jest.fn(),
  })),
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    getProfileState: jest.fn().mockReturnValue({
      type: 'temp',
      extensionsAvailable: false,
    }),
  })),
}));

import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';
import {
  getDisabledToolsSnapshot,
  setDisabledToolsSnapshot,
} from '../../src/resources/tools-disabled';
import {
  ALL_CATEGORIES,
  ALWAYS_ON_CATEGORIES,
  parseCategoryCsv,
  resolveEnabledCategories,
  SLIM_CATEGORIES,
  ToolCategory,
} from '../../src/tools/_shared/category';

describe('resolveEnabledCategories', () => {
  test('default selection (no flags) returns the full canonical set', () => {
    const result = resolveEnabledCategories();
    expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
  });

  test('default selection (empty object) returns the full canonical set', () => {
    const result = resolveEnabledCategories({});
    expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
  });

  describe('rule 1: slim mode', () => {
    test('slim → SLIM_CATEGORIES + always-on, in canonical order', () => {
      const result = Array.from(resolveEnabledCategories({ slim: true }));
      // Every slim category must be present.
      for (const cat of SLIM_CATEGORIES) {
        expect(result).toContain(cat);
      }
      // Every always-on category must be present.
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result).toContain(cat);
      }
      // Nothing else should leak in.
      const expected = new Set<ToolCategory>([
        ...SLIM_CATEGORIES,
        ...ALWAYS_ON_CATEGORIES,
      ]);
      expect(result.length).toBe(expected.size);
    });

    test('slim wins over enabled when both supplied', () => {
      const result = Array.from(
        resolveEnabledCategories({
          slim: true,
          enabled: ['vision', 'crawl'],
        }),
      );
      // vision/crawl must NOT appear — slim path is taken.
      expect(result).not.toContain('vision');
      expect(result).not.toContain('crawl');
      // navigation/interact/inspect (slim) MUST appear.
      expect(result).toContain('navigation');
      expect(result).toContain('interact');
      expect(result).toContain('inspect');
    });

    test('emitted order matches ALL_CATEGORIES ordering', () => {
      const result = Array.from(resolveEnabledCategories({ slim: true }));
      const indexes = result.map((cat) => ALL_CATEGORIES.indexOf(cat));
      const sorted = [...indexes].sort((a, b) => a - b);
      expect(indexes).toEqual(sorted);
    });
  });

  describe('rule 2: enable subset', () => {
    test('enabled subset → only those + always-on', () => {
      const result = Array.from(
        resolveEnabledCategories({ enabled: ['vision', 'crawl'] }),
      );
      const expected = new Set<ToolCategory>([
        'vision',
        'crawl',
        ...ALWAYS_ON_CATEGORIES,
      ]);
      expect(new Set(result)).toEqual(expected);
    });

    test('enabled = [] is treated as default (full set)', () => {
      const result = resolveEnabledCategories({ enabled: [] });
      expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
    });
  });

  describe('rule 3: disable subtracts', () => {
    test('disabled removes specified categories from the full set', () => {
      const result = resolveEnabledCategories({
        disabled: ['vision', 'crawl', 'memory'],
      });
      expect(result.has('vision')).toBe(false);
      expect(result.has('crawl')).toBe(false);
      expect(result.has('memory')).toBe(false);
      // Sibling categories remain.
      expect(result.has('navigation')).toBe(true);
      expect(result.has('tabs')).toBe(true);
    });

    test('disabled is applied AFTER enabled', () => {
      const result = resolveEnabledCategories({
        enabled: ['vision', 'crawl', 'memory'],
        disabled: ['memory'],
      });
      expect(result.has('vision')).toBe(true);
      expect(result.has('crawl')).toBe(true);
      expect(result.has('memory')).toBe(false);
    });
  });

  describe('rule 4: always-on cannot be disabled', () => {
    test('reliability + observe survive an explicit --disable-categories', () => {
      const result = resolveEnabledCategories({
        disabled: ['reliability', 'observe'],
      });
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result.has(cat)).toBe(true);
      }
    });

    test('reliability + observe survive an --enable-categories that omits them', () => {
      const result = resolveEnabledCategories({
        enabled: ['vision'],
      });
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result.has(cat)).toBe(true);
      }
    });

    test('reliability + observe survive --slim + --disable-categories combo', () => {
      const result = resolveEnabledCategories({
        slim: true,
        disabled: ['reliability', 'observe', 'navigation'],
      });
      // Always-on wins.
      expect(result.has('reliability')).toBe(true);
      expect(result.has('observe')).toBe(true);
      // Slim minus navigation is honored.
      expect(result.has('navigation')).toBe(false);
      expect(result.has('interact')).toBe(true);
      expect(result.has('inspect')).toBe(true);
    });
  });
});

describe('parseCategoryCsv', () => {
  test('parses well-formed csv', () => {
    expect(parseCategoryCsv('vision,crawl,memory', 'test')).toEqual([
      'vision',
      'crawl',
      'memory',
    ]);
  });

  test('trims whitespace and skips empty segments', () => {
    expect(parseCategoryCsv(' vision , , crawl ', 'test')).toEqual([
      'vision',
      'crawl',
    ]);
  });

  test('deduplicates while preserving first-seen order', () => {
    expect(parseCategoryCsv('vision,crawl,vision', 'test')).toEqual([
      'vision',
      'crawl',
    ]);
  });

  test('throws with the source label on unknown category', () => {
    expect(() => parseCategoryCsv('vision,bogus', '--enable-categories')).toThrow(
      /\[--enable-categories\] Unknown tool category "bogus"/,
    );
  });

  test('returns [] for empty input', () => {
    expect(parseCategoryCsv('', 'test')).toEqual([]);
    expect(parseCategoryCsv('  ', 'test')).toEqual([]);
  });
});

// ─── Per-tool filter regression (PR #944 / Codex P1) ────────────────────────
//
// Before #944 the registration dispatch was all-or-nothing per registrar:
// if ANY tool produced by a registrar belonged to a disabled category, the
// ENTIRE registrar was skipped. The orchestration registrar emits
// `worker_update` (categorized `tabs`) alongside the `workflow_*` family
// (categorized `workflow`), so --disable-categories=tabs unintentionally
// removed all workflow_* tools. These tests pin the fixed behavior: every
// individual tool is gated by its own category, not its registrar's union.

describe('registerAllTools — per-tool filter on mixed-category registrars', () => {
  let server: MCPServer;

  beforeEach(() => {
    // Reset the sidecar disabled-tools snapshot so cross-test state from
    // the registration-default snapshot suite (or prior cases here) does
    // not bleed in.
    setDisabledToolsSnapshot([]);
    server = new MCPServer();
  });

  test('--disable-categories=tabs preserves orchestration workflow_* tools', () => {
    registerAllTools(server, { disabled: ['tabs'] });
    const names = new Set(server.getToolNames());

    // worker_update is the only orchestration tool in the `tabs` category
    // and MUST be dropped.
    expect(names.has('worker_update')).toBe(false);
    // Sibling `tabs` tools also gone.
    expect(names.has('worker')).toBe(false);
    expect(names.has('tabs_create')).toBe(false);
    expect(names.has('tabs_close')).toBe(false);
    expect(names.has('tabs_context')).toBe(false);

    // Workflow-category tools live in the SAME registrar
    // (registerOrchestrationTools) but must SURVIVE the tabs disable.
    expect(names.has('workflow_init')).toBe(true);
    expect(names.has('workflow_status')).toBe(true);
    expect(names.has('workflow_collect')).toBe(true);
    expect(names.has('workflow_collect_partial')).toBe(true);
    expect(names.has('workflow_cleanup')).toBe(true);
    expect(names.has('worker_complete')).toBe(true);
    expect(names.has('execute_plan')).toBe(true);
  });

  test('--disable-categories=tabs,workflow drops both orchestration slices', () => {
    registerAllTools(server, { disabled: ['tabs', 'workflow'] });
    const names = new Set(server.getToolNames());

    // tabs slice
    expect(names.has('worker_update')).toBe(false);
    expect(names.has('worker')).toBe(false);
    expect(names.has('tabs_create')).toBe(false);

    // workflow slice (same orchestration registrar)
    expect(names.has('workflow_init')).toBe(false);
    expect(names.has('workflow_status')).toBe(false);
    expect(names.has('worker_complete')).toBe(false);
    expect(names.has('execute_plan')).toBe(false);
    // workflow-category tools outside the orchestration registrar also gone.
    expect(names.has('batch_execute')).toBe(false);
    expect(names.has('batch_paginate')).toBe(false);
    expect(names.has('lightweight_scroll')).toBe(false);

    // Sibling categories untouched.
    expect(names.has('navigate')).toBe(true);
    expect(names.has('vision_find')).toBe(true);
  });

  test('disabled-tools snapshot lists per-tool category for mixed registrars', () => {
    registerAllTools(server, { disabled: ['tabs'] });
    const snap = getDisabledToolsSnapshot();
    const byName = new Map(snap.tools.map((t) => [t.name, t]));

    // worker_update is categorized `tabs` and must surface as disabled
    // with its OWN category, not the registrar's union.
    const workerUpdate = byName.get('worker_update');
    expect(workerUpdate).toBeDefined();
    expect(workerUpdate?.category).toBe('tabs');
    expect(workerUpdate?.hint).toMatch(/--enable-categories=/);

    // workflow_* tools from the SAME registrar are NOT disabled and must
    // not appear in the disabled snapshot.
    expect(byName.has('workflow_init')).toBe(false);
    expect(byName.has('worker_complete')).toBe(false);
    expect(byName.has('execute_plan')).toBe(false);
  });

  test('fully disabled registrars are skipped but still recorded in disabled snapshot', () => {
    registerAllTools(server, { enabled: ['navigation'] });
    const names = new Set(server.getToolNames());
    const snap = getDisabledToolsSnapshot();
    const byName = new Map(snap.tools.map((t) => [t.name, t]));

    // oc_proxy_hook is a pilot-only registrar with optional side effects.
    // A narrow category allow-list must exclude it before invoking the
    // registrar, while still documenting the skipped tool for operators.
    expect(names.has('oc_proxy_hook')).toBe(false);
    expect(byName.get('oc_proxy_hook')?.category).toBe('pilot');
  });
});
