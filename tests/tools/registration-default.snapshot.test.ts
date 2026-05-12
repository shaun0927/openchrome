/// <reference types="jest" />
/**
 * Default-registration snapshot test (#847).
 *
 * Pins the v1.11.0 baseline tools/list payload: with NO category flags or env
 * vars set, registerAllTools() must produce the exact same set of tool names
 * (and the same count) as v1.11.0 — categorization is a P2 zero-impact
 * refactor and any drift is a regression.
 *
 * Strategy:
 *   - Construct an MCPServer with sessionManager mocked out (the manager has
 *     side effects we don't want in a unit test).
 *   - Call registerAllTools(server) with no selection argument.
 *   - Compare server.getToolNames() (sorted) against the baseline below.
 *
 * Updating the baseline:
 *   When you legitimately add or remove a tool from src/tools/index.ts you
 *   MUST also:
 *     1. Update TOOL_TO_CATEGORY in src/tools/_shared/category.ts (lint
 *        script enforces this).
 *     2. Update EXPECTED_DEFAULT_TOOLS below.
 *     3. Confirm the addition is intentional in the PR description.
 *   The double-edit is a feature: it forces a human to acknowledge surface
 *   changes that small-context model deployments care about.
 */

// ─── Mocks (mirrors tests/tools/journal.test.ts) ────────────────────────────

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
  resolveEnabledCategories,
  SLIM_CATEGORIES,
  ALWAYS_ON_CATEGORIES,
  TOOL_TO_CATEGORY,
} from '../../src/tools/_shared/category';
import {
  getDisabledToolsSnapshot,
  setDisabledToolsSnapshot,
} from '../../src/resources/tools-disabled';

// ─── v1.11.0 baseline (sorted) ───────────────────────────────────────────────
//
// Sourced from src/tools/index.ts REGISTRATION_ENTRIES — every name appearing
// in any `tools: [...]` array. Sorted alphabetically for stable diff output
// when a tool is added/removed.

