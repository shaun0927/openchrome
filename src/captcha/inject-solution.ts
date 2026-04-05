/**
 * CAPTCHA Solution Injector (#574)
 *
 * Injects solver tokens into pages to dismiss CAPTCHAs.
 * Each CAPTCHA type has a different injection strategy.
 */

import type { Page } from 'puppeteer-core';
import type { CaptchaType } from '../types/captcha';

/**
 * Inject a CAPTCHA solution token into the page.
 * Returns true if the injection appeared successful.
 */
export async function injectSolution(
  page: Page,
  captchaType: CaptchaType,
  token: string,
): Promise<boolean> {
  try {
    return await page.evaluate((type: string, tok: string) => {
      switch (type) {
        case 'recaptcha_v2':
        case 'recaptcha_v3': {
          // Set the response textarea
          const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]') as HTMLTextAreaElement | null;
          if (textarea) {
            textarea.value = tok;
            textarea.style.display = 'block';
          }
          // Try to call the callback
          try {
            const widgetId = Object.keys((window as any).___grecaptcha_cfg?.clients || {})[0];
            if (widgetId !== undefined) {
              const client = (window as any).___grecaptcha_cfg.clients[widgetId];
              // Walk the client to find the callback
              for (const key of Object.keys(client)) {
                const val = client[key];
                if (val && typeof val === 'object') {
                  for (const k2 of Object.keys(val)) {
                    if (typeof val[k2]?.callback === 'function') {
                      val[k2].callback(tok);
                      return true;
                    }
                  }
                }
              }
            }
          } catch { /* fallback: just set textarea */ }
          return !!textarea;
        }

        case 'hcaptcha': {
          const textarea = document.querySelector('[name="h-captcha-response"], textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null;
          if (textarea) textarea.value = tok;
          // Call hcaptcha.setResponse if available to register the token,
          // NOT hcaptcha.execute() which starts a new challenge
          try {
            const w = (window as any).hcaptcha;
            if (w && typeof w.setResponse === 'function') w.setResponse(tok);
          } catch { /* ignore */ }
          return !!textarea;
        }

        case 'turnstile': {
          // Turnstile uses a hidden input or callback
          const input = document.querySelector('[name="cf-turnstile-response"], input[name="cf-turnstile-response"]') as HTMLInputElement | null;
          if (input) input.value = tok;
          try {
            const cb = (window as any).turnstile?.getResponse ? true : false;
            if (!cb) {
              // Try triggering the widget callback
              const widget = document.querySelector('.cf-turnstile') as HTMLElement | null;
              if (widget) {
                const event = new CustomEvent('cf-turnstile-callback', { detail: tok });
                widget.dispatchEvent(event);
              }
            }
          } catch { /* ignore */ }
          return !!input;
        }

        case 'aws_waf': {
          // AWS WAF uses ChallengeScript callback
          try {
            const awsWaf = (window as any).AwsWafIntegration || (window as any).AwsWafCaptcha;
            if (awsWaf?.submitCaptcha) {
              awsWaf.submitCaptcha(tok);
              return true;
            }
          } catch { /* ignore */ }
          return false;
        }

        default:
          return false;
      }
    }, captchaType, token);
  } catch (err) {
    console.error('[CaptchaSolver] Solution injection failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
