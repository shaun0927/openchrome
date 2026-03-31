/**
 * Types for web AI host connection configuration.
 * Part of #523: Desktop App Web host connection guide.
 */

/** Supported web AI host platforms */
export type WebAIHostId = 'claude' | 'chatgpt' | 'gemini' | 'custom';

/** Per-host connection configuration */
export interface HostDefinition {
  id: WebAIHostId;
  name: string;
  /** URL path suffix appended to the tunnel URL (e.g. '/mcp') */
  mcpPathSuffix: string;
  /** URL to open the host's MCP connector settings page */
  settingsUrl: string | null;
  /** Protocol the host expects */
  protocol: 'streamable-http' | 'sse';
  /** Step-by-step connection instructions (plain language, no jargon) */
  steps: string[];
  /** Extra notes for this host */
  notes: string[];
}

/** Generated connection info for a specific host */
export interface ConnectionInfo {
  host: WebAIHostId;
  hostName: string;
  /** Full MCP server URL (tunnel URL + path suffix) */
  serverUrl: string;
  /** Bearer token for Authorization header (null if not configured) */
  bearerToken: string | null;
  /** URL to open the host's connector settings page */
  settingsUrl: string | null;
  /** Step-by-step instructions */
  steps: string[];
  /** JSON config snippet for manual configuration */
  configSnippet: string;
  /** Whether a tunnel is active */
  tunnelActive: boolean;
}

/** State passed to the config generator */
export interface ServerConnectionState {
  /** Tunnel URL (e.g. 'https://abc123.trycloudflare.com') or null if not active */
  tunnelUrl: string | null;
  /** Local HTTP server URL (e.g. 'http://localhost:3100') */
  localUrl: string;
  /** Bearer token configured for HTTP transport */
  authToken: string | null;
}
