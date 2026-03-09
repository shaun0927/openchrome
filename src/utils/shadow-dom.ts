/**
 * Shadow DOM utilities - CDP-based shadow root discovery and element search
 *
 * Uses CDP's DOM.getDocument({ pierce: true }) to access ALL shadow roots
 * (open, closed, and user-agent). JS-based traversal only works for open roots.
 *
 * Primary consumer: element-discovery.ts (third pass for shadow elements)
 * Future consumer: query-dom.ts (CSS queries inside shadow roots)
 */

import { Page } from 'puppeteer-core';
import { CDPClient } from '../cdp/client';

/**
 * Information about a discovered shadow root.
 */
export interface ShadowRootInfo {
  hostNodeId: number;
  hostBackendNodeId: number;
  shadowRootNodeId: number;
  shadowRootType: string;
}

/**
 * CDP DOM node structure (subset needed for tree walking).
 */
export interface CDPDOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  attributes?: string[];
  children?: CDPDOMNode[];
  contentDocument?: CDPDOMNode;
  nodeValue?: string;
  shadowRoots?: CDPDOMNode[];
  shadowRootType?: string;
}

/**
 * Element found inside a shadow root via CDP tree walking.
 */
export interface ShadowElement {
  backendDOMNodeId: number;
  role: string;
  name: string;
  tagName: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  textContent?: string;
  rect: { x: number; y: number; width: number; height: number };
}

// Node type constants
const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;

// Tags to skip when collecting shadow candidates
const SKIP_TAGS = new Set([
  'script', 'style', 'svg', 'noscript', 'meta', 'link', 'head',
]);

// Interactive tags for priority matching
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea',
]);

// Interactive roles for priority matching
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'tab', 'option', 'switch', 'slider', 'treeitem',
]);

// Stop words filtered from query tokens
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or',
]);

/**
 * Internal candidate collected from CDP DOM tree walking.
 */
interface ShadowCandidate {
  nodeId: number;
  backendNodeId: number;
  tagName: string;
  attributes: Map<string, string>;
  textContent: string;
}

/**
 * Get all shadow roots on a page by walking the CDP DOM tree.
 *
 * Uses DOM.getDocument({ depth: -1, pierce: true }) which returns
 * shadowRoots[] for every element that has one (open, closed, user-agent).
 *
 * Also returns the full DOM tree for efficient subtree walking.
 */
export async function getAllShadowRoots(
  page: Page,
  cdpClient: CDPClient,
): Promise<{ shadowRoots: ShadowRootInfo[]; domTree: CDPDOMNode }> {
  const { root } = await cdpClient.send<{ root: CDPDOMNode }>(
    page,
    'DOM.getDocument',
    { depth: -1, pierce: true },
  );

  const shadowRoots: ShadowRootInfo[] = [];
  walkForShadowRoots(root, shadowRoots);

  return { shadowRoots, domTree: root };
}

/**
 * Recursively walk CDP DOM tree collecting shadow root info.
 */
