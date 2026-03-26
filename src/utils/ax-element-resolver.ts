/**
 * AX-First Element Resolution — Framework-agnostic element targeting via Chrome Accessibility Tree
 *
 * Uses the browser's built-in accessibility engine (which already understands all UI frameworks:
 * Angular Material, React MUI, Vue Vuetify, etc.) to resolve elements by role + name.
 *
 * Architecture: Cascading filter — no scoring, no magic numbers, fully deterministic.
 * Flow: query → parseQueryForAX → getCachedAXTree → cascading filter → DOM.getBoxModel → coordinates
 * Fallback: if AX resolution fails, callers fall back to existing CSS-based discoverElements().
 */

import type { Page } from 'puppeteer-core';
import type { CDPClient } from '../cdp/client';
import { getTargetId } from './puppeteer-helpers';
import { normalizeQuery } from './element-finder';

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

/**
 * Match level from cascading filter (1 = most precise, 4 = least precise).
 * Used instead of numeric scores — each level has a clear semantic meaning.
 */
export type MatchLevel = 1 | 2 | 3 | 4;

export const MATCH_LEVEL_LABELS: Record<MatchLevel, string> = {
  1: 'exact match',
  2: 'role match',
  3: 'name match',
  4: 'partial match',
};

/** Result of AX-based element resolution */
export interface AXResolvedElement {
  backendDOMNodeId: number;
  role: string;
  name: string;
  matchLevel: MatchLevel;
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
  // Localized role keywords — Korean (ko)
  // LLM clients send queries in the user's language; these map Korean UI terms to ARIA roles.
  // To add another locale: append entries here, longest-first within each language block.
  // Keep keywords >= 2 characters to avoid spurious matches.
  ['라디오 버튼', 'radio'],
  ['체크박스', 'checkbox'],
  ['콤보박스', 'combobox'],
  ['텍스트 필드', 'textbox'],
  ['검색창', 'searchbox'],
  ['메뉴 항목', 'menuitem'],
  ['드롭다운', 'combobox'],
  ['버튼', 'button'],
  ['링크', 'link'],
  ['스위치', 'switch'],
  ['슬라이더', 'slider'],
  ['이미지', 'image'],
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
 *   "로그인"              → { roleHint: null, nameHint: "로그인" }
 */
export function parseQueryForAX(query: string): ParsedAXQuery {
  // Use normalized form for keyword matching, but preserve original case in nameHint
  const queryNorm = normalizeQuery(query);
  const queryClean = query.normalize('NFC').replace(/["""'''`]/g, '').trim();

  for (const [keyword, role] of ROLE_KEYWORDS) {
    const idx = queryNorm.indexOf(keyword);
    if (idx !== -1) {
      // Slice from the case-preserving version using the same indices
      const before = queryClean.slice(0, idx).trim();
      const after = queryClean.slice(idx + keyword.length).trim();
      const nameHint = [before, after].filter(Boolean).join(' ').trim();

      return {
        roleHint: role,
        nameHint: nameHint || queryClean,
      };
    }
  }

  return {
    roleHint: null,
    nameHint: queryClean,
  };
}

// ─── Cascading Filter ───

/**
 * Filter AX nodes through a prioritized cascade.
 * Returns the first match at the highest (strictest) level.
 *
 * Level 1: exact role + exact name
 * Level 2: exact role + name contains
 * Level 3: exact name (any interactive role)
 * Level 4: name contains (any interactive role)
 *
 * No scoring, no magic numbers, fully deterministic.
 */
export function cascadeFilter(
  nodes: AXNodeFlat[],
  roleHint: string | null,
  nameHint: string,
  maxResults: number = 5,
): Array<{ node: AXNodeFlat; matchLevel: MatchLevel }> {
  // Pre-filter: remove disabled and non-interactive nodes
  const candidates = nodes.filter(n =>
    n.properties['disabled'] !== true &&
    INTERACTIVE_ROLES.has(n.role.toLowerCase())
  );

  const nameLower = nameHint.normalize('NFC').toLowerCase().trim();
  if (!nameLower) return [];

  const eq = (nodeName: string) => nodeName.normalize('NFC').toLowerCase().trim() === nameLower;
  const includes = (nodeName: string) => nodeName.normalize('NFC').toLowerCase().trim().includes(nameLower);

  // Level 1: exact role + exact name
  if (roleHint) {
    const level1 = candidates.filter(n => n.role.toLowerCase() === roleHint && eq(n.name));
    if (level1.length > 0) {
      return level1.slice(0, maxResults).map(node => ({ node, matchLevel: 1 as MatchLevel }));
    }
  }

  // Level 2: exact role + name contains
  if (roleHint) {
    const level2 = candidates.filter(n => n.role.toLowerCase() === roleHint && includes(n.name));
    if (level2.length > 0) {
      return level2.slice(0, maxResults).map(node => ({ node, matchLevel: 2 as MatchLevel }));
    }
  }

  // Level 3: exact name (any interactive role)
  const level3 = candidates.filter(n => eq(n.name));
  if (level3.length > 0) {
    return level3.slice(0, maxResults).map(node => ({ node, matchLevel: 3 as MatchLevel }));
  }

  // Level 4: name contains (any interactive role)
  const level4 = candidates.filter(n => includes(n.name));
  if (level4.length > 0) {
    return level4.slice(0, maxResults).map(node => ({ node, matchLevel: 4 as MatchLevel }));
  }

  return [];
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

/** Invalidate AX cache for a page (call after interactions that mutate DOM). */
export function invalidateAXCache(pageTargetId: string): void {
  axCache.delete(pageTargetId);
}

/** Clear entire AX cache (for testing or shutdown). */
export function clearAXCache(): void {
  axCache.clear();
}

// ─── Main Resolution Function ───

/**
 * Resolve elements by querying the Chrome Accessibility Tree.
 *
 * Uses a cascading filter (not scoring) to find elements:
 * Level 1: exact role + exact name → Level 2: role + contains → Level 3: exact name → Level 4: contains
 *
 * Returns array of matches at the highest (strictest) cascade level that produced results.
 * Empty array if no matches found (caller should fall back to CSS discovery).
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

  // 3. Cascading filter
  const matches = cascadeFilter(nodes, parsed.roleHint, parsed.nameHint, maxResults);
  if (matches.length === 0) return [];

  // 4. Resolve coordinates for matches
  const resolved: AXResolvedElement[] = [];
  for (const { node, matchLevel } of matches) {
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
        matchLevel,
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
      continue;
    }
  }

  return resolved;
}
