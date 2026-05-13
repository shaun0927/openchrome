/**
 * Ref ID Manager - Manages persistent element references
 * Ported from extension
 */

import { Page } from 'puppeteer-core';

/** TTL for ref staleness warning (30 seconds) */
export const REF_TTL_MS = 30_000;

/**
 * Structured stale-ref error (#831). Returned to MCP clients when a tool is
 * called with an explicit `ref` argument that is expired, missing, or no
 * longer valid (e.g., after navigation cleared the per-target ref table).
 * No silent coordinate fallback — callers must call `read_page(mode='ax')`
 * to obtain a fresh ref.
 */
export const STALE_REF_HINT =
  "call read_page (mode='ax') to get fresh refs";

export interface StaleRefError {
  code: 'STALE_REF';
  ref_id: string;
  hint: string;
}

export function makeStaleRefError(refId: string): StaleRefError {
  return { code: 'STALE_REF', ref_id: refId, hint: STALE_REF_HINT };
}

/**
 * Format a STALE_REF error as a structured-but-readable text string
 * suitable for the MCPResult `content` channel. The exact phrase
 * "STALE_REF" is preserved so callers can detect it programmatically.
 */
export function formatStaleRefError(refId: string): string {
  return `STALE_REF: ref_id="${refId}" — ${STALE_REF_HINT}`;
}

export interface SnapshotRefMetadata {
  snapshotId: string;
  capturedAt: number;
  url: string;
  tabId: string;
}

export interface StaleSnapshotWarning {
  code: 'stale_snapshot' | 'possibly_stale_snapshot';
  message: string;
  ref_id: string;
  snapshot_id?: string;
  captured_at?: number;
  age_ms?: number;
  hint: string;
}

export interface RefEntry {
  refId: string;
  backendDOMNodeId: number;
  role: string;
  name?: string;
  tagName?: string;
  textContent?: string;
  createdAt: number;
  /**
   * TTL (ms) after which this ref becomes stale. Default: REF_TTL_MS.
   * Issue #831 — formalizes ref lifecycle on the read_page snapshot contract.
   */
  staleAfterMs: number;
  /**
   * Optional frame identifier for cross-frame disambiguation (#831).
   * Refs resolve via backendDOMNodeId; frameId is metadata for clients.
   */
  frameId?: string;
  /** Snapshot metadata from the page-state-producing call that minted this ref. */
  snapshot?: SnapshotRefMetadata;
}

export class RefIdManager {
  private refs: Map<string, Map<string, Map<string, RefEntry>>> = new Map();
  private counters: Map<string, Map<string, number>> = new Map();

  /**
   * Generate a new ref ID for an element.
   *
   * `options.staleAfterMs` lets callers override the default TTL for the ref
   * (defaults to REF_TTL_MS). `options.frameId` records the owning frame for
   * cross-frame disambiguation. Both fields are additive (#831).
   */
  generateRef(
    sessionId: string,
    targetId: string,
    backendDOMNodeId: number,
    role: string,
    name?: string,
    tagName?: string,
    textContent?: string,
    options?: { staleAfterMs?: number; frameId?: string; snapshot?: SnapshotRefMetadata }
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
      staleAfterMs: options?.staleAfterMs ?? REF_TTL_MS,
      frameId: options?.frameId,
      snapshot: options?.snapshot,
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

    // Do NOT reset counter to 0 — monotonically increasing counters prevent
    // ref aliasing where a new ref_1 could collide with a previous ref_1
    // that the LLM still has in its context window.
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
    // Do NOT reset counters — prevent ref aliasing across generations
  }

  getTargetRefs(sessionId: string, targetId: string): RefEntry[] {
    const targetRefs = this.refs.get(sessionId)?.get(targetId);
    if (!targetRefs) {
      return [];
    }
    return Array.from(targetRefs.values());
  }

  /**
   * Check if a ref entry is stale (older than its per-entry staleAfterMs).
   *
   * Returns true when the ref is missing OR past its TTL — callers treat
   * both conditions identically as STALE_REF (#831).
   */
  isRefStale(sessionId: string, targetId: string, refId: string): boolean {
    const entry = this.getRef(sessionId, targetId, refId);
    if (!entry) return true;
    return Date.now() - entry.createdAt > entry.staleAfterMs;
  }


  getRefStalenessWarning(
    sessionId: string,
    targetId: string,
    refId: string,
    now = Date.now()
  ): StaleSnapshotWarning | undefined {
    const entry = this.getRef(sessionId, targetId, refId);
    if (!entry) {
      return {
        code: 'stale_snapshot',
        message: `Ref ${refId} is no longer present for tab ${targetId}; the page likely navigated, reloaded, or refreshed refs.`,
        ref_id: refId,
        hint: STALE_REF_HINT,
      };
    }

    const ageMs = now - entry.createdAt;
    if (ageMs <= entry.staleAfterMs) return undefined;
    return {
      code: 'possibly_stale_snapshot',
      message: `Ref ${refId} is ${ageMs}ms old and exceeds stale_after_ms=${entry.staleAfterMs}.`,
      ref_id: refId,
      snapshot_id: entry.snapshot?.snapshotId,
      captured_at: entry.snapshot?.capturedAt ?? entry.createdAt,
      age_ms: ageMs,
      hint: STALE_REF_HINT,
    };
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
    currentTextContent?: string,
    currentName?: string
  ): { valid: boolean; reason?: string; stale?: boolean } {
    const entry = this.getRef(sessionId, targetId, refId);
    if (!entry) return { valid: false, reason: 'Ref not found' };

    const isStale = Date.now() - entry.createdAt > entry.staleAfterMs;

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

    // Validate accessible/name-like fingerprint if stored and available.
    if (entry.name && currentName) {
      const storedPrefix = entry.name.slice(0, 30).trim();
      const currentPrefix = currentName.slice(0, 30).trim();
      if (storedPrefix && currentPrefix && storedPrefix !== currentPrefix) {
        return {
          valid: false,
          stale: true,
          reason: `Element name changed: expected "${storedPrefix}...", found "${currentPrefix}..."`,
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
            const results: Element[] = [];
            try { const m = root.querySelectorAll(sel); for (let i = 0; i < m.length; i++) results.push(m[i]); } catch(e) {}
            const all = root.querySelectorAll('*');
            for (let j = 0; j < all.length; j++) {
              if ((all[j] as any).shadowRoot) {
                const sr = deepQSA((all[j] as any).shadowRoot, sel);
                for (let k = 0; k < sr.length; k++) results.push(sr[k]);
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
            let el = root.querySelector ? root.querySelector('*.__relocateTarget') : null;
            if (el) return el;
            let all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (let i = 0; i < all.length; i++) {
              if (all[i].__relocateTarget) return all[i];
              if (all[i].shadowRoot) {
                let found = deepFind(all[i].shadowRoot);
                if (found) return found;
              }
            }
            return null;
          }
          let el = deepFind(document);
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

      // Register a new ref for the re-located element. Preserve the original
      // ref's staleAfterMs + frameId so the relocated ref has equivalent
      // lifecycle semantics (#831).
      const newRef = this.generateRef(
        sessionId,
        tabId,
        node.backendNodeId,
        entry.role,
        entry.name,
        entry.tagName,
        entry.textContent,
        { staleAfterMs: entry.staleAfterMs, frameId: entry.frameId, snapshot: entry.snapshot }
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
