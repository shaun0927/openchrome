/**
 * Ref ID Manager - Manages persistent element references
 * Ported from extension
 */

import { Page } from 'puppeteer-core';

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

  clearTargetRefsAllSessions(targetId: string): void {
    for (const [, sessionRefs] of this.refs) {
      if (sessionRefs.has(targetId)) {
        sessionRefs.delete(targetId);
      }
    }
    for (const [, sessionCounters] of this.counters) {
      if (sessionCounters.has(targetId)) {
        sessionCounters.set(targetId, 0);
      }
    }
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
   * Migrate all refs from one target ID to another.
   * Used when Chrome reassigns target IDs after reconnection.
   */
  migrateTarget(sessionId: string, oldTargetId: string, newTargetId: string): void {
    const sessionRefs = this.refs.get(sessionId);
    if (sessionRefs) {
      const oldRefs = sessionRefs.get(oldTargetId);
      if (oldRefs) {
        // Move refs to new target ID
        sessionRefs.set(newTargetId, oldRefs);
        sessionRefs.delete(oldTargetId);
      }
    }

    // Migrate counter
    const sessionCounters = this.counters.get(sessionId);
    if (sessionCounters) {
      const counter = sessionCounters.get(oldTargetId);
      if (counter !== undefined) {
        sessionCounters.set(newTargetId, counter);
        sessionCounters.delete(oldTargetId);
      }
    }
  }

  /**
   * Attempt to relocate a stale ref by searching for an element that matches the
   * stored metadata (tagName + name/aria-label or textContent).
   *
   * Returns { backendNodeId, newRef } if the element is found and a new ref is
   * registered for it, or null if the element cannot be located.
   *
   * This is used by computer and form_input to recover transparently from stale
   * refs without surfacing an error to the LLM.
   */
  async tryRelocateRef(
    sessionId: string,
    tabId: string,
    ref: string,
    page: Page,
    cdpClient: { send: (page: Page, method: string, params?: Record<string, unknown>) => Promise<unknown> }
  ): Promise<{ backendNodeId: number; newRef: string } | null> {
    const entry = this.getRef(sessionId, tabId, ref);
    if (!entry) return null;

    const { tagName, name, textContent, role } = entry;

    // Build a selector from stored metadata. We need at least a tagName to proceed.
    if (!tagName) return null;

    try {
      // Use page.evaluate to search for a matching element quickly.
      // Strategy 1: tagName + aria-label/title exact match (most reliable).
      // Strategy 2: tagName + text content prefix match.
      // Strategy 3: tagName alone (only if role is unique enough, e.g. input types).
      const foundNodeId = await page.evaluate(
        (tag: string, elName: string | undefined, elText: string | undefined, elRole: string | undefined): number => {
          // Deep querySelectorAll that pierces open shadow roots
          function deepQSA(root: Element | Document | ShadowRoot, sel: string): Element[] {
            var results: Element[] = [];
            try { var m = root.querySelectorAll(sel); for (var i = 0; i < m.length; i++) results.push(m[i]); } catch(e) {}
            var all = root.querySelectorAll('*');
            for (var j = 0; j < all.length; j++) {
              if ((all[j] as any).shadowRoot) {
                var sr = deepQSA((all[j] as any).shadowRoot, sel);
                for (var k = 0; k < sr.length; k++) results.push(sr[k]);
              }
            }
            return results;
          }

          const selector = tag;
          const candidates = deepQSA(document, selector);

          // Helper: check visibility
          function isVisible(el: Element): boolean {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }

          const textPrefix = elText ? elText.slice(0, 30).trim() : '';
          const nameLower = elName ? elName.toLowerCase() : '';

          for (const el of candidates) {
            if (!isVisible(el)) continue;

            const inputEl = el as HTMLInputElement;

            // Strategy 1: aria-label or title match
            if (nameLower) {
              const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
              const titleAttr = (el.getAttribute('title') || '').toLowerCase();
              const placeholder = (inputEl.placeholder || '').toLowerCase();
              if (ariaLabel === nameLower || titleAttr === nameLower || placeholder === nameLower) {
                (el as unknown as { __relocateTarget: boolean }).__relocateTarget = true;
                return 1;
              }
            }

            // Strategy 2: textContent prefix match
            if (textPrefix) {
              const currentText = (el.textContent || '').trim().slice(0, 30);
              if (currentText === textPrefix) {
                (el as unknown as { __relocateTarget: boolean }).__relocateTarget = true;
                return 1;
              }
            }
          }

          // Strategy 3: role-only match — only use for inputs/buttons with no text/name
          if (!nameLower && !textPrefix && elRole) {
            const roleLower = elRole.toLowerCase();
            for (const el of candidates) {
              if (!isVisible(el)) continue;
              const inputEl = el as HTMLInputElement;
              const elRoleAttr = (el.getAttribute('role') || '').toLowerCase();
              const inferredRole = el.tagName === 'BUTTON' ? 'button'
                : el.tagName === 'A' ? 'link'
                : el.tagName === 'INPUT' ? (inputEl.type || 'textbox')
                : elRoleAttr;
              if (inferredRole === roleLower) {
                (el as unknown as { __relocateTarget: boolean }).__relocateTarget = true;
                return 1;
              }
            }
          }

          return 0;
        },
        tagName,
        name,
        textContent,
        role
      );

      if (!foundNodeId) return null;

      // Get the backend node ID via CDP
      // Deep search for __relocateTarget including open shadow roots
      const { result: batchResult } = await cdpClient.send(page, 'Runtime.evaluate', {
        expression: `(() => {
          function deepFind(root) {
            var el = root.querySelector ? root.querySelector('*.__relocateTarget') : null;
            if (el) return el;
            var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (var i = 0; i < all.length; i++) {
              if (all[i].__relocateTarget) return all[i];
              if (all[i].shadowRoot) {
                var found = deepFind(all[i].shadowRoot);
                if (found) return found;
              }
            }
            return null;
          }
          var el = deepFind(document);
          if (el) { delete el.__relocateTarget; }
          return el || null;
        })()`,
        returnByValue: false,
      }) as { result: { objectId?: string } };

      if (!batchResult?.objectId) return null;

      const { node } = await cdpClient.send(page, 'DOM.describeNode', {
        objectId: batchResult.objectId,
      }) as { node: { backendNodeId: number } };

      if (!node?.backendNodeId) return null;

      // Register a new ref for the re-located element
      const newRef = this.generateRef(
        sessionId,
        tabId,
        node.backendNodeId,
        entry.role,
        entry.name,
        entry.tagName,
        entry.textContent
      );

      return { backendNodeId: node.backendNodeId, newRef };
    } catch {
      // Any CDP or evaluate failure means we cannot relocate
      return null;
    }
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
