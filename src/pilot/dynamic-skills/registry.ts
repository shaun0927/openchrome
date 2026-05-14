/**
 * Ephemeral per-process registry of synthesized tools (issue #889).
 *
 * The registry tracks which synthesized tool names are currently
 * registered with the MCP server and the metadata needed to deregister
 * them on session teardown. State is process-local — no cross-process
 * sharing, no persistence. The MCP server itself owns the canonical
 * tool list; this registry is a side index that the dynamic-skills
 * bootstrap consults when deciding whether to call `registerTool` or
 * skip a duplicate.
 *
 * Concurrency model: the registry is invoked exclusively from the
 * dynamic-skills event handlers (`index.ts`), which run on the Node
 * event loop in a single fiber. No locking is required.
 *
 * Per portability-harness P2: when the dynamic-skills family flag is
 * off, this module compiles but `register()` is never called, so the
 * map remains empty for the lifetime of the process.
 */

import type { MCPToolDefinition } from '../../types/mcp';

/**
 * Per-entry metadata kept alongside the registered tool name. We
 * persist just enough state to (a) decide whether a fresh navigation
 * has already produced this exact synthesis (idempotency), and (b)
 * present an audit-friendly snapshot of what is currently registered.
 */
export interface RegistryEntry {
  /** The synthesized tool name (`skill_<domain-slug>__<skill-slug>`). */
  readonly name: string;
  /** The domain the synthesized tool is bound to. */
  readonly domain: string;
  /** The originating skill_id from SkillMemoryStore. */
  readonly skillId: string;
  /** The Outcome Contract id this skill enforces as a post-condition. */
  readonly contractId: string;
  /** The MCP tool definition we handed to `registerTool`. */
  readonly definition: MCPToolDefinition;
  /** Wall-clock ms epoch when the registration completed. */
  readonly registeredAt: number;
}

/**
 * Ephemeral name → entry map. Exposed as a class so tests can stand up
 * a fresh instance per scenario (the production process uses the
 * singleton exported via `getDynamicSkillsRegistry()`).
 */
export class DynamicSkillsRegistry {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  /**
   * Register a synthesized tool. If `name` is already registered, the
   * existing entry is replaced — re-recording a skill in the same
   * process is expected to refresh the registration. Returns true if
   * the registration was a fresh insert, false if it replaced an
   * existing entry of the same name.
   */
  register(entry: RegistryEntry): boolean {
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error('DynamicSkillsRegistry.register: entry.name must be a non-empty string');
    }
    if (typeof entry.domain !== 'string' || entry.domain.length === 0) {
      throw new Error('DynamicSkillsRegistry.register: entry.domain must be a non-empty string');
    }
    if (typeof entry.skillId !== 'string' || entry.skillId.length === 0) {
      throw new Error('DynamicSkillsRegistry.register: entry.skillId must be a non-empty string');
    }
    const fresh = !this.entries.has(entry.name);
    this.entries.set(entry.name, entry);
    return fresh;
  }

  /**
   * Remove a single synthesized tool by name. Returns true if a
   * matching entry existed and was deleted, false otherwise.
   */
  deregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /** Look up the entry for a given synthesized tool name. */
  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name);
  }

  /** Returns true iff a synthesized tool with this name is registered. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** List all currently-registered synthesized tools, declaration-order. */
  list(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Drop every entry. Called on session teardown and from test setup.
   * Returns the count of entries that existed before clearing — the
   * caller uses this to decide whether emitting a `list_changed`
   * notification is meaningful.
   */
  clearAll(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  /** Current number of registered synthesized tools. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Process-singleton registry. The pilot bootstrap registers exactly
 * one of these per process so multiple MCPServer instances (e.g. tests
 * spinning up several servers in parallel) do not contend over a
 * shared name space.
 */
let singleton: DynamicSkillsRegistry | undefined;

export function getDynamicSkillsRegistry(): DynamicSkillsRegistry {
  if (singleton === undefined) {
    singleton = new DynamicSkillsRegistry();
  }
  return singleton;
}

/**
 * Test-only hook. Disposes the existing singleton so the next call to
 * `getDynamicSkillsRegistry()` returns a fresh instance. Exposed with a
 * leading underscore so production callers do not depend on it.
 */
export function _resetDynamicSkillsRegistryForTesting(): void {
  singleton = undefined;
}
