/**
 * Outcome Contract Template types — A2-PR1.
 *
 * A *template* is a portable, importable data definition that bundles a
 * named target schema with an optional pre-built assertion tree. Templates
 * are the canonical way to declare "what counts as success" for a recurring
 * extraction task (page meta, SPA hydration, link graph, authenticated
 * profile fields).
 *
 * This module ships the **type system and a registry only**. Concrete
 * templates land in follow-up PRs (A2-PR2..5) and import this surface.
 *
 * Design rules (per #1359):
 *
 *  - **Data, not behavior** (P4 facts before decisions): a template is a
 *    JSON-serializable record. No code is bundled. The runtime that consumes
 *    a template (oc_assert, extract_data) supplies the behavior.
 *  - **Host owns selection** (P2 harness, not agent): we never infer which
 *    template applies from a free-text instruction. The host names the
 *    template by `id` (and optional `version`).
 *  - **Immutable contract identity**: a template's `(id, version)` pair is
 *    its eternal name. Renaming requires bumping `version`. Old versions
 *    must remain usable for replay and benchmarking reproducibility.
 *  - **Portability**: every template must be expressible as plain JSON so
 *    it can travel through MCP tool input, evidence bundles, and traces
 *    without code-mobility tricks.
 */

import type { Assertion } from '../types';

/**
 * Target schema descriptor that a template advertises. Intentionally a
 * loose `unknown` field on the data layer — downstream PRs (B1-PR2 and
 * later) will narrow this to the deterministic schema-diff shape. Keeping
 * it `unknown` in this PR avoids coupling A2-PR1 to schema-diff and lets
 * each thread land independently.
 */
export interface OutcomeTemplateSchema {
  /** Format identifier so the consumer knows which validator to invoke. */
  format: string;
  /** Format-specific definition. Opaque to the registry. */
  definition: unknown;
}

/**
 * The canonical template record. Plain data; no methods.
 *
 * Naming convention: `id` should be a dotted kebab-case namespace such as
 * `public-web.page-meta` so a future ID collision across template families
 * surfaces visually. The registry enforces uniqueness on `(id, version)`.
 */
export interface OutcomeTemplate {
  /** Stable kebab-case identifier. Required. */
  id: string;
  /**
   * Monotonic integer version. Required. Two templates may share an `id`
   * if their versions differ; the registry stores them side by side.
   */
  version: number;
  /** Human-readable summary. Required so traces stay legible. */
  description: string;
  /**
   * Optional schema this template targets. Consumed by extract_data,
   * oc_evidence_bundle's schema-diff hook, and benchmark harnesses.
   */
  targetSchema?: OutcomeTemplateSchema;
  /**
   * Optional pre-built assertion tree, evaluated by oc_assert and the
   * contract runtime. Either or both of {targetSchema, assertions} may
   * be present; a template with neither is legal but inert.
   */
  assertions?: Assertion;
  /** Free-form tags for catalog search. Order is not significant. */
  tags?: readonly string[];
}

/** Error thrown when the registry is asked to register a duplicate key. */
export class DuplicateTemplateError extends Error {
  constructor(public readonly id: string, public readonly version: number) {
    super(`outcome template already registered: ${id}@${version}`);
    this.name = 'DuplicateTemplateError';
  }
}

/** Error thrown when validation rejects a template record. */
export class InvalidTemplateError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid outcome template: ${reason}`);
    this.name = 'InvalidTemplateError';
  }
}
