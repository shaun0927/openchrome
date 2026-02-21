/**
 * DomainMemory — Cross-project domain knowledge persistence.
 *
 * MCP-aligned: server stores and retrieves, agent decides what to store.
 * Confidence: +0.1 on success, -0.2 on failure (asymmetric — broken selectors are dangerous).
 * Storage: ~/.claude-chrome-parallel/memory/domain-knowledge.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DomainKnowledge {
  id: string;
  domain: string;
  key: string;
  value: string;
  confidence: number;
  updatedAt: number;
}

interface KnowledgeStore {
  version: number;
  entries: DomainKnowledge[];
  updatedAt: number;
}

export class DomainMemory {
  private entries: DomainKnowledge[] = [];
  private filePath: string | null = null;
  private dirty = false;

  static readonly MAX_ENTRIES = 200;
  static readonly STALE_DAYS = 30;
  static readonly MIN_CONFIDENCE = 0.2;
  static readonly STALE_CONFIDENCE = 0.5;
  static readonly CONFIDENCE_BOOST = 0.1;
  static readonly CONFIDENCE_PENALTY = 0.2;
  static readonly DEFAULT_CONFIDENCE = 0.5;

  /**
   * Enable persistence and run startup compression.
   */
  enablePersistence(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      this.filePath = path.join(dirPath, 'domain-knowledge.json');
      this.load();
      this.compress();
    } catch {
      // Best-effort
    }
  }

  /**
   * CE: Write — Record domain knowledge. Agent calls this after successful operations.
   * If an entry with the same domain+key exists, update its value and reset confidence.
   */
  record(domain: string, key: string, value: string): DomainKnowledge {
    const existing = this.entries.find(
      (e) => e.domain === domain && e.key === key
    );

    if (existing) {
      existing.value = value;
      existing.confidence = Math.max(existing.confidence, DomainMemory.DEFAULT_CONFIDENCE);
      existing.updatedAt = Date.now();
      this.dirty = true;
      this.save();
      return existing;
    }

    const entry: DomainKnowledge = {
      id: `dk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      domain,
      key,
      value,
      confidence: DomainMemory.DEFAULT_CONFIDENCE,
      updatedAt: Date.now(),
    };

    this.entries.push(entry);
    this.dirty = true;
    this.save();
    return entry;
  }

  /**
   * CE: Select — Returns entries for domain, sorted by confidence desc.
   * Optionally filter by key prefix.
   */
  query(domain: string, key?: string): DomainKnowledge[] {
    let results = this.entries.filter((e) => e.domain === domain);

    if (key) {
      results = results.filter((e) => e.key === key || e.key.startsWith(key + ':'));
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Validation — Agent calls after using knowledge (success/fail).
   * Returns updated entry, or null if not found / pruned.
   */
  validate(id: string, success: boolean): DomainKnowledge | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;

    if (success) {
      entry.confidence = Math.min(1.0, entry.confidence + DomainMemory.CONFIDENCE_BOOST);
    } else {
      entry.confidence = Math.max(0.0, entry.confidence - DomainMemory.CONFIDENCE_PENALTY);
    }
    entry.updatedAt = Date.now();
    this.dirty = true;

    // Prune if confidence dropped below threshold
    if (entry.confidence < DomainMemory.MIN_CONFIDENCE) {
      this.entries = this.entries.filter((e) => e.id !== id);
      this.save();
      return null;
    }

    this.save();
    return entry;
  }

  /**
   * CE: Compress — Prune stale/invalid entries on startup.
   * 1. confidence < 0.2 → remove
   * 2. updatedAt > 30 days AND confidence < 0.5 → remove
   * 3. count > 200 → remove lowest-confidence
   */
  compress(): { pruned: number; remaining: number } {
    const before = this.entries.length;
    const now = Date.now();
    const staleCutoff = now - DomainMemory.STALE_DAYS * 24 * 60 * 60 * 1000;

    // Rule 1 & 2: Remove low-confidence and stale entries
    this.entries = this.entries.filter((e) => {
      if (e.confidence < DomainMemory.MIN_CONFIDENCE) return false;
      if (e.updatedAt < staleCutoff && e.confidence < DomainMemory.STALE_CONFIDENCE) return false;
      return true;
    });

    // Rule 3: Cap at MAX_ENTRIES, keep highest confidence
    if (this.entries.length > DomainMemory.MAX_ENTRIES) {
      this.entries.sort((a, b) => b.confidence - a.confidence);
      this.entries = this.entries.slice(0, DomainMemory.MAX_ENTRIES);
    }

    const pruned = before - this.entries.length;
    if (pruned > 0) {
      this.dirty = true;
      this.save();
      console.error(`[DomainMemory] Compressed: pruned ${pruned}, remaining ${this.entries.length}`);
    }

    return { pruned, remaining: this.entries.length };
  }

  /**
   * Get all entries (for testing/inspection).
   */
  getAll(): DomainKnowledge[] {
    return this.entries;
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const store: KnowledgeStore = JSON.parse(data);
      this.entries = store.entries || [];
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    if (!this.filePath || !this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const store: KnowledgeStore = {
        version: 1,
        entries: this.entries,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
      this.dirty = false;
    } catch {
      // Best-effort
    }
  }
}

// Singleton
let instance: DomainMemory | null = null;

export function getDomainMemory(): DomainMemory {
  if (!instance) {
    instance = new DomainMemory();
    const homedir = os.homedir();
    const memoryDir = path.join(homedir, '.claude-chrome-parallel', 'memory');
    instance.enablePersistence(memoryDir);
  }
  return instance;
}

/**
 * Extract domain from a URL string. Returns empty string on failure.
 */
export function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
