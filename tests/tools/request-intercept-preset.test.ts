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

type RequestAction = 'block' | 'modify' | 'log' | 'allow';

function parseToolResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

async function getMockPage() {
  return (await mockSessionManager.getPage(testSessionId, testTargetId)) as unknown as {
    on: jest.Mock;
  };
}

async function getRequestListener(): Promise<(request: unknown) => Promise<void>> {
  const page = await getMockPage();
  return page.on.mock.calls
    .slice()
    .reverse()
    .find(([event]) => event === 'request')?.[1] as (request: unknown) => Promise<void>;
}

function createMockRequest(options: {
  url: string;
  resourceType: string;
  method?: string;
  headers?: Record<string, string>;
}) {
  return {
    url: jest.fn(() => options.url),
    resourceType: jest.fn(() => options.resourceType),
    method: jest.fn(() => options.method ?? 'GET'),
    headers: jest.fn(() => options.headers ?? {}),
    abort: jest.fn().mockResolvedValue(undefined),
    respond: jest.fn().mockResolvedValue(undefined),
    continue: jest.fn().mockResolvedValue(undefined),
  };
}

function metricCalls(name: string) {
  return mockInc.mock.calls.filter(([metricName]) => metricName === name);
}

async function addRule(
  handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>,
  rule: {
    pattern: string;
    action: RequestAction;
    resourceTypes?: string[];
    modifyOptions?: { status?: number; headers?: Record<string, string>; body?: string };
  },
) {
  return handler(testSessionId, {
    tabId: testTargetId,
    action: 'addRule',
    rule,
  });
}

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

  test('log rule does not override preset block', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });
    await addRule(handler, {
      pattern: '*://cdn.example.com/*',
      resourceTypes: ['image'],
      action: 'log',
    });

    const request = createMockRequest({
      url: 'https://cdn.example.com/hero.png',
      resourceType: 'image',
    });
    await (await getRequestListener())(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(request.continue).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });

  test('log rule does not override user block', async () => {
    const handler = await loadHandler();

    await addRule(handler, {
      pattern: '*://assets.example.com/*',
      resourceTypes: ['image'],
      action: 'block',
    });
    await addRule(handler, {
      pattern: '*://assets.example.com/*',
      resourceTypes: ['image'],
      action: 'log',
    });
    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    });

    const request = createMockRequest({
      url: 'https://assets.example.com/photo.jpg',
      resourceType: 'image',
    });
    await (await getRequestListener())(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(request.continue).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });

  test('explicit allow rule overrides preset block', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });
    await addRule(handler, {
      pattern: '*://cdn.example.com/keep.png',
      resourceTypes: ['image'],
      action: 'allow',
    });

    const request = createMockRequest({
      url: 'https://cdn.example.com/keep.png',
      resourceType: 'image',
    });
    await (await getRequestListener())(request);

    expect(request.continue).toHaveBeenCalled();
    expect(request.abort).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });

  test('modify rule overriding preset block executes response modification', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });
    await addRule(handler, {
      pattern: '*://cdn.example.com/placeholder.png',
      resourceTypes: ['image'],
      action: 'modify',
      modifyOptions: {
        status: 204,
        headers: { 'content-type': 'image/png' },
        body: '',
      },
    });

    const request = createMockRequest({
      url: 'https://cdn.example.com/placeholder.png',
      resourceType: 'image',
    });
    await (await getRequestListener())(request);

    expect(request.respond).toHaveBeenCalledWith({
      status: 204,
      headers: { 'content-type': 'image/png' },
      body: '',
    });
    expect(request.abort).not.toHaveBeenCalled();
    expect(request.continue).not.toHaveBeenCalled();
  });

  test('preset rules are cleared across disable and enable without preset', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });
    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'disable',
    });

    const enableResult = await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
    });
    expect(parseToolResult(enableResult).preset).toBeNull();

    const listResult = await handler(testSessionId, {
      tabId: testTargetId,
      action: 'listRules',
    });
    const rules = parseToolResult(listResult).rules as Array<{ id: string }>;
    expect(rules.some((r) => r.id.startsWith('preset-'))).toBe(false);

    const request = createMockRequest({
      url: 'https://cdn.example.com/photo.jpg',
      resourceType: 'image',
    });
    await (await getRequestListener())(request);

    expect(request.continue).toHaveBeenCalled();
    expect(request.abort).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Estimated bandwidth metrics for preset-blocked assets
// ---------------------------------------------------------------------------
describe('preset bandwidth metrics', () => {
  test('blocked preset image increments non-zero estimated response bytes without request Content-Length', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });

    const request = createMockRequest({
      url: 'https://cdn.example.com/hero.png',
      resourceType: 'image',
      headers: {},
    });
    await (await getRequestListener())(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');

    const blockedCalls = metricCalls('openchrome_intercept_estimated_blocked_response_bytes_total');
    expect(blockedCalls).toHaveLength(1);
    expect(blockedCalls[0]).toEqual([
      'openchrome_intercept_estimated_blocked_response_bytes_total',
      { resource_type: 'image', estimate_source: 'resource_type' },
      expect.any(Number),
    ]);
    expect(blockedCalls[0][2]).toBeGreaterThan(0);

    expect(metricCalls('openchrome_intercept_blocked_bytes_total')).toHaveLength(0);
    expect(metricCalls('openchrome_intercept_observed_bytes_total')).toHaveLength(0);
  });

  test('blocked preset stylesheet uses deterministic estimate instead of request Content-Length', async () => {
    const handler = await loadHandler();

    await handler(testSessionId, {
      tabId: testTargetId,
      action: 'enable',
      preset: 'optimize-bandwidth',
    });

    const request = createMockRequest({
      url: 'https://static.example.com/app.css',
      resourceType: 'stylesheet',
      headers: { 'content-length': '0' },
    });
    await (await getRequestListener())(request);

    expect(request.abort).toHaveBeenCalledWith('blockedbyclient');

    const observedCalls = metricCalls('openchrome_intercept_estimated_response_bytes_total');
    const blockedCalls = metricCalls('openchrome_intercept_estimated_blocked_response_bytes_total');
    expect(observedCalls[0]).toEqual([
      'openchrome_intercept_estimated_response_bytes_total',
      { resource_type: 'stylesheet', estimate_source: 'resource_type' },
      20 * 1024,
    ]);
    expect(blockedCalls[0]).toEqual([
      'openchrome_intercept_estimated_blocked_response_bytes_total',
      { resource_type: 'stylesheet', estimate_source: 'resource_type' },
      20 * 1024,
    ]);
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
