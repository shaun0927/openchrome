/**
 * Ref ID Manager - Manages persistent element references
 * Ported from extension
 */

/** TTL for ref staleness warning (30 seconds) */
export const REF_TTL_MS = 30_000;

export interface RefEntry {
  refId: string;
  backendDOMNodeId: number;
  role: string;
  name?: string;
  tagName?: string;
  textContent?: string;
  createdAt: number;
}

export class RefIdManager {
  private refs: Map<string, Map<string, Map<string, RefEntry>>> = new Map();
  private counters: Map<string, Map<string, number>> = new Map();

  /**
   * Generate a new ref ID for an element
   */
  generateRef(
    sessionId: string,
    targetId: string,
    backendDOMNodeId: number,
    role: string,
    name?: string,
    tagName?: string,
    textContent?: string
  ): string {
    let sessionRefs = this.refs.get(sessionId);
    if (!sessionRefs) {
      sessionRefs = new Map();
      this.refs.set(sessionId, sessionRefs);
    }

    let targetRefs = sessionRefs.get(targetId);
    if (!targetRefs) {
      targetRefs = new Map();
      sessionRefs.set(targetId, targetRefs);
    }

    let sessionCounters = this.counters.get(sessionId);
    if (!sessionCounters) {
      sessionCounters = new Map();
      this.counters.set(sessionId, sessionCounters);
    }

    let counter = sessionCounters.get(targetId) || 0;
    counter++;
    sessionCounters.set(targetId, counter);

    const refId = `ref_${counter}`;
    const entry: RefEntry = {
      refId,
      backendDOMNodeId,
      role,
      name,
      tagName,
      textContent,
      createdAt: Date.now(),
    };

    targetRefs.set(refId, entry);
    return refId;
  }

  getRef(sessionId: string, targetId: string, refId: string): RefEntry | undefined {
    return this.refs.get(sessionId)?.get(targetId)?.get(refId);
  }

  getBackendDOMNodeId(sessionId: string, targetId: string, refId: string): number | undefined {
    return this.getRef(sessionId, targetId, refId)?.backendDOMNodeId;
  }

  clearTargetRefs(sessionId: string, targetId: string): void {
    const sessionRefs = this.refs.get(sessionId);
    if (sessionRefs) {
      sessionRefs.delete(targetId);
    }

    const sessionCounters = this.counters.get(sessionId);
    if (sessionCounters) {
      sessionCounters.set(targetId, 0);
    }
  }

  clearSessionRefs(sessionId: string): void {
    this.refs.delete(sessionId);
    this.counters.delete(sessionId);
  }

  getTargetRefs(sessionId: string, targetId: string): RefEntry[] {
    const targetRefs = this.refs.get(sessionId)?.get(targetId);
    if (!targetRefs) {
      return [];
    }
    return Array.from(targetRefs.values());
  }

  /**
   * Check if a ref entry is stale (older than REF_TTL_MS)
   */
  isRefStale(sessionId: string, targetId: string, refId: string): boolean {
    const entry = this.getRef(sessionId, targetId, refId);
    if (!entry) return true;
    return Date.now() - entry.createdAt > REF_TTL_MS;
  }

  /**
   * Validate a ref against current DOM node properties.
   * Returns { valid: true } if the element identity matches,
   * or { valid: false, reason } if the ref appears stale.
   */
  validateRef(
    sessionId: string,
    targetId: string,
    refId: string,
    currentNodeName: string,
    currentTextContent?: string
  ): { valid: boolean; reason?: string; stale?: boolean } {
    const entry = this.getRef(sessionId, targetId, refId);
    if (!entry) return { valid: false, reason: 'Ref not found' };

    const isStale = Date.now() - entry.createdAt > REF_TTL_MS;

    // Validate tagName if stored (case-insensitive)
    if (entry.tagName && currentNodeName) {
      if (entry.tagName.toLowerCase() !== currentNodeName.toLowerCase()) {
        return {
          valid: false,
          stale: true,
          reason: `Element tag changed: expected <${entry.tagName}>, found <${currentNodeName}>`,
        };
      }
    }

    // Validate textContent prefix if stored (first 30 chars)
    if (entry.textContent && currentTextContent) {
      const storedPrefix = entry.textContent.slice(0, 30).trim();
      const currentPrefix = currentTextContent.slice(0, 30).trim();
      if (storedPrefix && currentPrefix && storedPrefix !== currentPrefix) {
        return {
          valid: false,
          stale: true,
          reason: `Element text changed: expected "${storedPrefix}...", found "${currentPrefix}..."`,
        };
      }
    }

    return { valid: true, stale: isStale };
  }

  /**
   * Unified resolver: accepts "ref_N", raw integer string "142", or "node_142"
   * Returns the backendDOMNodeId for use with CDP DOM.resolveNode
   */
  resolveToBackendNodeId(
    sessionId: string,
    targetId: string,
    refOrNodeId: string
  ): number | undefined {
    // 1. Try as ref_N (existing lookup — preserves backward compat)
    const entry = this.getRef(sessionId, targetId, refOrNodeId);
    if (entry) return entry.backendDOMNodeId;

    // 2. Try as raw integer (from DOM serialization output)
    const asNum = parseInt(refOrNodeId, 10);
    if (!isNaN(asNum) && asNum > 0 && String(asNum) === refOrNodeId && asNum <= 2147483647) return asNum;

    // 3. Try as "node_N" format (explicit prefix for clarity)
    if (refOrNodeId.startsWith('node_')) {
      const suffix = refOrNodeId.slice(5);
      const n = parseInt(suffix, 10);
      if (!isNaN(n) && n > 0 && String(n) === suffix && n <= 2147483647) return n;
    }

    return undefined;
  }
}

let refIdManagerInstance: RefIdManager | null = null;

export function getRefIdManager(): RefIdManager {
  if (!refIdManagerInstance) {
    refIdManagerInstance = new RefIdManager();
  }
  return refIdManagerInstance;
}
