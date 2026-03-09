/**
 * SnapshotStore — LRU cache for DOM snapshots to enable delta responses.
 *
 * Caches the last serialized DOM output per (sessionId, tabId) and computes
 * line-based diffs on subsequent read_page calls.
 */

interface Snapshot {
  content: string; // serialized DOM text from serializeDOM()
  timestamp: number;
  pageUrl: string;
  lineCount: number;
}

interface DeltaResult {
  isDelta: true;
  totalNodes: number;
  changedNodes: number;
  changeRatio: number;
  added: string[]; // new lines not in previous
  removed: string[]; // lines in previous but not current
  changed: string[]; // lines that changed (same ref, different content)
  unchanged: number; // count of unchanged lines
  summary: string; // formatted delta text
}

interface FullResult {
  isDelta: false;
  reason:
    | 'first_call'
    | 'url_changed'
    | 'cache_expired'
    | 'high_change_ratio'
    | 'compression_none';
  content: string;
}

const MAX_ENTRIES = 50;
const TTL_MS = 30_000; // 30 seconds
const MAX_CHANGE_RATIO = 0.5; // if >50% changed, return full instead

export type DeltaOrFullResult = DeltaResult | FullResult;

export class SnapshotStore {
  private static instance: SnapshotStore;
  private cache: Map<string, Snapshot> = new Map();

  private constructor() {}

  static getInstance(): SnapshotStore {
    if (!SnapshotStore.instance) {
      SnapshotStore.instance = new SnapshotStore();
    }
    return SnapshotStore.instance;
  }

  private cacheKey(sessionId: string, tabId: string): string {
    return `${sessionId}:${tabId}`;
  }

  /**
   * Try to compute a delta against the cached snapshot.
   * Returns DeltaResult if cache hit and meaningful delta, FullResult otherwise.
   */
  computeDelta(
    sessionId: string,
    tabId: string,
    currentContent: string,
    currentUrl: string,
  ): DeltaOrFullResult {
    const key = this.cacheKey(sessionId, tabId);
    const previous = this.cache.get(key);
    const now = Date.now();

    // Always store current snapshot for next call
    this.store(key, currentContent, currentUrl, now);

    if (!previous) {
      return { isDelta: false, reason: 'first_call', content: currentContent };
    }

    if (now - previous.timestamp > TTL_MS) {
      return {
        isDelta: false,
        reason: 'cache_expired',
        content: currentContent,
      };
    }

    if (previous.pageUrl !== currentUrl) {
      return { isDelta: false, reason: 'url_changed', content: currentContent };
    }

    // Line-based diff
    const prevLines = previous.content.split('\n').filter((l) => l.trim());
    const currLines = currentContent.split('\n').filter((l) => l.trim());

    // Build a map of ref -> line for previous snapshot
    // Lines look like: "  [42]<button .../>Submit"
    // Extract ref (the [number] part) as key
    const prevByRef = new Map<string, string>();
    const refPattern = /\[(\d+)\]/;
    for (const line of prevLines) {
      const match = line.match(refPattern);
      if (match) {
        prevByRef.set(match[1], line.trim());
      }
    }

    const currByRef = new Map<string, string>();
    for (const line of currLines) {
      const match = line.match(refPattern);
      if (match) {
        currByRef.set(match[1], line.trim());
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    let unchanged = 0;

    // Find added and changed
    for (const [ref, line] of currByRef) {
      const prevLine = prevByRef.get(ref);
      if (!prevLine) {
        added.push(line);
      } else if (prevLine !== line) {
        changed.push(`${prevLine} \u2192 ${line}`);
      } else {
        unchanged++;
      }
    }

    // Find removed
    for (const [ref] of prevByRef) {
      if (!currByRef.has(ref)) {
        removed.push(prevByRef.get(ref)!);
      }
    }

    const totalNodes = currByRef.size;
    const changedNodes = added.length + removed.length + changed.length;
    const changeRatio = totalNodes > 0 ? changedNodes / totalNodes : 1;

    // If too many changes, return full snapshot
    if (changeRatio > MAX_CHANGE_RATIO) {
      return {
        isDelta: false,
        reason: 'high_change_ratio',
        content: currentContent,
      };
    }

    // Build summary text
    const summaryLines: string[] = [];
    summaryLines.push(
      `[DOM Delta \u2014 ${changedNodes} of ${totalNodes} nodes changed]`,
    );

    if (added.length > 0) {
      summaryLines.push(`Added (${added.length}):`);
      for (const line of added.slice(0, 10)) {
        summaryLines.push(`  + ${line}`);
      }
      if (added.length > 10)
        summaryLines.push(`  ... and ${added.length - 10} more`);
    }

    if (changed.length > 0) {
      summaryLines.push(`Changed (${changed.length}):`);
      for (const line of changed.slice(0, 10)) {
        summaryLines.push(`  ~ ${line}`);
      }
      if (changed.length > 10)
        summaryLines.push(`  ... and ${changed.length - 10} more`);
    }

    if (removed.length > 0) {
      summaryLines.push(`Removed (${removed.length}):`);
      for (const line of removed.slice(0, 10)) {
        summaryLines.push(`  - ${line}`);
      }
      if (removed.length > 10)
        summaryLines.push(`  ... and ${removed.length - 10} more`);
    }

    summaryLines.push(
      `Unchanged: ${unchanged} nodes (${totalNodes > 0 ? Math.round((unchanged / totalNodes) * 100) : 0}%)`,
    );

    return {
      isDelta: true,
      totalNodes,
      changedNodes,
      changeRatio,
      added,
      removed,
      changed,
      unchanged,
      summary: summaryLines.join('\n'),
    };
  }

  /**
   * Invalidate cache for a specific tab (call on navigation, tab close)
   */
  invalidate(sessionId: string, tabId: string): void {
    this.cache.delete(this.cacheKey(sessionId, tabId));
  }

  /**
   * Clear all cached snapshots
   */
  clear(): void {
    this.cache.clear();
  }

  private store(
    key: string,
    content: string,
    url: string,
    now: number,
  ): void {
    // LRU eviction
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(key)) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      content,
      timestamp: now,
      pageUrl: url,
      lineCount: content.split('\n').length,
    });
  }
}
