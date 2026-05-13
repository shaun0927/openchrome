/** Web Vitals collection helpers for oc_vitals (#840). No `web-vitals` package dependency. */

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalThreshold {
  good: number;
  poor: number;
}

export const WEB_VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
} as const;

export function rateVital(value: number, thresholds: VitalThreshold): WebVitalRating {
  if (value <= thresholds.good) return 'good';
  if (value > thresholds.poor) return 'poor';
  return 'needs-improvement';
}

export const rateLcp = (valueMs: number): WebVitalRating => rateVital(valueMs, WEB_VITAL_THRESHOLDS.lcp);
export const rateCls = (value: number): WebVitalRating => rateVital(value, WEB_VITAL_THRESHOLDS.cls);
export const rateInp = (valueMs: number): WebVitalRating => rateVital(valueMs, WEB_VITAL_THRESHOLDS.inp);
export const rateTtfb = (valueMs: number): WebVitalRating => rateVital(valueMs, WEB_VITAL_THRESHOLDS.ttfb);
export const rateFcp = (valueMs: number): WebVitalRating => rateVital(valueMs, WEB_VITAL_THRESHOLDS.fcp);

export interface RawLcpMetric {
  valueMs: number;
  occurredAtMs: number;
  /** Pre-resolved alias/selector from the page context, when available. */
  element?: string | null;
  /** Node-testable alias inputs; normalizeWebVitals resolves these before fallbackSelector. */
  elementAliases?: Record<string, string | null | undefined>;
  fallbackSelector?: string | null;
}

export interface RawClsMetric {
  value: number;
  largestShift: { valueMs: number; value: number } | null;
}

export interface RawInpMetric {
  valueMs: number;
  interactionCount: number;
}

export interface RawWebVitals {
  lcp: RawLcpMetric | null;
  cls: RawClsMetric;
  inp: RawInpMetric | null;
  inpNullReason?: 'no-interaction' | 'unsupported';
  ttfb: { valueMs: number } | null;
  fcp: { valueMs: number } | null;
  collectedAtMs: number;
}

export interface WebVitalsReport {
  lcp: { valueMs: number; rating: WebVitalRating; element: string | null; occurredAtMs: number } | null;
  cls: { value: number; rating: WebVitalRating; largestShift: { valueMs: number; value: number } | null };
  inp: { valueMs: number; rating: WebVitalRating; interactionCount: number } | null;
  inpNullReason?: 'no-interaction' | 'unsupported';
  ttfb: { valueMs: number; rating: WebVitalRating } | null;
  fcp: { valueMs: number; rating: WebVitalRating } | null;
  collectedAtMs: number;
}

function roundMs(value: number): number {
  return Math.round(value);
}

