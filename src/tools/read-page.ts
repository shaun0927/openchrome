/**
 * Read Page Tool - Get accessibility tree representation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { serializeDOM } from '../dom';
import { detectPagination, PaginationInfo } from '../utils/pagination-detector';
import { MAX_OUTPUT_CHARS } from '../config/defaults';

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
  description:
    'Get page content. Default mode "dom" returns compact DOM (~5-10x fewer tokens) with stable backendNodeId identifiers. Mode "ax" returns accessibility tree with ref_N identifiers for ARIA/accessibility auditing. Mode "css" returns CSS diagnostic info (variables, computed styles, framework detection) — use this BEFORE javascript_tool for style inspection or visual debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to read from',
      },
      depth: {
        type: 'number',
        description: 'Maximum depth of the tree to traverse (default: 8 for "all", 5 for "interactive")',
      },
      filter: {
        type: 'string',
        enum: ['interactive', 'all'],
        description: 'Filter elements: "interactive" for buttons/links/inputs only',
      },
      ref_id: {
        type: 'string',
        description: 'Reference ID of a parent element to read from',
      },
      selector: {
        type: 'string',
        description: '(css mode only) CSS selector to inspect specific elements. If omitted, inspects all elements with visual properties.',
      },
      mode: {
        type: 'string',
        enum: ['ax', 'dom', 'css'],
        description: 'Output mode: "dom" for compact DOM (default), "ax" for accessibility tree, "css" for CSS diagnostics (variables, computed styles, framework detection)',
      },
      includePagination: {
        type: 'boolean',
        description: 'Whether to detect and include pagination info in the output (default: true)',
      },
    },
    required: ['tabId'],
  },
};

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
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const filter = (args.filter as string) || 'all';
  const defaultDepth = filter === 'interactive' ? 5 : 8;
  const maxDepth = (args.depth as number) || defaultDepth;
  const fetchDepth = filter === 'interactive' ? Math.min(maxDepth, 5) : maxDepth;

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
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found. Hint: The tab may have been closed or the session expired. Use navigate() to open a new tab.` }],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // Mode dispatch
    const mode = (args.mode as string) || 'dom';
    if (mode !== 'ax' && mode !== 'dom' && mode !== 'css') {
      return {
        content: [{ type: 'text', text: `Error: Invalid mode "${mode}". Must be "ax", "dom", or "css".` }],
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
      const cssResult = await page.evaluate((sel: string | undefined) => {
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
      }, targetSelector);

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

    if (mode === 'dom') {
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

      const includePaginationDom = args.includePagination !== false;
      const domPaginationSection = includePaginationDom ? formatPaginationSection(await detectPagination(page, tabId)) : '';
      return {
        content: [{ type: 'text', text: outputText + domPaginationSection }],
      };
    }

    // Resolve ref_id to backendDOMNodeId if provided (AX mode subtree scoping)
    const refIdParam = args.ref_id as string | undefined;
    let scopedBackendNodeId: number | undefined;
    if (refIdParam) {
      scopedBackendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, refIdParam);
      if (scopedBackendNodeId === undefined) {
        return {
          content: [{ type: 'text', text: `Error: ref_id or node ID "${refIdParam}" not found or expired` }],
          isError: true,
        };
      }
    }

    // Add page stats header for AX mode (matching DOM mode format)
    const axPageStats = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
    const pageStatsLine = `[page_stats] url: ${axPageStats.url} | title: ${axPageStats.title} | scroll: ${axPageStats.scrollX},${axPageStats.scrollY} | viewport: ${axPageStats.viewportWidth}x${axPageStats.viewportHeight} | docSize: ${axPageStats.scrollWidth}x${axPageStats.scrollHeight}\n\n`;

    // Get the accessibility tree
    const { nodes } = await cdpClient.send<{ nodes: AXNode[] }>(
      page,
      'Accessibility.getFullAXTree',
      { depth: fetchDepth }
    );

    // Clear previous refs for this target
    refIdManager.clearTargetRefs(sessionId, tabId);

    // Build the tree structure
    const nodeMap = new Map<number, AXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
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
        refId = refIdManager.generateRef(
          sessionId,
          tabId,
          node.backendDOMNodeId,
          role,
          name
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
      const scopedNode = nodes.find((n) => n.backendDOMNodeId === scopedBackendNodeId);
      if (!scopedNode) {
        return {
          content: [{ type: 'text', text: `Error: ref_id or node ID "${refIdParam}" not found or expired` }],
          isError: true,
        };
      }
      startNodes = [scopedNode];
    } else {
      startNodes = nodes.filter(
        (n) => !nodes.some((other) => other.childIds?.includes(n.nodeId))
      );
    }
    for (const root of startNodes) {
      formatNode(root, 0);
    }

    const output = lines.join('\n');
    const includePaginationAx = args.includePagination !== false;
    const axPaginationSection = includePaginationAx ? formatPaginationSection(await detectPagination(page, tabId)) : '';

    if (charCount > MAX_OUTPUT) {
      // Auto-fallback: DOM mode produces complete output at ~5-10x fewer tokens
      try {
        const domResult = await serializeDOM(page, cdpClient, {
          maxDepth: -1,
          filter: filter,
          interactiveOnly: filter === 'interactive',
        });

        const fallbackNote =
          '\n\n[AX tree exceeded output limit (' + charCount + ' chars). ' +
          'Auto-switched to DOM mode for complete output. ' +
          'Use mode: "ax" with ref_id to scope specific subtrees for AX format.]';

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

export function registerReadPageTool(server: MCPServer): void {
  server.registerTool('read_page', handler, definition);
}
