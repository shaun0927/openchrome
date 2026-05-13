/**
 * DOM Serializer - Converts CDP DOM tree into a compact text representation
 */

import type { Page } from 'puppeteer-core';
import { MAX_OUTPUT_CHARS, DEFAULT_MAX_SERIALIZER_NODES } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';

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
  'selected', 'required', 'class', 'for',
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

const INTERACTIVE_HINT_SCAN_MAX_MS = 100;
const INTERACTIVE_HINT_SCAN_MAX_ELEMENTS = 2500;

interface CustomInteractiveHint {
  path: string;
  hints: string;
}

interface CursorInteractiveScanResult {
  completed: boolean;
  inspected: number;
  hints: CustomInteractiveHint[];
}

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

function escapeAttributeValue(value: string): string {
  const escapedAmpersands = value.replace(/&/g, '&amp;');
  return escapedAmpersands
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Check if a node is interactive
 */
function isNativeInteractive(tagName: string, attrMap: Map<string, string>): boolean {
  if (INTERACTIVE_TAGS.has(tagName)) return true;
  const role = attrMap.get('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return false;
}

function isInteractive(tagName: string, attrMap: Map<string, string>, customHints?: string): boolean {
  return Boolean(customHints) || isNativeInteractive(tagName, attrMap);
}

/**
 * Check if a DOM node or any descendant contains interactive elements.
 * Prevents sibling dedup from collapsing groups with clickable elements.
 */
function containsInteractive(node: DOMNode, path: string, ctx: SerializeContext): boolean {
  if (node.nodeType !== NODE_TYPE_ELEMENT) return false;
  const tag = (node.localName || node.nodeName).toLowerCase();
  const attrMap = parseAttributes(node.attributes);
  if (isInteractive(tag, attrMap, ctx.customInteractiveHints.get(path))) return true;
  if (node.children) {
    const childPaths = createChildPathMap(node.children, path);
    for (const child of node.children) {
      if (containsInteractive(child, childPaths.get(child) ?? path, ctx)) return true;
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
  hints?: string,
): string {
  const tagName = node.localName || node.nodeName.toLowerCase();

  // Build attribute string with only kept attrs
  const attrParts: string[] = [];
  for (const [k, v] of attrMap) {
    if (KEEP_ATTRS.has(k)) {
      attrParts.push(`${k}="${escapeAttributeValue(v)}"`);
    }
  }
  const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';

  const interactiveMarker = interactive
    ? ` ★${hints ? ` [${hints}]` : ''}`
    : '';
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
function isCollapsibleContainer(node: DOMNode, path: string, ctx: SerializeContext): boolean {
  if (!node.children) return false;
  const tagName = (node.localName || node.nodeName).toLowerCase();
  if (!CONTAINER_TAGS.has(tagName)) return false;

  const attrMap = parseAttributes(node.attributes);
  if (isInteractive(tagName, attrMap, ctx.customInteractiveHints.get(path))) return false;

  const text = getDirectTextContent(node);
  if (text.length > 0) return false;

  const elementChildren = node.children.filter(c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase()));
  return elementChildren.length === 1;
}

/**
 * Collect a chain of single-child containers starting from node.
 * Returns the chain nodes and the leaf (first non-container or multi-child node).
 */
function collectContainerChain(node: DOMNode, path: string, ctx: SerializeContext): { chain: DOMNode[], leaf: DOMNode, leafPath: string } {
  const chain: DOMNode[] = [node];
  let current = node;
  let currentPath = path;

  while (chain.length < MAX_CONTAINER_CHAIN) {
    const elementChildren = (current.children || []).filter(
      c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase())
    );
    if (elementChildren.length !== 1) break;

    const child = elementChildren[0];
    const childPaths = createChildPathMap(current.children || [], currentPath);
    const childPath = childPaths.get(child) ?? currentPath;
    const childTag = (child.localName || child.nodeName).toLowerCase();
    if (!CONTAINER_TAGS.has(childTag)) break;

    const childAttrMap = parseAttributes(child.attributes);
    if (isInteractive(childTag, childAttrMap, ctx.customInteractiveHints.get(childPath))) break;
    if (getDirectTextContent(child).length > 0) break;

    chain.push(child);
    current = child;
    currentPath = childPath;
  }

  // The leaf is the deepest container's single element child, or the last container itself
  const lastChildren = (current.children || []).filter(
    c => c.nodeType === NODE_TYPE_ELEMENT && !SKIP_TAGS.has(c.nodeName.toUpperCase())
  );
  const leaf = lastChildren.length === 1 ? lastChildren[0] : current;
  const lastChildPaths = createChildPathMap(current.children || [], currentPath);
  const leafPath = lastChildPaths.get(leaf) ?? currentPath;

  // If leaf is same as last chain entry, the chain didn't find a true leaf
  if (leaf === current) {
    return { chain: [], leaf: node, leafPath: path }; // no collapse
  }

  return { chain, leaf, leafPath };
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
  nodesVisited: number;
  maxNodes: number;
  customInteractiveHints: Map<string, string>;
  /**
   * Tracks every backendNodeId emitted in the output so the caller can mint
   * a `[node_refs]` block for the #844 backend-node uid contract. Insertion
   * order is preserved so the output map mirrors the visual order of lines.
   */
  emittedBackendNodeIds: Set<number>;
}

function createChildPathMap(children: DOMNode[], parentPath: string): Map<DOMNode, string> {
  const paths = new Map<DOMNode, string>();
  let elementIndex = 0;
  for (const child of children) {
    if (child.nodeType !== NODE_TYPE_ELEMENT) continue;
    paths.set(child, `${parentPath}/c:${elementIndex}`);
    elementIndex += 1;
  }
  return paths;
}

function appendTruncationMarker(ctx: SerializeContext): void {
  const truncationMsg = `\n\n[Output truncated at ${ctx.maxOutputChars} chars. Use depth parameter to limit scope.]`;
  ctx.lines.push(truncationMsg);
  ctx.truncated = true;
}

function appendBoundedLine(ctx: SerializeContext, line: string): boolean {
  if (ctx.totalChars + line.length > ctx.maxOutputChars) {
    appendTruncationMarker(ctx);
    return false;
  }

  ctx.lines.push(line);
  ctx.totalChars += line.length;
  return true;
}

/**
 * Recursively serialize a DOM node
 */
function serializeNode(
  node: DOMNode,
  depth: number,
  ctx: SerializeContext,
  path = 'd',
): void {
  if (ctx.truncated) return;

  // Node count safety valve — prevent event loop blocking on massive DOMs
  ctx.nodesVisited++;
  if (ctx.nodesVisited > ctx.maxNodes) {
    ctx.truncated = true;
    const msg = `\n[Truncated: visited ${ctx.maxNodes.toLocaleString()} nodes — output limit reached]\n`;
    ctx.lines.push(msg);
    ctx.totalChars += msg.length;
    return;
  }

  // Handle document node - just recurse into children
  if (node.nodeType === NODE_TYPE_DOCUMENT) {
    if (node.children) {
      const childPaths = createChildPathMap(node.children, path);
      for (const child of node.children) {
        serializeNode(child, depth, ctx, childPaths.get(child) ?? path);
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
  const customHints = ctx.customInteractiveHints.get(path);
  const interactive = isInteractive(tagName, attrMap, customHints);

  const indent = '  '.repeat(depth);

  // Container chain collapse (only in non-'none' compression mode, non-interactive containers)
  if (ctx.compression !== 'none' && !interactive && isCollapsibleContainer(node, path, ctx)) {
    const { chain, leaf, leafPath } = collectContainerChain(node, path, ctx);
    if (chain.length >= 2) {
      // Build chain prefix: [10]div>[11]section>[12]div>
      const chainPrefix = chain.map(n => {
        const nTag = (n.localName || n.nodeName).toLowerCase();
        return `[${n.backendNodeId}]${nTag}`;
      }).join('>') + '> ';

      // Serialize the leaf: format its line but with chain prefix prepended
      const leafTag = leaf.localName || leaf.nodeName.toLowerCase();
      const leafAttrMap = parseAttributes(leaf.attributes);
      const leafHints = ctx.customInteractiveHints.get(leafPath);
      const leafInteractive = isInteractive(leafTag, leafAttrMap, leafHints);
      const leafText = getDirectTextContent(leaf);
      const leafLine = formatElement(leaf, leafAttrMap, '', leafText, leafInteractive, leafHints);
      const fullLine = `${indent}${chainPrefix}${leafLine}\n`;

      if (ctx.totalChars + fullLine.length > ctx.maxOutputChars) {
        appendTruncationMarker(ctx);
        return;
      }

      ctx.lines.push(fullLine);
      ctx.totalChars += fullLine.length;
      // Track every backendNodeId emitted in this collapsed chain so the
      // #844 [node_refs] block can mint stable uids for the entire visible
      // DOM tree (chain ancestors + leaf), not just leaves.
      for (const chainNode of chain) ctx.emittedBackendNodeIds.add(chainNode.backendNodeId);
      ctx.emittedBackendNodeIds.add(leaf.backendNodeId);

      // Recurse into leaf's children
      if (leaf.children) {
        const childPaths = createChildPathMap(leaf.children, leafPath);
        for (const child of leaf.children) {
          serializeNode(child, depth + 1, ctx, childPaths.get(child) ?? leafPath);
          if (ctx.truncated) return;
        }
      }
      return; // skip normal emission for the chain nodes
    }
  }

  if (!ctx.interactiveOnly || interactive) {
    const textContent = getDirectTextContent(node);
    const line = formatElement(node, attrMap, indent, textContent, interactive, customHints);
    const lineWithNewline = line + '\n';

    if (ctx.totalChars + lineWithNewline.length > ctx.maxOutputChars) {
      appendTruncationMarker(ctx);
      return;
    }

    ctx.lines.push(lineWithNewline);
    ctx.totalChars += lineWithNewline.length;
    // #844: track this node's backendNodeId so the [node_refs] block can
    // mint a stable uid for it.
    ctx.emittedBackendNodeIds.add(node.backendNodeId);
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
    serializeNode(node.contentDocument, depth + 1, ctx, `${path}/f`);
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
        appendTruncationMarker(ctx);
        return;
      }

      ctx.lines.push(separator);
      ctx.totalChars += separator.length;

      // Shadow root children at depth+2 (inside shadow root boundary)
      if (shadowRoot.children) {
        const shadowPath = `${path}/s:${node.shadowRoots.indexOf(shadowRoot)}`;
        const childPaths = createChildPathMap(shadowRoot.children, shadowPath);
        for (const child of shadowRoot.children) {
          serializeNode(child, depth + 2, ctx, childPaths.get(child) ?? shadowPath);
          if (ctx.truncated) return;
        }
      }
    }
  }

  // Recurse into children
  if (node.children && ctx.compression !== 'none') {
    const childPaths = createChildPathMap(node.children, path);
    const groups = groupConsecutiveSiblings(node.children);
    const threshold = ctx.compression === 'aggressive'
      ? SIBLING_COLLAPSE_THRESHOLD_AGGRESSIVE
      : SIBLING_COLLAPSE_THRESHOLD_LIGHT;

    for (const group of groups) {
      if (ctx.truncated) return;

      // Skip dedup for groups containing interactive elements to avoid
      // hiding clickable buttons/links/inputs from the LLM
      const groupHasInteractive = group.nodes.some(n => containsInteractive(n, childPaths.get(n) ?? path, ctx));

      if (group.nodes.length >= threshold && !groupHasInteractive) {
        // Emit first SIBLING_SAMPLE_COUNT with full detail
        const samples = group.nodes.slice(0, SIBLING_SAMPLE_COUNT);
        for (const sampleNode of samples) {
          serializeNode(sampleNode, depth + 1, ctx, childPaths.get(sampleNode) ?? path);
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
          // #844: the summary line surfaces the first/last backendNodeIds of
          // the dedup'd run; mint stable uids for both endpoints so callers
          // can refer to the range bounds without a fresh DOM read.
          ctx.emittedBackendNodeIds.add(firstRef);
          ctx.emittedBackendNodeIds.add(lastRef);
        }

        // Emit last node if not already shown
        if (group.nodes.length > SIBLING_SAMPLE_COUNT) {
          const lastNode = group.nodes[group.nodes.length - 1];
          serializeNode(lastNode, depth + 1, ctx, childPaths.get(lastNode) ?? path);
        }
      } else {
        // Small group — emit all normally
        for (const groupNode of group.nodes) {
          serializeNode(groupNode, depth + 1, ctx, childPaths.get(groupNode) ?? path);
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
    const childPaths = createChildPathMap(node.children, path);
    for (const child of node.children) {
      serializeNode(child, depth + 1, ctx, childPaths.get(child) ?? path);
      if (ctx.truncated) return;
    }
  }
}

async function scanCustomInteractiveElements(page: Page, pierceIframes: boolean): Promise<CursorInteractiveScanResult> {
  // Bound the browser-side scan from inside the evaluated function. Racing
  // page.evaluate with a timeout does not abort the in-page work.
  return await page.evaluate((maxMs: number, maxElements: number, includeIframes: boolean) => {
      const interactiveRoles = new Set([
        'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
        'menu', 'menuitem', 'tab', 'switch', 'slider',
      ]);
      const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
      type RootEntry = { root: Document | ShadowRoot; path: string };
      const roots: RootEntry[] = [{ root: document, path: 'd' }];
      const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      const deadline = now() + maxMs;
      let inspected = 0;
      let budgetExceeded = false;
      const hintsByPath: Array<{ path: string; hints: string }> = [];

      for (let i = 0; i < roots.length; i++) {
        const { root, path: rootPath } = roots[i];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let current = walker.nextNode();
        const paths = new WeakMap<Node, string>();
        const childIndexes = new WeakMap<Node, number>();
        while (current) {
          inspected += 1;
          if (inspected > maxElements || now() > deadline) {
            budgetExceeded = true;
            break;
          }

          const el = current as HTMLElement;
          const parent = el.parentNode;
          const siblingIndex = childIndexes.get(parent as Node) ?? 0;
          childIndexes.set(parent as Node, siblingIndex + 1);
          const parentPath = parent === root
            ? rootPath
            : (paths.get(parent as Node) ?? rootPath);
          const path = `${parentPath}/c:${siblingIndex}`;
          paths.set(el, path);

          if (el.shadowRoot) roots.push({ root: el.shadowRoot, path: `${path}/s:0` });
          if (includeIframes && el.tagName.toLowerCase() === 'iframe') {
            try {
              const frame = el as HTMLIFrameElement;
              if (frame.contentDocument) roots.push({ root: frame.contentDocument, path: `${path}/f` });
            } catch {
              // Cross-origin frames are represented by CDP when possible; page
              // script cannot inspect them, so custom hints are best-effort.
            }
          }
          current = walker.nextNode();

          if (el.closest('[hidden], [aria-hidden="true"]')) continue;

          const tag = el.tagName.toLowerCase();
          if (interactiveTags.has(tag)) continue;
          const role = el.getAttribute('role');
          if (role && interactiveRoles.has(role.toLowerCase())) continue;

          const style = getComputedStyle(el);
          const hasCursorPointer = style.cursor === 'pointer';
          const hasOnClick = el.hasAttribute('onclick') || typeof el.onclick === 'function';
          const tabIndex = el.getAttribute('tabindex');
          const hasTabIndex = tabIndex !== null && tabIndex !== '-1';
          const editable = el.getAttribute('contenteditable');
          const isEditable = el.isContentEditable || editable === '' || editable === 'true' || editable === 'plaintext-only';

          if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) continue;
          if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
            const parent = el.parentElement;
            if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const hints: string[] = [];
          if (hasCursorPointer) hints.push('cursor:pointer');
          if (hasOnClick) hints.push('onclick');
          if (hasTabIndex) hints.push('tabindex');
          if (isEditable) hints.push('contenteditable');

          const hiddenInput = el.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
          if (hiddenInput) {
            const inputStyle = getComputedStyle(hiddenInput);
            const hidden = inputStyle.display === 'none' || inputStyle.visibility === 'hidden' || hiddenInput.hidden;
            if (hidden) {
              hints.push(`${hiddenInput.type}:${hiddenInput.indeterminate ? 'mixed' : String(hiddenInput.checked)}`);
            }
          }

          hintsByPath.push({ path, hints: hints.join(', ') });
        }
        if (budgetExceeded) break;
      }

      return { completed: !budgetExceeded, inspected, hints: hintsByPath };
    }, INTERACTIVE_HINT_SCAN_MAX_MS, INTERACTIVE_HINT_SCAN_MAX_ELEMENTS, pierceIframes);
}

/**
 * Serialize a page's DOM into a compact text representation
 */
export async function serializeDOM(
  page: Page,
  cdpClient: CDPClientLike,
  options?: DOMSerializerOptions,
): Promise<{
  content: string;
  pageStats: PageStats;
  truncated: boolean;
  /**
   * Backend node ids emitted into `content`, in insertion order. Callers
   * use this to mint the #844 backend-node uid contract `[node_refs]`
   * mapping block for the response.
   */
  emittedBackendNodeIds: number[];
}> {
  const maxDepth = options?.maxDepth ?? -1;
  const maxOutputChars = options?.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const includePageStats = options?.includePageStats ?? true;
  const pierceIframes = options?.pierceIframes ?? true;
  const interactiveOnly = (options?.interactiveOnly ?? false) || options?.filter === 'interactive';
  const compression = options?.compression ?? 'light';  // default to 'light'
  const includeUserAgentShadowDOM = options?.includeUserAgentShadowDOM ?? false;

  // Get page stats via page.evaluate
  const pageStats = await withTimeout(
    page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })),
    15000,
    'serializeDOM:pageStats',
  ) as PageStats;

  let customInteractiveHints = new Map<string, string>();
  if (interactiveOnly) {
    try {
      const scanResult = await scanCustomInteractiveElements(page, pierceIframes);
      if (scanResult.completed) {
        customInteractiveHints = new Map(scanResult.hints.map(({ path, hints }) => [path, hints]));
      }
    } catch {
      // Cursor/onclick hint discovery is opportunistic. Large or hostile pages
      // should still serialize using native tags and ARIA roles if this pre-scan
      // times out or throws.
      customInteractiveHints = new Map();
    }
  }

  // Get DOM tree via CDP. Always pierce at the CDP layer so shadowRoots are
  // present; ctx.pierceIframes below controls whether iframe contentDocument
  // subtrees are emitted. When callers request bounded output depth, avoid
  // fetching the full document up front where possible. CDP's depth starts at
  // the document root, while this serializer starts element indentation at the
  // document element, so add one level to preserve existing maxDepth output
  // semantics. When emitting iframes, the serializer's document handler
  // iterates contentDocument children at the same depth, so each iframe nesting
  // level introduces an unbounded gap between serializer-depth and CDP-depth —
  // fall back to an unbounded CDP fetch in that case so iframe body content
  // within maxDepth is not silently dropped.
  const documentDepth = maxDepth >= 0 && !pierceIframes ? maxDepth + 1 : -1;
  const { root } = await cdpClient.send<{ root: DOMNode }>(
    page,
    'DOM.getDocument',
    { depth: documentDepth, pierce: true },
  );

  const ctx: SerializeContext = {
    lines: [],
    totalChars: 0,
    truncated: false,
    maxOutputChars,
    maxDepth,
    pierceIframes,
    interactiveOnly,
    compression,
    includeUserAgentShadowDOM,
    nodesVisited: 0,
    maxNodes: DEFAULT_MAX_SERIALIZER_NODES,
    customInteractiveHints,
    emittedBackendNodeIds: new Set<number>(),
  };

  // Add page stats header through the same bounded append path as DOM lines.
  if (includePageStats) {
    const statsLine = `[page_stats] url: ${pageStats.url} | title: ${pageStats.title} | scroll: ${pageStats.scrollX},${pageStats.scrollY} | viewport: ${pageStats.viewportWidth}x${pageStats.viewportHeight} | docSize: ${pageStats.scrollWidth}x${pageStats.scrollHeight}\n\n`;
    appendBoundedLine(ctx, statsLine);
  }

  // Serialize from root
  if (!ctx.truncated) {
    serializeNode(root, 0, ctx);
  }

  const content = ctx.lines.join('');

  return {
    content,
    pageStats,
    truncated: ctx.truncated,
    emittedBackendNodeIds: Array.from(ctx.emittedBackendNodeIds),
  };
}