function walkForShadowRoots(node: CDPDOMNode, results: ShadowRootInfo[]): void {
  if (node.shadowRoots) {
    for (const sr of node.shadowRoots) {
      results.push({
        hostNodeId: node.nodeId,
        hostBackendNodeId: node.backendNodeId,
        shadowRootNodeId: sr.nodeId,
        shadowRootType: sr.shadowRootType || 'open',
      });
      // Recurse into shadow root children for nested shadow roots
      if (sr.children) {
        for (const child of sr.children) {
          walkForShadowRoots(child, results);
        }
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      walkForShadowRoots(child, results);
    }
  }

  if (node.contentDocument) {
    walkForShadowRoots(node.contentDocument, results);
  }
}

/**
 * Run CSS selectors scoped to individual shadow roots via CDP.
 *
 * For each shadow root, runs DOM.querySelectorAll with the given selector,
 * returning backendNodeIds of all matched elements.
 *
 * Primary use: query_dom CSS queries that need to pierce shadow boundaries.
 */
export async function querySelectorInShadowRoots(
  page: Page,
  cdpClient: CDPClient,
  selector: string,
  shadowRoots: ShadowRootInfo[],
): Promise<number[]> {
  if (shadowRoots.length === 0) return [];

  const backendNodeIds: number[] = [];

  for (const sr of shadowRoots) {
    try {
      const { nodeIds } = await cdpClient.send<{ nodeIds: number[] }>(
        page,
        'DOM.querySelectorAll',
        { nodeId: sr.shadowRootNodeId, selector },
      );

      if (!nodeIds || nodeIds.length === 0) continue;

      // Resolve each to backendNodeId
      const resolvePromises = nodeIds.map(async (nodeId) => {
        try {
          const { node } = await cdpClient.send<{
            node: { backendNodeId: number };
          }>(page, 'DOM.describeNode', { nodeId });
          return node.backendNodeId;
        } catch {
          return null;
        }
      });

      const resolved = await Promise.all(resolvePromises);
      for (const id of resolved) {
        if (id !== null) backendNodeIds.push(id);
      }
    } catch {
      // querySelectorAll may fail for invalid selectors or stale nodes
    }
  }

  return backendNodeIds;
}

/**
 * Discover elements inside shadow roots matching a query.
 *
 * Walks the CDP DOM tree's shadow root subtrees, matches elements against
 * the query text, and resolves coordinates via DOM.getBoxModel.
 *
 * Elements already have backendNodeId from the CDP tree (no tag-and-resolve needed).
 *
 * Flow:
 * 1. DOM.getDocument({ pierce: true }) → full tree with shadow roots
 * 2. Walk shadow subtrees collecting element candidates
 * 3. Match candidates against query (interactive first, then text)
 * 4. Batch DOM.getBoxModel for coordinates
 */
export async function discoverShadowElements(
  page: Page,
  cdpClient: CDPClient,
  query: string,
  options?: {
    maxResults?: number;
    useCenter?: boolean;
    excludeBackendIds?: Set<number>;
  },
): Promise<ShadowElement[]> {
  const maxResults = options?.maxResults ?? 30;
  const useCenter = options?.useCenter ?? false;
  const excludeIds = options?.excludeBackendIds ?? new Set();

  // Step 1: Get DOM tree and shadow roots
  const { shadowRoots, domTree } = await getAllShadowRoots(page, cdpClient);
  if (shadowRoots.length === 0) return [];

  // Step 2: Collect all element candidates from shadow root subtrees
  const candidates = collectCandidatesFromShadowRoots(domTree);
  if (candidates.length === 0) return [];

  // Step 3: Match candidates against query
  const searchLower = query.toLowerCase();
  const queryTokens = searchLower
    .split(/\s+/)
    .filter(t => t.length > 1)
    .filter(t => !STOP_WORDS.has(t));

  const matched: ShadowCandidate[] = [];
  const seenIds = new Set<number>();

  // First: interactive candidates matching query
  for (const c of candidates) {
    if (matched.length >= maxResults) break;
    if (excludeIds.has(c.backendNodeId) || seenIds.has(c.backendNodeId)) continue;
    if (!isInteractiveCandidate(c)) continue;

    const combinedText = buildCombinedText(c);
    if (matchesQuery(combinedText, searchLower, queryTokens)) {
      seenIds.add(c.backendNodeId);
      matched.push(c);
    }
  }

  // Second: all candidates matching query (text search)
  for (const c of candidates) {
    if (matched.length >= maxResults) break;
    if (excludeIds.has(c.backendNodeId) || seenIds.has(c.backendNodeId)) continue;

    const combinedText = buildCombinedText(c);
    if (matchesQuery(combinedText, searchLower, queryTokens)) {
      seenIds.add(c.backendNodeId);
      matched.push(c);
    }
  }

  if (matched.length === 0) return [];

  // Step 4: Batch resolve box models for coordinates
  const boxPromises = matched.map(async (c): Promise<ShadowElement | null> => {
    try {
      const { model } = await cdpClient.send<{
        model: { content: number[] };
      }>(page, 'DOM.getBoxModel', { nodeId: c.nodeId });

      if (!model?.content || model.content.length < 8) return null;

      // Content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
      const x = model.content[0];
      const y = model.content[1];
      const width = model.content[2] - x;
      const height = model.content[5] - y;

      if (width <= 0 || height <= 0) return null;

      const ariaLabel = c.attributes.get('aria-label');

      return {
        backendDOMNodeId: c.backendNodeId,
        role: c.attributes.get('role') || inferRole(c.tagName, c.attributes),
        name: ariaLabel || c.attributes.get('title') || c.textContent || '',
        tagName: c.tagName,
        type: c.attributes.get('type'),
        placeholder: c.attributes.get('placeholder'),
        ariaLabel: ariaLabel || undefined,
        textContent: c.textContent || undefined,
        rect: {
          x: useCenter ? x + width / 2 : x,
          y: useCenter ? y + height / 2 : y,
          width,
          height,
        },
      };
    } catch {
      return null; // element may not have layout
    }
  });

  const resolved = await Promise.all(boxPromises);
  return resolved.filter((el): el is ShadowElement => el !== null);
}

/**
 * Walk CDP DOM tree collecting element candidates from shadow root subtrees.
 *
 * Only collects elements that are inside shadow roots (not light DOM).
 * Handles nested shadow roots correctly.
 */
function collectCandidatesFromShadowRoots(domTree: CDPDOMNode): ShadowCandidate[] {
  const candidates: ShadowCandidate[] = [];

  function walkNode(node: CDPDOMNode, inShadowRoot: boolean): void {
    // Collect element nodes that are inside shadow roots
    if (node.nodeType === NODE_TYPE_ELEMENT && inShadowRoot) {
      const tagName = node.localName || node.nodeName.toLowerCase();
      if (!SKIP_TAGS.has(tagName)) {
        candidates.push({
          nodeId: node.nodeId,
          backendNodeId: node.backendNodeId,
          tagName,
          attributes: parseAttrs(node.attributes),
          textContent: getNodeText(node),
        });
      }
    }

    // If this node has shadow roots, walk into them (entering shadow context)
    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        if (sr.children) {
          for (const child of sr.children) {
            walkNode(child, true);
          }
        }
      }
    }

    // Walk regular children (keep current shadow context)
    if (node.children) {
      for (const child of node.children) {
        walkNode(child, inShadowRoot);
      }
    }

    // Walk into iframe content documents (reset shadow context)
    if (node.contentDocument) {
      walkNode(node.contentDocument, false);
    }
  }

  walkNode(domTree, false);
  return candidates;
}

