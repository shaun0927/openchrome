/**
 * DOM Serializer - Converts CDP DOM tree into a compact text representation
 */

import type { Page } from 'puppeteer-core';
import { MAX_OUTPUT_CHARS } from '../config/defaults';

export interface DOMSerializerOptions {
  maxDepth?: number;                    // default: -1 (unlimited)
  maxOutputChars?: number;              // default: 50000
  includePageStats?: boolean;           // default: true
  pierceIframes?: boolean;              // default: true
  interactiveOnly?: boolean;            // default: false
  filter?: string;                      // 'interactive' | 'all', default: 'all'
  compression?: 'none' | 'light' | 'aggressive';
  // none: no sibling dedup or container collapse (backward compat)
  // light (default): sibling dedup threshold=4, container collapse enabled
  // aggressive: sibling dedup threshold=3
  includeUserAgentShadowDOM?: boolean;  // default: false
}

export interface PageStats {
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

// CDPClient interface to avoid circular imports
interface CDPClientLike {
  send<T = unknown>(page: Page, method: string, params?: Record<string, unknown>): Promise<T>;
}

// CDP DOM node structure
interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  attributes?: string[];   // flat array: [name1, value1, name2, value2, ...]
  children?: DOMNode[];
  contentDocument?: DOMNode;
  nodeValue?: string;
  shadowRoots?: DOMNode[];
  shadowRootType?: 'open' | 'closed' | 'user-agent';
}

// Node types
const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_DOCUMENT = 9;

// Tags to skip entirely
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'META', 'LINK', 'HEAD', '#comment',
]);

// Attributes to keep
const KEEP_ATTRS = new Set([
  'id', 'name', 'type', 'value', 'placeholder', 'aria-label', 'role',
  'href', 'src', 'alt', 'title', 'data-testid', 'disabled', 'checked',
  'selected', 'required', 'class',
  // Common data attributes for testing and automation
  'data-cy', 'data-qa', 'data-id', 'data-value', 'data-state',
  'tabindex',
]);

// Interactive tag names
const INTERACTIVE_TAGS = new Set([
  'input', 'button', 'select', 'textarea', 'a',
]);

// Interactive roles
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menu', 'menuitem', 'tab', 'switch', 'slider',
]);

// Compression constants
const SIBLING_COLLAPSE_THRESHOLD_LIGHT = 4;
const SIBLING_COLLAPSE_THRESHOLD_AGGRESSIVE = 3;
const SIBLING_SAMPLE_COUNT = 3;
const MAX_CONTAINER_CHAIN = 8;

const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'span',
]);

/**
 * Parse flat attributes array into a map
 */
function parseAttributes(attrs: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!attrs) return map;
  for (let i = 0; i < attrs.length - 1; i += 2) {
    map.set(attrs[i], attrs[i + 1]);
  }
  return map;
}

/**
 * Check if a node is interactive
 */
function isInteractive(tagName: string, attrMap: Map<string, string>): boolean {
  if (INTERACTIVE_TAGS.has(tagName)) return true;
  const role = attrMap.get('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return false;
}

/**
 * Check if a DOM node or any descendant contains interactive elements.
 * Prevents sibling dedup from collapsing groups with clickable elements.
 */
function containsInteractive(node: DOMNode): boolean {
  if (node.nodeType !== NODE_TYPE_ELEMENT) return false;
  const tag = (node.localName || node.nodeName).toLowerCase();
  const attrMap = parseAttributes(node.attributes);
  if (isInteractive(tag, attrMap)) return true;
  if (node.children) {
    for (const child of node.children) {
      if (containsInteractive(child)) return true;
    }
  }
  return false;
}

/**
 * Get direct text content from immediate text node children (not deep)
 */
function getDirectTextContent(node: DOMNode): string {
  if (!node.children) return '';
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.nodeType === NODE_TYPE_TEXT && child.nodeValue) {
      const text = child.nodeValue.trim();
      if (text) parts.push(text);
    }
  }
  const combined = parts.join(' ');
  return combined.length > 200 ? combined.slice(0, 200) : combined;
}

/**
 * Format a single element node as a line
 */
