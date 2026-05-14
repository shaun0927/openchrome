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
});
