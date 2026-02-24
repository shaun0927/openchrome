/**
 * Counters for tracking MCP tool call metrics.
 * Used by benchmark tasks to accumulate metrics across multiple calls.
 */
export interface MeasureCounters {
  inputChars: number;
  outputChars: number;
  toolCallCount: number;
  /** Accumulated server-side execution time from _timing.durationMs (ms) */
  serverTimingMs: number;
}

/**
 * Create a fresh set of zero-initialized counters.
 */
export function createCounters(): MeasureCounters {
  return { inputChars: 0, outputChars: 0, toolCallCount: 0, serverTimingMs: 0 };
}

/**
 * Extract _timing.durationMs from an MCP tool result.
 * Returns 0 if not present or not parseable.
 */
export function extractServerTiming(result: unknown): number {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    // Check top-level _timing
    if (obj._timing && typeof obj._timing === 'object') {
      const timing = obj._timing as Record<string, unknown>;
      if (typeof timing.durationMs === 'number') {
        return timing.durationMs;
      }
    }
    // Check inside content[0].text (JSON string with _timing)
    if (Array.isArray(obj.content) && obj.content.length > 0) {
      const firstContent = obj.content[0];
      if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
        try {
          const parsed = JSON.parse((firstContent as { text: string }).text);
          if (parsed && parsed._timing && typeof parsed._timing.durationMs === 'number') {
            return parsed._timing.durationMs;
          }
        } catch {
          // Not JSON, skip
        }
      }
    }
  }
  return 0;
}

/**
 * Measure a single MCP tool call and accumulate metrics.
 * Extracts _timing.durationMs from the result if present.
 *
 * Backwards compatible: counters without serverTimingMs are accepted;
 * serverTimingMs accumulation is skipped in that case.
 */
export function measureCall(
  result: unknown,
  args: Record<string, unknown>,
  counters: { inputChars: number; outputChars: number; toolCallCount: number; serverTimingMs?: number },
): void {
  counters.inputChars += JSON.stringify(args).length;
  counters.outputChars += JSON.stringify(result).length;
  counters.toolCallCount += 1;
  if (counters.serverTimingMs !== undefined) {
    counters.serverTimingMs += extractServerTiming(result);
  }
}
