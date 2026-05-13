/**
 * Shared structured failure categories for OpenChrome runtime/tool failures.
 *
 * These categories are intentionally deterministic and dependency-free so they
 * can be attached to tool responses, run events, evidence bundles, and future
 * recovery policies without changing existing tool behavior.
 */
export const FAILURE_CATEGORIES = [
  'STALE_REF',
  'ELEMENT_NOT_FOUND',
  'NAVIGATION_TIMEOUT',
  'TAB_UNHEALTHY',
  'BROWSER_CRASH',
  'CONNECTION_LOST',
  'AUTH_REQUIRED',
  'CAPTCHA_OR_WAF',
  'NO_PROGRESS',
  'MAX_STEPS_EXCEEDED',
  'POSTCONDITION_FAILED',
  'LLM_WANDERING',
  'UNKNOWN',
] as const;

export type FailureCategory = typeof FAILURE_CATEGORIES[number];

export interface FailureClassification {
  category: FailureCategory;
  /** 0..1 deterministic confidence score. */
  confidence: number;
  /** Short human-readable explanation suitable for logs/metadata. */
  reason: string;
}
