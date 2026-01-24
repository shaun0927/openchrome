/**
 * Ref ID Manager - Manages persistent element references across read_page calls
 *
 * This solves the critical issue where read_page generates new ref_N IDs on each call,
 * making form_input and scroll_to unable to find previously identified elements.
 *
 * Architecture:
 * 1. Store mapping of ref_N → backendDOMNodeId (from accessibility tree) per session/tab
 * 2. When form_input or scroll_to needs an element, resolve backendDOMNodeId to actual DOM node
 * 3. Clear mappings when navigating to a new page
 */

export interface RefEntry {
  refId: string;
  backendDOMNodeId: number;
  role: string;
  name?: string;
  createdAt: number;
}

export class RefIdManager {
  // Map: sessionId -> tabId -> refId -> RefEntry
  private refs: Map<string, Map<number, Map<string, RefEntry>>> = new Map();
  private counters: Map<string, Map<number, number>> = new Map();

  /**
   * Generate a new ref ID for an element
   */
  generateRef(
    sessionId: string,
    tabId: number,
    backendDOMNodeId: number,
    role: string,
    name?: string
  ): string {
    // Get or create session map
    let sessionRefs = this.refs.get(sessionId);
    if (!sessionRefs) {
      sessionRefs = new Map();
      this.refs.set(sessionId, sessionRefs);
    }

    // Get or create tab map
    let tabRefs = sessionRefs.get(tabId);
    if (!tabRefs) {
      tabRefs = new Map();
      sessionRefs.set(tabId, tabRefs);
    }

    // Get or create counter for this session/tab
    let sessionCounters = this.counters.get(sessionId);
    if (!sessionCounters) {
      sessionCounters = new Map();
      this.counters.set(sessionId, sessionCounters);
    }

    let counter = sessionCounters.get(tabId) || 0;
    counter++;
    sessionCounters.set(tabId, counter);

    const refId = `ref_${counter}`;
    const entry: RefEntry = {
      refId,
      backendDOMNodeId,
      role,
      name,
      createdAt: Date.now(),
    };

    tabRefs.set(refId, entry);
    return refId;
  }

  /**
   * Get a ref entry by ID
   */
  getRef(sessionId: string, tabId: number, refId: string): RefEntry | undefined {
    return this.refs.get(sessionId)?.get(tabId)?.get(refId);
  }

  /**
   * Get the backend DOM node ID for a ref
   */
  getBackendDOMNodeId(sessionId: string, tabId: number, refId: string): number | undefined {
    return this.getRef(sessionId, tabId, refId)?.backendDOMNodeId;
  }

  /**
   * Clear all refs for a tab (called on navigation)
   */
  clearTabRefs(sessionId: string, tabId: number): void {
    const sessionRefs = this.refs.get(sessionId);
    if (sessionRefs) {
      sessionRefs.delete(tabId);
    }

    const sessionCounters = this.counters.get(sessionId);
    if (sessionCounters) {
      sessionCounters.set(tabId, 0);
    }
  }

  /**
   * Clear all refs for a session
   */
  clearSessionRefs(sessionId: string): void {
    this.refs.delete(sessionId);
    this.counters.delete(sessionId);
  }

  /**
   * Get all refs for a tab
   */
  getTabRefs(sessionId: string, tabId: number): RefEntry[] {
    const tabRefs = this.refs.get(sessionId)?.get(tabId);
    if (!tabRefs) {
      return [];
    }
    return Array.from(tabRefs.values());
  }

  /**
   * Get stats
   */
  getStats(): { sessions: number; totalRefs: number } {
    let totalRefs = 0;
    for (const sessionRefs of this.refs.values()) {
      for (const tabRefs of sessionRefs.values()) {
        totalRefs += tabRefs.size;
      }
    }
    return {
      sessions: this.refs.size,
      totalRefs,
    };
  }
}

// Singleton instance
let refIdManagerInstance: RefIdManager | null = null;

export function getRefIdManager(): RefIdManager {
  if (!refIdManagerInstance) {
    refIdManagerInstance = new RefIdManager();
  }
  return refIdManagerInstance;
}
