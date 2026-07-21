/**
 * Pixel-grounding fallback tier for vision-driven interaction.
 *
 * Motivation
 * ----------
 * openchrome's primary interaction path is DOM- / a11y-tree-based (see
 * `src/dom/`, `src/vision/dom-annotator-provider.ts`). This works when the
 * page cooperates. When it does not — heavily-shadowed DOM, canvas-only
 * UI (Figma, MapLibre, WebGL games), Salesforce Aura components, or
 * anti-automation obfuscation — the DOM does not have a stable element
 * for the thing the user actually sees.
 *
 * The fix, adopted by UI-TARS (Apache-2.0) and magnitude (Apache-2.0),
 * is a **pixel-grounding fallback**: send the screenshot + a natural-
 * language target ("click the blue Submit button") to a vision model
 * and receive normalised pixel coordinates back. openchrome then clicks
 * at those coordinates.
 *
 * This module contributes the **contract** for that fallback tier — a
 * `PixelGroundingAdapter` interface, a request/response shape covering
 * click / hover / drag / type targets, and a `PixelGroundingFallbackChain`
 * orchestrator that tries adapters in priority order and short-circuits on
 * the first confident hit.
 *
 * The module does not ship a UI-TARS or magnitude implementation —
 * openchrome cannot depend on those model runtimes. It ships the shape a
 * downstream plugin implements once, so the tier itself is native to the
 * MCP server and every plugin looks the same to callers.
 *
 * References
 * ----------
 * - UI-TARS (Apache-2.0) — https://github.com/bytedance/UI-TARS
 * - magnitude (Apache-2.0) — https://github.com/magnitudedev/magnitude
 * - Skyvern (AGPL-3.0) — https://github.com/Skyvern-AI/skyvern (form-vision
 *   idiom, referenced for the target-language grammar).
 *
 * Clean-room re-implementation. No UI-TARS / magnitude / Skyvern source
 * was copied.
 */

/**
 * The user-visible target types the fallback can ground.
 *
 * `click`  — a single click / tap on the target.
 * `hover`  — a hover over the target (used for menu opens).
 * `drag`   — a drag from the target to a second target (`toTarget`).
 * `type`   — click the target then type text.
 * `select` — click the target treated as a dropdown, then click `option`.
 */
export type PixelGroundingActionKind = 'click' | 'hover' | 'drag' | 'type' | 'select';

export interface PixelGroundingRequest {
  action: PixelGroundingActionKind;
  /** Natural-language description of the target the user sees. */
  target: string;
  /** For `drag`: the drop target. */
  toTarget?: string;
  /** For `type`: the text to enter. */
  text?: string;
  /** For `select`: the option label. */
  option?: string;
  /** Screenshot bytes (PNG/JPEG/WebP). Encoding is `data.encoding`. */
  screenshot: PixelGroundingScreenshot;
  /** Viewport pixel size — required for coordinate normalisation checks. */
  viewport: { width: number; height: number };
  /** Optional per-request hint (e.g. "avoid the sidebar"). */
  hint?: string;
  /** Milliseconds a caller is willing to wait. Adapters SHOULD respect. */
  timeoutMs?: number;
}

export interface PixelGroundingScreenshot {
  encoding: 'png' | 'jpeg' | 'webp';
  bytes: Uint8Array;
  /** Device pixel ratio the screenshot was taken at. Defaults to 1. */
  devicePixelRatio?: number;
}

export interface PixelGroundingHit {
  /** Adapter-supplied confidence 0..1. */
  confidence: number;
  /** Target pixel coordinates in the screenshot's coordinate space. */
  target: { x: number; y: number };
  /** For `drag` responses. */
  toTarget?: { x: number; y: number };
  /** Optional bounding box the adapter grounded on. */
  bbox?: { x: number; y: number; width: number; height: number };
  /** Adapter freeform reasoning / logs, kept small. */
  rationale?: string;
}

export interface PixelGroundingResult {
  ok: boolean;
  /** Adapter id that produced the result (or attempted it). */
  adapterId: string;
  /** Populated when `ok === true`. */
  hit?: PixelGroundingHit;
  /** Populated when `ok === false`. */
  error?: PixelGroundingError;
  /** Wall-clock ms the adapter spent. */
  elapsedMs: number;
}

export interface PixelGroundingError {
  code: PixelGroundingErrorCode;
  message: string;
  /** True when a caller SHOULD try the next adapter. */
  retryable: boolean;
}

export type PixelGroundingErrorCode =
  | 'timeout'
  | 'model_unavailable'
  | 'no_ground'
  | 'invalid_coordinates'
  | 'rate_limited'
  | 'internal_error';

