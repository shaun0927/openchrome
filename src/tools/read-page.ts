/**
 * Read Page Tool - Get accessibility tree representation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, throwIfAborted } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { serializeDOM } from '../dom';
import { detectPagination, PaginationInfo } from '../utils/pagination-detector';
import { MAX_OUTPUT_CHARS } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';
import { SnapshotStore } from '../compression/snapshot-store';
import { sanitizeContent } from '../security/content-sanitizer';
import { getGlobalConfig } from '../config/global';
import {
  buildSemanticView,
  type SemanticAXNode,
  type SemanticDomElement,
  type SemanticRuleSet,
} from '../core/perception/semantic';
import semanticRulesJson from '../core/perception/semantic-rules.json';

function formatPaginationSection(pagination: PaginationInfo): string {
  if (pagination.type === 'none') return '';
  const lines: string[] = ['', '[Pagination Detected]'];
  lines.push(`Type: ${pagination.type}`);
  if (pagination.currentPage !== undefined && pagination.totalPages !== undefined) {
    lines.push(`Pages: ${pagination.currentPage} / ${pagination.totalPages}`);
  } else if (pagination.totalPages !== undefined) {
    lines.push(`Total Pages: ${pagination.totalPages}`);
  }
  lines.push(`Strategy: ${pagination.suggestedStrategy}`);
  return lines.join('\n');
}

const definition: MCPToolDefinition = {
  name: 'read_page',
  description: 'Get page as DOM, accessibility tree (ax), or CSS diagnostics.\n\nWhen to use: Reading page structure, verifying content, or extracting the full DOM tree.\nWhen NOT to use: Use inspect for targeted state queries or find to locate a specific element.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to read from',
      },
      depth: {
        type: 'number',
        description: 'Max tree depth. Default: 8 (all), 5 (interactive)',
      },
      filter: {
        type: 'string',
        enum: ['interactive', 'all'],
        description: 'Filter: interactive for form/button/link only',
      },
      ref_id: {
        type: 'string',
        description: 'Parent ref for subtree scoping',
      },
      selector: {
        type: 'string',
        description: 'CSS selector (css mode only)',
      },
      mode: {
        type: 'string',
        enum: ['ax', 'dom', 'css', 'semantic'],
        description: 'Output mode: dom (default), ax, css, or semantic',
      },
      includePagination: {
        type: 'boolean',
        description: 'Include pagination info. Default: true',
      },
      compression: {
        type: 'string',
        enum: ['none', 'delta'],
        description: 'Compression mode. "delta" returns only changes since last read.',
      },
      fallback: {
        type: 'string',
        enum: ['none', 'dom'],
        description: 'AX mode only: use "dom" to explicitly fall back to DOM output if AX output exceeds the output budget. Default: none.',
      },
      compact: {
        type: 'boolean',
        description: 'AX mode only: return a compact AX snapshot that keeps actionable/ref-bearing nodes, value/state nodes, and ancestors. Default: false.',
      },
    },
    required: ['tabId'],
  },
};


function compactAXLines(lines: string[]): string[] {
  const keep = new Set<number>();
  const stack: Array<{ indent: number; index: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^ */)?.[0].length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const actionableOrValuable =
      line.includes('[ref_') ||
      line.includes(' = "') ||
      /\((focused|disabled|checked|selected|expanded)/.test(line);

    if (actionableOrValuable) {
      keep.add(i);
      for (const ancestor of stack) {
        keep.add(ancestor.index);
      }
    }

    stack.push({ indent, index: i });
  }

  return lines.filter((_, index) => keep.has(index));
}

