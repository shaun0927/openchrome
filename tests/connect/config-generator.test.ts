import { generateConnectionInfo, generateAllConnectionInfo } from '../../src/connect/config-generator';
import type { ServerConnectionState, WebAIHostId } from '../../src/connect/types';

describe('config-generator', () => {
  const tunnelState: ServerConnectionState = {
    tunnelUrl: 'https://abc123.trycloudflare.com',
    localUrl: 'http://localhost:3100',
    authToken: 'test-token-xyz',
  };

  const localOnlyState: ServerConnectionState = {
    tunnelUrl: null,
    localUrl: 'http://localhost:3100',
    authToken: null,
  };

  describe('generateConnectionInfo', () => {
    it('generates Claude Web config with tunnel URL', () => {
      const info = generateConnectionInfo('claude', tunnelState);

      expect(info.host).toBe('claude');
      expect(info.hostName).toBe('Claude Web');
      expect(info.serverUrl).toBe('https://abc123.trycloudflare.com/mcp');
      expect(info.bearerToken).toBe('test-token-xyz');
      expect(info.settingsUrl).toBe('https://claude.ai/customize/connectors?modal=add-custom-connector');
      expect(info.tunnelActive).toBe(true);
      expect(info.steps).toHaveLength(3);
    });

    it('generates ChatGPT config with tunnel URL', () => {
      const info = generateConnectionInfo('chatgpt', tunnelState);

      expect(info.host).toBe('chatgpt');
      expect(info.serverUrl).toBe('https://abc123.trycloudflare.com/mcp');
      expect(info.settingsUrl).toBe('https://chatgpt.com/gpts/mine');
    });

    it('generates Gemini config', () => {
      const info = generateConnectionInfo('gemini', tunnelState);

      expect(info.host).toBe('gemini');
      expect(info.serverUrl).toBe('https://abc123.trycloudflare.com/mcp');
      expect(info.settingsUrl).toBe('https://aistudio.google.com/app/mcpserver');
    });

    it('generates custom config with raw URL and token', () => {
      const info = generateConnectionInfo('custom', tunnelState);

      expect(info.host).toBe('custom');
      expect(info.settingsUrl).toBeNull();
      expect(info.configSnippet).toContain('"url"');
      expect(info.configSnippet).toContain('"Bearer test-token-xyz"');
    });

    it('falls back to local URL when tunnel is not active', () => {
      const info = generateConnectionInfo('claude', localOnlyState);

      expect(info.serverUrl).toBe('http://localhost:3100/mcp');
      expect(info.bearerToken).toBeNull();
      expect(info.tunnelActive).toBe(false);
    });

    it('config snippet omits headers when no auth token', () => {
      const info = generateConnectionInfo('custom', localOnlyState);
      const snippet = JSON.parse(info.configSnippet);

      expect(snippet.url).toBe('http://localhost:3100/mcp');
      expect(snippet.headers).toBeUndefined();
    });

    it('config snippet includes Authorization header when token set', () => {
      const info = generateConnectionInfo('custom', tunnelState);
      const snippet = JSON.parse(info.configSnippet);

      expect(snippet.headers.Authorization).toBe('Bearer test-token-xyz');
    });

    it('strips trailing slash from tunnel URL', () => {
      const state: ServerConnectionState = {
        tunnelUrl: 'https://abc123.trycloudflare.com/',
        localUrl: 'http://localhost:3100',
        authToken: null,
      };
      const info = generateConnectionInfo('claude', state);

      expect(info.serverUrl).toBe('https://abc123.trycloudflare.com/mcp');
    });
  });

  describe('generateAllConnectionInfo', () => {
    it('generates configs for all four hosts', () => {
      const all = generateAllConnectionInfo(tunnelState);

      expect(Object.keys(all)).toEqual(['claude', 'chatgpt', 'gemini', 'custom']);
      expect(all.claude.serverUrl).toContain('/mcp');
      expect(all.chatgpt.serverUrl).toContain('/mcp');
      expect(all.gemini.serverUrl).toContain('/mcp');
      expect(all.custom.serverUrl).toContain('/mcp');
    });

    it('all hosts share the same base URL', () => {
      const all = generateAllConnectionInfo(tunnelState);
      const hosts: WebAIHostId[] = ['claude', 'chatgpt', 'gemini', 'custom'];

      for (const id of hosts) {
        expect(all[id].serverUrl).toBe('https://abc123.trycloudflare.com/mcp');
      }
    });
  });
});