function formatElement(
  node: DOMNode,
  attrMap: Map<string, string>,
  indent: string,
  textContent: string,
  interactive: boolean,
): string {
  const tagName = node.localName || node.nodeName.toLowerCase();

  // Build attribute string with only kept attrs
  const attrParts: string[] = [];
  for (const [k, v] of attrMap) {
    if (KEEP_ATTRS.has(k)) {
      attrParts.push(`${k}="${v}"`);
    }
  }
  const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';

  const interactiveMarker = interactive ? ' ★' : '';
  const line = `${indent}[${node.backendNodeId}]<${tagName}${attrStr}/>${textContent}${interactiveMarker}`;
  return line;
}

/**
 * Check if a node is a collapsible container:
 * - Is a container tag (div, section, etc.)
 * - Has exactly 1 element child
 * - Has no meaningful text content
 * - Is NOT interactive
 */
function isCollapsibleContainer(node: DOMNode): boolean {
  if (!node.children) return false;
  const tagName = (node.localName || node.nodeName).toLowerCase();
  if (!CONTAINER_TAGS.has(tagName)) return false;

  const attrMap = parseAttributes(node.attributes);
  if (isInteractive(tagName, attrMap)) return false;

  const text = getDirectTextContent(node);
  if (text.length > 0) return false;

  const elementChildren = node.children.filter(c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase()));
  return elementChildren.length === 1;
}

/**
 * Collect a chain of single-child containers starting from node.
 * Returns the chain nodes and the leaf (first non-container or multi-child node).
 */
function collectContainerChain(node: DOMNode): { chain: DOMNode[], leaf: DOMNode } {
  const chain: DOMNode[] = [node];
  let current = node;

  while (chain.length < MAX_CONTAINER_CHAIN) {
    const elementChildren = (current.children || []).filter(
      c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase())
    );
    if (elementChildren.length !== 1) break;

    const child = elementChildren[0];
    const childTag = (child.localName || child.nodeName).toLowerCase();
    if (!CONTAINER_TAGS.has(childTag)) break;

    const childAttrMap = parseAttributes(child.attributes);
    if (isInteractive(childTag, childAttrMap)) break;
    if (getDirectTextContent(child).length > 0) break;

    chain.push(child);
    current = child;
  }

  // The leaf is the deepest container's single element child, or the last container itself
  const lastChildren = (current.children || []).filter(
    c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase())
  );
  const leaf = lastChildren.length === 1 ? lastChildren[0] : current;

  // If leaf is same as last chain entry, the chain didn't find a true leaf
  if (leaf === current) {
    return { chain: [], leaf: node }; // no collapse
  }

  return { chain, leaf };
}

interface SiblingGroup {
  tag: string;
  nodes: DOMNode[];
}

/**
 * Group consecutive children by tag name for sibling deduplication
 */
function groupConsecutiveSiblings(children: DOMNode[]): SiblingGroup[] {
  const groups: SiblingGroup[] = [];
  let currentGroup: SiblingGroup | null = null;

  for (const child of children) {
    if (child.nodeType !== NODE_TYPE_ELEMENT) continue;
    const tagUpper = child.nodeName.toUpperCase();
    if (SKIP_TAGS.has(tagUpper)) continue;

    const tag = (child.localName || child.nodeName).toLowerCase();

    if (currentGroup && currentGroup.tag === tag) {
      currentGroup.nodes.push(child);
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { tag, nodes: [child] };
    }
  }
  if (currentGroup) groups.push(currentGroup);

  return groups;
}

interface SerializeContext {
  lines: string[];
  totalChars: number;
  truncated: boolean;
  maxOutputChars: number;
  maxDepth: number;
  pierceIframes: boolean;
  interactiveOnly: boolean;
  compression: 'none' | 'light' | 'aggressive';
  includeUserAgentShadowDOM: boolean;
}

/**
 * Recursively serialize a DOM node
 */
