export const EXTRACTION_MODES = ['fast', 'standard', 'semantic'] as const;
export type ExtractionMode = (typeof EXTRACTION_MODES)[number];

export interface ExtractionModeBudget {
  readonly mode: ExtractionMode;
  readonly jsonLdTimeoutMs: number;
  readonly microdataTimeoutMs: number;
  readonly openGraphTimeoutMs: number;
  readonly cssTimeoutMs: number;
  readonly standardDomTimeoutMs: number;
  readonly maxCssNodes: number;
  readonly maxStandardDomNodes: number;
}

export const EXTRACTION_MODE_BUDGETS: Record<ExtractionMode, ExtractionModeBudget> = {
  fast: {
    mode: 'fast',
    jsonLdTimeoutMs: 5000,
    microdataTimeoutMs: 5000,
    openGraphTimeoutMs: 5000,
    cssTimeoutMs: 10000,
    standardDomTimeoutMs: 0,
    maxCssNodes: 500,
    maxStandardDomNodes: 0,
  },
  standard: {
    mode: 'standard',
    jsonLdTimeoutMs: 5000,
    microdataTimeoutMs: 5000,
    openGraphTimeoutMs: 5000,
    cssTimeoutMs: 10000,
    standardDomTimeoutMs: 12000,
    maxCssNodes: 1000,
    maxStandardDomNodes: 2000,
  },
  semantic: {
    mode: 'semantic',
    jsonLdTimeoutMs: 0,
    microdataTimeoutMs: 0,
    openGraphTimeoutMs: 0,
    cssTimeoutMs: 0,
    standardDomTimeoutMs: 0,
    maxCssNodes: 0,
    maxStandardDomNodes: 0,
  },
};

export function parseExtractionMode(value: unknown): { ok: true; mode: ExtractionMode } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, mode: 'fast' };
  if (value === 'fast' || value === 'standard' || value === 'semantic') return { ok: true, mode: value };
  return { ok: false, error: 'Invalid mode. Use "fast", "standard", or "semantic".' };
}
