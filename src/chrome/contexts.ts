/**
 * NamedContextRegistry — in-memory registry of named puppeteer-core
 * BrowserContexts keyed by (Browser instance, user-supplied name) (#848).
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
 * Registry keying — Codex P1 follow-up:
 * The registry is keyed by `(browserInstanceId, name)`, not by name alone.
 * `browserInstanceId` is minted on first sight of each `Browser` via an
 * internal `WeakMap<Browser, string>`. This prevents a same-named
 * isolatedContext on a different Chrome instance (e.g., a per-profile
 * worker on another port) from overwriting an existing entry and later
 * tearing down the wrong BrowserContext when tab counts roll over.
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

/** Separator used to build the internal composite key. */
const KEY_SEP = '\x00';

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
   * Returns the existing BrowserContext for `(browser, name)` or creates a
   * new one inside `browser`. Reserved names (e.g. `default`) and
   * malformed names throw {@link InvalidContextNameError}.
   */
  getOrCreate(browser: Browser, name: string): Promise<BrowserContext>;

  /**
   * Lists active named contexts. When `browser` is provided, restricts the
   * listing to entries owned by that browser; otherwise returns every
   * tracked entry across all browsers (de-duplicated by composite key).
   */
  list(browser?: Browser): NamedContextInfo[];

  /**
   * Closes a context and all its tabs.
   * Rejects with {@link ContextHasActiveTabsError} when tabs > 0 and
   * `force` is not set.
   */
  close(browser: Browser, name: string, opts?: { force?: boolean }): Promise<void>;
}

/** Internal record kept per named context. */
interface ContextEntry {
  /** Stable identifier of the owning browser (minted by the registry). */
  browserInstanceId: string;
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
  /** Coalesce concurrent creation requests for the same composite key. */
  private readonly inflight = new Map<string, Promise<BrowserContext>>();
  /** Stable identifier per Browser, minted lazily on first access. */
  private readonly browserIds = new WeakMap<Browser, string>();
  private nextBrowserSeq = 1;

  /** Returns the stable identifier for `browser`, minting one if needed. */
  private browserIdFor(browser: Browser): string {
    let id = this.browserIds.get(browser);
    if (id === undefined) {
      id = `b${this.nextBrowserSeq++}`;
      this.browserIds.set(browser, id);
    }
    return id;
  }

  /** Build the composite `entries` / `inflight` key. */
  private keyOf(browser: Browser, name: string): string {
    return `${this.browserIdFor(browser)}${KEY_SEP}${name}`;
  }

  async getOrCreate(browser: Browser, name: string): Promise<BrowserContext> {
    assertValidContextName(name);

    const key = this.keyOf(browser, name);
    const existing = this.entries.get(key);
    if (existing && this.isContextLive(browser, existing.context)) {
      return existing.context;
    }

    // Stale (Chrome restarted) — drop the entry and fall through.
    if (existing) {
      this.entries.delete(key);
    }

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const browserInstanceId = this.browserIdFor(browser);
    const promise = (async () => {
      const context = await browser.createBrowserContext();
      this.entries.set(key, {
        browserInstanceId,
        name,
        context,
        createdAt: Date.now(),
        tabCount: 0,
        resumeRefs: 0,
      });
      return context;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  list(browser?: Browser): NamedContextInfo[] {
    const filterId = browser ? this.browserIdFor(browser) : undefined;
    const out: NamedContextInfo[] = [];
    for (const e of this.entries.values()) {
      if (filterId !== undefined && e.browserInstanceId !== filterId) continue;
      out.push({ name: e.name, createdAt: e.createdAt, tabs: e.tabCount });
    }
    return out;
  }

  async close(browser: Browser, name: string, opts?: { force?: boolean }): Promise<void> {
    const key = this.keyOf(browser, name);
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.tabCount > 0 && !opts?.force) {
      throw new ContextHasActiveTabsError(name, entry.tabCount);
    }

    this.entries.delete(key);
    try {
      await entry.context.close();
    } catch {
      // Already closed or Chrome gone — nothing actionable.
    }
  }

  /** Increments the tab count for `(browser, name)`. No-op if unknown. */
  incrementTabCount(browser: Browser, name: string): void {
    const entry = this.entries.get(this.keyOf(browser, name));
    if (entry) entry.tabCount++;
  }

  /**
   * Decrements the tab count for `(browser, name)` and, when it reaches
   * zero with no outstanding resume references, destroys the underlying
   * BrowserContext. Returns true when the context was destroyed.
   */
  async decrementTabCount(browser: Browser, name: string): Promise<boolean> {
    const key = this.keyOf(browser, name);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.tabCount > 0) entry.tabCount--;
    return this.maybeDestroy(key, entry);
  }

  /** Adds a resume-token reference, preventing auto-destroy. */
  addResumeRef(browser: Browser, name: string): void {
    const entry = this.entries.get(this.keyOf(browser, name));
    if (entry) entry.resumeRefs++;
  }

  /**
   * Releases a resume-token reference. May trigger auto-destroy when the
   * referenced context has no tabs left.
   */
  async releaseResumeRef(browser: Browser, name: string): Promise<boolean> {
    const key = this.keyOf(browser, name);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.resumeRefs > 0) entry.resumeRefs--;
    return this.maybeDestroy(key, entry);
  }

  /** Test/diagnostic accessor. */
  getInfo(browser: Browser, name: string): NamedContextInfo | undefined {
    const entry = this.entries.get(this.keyOf(browser, name));
    if (!entry) return undefined;
    return { name: entry.name, createdAt: entry.createdAt, tabs: entry.tabCount };
  }

  /** Test/diagnostic accessor. */
  has(browser: Browser, name: string): boolean {
    return this.entries.has(this.keyOf(browser, name));
  }

  /** Test helper — drops in-memory state without closing contexts. */
  resetForTests(): void {
    this.entries.clear();
    this.inflight.clear();
    this.nextBrowserSeq = 1;
    // WeakMap cannot be cleared directly; allow GC to reclaim entries.
  }

  private async maybeDestroy(key: string, entry: ContextEntry): Promise<boolean> {
    if (entry.tabCount > 0 || entry.resumeRefs > 0) return false;
    if (!this.entries.has(key)) return false;
    this.entries.delete(key);
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
