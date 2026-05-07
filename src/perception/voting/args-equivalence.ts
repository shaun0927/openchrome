/**
 * Action argument equivalence for multi-model voting (#711 v2).
 *
 * Two providers' replies should not be flagged as "disagreement" when
 * they describe the same physical action via differently-shaped args.
 * Per #711 v2 the relation is per-action-type:
 *
 *   click          backendNodeId match (via host's selector→node
 *                  resolver), OR coordinate-pair distance ≤5 px
 *   type/fill      same target node + text equality after trim()
 *   navigate       same URL after dropping trailing slash + tracking
 *                  params (reuses #702's normalizeUrl)
 *   scroll         dx within ±50 px AND dy within ±50 px
 *                  AND same target frame
 *   default        deep-equal on canonical args
 *
 * The function is exhaustive — `default` throws so a new action kind
 * cannot silently slip through with structural equality.
 */

import { normalizeUrl } from '../../skill/url-normalizer';

export interface ActionInvocation {
  kind: string;
  args: unknown;
}

export interface EquivalenceContext {
  /**
   * Resolve a selector / ref / coords to a stable element id (typically
   * backendNodeId). Hosts inject this; tests pass deterministic fakes.
   * Returns null when resolution fails (treated as not-equivalent).
   */
  resolveTarget?: (action: ActionInvocation) => number | null;
}

/** Tunable thresholds — exposed so callers can override per-action. */
export const COORDINATE_TOLERANCE_PX = 5;
export const SCROLL_TOLERANCE_PX = 50;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* per-kind equivalence                                                */
/* ------------------------------------------------------------------ */

function clickEquivalent(
  a: ActionInvocation,
  b: ActionInvocation,
  ctx: EquivalenceContext,
): boolean {
  // 1. Try host-side target resolution: same node ⇒ equivalent.
  if (ctx.resolveTarget) {
    const ra = ctx.resolveTarget(a);
    const rb = ctx.resolveTarget(b);
    if (ra !== null && rb !== null && ra === rb) return true;
  }
  // 2. Coordinate-pair fallback: ±5 px on both axes.
  if (isObject(a.args) && isObject(b.args)) {
    const ax = asNumber(a.args.x);
    const ay = asNumber(a.args.y);
    const bx = asNumber(b.args.x);
    const by = asNumber(b.args.y);
    if (ax !== undefined && ay !== undefined && bx !== undefined && by !== undefined) {
      return Math.abs(ax - bx) <= COORDINATE_TOLERANCE_PX && Math.abs(ay - by) <= COORDINATE_TOLERANCE_PX;
    }
  }
  return false;
}

function typeEquivalent(
  a: ActionInvocation,
  b: ActionInvocation,
  ctx: EquivalenceContext,
): boolean {
  if (!isObject(a.args) || !isObject(b.args)) return false;
  // Target match (selector / ref / id)
  if (ctx.resolveTarget) {
    const ra = ctx.resolveTarget(a);
    const rb = ctx.resolveTarget(b);
    if (ra === null || rb === null || ra !== rb) return false;
  } else {
    // No host resolver — fall back to selector-string equality.
    if (asString(a.args.selector) !== asString(b.args.selector)) return false;
    if (asString(a.args.ref) !== asString(b.args.ref)) return false;
  }
  const ta = asString(a.args.text) ?? '';
  const tb = asString(b.args.text) ?? '';
  return ta.trim() === tb.trim();
}

function navigateEquivalent(a: ActionInvocation, b: ActionInvocation): boolean {
  if (!isObject(a.args) || !isObject(b.args)) return false;
  const ua = asString(a.args.url);
  const ub = asString(b.args.url);
  if (!ua || !ub) return false;
  try {
    const na = normalizeUrl(ua).url.replace(/\/$/, '');
    const nb = normalizeUrl(ub).url.replace(/\/$/, '');
    return na === nb;
  } catch {
    return false;
  }
}

function scrollEquivalent(a: ActionInvocation, b: ActionInvocation): boolean {
  if (!isObject(a.args) || !isObject(b.args)) return false;
  const dxa = asNumber(a.args.dx) ?? 0;
  const dya = asNumber(a.args.dy) ?? 0;
  const dxb = asNumber(b.args.dx) ?? 0;
  const dyb = asNumber(b.args.dy) ?? 0;
  const fa = asString(a.args.frame_id) ?? null;
  const fb = asString(b.args.frame_id) ?? null;
  if (fa !== fb) return false;
  return Math.abs(dxa - dxb) <= SCROLL_TOLERANCE_PX && Math.abs(dya - dyb) <= SCROLL_TOLERANCE_PX;
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

export function actionsEquivalent(
  a: ActionInvocation,
  b: ActionInvocation,
  ctx: EquivalenceContext = {},
): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'click':
      return clickEquivalent(a, b, ctx);
    case 'type':
    case 'fill_input':
      return typeEquivalent(a, b, ctx);
    case 'navigate':
      return navigateEquivalent(a, b);
    case 'scroll':
      return scrollEquivalent(a, b);
    default:
      // Unknown kind — fall through to canonical deep-equal so the
      // dispatcher can still safely compare unfamiliar actions.
      return deepEqual(a.args, b.args);
  }
}
