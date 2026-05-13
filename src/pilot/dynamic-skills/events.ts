/**
 * Process-local EventEmitter for dynamic skill→tool synthesis (issue #889).
 *
 * Core tools (`navigate`, `oc_skill_record`) emit lightweight events on
 * this singleton when the dynamic-skills pilot family is active. The
 * synthesizer (`src/pilot/dynamic-skills/index.ts`) subscribes at pilot
 * bootstrap. Core code does NOT import the synthesizer directly — it
 * only reaches this neutral emitter, which lives under `src/pilot/` so
 * that dep-cruiser's `core-must-not-import-pilot` rule remains a single
 * straight-line invariant.
 *
 * The emitter is intentionally a *typed* surface: every emit/listen
 * shape is enumerated in `DynamicSkillEventMap`. We re-export
 * `dynamicSkillEvents` as a singleton so cross-module wiring uses
 * referential equality regardless of how it was imported (esm vs cjs).
 *
 * Per the portability-harness contract:
 *   - P2 strict: this module compiles into the core build (it lives in
 *     `src/pilot/dynamic-skills/`, which is a pilot tree, but the
 *     references from core code reach it through `import()` inside the
 *     navigate / skill-record success path only when
 *     `isDynamicSkillsEnabled()` returns true). When the flag is off,
 *     no listener is registered and the emit() calls early-return.
 *   - P3 strict: no third-party transport. Node's built-in `events`
 *     EventEmitter is used unchanged.
 */

import { EventEmitter } from 'node:events';

/** Payload for `domain_entered` — fires after a successful navigation. */
export interface DomainEnteredEvent {
  /** Hostname of the page that the tab now sits on (lowercase). */
  readonly domain: string;
  /** Full URL of the navigated page, for audit context. */
  readonly url: string;
  /** Session id the navigation belongs to. */
  readonly sessionId: string;
}

/** Payload for `skill_recorded` — fires after `oc_skill_record` succeeds. */
export interface SkillRecordedEvent {
  /** Domain the skill is bound to (matches `SkillRecord.domain`). */
  readonly domain: string;
  /** Stored `skill_id` returned by `SkillMemoryStore.record()`. */
  readonly skillId: string;
}

/**
 * Strict event map. Add a new entry here when introducing a new event;
 * the singleton getter below is generic over this map.
 */
export interface DynamicSkillEventMap {
  domain_entered: [DomainEnteredEvent];
  skill_recorded: [SkillRecordedEvent];
}

/**
 * Typed wrapper around Node's `EventEmitter`. The underlying instance is
 * an unmodified `EventEmitter` — we only narrow the surface so callers
 * cannot accidentally emit untyped events.
 */
export interface TypedDynamicSkillEmitter {
  emit<E extends keyof DynamicSkillEventMap>(
    event: E,
    ...args: DynamicSkillEventMap[E]
  ): boolean;
  on<E extends keyof DynamicSkillEventMap>(
    event: E,
    listener: (...args: DynamicSkillEventMap[E]) => void,
  ): TypedDynamicSkillEmitter;
  off<E extends keyof DynamicSkillEventMap>(
    event: E,
    listener: (...args: DynamicSkillEventMap[E]) => void,
  ): TypedDynamicSkillEmitter;
  removeAllListeners<E extends keyof DynamicSkillEventMap>(event?: E): TypedDynamicSkillEmitter;
}

const emitter = new EventEmitter() as unknown as TypedDynamicSkillEmitter;

/**
 * Process-singleton event emitter. Exported by value so that
 * `import { dynamicSkillEvents } from '...'` always returns the same
 * instance regardless of module-system quirks.
 */
export const dynamicSkillEvents: TypedDynamicSkillEmitter = emitter;