interface AXNode {
  nodeId: number;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  childIds?: number[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const filter = (args.filter as string) || 'all';
  const defaultDepth = filter === 'interactive' ? 5 : 8;
  const maxDepth = (args.depth as number) || defaultDepth;
  const fetchDepth = maxDepth;

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // Mode dispatch
    const mode = (args.mode as string) || 'dom';
    if (mode !== 'ax' && mode !== 'dom' && mode !== 'css' && mode !== 'semantic') {
      return {
        content: [{ type: 'text', text: `Error: Invalid mode "${mode}". Must be "ax", "dom", "css", or "semantic".` }],
        isError: true,
      };
    }
    const axOverflowFallback = (args.fallback as string | undefined) || 'none';
    const compactAX = args.compact === true;
    if (axOverflowFallback !== 'none' && axOverflowFallback !== 'dom') {
      return {
        content: [{ type: 'text', text: `Error: Invalid fallback "${axOverflowFallback}". Must be "none" or "dom".` }],
        isError: true,
      };
    }

    // Validate selector is only used with CSS mode
    if (mode !== 'css' && args.selector) {
      return {
        content: [{ type: 'text', text: 'Error: "selector" parameter is only supported in mode="css". Use ref_id for subtree scoping in "ax" mode.' }],
        isError: true,
      };
    }

    // CSS diagnostic mode — extracts computed styles, CSS variables, and framework info
    if (mode === 'css') {
      const targetSelector = args.selector as string | undefined;
      const cssResult = await withTimeout(page.evaluate((sel: string | undefined) => {
        const output: {
          cssVariables: Record<string, string>;
          framework: { css: string; js: string };
          elements: Array<{
            selector: string;
            count: number;
            sample: Record<string, string>;
            pseudoBefore: boolean;
            pseudoAfter: boolean;
          }>;
        } = { cssVariables: {}, framework: { css: 'unknown', js: 'unknown' }, elements: [] };

        // 1. Extract CSS custom properties from :root
        try {
          const rootStyles = getComputedStyle(document.documentElement);
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === ':root, :host')) {
                  for (let i = 0; i < rule.style.length; i++) {
                    const prop = rule.style[i];
                    if (prop.startsWith('--')) {
                      output.cssVariables[prop] = rootStyles.getPropertyValue(prop).trim();
                    }
                  }
                }
              }
            } catch { /* cross-origin stylesheet */ }
          }
        } catch { /* no stylesheets */ }

        // 2. Framework detection
        const html = document.documentElement;
        // CSS framework
        const hasTwPrefix = !!document.querySelector('[class*="tw-"]');
        const hasTwV4Indicator = !!document.querySelector('style[data-precedence]') && hasTwPrefix;
        const hasTwUtilities = !!(html.className.match(/dark|light/) && document.querySelector('[class*="flex"]') && document.querySelector('[class*="px-"]'));
        if (hasTwPrefix || hasTwV4Indicator || hasTwUtilities) {
          output.framework.css = hasTwV4Indicator ? 'tailwind-v4' : 'tailwind';
        } else if (document.querySelector('[class*="css-"]')) {
          output.framework.css = 'css-in-js (emotion/styled-components)';
        } else if (document.querySelector('[class*="MuiBox"]')) {
          output.framework.css = 'material-ui';
        }
        // JS framework
        if ((document as any).__next_f || document.getElementById('__next')) {
          output.framework.js = 'next.js';
        } else if ((window as any).__NUXT__) {
          output.framework.js = 'nuxt';
        } else if (document.querySelector('[data-reactroot]') || document.querySelector('#__next') || (document.querySelector('[id]') as any)?._reactRootContainer) {
          output.framework.js = 'react';
        } else if ((window as any).__VUE__) {
          output.framework.js = 'vue';
        }

        // 3. Inspect elements with visual properties
        const VISUAL_PROPS = [
          'borderRadius', 'boxShadow', 'clipPath', 'overflow', 'opacity',
          'backdropFilter', 'outline', 'border', 'background',
        ] as const;
        const DEFAULT_VALUES: Record<string, string[]> = {
          borderRadius: ['0px'],
          boxShadow: ['none'],
          clipPath: ['none'],
          overflow: ['visible'],
          opacity: ['1'],
          backdropFilter: ['none'],
          outline: ['none', 'rgb(0, 0, 0) none 0px'],
          border: ['0px none rgb(0, 0, 0)', '0px'],
          background: ['rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box', 'rgba(0, 0, 0, 0)'],
        };

        const MAX_ELEMENTS = 2000;
        const rawElements = sel ? document.querySelectorAll(sel) : document.querySelectorAll('body *');
        const elements = Array.from(rawElements).slice(0, MAX_ELEMENTS);
        const seen = new Map<string, { count: number; sample: Record<string, string>; pseudoBefore: boolean; pseudoAfter: boolean }>();

