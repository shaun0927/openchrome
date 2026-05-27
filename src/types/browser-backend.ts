export enum BrowserBackend {
  CHROME = 'chrome',
  LIGHTPANDA = 'lightpanda',
}

export type ToolRouting = 'chrome-only' | 'prefer-lightpanda';

/**
 * Discriminator for *why* the router landed on a given backend on a given
 * call. Surfaces the routing decision as a fact (per #1359 Pillar C / P4):
 * the host agent can read this on each tool result and decide what to do
 * (token-cost optimization, retry policy, evidence enrichment) without
 * re-deriving the decision from request shape.
 *
 * Values are closed and stable — adding a new branch in the router MUST
 * extend this union so the discriminator stays exhaustive.
 *
 *  - `hybrid-disabled`: hybrid mode is off; everything goes to Chrome.
 *  - `visual-tool`: tool is registered as visual-only and bypasses LP.
 *  - `circuit-open`: LP circuit breaker is open and cooldown has not
 *    elapsed; Chrome is serving in degraded mode.
 *  - `lp-served`: LP page was healthy and served the request.
 *  - `lp-unhealthy`: LP page was missing or unhealthy; Chrome served as
 *    fallback. `fallback === true` whenever this reason is emitted.
 */
export type RouteReason =
  | 'hybrid-disabled'
  | 'visual-tool'
  | 'circuit-open'
  | 'lp-served'
  | 'lp-unhealthy';

export interface RouterStats {
  chromeRequests: number;
  lightpandaRequests: number;
  fallbacks: number;
  circuitBreakerTrips: number;
}

export interface HybridConfig {
  enabled: boolean;
  lightpandaPort: number;
  circuitBreaker: {
    maxFailures: number;
    cooldownMs: number;
  };
  cookieSync: {
    intervalMs: number;
  };
}

export interface EscalationResult {
  success: boolean;
  previousBackend: BrowserBackend;
  newBackend: BrowserBackend;
  cookiesSynced: boolean;
  url?: string;
}
