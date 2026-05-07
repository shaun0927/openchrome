/// <reference types="jest" />

import { createMockSessionManager } from '../utils/mock-session';
import { MAX_INLINE_IMAGE_PAYLOAD_BYTES } from '../../src/config/defaults';
import {
  bufferToBase64WithPayloadGuard,
  getBase64EncodedByteLengthForRawBytes,
} from '../../src/utils/screenshot-guards';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

async function getPageScreenshotHandler(mockSessionManager: ReturnType<typeof createMockSessionManager>) {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));

  const { registerPageScreenshotTool } = await import('../../src/tools/page-screenshot');
  const tools = new Map<string, (sessionId: string, args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown>);
    },
  };

  registerPageScreenshotTool(server as unknown as Parameters<typeof registerPageScreenshotTool>[0]);
  return tools.get('page_screenshot')!;
}

describe('page_screenshot payload guards', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let sessionId: string;
  let tabId: string;

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    sessionId = 'screenshot-guard-session';
    const target = await mockSessionManager.createTarget(sessionId, 'about:blank');
    tabId = target.targetId;
  });

  it('returns existing viewport screenshots when inline payload is under the cap', async () => {
    const handler = await getPageScreenshotHandler(mockSessionManager);
    const page = (await mockSessionManager.getPage(sessionId, tabId))!;
    (page.screenshot as jest.Mock).mockResolvedValue(Buffer.from('small image'));

    const result = await handler(sessionId, { tabId }) as {
      content: Array<{ type: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: 'image',
      data: Buffer.from('small image').toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('rejects inline base64 payloads over 10 MiB after encoding', async () => {
    const handler = await getPageScreenshotHandler(mockSessionManager);
    const page = (await mockSessionManager.getPage(sessionId, tabId))!;
    const rawBytesNeeded = Math.ceil((MAX_INLINE_IMAGE_PAYLOAD_BYTES + 1) * 3 / 4);
    (page.screenshot as jest.Mock).mockResolvedValue(Buffer.alloc(rawBytesNeeded));

    const result = await handler(sessionId, { tabId }) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeds the 10 MiB inline limit');
    expect(result.content[0].text).toContain('path parameter');
  });

  it('rejects oversized full-page captures before starting capture with actionable hint', async () => {
    const handler = await getPageScreenshotHandler(mockSessionManager);
    const page = (await mockSessionManager.getPage(sessionId, tabId))!;
    (page.evaluate as jest.Mock).mockResolvedValue({ width: 6000, height: 5000 });

    const result = await handler(sessionId, { tabId, fullPage: true }) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Full-page screenshot area 6000x5000');
    expect(result.content[0].text).toContain('Request viewport-only capture');
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('validates clip option parsing and uses clip instead of fullPage', async () => {
    const handler = await getPageScreenshotHandler(mockSessionManager);
    const page = (await mockSessionManager.getPage(sessionId, tabId))!;
    (page.screenshot as jest.Mock).mockResolvedValue(Buffer.from('clipped'));

    const invalid = await handler(sessionId, {
      tabId,
      clip: { x: 0, y: 0, width: 0, height: 100 },
    }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('clip width/height must be greater than 0');

    await handler(sessionId, {
      tabId,
      fullPage: true,
      clip: { x: 1, y: 2, width: 300, height: 200 },
    });

    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      fullPage: false,
      clip: { x: 1, y: 2, width: 300, height: 200 },
    }));
  });

  it('labels oversized clips correctly even when fullPage is also requested', async () => {
    const handler = await getPageScreenshotHandler(mockSessionManager);
    const page = (await mockSessionManager.getPage(sessionId, tabId))!;

    const result = await handler(sessionId, {
      tabId,
      fullPage: true,
      clip: { x: 0, y: 0, width: 6000, height: 5000 },
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Clipped screenshot area 6000x5000');
    expect(result.content[0].text).not.toContain('Full-page screenshot area');
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('times out instead of blocking forever when full-page dimension lookup hangs', async () => {
    jest.useFakeTimers();
    try {
      const handler = await getPageScreenshotHandler(mockSessionManager);
      const page = (await mockSessionManager.getPage(sessionId, tabId))!;
      (page.evaluate as jest.Mock).mockImplementation(() => new Promise(() => {}));
      (page.screenshot as jest.Mock).mockResolvedValue(Buffer.from('never reached'));

      const pending = handler(sessionId, { tabId, fullPage: true }) as Promise<{
        content: Array<{ text?: string }>;
        isError?: boolean;
      }>;

      await jest.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Full-page dimension lookup/i);
      expect(page.screenshot).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('computes base64 payload size before encoding oversized buffers', () => {
    expect(getBase64EncodedByteLengthForRawBytes(0)).toBe(0);
    expect(getBase64EncodedByteLengthForRawBytes(1)).toBe(4);
    expect(getBase64EncodedByteLengthForRawBytes(3)).toBe(4);
    expect(getBase64EncodedByteLengthForRawBytes(4)).toBe(8);

    const rawBytesNeeded = Math.ceil((MAX_INLINE_IMAGE_PAYLOAD_BYTES + 1) * 3 / 4);
    const result = bufferToBase64WithPayloadGuard(Buffer.alloc(rawBytesNeeded));

    expect(result.error).toContain('exceeds the 10 MiB inline limit');
    expect(result.data).toBeUndefined();
  });
});