        for (const el of elements) {
          if (!(el instanceof HTMLElement) || el.offsetWidth === 0) continue;
          const s = getComputedStyle(el);
          const interesting: Record<string, string> = {};
          for (const prop of VISUAL_PROPS) {
            const val = s[prop as any] as string;
            const defaults = DEFAULT_VALUES[prop] || [];
            if (val && !defaults.includes(val)) {
              interesting[prop] = val.length > 80 ? val.substring(0, 80) + '...' : val;
            }
          }
          if (Object.keys(interesting).length === 0) continue;

          // Build a representative selector
          const tag = el.tagName.toLowerCase();
          const classes = Array.from(el.classList).slice(0, 3).join('.');
          const key = classes ? `${tag}.${classes}` : tag;

          const before = getComputedStyle(el, '::before');
          const after = getComputedStyle(el, '::after');
          const hasBefore = before.content !== 'none' && before.content !== '""' && before.content !== '';
          const hasAfter = after.content !== 'none' && after.content !== '""' && after.content !== '';

          if (seen.has(key)) {
            seen.get(key)!.count++;
          } else {
            seen.set(key, { count: 1, sample: interesting, pseudoBefore: hasBefore, pseudoAfter: hasAfter });
          }
        }

        // Sort by count descending and limit to top 30
        const sorted = [...seen.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 30);
        for (const [selector, data] of sorted) {
          output.elements.push({
            selector, count: data.count, sample: data.sample,
            pseudoBefore: data.pseudoBefore, pseudoAfter: data.pseudoAfter,
          });
        }

