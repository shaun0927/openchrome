/**
 * Typed errors used across the CDP subsystem.
 *
 * Callers use `instanceof` to distinguish structural failure modes from
 * generic Error instances. Kept in its own file to avoid circular imports
 * from `client.ts` and `../utils/budget.ts`.
 */

/**
 * Thrown when a session-init Budget runs out before a stage completes.
 *
 * - `context`: call site that detected exhaustion (e.g. "connectInternal.attempt").
 * - `stage`: Budget.label at the time of exhaustion (e.g. "session-init/connect").
 * - `elapsedMs`: how long the budget had been running.
 * - `totalMs`: original budget size.
 */
export class SessionInitBudgetExhausted extends Error {
  public readonly context: string;
  public readonly stage: string;
  public readonly elapsedMs: number;
  public readonly totalMs: number;

  constructor(context: string, stage: string, elapsedMs: number, totalMs: number) {
    super(
      `[Session Init] Budget exhausted after ${stage}, elapsed=${elapsedMs}ms, total=${totalMs}ms (at ${context})`,
    );
    this.name = 'SessionInitBudgetExhausted';
    this.context = context;
    this.stage = stage;
    this.elapsedMs = elapsedMs;
    this.totalMs = totalMs;
    // Preserve prototype chain for instanceof under transpilation.
    Object.setPrototypeOf(this, SessionInitBudgetExhausted.prototype);
  }
}
