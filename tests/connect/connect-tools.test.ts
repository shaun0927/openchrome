/**
 * Tests for MCP connect tools (#523).
 */

import { generateConnectionInfo } from '../../src/connect/config-generator';
import type { ServerConnectionState } from '../../src/connect/types';

describe('connect tools logic', () => {
  const tunnelState: ServerConnectionState = {
    tunnelUrl: 'https://test-tunnel.trycloudflare.com',
    localUrl: 'http://localhost:3100',
    authToken: 'secret-token',
  };

  describe('get_connection_info', () => {
    it('returns Claude Web settings URL', () => {
      const info = generateConnectionInfo('claude', tunnelState);
      expect(info.settingsUrl).toBe('https://claude.ai/customize/connectors?modal=add-custom-connector');
    });

    it('returns ChatGPT settings URL', () => {
      const info = generateConnectionInfo('chatgpt', tunnelState);
      expect(info.settingsUrl).toBe('https://chatgpt.com/gpts/mine');
    });

    it('returns Gemini settings URL', () => {
      const info = generateConnectionInfo('gemini', tunnelState);
      expect(info.settingsUrl).toBe('https://aistudio.google.com/app/mcpserver');
    });

    it('custom host has no settings URL', () => {
      const info = generateConnectionInfo('custom', tunnelState);
      expect(info.settingsUrl).toBeNull();
    });

    it('config snippet is valid JSON with auth header', () => {
      const info = generateConnectionInfo('custom', tunnelState);
      const parsed = JSON.parse(info.configSnippet);
      expect(parsed.url).toBe('https://test-tunnel.trycloudflare.com/mcp');
      expect(parsed.headers.Authorization).toBe('Bearer secret-token');
    });

    it('uses local URL when tunnel is inactive', () => {
      const localState: ServerConnectionState = {
        tunnelUrl: null,
        localUrl: 'http://localhost:3100',
        authToken: null,
      };
      const info = generateConnectionInfo('claude', localState);
      expect(info.serverUrl).toBe('http://localhost:3100/mcp');
      expect(info.tunnelActive).toBe(false);
    });
  });
});
