/**
 * AX-First Element Resolution — Framework-agnostic element targeting via Chrome Accessibility Tree
 *
 * Uses the browser's built-in accessibility engine (which already understands all UI frameworks:
 * Angular Material, React MUI, Vue Vuetify, etc.) to resolve elements by role + name.
 *
 * Flow: query → parseQueryForAX → getCachedAXTree → scoreAXNode → DOM.getBoxModel → coordinates
 * Fallback: if AX resolution fails, callers fall back to existing CSS-based discoverElements().
 */

import type { Page } from 'puppeteer-core';
import type { CDPClient } from '../cdp/client';
import { getTargetId } from './puppeteer-helpers';

// ─── Types ───

/** AX node from Accessibility.getFullAXTree, matching read-page.ts:76-84 */
interface AXNode {
  nodeId: number;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  childIds?: number[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

/** Flattened AX node for efficient processing */
export interface AXNodeFlat {
  nodeId: number;
  backendDOMNodeId: number;
  role: string;
  name: string;
  value?: string;
  properties: Record<string, unknown>;
}

/** Result of AX-based element resolution */
export interface AXResolvedElement {
  backendDOMNodeId: number;
  role: string;
  name: string;
  axScore: number;
  rect: { x: number; y: number; width: number; height: number };
  properties: Record<string, unknown>;
  source: 'ax';
}

/** Options for AX resolution */
export interface AXResolveOptions {
  useCenter?: boolean;
  maxResults?: number;
  depth?: number;
}

/** Parsed query with optional role hint */
export interface ParsedAXQuery {
  roleHint: string | null;
  nameHint: string;
  nameTokens: string[];
}

// ─── Role Keyword Map ───

/**
 * Maps natural language role keywords to AX tree role values.
 * Ordered longest-first for greedy matching ("radio button" before "radio").
 */
const ROLE_KEYWORDS: Array<[string, string]> = [
  ['radio button', 'radio'],
  ['check box', 'checkbox'],
  ['combo box', 'combobox'],
  ['text field', 'textbox'],
  ['text box', 'textbox'],
  ['search box', 'searchbox'],
  ['menu item', 'menuitem'],
  ['tree item', 'treeitem'],
  ['tab panel', 'tabpanel'],
  ['list item', 'listitem'],
  ['button', 'button'],
  ['link', 'link'],
  ['radio', 'radio'],
  ['checkbox', 'checkbox'],
  ['input', 'textbox'],
  ['textbox', 'textbox'],
  ['search', 'searchbox'],
  ['dropdown', 'combobox'],
  ['select', 'combobox'],
  ['combobox', 'combobox'],
  ['tab', 'tab'],
  ['slider', 'slider'],
  ['switch', 'switch'],
  ['toggle', 'switch'],
  ['menuitem', 'menuitem'],
  ['option', 'option'],
  ['heading', 'heading'],
  ['img', 'image'],
  ['image', 'image'],
];

/** AX roles to skip during flattening (non-interactive structural roles) */
const SKIP_ROLES = new Set([
  'none', 'presentation', 'generic', 'InlineTextBox',
  'StaticText', 'LineBreak', 'paragraph', 'Section',
]);

/** AX roles considered interactive */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox',
  'radio', 'checkbox', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'treeitem', 'listitem',
]);

// ─── Query Parsing ───

/**
 * Parse a natural-language query into structured role + name hints.
 *
 * Examples:
 *   "외부 radio button"  → { roleHint: "radio", nameHint: "외부" }
 *   "Submit button"      → { roleHint: "button", nameHint: "submit" }
 *   "search input"       → { roleHint: "textbox", nameHint: "search" }
 *   "로그인"              → { roleHint: null, nameHint: "로그인" }
 */
