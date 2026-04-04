/**
 * TOTP Generate Tool - Generate current TOTP 2FA codes for configured domains
 */

import * as crypto from 'crypto';
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
 * Generate a TOTP code from a base32-encoded secret.
 * Implements RFC 6238 (TOTP) using HMAC-SHA1 per RFC 4226 (HOTP).
 * Returns the 6-digit code and seconds remaining in the current 30s period.
 */
function generateTOTPCode(secret: string): { code: string; secondsRemaining: number } {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanSecret = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');

  // Decode base32 to bytes
  let bits = '';
  for (const char of cleanSecret) {
    const val = base32Chars.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }

  const keyBytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  // Current time step (30-second intervals)
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(nowSeconds / 30);
  const secondsRemaining = 30 - (nowSeconds % 30);

  // Pack time step as 8-byte big-endian buffer
  const timeBuffer = Buffer.alloc(8);
  let t = timeStep;
  for (let i = 7; i >= 0; i--) {
    timeBuffer[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', keyBytes);
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    1_000_000;

  return {
    code: code.toString().padStart(6, '0'),
    secondsRemaining,
  };
}

/**
 * Look up TOTP secret for a domain.
 * Stub implementation — integrates with credential store when PR 1 lands.
 * Falls back to environment variable OPENCHROME_TOTP_<DOMAIN> for testing.
 */
async function getTOTPSecret(domain: string): Promise<string | undefined> {
  // Try to load the credential store dynamically (available when PR 1 is merged).
  // Using require() at runtime so TypeScript does not resolve the module at compile time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const credModule = require('../security/credential-store') as { getTOTPSecret?: (d: string) => Promise<string | undefined> };
    if (typeof credModule.getTOTPSecret === 'function') {
      return credModule.getTOTPSecret(domain);
    }
  } catch {
    // Credential store not available yet — fall through to env var fallback
  }

  // Environment variable fallback for testing:
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

    const { code, secondsRemaining } = generateTOTPCode(secret);

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
