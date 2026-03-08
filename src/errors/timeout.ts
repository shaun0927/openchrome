/**
 * Typed timeout error for OpenChrome.
 * Replaces fragile string-based timeout detection across the codebase.
 */
export class OpenChromeTimeoutError extends Error {
  /** Whether the operation may have produced useful partial state (e.g., partial DOM load). */
  readonly recoverable: boolean;
  /** Original operation label for diagnostics. */
  readonly label: string;
  /** Timeout duration in milliseconds. */
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number, recoverable = false) {
    super(`${label} timed out after ${timeoutMs}ms`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'OpenChromeTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.recoverable = recoverable;
  }
}

/**
 * Type guard for timeout errors. Checks for:
 * 1. OpenChromeTimeoutError instances (preferred)
 * 2. Legacy string-based patterns including Puppeteer's "Waiting failed: Xms exceeded"
 */
export function isTimeoutError(error: unknown): error is OpenChromeTimeoutError | Error {
  if (error instanceof OpenChromeTimeoutError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('timed out') ||
      /waiting failed:.*exceeded/i.test(error.message)
    );
  }
  return false;
}
