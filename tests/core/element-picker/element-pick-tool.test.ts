/// <reference types="jest" />

import { createMockSessionManager } from '../../utils/mock-session';

jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

async function loadHandler(mockSessionManager: ReturnType<typeof createMockSessionManager>) {
  jest.resetModules();
  jest.doMock('../../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  const { registerElementPickTool } = await import('../../../src/tools/element-pick');
  const tools = new Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>; definition: any }>();
  const server = {
    registerTool: (name: string, handler: unknown, definition: unknown) => {
      tools.set(name, { handler: handler as any, definition });
    },
  };
  registerElementPickTool(server as any);
  return tools.get('element_pick')!;
}

describe('element_pick tool (#899)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let sessionId: string;
  let tabId: string;

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    sessionId = 'pick-session';
    const target = await mockSessionManager.createTarget(sessionId, 'https://example.test');
    tabId = target.targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('registers start/cancel schema', async () => {
    const { definition } = await loadHandler(mockSessionManager);
    expect(definition.inputSchema.properties.action.enum).toEqual(['start', 'cancel']);
    expect(definition.inputSchema.required).toEqual(['tabId']);
  });

  test('start installs overlay and returns a redacted PickedElement payload', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockResolvedValueOnce({
        success: true,
        element: {
          ancestry: [
            { tagName: 'html', nthOfType: 1 },
            { tagName: 'body', nthOfType: 1 },
            { tagName: 'button', id: 'submit', nthOfType: 1 },
          ],
          role: 'button',
          accessibleName: 'Submit',
          text: 'Submit',
          boundingBox: { x: 10, y: 20, width: 100, height: 30 },
          viewport: { width: 300, height: 200 },
          domSnippet: '<button id="submit" name="token" value="abc1234567890abcdef">Submit</button>',
          computedStyle: { display: 'block', color: 'red', cursor: 'pointer' },
          pageUrl: 'https://example.test',
          pageTitle: 'Example',
          pickedAt: 123,
        },
      });

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent.element.selectors.cssPath).toContain('button#submit');
    expect(result.structuredContent.element.domSnippet).toContain('[REDACTED]');
    expect(result.structuredContent.element.computedStyle).toEqual({ display: 'block', cursor: 'pointer' });
    expect(page.evaluate).toHaveBeenNthCalledWith(1, expect.stringContaining('__openchromeElementPick'));
    expect(page.evaluate).toHaveBeenNthCalledWith(2, 'window.__openchromeElementPick.startAsync({ timeoutMs: 25 })');
  });

  test('cancel installs overlay controller and returns cancel result', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockResolvedValueOnce({ success: true, canceled: true });

    const result = await handler(sessionId, { tabId, action: 'cancel' });
    expect(result.structuredContent).toEqual({ success: true, canceled: true });
    expect(page.evaluate).toHaveBeenNthCalledWith(2, "window.__openchromeElementPick && window.__openchromeElementPick.cancel('cancelled')");
  });

  test('start failure is a structured tool error', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockResolvedValueOnce({ success: false, error: 'timeout' });

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ success: false, error: 'timeout' });
  });

  test('start returns no_human_attached in headless mode', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const { setGlobalConfig } = await import('../../../src/config/global');
    setGlobalConfig({ headless: true });
    const page = mockSessionManager.pages.get(tabId)!;

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      success: false,
      error: 'no_human_attached',
      remediation: expect.stringContaining('without --server-mode'),
    });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('start returns navigated when the main frame navigates before a pick resolves', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    const mainFrame = { url: jest.fn().mockReturnValue('https://example.test/next') };
    let frameNavigated: ((frame: unknown) => void) | undefined;

    (page.mainFrame as jest.Mock).mockReturnValue(mainFrame);
    (page.on as jest.Mock).mockImplementation((event: string, listener: (frame: unknown) => void) => {
      if (event === 'framenavigated') frameNavigated = listener;
      return page;
    });
    (page.off as jest.Mock).mockImplementation((event: string, listener: (frame: unknown) => void) => {
      if (event === 'framenavigated' && frameNavigated === listener) frameNavigated = undefined;
      return page;
    });
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockImplementationOnce(() => new Promise(() => {
        setTimeout(() => frameNavigated?.(mainFrame), 0);
      }));

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ success: false, error: 'navigated' });
    expect(page.off).toHaveBeenCalledWith('framenavigated', expect.any(Function));
  });

  test('start returns target_destroyed when the page closes before a pick resolves', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    let closeListener: (() => void) | undefined;

    (page.on as jest.Mock).mockImplementation((event: string, listener: () => void) => {
      if (event === 'close') closeListener = listener;
      return page;
    });
    (page.off as jest.Mock).mockImplementation((event: string, listener: () => void) => {
      if (event === 'close' && closeListener === listener) closeListener = undefined;
      return page;
    });
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockImplementationOnce(() => new Promise(() => {
        setTimeout(() => closeListener?.(), 0);
      }));

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ success: false, error: 'target_destroyed' });
    expect(page.off).toHaveBeenCalledWith('close', expect.any(Function));
  });

  test('start maps execution-context navigation failures to a structured navigated error', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'));

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ success: false, error: 'navigated' });
  });

  test('start maps target closure failures to a structured target_destroyed error', async () => {
    const { handler } = await loadHandler(mockSessionManager);
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ success: true, installed: true })
      .mockRejectedValueOnce(new Error('Target closed'));

    const result = await handler(sessionId, { tabId, action: 'start', timeoutMs: 25 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ success: false, error: 'target_destroyed' });
  });
});
