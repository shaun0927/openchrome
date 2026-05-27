/**
 * Outcome Contract Template Registry — A2-PR1.
 *
 * In-memory, deterministic lookup table for {@link OutcomeTemplate}
 * records. The registry is the single source of truth for which template
 * IDs are known and which `version` is the default for unversioned
 * lookups.
 *
 * Why a class instead of a global mutable object: tests need isolation
 * and host-integration code may want per-tenant registries. The registry
 * is small and explicit — instantiate one, register your templates,
 * pass it where it's needed.
 *
 * Concrete public-web templates (page-meta, spa-hydrated, link-graph,
 * authenticated-fields) ship in follow-up PRs A2-PR2..5.
 */

import {
  DuplicateTemplateError,
  InvalidTemplateError,
  OutcomeTemplate,
} from './types';

/** Result of a successful `list()` call — a frozen view of the registry. */
export interface TemplateListing {
  /** Template id. */
  id: string;
  /** Available versions, sorted ascending. */
  versions: number[];
  /** Latest registered version. Identical to `Math.max(...versions)`. */
  latest: number;
  /** Description of the latest version. */
  description: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

function validateTemplate(template: OutcomeTemplate): void {
  if (typeof template.id !== 'string' || template.id.length === 0) {
    throw new InvalidTemplateError('id must be a non-empty string');
  }
  if (!ID_PATTERN.test(template.id)) {
    throw new InvalidTemplateError(
      `id "${template.id}" must be dotted kebab-case (a-z0-9 separated by '-' or '.')`,
    );
  }
  if (
    typeof template.version !== 'number' ||
    !Number.isInteger(template.version) ||
    template.version < 1
  ) {
    throw new InvalidTemplateError('version must be a positive integer');
  }
  if (typeof template.description !== 'string' || template.description.length === 0) {
    throw new InvalidTemplateError('description must be a non-empty string');
  }
}

export class TemplateRegistry {
  /** id → version → template. Inner map preserves insertion order. */
  private readonly byId = new Map<string, Map<number, OutcomeTemplate>>();

  /**
   * Register a template. Rejects duplicate `(id, version)` pairs with
   * {@link DuplicateTemplateError} and shape violations with
   * {@link InvalidTemplateError}.
   */
  register(template: OutcomeTemplate): void {
    validateTemplate(template);
    let versions = this.byId.get(template.id);
    if (!versions) {
      versions = new Map();
      this.byId.set(template.id, versions);
    }
    if (versions.has(template.version)) {
      throw new DuplicateTemplateError(template.id, template.version);
    }
    versions.set(template.version, Object.freeze({ ...template }) as OutcomeTemplate);
  }

  /**
   * Resolve a template. With no `version`, returns the highest registered
   * version. Returns `undefined` if either the id is unknown or the
   * specific version is unknown.
   */
  get(id: string, version?: number): OutcomeTemplate | undefined {
    const versions = this.byId.get(id);
    if (!versions) return undefined;
    if (version === undefined) {
      let best: OutcomeTemplate | undefined;
      let bestVersion = -Infinity;
      for (const [v, t] of versions) {
        if (v > bestVersion) {
          bestVersion = v;
          best = t;
        }
      }
      return best;
    }
    return versions.get(version);
  }

  /** Whether a template `(id, version?)` is registered. */
  has(id: string, version?: number): boolean {
    return this.get(id, version) !== undefined;
  }

  /**
   * Remove one template. With no `version`, removes the id and every
   * version registered under it. Returns the count removed.
   */
  unregister(id: string, version?: number): number {
    const versions = this.byId.get(id);
    if (!versions) return 0;
    if (version === undefined) {
      const count = versions.size;
      this.byId.delete(id);
      return count;
    }
    const removed = versions.delete(version);
    if (versions.size === 0) this.byId.delete(id);
    return removed ? 1 : 0;
  }

  /**
   * Enumerate every registered id with its versions. Output is sorted by
   * id for determinism (helpful in trace bundles and test snapshots).
   */
  list(): TemplateListing[] {
    const ids = [...this.byId.keys()].sort();
    return ids.map(id => {
      const versions = [...this.byId.get(id)!.keys()].sort((a, b) => a - b);
      const latest = versions[versions.length - 1];
      const latestTemplate = this.byId.get(id)!.get(latest)!;
      return {
        id,
        versions,
        latest,
        description: latestTemplate.description,
      };
    });
  }

  /** Total number of registered `(id, version)` pairs. */
  size(): number {
    let n = 0;
    for (const versions of this.byId.values()) n += versions.size;
    return n;
  }
}