export function parseQueryForAX(query: string): ParsedAXQuery {
  const queryLower = query.toLowerCase().trim();

  // Try longest-match-first to extract role hint
  for (const [keyword, role] of ROLE_KEYWORDS) {
    const idx = queryLower.indexOf(keyword);
    if (idx !== -1) {
      // Remove the role keyword from the query to get the name hint
      const before = query.slice(0, idx).trim();
      const after = query.slice(idx + keyword.length).trim();
      const nameHint = [before, after].filter(Boolean).join(' ').trim();

      return {
        roleHint: role,
        nameHint: nameHint || query.trim(), // if only role keyword, use full query as name
        nameTokens: tokenize(nameHint || query.trim()),
      };
    }
  }

  // No role keyword found
  return {
    roleHint: null,
    nameHint: query.trim(),
    nameTokens: tokenize(query.trim()),
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
}

// ─── AX Node Scoring ───

/**
 * Score an AX node against parsed query hints.
 *
 * Scoring rubric:
 *   Exact role + exact name:     100
 *   Exact role + name contains:   80
 *   Exact name, no role hint:     75
 *   Name contains, no role hint:  50
 *   Role match only:              30
 *   Per-token overlap:           +15 each
 *   Interactive role bonus:      +10
 *   Disabled penalty:            -50
 */
export function scoreAXNode(
  node: AXNodeFlat,
  roleHint: string | null,
  nameHint: string,
  nameTokens: string[],
): number {
  const nodeName = node.name.toLowerCase().trim();
  const nodeRole = node.role.toLowerCase();
  const nameHintLower = nameHint.toLowerCase().trim();

  if (!nodeName && !roleHint) return 0;

  let score = 0;
  const roleMatches = roleHint ? nodeRole === roleHint : false;
  const exactNameMatch = nodeName === nameHintLower;
  const nameContains = nameHintLower.length > 0 && nodeName.includes(nameHintLower);
  const nameContainedBy = nameHintLower.length > 0 && nameHintLower.includes(nodeName);

  // Primary scoring
  if (roleMatches && exactNameMatch) {
    score = 100;
  } else if (roleMatches && nameContains) {
    score = 80;
  } else if (roleMatches && nameContainedBy && nodeName.length > 0) {
    score = 70;
  } else if (exactNameMatch && !roleHint) {
    score = 75;
  } else if (nameContains && !roleHint) {
    score = 50;
  } else if (roleMatches && !nameHintLower) {
    score = 30;
  } else if (roleMatches) {
    // Role matches but name doesn't — check token overlap
    score = 25;
  } else {
    // No role match — check token overlap only
    score = 0;
  }

  // Token overlap bonus (for partial matches)
  if (score < 80) {
    let tokenMatches = 0;
    for (const token of nameTokens) {
      if (token.length >= 2 && nodeName.includes(token)) {
        tokenMatches++;
      }
    }
    if (nameTokens.length > 0) {
      score += tokenMatches * 15;
    }
  }

  // Interactive role bonus
  if (INTERACTIVE_ROLES.has(nodeRole)) {
    score += 10;
  }

  // Disabled penalty
  if (node.properties['disabled'] === true) {
    score -= 50;
  }

  return Math.max(0, score);
}

// ─── AX Tree Cache ───

const AX_CACHE_TTL_MS = 2000;

const axCache = new Map<string, {
  nodes: AXNodeFlat[];
  timestamp: number;
}>();

/**
 * Fetch (or return cached) AX tree, flattened and filtered.
 */
export async function getCachedAXTree(
  page: Page,
  cdpClient: CDPClient,
  depth: number = -1,
): Promise<AXNodeFlat[]> {
  const targetId = getTargetId(page.target());
  const cached = axCache.get(targetId);

  if (cached && Date.now() - cached.timestamp < AX_CACHE_TTL_MS) {
    return cached.nodes;
  }

  const { nodes } = await cdpClient.send<{ nodes: AXNode[] }>(
    page, 'Accessibility.getFullAXTree', { depth }
  );

  const flat: AXNodeFlat[] = [];
  for (const node of nodes) {
    if (!node.backendDOMNodeId) continue;
    const role = node.role?.value || '';
    if (SKIP_ROLES.has(role)) continue;

    const props: Record<string, unknown> = {};
    if (node.properties) {
      for (const p of node.properties) {
        props[p.name] = p.value.value;
      }
    }

    flat.push({
      nodeId: node.nodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      role,
      name: node.name?.value || '',
      value: node.value?.value,
      properties: props,
    });
  }

  axCache.set(targetId, { nodes: flat, timestamp: Date.now() });
  return flat;
}

/**
 * Invalidate AX cache for a page (call after interactions that mutate DOM).
 */
export function invalidateAXCache(pageTargetId: string): void {
  axCache.delete(pageTargetId);
}

/**
 * Clear entire AX cache (for testing or shutdown).
 */
export function clearAXCache(): void {
  axCache.clear();
}

// ─── Main Resolution Function ───

/**
 * Resolve elements by querying the Chrome Accessibility Tree.
 *
 * 1. Fetch (or use cached) AX tree
 * 2. Parse query into role hint + name hint
 * 3. Match and score AX nodes
 * 4. Resolve coordinates via DOM.getBoxModel for top matches
 *
 * Returns sorted array of matches (highest score first), or empty array
 * if no matches meet the minimum threshold (score >= 20).
 */
export async function resolveElementsByAXTree(
  page: Page,
  cdpClient: CDPClient,
  query: string,
  options?: AXResolveOptions,
): Promise<AXResolvedElement[]> {
  const { useCenter = true, maxResults = 5, depth = -1 } = options || {};

  // 1. Parse query
  const parsed = parseQueryForAX(query);

  // 2. Get AX tree
  const nodes = await getCachedAXTree(page, cdpClient, depth);
  if (nodes.length === 0) return [];

  // 3. Score all nodes
  const scored: Array<{ node: AXNodeFlat; score: number }> = [];
  for (const node of nodes) {
    const score = scoreAXNode(node, parsed.roleHint, parsed.nameHint, parsed.nameTokens);
    if (score >= 20) {
      scored.push({ node, score });
    }
  }

  if (scored.length === 0) return [];

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 4. Resolve coordinates for top matches
  const resolved: AXResolvedElement[] = [];
  for (const { node, score } of scored.slice(0, maxResults * 2)) { // fetch extra in case some fail
    if (resolved.length >= maxResults) break;

    try {
      const { model } = await cdpClient.send<{
        model: { content: number[] };
      }>(page, 'DOM.getBoxModel', {
        backendNodeId: node.backendDOMNodeId,
      });

      if (!model?.content || model.content.length < 8) continue;

      const x = model.content[0];
      const y = model.content[1];
      const width = model.content[2] - x;
      const height = model.content[5] - y;

      if (width <= 0 || height <= 0) continue;

      resolved.push({
        backendDOMNodeId: node.backendDOMNodeId,
        role: node.role,
        name: node.name,
        axScore: score,
        rect: {
          x: useCenter ? x + width / 2 : x,
          y: useCenter ? y + height / 2 : y,
          width,
          height,
        },
        properties: node.properties,
        source: 'ax',
      });
    } catch {
      // Element may not have layout — skip
      continue;
    }
  }

  return resolved;
}
