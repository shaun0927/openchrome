/**
 * 2Captcha Solver Adapter (#574)
 *
 * Integrates with the 2captcha.com API for solving CAPTCHAs.
 * Supports: reCAPTCHA v2/v3, hCaptcha, Turnstile.
 */

import type { CaptchaType } from '../../types/captcha';
import { CaptchaSolver, SolveRequest, SolveResult, SolverConfig } from '../solver-interface';

const API_BASE = 'https://2captcha.com';

const SUPPORTED_TYPES: ReadonlySet<CaptchaType> = new Set([
  'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile',
]);

export class TwoCaptchaSolver extends CaptchaSolver {
  constructor(config: SolverConfig) {
    super('2captcha', config);
  }

  supportsType(captchaType: CaptchaType): boolean {
    return SUPPORTED_TYPES.has(captchaType);
  }

  async solve(request: SolveRequest): Promise<SolveResult> {
    const startTime = Date.now();

    // Submit task via POST to avoid leaking API key in access logs
    const submitParams = this.buildSubmitParams(request);
    const submitResponse = await fetch(`${API_BASE}/in.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: submitParams,
      signal: AbortSignal.timeout(15000),
    });
    const submitText = await submitResponse.text();

    if (!submitText.startsWith('OK|')) {
      throw new Error(`2Captcha submit failed: ${submitText}`);
    }

    const taskId = submitText.split('|')[1];

    // Poll for result
    const token = await this.pollResult(taskId);
    const solveTimeMs = Date.now() - startTime;

    return {
      token,
      taskId,
      solveTimeMs,
      costUsd: this.estimateCost(request.captchaType),
    };
  }

  async getBalance(): Promise<number> {
    // Use POST to avoid leaking API key in server access logs
    const response = await fetch(`${API_BASE}/res.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: this.config.apiKey, action: 'getbalance', json: '1' }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json() as { status: number; request: string };
    return parseFloat(data.request);
  }

  private buildSubmitParams(request: SolveRequest): string {
    const params = new URLSearchParams({
      key: this.config.apiKey,
      json: '0',
      pageurl: request.pageUrl,
    });

    switch (request.captchaType) {
      case 'recaptcha_v2':
        params.set('method', 'userrecaptcha');
        params.set('googlekey', request.siteKey);
        if (request.invisible) params.set('invisible', '1');
        break;
      case 'recaptcha_v3':
        params.set('method', 'userrecaptcha');
        params.set('version', 'v3');
        params.set('googlekey', request.siteKey);
        if (request.action) params.set('action', request.action);
        if (request.minScore) params.set('min_score', request.minScore.toString());
        break;
      case 'hcaptcha':
        params.set('method', 'hcaptcha');
        params.set('sitekey', request.siteKey);
        break;
      case 'turnstile':
        params.set('method', 'turnstile');
        params.set('sitekey', request.siteKey);
        break;
    }

    return params.toString();
  }

  private async pollResult(taskId: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    const params = new URLSearchParams({ key: this.config.apiKey, action: 'get', id: taskId, json: '0' }).toString();
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
      try {
        const response = await fetch(`${API_BASE}/res.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
          signal: AbortSignal.timeout(15000),
        });
        const text = await response.text();
        consecutiveErrors = 0;

        if (text === 'CAPCHA_NOT_READY') continue;
        if (text.startsWith('OK|')) return text.split('|')[1];
        throw new Error(`2Captcha solve failed: ${text}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('2Captcha solve failed')) throw err;
        if (++consecutiveErrors >= 3) throw new Error(`2Captcha poll failed after 3 consecutive network errors: ${err}`);
      }
    }

    throw new Error(`2Captcha solve timed out after ${this.timeoutMs}ms`);
  }

  private estimateCost(captchaType: CaptchaType): number {
    switch (captchaType) {
      case 'recaptcha_v2': return 0.003;
      case 'recaptcha_v3': return 0.004;
      case 'hcaptcha': return 0.003;
      case 'turnstile': return 0.003;
      default: return 0.003;
    }
  }
}
