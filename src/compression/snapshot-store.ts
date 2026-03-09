/**
 * SnapshotStore - LRU cache for DOM snapshots to enable incremental delta responses.
 *
 * Caches serialized DOM text per (sessionId, tabId) and computes line-based
 * diffs on subsequent read_page calls. Distinct from withDomDelta which captures
 * MutationObserver changes during actions.
 */

interface Snapshot {
  content: string;
  timestamp: number;
  pageUrl: string;
  lineCount: number;
}

export interface DeltaResult {
  isDelta: boolean;
  content: string;
  changeRatio: number;  // 0.0 = identical, 1.0 = completely different
  stats: {
    totalNodes: number;
    addedLines: number;
    removedLines: number;
    unchangedLines: number;
  };
}

const MAX_ENTRIES = 50;
const TTL_MS = 30_000;  // 30 seconds
const DELTA_THRESHOLD = 0.5;  // If >50% changed, return full instead of delta

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

  private makeKey(sessionId: string, tabId: string): string {
    return `${sessionId}:${tabId}`;
  }

  /**
   * Get a cached snapshot if it exists and is not stale.
   */
  get(sessionId: string, tabId: string): Snapshot | null {
    const key = this.makeKey(sessionId, tabId);
    const snapshot = this.cache.get(key);
    if (!snapshot) return null;
    if (Date.now() - snapshot.timestamp > TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return snapshot;
  }

  /**
   * Store a new snapshot, evicting oldest if at capacity.
   */
  set(sessionId: string, tabId: string, content: string, url: string): void {
    const key = this.makeKey(sessionId, tabId);

    // LRU eviction
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    // Move to end for LRU (delete + set)
    this.cache.delete(key);
    this.cache.set(key, {
      content,
      timestamp: Date.now(),
      pageUrl: url,
      lineCount: content.split('\n').length,
    });
  }

  /**
   * Invalidate cache for a specific tab (call on navigation).
   */
  invalidate(sessionId: string, tabId: string): void {
    this.cache.delete(this.makeKey(sessionId, tabId));
  }

  /**
   * Clear all cached snapshots.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Compute a line-based delta between previous snapshot and current content.
   * Returns delta format if change ratio is below threshold, otherwise returns full content.
   */
  computeDelta(previous: Snapshot, currentContent: string, currentUrl: string): DeltaResult {
    // If URL changed, not a meaningful delta
    if (previous.pageUrl !== currentUrl) {
      return {
        isDelta: false,
        content: currentContent,
        changeRatio: 1.0,
        stats: { totalNodes: 0, addedLines: 0, removedLines: 0, unchangedLines: 0 },
      };
    }

    const prevLines = previous.content.split('\n');
    const currLines = currentContent.split('\n');

    // Build a set of previous lines for fast lookup (preserve indentation for structural comparison)
    const prevSet = new Map<string, number>();
    for (const line of prevLines) {
      if (line.trim()) prevSet.set(line, (prevSet.get(line) || 0) + 1);
    }

    const currSet = new Map<string, number>();
    for (const line of currLines) {
      if (line.trim()) currSet.set(line, (currSet.get(line) || 0) + 1);
    }

    // Find added lines (in current but not in previous)
    const added: string[] = [];
    const tempPrev = new Map(prevSet);
    for (const line of currLines) {
      if (!line.trim()) continue;
      const prevCount = tempPrev.get(line) || 0;
      if (prevCount > 0) {
        tempPrev.set(line, prevCount - 1);
      } else {
        added.push(line);
      }
    }

    // Find removed lines (in previous but not in current)
    const removed: string[] = [];
    const tempCurr = new Map(currSet);
    for (const line of prevLines) {
      if (!line.trim()) continue;
      const currCount = tempCurr.get(line) || 0;
      if (currCount > 0) {
        tempCurr.set(line, currCount - 1);
      } else {
        removed.push(line);
      }
    }

    const totalPrevLines = prevLines.filter(l => l.trim()).length;
    const unchangedLines = totalPrevLines - removed.length;
    const changeRatio = totalPrevLines > 0
      ? (added.length + removed.length) / (totalPrevLines + added.length)
      : 1.0;

    // If too many changes, return full content instead
    if (changeRatio > DELTA_THRESHOLD) {
      return {
        isDelta: false,
        content: currentContent,
        changeRatio,
        stats: {
          totalNodes: currLines.filter(l => l.trim()).length,
          addedLines: added.length,
          removedLines: removed.length,
          unchangedLines,
        },
      };
    }

    // Format delta output
    const deltaLines: string[] = [];
    deltaLines.push(`[DOM Delta — ${added.length + removed.length} of ${totalPrevLines} nodes changed]`);

    if (added.length > 0) {
      deltaLines.push(`\nAdded (${added.length}):`);
      for (const line of added.slice(0, 20)) {
        deltaLines.push(`  + ${line.trim()}`);
      }
      if (added.length > 20) {
        deltaLines.push(`  ... and ${added.length - 20} more`);
      }
    }

    if (removed.length > 0) {
      deltaLines.push(`\nRemoved (${removed.length}):`);
      for (const line of removed.slice(0, 10)) {
        deltaLines.push(`  - ${line.trim()}`);
      }
      if (removed.length > 10) {
        deltaLines.push(`  ... and ${removed.length - 10} more`);
      }
    }

    deltaLines.push(`\nUnchanged: ${unchangedLines} nodes (${totalPrevLines > 0 ? Math.round((unchangedLines / totalPrevLines) * 100) : 0}%)`);

    return {
      isDelta: true,
      content: deltaLines.join('\n'),
      changeRatio,
      stats: {
        totalNodes: currLines.filter(l => l.trim()).length,
        addedLines: added.length,
        removedLines: removed.length,
        unchangedLines,
      },
    };
  }
}
