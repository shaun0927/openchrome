/**
 * 2FA Auto-Handling Logic - Handles 2FA challenges detected on pages
 */

import { TwoFAType, TwoFADetectionResult } from './twofa-detector';
import { generateTOTP } from './totp-manager';

/**
 * Minimal credential provider interface compatible with PR #582's shape.
 * When credential-provider.ts lands, this can be replaced with an import.
 */
interface CredentialProvider {
  getCredentials(domain: string): Promise<{ totpSecret?: string } | null>;
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
        const credentials = await credentialProvider.getCredentials(domain);
        const secret = credentials?.totpSecret;
        if (secret) {
          const originalUrl = page.url();
          let filled = false;

          for (let attempt = 0; attempt < maxRetries; attempt++) {
            // On retries, apply ±1 step offset for clock drift
            const stepOffsets = [0, 1, -1];
            const timeOffset = stepOffsets[attempt] || 0;

            try {
              const code = generateTOTP(secret, { timeOffset });
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
