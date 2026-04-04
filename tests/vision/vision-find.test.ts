/// <reference types="jest" />
/**
 * Tests for Vision Find Tool and Vision Config (Phase 2: Vision Hybrid Mode #577)
 */

// ─── getVisionMode config tests ───

describe('getVisionMode', () => {
  const originalEnv = process.env.OPENCHROME_VISION_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCHROME_VISION_MODE;
    } else {
      process.env.OPENCHROME_VISION_MODE = originalEnv;
    }
    jest.resetModules();
  });

  it('returns fallback by default when env is not set', async () => {
    delete process.env.OPENCHROME_VISION_MODE;
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('fallback');
  });

  it('returns off when env is off', async () => {
    process.env.OPENCHROME_VISION_MODE = 'off';
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('off');
  });

  it('returns auto when env is auto', async () => {
    process.env.OPENCHROME_VISION_MODE = 'auto';
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('auto');
  });

  it('returns fallback for invalid values', async () => {
    process.env.OPENCHROME_VISION_MODE = 'invalid-value';
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('fallback');
  });
});

// ─── Mock Page Factory ───

function createMockPage(evaluateResult: unknown[] = [], viewport = { width: 1920, height: 1080 }) {
  return {
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      // Overlay injection/removal calls
      if (args.length === 3 && typeof args[2] === 'string' && String(args[2]).includes('oc_vision')) {
        return Promise.resolve();
      }
      if (args.length === 1 && typeof args[0] === 'string' && String(args[0]).includes('oc_vision')) {
        return Promise.resolve();
      }
      return Promise.resolve(evaluateResult);
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
    viewport: jest.fn().mockReturnValue(viewport),
  };
}

// ─── VisionFindTool ───

describe('VisionFindTool', () => {
  const getVisionFindHandler = async (mockSessionManager: Record<string, jest.Mock>) => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: jest.fn(() => mockSessionManager),
    }));

    const { registerVisionFindTool } = await import('../../src/tools/vision-find');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>, context?: unknown) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>, context?: unknown) => Promise<unknown> });
      },
    };

    registerVisionFindTool(mockServer as unknown as Parameters<typeof registerVisionFindTool>[0]);
    return tools.get('vision_find')!.handler;
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns annotated screenshot and element map', async () => {
    const mockElements = [
      { role: 'button', name: 'Submit', x: 100, y: 200, width: 80, height: 30 },
      { role: 'link', name: 'Home', x: 10, y: 10, width: 60, height: 20 },
    ];
    const page = createMockPage(mockElements);

    const mockSessionManager = {
      getPage: jest.fn().mockResolvedValue(page),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
    };

    const handler = await getVisionFindHandler(mockSessionManager);
    const context = { startTime: Date.now(), deadlineMs: 60000 };
    const result = await handler('session-1', { tabId: 'tab-1' }, context) as any;

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('2 elements found');
    expect(result.content[1].type).toBe('image');
    expect(result.content[1].data).toBeTruthy();
    expect(result.content[1].mimeType).toMatch(/^image\//);
  });

  it('errors on missing tabId', async () => {
    const mockSessionManager = {
      getPage: jest.fn(),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
    };

    const handler = await getVisionFindHandler(mockSessionManager);
    const result = await handler('session-1', {}) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tabId is required');
  });

  it('errors on missing tab', async () => {
    const mockSessionManager = {
      getPage: jest.fn().mockResolvedValue(null),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
    };

    const handler = await getVisionFindHandler(mockSessionManager);
    const context = { startTime: Date.now(), deadlineMs: 60000 };
    const result = await handler('session-1', { tabId: 'nonexistent' }, context) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on low budget', async () => {
    const mockSessionManager = {
      getPage: jest.fn(),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
    };

    const handler = await getVisionFindHandler(mockSessionManager);
    // Budget of only 5s — less than the 10s minimum
    const context = { startTime: Date.now(), deadlineMs: 5000 };
    const result = await handler('session-1', { tabId: 'tab-1' }, context) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('deadline approaching');
  });
});

// ─── Find tool schema includes vision_fallback ───

describe('FindTool schema', () => {
  it('find tool includes vision_fallback property', async () => {
    jest.resetModules();

    // Mock all find tool dependencies
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: jest.fn(() => ({})),
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: jest.fn(() => ({})),
    }));
    jest.doMock('../../src/utils/ax-element-resolver', () => ({
      resolveElementsByAXTree: jest.fn().mockResolvedValue([]),
      invalidateAXCache: jest.fn(),
      clearAXCache: jest.fn(),
      MATCH_LEVEL_LABELS: ['exact', 'partial', 'fuzzy'],
    }));
    jest.doMock('../../src/utils/ralph/circuit-breaker', () => ({
      getCircuitBreaker: jest.fn(() => ({
        check: jest.fn().mockReturnValue({ allowed: true }),
        recordElementFailure: jest.fn(),
        recordElementSuccess: jest.fn(),
      })),
    }));

    const { registerFindTool } = await import('../../src/tools/find');

    let capturedDefinition: any;
    const mockServer = {
      registerTool: (_name: string, _handler: unknown, definition: unknown) => {
        capturedDefinition = definition;
      },
    };

    registerFindTool(mockServer as unknown as Parameters<typeof registerFindTool>[0]);

    expect(capturedDefinition.inputSchema.properties).toHaveProperty('vision_fallback');
    expect(capturedDefinition.inputSchema.properties.vision_fallback.type).toBe('boolean');
  });
});