export interface PixelGroundingAdapter {
  /** Short id used in logs and telemetry (e.g. `ui-tars`, `magnitude`). */
  readonly id: string;
  /** Human-friendly label. */
  readonly label: string;
  /**
   * Priority for the fallback chain — lower runs first. Adapters with the
   * same priority are attempted in registration order.
   */
  readonly priority: number;
  /**
   * Confidence floor an adapter's hit must clear before the chain accepts
   * it. Adapters can enforce their own floor via this field so the chain
   * does not need to know model-specific calibration.
   */
  readonly minConfidence: number;
  /** Whether the adapter is currently usable (auth, quota, health). */
  isReady(): Promise<boolean> | boolean;
  /** Attempt to ground the request. MUST NOT throw — return an error result. */
  ground(request: PixelGroundingRequest): Promise<PixelGroundingResult>;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateGroundingRequest(req: PixelGroundingRequest): ValidationResult {
  if (!req) return { ok: false, error: 'request is required' };
  if (!req.action) return { ok: false, error: 'action is required' };
  if (!isKnownAction(req.action)) {
    return { ok: false, error: `unknown action: ${req.action}` };
  }
  if (!req.target || req.target.length === 0) {
    return { ok: false, error: 'target is required' };
  }
  if (req.target.length > 500) {
    return { ok: false, error: 'target exceeds 500-character cap' };
  }
  if (req.action === 'drag' && (!req.toTarget || req.toTarget.length === 0)) {
    return { ok: false, error: 'drag action requires toTarget' };
  }
  if (req.action === 'type' && (req.text === undefined || req.text === null)) {
    return { ok: false, error: 'type action requires text' };
  }
  if (req.action === 'select' && (!req.option || req.option.length === 0)) {
    return { ok: false, error: 'select action requires option' };
  }
  if (!req.viewport || req.viewport.width <= 0 || req.viewport.height <= 0) {
    return { ok: false, error: 'viewport width and height must be positive' };
  }
  if (!req.screenshot || !req.screenshot.bytes || req.screenshot.bytes.length === 0) {
    return { ok: false, error: 'screenshot bytes are required' };
  }
  if (!['png', 'jpeg', 'webp'].includes(req.screenshot.encoding)) {
    return { ok: false, error: `unsupported screenshot encoding: ${req.screenshot.encoding}` };
  }
  return { ok: true };
}

function isKnownAction(action: string): action is PixelGroundingActionKind {
  return ['click', 'hover', 'drag', 'type', 'select'].includes(action);
}

/**
 * Guard a hit's coordinates against the viewport. Adapters that return
 * coordinates outside the viewport are considered to have failed
 * (`invalid_coordinates`).
 */
export function coordinatesInViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  dpr: number,
): boolean {
  const maxX = viewport.width * dpr;
  const maxY = viewport.height * dpr;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= maxX &&
    point.y <= maxY
  );
}

// ---------------------------------------------------------------------------
// Fallback-chain orchestrator
// ---------------------------------------------------------------------------

export interface FallbackChainOptions {
  /** Global request timeout applied to every adapter unless the adapter caps sooner. */
  timeoutMs?: number;
  /** If set, chain gives up after this many failed adapters. */
  maxAttempts?: number;
  /** Called on each adapter attempt for telemetry. */
  onAttempt?: (result: PixelGroundingResult) => void;
}

export interface FallbackChainOutcome {
  ok: boolean;
  hit?: PixelGroundingHit;
  /** The adapter that produced the successful hit, when `ok === true`. */
  adapterId?: string;
  attempts: PixelGroundingResult[];
}

/**
 * Runs adapters in priority order and returns the first hit whose
 * confidence >= adapter.minConfidence and whose coordinates lie within the
 * viewport. Every attempt is recorded in `attempts` — callers can log the
 * whole trace for auditing.
 */
export class PixelGroundingFallbackChain {
  private adapters: PixelGroundingAdapter[] = [];

  constructor(private readonly options: FallbackChainOptions = {}) {}

  register(adapter: PixelGroundingAdapter): void {
    this.adapters.push(adapter);
    this.adapters.sort((a, b) => a.priority - b.priority);
  }

  size(): number {
    return this.adapters.length;
  }

  listAdapters(): ReadonlyArray<PixelGroundingAdapter> {
    return this.adapters;
  }

  async ground(request: PixelGroundingRequest): Promise<FallbackChainOutcome> {
    const validation = validateGroundingRequest(request);
    if (!validation.ok) {
      const err: PixelGroundingResult = {
        ok: false,
        adapterId: 'chain',
        error: { code: 'internal_error', message: validation.error!, retryable: false },
        elapsedMs: 0,
      };
      return { ok: false, attempts: [err] };
    }

    const attempts: PixelGroundingResult[] = [];
    const maxAttempts = this.options.maxAttempts ?? this.adapters.length;
    const dpr = request.screenshot.devicePixelRatio ?? 1;

    for (const adapter of this.adapters) {
      if (attempts.length >= maxAttempts) break;
      const ready = await Promise.resolve(adapter.isReady());
      if (!ready) {
        const skip: PixelGroundingResult = {
          ok: false,
          adapterId: adapter.id,
          error: { code: 'model_unavailable', message: 'adapter not ready', retryable: true },
          elapsedMs: 0,
        };
        attempts.push(skip);
        this.options.onAttempt?.(skip);
        continue;
      }

      const per = this.options.timeoutMs
        ? { ...request, timeoutMs: Math.min(this.options.timeoutMs, request.timeoutMs ?? this.options.timeoutMs) }
        : request;
      const result = await adapter.ground(per);
      attempts.push(result);
      this.options.onAttempt?.(result);

      if (!result.ok || !result.hit) continue;
      if (result.hit.confidence < adapter.minConfidence) continue;
      if (!coordinatesInViewport(result.hit.target, request.viewport, dpr)) continue;
      if (
        request.action === 'drag' &&
        result.hit.toTarget &&
        !coordinatesInViewport(result.hit.toTarget, request.viewport, dpr)
      ) {
        continue;
      }

      return { ok: true, hit: result.hit, adapterId: adapter.id, attempts };
    }

    return { ok: false, attempts };
  }
}
