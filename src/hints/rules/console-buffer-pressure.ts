/**
 * Console Buffer Pressure Hint Rule (#897)
 *
 * Surfaces a one-shot, rule-based hint when the console ring buffer is under
 * sustained byte pressure (as detected by the TabHealthMonitor watchdog).
 * Consistent with all existing hint conventions: rule-based, not LLM-judged.
 * Priority 95 — fires before error-recovery rules (priority 100+).
 */

import type { HintRule } from '../hint-engine';

export const consoleBufferPressureRules: HintRule[] = [
  {
    name: 'console-buffer-pressure',
    priority: 95,
    maxSeverity: 'warning',
    match(ctx) {
      // One-shot: fire only the first time this rule matches per session.
      if ((ctx.fireCounts.get('console-buffer-pressure') ?? 0) > 0) return null;
      if (ctx.toolName !== 'console_capture') return null;
      if (ctx.isError) return null;
      // Check for pressure signal in the bufferStats of the response.
      if (/"console_buffer_pressure"/.test(ctx.resultText) ||
          /"retainedBytes"\s*:\s*\d/.test(ctx.resultText) &&
          /"evictedTotal"\s*:\s*[1-9]/.test(ctx.resultText)) {
        return (
          'Hint: Console buffer is near capacity (eviction in progress). ' +
          'Call console_capture action="clear" to free space, or increase ' +
          'OPENCHROME_CONSOLE_BUFFER_MAX_BYTES / OPENCHROME_CONSOLE_BUFFER_MAX_LINES.'
        );
      }
      return null;
    },
  },
];
