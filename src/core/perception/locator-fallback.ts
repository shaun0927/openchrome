export type LocatorFallbackTrigger = 'STALE_REF' | 'ELEMENT_NOT_FOUND' | 'AMBIGUOUS_SELECTOR' | 'VISIBLE_LABEL_MISMATCH';

export interface LocatorFallbackCandidate {
  selector?: string;
  backendNodeId?: number;
  ref?: string;
  label?: string;
  confidence: number;
  reason: string;
  provider: string;
}

export interface LocatorFallbackRequest {
  trigger: LocatorFallbackTrigger;
  query: string;
  action?: string;
  tabId: string;
  sessionId: string;
  pageUrl?: string;
  pageTitle?: string;
  maxCandidates?: number;
}

export interface LocatorFallbackResult {
  provider: string;
  candidates: LocatorFallbackCandidate[];
}

export interface ValidatedLocatorFallbackCandidate extends LocatorFallbackCandidate {
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface LocatorFallbackValidationResult {
  accepted: ValidatedLocatorFallbackCandidate | null;
  rejected: Array<{ candidate: LocatorFallbackCandidate; reason: string }>;
}

export interface LocatorFallbackProvider {
  name: string;
  locate(request: LocatorFallbackRequest): Promise<LocatorFallbackResult>;
}

class NoopLocatorFallbackProvider implements LocatorFallbackProvider {
  readonly name = 'noop';
  async locate(_request: LocatorFallbackRequest): Promise<LocatorFallbackResult> {
    return { provider: this.name, candidates: [] };
  }
}

let provider: LocatorFallbackProvider = new NoopLocatorFallbackProvider();

export function getLocatorFallbackProvider(): LocatorFallbackProvider {
  return provider;
}

export function setLocatorFallbackProviderForTests(next: LocatorFallbackProvider | null): void {
  provider = next ?? new NoopLocatorFallbackProvider();
}

export function isLocatorFallbackEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const env = process.env.OPENCHROME_LOCATOR_FALLBACK;
  const envEnabled = env === '1' || env === 'true' || env === 'yes';
  if (value && typeof value === 'object') {
    const enabled = (value as Record<string, unknown>).enabled;
    if (enabled === false) return false;
    return enabled === true || envEnabled;
  }
  return envEnabled;
}

export function locatorFallbackThreshold(value: unknown): number {
  if (value && typeof value === 'object') {
    const threshold = (value as Record<string, unknown>).minConfidence;
    if (typeof threshold === 'number' && Number.isFinite(threshold)) {
      return Math.min(Math.max(threshold, 0), 1);
    }
  }
  return 0.7;
}

export function classifyLocatorFallbackTrigger(codeOrMessage: string): LocatorFallbackTrigger | null {
  if (/STALE_REF|stale ref|no longer valid|could not be resolved/i.test(codeOrMessage)) return 'STALE_REF';
  if (/No elements found|Could not find|ELEMENT_NOT_FOUND|not found|no match/i.test(codeOrMessage)) return 'ELEMENT_NOT_FOUND';
  if (/ambiguous|multiple candidates|selector ambiguity/i.test(codeOrMessage)) return 'AMBIGUOUS_SELECTOR';
  if (/label mismatch|visible label mismatch/i.test(codeOrMessage)) return 'VISIBLE_LABEL_MISMATCH';
  return null;
}

export async function resolveLocatorFallback(
  request: LocatorFallbackRequest,
  validate: (candidate: LocatorFallbackCandidate) => Promise<ValidatedLocatorFallbackCandidate | null>,
  opts: { minConfidence?: number; provider?: LocatorFallbackProvider } = {},
): Promise<LocatorFallbackValidationResult & { provider: string }> {
  const activeProvider = opts.provider ?? getLocatorFallbackProvider();
  const located = await activeProvider.locate(request);
  const rejected: LocatorFallbackValidationResult['rejected'] = [];
  const minConfidence = opts.minConfidence ?? 0.7;

  const candidates = located.candidates
    .filter((candidate) => candidate && typeof candidate.confidence === 'number')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, request.maxCandidates ?? 5);

  for (const candidate of candidates) {
    if (candidate.confidence < minConfidence) {
      rejected.push({ candidate, reason: `confidence ${candidate.confidence} below threshold ${minConfidence}` });
      continue;
    }
    if (!candidate.selector && candidate.backendNodeId === undefined && !candidate.ref) {
      rejected.push({ candidate, reason: 'candidate has no selector, backendNodeId, or ref' });
      continue;
    }
    const validated = await validate(candidate);
    if (validated) return { provider: located.provider || activeProvider.name, accepted: validated, rejected };
    rejected.push({ candidate, reason: 'candidate failed visibility/clickability validation' });
  }

  return { provider: located.provider || activeProvider.name, accepted: null, rejected };
}
