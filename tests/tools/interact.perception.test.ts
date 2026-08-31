/// <reference types="jest" />

import type { MCPResult, MCPToolDefinition } from '../../src/types/mcp';
import type { PerceptionElement, PerceptionSnapshot } from '../../src/vision/types';
import { VISUAL_PERCEPTION_MAX_AGE_MS } from '../../src/vision/perception-target';
import { createMockPage } from '../utils/mock-cdp';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    generateRef: jest.fn().mockReturnValue('ref_1'),
    isRefStale: jest.fn().mockReturnValue(false),
    resolveToBackendNodeId: jest.fn(),
  })),
}));

jest.mock('../../src/core/browser-lanes', () => ({
  applyLaneTarget: jest.fn((args: Record<string, unknown>) => args),
  recordLaneToolCall: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/dom/dom-delta', () => ({
  withDomDelta: jest.fn().mockImplementation(async (_page: unknown, action: () => Promise<void>) => {
    await action();
    return { delta: 'button state changed' };
  }),
}));

jest.mock('../../src/core/perception/verify', () => {
  const actual = jest.requireActual('../../src/core/perception/verify');
  return {
    ...actual,
    runVerify: jest.fn().mockImplementation(async (_page: unknown, mode: string, action: () => Promise<unknown>) => ({
      result: await action(),
      verify: mode === 'none' ? undefined : { mode, total_bytes: 0 },
    })),
  };
});

jest.mock('../../src/stealth/human-behavior', () => ({
  humanMouseMove: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/tools/_shared/replay-recorder', () => ({
  captureBackendNodeReplayStep: jest.fn().mockResolvedValue(undefined),
  shouldCaptureReplayArtifact: jest.fn((value: unknown) => value === true),
}));

import { getSessionManager } from '../../src/session-manager';
import { runVerify } from '../../src/core/perception/verify';
import { captureBackendNodeReplayStep } from '../../src/tools/_shared/replay-recorder';

const NOW = 1_800_000_000_000;
const VIEWPORT = { width: 1280, height: 720 };

function perceptionElement(overrides: Partial<PerceptionElement> = {}): PerceptionElement {
  return {
    id: 'v1',
    type: 'control',
    label: 'Continue',
    role: 'button',
    interactive: true,
    bbox: { x: 100, y: 200, width: 80, height: 40 },
    bboxRatio: { x: 100 / 1280, y: 200 / 720, width: 80 / 1280, height: 40 / 720 },
    source: 'mock',
    backendDOMNodeId: 42,
    ...overrides,
  };
}

function perceptionSnapshot(overrides: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    version: 1,
    provider: 'mock-provider',
    tabId: 'tab-1',
    url: 'https://example.test/app',
    capturedAt: NOW - 100,
    viewport: VIEWPORT,
    elements: [perceptionElement()],
    warnings: ['snapshot-only-warning'],
    latencyMs: 12,
    ...overrides,
  };
}

function visualSnapshot(overrides: Partial<PerceptionElement> = {}): PerceptionSnapshot {
  return perceptionSnapshot({
    elements: [perceptionElement({ backendDOMNodeId: undefined, ...overrides })],
  });
}

