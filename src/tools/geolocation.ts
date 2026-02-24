/**
 * Geolocation Tool - Override browser geolocation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Predefined locations
const LOCATION_PRESETS: Record<
  string,
  { latitude: number; longitude: number; name: string }
> = {
  seoul: { latitude: 37.5665, longitude: 126.978, name: 'Seoul, South Korea' },
  tokyo: { latitude: 35.6762, longitude: 139.6503, name: 'Tokyo, Japan' },
  'new-york': { latitude: 40.7128, longitude: -74.006, name: 'New York, USA' },
  london: { latitude: 51.5074, longitude: -0.1278, name: 'London, UK' },
  'san-francisco': { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco, USA' },
  sydney: { latitude: -33.8688, longitude: 151.2093, name: 'Sydney, Australia' },
  paris: { latitude: 48.8566, longitude: 2.3522, name: 'Paris, France' },
  berlin: { latitude: 52.52, longitude: 13.405, name: 'Berlin, Germany' },
  singapore: { latitude: 1.3521, longitude: 103.8198, name: 'Singapore' },
  beijing: { latitude: 39.9042, longitude: 116.4074, name: 'Beijing, China' },
};

const definition: MCPToolDefinition = {
  name: 'geolocation',
  description: 'Set or clear geolocation coordinates. Use a preset city or provide custom latitude/longitude.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to set geolocation for',
      },
      preset: {
        type: 'string',
        description: `Preset location: ${Object.keys(LOCATION_PRESETS).join(', ')}`,
        enum: Object.keys(LOCATION_PRESETS),
      },
      latitude: {
        type: 'number',
        description: 'Custom latitude (-90 to 90)',
      },
      longitude: {
        type: 'number',
        description: 'Custom longitude (-180 to 180)',
      },
      accuracy: {
        type: 'number',
        description: 'Accuracy in meters (default: 100)',
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
  const latitude = args.latitude as number | undefined;
  const longitude = args.longitude as number | undefined;
  const accuracy = (args.accuracy as number | undefined) ?? 100;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!preset && (latitude === undefined || longitude === undefined)) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Either preset or both latitude and longitude are required',
        },
      ],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'geolocation');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    let finalLatitude: number;
    let finalLongitude: number;
    let locationName: string;

    if (latitude !== undefined && longitude !== undefined) {
      // Custom coordinates
      finalLatitude = latitude;
      finalLongitude = longitude;
      locationName = `Custom (${latitude}, ${longitude})`;
    } else if (preset) {
      const presetLocation = LOCATION_PRESETS[preset];
      if (!presetLocation) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown preset "${preset}". Available: ${Object.keys(LOCATION_PRESETS).join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      finalLatitude = presetLocation.latitude;
      finalLongitude = presetLocation.longitude;
      locationName = presetLocation.name;
    } else {
      return {
        content: [{ type: 'text', text: 'Error: No location specified' }],
        isError: true,
      };
    }

    // Validate coordinates
    if (finalLatitude < -90 || finalLatitude > 90) {
      return {
        content: [{ type: 'text', text: 'Error: Latitude must be between -90 and 90' }],
        isError: true,
      };
    }
    if (finalLongitude < -180 || finalLongitude > 180) {
      return {
        content: [{ type: 'text', text: 'Error: Longitude must be between -180 and 180' }],
        isError: true,
      };
    }

    // Grant geolocation permission
    const context = page.browserContext();
    await context.overridePermissions(page.url() || 'https://example.com', ['geolocation']);

    // Set geolocation
    await page.setGeolocation({
      latitude: finalLatitude,
      longitude: finalLongitude,
      accuracy,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'geolocation',
            preset: preset || null,
            latitude: finalLatitude,
            longitude: finalLongitude,
            accuracy,
            locationName,
            message: `Geolocation set to ${locationName}`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Geolocation error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerGeolocationTool(server: MCPServer): void {
  server.registerTool('geolocation', handler, definition);
}
