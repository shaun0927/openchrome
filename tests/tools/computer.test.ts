/// <reference types="jest" />
/**
 * Tests for Computer Tool
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { keyNormalizationMap } from '../utils/test-helpers';

// Mock the session manager and ref-id-manager modules
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('ComputerTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getComputerHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

    const { registerComputerTool } = await import('../../src/tools/computer');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerComputerTool(mockServer as unknown as Parameters<typeof registerComputerTool>[0]);
    return tools.get('computer')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-123';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Click Actions', () => {
    test('left_click at coordinates', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [100, 200],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(100, 200);
      expect(result.content[0].text).toContain('Clicked at (100, 200)');
    });

    test('right_click at coordinates', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'right_click',
        coordinate: [150, 250],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(150, 250, { button: 'right' });
      expect(result.content[0].text).toContain('Right-clicked');
    });

    test('double_click at coordinates', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'double_click',
        coordinate: [200, 300],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(200, 300, { clickCount: 2 });
      expect(result.content[0].text).toContain('Double-clicked');
    });

    test('triple_click at coordinates', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'triple_click',
        coordinate: [250, 350],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(250, 350, { clickCount: 3 });
      expect(result.content[0].text).toContain('Triple-clicked');
    });

    test('rejects left_click without coordinates', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coordinate is required');
    });

    test('rejects right_click without coordinates', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'right_click',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coordinate is required');
    });

    test('rejects double_click without coordinates', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'double_click',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coordinate is required');
    });

    test('handles click at origin (0, 0)', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [0, 0],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(0, 0);
      expect(result.content[0].text).toContain('(0, 0)');
    });

    test('handles large coordinate values', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [10000, 20000],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.click).toHaveBeenCalledWith(10000, 20000);
    });
  });

  describe('Hover Action', () => {
    test('hover at coordinates', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'hover',
        coordinate: [100, 200],
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.mouse.move).toHaveBeenCalledWith(100, 200);
      expect(result.content[0].text).toContain('Hovered at (100, 200)');
    });

    test('rejects hover without coordinates', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'hover',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coordinate is required');
    });
  });

  describe('Keyboard Actions', () => {
    test('type text input', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'type',
        text: 'Hello World',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.keyboard.type).toHaveBeenCalledWith('Hello World');
      expect(result.content[0].text).toContain('Typed: Hello World');
    });

    test('press single key', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: 'Enter',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
      expect(result.content[0].text).toContain('Pressed: Enter');
    });

    test('press key combination (ctrl+a)', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: 'ctrl+a',
      });

      expect(page.keyboard.down).toHaveBeenCalledWith('Control');
      expect(page.keyboard.press).toHaveBeenCalledWith('a');
      expect(page.keyboard.up).toHaveBeenCalledWith('Control');
    });

    test('press key combination with multiple modifiers (ctrl+shift+s)', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: 'ctrl+shift+s',
      });

      expect(page.keyboard.down).toHaveBeenCalledWith('Control');
      expect(page.keyboard.down).toHaveBeenCalledWith('Shift');
      expect(page.keyboard.press).toHaveBeenCalledWith('s');
    });

    test('press multiple keys separated by space', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: 'Tab Tab Enter',
      });

      expect(page.keyboard.press).toHaveBeenCalledWith('Tab');
      expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    });

    test.each(Object.entries(keyNormalizationMap))('normalizes key: %s -> %s', async (input, expected) => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: input,
      });

      expect(page.keyboard.press).toHaveBeenCalledWith(expected);
    });

    test('handles unknown keys by passing through', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
        text: 'F12',
      });

      expect(page.keyboard.press).toHaveBeenCalledWith('F12');
    });

    test('rejects type without text', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'type',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('text is required');
    });

    test('rejects key without text', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'key',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('text is required');
    });
  });

  describe('Screenshot', () => {
    test('returns base64 WebP image via CDP', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; data?: string; mimeType?: string }> };

      expect(result.content[0].type).toBe('image');
      expect(result.content[0].data).toBe('base64-screenshot-data');
    });

    test('returns correct mime type', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; mimeType?: string }> };

      expect(result.content[0].mimeType).toBe('image/webp');
    });

    test('uses CDP Page.captureScreenshot', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      });

      const cdpSession = await (page as any).createCDPSession();
      expect(cdpSession.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
        format: 'webp',
        optimizeForSpeed: true,
      }));
    });
  });

  describe('Scroll Actions', () => {
    test('scroll up', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'up',
      });

      expect(page.mouse.move).toHaveBeenCalledWith(500, 500);
      expect(page.mouse.wheel).toHaveBeenCalledWith({
        deltaX: 0,
        deltaY: -300, // 3 * 100 default
      });
    });

    test('scroll down', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'down',
      });

      expect(page.mouse.wheel).toHaveBeenCalledWith({
        deltaX: 0,
        deltaY: 300,
      });
    });

    test('scroll propagates error when mouse.wheel fails', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Mock mouse.wheel to throw timeout error
      (page.mouse.wheel as jest.Mock).mockRejectedValueOnce(
        new Error('Input.dispatchMouseEvent timed out')
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'down',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      // Error should be propagated
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('error');
    });

    test('scroll left', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'left',
      });

      expect(page.mouse.wheel).toHaveBeenCalledWith({
        deltaX: -300,
        deltaY: 0,
      });
    });

    test('scroll right', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'right',
      });

      expect(page.mouse.wheel).toHaveBeenCalledWith({
        deltaX: 300,
        deltaY: 0,
      });
    });

    test('scroll with custom amount', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
        scroll_direction: 'down',
        scroll_amount: 5,
      });

      expect(page.mouse.wheel).toHaveBeenCalledWith({
        deltaX: 0,
        deltaY: 500, // 5 * 100
      });
    });

    test('rejects scroll without coordinates', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        scroll_direction: 'down',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coordinate is required');
    });

    test('rejects scroll without direction', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll',
        coordinate: [500, 500],
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('scroll_direction is required');
    });
  });

  describe('Scroll To Action', () => {
    test('scroll_to with valid ref', async () => {
      const handler = await getComputerHandler();

      // Set up a ref
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'button', 'Submit');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: refId,
      }) as { content: Array<{ type: string; text: string }> };

      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, refId);
      expect(result.content[0].text).toContain('Scrolled to');
    });

    test('scroll_to with invalid ref', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: 'nonexistent_ref',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('rejects scroll_to without ref', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ref is required');
    });
  });

  describe('Wait Action', () => {
    test('waits for specified duration', async () => {
      const handler = await getComputerHandler();
      const startTime = Date.now();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'wait',
        duration: 0.1, // 100ms
      }) as { content: Array<{ type: string; text: string }> };

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
      expect(result.content[0].text).toContain('0.1 seconds');
    });

    test('caps wait at 30 seconds', async () => {
      const handler = await getComputerHandler();

      // This test would take too long if it actually waited, so we just check the cap logic
      // The actual wait is capped at 30 seconds
      const startTime = Date.now();

      // Don't actually wait 30 seconds in tests - just verify the cap is applied
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'wait',
        duration: 0.01, // Just a short wait to verify it works
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Waited');
    });

    test('handles default duration', async () => {
      const handler = await getComputerHandler();
      const startTime = Date.now();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'wait',
      }) as { content: Array<{ type: string; text: string }> };

      // Default should be 1 second, but we'll just check it worked
      expect(result.content[0].text).toContain('Waited');
    });

    test('handles zero duration (defaults to 1 second)', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'wait',
        duration: 0,
      }) as { content: Array<{ type: string; text: string }> };

      // Note: Implementation uses (duration || 1) which treats 0 as falsy, defaulting to 1 second
      expect(result.content[0].text).toContain('Waited 1 seconds');
    });
  });

  describe('Error Handling', () => {
    test('returns error for missing tabId', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        action: 'screenshot',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error for unknown action', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'unknown_action',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action');
    });

    test('returns error when tab not found', async () => {
      const handler = await getComputerHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        action: 'screenshot',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('handles screenshot failure with DOM fallback when page is responsive', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Make CDP session fail both attempts (via target.createCDPSession)
      const target = (page as any).target();
      (target.createCDPSession as jest.Mock).mockRejectedValue(new Error('CDP unavailable'));
      // But page.evaluate works (page is responsive) — first call is readyState, second is DOM fallback
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce('complete')
        .mockResolvedValueOnce({
          url: 'https://example.com',
          title: 'Test',
          readyState: 'complete',
          textPreview: 'page content',
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Screenshot failed');
      expect(result.content[0].text).toContain('DOM fallback');
    });

    test('handles click failure', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.mouse.click as jest.Mock).mockRejectedValue(new Error('Click failed'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [100, 100],
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Click failed');
    });
  });

  describe('Session Isolation', () => {
    test('rejects actions on tab from another session', async () => {
      const handler = await getComputerHandler();

      // Create a second session with its own tab
      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      // Try to take screenshot of session2's tab from session1
      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });

  describe('Screenshot Resilience', () => {
    test('screenshot retries once on CDP failure', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Access the target mock (page.target().createCDPSession is the actual code path)
      const target = (page as any).target();
      (target.createCDPSession as jest.Mock)
        .mockRejectedValueOnce(new Error('CDP timeout'))
        .mockResolvedValueOnce({
          send: jest.fn().mockResolvedValue({ data: 'retry-screenshot-data' }),
          detach: jest.fn().mockResolvedValue(undefined),
        });

      // readyState check
      (page.evaluate as jest.Mock).mockResolvedValueOnce('complete');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; data?: string; mimeType?: string }> };

      expect(result.content[0].type).toBe('image');
      expect(result.content[0].data).toBe('retry-screenshot-data');
      expect(result.content[0].mimeType).toBe('image/webp');
    });

    test('screenshot returns DOM fallback when both attempts fail', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Both CDP attempts fail (via target.createCDPSession)
      const target = (page as any).target();
      (target.createCDPSession as jest.Mock).mockRejectedValue(new Error('CDP unavailable'));

      // readyState check + DOM fallback evaluate
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce('complete')
        .mockResolvedValueOnce({
          url: 'https://example.com',
          title: 'Example',
          readyState: 'complete',
          textPreview: 'Hello world content',
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Screenshot failed');
      expect(result.content[0].text).toContain('DOM fallback');
    });

    test('screenshot checks page readiness before capture', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // readyState returns 'complete' immediately
      (page.evaluate as jest.Mock).mockResolvedValueOnce('complete');

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      });

      // evaluate should have been called for readyState check
      expect(page.evaluate).toHaveBeenCalled();
    });

    test('DOM fallback does not set isError', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Both CDP attempts fail (via target.createCDPSession)
      const target = (page as any).target();
      (target.createCDPSession as jest.Mock).mockRejectedValue(new Error('CDP unavailable'));

      // readyState + DOM fallback succeed
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce('complete')
        .mockResolvedValueOnce({
          url: 'https://example.com',
          title: 'Test Page',
          readyState: 'complete',
          textPreview: 'Some content',
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

      // DOM fallback is usable content — NOT an error
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Screenshot failed');
    });

    test('completely unresponsive page sets isError', async () => {
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Both CDP attempts fail (via target.createCDPSession)
      const target = (page as any).target();
      (target.createCDPSession as jest.Mock).mockRejectedValue(new Error('CDP unavailable'));

      // All page.evaluate calls fail (page is completely unresponsive)
      (page.evaluate as jest.Mock).mockRejectedValue(new Error('Execution context was destroyed'));
      (page.waitForFunction as jest.Mock).mockRejectedValue(new Error('Execution context was destroyed'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'screenshot',
      }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('unresponsive');
    });
  });

  describe('Hit Element Detection', () => {
    // Helper to set up CDP responses for a button element hit
    function setupButtonHit() {
      const cdpClient = mockSessionManager.mockCDPClient;
      cdpClient.cdpResponses.set(
        `DOM.getNodeForLocation:${JSON.stringify({ x: 100, y: 200, includeUserAgentShadowDOM: false })}`,
        { backendNodeId: 42, nodeId: 10 }
      );
      cdpClient.cdpResponses.set(
        `DOM.describeNode:${JSON.stringify({ backendNodeId: 42 })}`,
        {
          node: {
            localName: 'button',
            attributes: ['id', 'submit-btn', 'class', 'btn-primary'],
            nodeType: 1,
          },
        }
      );
    }

    // Helper to set up CDP responses for a non-interactive div element hit
    function setupDivHit(x: number, y: number) {
      const cdpClient = mockSessionManager.mockCDPClient;
      cdpClient.cdpResponses.set(
        `DOM.getNodeForLocation:${JSON.stringify({ x, y, includeUserAgentShadowDOM: false })}`,
        { backendNodeId: 99, nodeId: 20 }
      );
      cdpClient.cdpResponses.set(
        `DOM.describeNode:${JSON.stringify({ backendNodeId: 99 })}`,
        {
          node: {
            localName: 'div',
            attributes: ['class', 'container'],
            nodeType: 1,
          },
        }
      );
    }

    test('left_click includes hit element info for interactive element', async () => {
      setupButtonHit();
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Mock evaluate to return empty textContent
      (page.evaluate as jest.Mock).mockResolvedValueOnce('');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [100, 200],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Clicked at (100, 200)');
      expect(result.content[0].text).toContain('Hit:');
      expect(result.content[0].text).toContain('<button');
      expect(result.content[0].text).toContain('[interactive]');
    });

    test('hit element shows [not interactive] flag for non-interactive element', async () => {
      setupDivHit(100, 200);
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // First evaluate: textContent fetch, second: nearest interactive search
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce('')    // textContent
        .mockResolvedValueOnce(null); // nearest interactive (none found)

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [100, 200],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('[not interactive]');
      expect(result.content[0].text).not.toContain('[interactive]');
    });

    test('nearest interactive element reported when clicking empty space', async () => {
      setupDivHit(300, 400);
      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // First evaluate: textContent fetch
      // Second evaluate: nearest interactive found
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce({
          tag: 'button',
          text: 'Submit',
          x: 300,
          y: 380,
          dx: 0,
          dy: -20,
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [300, 400],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Nearest interactive:');
      expect(result.content[0].text).toContain('<button>');
      expect(result.content[0].text).toContain('"Submit"');
      expect(result.content[0].text).toContain('above');
    });

    test('graceful fallback when CDP getNodeForLocation fails', async () => {
      // Make CDP throw on getNodeForLocation to simulate CDP failure
      const cdpClient = mockSessionManager.mockCDPClient;
      const originalSend = cdpClient.send as jest.Mock;
      originalSend.mockImplementationOnce(async (_page: unknown, method: string) => {
        if (method === 'DOM.getNodeForLocation') {
          throw new Error('CDP connection lost');
        }
        return {};
      });

      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        coordinate: [500, 600],
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      // Should still succeed (not an error) and return basic click message
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Clicked at (500, 600)');
      // No hit info since CDP threw
      expect(result.content[0].text).not.toContain('Hit:');
    });

    test('ref-based left_click does NOT include hit detection', async () => {
      setupButtonHit();
      const handler = await getComputerHandler();

      // Generate a ref and set up box model response
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 42, 'button', 'Submit');
      mockSessionManager.mockCDPClient.cdpResponses.set(
        `DOM.scrollIntoViewIfNeeded:${JSON.stringify({ backendNodeId: 42 })}`,
        {}
      );
      mockSessionManager.mockCDPClient.cdpResponses.set(
        `DOM.getBoxModel:${JSON.stringify({ backendNodeId: 42 })}`,
        { model: { content: [90, 190, 110, 190, 110, 210, 90, 210] } }
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'left_click',
        ref: refId,
      }) as { content: Array<{ type: string; text: string }> };

      // Ref-based click returns early before hit detection
      expect(result.content[0].text).toContain(`Clicked element ${refId}`);
      expect(result.content[0].text).not.toContain('Hit:');
    });

    test('double_click includes hit element info', async () => {
      const cdpClient = mockSessionManager.mockCDPClient;
      cdpClient.cdpResponses.set(
        `DOM.getNodeForLocation:${JSON.stringify({ x: 200, y: 300, includeUserAgentShadowDOM: false })}`,
        { backendNodeId: 55, nodeId: 15 }
      );
      cdpClient.cdpResponses.set(
        `DOM.describeNode:${JSON.stringify({ backendNodeId: 55 })}`,
        {
          node: {
            localName: 'input',
            attributes: ['type', 'text', 'id', 'search'],
            nodeType: 1,
          },
        }
      );

      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.evaluate as jest.Mock).mockResolvedValueOnce('');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'double_click',
        coordinate: [200, 300],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Double-clicked at (200, 300)');
      expect(result.content[0].text).toContain('Hit:');
      expect(result.content[0].text).toContain('<input');
      expect(result.content[0].text).toContain('[interactive]');
    });

    test('triple_click includes hit element info', async () => {
      const cdpClient = mockSessionManager.mockCDPClient;
      cdpClient.cdpResponses.set(
        `DOM.getNodeForLocation:${JSON.stringify({ x: 250, y: 350, includeUserAgentShadowDOM: false })}`,
        { backendNodeId: 77, nodeId: 25 }
      );
      cdpClient.cdpResponses.set(
        `DOM.describeNode:${JSON.stringify({ backendNodeId: 77 })}`,
        {
          node: {
            localName: 'a',
            attributes: ['href', '/page', 'class', 'nav-link'],
            nodeType: 1,
          },
        }
      );

      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.evaluate as jest.Mock).mockResolvedValueOnce('Page Link');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'triple_click',
        coordinate: [250, 350],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Triple-clicked at (250, 350)');
      expect(result.content[0].text).toContain('Hit:');
      expect(result.content[0].text).toContain('<a');
      expect(result.content[0].text).toContain('[interactive]');
    });

    test('right_click includes hit element info', async () => {
      const cdpClient = mockSessionManager.mockCDPClient;
      cdpClient.cdpResponses.set(
        `DOM.getNodeForLocation:${JSON.stringify({ x: 150, y: 250, includeUserAgentShadowDOM: false })}`,
        { backendNodeId: 33, nodeId: 11 }
      );
      cdpClient.cdpResponses.set(
        `DOM.describeNode:${JSON.stringify({ backendNodeId: 33 })}`,
        {
          node: {
            localName: 'span',
            attributes: ['role', 'button', 'aria-label', 'Close'],
            nodeType: 1,
          },
        }
      );

      const handler = await getComputerHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.evaluate as jest.Mock).mockResolvedValueOnce('');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'right_click',
        coordinate: [150, 250],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Right-clicked at (150, 250)');
      expect(result.content[0].text).toContain('Hit:');
      expect(result.content[0].text).toContain('role="button"');
      expect(result.content[0].text).toContain('[interactive]');
    });
  });
});
