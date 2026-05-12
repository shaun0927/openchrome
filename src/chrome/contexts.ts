/**
 * NamedContextRegistry — in-memory registry of named puppeteer-core
 * BrowserContexts keyed by user-supplied name (#848).
 *
 * Adopted from chrome-devtools-mcp's `new_page({isolatedContext})` pattern:
 * a single Chrome process serves N named BrowserContexts that each have
 * isolated cookies, localStorage, sessionStorage, and HTTP cache.
 *
 * The pinned puppeteer-core (rebrowser-puppeteer-core@23.10.3) exposes
 * `Browser.createBrowserContext()` (verified at
 * node_modules/puppeteer-core/lib/types.d.ts:221). The older
 * `createIncognitoBrowserContext()` spelling is NOT used.
 *
 * Names must match `[A-Za-z0-9_-]{1,64}` and are case-sensitive. The
 * reserved name `default` always refers to the Chrome process's default
 * context (never created here).
 *
 * Lifecycle: a context is destroyed when its tab count drops to zero AND
 * no `oc_session_resume` token still references it. Until both conditions
 * hold, the BrowserContext is retained.
 *
 * In-memory only in v1; persistence across openchrome restarts is tracked
 * separately (see issue #848 "Out of scope").
 */

import type { Browser, BrowserContext } from 'puppeteer-core';

/**
 * Reserved context name — refers to Chrome's default BrowserContext.
 * The registry never mints a BrowserContext for this name.
 */
export const DEFAULT_CONTEXT_NAME = 'default';

/**
 * Validation pattern for user-supplied context names.
 * Case-sensitive; 1–64 chars; alphanumeric / underscore / hyphen.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidContextNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid context name "${name}". Names must match [A-Za-z0-9_-]{1,64} and not equal "${DEFAULT_CONTEXT_NAME}".`,
    );
    this.name = 'InvalidContextNameError';
  }
}

export class ContextHasActiveTabsError extends Error {
  constructor(name: string, tabs: number) {
    super(`Context "${name}" still has ${tabs} active tab(s); pass {force: true} to close anyway.`);
    this.name = 'ContextHasActiveTabsError';
  }
}

/** Public read-only view used by listing tools (e.g. tabs_context). */
export interface NamedContextInfo {
  name: string;
  createdAt: number;
  /** Number of currently-open tabs charged to this context. */
  tabs: number;
}

export interface NamedContextRegistry {
  /**
   * Returns the existing BrowserContext for `name` or creates a new one
   * inside `browser`. Reserved names (e.g. `default`) and malformed names
   * throw {@link InvalidContextNameError}.
   */
  getOrCreate(browser: Browser, name: string): Promise<BrowserContext>;

  /** Lists active named contexts (excluding the default). */
  list(): NamedContextInfo[];

  /**
   * Closes a context and all its tabs.
   * Rejects with {@link ContextHasActiveTabsError} when tabs > 0 and
   * `force` is not set.
   */
  close(name: string, opts?: { force?: boolean }): Promise<void>;
}

/** Internal record kept per named context. */
interface ContextEntry {
  name: string;
  context: BrowserContext;
  createdAt: number;
  /** Tab counter; incremented on tabs_create, decremented on close. */
  tabCount: number;
  /** Resume-token reference counter (oc_session_resume). */
  resumeRefs: number;
}

/**
 * Validates and normalizes a context name. Returns the input unchanged on
 * success or throws {@link InvalidContextNameError} otherwise. The reserved
 * `default` name is rejected — the default context is implicit, not minted
 * through this registry.
 */
export function assertValidContextName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name === DEFAULT_CONTEXT_NAME) {
    throw new InvalidContextNameError(name);
  }
}

/**
 * Default in-memory implementation. One instance per openchrome process.
 *
 * The registry is browser-agnostic at construction: the same registry can
 * be reused across reconnects because the puppeteer `Browser` is supplied
 * to {@link getOrCreate} on each call. If the browser's context is no
 * longer usable (e.g. Chrome restarted), the entry is dropped and a fresh
 * one is minted on the next request.
 */
