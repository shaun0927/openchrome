/**
 * 2FA Auto-Handling Logic - Handles 2FA challenges detected on pages
 */

import { TwoFAType, TwoFADetectionResult } from './twofa-detector';

/** Minimal interface for a credential provider (stub for standalone compilation) */
interface CredentialProvider {
  getTOTPSecret(domain: string): Promise<string | undefined>;
}

export interface TwoFAHandlerOptions {
  credentialProvider?: CredentialProvider;
  domain: string;
  maxRetries?: number;  // Default: 3
  timeoutMs?: number;   // Default: 30000
}

export interface TwoFAHandlerResult {
  handled: boolean;
  type: TwoFAType;
  method: 'auto-fill' | 'manual-hint' | 'timeout' | 'not-detected';
  message: string;
}

/**
 * Generate a TOTP code from a base32 secret.
 * Implements RFC 6238 (TOTP) over RFC 4226 (HOTP).
 */
function generateTOTPCode(secret: string, offsetSeconds = 0): string {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanSecret = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');

  // Decode base32
  let bits = '';
  for (const char of cleanSecret) {
    const val = base32Chars.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  // Time step (30s intervals)
  const timeStep = Math.floor((Date.now() / 1000 + offsetSeconds) / 30);

  // Pack time step as 8-byte big-endian
  const timeBytes = new Uint8Array(8);
  let t = timeStep;
  for (let i = 7; i >= 0; i--) {
    timeBytes[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  // HMAC-SHA1 using Node.js crypto
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes));
  hmac.update(Buffer.from(timeBytes));
  const digest = hmac.digest();

  // Dynamic truncation
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    1000000;

  return code.toString().padStart(6, '0');
}

/**
 * Wait for page URL or content to change (indicates 2FA success).
 */
async function waitForPageChange(
  page: any,
  originalUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 500;

  while (Date.now() < deadline) {
    try {
      const currentUrl = page.url();
      if (currentUrl !== originalUrl) {
        return true;
      }
    } catch {
      // Page may have navigated away (frame detached)
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}

/**
 * Fill and submit a 2FA input field on the page.
 */
async function fillAndSubmit(
  page: any,
  inputSelector: string,
  submitSelector: string | undefined,
  code: string,
): Promise<void> {
  await page.click(inputSelector);
  await page.evaluate(
    (selector: string) => {
      const el = document.querySelector<HTMLInputElement>(selector);
      if (el) el.value = '';
    },
    inputSelector,
  );
  await page.type(inputSelector, code);

  if (submitSelector) {
    try {
      await page.click(submitSelector);
    } catch {
      // Fall back to pressing Enter on the input
      await page.keyboard.press('Enter');
    }
  } else {
    await page.keyboard.press('Enter');
  }
}

/**
 * Handle a detected 2FA challenge.
 * Returns a result indicating how the 2FA was handled.
 */
export async function handleTwoFA(
  page: any,
  detection: TwoFADetectionResult,
  options: TwoFAHandlerOptions,
): Promise<TwoFAHandlerResult> {
  const { domain, credentialProvider, maxRetries = 3, timeoutMs = 30000 } = options;

  if (!detection.detected) {
    return {
      handled: false,
      type: TwoFAType.UNKNOWN,
      method: 'not-detected',
      message: 'No 2FA challenge detected',
    };
  }

  switch (detection.type) {
    case TwoFAType.TOTP: {
      // Try to auto-fill if a credential provider is available
      if (credentialProvider && detection.inputSelector) {
        const secret = await credentialProvider.getTOTPSecret(domain);
        if (secret) {
          const originalUrl = page.url();
          let filled = false;

          for (let attempt = 0; attempt < maxRetries; attempt++) {
            // On retries, apply ±30s offset for clock drift
            const offsets = [0, 30, -30];
            const offsetSeconds = offsets[attempt] || 0;

            try {
              const code = generateTOTPCode(secret, offsetSeconds);
              await fillAndSubmit(
                page,
                detection.inputSelector,
                detection.submitSelector,
                code,
              );

              // Wait briefly and check if page changed
              const changed = await waitForPageChange(page, originalUrl, 3000);
              if (changed) {
                filled = true;
                break;
              }
            } catch (err) {
              console.error(
                `[twofa-handler] TOTP fill attempt ${attempt + 1} failed:`,
                err instanceof Error ? err.message : err,
              );
            }
          }

          if (filled) {
            return {
              handled: true,
              type: TwoFAType.TOTP,
              method: 'auto-fill',
              message: `TOTP code automatically filled for ${domain}`,
            };
          }

          return {
            handled: false,
            type: TwoFAType.TOTP,
            method: 'manual-hint',
            message: `TOTP fill failed after ${maxRetries} attempts for ${domain}. Please verify the TOTP secret is correct.`,
          };
        }
      }

      // No secret available — provide setup instructions
      return {
        handled: false,
        type: TwoFAType.TOTP,
        method: 'manual-hint',
        message: `TOTP code required for ${domain}. Configure via: npx openchrome totp add --domain ${domain} --secret <base32>`,
      };
    }

    case TwoFAType.SMS: {
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const phoneMatch = pageText.match(/\*+[-.\s]?\*+[-.\s]?\d{4}/);
      const phoneHint = phoneMatch ? ` Code sent to ${phoneMatch[0]}.` : '';
      return {
        handled: false,
        type: TwoFAType.SMS,
        method: 'manual-hint',
        message: `SMS 2FA detected.${phoneHint} Manual input required.`,
      };
    }

    case TwoFAType.EMAIL: {
      return {
        handled: false,
        type: TwoFAType.EMAIL,
        method: 'manual-hint',
        message: 'Email 2FA detected. Check your email for verification code.',
      };
    }

    case TwoFAType.PUSH: {
      // Wait for page change (user approves on device)
      const originalUrl = page.url();
      const changed = await waitForPageChange(page, originalUrl, timeoutMs);

      if (changed) {
        return {
          handled: true,
          type: TwoFAType.PUSH,
          method: 'auto-fill',
          message: `Push notification approved — page changed for ${domain}`,
        };
      }

      return {
        handled: false,
        type: TwoFAType.PUSH,
        method: 'timeout',
        message: `Push 2FA timed out after ${timeoutMs}ms. Open your authentication app and approve the request.`,
      };
    }

    case TwoFAType.RECOVERY: {
      return {
        handled: false,
        type: TwoFAType.RECOVERY,
        method: 'manual-hint',
        message: 'Recovery code required. Use stored recovery codes.',
      };
    }

    default: {
      return {
        handled: false,
        type: TwoFAType.UNKNOWN,
        method: 'manual-hint',
        message: `Unknown 2FA type detected on ${domain}. Manual intervention required.`,
      };
    }
  }
}
