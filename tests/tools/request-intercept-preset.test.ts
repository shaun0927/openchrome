/// <reference types="jest" />
/**
 * Unit tests for request_intercept preset feature (#861)
 * Covers: preset → rule expansion, unknown preset error,
 *         allow-wins composition, env-driven auto-apply.
 */

import { createMockSessionManager } from '../utils/mock-session';

// Module-level mock: jest.mock must be at the top level.
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock metrics collector so tests don't depend on singleton state.
const mockInc = jest.fn();
jest.mock('../../src/metrics/collector', () => ({
  getMetricsCollector: jest.fn(() => ({
    inc: mockInc,
  })),
}));

import { getSessionManager } from '../../src/session-manager';
import {
  PRESET_RESOURCE_TYPES,
  SUPPORTED_PRESETS,
  BandwidthPreset,
} from '../../src/tools/request-intercept';

// ---------------------------------------------------------------------------
// Helper: load the handler fresh for each test (needed to re-read ENV_PRESET
// which is captured at module load time via jest.resetModules).
// ---------------------------------------------------------------------------
async function loadHandler(envPreset?: string): Promise<
  (sessionId: string, args: Record<string, unknown>) => Promise<unknown>
> {
  // Re-read env preset each load.
  if (envPreset !== undefined) {
    process.env.OPENCHROME_OPTIMIZE_BANDWIDTH = envPreset;
  } else {
    delete process.env.OPENCHROME_OPTIMIZE_BANDWIDTH;
  }

  jest.resetModules();

  // Re-mock after resetModules.
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/metrics/collector', () => ({
    getMetricsCollector: jest.fn(() => ({ inc: mockInc })),
  }));

  const { registerRequestInterceptTool } = await import('../../src/tools/request-intercept');

  const tools = new Map<
    string,
    { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }
  >();
  const mockServer = {
    registerTool: (name: string, h: unknown) => {
      tools.set(name, {
        handler: h as (sessionId: string, args: Record<string, unknown>) => Promise<unknown>,
      });
    },
  };
  registerRequestInterceptTool(mockServer as unknown as Parameters<typeof registerRequestInterceptTool>[0]);
  return tools.get('request_intercept')!.handler;
}

let mockSessionManager: ReturnType<typeof createMockSessionManager>;
let testSessionId: string;
let testTargetId: string;

beforeEach(async () => {
  mockSessionManager = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
  mockInc.mockReset();

  testSessionId = 'test-session-preset';
  const created = await mockSessionManager.createTarget(testSessionId, 'about:blank');
  testTargetId = created.targetId;

  // Patch setRequestInterception onto the mock page (not present in createMockPage by default).
  const page = await mockSessionManager.getPage(testSessionId, testTargetId);
  if (page && !(page as unknown as Record<string, unknown>).setRequestInterception) {
    (page as unknown as Record<string, unknown>).setRequestInterception = jest.fn().mockResolvedValue(undefined);
  }
});

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENCHROME_OPTIMIZE_BANDWIDTH;
});

// ---------------------------------------------------------------------------
// Exported table tests (no handler needed)
// ---------------------------------------------------------------------------
describe('PRESET_RESOURCE_TYPES table', () => {
  test('optimize-bandwidth blocks Image, Media, Font, Stylesheet', () => {
    const types = PRESET_RESOURCE_TYPES['optimize-bandwidth'];
    expect(types).toEqual(expect.arrayContaining(['Image', 'Media', 'Font', 'Stylesheet']));
    expect(types).toHaveLength(4);
  });

  test('optimize-bandwidth-light blocks Image, Media, Font only', () => {
    const types = PRESET_RESOURCE_TYPES['optimize-bandwidth-light'];
    expect(types).toEqual(expect.arrayContaining(['Image', 'Media', 'Font']));
    expect(types).not.toContain('Stylesheet');
    expect(types).toHaveLength(3);
  });

  test('SUPPORTED_PRESETS contains both presets', () => {
    expect(SUPPORTED_PRESETS).toContain('optimize-bandwidth');
    expect(SUPPORTED_PRESETS).toContain('optimize-bandwidth-light');
    expect(SUPPORTED_PRESETS).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unknown preset → structured error
// ---------------------------------------------------------------------------
describe('unknown preset → structured error', () => {
  test('returns error with supported list for unknown preset string', async () => {
    const handler = await loadHandler();
    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'fake-preset',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('unknown_preset');
    expect(parsed.supported).toEqual(expect.arrayContaining(['optimize-bandwidth', 'optimize-bandwidth-light']));
  });

  test('returns error for empty string preset', async () => {
    const handler = await loadHandler();
    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: '',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // Empty string is not in SUPPORTED_PRESETS
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('unknown_preset');
  });
});

// ---------------------------------------------------------------------------
// Valid preset → enable succeeds with preset reported
// ---------------------------------------------------------------------------
describe('valid preset enables successfully', () => {
  test('optimize-bandwidth preset is accepted and reported in response', async () => {
    const handler = await loadHandler();
    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('enabled');
    expect(parsed.preset).toBe('optimize-bandwidth');
  });

  test('optimize-bandwidth-light preset is accepted and reported in response', async () => {
    const handler = await loadHandler();
    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth-light',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('enabled');
    expect(parsed.preset).toBe('optimize-bandwidth-light');
  });

  test('no preset → preset field is null in response', async () => {
    const handler = await loadHandler();
    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.preset).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// allow-wins: after listRules the preset rules are in front
// ---------------------------------------------------------------------------
describe('allow-wins composition', () => {
  test('preset rules are prepended before user rules', async () => {
    const handler = await loadHandler();

    // Enable with preset
    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });

    // Add a user block rule
    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'addRule',
      rule: { pattern: '*/api/*', action: 'block' },
    });

    const listResult = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'listRules',
    })) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(listResult.content[0].text);
    const rules = parsed.rules as Array<{ id: string; action: string }>;

    // Preset rules should all be at the front (ids start with 'preset-')
    const presetRules = rules.filter((r) => r.id.startsWith('preset-'));
    const userRules = rules.filter((r) => !r.id.startsWith('preset-'));

    expect(presetRules.length).toBe(4); // optimize-bandwidth: Image, Media, Font, Stylesheet
    expect(userRules.length).toBe(1);

    // Preset rules must come before user rules in the list
    const lastPresetIdx = rules.reduce(
      (acc: number, r: { id: string; action: string }, i: number) =>
        r.id.startsWith('preset-') ? i : acc,
      -1,
    );
    const firstUserIdx = rules.findIndex(
      (r: { id: string; action: string }) => !r.id.startsWith('preset-'),
    );
    expect(lastPresetIdx).toBeLessThan(firstUserIdx);
  });
});

// ---------------------------------------------------------------------------
// Env auto-apply
// ---------------------------------------------------------------------------
describe('OPENCHROME_OPTIMIZE_BANDWIDTH env auto-apply', () => {
  test('env preset is applied when no per-call preset is given', async () => {
    const handler = await loadHandler('optimize-bandwidth');

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.preset).toBe('optimize-bandwidth');
  });

  test('per-call preset overrides env preset', async () => {
    const handler = await loadHandler('optimize-bandwidth');

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth-light',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    // Per-call arg takes precedence
    expect(parsed.preset).toBe('optimize-bandwidth-light');
  });

  test('invalid env value is ignored (no preset applied)', async () => {
    const handler = await loadHandler('not-a-real-preset');

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.preset).toBeNull();
  });

  test('empty env value is ignored', async () => {
    const handler = await loadHandler('');

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.preset).toBeNull();
  });
});
