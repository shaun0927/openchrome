/// <reference types="jest" />

/**
 * Unit tests for the oc_gate_inspect MCP tool (B2-PR1 of #1359).
 *
 * Covers:
 *  - registration shape (name, annotations, required input)
 *  - facts-only output when no gate is present
 *  - facts-only output when a captcha gate IS present (each captcha type)
 *  - tabId validation and missing-page error path
 *  - P7 invariant: no CAPTCHA solver provider module is loaded
 */

import type { MCPToolDefinition, MCPResult, ToolHandler } from '../../src/types/mcp';

const PROVIDER_MODULE_KEYS = [
  '/captcha/providers/twocaptcha',
  '/captcha/providers/anticaptcha',
  '/captcha/providers/capsolver',
];

function providerModulesInRequireCache(): string[] {
  return Object.keys(require.cache).filter(k =>
    PROVIDER_MODULE_KEYS.some(suffix => k.includes(suffix)),
  );
}

// ─── Test harness ──────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class MockServer {
  public tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

function parseResult(result: MCPResult): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

// ─── Module mocks ──────────────────────────────────────────────────────────

const mockGetPage = jest.fn();
const mockDetectCaptcha = jest.fn();

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getPage: mockGetPage }),
}));

jest.mock('../../src/captcha/detect', () => ({
  detectCaptcha: (...args: unknown[]) => mockDetectCaptcha(...args),
}));

function loadHandler(): {
  handler: ToolHandler;
  definition: MCPToolDefinition;
} {
  jest.isolateModules(() => {
    /* nothing — required to ensure the mocks above are in scope when the tool is loaded */
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerOcGateInspectTool } = require('../../src/tools/oc-gate-inspect');
  const server = new MockServer();
  registerOcGateInspectTool(server as unknown as Parameters<typeof registerOcGateInspectTool>[0]);
  const registered = server.tools.get('oc_gate_inspect');
  if (!registered) throw new Error('tool was not registered');
  return { handler: registered.handler, definition: registered.definition };
}

function makeFakePage(url: string) {
  return { url: () => url };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('oc_gate_inspect — registration', () => {
  beforeEach(() => {
    mockGetPage.mockReset();
    mockDetectCaptcha.mockReset();
  });

  test('registers a tool named oc_gate_inspect with tabId required and read-only annotations', () => {
    const { definition } = loadHandler();
    expect(definition.name).toBe('oc_gate_inspect');
    expect(definition.inputSchema.type).toBe('object');
    expect(definition.inputSchema.required).toEqual(['tabId']);
    // READ_ONLY: not destructive, not open-world, idempotent or readOnlyHint true.
    expect(definition.annotations?.readOnlyHint).toBe(true);
    expect(definition.annotations?.destructiveHint).toBe(false);
    expect(definition.annotations?.openWorldHint).toBe(false);
  });
});

describe('oc_gate_inspect — facts-only output', () => {
  beforeEach(() => {
    mockGetPage.mockReset();
    mockDetectCaptcha.mockReset();
  });

  test('no gate present → {detected: false, pageUrl}', async () => {
    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(makeFakePage('https://example.com/'));
    mockDetectCaptcha.mockResolvedValue(null);

    const result = await handler('sess-1', { tabId: 'tab-1' });
    const out = parseResult(result);

    expect(out).toEqual({ detected: false, pageUrl: 'https://example.com/' });
  });

  test('captcha present → kind + gateType + invisible + siteKey + source', async () => {
    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(makeFakePage('https://example.com/'));
    mockDetectCaptcha.mockResolvedValue({
      detected: true,
      captchaType: 'recaptcha_v2',
      siteKey: { key: 'site-key-abc', source: 'attribute' },
      invisible: false,
      pageUrl: 'https://example.com/',
    });

    const result = await handler('sess-1', { tabId: 'tab-1' });
    const out = parseResult(result);

    expect(out).toEqual({
      detected: true,
      kind: 'captcha',
      gateType: 'recaptcha_v2',
      siteKey: 'site-key-abc',
      siteKeySource: 'attribute',
      invisible: false,
      pageUrl: 'https://example.com/',
    });
  });

  test('captcha v3 (invisible, no site key) is reported without siteKey fields', async () => {
    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(makeFakePage('https://example.com/'));
    mockDetectCaptcha.mockResolvedValue({
      detected: true,
      captchaType: 'recaptcha_v3',
      invisible: true,
      pageUrl: 'https://example.com/',
    });

    const result = await handler('sess-1', { tabId: 'tab-1' });
    const out = parseResult(result);

    expect(out.detected).toBe(true);
    expect(out.kind).toBe('captcha');
    expect(out.gateType).toBe('recaptcha_v3');
    expect(out.invisible).toBe(true);
    expect('siteKey' in out).toBe(false);
    expect('siteKeySource' in out).toBe(false);
  });

  test('aws_waf with no extractable site key is still reported', async () => {
    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(makeFakePage('https://example.com/'));
    mockDetectCaptcha.mockResolvedValue({
      detected: true,
      captchaType: 'aws_waf',
      invisible: false,
      pageUrl: 'https://example.com/',
    });

    const result = await handler('sess-1', { tabId: 'tab-1' });
    const out = parseResult(result);

    expect(out.detected).toBe(true);
    expect(out.gateType).toBe('aws_waf');
    expect('siteKey' in out).toBe(false);
  });
});

describe('oc_gate_inspect — input validation', () => {
  beforeEach(() => {
    mockGetPage.mockReset();
    mockDetectCaptcha.mockReset();
  });

  test('missing tabId returns an error result and never calls getPage', async () => {
    const { handler } = loadHandler();

    const result = await handler('sess-1', {});

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/tabId is required/i);
    expect(mockGetPage).not.toHaveBeenCalled();
    expect(mockDetectCaptcha).not.toHaveBeenCalled();
  });

  test('tabId of wrong type returns an error', async () => {
    const { handler } = loadHandler();

    const result = await handler('sess-1', { tabId: 123 as unknown as string });

    expect(result.isError).toBe(true);
    expect(mockDetectCaptcha).not.toHaveBeenCalled();
  });

  test('page-not-found returns an error result', async () => {
    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(null);

    const result = await handler('sess-1', { tabId: 'tab-missing' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not found/i);
    expect(mockDetectCaptcha).not.toHaveBeenCalled();
  });
});

describe('oc_gate_inspect — P7 invariant', () => {
  beforeEach(() => {
    mockGetPage.mockReset();
    mockDetectCaptcha.mockReset();
  });

  test('inspecting a captcha-gated page does NOT load any solver provider module', async () => {
    const before = providerModulesInRequireCache();

    const { handler } = loadHandler();
    mockGetPage.mockResolvedValue(makeFakePage('https://example.com/'));
    mockDetectCaptcha.mockResolvedValue({
      detected: true,
      captchaType: 'hcaptcha',
      siteKey: { key: 'k', source: 'attribute' },
      invisible: false,
      pageUrl: 'https://example.com/',
    });

    await handler('sess-1', { tabId: 'tab-1' });

    const after = providerModulesInRequireCache();
    expect(after).toEqual(before);
  });
});
