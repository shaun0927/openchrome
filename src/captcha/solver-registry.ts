/**
 * CAPTCHA Solver Registry (#574)
 *
 * Manages solver provider instances and dispatches solve requests
 * with rate limiting and cost tracking.
 */

import type { CaptchaType } from '../types/captcha';
import { CaptchaSolver, SolveRequest, SolveResult, SolverConfig } from './solver-interface';

/** Supported provider names. */
export type SolverProvider = '2captcha' | 'anticaptcha' | 'capsolver';

/** Session-level cost tracking. */
export interface CostTracker {
  totalSolves: number;
  totalCostUsd: number;
  dailySolves: number;
  dailyLimitReached: boolean;
  lastSolveAt: number;
}

export class SolverRegistry {
  private solver: CaptchaSolver | null = null;
  private costTracker: CostTracker = {
    totalSolves: 0,
    totalCostUsd: 0,
    dailySolves: 0,
    dailyLimitReached: false,
    lastSolveAt: 0,
  };
  private dailyLimit: number;
  private minSolveIntervalMs: number;
  private autoSolve: boolean;
  private dailyResetDate: string = '';

  constructor() {
    this.dailyLimit = parseInt(process.env.OPENCHROME_CAPTCHA_DAILY_LIMIT || '', 10) || 100;
    this.minSolveIntervalMs = 3000; // Minimum 3s between solves
    this.autoSolve = process.env.OPENCHROME_CAPTCHA_AUTO_SOLVE === 'true';
  }

  /** Initialize the solver from environment variables. */
  async initialize(): Promise<void> {
    const provider = process.env.OPENCHROME_CAPTCHA_PROVIDER as SolverProvider | undefined;
    const apiKey = process.env.OPENCHROME_CAPTCHA_API_KEY;

    if (!provider || !apiKey) {
      this.solver = null;
      return;
    }

    const config: SolverConfig = { apiKey };

    switch (provider) {
      case '2captcha': {
        const { TwoCaptchaSolver } = await import('./providers/twocaptcha');
        this.solver = new TwoCaptchaSolver(config);
        break;
      }
      case 'anticaptcha': {
        const { AntiCaptchaSolver } = await import('./providers/anticaptcha');
        this.solver = new AntiCaptchaSolver(config);
        break;
      }
      case 'capsolver': {
        const { CapSolverSolver } = await import('./providers/capsolver');
        this.solver = new CapSolverSolver(config);
        break;
      }
      default:
        console.error(`[CaptchaSolver] Unknown provider: ${provider}. Supported: 2captcha, anticaptcha, capsolver`);
        this.solver = null;
    }

    if (this.solver) {
      console.error(`[CaptchaSolver] Initialized provider: ${provider}, auto-solve: ${this.autoSolve}`);
    }
  }

  /** Whether a solver is configured and available. */
  isConfigured(): boolean {
    return this.solver !== null;
  }

  /** Whether auto-solve is enabled. */
  isAutoSolveEnabled(): boolean {
    return this.autoSolve && this.isConfigured();
  }

  /** Whether this CAPTCHA type can be solved. */
  canSolve(captchaType: CaptchaType): boolean {
    if (!this.solver) return false;
    if (this.costTracker.dailyLimitReached) return false;
    return this.solver.supportsType(captchaType);
  }

  /** Solve a CAPTCHA. Enforces rate limiting and daily limits. */
  async solve(request: SolveRequest): Promise<SolveResult> {
    if (!this.solver) {
      throw new Error('No CAPTCHA solver configured. Set OPENCHROME_CAPTCHA_PROVIDER and OPENCHROME_CAPTCHA_API_KEY.');
    }

    // Reset daily counter if date changed
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyResetDate !== today) {
      this.dailyResetDate = today;
      this.costTracker.dailySolves = 0;
      this.costTracker.dailyLimitReached = false;
    }

    // Check daily limit
    if (this.costTracker.dailySolves >= this.dailyLimit) {
      this.costTracker.dailyLimitReached = true;
      throw new Error(`Daily CAPTCHA solve limit reached (${this.dailyLimit}). Set OPENCHROME_CAPTCHA_DAILY_LIMIT to increase.`);
    }

    // Rate limiting: minimum 3s between solves
    const now = Date.now();
    const elapsed = now - this.costTracker.lastSolveAt;
    if (elapsed < this.minSolveIntervalMs) {
      const waitMs = this.minSolveIntervalMs - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    console.error(`[CaptchaSolver] Solving ${request.captchaType} on ${request.pageUrl}...`);
    const result = await this.solver.solve(request);

    // Update cost tracking
    this.costTracker.totalSolves++;
    this.costTracker.dailySolves++;
    this.costTracker.totalCostUsd += result.costUsd;
    this.costTracker.lastSolveAt = Date.now();

    console.error(`[CaptchaSolver] Solved in ${result.solveTimeMs}ms, cost: $${result.costUsd.toFixed(4)}`);
    return result;
  }

  /** Get current cost tracking data. */
  getCostTracker(): CostTracker {
    return { ...this.costTracker };
  }

  /** Get solver provider name. */
  getProviderName(): string | null {
    return this.solver?.name ?? null;
  }
}

// Singleton
let instance: SolverRegistry | null = null;

export function getSolverRegistry(): SolverRegistry {
  if (!instance) {
    instance = new SolverRegistry();
    instance.initialize().catch(err => {
      console.error('[CaptchaSolver] Initialization failed:', err instanceof Error ? err.message : err);
    });
  }
  return instance;
}
