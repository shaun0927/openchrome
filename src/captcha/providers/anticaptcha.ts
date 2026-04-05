/**
 * Anti-Captcha Solver Adapter (#574)
 *
 * Integrates with the anti-captcha.com API.
 * Supports: reCAPTCHA v2/v3, hCaptcha, Turnstile.
 */

import type { CaptchaType } from '../../types/captcha';
import { CaptchaSolver, SolveRequest, SolveResult, SolverConfig } from '../solver-interface';

const API_BASE = 'https://api.anti-captcha.com';

const SUPPORTED_TYPES: ReadonlySet<CaptchaType> = new Set([
  'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile',
]);

export class AntiCaptchaSolver extends CaptchaSolver {
  constructor(config: SolverConfig) {
    super('anticaptcha', config);
  }

  supportsType(captchaType: CaptchaType): boolean {
    return SUPPORTED_TYPES.has(captchaType);
  }

  async solve(request: SolveRequest): Promise<SolveResult> {
    const startTime = Date.now();
    const task = this.buildTask(request);

    // Create task
    const createResponse = await fetch(`${API_BASE}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.config.apiKey, task }),
      signal: AbortSignal.timeout(15000),
    });
    const createData = await createResponse.json() as { errorId: number; errorDescription?: string; taskId?: number };

    if (createData.errorId !== 0) {
      throw new Error(`Anti-Captcha create failed: ${createData.errorDescription}`);
    }

    const taskId = String(createData.taskId);

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
    const response = await fetch(`${API_BASE}/getBalance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.config.apiKey }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json() as { balance: number };
    return data.balance;
  }

  private buildTask(request: SolveRequest): Record<string, unknown> {
    switch (request.captchaType) {
      case 'recaptcha_v2':
        return {
          type: 'RecaptchaV2TaskProxyless',
          websiteURL: request.pageUrl,
          websiteKey: request.siteKey,
          isInvisible: request.invisible ?? false,
        };
      case 'recaptcha_v3':
        return {
          type: 'RecaptchaV3TaskProxyless',
          websiteURL: request.pageUrl,
          websiteKey: request.siteKey,
          minScore: request.minScore ?? 0.3,
          pageAction: request.action ?? 'verify',
        };
      case 'hcaptcha':
        return {
          type: 'HCaptchaTaskProxyless',
          websiteURL: request.pageUrl,
          websiteKey: request.siteKey,
        };
      case 'turnstile':
        return {
          type: 'TurnstileTaskProxyless',
          websiteURL: request.pageUrl,
          websiteKey: request.siteKey,
        };
      default:
        throw new Error(`Unsupported CAPTCHA type: ${request.captchaType}`);
    }
  }

  private async pollResult(taskId: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
      let data: { status: string; errorId: number; errorDescription?: string; solution?: { gRecaptchaResponse?: string; token?: string } };
      try {
        const response = await fetch(`${API_BASE}/getTaskResult`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.config.apiKey, taskId: parseInt(taskId, 10) }),
          signal: AbortSignal.timeout(15000),
        });
        data = await response.json() as typeof data;
        consecutiveErrors = 0;
      } catch (err) {
        if (++consecutiveErrors >= 3) throw new Error(`Anti-Captcha poll failed after 3 consecutive network errors: ${err}`);
        continue;
      }

      if (data.status === 'processing') continue;
      if (data.errorId !== 0) throw new Error(`Anti-Captcha solve failed: ${data.errorDescription}`);
      if (data.solution) return data.solution.gRecaptchaResponse || data.solution.token || '';
      throw new Error('Anti-Captcha: empty solution');
    }

    throw new Error(`Anti-Captcha solve timed out after ${this.timeoutMs}ms`);
  }

  private estimateCost(captchaType: CaptchaType): number {
    switch (captchaType) {
      case 'recaptcha_v2': return 0.002;
      case 'recaptcha_v3': return 0.003;
      case 'hcaptcha': return 0.002;
      case 'turnstile': return 0.002;
      default: return 0.002;
    }
  }
}
