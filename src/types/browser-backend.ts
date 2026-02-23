export enum BrowserBackend {
  CHROME = 'chrome',
  LIGHTPANDA = 'lightpanda',
}

export type ToolRouting = 'chrome-only' | 'prefer-lightpanda';

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
