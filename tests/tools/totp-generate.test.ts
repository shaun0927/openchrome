/// <reference types="jest" />
/**
 * Unit tests for oc_totp_generate MCP tool
 */

import { MCPServer } from '../../src/mcp-server';

// We'll capture the registered handler by intercepting registerTool
let capturedHandler: ((sessionId: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

function getHandler() {
  if (!capturedHandler) throw new Error('Handler not registered');
  return capturedHandler;
}

// Known TOTP secret for deterministic testing (RFC 4226 test vector)
const TEST_SECRET = 'JBSWY3DPEHPK3PXP'; // base32 of "Hello!\xDE\xAD\xBE\xEF"
const TEST_DOMAIN = 'github.com';

describe('oc_totp_generate tool', () => {
  beforeEach(() => {
    capturedHandler = null;
    jest.resetModules();
    // Clear env vars between tests
    delete process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  });

  async function loadTool() {
    const { registerTotpGenerateTool } = await import('../../src/tools/totp-generate');
    const mockServer = {
      registerTool: jest.fn().mockImplementation((_name: string, handler: Function) => {
        capturedHandler = handler as typeof capturedHandler;
      }),
    } as unknown as MCPServer;
    registerTotpGenerateTool(mockServer);
    return getHandler();
  }

  describe('error handling', () => {
    test('returns error when domain is missing', async () => {
      const handler = await loadTool();
      const result = await handler('session-1', {}) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('domain is required');
    });

    test('returns error with setup instructions when domain not configured', async () => {
      const handler = await loadTool();
      const result = await handler('session-1', { domain: 'unconfigured.com' }) as any;

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not configured');
      expect(parsed.domain).toBe('unconfigured.com');
      expect(parsed.setup).toContain('npx openchrome totp add');
      expect(parsed.setup).toContain('unconfigured.com');
    });
  });

  describe('code generation', () => {
    test('generates a 6-digit code for configured domain', async () => {
      process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = TEST_SECRET;

      const handler = await loadTool();
      const result = await handler('session-1', { domain: TEST_DOMAIN }) as any;

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toMatch(/^\d{6}$/);
      expect(parsed.domain).toBe(TEST_DOMAIN);
    });

    test('response includes secondsRemaining in range 1-30', async () => {
      process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = TEST_SECRET;

      const handler = await loadTool();
      const result = await handler('session-1', { domain: TEST_DOMAIN }) as any;

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.secondsRemaining).toBeGreaterThanOrEqual(1);
      expect(parsed.secondsRemaining).toBeLessThanOrEqual(30);
    });

    test('response includes expiresAt timestamp', async () => {
      process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = TEST_SECRET;

      const handler = await loadTool();
      const result = await handler('session-1', { domain: TEST_DOMAIN }) as any;

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.expiresAt).toBeTruthy();
      // Should be a valid ISO date string
      expect(() => new Date(parsed.expiresAt)).not.toThrow();
      const expiryDate = new Date(parsed.expiresAt);
      expect(expiryDate.getTime()).toBeGreaterThan(Date.now());
    });

    test('response does NOT include the secret', async () => {
      process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = TEST_SECRET;

      const handler = await loadTool();
      const result = await handler('session-1', { domain: TEST_DOMAIN }) as any;

      const responseText = result.content[0].text;
      // Secret must not appear in the response
      expect(responseText).not.toContain(TEST_SECRET);
      expect(responseText).not.toContain(TEST_SECRET.toLowerCase());
    });

    test('generates same code within same 30s window', async () => {
      process.env[`OPENCHROME_TOTP_${TEST_DOMAIN.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = TEST_SECRET;

      const handler = await loadTool();

      const result1 = await handler('session-1', { domain: TEST_DOMAIN }) as any;
      const result2 = await handler('session-1', { domain: TEST_DOMAIN }) as any;

      const parsed1 = JSON.parse(result1.content[0].text);
      const parsed2 = JSON.parse(result2.content[0].text);

      // Both generated within same test run — should be same time step
      expect(parsed1.code).toBe(parsed2.code);
    });

    test('registers with correct tool name', async () => {
      const { registerTotpGenerateTool } = await import('../../src/tools/totp-generate');
      const registeredNames: string[] = [];
      const mockServer = {
        registerTool: jest.fn().mockImplementation((name: string) => {
          registeredNames.push(name);
        }),
      } as unknown as MCPServer;

      registerTotpGenerateTool(mockServer);

      expect(registeredNames).toContain('oc_totp_generate');
    });
  });
});
