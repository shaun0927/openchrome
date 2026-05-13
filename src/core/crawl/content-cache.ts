import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CrawlCacheMode = 'disabled' | 'enabled' | 'read_only' | 'write_only' | 'bypass';
export type CrawlCacheScope = 'public' | 'session';
export type CrawlCacheStatus = 'disabled' | 'hit' | 'miss' | 'stale' | 'write_only' | 'bypass';

export interface CrawlCacheMetadata {
  status: CrawlCacheStatus;
  key?: string;
  scope?: CrawlCacheScope;
  hit?: boolean;
  write?: 'stored' | 'skipped' | 'disabled';
  write_skipped_reason?: string;
  createdAt?: number;
  content_length?: number;
}

export interface CrawlCacheKeyInput {
  url: string;
  finalUrl?: string;
  outputFormat: string;
  engine?: string;
  cacheScope: CrawlCacheScope;
  sessionFingerprint?: string;
  dimensions?: Record<string, unknown>;
}

export interface CrawlCacheEntry<TPage extends { url: string; title: string; content: string }> {
  schema_version: 1;
  createdAt: number;
  sourceUrl: string;
  finalUrl: string;
  contentLength: number;
  key: string;
  page: TPage;
  links: string[];
}

export interface CrawlContentCacheOptions {
  rootDir?: string;
  now?: () => number;
  maxEntries?: number;
}

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 500;
const SENSITIVE_PATH = /\b(account|dashboard|billing|admin|settings|checkout|cart|profile|login|signin|sign-in)\b/i;
const SENSITIVE_CONTENT = /<input\b[^>]*(type=["']?password|name=["']?(password|token|secret|credential))|\b(password|token|secret|api[_-]?key)\s*[:=]/i;

export class CrawlContentCache<TPage extends { url: string; title: string; content: string }> {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: CrawlContentCacheOptions = {}) {
    this.rootDir = options.rootDir ?? defaultCrawlCacheRootDir();
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  key(input: CrawlCacheKeyInput): string {
    const normalized = {
      schema_version: SCHEMA_VERSION,
      url: normalizeUrlForKey(input.finalUrl ?? input.url),
      outputFormat: input.outputFormat,
      engine: input.engine ?? 'default',
      cacheScope: input.cacheScope,
      sessionFingerprint: input.cacheScope === 'session' ? hashText(input.sessionFingerprint ?? 'default') : undefined,
      dimensions: sortKeys(input.dimensions ?? {}),
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  read(key: string, ttlMs?: number): { entry: CrawlCacheEntry<TPage>; stale: boolean } | null {
    try {
      const raw = fs.readFileSync(this.filePath(key), 'utf8');
      const entry = JSON.parse(raw) as CrawlCacheEntry<TPage>;
      if (!entry || entry.schema_version !== SCHEMA_VERSION || entry.key !== key) return null;
      const stale = typeof ttlMs === 'number' && ttlMs >= 0 && this.now() - entry.createdAt > ttlMs;
      return { entry, stale };
    } catch {
      return null;
    }
  }

  write(input: {
    key: string;
    sourceUrl: string;
    finalUrl?: string;
    page: TPage;
    links?: string[];
    cacheScope: CrawlCacheScope;
  }): { stored: boolean; reason?: string; entry?: CrawlCacheEntry<TPage> } {
    const reason = publicWriteSkipReason(input.page, input.cacheScope);
    if (reason) return { stored: false, reason };

    const entry: CrawlCacheEntry<TPage> = {
      schema_version: SCHEMA_VERSION,
      createdAt: this.now(),
      sourceUrl: input.sourceUrl,
      finalUrl: input.finalUrl ?? input.page.url,
      contentLength: input.page.content.length,
      key: input.key,
      page: input.page,
      links: input.links ?? [],
    };
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      const file = this.filePath(input.key);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
      fs.renameSync(tmp, file);
      this.prune();
      return { stored: true, entry };
    } catch (err) {
      return { stored: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  metadata(status: CrawlCacheStatus, input: Partial<CrawlCacheMetadata> = {}): CrawlCacheMetadata {
    return { status, ...input };
  }

  private filePath(key: string): string {
    return path.join(this.rootDir, `${key}.json`);
  }

  private prune(): void {
    try {
      const entries = fs.readdirSync(this.rootDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({ file: path.join(this.rootDir, file), mtimeMs: fs.statSync(path.join(this.rootDir, file)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const entry of entries.slice(this.maxEntries)) {
        try { fs.unlinkSync(entry.file); } catch { /* best-effort cleanup */ }
      }
    } catch {
      // Best-effort pruning only.
    }
  }
}

export function parseCrawlCacheMode(value: unknown): CrawlCacheMode {
  if (value === undefined || value === null || value === '') return 'disabled';
  if (value === 'disabled' || value === 'enabled' || value === 'read_only' || value === 'write_only' || value === 'bypass') return value;
  throw new Error('cache_mode must be one of disabled, enabled, read_only, write_only, bypass');
}

export function parseCrawlCacheScope(value: unknown): CrawlCacheScope {
  if (value === undefined || value === null || value === '') return 'public';
  if (value === 'public' || value === 'session') return value;
  throw new Error('cache_scope must be one of public, session');
}

export function canReadCache(mode: CrawlCacheMode): boolean {
  return mode === 'enabled' || mode === 'read_only';
}

export function canWriteCache(mode: CrawlCacheMode): boolean {
  return mode === 'enabled' || mode === 'write_only' || mode === 'bypass';
}

export function defaultCrawlCacheRootDir(): string {
  return process.env.OPENCHROME_CRAWL_CACHE_DIR || path.join(process.env.OPENCHROME_HOME || os.homedir(), '.openchrome', 'cache', 'crawl');
}

function publicWriteSkipReason(page: { url: string; title: string; content: string }, scope: CrawlCacheScope): string | undefined {
  if (scope !== 'public') return undefined;
  try {
    const parsed = new URL(page.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'non-http-url';
    if (SENSITIVE_PATH.test(parsed.pathname) || SENSITIVE_PATH.test(page.title)) return 'auth-sensitive-url-or-title';
  } catch {
    return 'invalid-url';
  }
  if (SENSITIVE_CONTENT.test(page.content)) return 'auth-sensitive-content';
  return undefined;
}

function normalizeUrlForKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
