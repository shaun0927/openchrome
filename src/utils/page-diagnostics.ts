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

      // Count elements including those inside open shadow roots
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
    return {
      url: 'unknown',
      readyState: 'unknown',
      totalElements: 0,
      framework: null,
      title: 'unknown',
    };
  }
}

/**
 * Detect if the page is showing a blocking verification/captcha/access-denied page.
 * Returns null if page appears normal.
 */
export async function detectBlockingPage(page: Page): Promise<BlockingInfo | null> {
  try {
    return await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const bodyText = document.body?.innerText?.substring(0, 1000).toLowerCase() || '';

      // CAPTCHA detection (includes Cloudflare Turnstile)
      if (bodyText.includes('captcha') ||
          bodyText.includes('recaptcha') ||
          document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile')) {
        return { type: 'captcha' as const, detail: document.title };
      }

      // Bot verification
      if (bodyText.includes('verify you are human') ||
          bodyText.includes('are you a robot') ||
          bodyText.includes('bot protection') ||
          bodyText.includes('automated access') ||
          bodyText.includes('please verify') ||
          title.includes('robot check') ||
          title.includes('security check') ||
          title.includes('just a moment')) {  // Cloudflare
        return { type: 'bot-check' as const, detail: document.title };
      }

      // Access denied
      if (title.includes('access denied') ||
          title.includes('403 forbidden') ||
          title.includes('forbidden') ||
          (bodyText.includes('access denied') && bodyText.length < 500)) {
        return { type: 'access-denied' as const, detail: document.title };
      }

      // JS required
      if (bodyText.includes('please enable javascript') ||
          bodyText.includes('javascript is required') ||
          bodyText.includes('this site requires javascript')) {
        return { type: 'js-required' as const, detail: 'Page requires JavaScript' };
      }

      return null;
    });
  } catch {
    return null;
  }
}