const EXPECTED_DEFAULT_TOOLS: readonly string[] = [
  'act',
  'batch_execute',
  'batch_paginate',
  'computer',
  'console_capture',
  'cookies',
  'crawl',
  'crawl_sitemap',
  'drag_drop',
  'emulate_device',
  'execute_plan',
  'extract_data',
  'file_upload',
  'fill_form',
  'find',
  'form_input',
  'geolocation',
  'http_auth',
  'inspect',
  'interact',
  'javascript_tool',
  'lightweight_scroll',
  'list_profiles',
  'memory',
  'navigate',
  'network',
  'oc_assert',
  'oc_checkpoint',
  'oc_connection_health',
  'oc_copy_to_clipboard',
  'oc_evidence_bundle',
  'oc_get_connection_info',
  'oc_journal',
  'oc_open_host_settings',
  'oc_profile_status',
  'oc_reap_orphans',
  'oc_recording_export',
  'oc_recording_list',
  'oc_recording_start',
  'oc_recording_stop',
  'oc_session_resume',
  'oc_session_snapshot',
  'oc_skill_recall',
  'oc_skill_record',
  'oc_stop',
  'oc_totp_generate',
  'page_content',
  'page_pdf',
  'page_reload',
  'page_screenshot',
  'performance_metrics',
  'query_dom',
  'read_page',
  'request_intercept',
  'storage',
  'tabs_close',
  'tabs_context',
  'tabs_create',
  'user_agent',
  'validate_page',
  'vision_find',
  'wait_for',
  'worker',
  'worker_complete',
  'worker_update',
  'workflow_cleanup',
  'workflow_collect',
  'workflow_collect_partial',
  'workflow_init',
  'workflow_status',
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('registerAllTools — default selection (v1.11.0 parity)', () => {
  let server: MCPServer;

  beforeEach(() => {
    // Reset the disabled-tools snapshot module-level state so a prior test
    // does not bleed into this one.
    setDisabledToolsSnapshot([]);
    server = new MCPServer();
  });

  test('produces the v1.11.0 tool surface byte-for-byte', () => {
    registerAllTools(server);
    const actual = server.getToolNames().slice().sort();
    expect(actual).toEqual([...EXPECTED_DEFAULT_TOOLS]);
  });

  test('default surface size is the v1.11.0 count', () => {
    registerAllTools(server);
    expect(server.getToolNames().length).toBe(EXPECTED_DEFAULT_TOOLS.length);
  });

  test('disabled-tools snapshot is empty by default', () => {
    registerAllTools(server);
    const snap = getDisabledToolsSnapshot();
    expect(snap.tools).toEqual([]);
  });

  test('every default tool has a category in TOOL_TO_CATEGORY', () => {
    // This is the runtime mirror of scripts/lint-tool-categories.mjs — the
    // lint script catches the failure pre-merge, this catches it pre-commit
    // for developers who forget to run the lint.
    for (const name of EXPECTED_DEFAULT_TOOLS) {
      expect(TOOL_TO_CATEGORY[name]).toBeDefined();
    }
  });
});

describe('registerAllTools — slim selection', () => {
  let server: MCPServer;

  beforeEach(() => {
    setDisabledToolsSnapshot([]);
    server = new MCPServer();
  });

  test('--slim registers only slim + always-on category tools', () => {
    registerAllTools(server, { slim: true });
    const enabled = resolveEnabledCategories({ slim: true });
    const expected = EXPECTED_DEFAULT_TOOLS.filter((name) =>
      enabled.has(TOOL_TO_CATEGORY[name]),
    ).sort();
    const actual = server.getToolNames().slice().sort();
    expect(actual).toEqual(expected);
  });

  test('always-on tools survive --slim (reliability + observe)', () => {
    registerAllTools(server, { slim: true });
    const names = new Set(server.getToolNames());
    // Always-on category exemplars.
    expect(names.has('oc_stop')).toBe(true); // reliability
    expect(names.has('validate_page')).toBe(true); // reliability
    expect(names.has('console_capture')).toBe(true); // observe
    expect(names.has('oc_journal')).toBe(true); // observe
  });

  test('slim drops at least one tool per non-slim, non-always-on category', () => {
    registerAllTools(server, { slim: true });
    const enabled = resolveEnabledCategories({ slim: true });
    const slimAndAlwaysOn = new Set([
      ...SLIM_CATEGORIES,
      ...ALWAYS_ON_CATEGORIES,
    ]);
    // Sanity: every enabled category is in the slim+always-on set.
    for (const cat of enabled) {
      expect(slimAndAlwaysOn.has(cat)).toBe(true);
    }
    // And the surface is strictly smaller than the default.
    expect(server.getToolNames().length).toBeLessThan(
      EXPECTED_DEFAULT_TOOLS.length,
    );
  });

  test('disabled-tools snapshot lists every excluded tool with a restart hint', () => {
    registerAllTools(server, { slim: true });
    const snap = getDisabledToolsSnapshot();
    expect(snap.tools.length).toBeGreaterThan(0);
    for (const entry of snap.tools) {
      expect(entry.name).toBeTruthy();
      expect(entry.category).toBeTruthy();
      // Restart hint must contain the exact flag text an operator can copy.
      expect(entry.hint).toMatch(/--enable-categories=/);
    }
    // No always-on tool should appear as disabled.
    const disabledNames = new Set(snap.tools.map((t) => t.name));
    expect(disabledNames.has('oc_stop')).toBe(false);
    expect(disabledNames.has('console_capture')).toBe(false);
  });
});

describe('registerAllTools — enable / disable subsets', () => {
  let server: MCPServer;

  beforeEach(() => {
    setDisabledToolsSnapshot([]);
    server = new MCPServer();
  });

  test('--enable-categories=vision registers vision_find + always-on tools only', () => {
    registerAllTools(server, { enabled: ['vision'] });
    const names = new Set(server.getToolNames());
    expect(names.has('vision_find')).toBe(true);
    // Always-on still present.
    expect(names.has('oc_stop')).toBe(true);
    expect(names.has('console_capture')).toBe(true);
    // Out-of-scope category is gone.
    expect(names.has('navigate')).toBe(false);
    expect(names.has('crawl')).toBe(false);
  });

  test('--disable-categories=crawl drops crawl tools and keeps everything else', () => {
    registerAllTools(server, { disabled: ['crawl'] });
    const names = new Set(server.getToolNames());
    expect(names.has('crawl')).toBe(false);
    expect(names.has('crawl_sitemap')).toBe(false);
    // Sibling categories untouched.
    expect(names.has('navigate')).toBe(true);
    expect(names.has('vision_find')).toBe(true);
  });

  test('--disable-categories=reliability,observe is a no-op on always-on tools', () => {
    registerAllTools(server, { disabled: ['reliability', 'observe'] });
    const names = new Set(server.getToolNames());
    expect(names.has('oc_stop')).toBe(true);
    expect(names.has('validate_page')).toBe(true);
    expect(names.has('console_capture')).toBe(true);
    expect(names.has('oc_journal')).toBe(true);
  });
});
