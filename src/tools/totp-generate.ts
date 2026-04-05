/**
 * TOTP Generate Tool - Generate current TOTP 2FA codes for configured domains
 */

import { generateTOTP } from '../auth/totp-manager';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';

const definition: MCPToolDefinition = {
  name: 'oc_totp_generate',
  description:
    'Generate a current TOTP 2FA code for a domain. Requires TOTP secret to be configured.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Domain to generate TOTP code for (e.g., "github.com")',
      },
    },
    required: ['domain'],
  },
};

/**
 * Look up TOTP secret for a domain.
 * Falls back to environment variable OPENCHROME_TOTP_<DOMAIN> for testing.
 */
async function getTOTPSecret(domain: string): Promise<string | undefined> {
  // Try to load the credential store dynamically (available when PR lands).
  // Using require() at runtime so TypeScript does not resolve the module at compile time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const credModule = require('../auth/credential-store') as { getTotpSecret?: (d: string) => Promise<string | null> };
    if (typeof credModule.getTotpSecret === 'function') {
      const result = await credModule.getTotpSecret(domain);
      if (result) return result;
      // Not in store — fall through to env var fallback
    }
  } catch {
    // Credential store not available yet — fall through to env var fallback
  }

  // Environment variable fallback for testing and quick setup:
  // OPENCHROME_TOTP_GITHUB_COM=JBSWY3DPEHPK3PXP
  const envKey = `OPENCHROME_TOTP_${domain.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envKey];
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domain = args.domain as string | undefined;

  if (!domain) {
    return {
      content: [{ type: 'text', text: 'Error: domain is required' }],
      isError: true,
    };
  }

  try {
    const secret = await getTOTPSecret(domain);

    if (!secret) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'TOTP secret not configured',
              domain,
              setup: `Configure TOTP for this domain with: npx openchrome totp add --domain ${domain} --secret <base32>`,
            }),
          },
        ],
        isError: true,
      };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsRemaining = 30 - (nowSeconds % 30);
    const code = generateTOTP(secret);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            domain,
            code,
            secondsRemaining,
            expiresAt: new Date(Date.now() + secondsRemaining * 1000).toISOString(),
            note: 'Code expires at the indicated time. Request a new code if needed.',
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `TOTP generation error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTotpGenerateTool(server: MCPServer): void {
  server.registerTool('oc_totp_generate', handler, definition);
}
