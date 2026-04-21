/**
 * Time-based Budget primitive for hierarchical deadline propagation.
 *
 * A Budget represents a monotonic deadline (Date.now() + totalMs). Child
 * budgets carved with `slice(fraction)` cannot outlive the parent — the
 * effective deadline is `min(parent.deadline, Date.now() + remaining*fraction)`,
 * so when an upstream stage finishes faster than allocated the leftover time
 * automatically flows to the next stage.
 *
 * Used by session-init (A-3) to replace fixed retry-count loops with
 * time-sliced stages. Reusable by tool-call cancellation (B-2) later.
 */

export interface Budget {
  /** Absolute deadline in Date.now() units. */
  readonly deadline: number;
  /** Human-readable label for diagnostics (e.g. "session-init", "connect"). */
  readonly label: string;
  /** Original budget size in ms, capped by any parent deadline. */
  readonly totalMs: number;
  /** ms until deadline, clamped at 0. */
  remaining(): number;
  /** ms since this budget was created. */
  elapsedMs(): number;
  /** true when remaining() <= 0. */
  isExpired(): boolean;
  /**
   * Carve a child budget representing `fraction` (0-1) of the current remaining
   * time. The child cannot outlive the parent.
   */
  slice(fraction: number, label?: string): Budget;
  /**
   * Throw SessionInitBudgetExhausted when the budget has already run out.
   * `context` is included in the error to identify which stage consumed time.
   */
  assertNotExpired(context: string): void;
  /**
   * Throw SessionInitBudgetExhausted when remaining() is below `minRequiredMs`.
   * Use this to abort an operation that cannot meaningfully complete in the
   * remaining time (e.g. a retry attempt that needs at least 3s).
   */
  requireRemaining(minRequiredMs: number, context: string): void;
}

class BudgetImpl implements Budget {
  public readonly deadline: number;
  public readonly label: string;
  public readonly totalMs: number;
  private readonly startedAt: number;

  constructor(totalMs: number, label: string, parentDeadline?: number) {
    if (!Number.isFinite(totalMs) || totalMs < 0) {
      throw new Error(`Budget totalMs must be a non-negative finite number, got ${totalMs}`);
    }
    this.startedAt = Date.now();
    const rawDeadline = this.startedAt + totalMs;
    // Child cannot outlive parent.
    this.deadline = parentDeadline !== undefined ? Math.min(rawDeadline, parentDeadline) : rawDeadline;
    this.totalMs = Math.max(0, this.deadline - this.startedAt);
    this.label = label;
  }

  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  isExpired(): boolean {
    return this.remaining() === 0;
  }

  slice(fraction: number, label?: string): Budget {
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new Error(`Budget.slice fraction must be in (0, 1], got ${fraction}`);
    }
    const childMs = Math.floor(this.remaining() * fraction);
    const childLabel = label ? `${this.label}/${label}` : `${this.label}/slice`;
    return new BudgetImpl(childMs, childLabel, this.deadline);
  }

  assertNotExpired(context: string): void {
    if (this.isExpired()) {
      this.throwExhausted(context);
    }
  }

  requireRemaining(minRequiredMs: number, context: string): void {
    if (!Number.isFinite(minRequiredMs) || minRequiredMs < 0) {
      throw new Error(`Budget.requireRemaining minRequiredMs must be >= 0, got ${minRequiredMs}`);
    }
    if (this.remaining() < minRequiredMs) {
      this.throwExhausted(context);
    }
  }

  private throwExhausted(context: string): never {
    // Lazy import avoids circular deps with other cdp modules if they evolve.
    const { SessionInitBudgetExhausted } = require('../cdp/errors') as typeof import('../cdp/errors');
    throw new SessionInitBudgetExhausted(context, this.label, this.elapsedMs(), this.totalMs);
  }
}

/**
 * Create a root Budget with the given total milliseconds.
 * `label` is propagated to all child slices for diagnostics.
 */
export function createBudget(totalMs: number, label = 'root'): Budget {
  return new BudgetImpl(totalMs, label);
}

/**
 * Env flag: set OPENCHROME_SESSION_INIT_BUDGET_MODE=legacy to fall back to
 * retry-count-based behavior in consumers. Budget class itself is always
 * available — consumers are responsible for checking this flag.
 */
export function isLegacyBudgetMode(): boolean {
  return (process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE ?? '').toLowerCase() === 'legacy';
}