        return output;
      }, targetSelector), 15000, 'read_page', context);

      // Format output
      const lines: string[] = ['[CSS Diagnostic Report]', ''];

      lines.push(`Framework: CSS=${cssResult.framework.css}, JS=${cssResult.framework.js}`);
      lines.push('');

      const varEntries = Object.entries(cssResult.cssVariables);
      if (varEntries.length > 0) {
        lines.push(`CSS Variables (${varEntries.length}):`);
        for (const [k, v] of varEntries.slice(0, 40)) {
          lines.push(`  ${k}: ${v}`);
        }
        if (varEntries.length > 40) lines.push(`  ... and ${varEntries.length - 40} more`);
        lines.push('');
      }

      if (cssResult.elements.length > 0) {
        lines.push(`Elements with visual styles (${cssResult.elements.length}):`);
        for (const el of cssResult.elements) {
          const pseudo = [el.pseudoBefore && '::before', el.pseudoAfter && '::after'].filter(Boolean).join(', ');
          lines.push(`  ${el.selector} (x${el.count})${pseudo ? ` [${pseudo}]` : ''}`);
          for (const [prop, val] of Object.entries(el.sample)) {
            lines.push(`    ${prop}: ${val}`);
          }
        }
      } else {
        lines.push('No elements with notable visual styles found.');
      }

      const cssText = lines.join('\n');
      const includePagination = args.includePagination !== false;
      const cssPaginationSection = includePagination ? formatPaginationSection(await detectPagination(page, tabId)) : '';
      return {
        content: [{ type: 'text', text: cssText + cssPaginationSection }],
      };
    }

    // Semantic mode: rule-based NL summary of regions + actions.
    // Pure deterministic transform; no LLM (P3), no new deps (P5).
    if (mode === 'semantic') {
      const semanticPageStats = await withTimeout(page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
      })), 15000, 'read_page', context);

      const { nodes: semanticAxNodes } = await withTimeout(
        cdpClient.send<{ nodes: AXNode[] }>(page, 'Accessibility.getFullAXTree', { depth: fetchDepth }),
        15000,
        'Accessibility.getFullAXTree',
        context,
      );

      // Clear previous refs for this target so refs in the semantic
      // response do not alias older AX/DOM-mode refs.
      refIdManager.clearTargetRefs(sessionId, tabId);

      // Convert CDP AX nodes into the semantic input shape.
      // P1 codex fix: extract `url` from CDP AX properties so that
      // `buildSemanticView` can pick the correct verb for links
      // (navigate when href is present, click otherwise). Without
      // this, every link emits `click`.
      const semanticNodes: SemanticAXNode[] = semanticAxNodes.map((n) => {
        let href: string | undefined;
        if (n.role?.value === 'link' && n.properties) {
          for (const prop of n.properties) {
            if (prop.name === 'url') {
              const raw = prop.value?.value;
              if (typeof raw === 'string' && raw.length > 0) {
                href = raw;
              }
              break;
            }
          }
        }
        return {
          nodeId: n.nodeId,
          backendDOMNodeId: n.backendDOMNodeId,
          role: n.role?.value ?? 'unknown',
          name: n.name?.value,
          value: n.value?.value,
          href,
          childIds: n.childIds ? [...n.childIds] : [],
        };
      });

      // Best-effort DOM snapshot for state extraction (microdata, classes).
      // P1 codex fix: pulled via CDP `DOM.getDocument` instead of
      // `page.evaluate(...)` so each element carries its `backendDOMNodeId`.
      // Without this, `buildSemanticView`'s `byBackendNodeId` join map was
      // always empty and every DOM-dependent classifier (microdata, data-*,
      // class signals) degraded to AX-only behavior. CDP returns the full
      // tree with backendNodeIds in a single call; we walk it in DFS order
      // and cap at `SEMANTIC_DOM_MAX_ELEMENTS` to bound work on large pages.
      const SEMANTIC_DOM_MAX_ELEMENTS = 2000;
      let semanticDomSnapshot: { elements: SemanticDomElement[] } | undefined;
      // Minimal CDP DOMNode shape needed for the walk; mirrors what
      // `DOM.getDocument({depth: -1})` returns. Inlined to avoid pulling
      // in dom/dom-serializer.ts which carries unrelated dependencies.
      interface CdpDomNode {
        backendNodeId?: number;
        nodeType: number;
        nodeName: string;
        localName?: string;
        attributes?: string[]; // parallel [name1, value1, name2, value2, ...]
        nodeValue?: string;
        children?: CdpDomNode[];
      }
      try {
        const { root } = await withTimeout(
          cdpClient.send<{ root: CdpDomNode }>(page, 'DOM.getDocument', {
            depth: -1,
            pierce: false,
          }),
          15000,
          'DOM.getDocument',
          context,
        );
        const elements: SemanticDomElement[] = [];
        let totalCount = 0;
        // Iterative DFS (avoids stack overflows on deep pages).
        const stack: CdpDomNode[] = [root];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.nodeType === 1 /* ELEMENT_NODE */) {
            totalCount += 1;
            if (elements.length < SEMANTIC_DOM_MAX_ELEMENTS) {
              const tagName = (node.localName || node.nodeName || '').toLowerCase();
              let itemType: string | undefined;
              let itemProp: string | undefined;
              let classNames: string | undefined;
              const attrs: Record<string, string> = {};
              const attrPairs = node.attributes;
              if (attrPairs) {
                for (let k = 0; k + 1 < attrPairs.length; k += 2) {
                  const name = attrPairs[k];
                  const value = attrPairs[k + 1];
                  if (name === 'itemtype') itemType = value || undefined;
                  else if (name === 'itemprop') itemProp = value || undefined;
                  else if (name === 'class') classNames = value || undefined;
                  else if (name === 'data-price') attrs[name] = value;
                  else if (name === 'data-product-id') attrs[name] = value;
                }
              }
              // Collect descendant text node values, capped at 200 chars.
              let text = '';
              const textStack: CdpDomNode[] = [];
              if (node.children) {
                for (let i = node.children.length - 1; i >= 0; i--) {
                  textStack.push(node.children[i]);
                }
              }
              while (textStack.length > 0 && text.length < 200) {
                const tn = textStack.pop()!;
                if (tn.nodeType === 3 /* TEXT_NODE */ && tn.nodeValue) {
                  text += tn.nodeValue;
                } else if (tn.children) {
                  for (let i = tn.children.length - 1; i >= 0; i--) {
                    textStack.push(tn.children[i]);
                  }
                }
              }
              if (text.length > 200) text = text.slice(0, 200);
              elements.push({
                backendDOMNodeId: node.backendNodeId,
                tagName,
                itemType,
                itemProp,
                classNames,
                attrs: Object.keys(attrs).length ? attrs : undefined,
                text: text || undefined,
              });
            }
          }
          // Always descend (so text nodes inside non-elements like
          // documents are skipped naturally — they are not ELEMENT_NODE).
          if (node.children) {
            // Push children in reverse so iteration order matches DFS.
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }
        if (totalCount > SEMANTIC_DOM_MAX_ELEMENTS) {
          // NEVER use console.log — corrupts MCP JSON-RPC on stdout.
          console.error(
            `[read_page semantic] DOM truncated: ${totalCount} elements -> cap ${SEMANTIC_DOM_MAX_ELEMENTS}`,
          );
        }
        semanticDomSnapshot = { elements };
      } catch {
        semanticDomSnapshot = undefined;
      }

      const view = buildSemanticView(
        {
          url: semanticPageStats.url,
          title: semanticPageStats.title,
          axNodes: semanticNodes,
          domSnapshot: semanticDomSnapshot,
          allocateRef: (node) => {
            if (node.backendDOMNodeId === undefined) return undefined;
            const AX_ROLE_TO_TAG: Record<string, string> = {
              button: 'button',
              link: 'a',
              textbox: 'input',
              searchbox: 'input',
              checkbox: 'input',
              radio: 'input',
              combobox: 'select',
              listbox: 'select',
            };
            const tagName = AX_ROLE_TO_TAG[node.role];
            return refIdManager.generateRef(
              sessionId,
              tabId,
              node.backendDOMNodeId,
              node.role,
              node.name,
              tagName,
            );
          },
        },
        semanticRulesJson as SemanticRuleSet,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(view) }],
      };
    }

    if (mode === 'dom') {
      try {
        const refId = args.ref_id as string | undefined;
        const depth = args.depth as number | undefined;
        const result = await serializeDOM(page, cdpClient, {
          maxDepth: depth ?? -1,
          filter: filter,
          interactiveOnly: filter === 'interactive',
        });

        let outputText = result.content;
        if (refId) {
          outputText = '[Note: ref_id is ignored in DOM mode. Use mode "ax" for subtree scoping.]\n\n' + outputText;
        }

        // Delta compression: cache DOM and return diff if applicable
        const compression = args.compression as string | undefined;
        if (compression === 'delta') {
          const snapshotStore = SnapshotStore.getInstance();
          const currentUrl = result.pageStats.url;
          const previous = snapshotStore.get(sessionId, tabId);

          if (previous) {
            const delta = snapshotStore.computeDelta(previous, outputText, currentUrl);
            // Always update cache with current content
            snapshotStore.set(sessionId, tabId, outputText, currentUrl);

            if (delta.isDelta) {
              // Return delta instead of full content, but keep page stats header
              const statsLine = `[page_stats] url: ${result.pageStats.url} | title: ${result.pageStats.title} | scroll: ${result.pageStats.scrollX},${result.pageStats.scrollY} | viewport: ${result.pageStats.viewportWidth}x${result.pageStats.viewportHeight} | docSize: ${result.pageStats.scrollWidth}x${result.pageStats.scrollHeight}\n\n`;
              const includePaginationDom = args.includePagination !== false;
              const domPaginationSection = includePaginationDom ? formatPaginationSection(await detectPagination(page, tabId)) : '';
              return {
                content: [{ type: 'text', text: statsLine + delta.content + domPaginationSection }],
              };
            }
            // If not delta (too many changes), fall through to full response
          } else {
            // First call or cache miss: cache and fall through to full response
            snapshotStore.set(sessionId, tabId, outputText, currentUrl);
          }
        }

        const includePaginationDom = args.includePagination !== false;
        const domPaginationSection = includePaginationDom ? formatPaginationSection(await detectPagination(page, tabId)) : '';
        return {
          content: [{ type: 'text', text: outputText + domPaginationSection }],
        };
      } catch {
        // DOM serialization failed — fall through to AX mode as fallback
      }
    }

    // Resolve ref_id to backendDOMNodeId if provided (AX mode subtree scoping)
    const refIdParam = args.ref_id as string | undefined;
    let scopedBackendNodeId: number | undefined;
    if (refIdParam) {
      scopedBackendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, refIdParam);
      if (scopedBackendNodeId === undefined) {
        // Attempt transparent stale ref recovery
        const cdpClientForRecovery = sessionManager.getCDPClient();
        const relocated = await refIdManager.tryRelocateRef(
          sessionId, tabId, refIdParam, page, cdpClientForRecovery
        );
        if (relocated) {
          scopedBackendNodeId = relocated.backendNodeId;
        } else {
          return {
            content: [{ type: 'text', text: `Error: ref_id or node ID "${refIdParam}" not found or expired` }],
            isError: true,
          };
        }
      }
    }

    // Snapshot ref entry BEFORE clearing refs (needed for post-clear recovery)
    const refEntrySnapshot = refIdParam
      ? refIdManager.getRef(sessionId, tabId, refIdParam)
      : undefined;

    // Get the accessibility tree
    const { nodes } = await withTimeout(
      cdpClient.send<{ nodes: AXNode[] }>(page, 'Accessibility.getFullAXTree', { depth: fetchDepth }),
      15000,
      'Accessibility.getFullAXTree',
      context,
    );

    // Add page stats header for AX mode after the AX snapshot so stats are not older than the tree.
    const axPageStats = await withTimeout(page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })), 15000, 'read_page', context);
    const pageStatsLine = `[page_stats] url: ${axPageStats.url} | title: ${axPageStats.title} | scroll: ${axPageStats.scrollX},${axPageStats.scrollY} | viewport: ${axPageStats.viewportWidth}x${axPageStats.viewportHeight} | docSize: ${axPageStats.scrollWidth}x${axPageStats.scrollHeight}\n\n`;

    // Clear previous refs for this target
    refIdManager.clearTargetRefs(sessionId, tabId);

    // Build the tree structure and child-id set in one pass. Root detection used
    // to scan every node's children for every candidate root (O(n^2)); keeping a
    // child set by construction makes the root pass O(n).
    const nodeMap = new Map<number, AXNode>();
    const childNodeIds = new Set<number>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
      if (node.childIds) {
        for (const childId of node.childIds) {
          childNodeIds.add(childId);
        }
      }
    }

    // Interactive roles
    const interactiveRoles = new Set([
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'menu',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'treeitem',
    ]);

    // Format nodes
    const lines: string[] = [];
    let charCount = 0;
    const MAX_OUTPUT = MAX_OUTPUT_CHARS;

    function formatNode(node: AXNode, indent: number): void {
      if (charCount > MAX_OUTPUT) return;

      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';
      const value = node.value?.value || '';

      // Apply filter
      if (filter === 'interactive' && !interactiveRoles.has(role)) {
        // Still process children
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeMap.get(childId);
            if (child) formatNode(child, indent);
          }
        }
        return;
      }

      // Generate ref ID if element has a backend DOM node
      let refId = '';
      if (node.backendDOMNodeId) {
        // Map AX roles to approximate HTML tag names for ref validation
        const AX_ROLE_TO_TAG: Record<string, string> = {
          button: 'button',
          link: 'a',
          textbox: 'input',
          searchbox: 'input',
          checkbox: 'input',
          radio: 'input',
          image: 'img',
          table: 'table',
          row: 'tr',
          cell: 'td',
          list: 'ul',
          listitem: 'li',
          form: 'form',
          dialog: 'dialog',
          navigation: 'nav',
          main: 'main',
          article: 'article',
          section: 'section',
        };
        const tagName: string | undefined = AX_ROLE_TO_TAG[role];
        refId = refIdManager.generateRef(
          sessionId,
          tabId,
          node.backendDOMNodeId,
          role,
          name,
          tagName
        );
      }

      // Build line
      const indentStr = '  '.repeat(indent);
      let line = `${indentStr}[${refId || 'no-ref'}] ${role}`;
      if (name) line += `: "${name}"`;
      if (value) line += ` = "${value}"`;

      // Add relevant properties
      if (node.properties) {
        const props: string[] = [];
        for (const prop of node.properties) {
          if (['focused', 'disabled', 'checked', 'selected', 'expanded'].includes(prop.name)) {
            if (prop.value.value === true) {
              props.push(prop.name);
            }
          }
        }
        if (props.length > 0) {
          line += ` (${props.join(', ')})`;
        }
      }

      lines.push(line);
      charCount += line.length + 1;

      // Process children
      if (node.childIds && indent < maxDepth) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) formatNode(child, indent + 1);
        }
      }
    }

    // Start from root nodes (or scoped subtree if ref_id provided)
    let startNodes: AXNode[];
    if (scopedBackendNodeId !== undefined) {
      let scopedNode = nodes.find((n) => n.backendDOMNodeId === scopedBackendNodeId);
      if (!scopedNode && refEntrySnapshot) {
        // Refs were cleared — use snapshot to search by element attributes
        // tryRelocateRef won't work here because clearTargetRefs already deleted the entry
        const { name, role } = refEntrySnapshot;
        scopedNode = nodes.find((n) => {
          if (!n.backendDOMNodeId) return false;
          const nodeRole = n.role?.value;
          const nodeName = n.name?.value;
          // Match by role + name (accessibility attributes survive DOM mutations)
          return (
            (role && nodeRole === role) &&
            (name && nodeName === name)
          );
        });
      }
      if (!scopedNode) {
        return {
          content: [{ type: 'text', text: `Error: ref_id or node ID "${refIdParam}" not found or expired` }],
          isError: true,
        };
      }
      startNodes = [scopedNode];
    } else {
      startNodes = nodes.filter((n) => !childNodeIds.has(n.nodeId));
    }
    for (const root of startNodes) {
      formatNode(root, 0);
    }

    const outputLines = compactAX ? compactAXLines(lines) : lines;
    const output = outputLines.join('\n');
    const outputCharCount = output.length;
    const includePaginationAx = args.includePagination !== false;
    const axPaginationSection = includePaginationAx ? formatPaginationSection(await detectPagination(page, tabId)) : '';

    const compression = args.compression as string | undefined;
    if (compression === 'delta') {
      const snapshotStore = SnapshotStore.getInstance();
      const axCacheTabId = `${tabId}:ax${compactAX ? ':compact' : ''}`;
      const previous = snapshotStore.get(sessionId, axCacheTabId);
      if (previous) {
        const delta = snapshotStore.computeDelta(previous, output, axPageStats.url);
        snapshotStore.set(sessionId, axCacheTabId, output, axPageStats.url);
        if (delta.isDelta) {
          return {
            content: [{ type: 'text', text: pageStatsLine + delta.content.replace('[DOM Delta', '[AX Delta') + axPaginationSection }],
          };
        }
      } else {
        snapshotStore.set(sessionId, axCacheTabId, output, axPageStats.url);
      }
    }

    if (outputCharCount > MAX_OUTPUT) {
      // Large AX output should not trigger a second full DOM traversal unless
      // the caller explicitly opts into that fallback. Otherwise preserve AX
      // intent and return the bounded/truncated AX representation.
      if (axOverflowFallback !== 'dom') {
        return {
          content: [
            {
              type: 'text',
              text:
                pageStatsLine +
                output +
                '\n\n[Output truncated. AX output exceeded the output budget. Use mode: "dom" or fallback: "dom" for DOM output, or use smaller depth / ref_id to focus on specific element.]' +
                axPaginationSection,
            },
          ],
        };
      }

      // Explicit fallback: DOM mode often produces equivalent page structure at
      // fewer tokens, but it can require another CDP DOM traversal.
      try {
        const domResult = await serializeDOM(page, cdpClient, {
          maxDepth,
          filter: filter,
          interactiveOnly: filter === 'interactive',
        });

        const fallbackNote =
          '\n\n[AX tree exceeded output limit (' + charCount + ' chars). ' +
          'Switched to DOM mode because fallback: "dom" was requested. ' +
          'Use mode: "ax" with smaller depth / ref_id to scope specific subtrees for AX format.]';

        return {
          content: [
            {
              type: 'text',
              text: domResult.content + fallbackNote + axPaginationSection,
            },
          ],
        };
      } catch {
        // If DOM serialization fails, fall back to truncated AX (original behavior)
        return {
          content: [
            {
              type: 'text',
              text:
                pageStatsLine +
                output +
                '\n\n[Output truncated. Try mode: "dom" for ~5-10x fewer tokens, or use smaller depth / ref_id to focus on specific element.]' +
                axPaginationSection,
            },
          ],
        };
      }
    }

    return {
      content: [{ type: 'text', text: pageStatsLine + output + axPaginationSection }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Read page error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

/**
 * Wrapper that applies content sanitization to read_page output.
 * Strips invisible characters, HTML comments, and flags suspicious
 * instruction-like patterns to mitigate indirect prompt injection.
 */
const sanitizedHandler: ToolHandler = async (sessionId, args, context) => {
  const result = await handler(sessionId, args, context);

  // Skip sanitization if disabled, if the result is an error, or if no content
  const config = getGlobalConfig();
  if (config.security?.sanitize_content === false || result.isError || !result.content) {
    return result;
  }

  // P1 codex fix: semantic mode emits a JSON payload via `JSON.stringify(view)`.
  // Running the string-level sanitizer over the serialized JSON would let
  // patterns like `<!--` in one field and `-->` in a later field cross JSON
  // delimiters and corrupt the structure. Parse first, sanitize each string
  // value in place, then re-serialize. Sanitization metadata is attached as a
  // structural `_sanitization` field so JSON.parse always succeeds. Other
  // modes keep the legacy text-suffix behavior.
  const isSemanticMode =
    typeof (args as { mode?: unknown })?.mode === 'string' &&
    (args as { mode: string }).mode === 'semantic';

  function sanitizeStringsDeep(
    value: unknown,
    notes: string[],
  ): unknown {
    if (typeof value === 'string') {
      const s = sanitizeContent(value);
      if (s.sanitizationNote && s.sanitizationNote.length > 0) {
        notes.push(s.sanitizationNote.trim());
      }
      return s.text;
    }
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeStringsDeep(v, notes));
    }
    if (value && typeof value === 'object') {
      // P1 codex fix: object KEYS can be attacker-controlled too
      // (`buildSemanticView` lifts `itemprop` strings into `state` keys),
      // so sanitize keys as well as values. Previous version only walked
      // values, which reopened a prompt-injection vector via keys.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const sk = sanitizeContent(k);
        if (sk.sanitizationNote && sk.sanitizationNote.length > 0) {
          notes.push(sk.sanitizationNote.trim());
        }
        // Reserve `_sanitization` for our own metadata channel: if a
        // sanitized key collides, prefix it to keep the metadata intact.
        const keyOut = sk.text === '_sanitization' ? '_sanitization_input' : sk.text;
        out[keyOut] = sanitizeStringsDeep(v, notes);
      }
      return out;
    }
    return value;
  }

  // Sanitize all text content blocks
  const sanitizedContent = result.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (isSemanticMode) {
        // Parse first, then sanitize each string value inside. This prevents
        // the sanitizer from stripping content across JSON delimiters.
        try {
          const parsed = JSON.parse(block.text) as Record<string, unknown>;
          const notes: string[] = [];
          const cleaned = sanitizeStringsDeep(parsed, notes) as Record<string, unknown>;
          if (notes.length > 0) {
            // Deduplicate identical notes; join the rest with `; `.
            const unique = Array.from(new Set(notes));
            cleaned['_sanitization'] = unique.join('; ');
          }
          return { ...block, text: JSON.stringify(cleaned) };
        } catch {
          // Parse failed — fall back to string-level sanitization so the
          // security signal is not silently lost.
          const sanitized = sanitizeContent(block.text);
          return { ...block, text: sanitized.text + sanitized.sanitizationNote };
        }
      }
      const sanitized = sanitizeContent(block.text);
      return {
        ...block,
        text: sanitized.text + sanitized.sanitizationNote,
      };
    }
    return block;
  });

  return { ...result, content: sanitizedContent };
};

export function registerReadPageTool(server: MCPServer): void {
  server.registerTool('read_page', sanitizedHandler, definition);
}
