export interface TextMetrics {
  returned_chars: number;
  estimated_tokens: number;
  truncated: boolean;
  mode?: string;
}

export interface RawTextMetrics extends TextMetrics {
  raw_chars: number;
  raw_estimated_tokens: number;
  compression_ratio: number;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // Deliberately approximate and provider-neutral. The field name is
  // `estimated_tokens`, not exact tokens.
  return Math.ceil(text.length / 4);
}

export function buildTextMetrics(text: string, opts?: { mode?: string; truncated?: boolean }): TextMetrics {
  return {
    returned_chars: text.length,
    estimated_tokens: estimateTokens(text),
    truncated: opts?.truncated ?? text.includes('...[truncated]'),
    ...(opts?.mode ? { mode: opts.mode } : {}),
  };
}

export function buildRawTextMetrics(
  rawText: string,
  returnedText: string,
  opts?: { mode?: string; truncated?: boolean },
): RawTextMetrics {
  const rawTokens = estimateTokens(rawText);
  const returnedTokens = estimateTokens(returnedText);
  return {
    raw_chars: rawText.length,
    raw_estimated_tokens: rawTokens,
    returned_chars: returnedText.length,
    estimated_tokens: returnedTokens,
    compression_ratio: returnedText.length > 0
      ? Number((rawText.length / returnedText.length).toFixed(3))
      : rawText.length === 0 ? 1 : 0,
    truncated: opts?.truncated ?? returnedText.includes('...[truncated]'),
    ...(opts?.mode ? { mode: opts.mode } : {}),
  };
}

export function appendMetricsFooter(text: string, metrics: object): string {
  return `${text}\n\n[openchrome_metrics] ${JSON.stringify(metrics)}`;
}