function serializeNode(
  node: DOMNode,
  depth: number,
  ctx: SerializeContext,
): void {
  if (ctx.truncated) return;

  // Handle document node - just recurse into children
  if (node.nodeType === NODE_TYPE_DOCUMENT) {
    if (node.children) {
      for (const child of node.children) {
        serializeNode(child, depth, ctx);
        if (ctx.truncated) return;
      }
    }
    return;
  }

  // Skip non-element nodes at this level
  if (node.nodeType !== NODE_TYPE_ELEMENT) return;

  const tagUpper = node.nodeName.toUpperCase();

  // Skip invisible/irrelevant nodes
  if (SKIP_TAGS.has(tagUpper)) return;

  // Depth limiting
  if (ctx.maxDepth >= 0 && depth > ctx.maxDepth) return;

  const tagName = node.localName || node.nodeName.toLowerCase();
  const attrMap = parseAttributes(node.attributes);
  const interactive = isInteractive(tagName, attrMap);

  const indent = '  '.repeat(depth);

  // Container chain collapse (only in non-'none' compression mode, non-interactive containers)
  if (ctx.compression !== 'none' && !interactive && isCollapsibleContainer(node)) {
    const { chain, leaf } = collectContainerChain(node);
    if (chain.length >= 2) {
      // Build chain prefix: [10]div>[11]section>[12]div>
      const chainPrefix = chain.map(n => {
        const nTag = (n.localName || n.nodeName).toLowerCase();
        return `[${n.backendNodeId}]${nTag}`;
      }).join('>') + '> ';

      // Serialize the leaf: format its line but with chain prefix prepended
      const leafTag = leaf.localName || leaf.nodeName.toLowerCase();
      const leafAttrMap = parseAttributes(leaf.attributes);
      const leafInteractive = isInteractive(leafTag, leafAttrMap);
      const leafText = getDirectTextContent(leaf);
      const leafLine = formatElement(leaf, leafAttrMap, '', leafText, leafInteractive);
      const fullLine = `${indent}${chainPrefix}${leafLine}\n`;

      if (ctx.totalChars + fullLine.length > ctx.maxOutputChars) {
        const truncationMsg = `\n\n[Output truncated at ${ctx.maxOutputChars} chars. Use depth parameter to limit scope.]`;
        ctx.lines.push(truncationMsg);
        ctx.truncated = true;
        return;
      }

      ctx.lines.push(fullLine);
      ctx.totalChars += fullLine.length;

      // Recurse into leaf's children
      if (leaf.children) {
        for (const child of leaf.children) {
          serializeNode(child, depth + 1, ctx);
          if (ctx.truncated) return;
        }
      }
      return; // skip normal emission for the chain nodes
    }
  }

  if (!ctx.interactiveOnly || interactive) {
    const textContent = getDirectTextContent(node);
    const line = formatElement(node, attrMap, indent, textContent, interactive);
    const lineWithNewline = line + '\n';

    if (ctx.totalChars + lineWithNewline.length > ctx.maxOutputChars) {
      const truncationMsg = `\n\n[Output truncated at ${ctx.maxOutputChars} chars. Use depth parameter to limit scope.]`;
      ctx.lines.push(truncationMsg);
      ctx.truncated = true;
      return;
    }

    ctx.lines.push(lineWithNewline);
    ctx.totalChars += lineWithNewline.length;
  }

  // Handle iframe content document
  if (ctx.pierceIframes && node.contentDocument) {
    // Get src attribute for the separator
    const src = attrMap.get('src') || '';
    const separator = `${indent}--page-separator-- iframe: ${src}\n`;
    if (ctx.totalChars + separator.length <= ctx.maxOutputChars) {
      ctx.lines.push(separator);
      ctx.totalChars += separator.length;
    }
    serializeNode(node.contentDocument, depth + 1, ctx);
    return; // children are inside contentDocument
  }

  // Handle shadow roots (before regular children to match DOM rendering order)
  if (node.shadowRoots && node.shadowRoots.length > 0) {
    for (const shadowRoot of node.shadowRoots) {
      if (ctx.truncated) return;

      // Skip user-agent shadow roots unless explicitly requested
      if (!ctx.includeUserAgentShadowDOM && shadowRoot.shadowRootType === 'user-agent') continue;

      const shadowType = shadowRoot.shadowRootType || 'open';
      const childIndent = '  '.repeat(depth + 1);
      const separator = `${childIndent}--shadow-root-- (${shadowType})\n`;

      if (ctx.totalChars + separator.length > ctx.maxOutputChars) {
        const truncationMsg = `\n\n[Output truncated at ${ctx.maxOutputChars} chars. Use depth parameter to limit scope.]`;
        ctx.lines.push(truncationMsg);
        ctx.truncated = true;
        return;
      }

      ctx.lines.push(separator);
      ctx.totalChars += separator.length;

      // Shadow root children at depth+2 (inside shadow root boundary)
      if (shadowRoot.children) {
        for (const child of shadowRoot.children) {
          serializeNode(child, depth + 2, ctx);
          if (ctx.truncated) return;
        }
      }
    }
  }

  // Recurse into children
  if (node.children && ctx.compression !== 'none') {
    const groups = groupConsecutiveSiblings(node.children);
    const threshold = ctx.compression === 'aggressive'
      ? SIBLING_COLLAPSE_THRESHOLD_AGGRESSIVE
      : SIBLING_COLLAPSE_THRESHOLD_LIGHT;

    for (const group of groups) {
      if (ctx.truncated) return;

      // Skip dedup for groups containing interactive elements to avoid
      // hiding clickable buttons/links/inputs from the LLM
      const groupHasInteractive = group.nodes.some(n => containsInteractive(n));

      if (group.nodes.length >= threshold && !groupHasInteractive) {
        // Emit first SIBLING_SAMPLE_COUNT with full detail
        const samples = group.nodes.slice(0, SIBLING_SAMPLE_COUNT);
        for (const sampleNode of samples) {
          serializeNode(sampleNode, depth + 1, ctx);
          if (ctx.truncated) return;
        }

        // Emit summary line
        const firstRef = group.nodes[0].backendNodeId;
        const lastRef = group.nodes[group.nodes.length - 1].backendNodeId;
        const groupIndent = '  '.repeat(depth + 1);
        const summaryLine = `${groupIndent}[${firstRef}-${lastRef}] ${group.tag} \u00d7${group.nodes.length} (showing ${SIBLING_SAMPLE_COUNT} of ${group.nodes.length})\n`;

        if (ctx.totalChars + summaryLine.length <= ctx.maxOutputChars) {
          ctx.lines.push(summaryLine);
          ctx.totalChars += summaryLine.length;
        }

        // Emit last node if not already shown
        if (group.nodes.length > SIBLING_SAMPLE_COUNT) {
          const lastNode = group.nodes[group.nodes.length - 1];
          serializeNode(lastNode, depth + 1, ctx);
        }
      } else {
        // Small group — emit all normally
        for (const groupNode of group.nodes) {
          serializeNode(groupNode, depth + 1, ctx);
          if (ctx.truncated) return;
        }
      }
    }

    // Also handle text nodes that groupConsecutiveSiblings skipped
    for (const child of node.children) {
      if (child.nodeType === NODE_TYPE_TEXT && child.nodeValue) {
        // Text nodes are handled inline via getDirectTextContent on parent,
        // so we skip them here to avoid double-rendering
      }
    }
  } else if (node.children) {
    // Original behavior when compression is 'none'
    for (const child of node.children) {
      serializeNode(child, depth + 1, ctx);
      if (ctx.truncated) return;
    }
  }
}