export class DefaultNamedContextRegistry implements NamedContextRegistry {
  private readonly entries = new Map<string, ContextEntry>();
  /** Coalesce concurrent creation requests for the same name. */
  private readonly inflight = new Map<string, Promise<BrowserContext>>();

  async getOrCreate(browser: Browser, name: string): Promise<BrowserContext> {
    assertValidContextName(name);

    const existing = this.entries.get(name);
    if (existing && this.isContextLive(browser, existing.context)) {
      return existing.context;
    }

    // Stale (Chrome restarted) — drop the entry and fall through.
    if (existing) {
      this.entries.delete(name);
    }

    const inflight = this.inflight.get(name);
    if (inflight) return inflight;

    const promise = (async () => {
      const context = await browser.createBrowserContext();
      this.entries.set(name, {
        name,
        context,
        createdAt: Date.now(),
        tabCount: 0,
        resumeRefs: 0,
      });
      return context;
    })().finally(() => {
      this.inflight.delete(name);
    });

    this.inflight.set(name, promise);
    return promise;
  }

  list(): NamedContextInfo[] {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.name,
      createdAt: e.createdAt,
      tabs: e.tabCount,
    }));
  }

  async close(name: string, opts?: { force?: boolean }): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;

    if (entry.tabCount > 0 && !opts?.force) {
      throw new ContextHasActiveTabsError(name, entry.tabCount);
    }

    this.entries.delete(name);
    try {
      await entry.context.close();
    } catch {
      // Already closed or Chrome gone — nothing actionable.
    }
  }

  /** Increments the tab count for `name`. No-op if name unknown. */
  incrementTabCount(name: string): void {
    const entry = this.entries.get(name);
    if (entry) entry.tabCount++;
  }

  /**
   * Decrements the tab count for `name` and, when it reaches zero with no
   * outstanding resume references, destroys the underlying BrowserContext.
   * Returns true when the context was destroyed.
   */
  async decrementTabCount(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (entry.tabCount > 0) entry.tabCount--;
    return this.maybeDestroy(entry);
  }

  /** Adds a resume-token reference, preventing auto-destroy. */
  addResumeRef(name: string): void {
    const entry = this.entries.get(name);
    if (entry) entry.resumeRefs++;
  }

  /**
   * Releases a resume-token reference. May trigger auto-destroy when the
   * referenced context has no tabs left.
   */
  async releaseResumeRef(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (entry.resumeRefs > 0) entry.resumeRefs--;
    return this.maybeDestroy(entry);
  }

  /** Test/diagnostic accessor. */
  getInfo(name: string): NamedContextInfo | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return { name: entry.name, createdAt: entry.createdAt, tabs: entry.tabCount };
  }

  /** Test/diagnostic accessor. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Test helper — drops in-memory state without closing contexts. */
  resetForTests(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  private async maybeDestroy(entry: ContextEntry): Promise<boolean> {
    if (entry.tabCount > 0 || entry.resumeRefs > 0) return false;
    if (!this.entries.has(entry.name)) return false;
    this.entries.delete(entry.name);
    try {
      await entry.context.close();
    } catch {
      // Best-effort: Chrome may have already collected it.
    }
    return true;
  }

  private isContextLive(browser: Browser, context: BrowserContext): boolean {
    // puppeteer keeps a list of contexts on the browser; if our entry is
    // missing the Chrome connection has rotated underneath us.
    try {
      const known = browser.browserContexts();
      return known.includes(context);
    } catch {
      return false;
    }
  }
}

let singleton: DefaultNamedContextRegistry | null = null;

/** Process-wide singleton accessor used by tools / SessionManager. */
export function getNamedContextRegistry(): DefaultNamedContextRegistry {
  if (!singleton) {
    singleton = new DefaultNamedContextRegistry();
  }
  return singleton;
}

/** Test-only: replace or clear the singleton. */
export function _setNamedContextRegistryForTests(
  registry: DefaultNamedContextRegistry | null,
): void {
  singleton = registry;
}
