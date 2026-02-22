/**
 * Ref ID Manager - Manages persistent element references
 * Ported from extension
 */

export interface RefEntry {
  refId: string;
  backendDOMNodeId: number;
  role: string;
  name?: string;
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
    name?: string
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
    if (!isNaN(asNum) && asNum > 0) return asNum;

    // 3. Try as "node_N" format (explicit prefix for clarity)
    if (refOrNodeId.startsWith('node_')) {
      const n = parseInt(refOrNodeId.slice(5), 10);
      if (!isNaN(n) && n > 0) return n;
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
