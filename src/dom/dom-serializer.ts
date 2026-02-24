/**
 * DOM Serializer - Converts CDP DOM tree into a compact text representation
 */

import type { Page } from 'puppeteer-core';
import { MAX_OUTPUT_CHARS } from '../config/defaults';

export interface DOMSerializerOptions {
  maxDepth?: number;           // default: -1 (unlimited)
  maxOutputChars?: number;     // default: 50000
  includePageStats?: boolean;  // default: true
  pierceIframes?: boolean;     // default: true
  interactiveOnly?: boolean;   // default: false
  filter?: string;             // 'interactive' | 'all', default: 'all'
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

  const line = `${indent}[${node.backendNodeId}]<${tagName}${attrStr}/>${textContent}`;
  return line;
}

interface SerializeContext {
  lines: string[];
  totalChars: number;
  truncated: boolean;
  maxOutputChars: number;
  maxDepth: number;
  pierceIframes: boolean;
  interactiveOnly: boolean;
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

  if (!ctx.interactiveOnly || interactive) {
    const textContent = getDirectTextContent(node);
    const line = formatElement(node, attrMap, indent, textContent);
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

  // Recurse into children
  if (node.children) {
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
    const statsLine = `[page_stats] url: ${pageStats.url} | title: ${pageStats.title} | scroll: ${pageStats.scrollX},${pageStats.scrollY} | viewport: ${pageStats.viewportWidth}x${pageStats.viewportHeight}\n\n`;
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
