/**
 * Emulate Device Tool - Device emulation with viewport and user agent
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Device presets based on common devices
interface DevicePreset {
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  userAgent: string | null;
}

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iphone-14': {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'iphone-14-pro-max': {
    viewport: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'iphone-se': {
    viewport: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'ipad-pro': {
    viewport: { width: 1024, height: 1366, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'ipad-mini': {
    viewport: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-7': {
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
  'galaxy-s21': {
    viewport: { width: 360, height: 800, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
  'galaxy-fold': {
    viewport: { width: 280, height: 653, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-F926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
  'desktop-1080p': {
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    userAgent: null,
  },
  'desktop-1440p': {
    viewport: { width: 2560, height: 1440, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    userAgent: null,
  },
  'desktop-4k': {
    viewport: { width: 3840, height: 2160, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    userAgent: null,
  },
  'laptop-13': {
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    userAgent: null,
  },
  'laptop-15': {
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    userAgent: null,
  },
};

const definition: MCPToolDefinition = {
  name: 'emulate_device',
  description: `Emulate a device with specific viewport and user agent.
Presets: ${Object.keys(DEVICE_PRESETS).join(', ')}
Use "preset" for predefined devices or provide custom viewport settings.`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to emulate device on',
      },
      preset: {
        type: 'string',
        description: `Device preset: ${Object.keys(DEVICE_PRESETS).join(', ')}`,
        enum: Object.keys(DEVICE_PRESETS),
      },
      width: {
        type: 'number',
        description: 'Custom viewport width (overrides preset)',
      },
      height: {
        type: 'number',
        description: 'Custom viewport height (overrides preset)',
      },
      deviceScaleFactor: {
        type: 'number',
        description: 'Device scale factor (default: 1)',
      },
      isMobile: {
        type: 'boolean',
        description: 'Whether to emulate mobile device (default: false)',
      },
      hasTouch: {
        type: 'boolean',
        description: 'Whether to emulate touch events (default: false)',
      },
      userAgent: {
        type: 'string',
        description: 'Custom user agent (overrides preset)',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const preset = args.preset as string | undefined;
  const width = args.width as number | undefined;
  const height = args.height as number | undefined;
  const deviceScaleFactor = args.deviceScaleFactor as number | undefined;
  const isMobile = args.isMobile as boolean | undefined;
  const hasTouch = args.hasTouch as boolean | undefined;
  const userAgent = args.userAgent as string | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    let finalViewport: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      isMobile: boolean;
      hasTouch: boolean;
    };
    let finalUserAgent: string | null = null;
    let deviceName: string;

    if (preset) {
      const presetDevice = DEVICE_PRESETS[preset];
      if (!presetDevice) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown preset "${preset}". Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      finalViewport = { ...presetDevice.viewport };
      finalUserAgent = presetDevice.userAgent;
      deviceName = preset;
    } else if (width !== undefined && height !== undefined) {
      finalViewport = {
        width,
        height,
        deviceScaleFactor: deviceScaleFactor ?? 1,
        isMobile: isMobile ?? false,
        hasTouch: hasTouch ?? false,
      };
      deviceName = `Custom (${width}x${height})`;
    } else {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Either preset or both width and height are required',
          },
        ],
        isError: true,
      };
    }

    // Apply custom overrides
    if (width !== undefined) finalViewport.width = width;
    if (height !== undefined) finalViewport.height = height;
    if (deviceScaleFactor !== undefined) finalViewport.deviceScaleFactor = deviceScaleFactor;
    if (isMobile !== undefined) finalViewport.isMobile = isMobile;
    if (hasTouch !== undefined) finalViewport.hasTouch = hasTouch;
    if (userAgent !== undefined) finalUserAgent = userAgent;

    // Set viewport
    await page.setViewport(finalViewport);

    // Set user agent if specified
    if (finalUserAgent) {
      await page.setUserAgent(finalUserAgent);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'emulate_device',
            device: deviceName,
            viewport: finalViewport,
            userAgent: finalUserAgent ? `${finalUserAgent.slice(0, 60)}...` : null,
            message: `Device emulation set to ${deviceName}`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Emulate device error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerEmulateDeviceTool(server: MCPServer): void {
  server.registerTool('emulate_device', handler, definition);
}