/**
 * Check if a candidate element is interactive.
 */
function isInteractiveCandidate(c: ShadowCandidate): boolean {
  if (INTERACTIVE_TAGS.has(c.tagName)) return true;
  const role = c.attributes.get('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (c.attributes.has('onclick')) return true;
  if (c.attributes.has('tabindex')) return true;
  if (c.attributes.get('contenteditable') === 'true') return true;
  return false;
}

/**
 * Extract direct text content from a CDP DOM node's text children.
 */
function getNodeText(node: CDPDOMNode): string {
  if (!node.children) return '';
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.nodeType === NODE_TYPE_TEXT && child.nodeValue) {
      const text = child.nodeValue.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(' ').slice(0, 100);
}

/**
 * Parse CDP flat attributes array [name1, value1, name2, value2, ...] into a Map.
 */
function parseAttrs(attrs?: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!attrs) return map;
  for (let i = 0; i < attrs.length - 1; i += 2) {
    map.set(attrs[i], attrs[i + 1]);
  }
  return map;
}

/**
 * Build combined text for query matching from candidate attributes.
 */
function buildCombinedText(c: ShadowCandidate): string {
  const name = c.attributes.get('aria-label') || c.attributes.get('title') || c.textContent || '';
  const ariaLabel = c.attributes.get('aria-label') || '';
  const placeholder = c.attributes.get('placeholder') || '';
  return `${name} ${c.textContent} ${ariaLabel} ${placeholder}`.toLowerCase();
}

/**
 * Check if combined text matches query.
 */
function matchesQuery(combinedText: string, searchLower: string, queryTokens: string[]): boolean {
  return combinedText.includes(searchLower) || queryTokens.some(token => combinedText.includes(token));
}

/**
 * Infer semantic role from tag name and attributes.
 */
function inferRole(tagName: string, attrs: Map<string, string>): string {
  if (tagName === 'button') return 'button';
  if (tagName === 'a') return 'link';
  if (tagName === 'input') return attrs.get('type') || 'textbox';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'select') return 'combobox';
  if (attrs.get('contenteditable') === 'true') return 'textbox';
  return tagName;
}
