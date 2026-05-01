/// <reference types="jest" />
/**
 * Tests for Validate Page Tool — covers regressions called out by Codex on PR #653:
 *  - P1: smartGoto authRedirect was being silently dropped, so SSO/login redirects
 *        looked like healthy pages.
 *  - P2: normalizeUrl mishandled uppercase schemes ("HTTP://example.com" became
 *        "https://HTTP://example.com").
 */

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import type { SmartGotoResult } from '../../src/utils/smart-goto';

// Variables prefixed with `mock` are accessible inside `jest.mock` factories.
// Wrapped via getter so the factory references the binding lazily — `validate-page`
// is loaded via dynamic import inside the handler describe-block, after this
// const has been initialized, avoiding the TDZ error a static import would cause.
const mockSmartGotoFn = jest.fn<Promise<SmartGotoResult>, [unknown, string, unknown?]>(
  async () => ({ response: null }),
);
jest.mock('../../src/utils/smart-goto', () => ({
  smartGoto: (...args: unknown[]) => mockSmartGotoFn(...(args as [unknown, string, unknown?])),
}));

import { getSessionManager } from '../../src/session-manager';

interface ValidatePageResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  status: string;
  authRedirect?: boolean;
  redirectedFrom?: string;
  authRedirectHost?: string;
  error?: string;
}

// Lazy loader — defers requiring validate-page until after the mock module
// graph above is registered with jest.
const loadValidatePageModule = (): typeof import('../../src/tools/validate-page') => {
  return require('../../src/tools/validate-page');
};

describe('normalizeUrl (P2 regression)', () => {
  let normalizeUrl: (raw: string) => string;

  beforeAll(() => {
    normalizeUrl = loadValidatePageModule().normalizeUrl;
  });

  test('lowercase http:// is preserved', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  test('lowercase https:// is preserved', () => {
    expect(normalizeUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  test('bare domain gets https:// prepended', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  test('uppercase HTTP:// is normalized to lowercase, host preserved', () => {
    expect(normalizeUrl('HTTP://example.com')).toBe('http://example.com');
  });

  test('uppercase HTTPS:// is normalized to lowercase, host preserved', () => {
    expect(normalizeUrl('HTTPS://example.com/foo')).toBe('https://example.com/foo');
  });

  test('mixed-case Https:// is normalized to lowercase', () => {
    expect(normalizeUrl('Https://Example.COM/Path')).toBe('https://Example.COM/Path');
  });

  test('uppercase scheme does NOT produce a doubled-scheme URL', () => {
    const out = normalizeUrl('HTTP://example.com');
    expect(out).not.toMatch(/https:\/\/HTTP:/i);
    const parsed = new URL(out);
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.protocol).toBe('http:');
  });

  test('rejects non-http schemes (lowercase)', () => {
    expect(() => normalizeUrl('ftp://example.com')).toThrow(/not supported/);
  });

  test('rejects non-http schemes (uppercase)', () => {
    expect(() => normalizeUrl('FTP://example.com')).toThrow(/not supported/);
    expect(() => normalizeUrl('FILE:///etc/passwd')).toThrow(/not supported/);
  });

  test('rejects malformed URLs with no hostname', () => {
    expect(() => normalizeUrl('https://')).toThrow();
  });
});

describe('validate_page handler — auth redirect (P1 regression)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getValidatePageHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/smart-goto', () => ({
      smartGoto: (...args: unknown[]) => mockSmartGotoFn(...(args as [unknown, string, unknown?])),
    }));
    const { registerValidatePageTool } = await import('../../src/tools/validate-page');

    const tools: Map<
      string,
      { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }
    > = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, {
          handler: handler as (
            sessionId: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>,
        });
      },
    };

    registerValidatePageTool(
      mockServer as unknown as Parameters<typeof registerValidatePageTool>[0],
    );
    return tools.get('validate_page')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    mockSmartGotoFn.mockReset();
    mockSmartGotoFn.mockResolvedValue({ response: null });

    testSessionId = 'test-session-validate-page';
    const created = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = created.targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('marks status as auth_redirect_required when smartGoto reports a redirect', async () => {
    mockSmartGotoFn.mockResolvedValue({
      response: null,
      authRedirect: {
        from: 'https://app.example.com',
        to: 'https://accounts.google.com/signin',
        host: 'accounts.google.com',
      },
    });

    const handler = await getValidatePageHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.url as jest.Mock).mockReturnValue('https://accounts.google.com/signin');

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      url: 'https://app.example.com',
      captureConsoleMs: 0,
    })) as ValidatePageResult;

    expect(result.status).toBe('auth_redirect_required');
    expect(result.authRedirect).toBe(true);
    expect(result.redirectedFrom).toBe('https://app.example.com');
    expect(result.authRedirectHost).toBe('accounts.google.com');
    expect(result.error).toContain('accounts.google.com');
    expect(result.content[0].text).toContain('auth_redirect_required');
    expect(result.content[0].text).toContain('accounts.google.com');
  });

  test('returns status=ok with no authRedirect fields when smartGoto succeeds', async () => {
    mockSmartGotoFn.mockResolvedValue({ response: null });

    const handler = await getValidatePageHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.url as jest.Mock).mockReturnValue('https://example.com');
    (page.evaluate as jest.Mock).mockResolvedValue({
      interactiveCount: 0,
      formCount: 0,
      hasCanvas: false,
      hasIframe: false,
      bodyTextSample: '',
    });

    const result = (await handler(testSessionId, {
      tabId: testTargetId,
      url: 'https://example.com',
      captureConsoleMs: 0,
    })) as ValidatePageResult;

    expect(result.status).toBe('ok');
    expect(result.authRedirect).toBeUndefined();
    expect(result.redirectedFrom).toBeUndefined();
    expect(result.authRedirectHost).toBeUndefined();
  });

  test('does not run waitForSelector when an auth redirect is detected', async () => {
    mockSmartGotoFn.mockResolvedValue({
      response: null,
      authRedirect: {
        from: 'https://app.example.com',
        to: 'https://accounts.google.com/signin',
        host: 'accounts.google.com',
      },
    });

    const handler = await getValidatePageHandler();
    const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
    (page.url as jest.Mock).mockReturnValue('https://accounts.google.com/signin');

    await handler(testSessionId, {
      tabId: testTargetId,
      url: 'https://app.example.com',
      waitForSelector: '#dashboard',
      captureConsoleMs: 0,
    });

    expect(page.waitForSelector).not.toHaveBeenCalled();
  });
});
