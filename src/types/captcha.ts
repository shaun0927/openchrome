/**
 * CAPTCHA Detection Types (#574)
 */

export type CaptchaType =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'aws_waf'
  | 'unknown';

export interface CaptchaSiteKey {
  key: string;
  source: 'attribute' | 'script' | 'iframe';
}

export interface CaptchaDetectionResult {
  detected: boolean;
  captchaType: CaptchaType;
  siteKey?: CaptchaSiteKey;
  pageUrl: string;
  invisible: boolean;
}
