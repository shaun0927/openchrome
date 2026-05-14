import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolContext, ToolHandler, throwIfAborted } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import {
  buildPickedElement,
  clampBoundingBox,
  elementPickInstallExpression,
  validateScreenshotPng,
  type ElementPickRecorderInput,
} from '../core/element-picker';
import { getGlobalConfig } from '../config/global';

interface ElementPickSuccess {
  success: true;
  element: ElementPickRecorderInput;
}

interface ElementPickFailure {
  success: false;
  error: string;
  remediation?: string;
}

type ElementPickOverlayResult = ElementPickSuccess | ElementPickFailure | { success: true; started?: true; canceled?: boolean; installed?: true };

const definition: MCPToolDefinition = {
  name: 'element_pick',
  description: 'Start or cancel an in-page human element picker overlay. Returns selector, DOM, style, and bounding-box facts; it does not persist skills directly.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'REQUIRED Tab ID to pick from' },
      action: { type: 'string', enum: ['start', 'cancel'], description: 'start waits for a picked element; cancel cancels an in-flight pick. Default: start.' },
      timeoutMs: { type: 'number', description: 'Max wait for a click in ms. Default 60000; capped at 300000.' },
      cancelOnEscape: { type: 'boolean', description: 'Reserved for compatibility; Escape cancellation is enabled by the overlay.' },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.element_pick,
};

const handler: ToolHandler = async (sessionId: string, args: Record<string, unknown>, context?: ToolContext): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const action = (args.action as string | undefined) ?? 'start';
  const timeoutMs = normalizeTimeout(args.timeoutMs);

  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }
  if (action !== 'start' && action !== 'cancel') {
    return { content: [{ type: 'text', text: 'Error: action must be "start" or "cancel"' }], isError: true };
  }
  if (action === 'start' && getGlobalConfig().headless === true) {
    return jsonResult({
      success: false,
      error: 'no_human_attached',
      remediation: 'Run openchrome without --server-mode or --headless so a human can click the in-page picker overlay.',
    }, true);
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'element_pick');
  if (!page) {
    return { content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }], isError: true };
  }

  try {
    await withTimeout(
      page.evaluate(elementPickInstallExpression()),
      5000,
      'element_pick.install',
      context,
    );

    if (action === 'cancel') {
      const canceled = await withTimeout(
        page.evaluate(`window.__openchromeElementPick && window.__openchromeElementPick.cancel('cancelled')`),
        5000,
        'element_pick.cancel',
        context,
      ) as ElementPickOverlayResult | null;
      const payload = (canceled && typeof canceled === 'object') ? canceled : { success: true, canceled: false };
      return jsonResult(payload);
    }

    const overlayResult = await startElementPick(page, timeoutMs, context);

    if (!overlayResult || overlayResult.success !== true || !('element' in overlayResult)) {
      return jsonResult(overlayResult ?? { success: false, error: 'unknown' }, true);
    }

    const screenshot = await captureElementScreenshot(page, overlayResult.element, context);
    if (screenshot && !screenshot.success) {
      return jsonResult(screenshot, true);
    }

    const picked = buildPickedElement({
      ...overlayResult.element,
      ...(screenshot?.screenshotPng ? { screenshotPng: screenshot.screenshotPng } : {}),
    });
    return jsonResult({ success: true, element: picked });
  } catch (error) {
    throwIfAborted(context);
    return {
      content: [{ type: 'text', text: `element_pick error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 60000;
  return Math.max(1, Math.min(300000, Math.floor(value)));
}

function jsonResult(payload: object, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

async function startElementPick(page: any, timeoutMs: number, context?: ToolContext): Promise<ElementPickOverlayResult> {
  let cleanupLifecycleListeners = () => {};
  const lifecycleResult = new Promise<ElementPickFailure>((resolve) => {
    const onFrameNavigated = (frame: unknown) => {
      if (!isMainFrameNavigation(page, frame)) return;
      cleanupLifecycleListeners();
      resolve({ success: false, error: 'navigated' });
    };
    const onTargetClosed = () => {
      cleanupLifecycleListeners();
      resolve({ success: false, error: 'target_destroyed' });
    };
    page.on?.('framenavigated', onFrameNavigated);
    page.on?.('close', onTargetClosed);
    cleanupLifecycleListeners = () => {
      page.off?.('framenavigated', onFrameNavigated);
      page.off?.('close', onTargetClosed);
    };
  });

  const overlayResult = withTimeout(
    page.evaluate(`window.__openchromeElementPick.startAsync({ timeoutMs: ${timeoutMs} })`),
    timeoutMs + 1000,
    'element_pick.start',
    context,
  ).catch((error) => {
    if (isTargetDestroyedAbort(error)) {
      return { success: false, error: 'target_destroyed' };
    }
    if (isNavigationAbort(error)) {
      return { success: false, error: 'navigated' };
    }
    throw error;
  }) as Promise<ElementPickOverlayResult>;

  try {
    return await Promise.race([overlayResult, lifecycleResult]);
  } finally {
    cleanupLifecycleListeners();
  }
}

function isMainFrameNavigation(page: any, frame: unknown): boolean {
  try {
    const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined;
    return !mainFrame || frame === mainFrame;
  } catch {
    return true;
  }
}

function isNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context|frame was detached|navigation/i.test(message);
}

function isTargetDestroyedAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target closed|session closed|target destroyed|page closed/i.test(message);
}

async function captureElementScreenshot(
  page: any,
  element: ElementPickRecorderInput,
  context?: ToolContext,
): Promise<{ success: true; screenshotPng?: string } | ElementPickFailure> {
  const clip = clampBoundingBox(element.boundingBox, element.viewport);
  if (clip.width <= 0 || clip.height <= 0) {
    return { success: true };
  }

  let session: { send: (method: string, params?: unknown) => Promise<unknown>; detach?: () => Promise<void> } | undefined;
  try {
    session = await withTimeout(
      page.createCDPSession(),
      5000,
      'element_pick.screenshot_session',
      context,
    ) as typeof session;
    if (!session) return { success: true };
    const response = await withTimeout(
      session.send('Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        },
      }),
      5000,
      'element_pick.screenshot',
      context,
    ) as { data?: string } | undefined;
    const data = response?.data;
    if (!data) return { success: true };
    const validation = validateScreenshotPng(data);
    if (!validation.ok) {
      return { success: false, error: validation.error ?? 'snapshot_too_large' };
    }
    return { success: true, screenshotPng: data };
  } finally {
    try {
      await session?.detach?.();
    } catch {
      // Best effort cleanup only; screenshot capture should not fail after a
      // successful pick just because the temporary CDP session already closed.
    }
  }
}

export function registerElementPickTool(server: MCPServer): void {
  server.registerTool('element_pick', handler, definition);
}