/**
 * Serialize a page's DOM into a compact text representation
 */
export async function serializeDOM(
  page: Page,
  cdpClient: CDPClientLike,
  options?: DOMSerializerOptions,
): Promise<{ content: string; pageStats: PageStats; truncated: boolean }> {
  const maxDepth = options?.maxDepth ?? -1;
  const maxOutputChars = options?.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const includePageStats = options?.includePageStats ?? true;
  const pierceIframes = options?.pierceIframes ?? true;
  const interactiveOnly = (options?.interactiveOnly ?? false) || options?.filter === 'interactive';
  const compression = options?.compression ?? 'light';  // default to 'light'
  const includeUserAgentShadowDOM = options?.includeUserAgentShadowDOM ?? false;

  // Get page stats via page.evaluate
  const pageStats = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  })) as PageStats;

  // Get full DOM tree via CDP
  const { root } = await cdpClient.send<{ root: DOMNode }>(
    page,
    'DOM.getDocument',
    { depth: -1, pierce: true },
  );

  const lines: string[] = [];

  // Add page stats header
  if (includePageStats) {
    const statsLine = `[page_stats] url: ${pageStats.url} | title: ${pageStats.title} | scroll: ${pageStats.scrollX},${pageStats.scrollY} | viewport: ${pageStats.viewportWidth}x${pageStats.viewportHeight} | docSize: ${pageStats.scrollWidth}x${pageStats.scrollHeight}\n\n`;
    lines.push(statsLine);
  }

  const ctx: SerializeContext = {
    lines,
    totalChars: lines.reduce((acc, l) => acc + l.length, 0),
    truncated: false,
    maxOutputChars,
    maxDepth,
    pierceIframes,
    interactiveOnly,
    compression,
    includeUserAgentShadowDOM,
  };

  // Serialize from root
  serializeNode(root, 0, ctx);

  const content = ctx.lines.join('');

  return {
    content,
    pageStats,
    truncated: ctx.truncated,
  };
}
