import type { Page } from 'puppeteer-core';

export interface PageDiagnostics {
  url: string;
  readyState: string;
  totalElements: number;
  framework: string | null;
  title: string;
}

export interface BlockingInfo {
  type: 'captcha' | 'bot-check' | 'access-denied' | 'js-required';
  detail: string;
  /** Classified CAPTCHA type when type === 'captcha' (#574) */
  captchaType?: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'aws_waf' | 'unknown';
  /** Extracted site key when type === 'captcha' (#574) */
  captchaSiteKey?: string;
}

/**
 * Get basic page diagnostics for failure reporting.
 * Lightweight - single evaluate call.
 */
export async function getPageDiagnostics(page: Page): Promise<PageDiagnostics> {
  try {
    return await page.evaluate(() => {
      let framework: string | null = null;
      if (document.querySelector('[data-reactroot], #__next, #root[data-reactroot]')) framework = 'react';
      else if (document.querySelector('[data-v-], #app[data-v-]')) framework = 'vue';
      else if (document.querySelector('[ng-version], [_nghost]')) framework = 'angular';

      function deepElementCount(root: Element | Document | ShadowRoot): number {
        let count = root.querySelectorAll('*').length;
        const allEls = root.querySelectorAll('*');
        for (let i = 0; i < allEls.length; i++) {
          if ((allEls[i] as any).shadowRoot) {
            count += deepElementCount((allEls[i] as any).shadowRoot);
          }
        }
        return count;
      }

      return {
        url: location.href,
        readyState: document.readyState,
        totalElements: deepElementCount(document),
        framework,
        title: document.title.substring(0, 100),
      };
    });
  } catch {
    return { url: 'unknown', readyState: 'unknown', totalElements: 0, framework: null, title: 'unknown' };
  }
}

/**
 * Detect if the page is showing a blocking verification/captcha/access-denied page.
 * Returns null if page appears normal.
 * When a CAPTCHA is detected, classifies the type and extracts the site key (#574).
 */
export async function detectBlockingPage(page: Page): Promise<BlockingInfo | null> {
  try {
    return await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const bodyText = document.body?.innerText?.substring(0, 1000).toLowerCase() || '';

      // reCAPTCHA v2
      const rv2 = document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha/api2"], iframe[src*="google.com/recaptcha/enterprise"]') as HTMLElement | null;
      if (rv2) {
        const isInvisible = rv2.getAttribute?.('data-size') === 'invisible';
        const sk = rv2.getAttribute?.('data-sitekey') || undefined;
        const captchaType = isInvisible ? 'recaptcha_v3' as const : 'recaptcha_v2' as const;
        return { type: 'captcha' as const, detail: document.title, captchaType, captchaSiteKey: sk };
      }
      // reCAPTCHA v3 (script-only, invisible)
      const rv3 = document.querySelector('script[src*="google.com/recaptcha/api.js?render="], script[src*="google.com/recaptcha/enterprise.js?render="]') as HTMLScriptElement | null;
      if (rv3) {
        const m = rv3.src.match(/render=([^&]+)/);
        const sk = m && m[1] !== 'explicit' ? m[1] : undefined;
        return { type: 'captcha' as const, detail: document.title, captchaType: 'recaptcha_v3' as const, captchaSiteKey: sk };
      }
      // hCaptcha
      const hc = document.querySelector('.h-captcha, iframe[src*="hcaptcha.com/captcha"]') as HTMLElement | null;
      if (hc) {
        const sk = hc.getAttribute?.('data-sitekey') || undefined;
        return { type: 'captcha' as const, detail: document.title, captchaType: 'hcaptcha' as const, captchaSiteKey: sk };
      }
      // Cloudflare Turnstile
      const ts = document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') as HTMLElement | null;
      if (ts) {
        const sk = ts.getAttribute?.('data-sitekey') || undefined;
        return { type: 'captcha' as const, detail: document.title, captchaType: 'turnstile' as const, captchaSiteKey: sk };
      }
      // AWS WAF CAPTCHA
      if (document.querySelector('iframe[src*="awswaf"], iframe[src*="aws-waf-captcha"], #awswaf-captcha')) {
        return { type: 'captcha' as const, detail: document.title, captchaType: 'aws_waf' as const, captchaSiteKey: undefined };
      }
      // Generic captcha fallback
      if (bodyText.includes('captcha') || bodyText.includes('recaptcha') || document.querySelector('iframe[src*="captcha"]')) {
        return { type: 'captcha' as const, detail: document.title, captchaType: 'unknown' as const, captchaSiteKey: undefined };
      }

      // Bot verification
      if (bodyText.includes('verify you are human') || bodyText.includes('are you a robot') ||
          bodyText.includes('bot protection') || bodyText.includes('automated access') ||
          bodyText.includes('please verify') || title.includes('robot check') ||
          title.includes('security check') || title.includes('just a moment')) {
        return { type: 'bot-check' as const, detail: document.title };
      }

      // Access denied
      if (title.includes('access denied') || title.includes('403 forbidden') ||
          title.includes('forbidden') || (bodyText.includes('access denied') && bodyText.length < 500)) {
        return { type: 'access-denied' as const, detail: document.title };
      }

      // JS required
      if (bodyText.includes('please enable javascript') || bodyText.includes('javascript is required') ||
          bodyText.includes('this site requires javascript')) {
        return { type: 'js-required' as const, detail: 'Page requires JavaScript' };
      }

      const elementCount = document.querySelectorAll('*').length;
      const isSparsePage = elementCount < 100 && bodyText.length < 800;
      if (isSparsePage) {
        const BLOCK_SIGNALS = ['blocked by','been blocked','request blocked','ip blocked','ip has been blocked',
          'network security','security policy','permission denied','not permitted','rate limit',
          'too many requests','temporarily banned','your ip','suspicious activity','unusual traffic'];
        if (BLOCK_SIGNALS.some(signal => bodyText.includes(signal))) {
          return { type: 'access-denied' as const, detail: document.title || bodyText.substring(0, 100) };
        }
      }

      return null;
    });
  } catch {
    return null;
  }
}