function roundDecimal(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function resolveVitalsElementLabel(
  aliases: Record<string, string | null | undefined> | undefined,
  fallbackSelector: string | null | undefined,
): string | null {
  for (const attr of ['data-oc-ref', 'data-openchrome-ref', 'data-ref', 'data-testid']) {
    const value = aliases?.[attr];
    if (!value?.trim()) continue;
    if (/^@e\d+$/.test(value) || /^ref_\d+$/.test(value)) return value;
      return `[${attr}="${value.replace(/"/g, '\\"')}"]`;
  }
  return fallbackSelector ?? null;
}

export function normalizeWebVitals(raw: RawWebVitals): WebVitalsReport {
  return {
    lcp: raw.lcp
      ? {
          valueMs: roundMs(raw.lcp.valueMs),
          rating: rateLcp(raw.lcp.valueMs),
          element: raw.lcp.element ?? resolveVitalsElementLabel(raw.lcp.elementAliases, raw.lcp.fallbackSelector),
          occurredAtMs: roundMs(raw.lcp.occurredAtMs),
        }
      : null,
    cls: {
      value: roundDecimal(raw.cls.value),
      rating: rateCls(raw.cls.value),
      largestShift: raw.cls.largestShift
        ? {
            valueMs: roundMs(raw.cls.largestShift.valueMs),
            value: roundDecimal(raw.cls.largestShift.value),
          }
        : null,
    },
    inp: raw.inp
      ? {
          valueMs: roundMs(raw.inp.valueMs),
          rating: rateInp(raw.inp.valueMs),
          interactionCount: raw.inp.interactionCount,
        }
      : null,
    inpNullReason: raw.inp ? undefined : raw.inpNullReason,
    ttfb: raw.ttfb ? { valueMs: roundMs(raw.ttfb.valueMs), rating: rateTtfb(raw.ttfb.valueMs) } : null,
    fcp: raw.fcp ? { valueMs: roundMs(raw.fcp.valueMs), rating: rateFcp(raw.fcp.valueMs) } : null,
    collectedAtMs: roundMs(raw.collectedAtMs),
  };
}

/** Executes inside page.evaluate; keep self-contained. */
export async function collectWebVitalsInPage(): Promise<RawWebVitals> {
  function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function cssEscape(value: string): string {
    const css = (globalThis as typeof globalThis & { CSS?: { escape?: (s: string) => string } }).CSS;
    if (css?.escape) return css.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function selectorForElement(el: Element | null | undefined): string | null {
    if (!el) return null;
    for (const attr of ['data-oc-ref', 'data-openchrome-ref', 'data-ref', 'data-testid']) {
      const value = el.getAttribute(attr);
      if (!value?.trim()) continue;
      if (/^@e\d+$/.test(value) || /^ref_\d+$/.test(value)) return value;
      return `[${attr}="${value.replace(/"/g, '\\"')}"]`;
    }
    const htmlEl = el as HTMLElement;
    if (htmlEl.id) return `#${cssEscape(htmlEl.id)}`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      const currentHtml = current as HTMLElement;
      if (currentHtml.id) {
        part += `#${cssEscape(currentHtml.id)}`;
        parts.unshift(part);
        break;
      }
      const currentParent: Element | null = current.parentElement;
      if (currentParent) {
        const siblings = Array.from(currentParent.children) as Element[];
        const sameTagSiblings = siblings.filter((child: Element) => child.tagName === current!.tagName);
        if (sameTagSiblings.length > 1) part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = currentParent;
    }
    return parts.length > 0 ? parts.join(' > ') : el.tagName.toLowerCase();
  }

  const observedEntries: Record<string, PerformanceEntry[]> = {};
  const observers: PerformanceObserver[] = [];
  const supported = typeof PerformanceObserver !== 'undefined'
    ? new Set(PerformanceObserver.supportedEntryTypes || [])
    : new Set<string>();
  for (const type of ['largest-contentful-paint', 'layout-shift', 'event']) {
    if (!supported.has(type)) continue;
    try {
      const observer = new PerformanceObserver((list) => {
        observedEntries[type] = (observedEntries[type] || []).concat(list.getEntries());
      });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch {
      // Unsupported observer options are non-fatal; performance entries below remain the fallback.
    }
  }
  if (observers.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const observer of observers) observer.disconnect();
  }

  const lcpEntries = ((observedEntries['largest-contentful-paint']?.length
    ? observedEntries['largest-contentful-paint']
    : performance.getEntriesByType('largest-contentful-paint')) as Array<PerformanceEntry & {
    renderTime?: number;
    loadTime?: number;
    element?: Element;
  }>);
  const lcpEntry = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;
  const lcpValue = numberOrNull(lcpEntry?.renderTime) ?? numberOrNull(lcpEntry?.loadTime) ?? numberOrNull(lcpEntry?.startTime);

  const layoutShiftEntries = ((observedEntries['layout-shift']?.length
    ? observedEntries['layout-shift']
    : performance.getEntriesByType('layout-shift')) as Array<PerformanceEntry & {
    value?: number;
    hadRecentInput?: boolean;
  }>);
  let clsValue = 0;
  let largestShift: { valueMs: number; value: number } | null = null;
  for (const entry of layoutShiftEntries) {
    if (entry.hadRecentInput) continue;
    const value = numberOrNull(entry.value) ?? 0;
    clsValue += value;
    if (!largestShift || value > largestShift.value) largestShift = { valueMs: numberOrNull(entry.startTime) ?? 0, value };
  }

  const eventEntries = ((observedEntries.event?.length
    ? observedEntries.event
    : performance.getEntriesByType('event')) as Array<PerformanceEntry & {
    duration?: number;
    interactionId?: number;
  }>);
  const interactions = eventEntries.filter((entry) => typeof entry.interactionId === 'number' && entry.interactionId > 0);
  const inp = interactions.length > 0
    ? {
        valueMs: interactions.reduce((max, entry) => Math.max(max, numberOrNull(entry.duration) ?? 0), 0),
        interactionCount: new Set(interactions.map((entry) => entry.interactionId)).size,
      }
    : null;

  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const ttfbValue = navigation ? numberOrNull(navigation.responseStart - navigation.requestStart) : null;
  const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
  const fcpValue = numberOrNull(fcpEntry?.startTime);

  return {
    lcp: lcpEntry && lcpValue !== null
      ? { valueMs: lcpValue, occurredAtMs: numberOrNull(lcpEntry.startTime) ?? lcpValue, element: selectorForElement(lcpEntry.element) }
      : null,
    cls: { value: clsValue, largestShift },
    inp,
    inpNullReason: inp ? undefined : (eventEntries.length === 0 ? 'no-interaction' : 'unsupported'),
    ttfb: ttfbValue !== null ? { valueMs: ttfbValue } : null,
    fcp: fcpValue !== null ? { valueMs: fcpValue } : null,
    collectedAtMs: performance.now(),
  };
}
