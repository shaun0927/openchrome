/**
 * Retry with fallback utility.
 * Retries the primary operation, then tries fallback methods before giving up.
 */

export interface RetryOptions {
  /** Maximum retry attempts for primary method (default: 1) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 500) */
  retryDelayMs?: number;
  /** Label for logging (default: 'operation') */
  label?: string;
}

export async function retryWithFallback<T>(
  primary: () => Promise<T>,
  fallbacks: Array<() => Promise<T>>,
  options: RetryOptions = {}
): Promise<{ result: T; recovered: boolean; method: string }> {
  const { maxRetries = 1, retryDelayMs = 500, label = 'operation' } = options;

  // Try primary with retries
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await primary();
      return { result, recovered: attempt > 0, method: 'primary' };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        console.error(`[retry] ${label} attempt ${attempt + 1} failed, retrying in ${retryDelayMs}ms...`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }

  // Try fallbacks
  for (let i = 0; i < fallbacks.length; i++) {
    try {
      console.error(`[retry] ${label} trying fallback ${i + 1}...`);
      const result = await fallbacks[i]();
      return { result, recovered: true, method: `fallback-${i + 1}` };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // All methods exhausted
  throw lastError || new Error(`${label}: all recovery methods exhausted`);
}