describe('interact tool - perception mode', () => {
  let definition: MCPToolDefinition;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<MCPResult>;
  let page: ReturnType<typeof createMockPage>;
  let cdpSend: jest.Mock;
  let sessionManager: Record<string, jest.Mock>;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeAll(async () => {
    const { registerInteractTool } = await import('../../src/tools/interact');
    registerInteractTool({
      registerTool: (_name: string, registeredHandler: typeof handler, registeredDefinition: MCPToolDefinition) => {
        handler = registeredHandler;
        definition = registeredDefinition;
      },
    } as unknown as Parameters<typeof registerInteractTool>[0]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    page = createMockPage({ url: 'https://example.test/app', title: 'Fixture' });
    cdpSend = jest.fn().mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-42' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { clickable: true } } };
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [200, 300, 280, 300, 280, 340, 200, 340] } };
      }
      return {};
    });
    sessionManager = {
      getPage: jest.fn().mockResolvedValue(page),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
      getCDPClient: jest.fn().mockReturnValue({ send: cdpSend }),
      isStealthTarget: jest.fn().mockReturnValue(false),
      getTargetWorkerId: jest.fn().mockReturnValue('default'),
      getTargetCreationCursor: jest.fn().mockReturnValue(20),
      getOpenedTabsAfter: jest.fn().mockReturnValue({
        total: 0,
        truncated: false,
        pendingCount: 0,
        tabs: [],
      }),
    };
    (getSessionManager as jest.Mock).mockReturnValue(sessionManager);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function callPerception(overrides: Record<string, unknown> = {}): Promise<MCPResult> {
    return handler('session-1', {
      tabId: 'tab-1',
      mode: 'perception',
      action: 'click',
      perception: { snapshot: perceptionSnapshot(), elementId: 'v1' },
      ...overrides,
    });
  }

  function expectNoInput(): void {
    expect(page.mouse.click).not.toHaveBeenCalled();
    expect(page.mouse.move).not.toHaveBeenCalled();
  }

  test('exposes an additive perception schema without removing existing modes', () => {
    const properties = definition.inputSchema.properties as Record<string, any>;

    expect(properties.mode.enum).toEqual(['ref', 'coordinate', 'perception']);
    expect(properties.perception.required).toEqual(['snapshot', 'elementId']);
    expect(properties.perception.properties.elementId).toMatchObject({ type: 'string', minLength: 1 });
  });

  test('re-resolves a DOM-backed target and returns bounded provenance', async () => {
    const result = await callPerception({ verify: 'ax-diff', capture_artifact: true });

    expect(result.isError).toBeFalsy();
    expect(cdpSend).toHaveBeenCalledWith(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: 42 });
    expect(cdpSend).toHaveBeenCalledWith(page, 'DOM.getBoxModel', { backendNodeId: 42 });
    expect(page.mouse.click).toHaveBeenCalledWith(240, 320);
    expect(runVerify).toHaveBeenCalledWith(page, 'ax-diff', expect.any(Function));
    expect(captureBackendNodeReplayStep).toHaveBeenCalledWith(expect.objectContaining({
      page,
      backendNodeId: 42,
      kind: 'click',
    }));
    expect(result.structuredContent).toEqual({
      mode: 'perception',
      action: 'click',
      perception: {
        provider: 'mock-provider',
        elementId: 'v1',
        source: 'mock',
        resolution: 'backend-node',
        snapshotAgeMs: 100,
        coordinates: { x: 240, y: 320 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('snapshot-only-warning');
    expect(result.verify).toMatchObject({ mode: 'ax-diff' });
  });

  test('uses the validated snapshot box for a visual-only target', async () => {
    const result = await callPerception({
      perception: { snapshot: visualSnapshot(), elementId: 'v1' },
    });

    expect(result.isError).toBeFalsy();
    expect(page.mouse.click).toHaveBeenCalledWith(140, 220);
    expect(cdpSend).not.toHaveBeenCalled();
    expect(captureBackendNodeReplayStep).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      perception: { resolution: 'snapshot-bbox', coordinates: { x: 140, y: 220 } },
    });
  });

  test.each(['double_click', 'hover'])('dispatches the supported %s action', async (action) => {
    const result = await callPerception({ action });

    expect(result.isError).toBeFalsy();
    if (action === 'double_click') {
      expect(page.mouse.click).toHaveBeenCalledWith(240, 320, { clickCount: 2 });
    } else {
      expect(page.mouse.move).toHaveBeenCalledWith(240, 320);
    }
    expect(result.structuredContent).toMatchObject({ action });
  });

  test('reports opener-correlated tabs created by a perception click', async () => {
    sessionManager.getOpenedTabsAfter.mockReturnValue({
      total: 1,
      truncated: false,
      pendingCount: 0,
      tabs: [{
        tabId: 'popup-1',
        workerId: 'default',
        url: 'https://example.test/report',
        title: 'Report',
        status: 'ready',
      }],
    });

    const result = await callPerception();

    expect(sessionManager.getTargetCreationCursor).toHaveBeenCalledTimes(1);
    expect(sessionManager.getOpenedTabsAfter).toHaveBeenCalledWith({
      afterSequence: 20,
      sessionId: 'session-1',
      workerId: 'default',
      openerTargetId: 'tab-1',
      limit: 5,
    });
    expect(result).toMatchObject({
      openedTabCount: 1,
      openedTabsTruncated: false,
      openedTabs: [{ tabId: 'popup-1', status: 'ready' }],
    });
    expect(result.content?.[0].text).toContain('[Opened tabs]');
    expect(result.structuredContent).toMatchObject({ mode: 'perception', action: 'click' });
  });

  test('reports opener-correlated tabs created by a perception double-click', async () => {
    sessionManager.getOpenedTabsAfter.mockReturnValue({
      total: 1,
      truncated: false,
      pendingCount: 0,
      tabs: [{
        tabId: 'popup-2',
        workerId: 'default',
        url: 'https://example.test/details',
        title: 'Details',
        status: 'ready',
      }],
    });

    const result = await callPerception({ action: 'double_click' });

    expect(page.mouse.click).toHaveBeenCalledWith(240, 320, { clickCount: 2 });
    expect(sessionManager.getOpenedTabsAfter).toHaveBeenCalledWith({
      afterSequence: 20,
      sessionId: 'session-1',
      workerId: 'default',
      openerTargetId: 'tab-1',
      limit: 5,
    });
    expect(result).toMatchObject({
      openedTabCount: 1,
      openedTabs: [{ tabId: 'popup-2', status: 'ready' }],
    });
    expect(result.structuredContent).toMatchObject({ mode: 'perception', action: 'double_click' });
  });

  test('does not observe opened tabs for a perception hover', async () => {
    const result = await callPerception({ action: 'hover' });

    expect(sessionManager.getTargetCreationCursor).not.toHaveBeenCalled();
    expect(sessionManager.getOpenedTabsAfter).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('openedTabCount');
    expect(result).not.toHaveProperty('openedTabs');
  });

  test.each([
    ['tiled capture', perceptionSnapshot({ captureMode: 'tiled' }), 'unsupported_capture_mode'],
    ['wrong tab', perceptionSnapshot({ tabId: 'tab-2' }), 'tab_mismatch'],
    ['wrong URL', perceptionSnapshot({ url: 'https://example.test/other' }), 'url_mismatch'],
    ['stale capture', visualSnapshot(), 'snapshot_stale'],
    ['unsafe label', visualSnapshot({ label: 'Payment credentials' }), 'unsafe_visual_label'],
  ])('rejects %s before dispatching browser input', async (_name, snapshot, reason) => {
    if (reason === 'snapshot_stale') snapshot.capturedAt = NOW - VISUAL_PERCEPTION_MAX_AGE_MS - 1;

    const result = await callPerception({ perception: { snapshot, elementId: 'v1' } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason } },
    });
    expectNoInput();
  });

  test('fails closed when the live viewport cannot be read', async () => {
    page.viewport.mockReturnValue(null);
    page.evaluate.mockRejectedValue(new Error('viewport unavailable'));

    const result = await callPerception();

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: 'viewport_unavailable' } },
    });
    expectNoInput();
  });

  test('rejects visual-only viewport drift before browser input', async () => {
    page.viewport.mockReturnValue({ width: 800, height: 600 });

    const result = await callPerception({
      perception: { snapshot: visualSnapshot(), elementId: 'v1' },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: 'viewport_mismatch' } },
    });
    expectNoInput();
  });

  test.each([
    ['query', { query: 'Continue' }],
    ['coordinate', { coordinate: { x: 10, y: 20 } }],
    ['ref', { ref: 'ref_1' }],
  ])('rejects the mutually exclusive %s field before browser input', async (_name, extra) => {
    const result = await callPerception(extra);

    expect(result.isError).toBe(true);
    expect(result.content?.[0].text).toContain('INVALID_SCHEMA');
    expectNoInput();
  });

  test('rejects type actions even when a value is supplied', async () => {
    const result = await callPerception({ action: 'type', value: 'do not type' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0].text).toContain('UNSUPPORTED_PERCEPTION_ACTION');
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expectNoInput();
  });

  test('fails closed when a DOM-backed target is no longer clickable', async () => {
    cdpSend.mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-42' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { clickable: false } } };
      return {};
    });

    const result = await callPerception();

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: 'backend_node_not_clickable' } },
    });
    expectNoInput();
  });

  test('fails closed when CDP cannot re-resolve the backend node', async () => {
    cdpSend.mockRejectedValue(new Error('stale backend node'));

    const result = await callPerception();

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: 'backend_node_unavailable' } },
    });
    expectNoInput();
  });

  test('fails closed when the live CDP box is degenerate', async () => {
    cdpSend.mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-42' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { clickable: true } } };
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [20, 20, 20, 20, 20, 20, 20, 20] } };
      }
      return {};
    });

    const result = await callPerception();

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: 'invalid_live_bbox' } },
    });
    expectNoInput();
  });

  test('bounds malformed snapshot diagnostics and never dispatches input', async () => {
    const result = await callPerception({
      perception: { snapshot: { version: 1, elements: Array.from({ length: 1000 }, () => ({})) }, elementId: 'v1' },
    });

    const errors = (result.structuredContent?.error as { details?: { errors?: string[] } }).details?.errors;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_PERCEPTION_TARGET', reason: 'malformed_snapshot' } },
    });
    expect(errors?.length).toBeLessThanOrEqual(10);
    expectNoInput();
  });
});
