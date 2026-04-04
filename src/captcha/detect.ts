/**
 * CAPTCHA Detection - Classifies CAPTCHA types and extracts site keys (#574)
 */
import type { Page } from 'puppeteer-core';
import type { CaptchaType, CaptchaDetectionResult, CaptchaSiteKey } from '../types/captcha';

function detectCaptchaInPage(): { captchaType: CaptchaType; siteKey: CaptchaSiteKey | null; invisible: boolean } | null {
  const rv2 = document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha/api2"], iframe[src*="google.com/recaptcha/enterprise"]') as HTMLElement | null;
  if (rv2) {
    const isInvisible = rv2.getAttribute?.('data-size') === 'invisible';
    const sk = rv2.getAttribute?.('data-sitekey');
    return { captchaType: 'recaptcha_v2', siteKey: sk ? { key: sk, source: 'attribute' } : null, invisible: isInvisible };
  }
  const rv3 = document.querySelector('script[src*="google.com/recaptcha/api.js?render="], script[src*="google.com/recaptcha/enterprise.js?render="]') as HTMLScriptElement | null;
  if (rv3) {
    const m = rv3.src.match(/render=([^&]+)/);
    const sk = m && m[1] !== 'explicit' ? m[1] : null;
    return { captchaType: 'recaptcha_v3', siteKey: sk ? { key: sk, source: 'script' } : null, invisible: true };
  }
  const hc = document.querySelector('.h-captcha, iframe[src*="hcaptcha.com/captcha"]') as HTMLElement | null;
  if (hc) {
    const sk = hc.getAttribute?.('data-sitekey');
    return { captchaType: 'hcaptcha', siteKey: sk ? { key: sk, source: 'attribute' } : null, invisible: false };
  }
  const ts = document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') as HTMLElement | null;
  if (ts) {
    const sk = ts.getAttribute?.('data-sitekey');
    return { captchaType: 'turnstile', siteKey: sk ? { key: sk, source: 'attribute' } : null, invisible: false };
  }
  if (document.querySelector('iframe[src*="awswaf"], iframe[src*="aws-waf-captcha"], #awswaf-captcha')) {
    return { captchaType: 'aws_waf', siteKey: null, invisible: false };
  }
  const bodyText = document.body?.innerText?.substring(0, 2000).toLowerCase() || '';
  if (bodyText.includes('captcha') || bodyText.includes('recaptcha') || document.querySelector('iframe[src*="captcha"]')) {
    return { captchaType: 'unknown', siteKey: null, invisible: false };
  }
  return null;
}

export async function detectCaptcha(page: Page): Promise<CaptchaDetectionResult | null> {
  try {
    const result = await page.evaluate(detectCaptchaInPage);
    if (!result) return null;
    let pageUrl: string;
    try { pageUrl = page.url(); } catch { pageUrl = 'unknown'; }
    return { detected: true, captchaType: result.captchaType, siteKey: result.siteKey ?? undefined, pageUrl, invisible: result.invisible };
  } catch {
    return null;
  }
}
