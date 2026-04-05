/**
 * CAPTCHA Solver Interface (#574)
 *
 * Abstract interface for third-party CAPTCHA solving services.
 * Implementations: 2Captcha, Anti-Captcha, CapSolver.
 */

import type { CaptchaType } from '../types/captcha';

/** Request payload sent to a solver provider. */
export interface SolveRequest {
  /** The type of CAPTCHA to solve. */
  captchaType: CaptchaType;
  /** The site key extracted from the page. */
  siteKey: string;
  /** The URL of the page containing the CAPTCHA. */
  pageUrl: string;
  /** Whether this is an invisible CAPTCHA (reCAPTCHA v3). */
  invisible?: boolean;
  /** Optional reCAPTCHA v3 action string. */
  action?: string;
  /** Optional minimum score for reCAPTCHA v3 (0.1-0.9). */
  minScore?: number;
}

/** Solution returned by a solver provider. */
export interface SolveResult {
  /** The solution token to inject into the page. */
  token: string;
  /** Provider-specific task/request ID for tracking. */
  taskId: string;
  /** Time in milliseconds the solve took. */
  solveTimeMs: number;
  /** Estimated cost in USD. */
  costUsd: number;
}

/** Error from a solver provider. */
export interface SolverError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Provider configuration. */
export interface SolverConfig {
  /** API key for the provider. */
  apiKey: string;
  /** Solve timeout in milliseconds (default: 120000). */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 5000). */
  pollIntervalMs?: number;
}

/**
 * Abstract CAPTCHA solver. Each provider (2Captcha, Anti-Captcha, CapSolver)
 * implements this interface.
 */
export abstract class CaptchaSolver {
  readonly name: string;
  protected config: SolverConfig;

  constructor(name: string, config: SolverConfig) {
    this.name = name;
    this.config = config;
  }

  /** Check if this solver supports the given CAPTCHA type. */
  abstract supportsType(captchaType: CaptchaType): boolean;

  /** Submit a CAPTCHA for solving and return the solution. */
  abstract solve(request: SolveRequest): Promise<SolveResult>;

  /** Get the current account balance (for cost tracking). */
  abstract getBalance(): Promise<number>;

  /** Timeout for solving in milliseconds. */
  get timeoutMs(): number {
    return this.config.timeoutMs ?? 120000;
  }

  /** Poll interval for checking solution status. */
  get pollIntervalMs(): number {
    return this.config.pollIntervalMs ?? 5000;
  }
}
