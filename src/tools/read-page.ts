/**
 * Read Page Tool - Get accessibility tree representation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, throwIfAborted } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { getRefIdManager, REF_TTL_MS, type SnapshotRefMetadata } from '../utils/ref-id-manager';
import { serializeDOM } from '../dom';
import { detectPagination, PaginationInfo } from '../utils/pagination-detector';
import { MAX_OUTPUT_CHARS } from '../config/defaults';
import { isFastProfile } from '../config/runtime-profile';
import { withTimeout } from '../utils/with-timeout';
import { SnapshotStore } from '../compression/snapshot-store';
import { sanitizeContent } from '../security/content-sanitizer';
import { appendMetricsFooter, buildTextMetrics } from '../core/metrics/token-estimate';
import { getGlobalConfig } from '../config/global';
import { extractMainContent, toMarkdown } from '../core/extract/html-to-markdown';
import { applyContentFilter, parseContentFilterType } from '../core/extract/content-filter';
import { getCurrentLoaderId, mintNodeRefSync } from '../core/perception/node-ref';
import { isStateHeaderEnabled, mergeHeaderJson, prependHeaderText } from './_shared/state-header';

/**
 * Build the `[node_refs]` block that surfaces the #844 backend-node uid
 * contract in `read_page` DOM mode responses.
 *
 * P2 contract: this section is **always** present in the response shape so
 * `tools/list` parity holds regardless of the `OPENCHROME_NODE_REF` env var.
 * When the flag is off (or loaderId resolution fails), every uid is rendered
 * as the literal `null`, keeping the field present but the runtime value
 * inert.
 *
 * The format is line-oriented JSON-ish, one `<backendNodeId>=<nodeRef>` per
 * line, so a trace-replay parser can reconstruct the registry state without
 * bringing along a full JSON parser.
 */
async function formatNodeRefsBlock(
  page: import('puppeteer-core').Page,
  cdpClient: { send: (page: import('puppeteer-core').Page, method: string, params?: Record<string, unknown>) => Promise<unknown> },
  backendNodeIds: number[],
): Promise<string> {
  if (backendNodeIds.length === 0) {
    return '\n\n[node_refs]\n(empty)\n';
  }
  let loaderId: string | null = null;
  try {
    loaderId = await getCurrentLoaderId(page, cdpClient as any);
  } catch {
    loaderId = null;
  }
  const lines: string[] = ['', '', '[node_refs]'];
  for (const backendNodeId of backendNodeIds) {
    let uid: string | null = null;
    if (loaderId) {
      try {
        uid = mintNodeRefSync(page, loaderId, backendNodeId);
      } catch {
        uid = null;
      }
    }
    lines.push(`${backendNodeId}=${uid ?? 'null'}`);
  }
  lines.push('');
  return lines.join('\n');
}
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
  description: 'Get page as DOM, accessibility tree (ax), CSS diagnostics, semantic summary, or clean Markdown (article-shaped).\n\nWhen to use: Reading page structure, verifying content, extracting the full DOM tree, or reducing article-like pages to Markdown.\nWhen NOT to use: Use inspect for targeted state queries or find to locate a specific element.',
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
        enum: ['ax', 'dom', 'css', 'semantic', 'markdown'],
        description: 'Output mode: dom (default), ax, css, semantic, or markdown (clean article extraction).',
      },
      onlyMainContent: {
        type: 'boolean',
        description: 'Markdown mode only: strip nav/header/footer/aside/ads. Default: true.',
      },
      includeLinks: {
        type: 'boolean',
        description: 'Markdown mode only: preserve <a> as markdown links. Default: true.',
      },
      contentFilter: {
        type: 'string',
        enum: ['none', 'prune', 'bm25'],
        description: 'Markdown mode only: deterministic fit_markdown filter. Default: none.',
      },
      query: {
        type: 'string',
        description: 'Markdown mode only: required when contentFilter="bm25".',
      },
      returnRaw: {
        type: 'boolean',
        description: 'Markdown mode only: include raw_markdown in JSON response. Default: false.',
      },
      returnFit: {
        type: 'boolean',
        description: 'Markdown mode only: include fit_markdown and use it as content when filtering. Default: true when filtered.',
      },
      filterOptions: {
        type: 'object',
        description: 'Markdown mode only: minWords, maxSections, bm25Threshold, pruneThreshold.',
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
      planningProfile: {
        type: 'string',
        enum: ['default', 'stable'],
        description: 'DOM mode only: stable omits decorative/noisy serialization details without mutating the live page. Default: default.',
      },
      fallback: {
        type: 'string',
        enum: ['none', 'dom'],
        description: 'AX mode only: use "dom" to explicitly fall back to DOM output if AX output exceeds the output budget. Default: none.',
      },
      compact: {
        type: 'boolean',
        description: 'AX mode only: return a compact AX snapshot that keeps actionable/ref-bearing nodes, value/state nodes, and ancestors. Default: false, or true when OPENCHROME_PROFILE=fast.',
      },
      diagnostics: {
        type: 'boolean',
        description: 'Include structured read_page timing diagnostics in the MCP result metadata. Default: false.',
      },
      include_metrics: {
        type: 'boolean',
        description: 'When true, include approximate returned size/token metrics in the emitted payload. Default: false.',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.read_page,
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

interface ReadPageDiagnostics {
  mode: string;
  requestedMode?: string;
  pageStatsMs?: number;
  domGetDocumentMs?: number;
  axGetFullTreeMs?: number;
  formatMs?: number;
  paginationMs?: number;
  sanitizeMs?: number;
  deltaMs?: number;
}

type ReadPageDiagnosticTimingKey = Exclude<keyof ReadPageDiagnostics, 'mode' | 'requestedMode'>;


interface AXNode {
  nodeId: number;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  childIds?: number[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}


function createReadPageSnapshotMetadata(tabId: string, url: string, capturedAt = Date.now()): SnapshotRefMetadata {
  return {
    snapshotId: `snap_${capturedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    capturedAt,
    url,
    tabId,
  };
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
  const requestedDepth = typeof args.depth === 'number' ? args.depth : undefined;
  const maxDepth = filter === 'interactive'
    ? Math.min(requestedDepth ?? defaultDepth, defaultDepth)
    : requestedDepth ?? defaultDepth;
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
    const requestedMode = args.mode as string | undefined;
    const mode = requestedMode || 'dom';
    const isExplicitDomMode = requestedMode === 'dom';
    if (mode !== 'ax' && mode !== 'dom' && mode !== 'css' && mode !== 'semantic' && mode !== 'markdown') {
      return {
        content: [{ type: 'text', text: `Error: Invalid mode "${mode}". Must be "ax", "dom", "css", "semantic", or "markdown".` }],
        isError: true,
      };
    }
    const diagnosticsEnabled = args.diagnostics === true;
    const diagnostics: ReadPageDiagnostics = {
      mode,
      ...(requestedMode !== undefined && requestedMode !== mode ? { requestedMode } : {}),
    };
    const mark = () => Date.now();
    const measure = async <T>(key: ReadPageDiagnosticTimingKey, fn: () => Promise<T>): Promise<T> => {
      const start = mark();
      try {
        return await fn();
      } finally {
        diagnostics[key] = mark() - start;
      }
    };
    const withDiagnostics = (result: MCPResult): MCPResult => (
      diagnosticsEnabled ? { ...result, _diagnostics: diagnostics } : result
    );
    const includeMetrics = args.include_metrics === true;
    const withTextMetrics = (text: string, emittedMode: string, truncated = hasTruncationMarker(text)): string => {
      if (!includeMetrics) return text;
      let baseText = text;
      let metrics = buildTextMetrics(baseText, { mode: emittedMode, truncated });
      for (let i = 0; i < 8; i++) {
        const candidate = appendMetricsFooter(baseText, metrics);
        const nextMetrics = buildTextMetrics(candidate, { mode: emittedMode, truncated });
        if (nextMetrics.returned_chars === metrics.returned_chars && nextMetrics.estimated_tokens === metrics.estimated_tokens) {
          if (candidate.length <= MAX_OUTPUT_CHARS) return candidate;
          const reserve = Math.min(512, Math.max(128, candidate.length - baseText.length + 64));
          baseText = `${baseText.slice(0, Math.max(0, MAX_OUTPUT_CHARS - reserve))}

[Output truncated — metrics footer reserved output budget]`;
          truncated = true;
          metrics = buildTextMetrics(baseText, { mode: emittedMode, truncated });
          continue;
        }
        metrics = nextMetrics;
      }
      return appendMetricsFooter(baseText, metrics);
    };
    const withSemanticMetrics = (view: Record<string, unknown>): string => {
      if (!includeMetrics) return JSON.stringify(view);
      const payload: Record<string, unknown> = { ...view };
      let metrics = buildTextMetrics(JSON.stringify(payload), { mode: 'semantic' });
      for (let i = 0; i < 8; i++) {
        payload._metrics = metrics;
        const text = JSON.stringify(payload);
        const nextMetrics = buildTextMetrics(text, { mode: 'semantic' });
        if (nextMetrics.returned_chars === metrics.returned_chars && nextMetrics.estimated_tokens === metrics.estimated_tokens) return text;
        metrics = nextMetrics;
      }
      payload._metrics = metrics;
      return JSON.stringify(payload);
    };

    const axOverflowFallback = (args.fallback as string | undefined) || 'none';
    const compactAX = args.compact === true || (args.compact === undefined && isFastProfile());
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

    // Markdown mode — clean HTML→Markdown extraction.
    // Keep pagination metadata parity with DOM/AX/CSS modes when requested.
    if (mode === 'markdown') {
      const onlyMainContent = args.onlyMainContent !== false;
      const includeLinks = args.includeLinks !== false;
      const includePaginationMarkdown = args.includePagination !== false;
      const contentFilter = parseContentFilterType(args.contentFilter);
      const returnRaw = args.returnRaw === true;
      const returnFit = args.returnFit !== false;
      const filterOptions = (args.filterOptions && typeof args.filterOptions === 'object') ? args.filterOptions as Record<string, unknown> : {};
      const refIdNote = args.ref_id
        ? '[Note: ref_id is not supported in markdown mode — full-page content returned. Use mode "ax" for ref_id subtree scoping.]\n\n'
        : '';
      const html = await withTimeout(
        page.content(),
        15000,
        'read_page.markdown.content',
        context,
      );
      const { html: cleaned } = extractMainContent(html, { onlyMainContent });
      let md = refIdNote + toMarkdown(cleaned, { includeLinks });
      const paginationSection = includePaginationMarkdown
        ? formatPaginationSection(await detectPagination(page, tabId))
        : '';
      if (paginationSection) {
        md += `\n${paginationSection}`;
      }
      let truncated = false;
      if (md.length > MAX_OUTPUT_CHARS) {
        md = md.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
      const suffix = truncated ? '\n\n[Output truncated — exceeded MAX_OUTPUT_CHARS]' : '';
      const rawMarkdown = md + suffix;
      if (contentFilter !== 'none' || returnRaw || args.returnFit === true) {
        try {
          const filtered = applyContentFilter(rawMarkdown, {
            type: contentFilter,
            query: args.query as string | undefined,
            returnRaw,
            returnFit,
            minWords: filterOptions.minWords as number | undefined,
            maxSections: filterOptions.maxSections as number | undefined,
            bm25Threshold: filterOptions.bm25Threshold as number | undefined,
            pruneThreshold: filterOptions.pruneThreshold as number | undefined,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...filtered, content: withTextMetrics(filtered.content, 'markdown', truncated) }) }],
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      }
      return {
        content: [{ type: 'text', text: withTextMetrics(rawMarkdown, 'markdown', truncated) }],
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
        content: [{ type: 'text', text: withTextMetrics(cssText + cssPaginationSection, 'css') }],
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
        content: [{ type: 'text', text: withSemanticMetrics(view as unknown as Record<string, unknown>) }],
      };
    }

    if (mode === 'dom') {
      try {
        const refId = args.ref_id as string | undefined;
        const depth = args.depth as number | undefined;
        const planningProfile = (args.planningProfile as 'default' | 'stable' | undefined) ?? 'default';
        const result = await measure('domGetDocumentMs', () => serializeDOM(page, cdpClient, {
          maxDepth: depth ?? -1,
          filter: filter,
          interactiveOnly: filter === 'interactive',
          planningProfile,
        }));
        diagnostics.formatMs = diagnostics.domGetDocumentMs;

        let outputText = result.content;
        if (refId) {
          outputText = '[Note: ref_id is ignored in DOM mode. Use mode "ax" for subtree scoping.]\n\n' + outputText;
        }

        // #844: build the [node_refs] block from emitted backendNodeIds.
        // P2 contract — block is always present (never gated by the flag);
        // the flag only flips uid values to `null` at runtime.
        const nodeRefsBlock = await formatNodeRefsBlock(
          page,
          cdpClient,
          result.emittedBackendNodeIds ?? [],
        );

        // Delta compression: cache DOM and return diff if applicable
        const compression = args.compression as string | undefined;
        if (compression === 'delta') {
          const snapshotStore = SnapshotStore.getInstance();
          const currentUrl = result.pageStats.url;
          const previous = snapshotStore.get(sessionId, tabId);

          if (previous) {
            const delta = await measure('deltaMs', async () => snapshotStore.computeDelta(previous, outputText, currentUrl));
            // Always update cache with current content
            snapshotStore.set(sessionId, tabId, outputText, currentUrl);

            if (delta.isDelta) {
              // Return delta instead of full content, but keep page stats header
              const statsLine = `[page_stats] url: ${result.pageStats.url} | title: ${result.pageStats.title} | scroll: ${result.pageStats.scrollX},${result.pageStats.scrollY} | viewport: ${result.pageStats.viewportWidth}x${result.pageStats.viewportHeight} | docSize: ${result.pageStats.scrollWidth}x${result.pageStats.scrollHeight}\n\n`;
              const includePaginationDom = args.includePagination !== false;
              const domPaginationSection = includePaginationDom ? await measure('paginationMs', async () => formatPaginationSection(await detectPagination(page, tabId))) : '';
              const compressedText = statsLine + delta.content + nodeRefsBlock + domPaginationSection;
              return withDiagnostics({
                content: [{ type: 'text', text: withTextMetrics(compressedText, 'dom') }],
                _compression: {
                  level: 'delta',
                  originalChars: outputText.length,
                  compressedChars: compressedText.length,
                },
              });
            }
            // If not delta (too many changes), fall through to full response
          } else {
            // First call or cache miss: cache and fall through to full response
            snapshotStore.set(sessionId, tabId, outputText, currentUrl);
          }
        }

        const includePaginationDom = args.includePagination !== false;
        const domPaginationSection = includePaginationDom ? await measure('paginationMs', async () => formatPaginationSection(await detectPagination(page, tabId))) : '';
        return withDiagnostics({
          content: [{ type: 'text', text: withTextMetrics(outputText + nodeRefsBlock + domPaginationSection, 'dom') }],
        });
      } catch (error) {
        if (isExplicitDomMode) {
          return withDiagnostics({
            content: [
              {
                type: 'text',
                text: `Read page DOM serialization error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          });
        }
        // DOM serialization failed — fall through to AX mode as fallback
        diagnostics.mode = 'ax';
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
    const { nodes } = await measure('axGetFullTreeMs', () => withTimeout(
      cdpClient.send<{ nodes: AXNode[] }>(page, 'Accessibility.getFullAXTree', { depth: fetchDepth }),
      15000,
      'Accessibility.getFullAXTree',
      context,
    ));

    // Add page stats header for AX mode after the AX snapshot so stats are not older than the tree.
    const axPageStats = await measure('pageStatsMs', () => withTimeout(page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })), 15000, 'read_page', context));
    const pageStatsLine = `[page_stats] url: ${axPageStats.url} | title: ${axPageStats.title} | scroll: ${axPageStats.scrollX},${axPageStats.scrollY} | viewport: ${axPageStats.viewportWidth}x${axPageStats.viewportHeight} | docSize: ${axPageStats.scrollWidth}x${axPageStats.scrollHeight}\n\n`;

    const formatStart = mark();

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

    /**
     * Per-snapshot refs map (#831). Populated as the AX tree is walked so that
     * the final response carries a structured `refs` map alongside the textual
     * tree. Additive to the existing ax response — `mode='ax'` is unchanged.
     */
    const refsMap: Record<string, {
      role: string;
      name?: string;
      tag_name?: string;
      text_content?: string;
      frame_id?: string;
      created_at: number;
      stale_after_ms: number;
      snapshot_id: string;
      snapshot_captured_at: number;
      snapshot_url: string;
    }> = {};
    const snapshotMetadata = createReadPageSnapshotMetadata(tabId, axPageStats.url);

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
          tagName,
          undefined,
          { snapshot: snapshotMetadata }
        );

        // #831: record the structured ref entry for the response `refs` map.
        // Fields mirror the RefEntry contract documented in the issue.
        const entry = refIdManager.getRef(sessionId, tabId, refId);
        const textContent = value || undefined;
        refsMap[refId] = {
          role,
          ...(name ? { name } : {}),
          ...(tagName ? { tag_name: tagName } : {}),
          ...(textContent ? { text_content: textContent } : {}),
          ...(entry?.frameId ? { frame_id: entry.frameId } : {}),
          created_at: entry?.createdAt ?? Date.now(),
          stale_after_ms: entry?.staleAfterMs ?? REF_TTL_MS,
          snapshot_id: snapshotMetadata.snapshotId,
          snapshot_captured_at: snapshotMetadata.capturedAt,
          snapshot_url: snapshotMetadata.url,
        };
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
        return withDiagnostics({
          content: [{ type: 'text', text: `Error: ref_id or node ID "${refIdParam}" not found or expired` }],
          isError: true,
        });
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
    diagnostics.formatMs = mark() - formatStart;
    const includePaginationAx = args.includePagination !== false;
    const axPaginationSection = includePaginationAx ? await measure('paginationMs', async () => formatPaginationSection(await detectPagination(page, tabId))) : '';

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
        return withDiagnostics({
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
          refs: refsMap,
          snapshot: snapshotMetadata,
        });
      }

      // Explicit fallback: DOM mode often produces equivalent page structure at
      // fewer tokens, but it can require another CDP DOM traversal.
      try {
        const domResult = await serializeDOM(page, cdpClient, {
          maxDepth,
          filter: filter,
          interactiveOnly: filter === 'interactive',
        });

        // #844: include the [node_refs] block in the AX-overflow DOM
        // fallback path too — P2 contract is unconditional across response
        // shapes that ship DOM content.
        const fallbackNodeRefsBlock = await formatNodeRefsBlock(
          page,
          cdpClient,
          domResult.emittedBackendNodeIds ?? [],
        );

        const fallbackNote =
          '\n\n[AX tree exceeded output limit (' + charCount + ' chars). ' +
          'Switched to DOM mode because fallback: "dom" was requested. ' +
          'Use mode: "ax" with smaller depth / ref_id to scope specific subtrees for AX format.]';

        // Update diagnostics to reflect the effective output mode (DOM), not the requested one (AX).
        diagnostics.requestedMode = diagnostics.requestedMode ?? diagnostics.mode;
        diagnostics.mode = 'dom';

        return withDiagnostics({
          content: [
            {
              type: 'text',
              text: domResult.content + fallbackNote + fallbackNodeRefsBlock + axPaginationSection,
            },
          ],
        });
      } catch {
        // If DOM serialization fails, fall back to truncated AX (original behavior)
        return withDiagnostics({
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
          refs: refsMap,
          snapshot: snapshotMetadata,
        });
      }
    }

    return withDiagnostics({
      content: [{ type: 'text', text: pageStatsLine + output + axPaginationSection }],
      refs: refsMap,
      snapshot: snapshotMetadata,
    });
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

  const sanitizeStart = Date.now();

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

  const sanitizedResult: MCPResult = { ...result, content: sanitizedContent };
  if (args.diagnostics === true && sanitizedResult._diagnostics && typeof sanitizedResult._diagnostics === 'object') {
    (sanitizedResult._diagnostics as ReadPageDiagnostics).sanitizeMs = Date.now() - sanitizeStart;
  }
  return sanitizedResult;
};

/**
 * Snapshot-cache wrapper (#879).
 *
 * read_page stays uncached for now. AX/semantic responses embed ephemeral
 * ref_* ids owned by RefIdManager, and DOM/CSS outputs include scroll-sensitive
 * page stats/content. Until cache identity can include scroll state and ref
 * mappings can be replayed or made stable, returning cached read_page payloads
 * risks stale refs or stale post-scroll snapshots. Keep the wrapper as a
 * behavior-preserving seam so the feature can be re-enabled safely later.
 */
const cachedHandler: ToolHandler = async (sessionId, args, context) => {
  const result = await sanitizedHandler(sessionId, args, context);
  if (!isStateHeaderEnabled() || result.isError || !result.content) return result;

  const tabId = typeof args.tabId === 'string' ? args.tabId : '';
  if (!tabId) return result;

  let page: Awaited<ReturnType<ReturnType<typeof getSessionManager>['getPage']>> | null = null;
  try {
    page = await getSessionManager().getPage(sessionId, tabId);
  } catch {
    page = null;
  }
  if (!page) return result;

  let url = '';
  let title = '';
  try {
    url = page.url() || '';
  } catch {
    url = '';
  }
  try {
    title = await page.title();
  } catch {
    title = '';
  }

  const requestedMode = typeof args.mode === 'string' ? args.mode : 'dom';
  const mode = ['ax', 'dom', 'css', 'semantic', 'markdown'].includes(requestedMode)
    ? requestedMode
    : 'dom';
  const headerMode = mode === 'markdown' ? 'html' : mode;
  const header = { url, title, mode: headerMode as 'ax' | 'dom' | 'css' | 'html', capturedAt: Date.now(), tabId };
  const includeMetrics = args.include_metrics === true;
  const refreshSemanticMetrics = (payload: Record<string, unknown>): Record<string, unknown> => {
    if (!includeMetrics || !('_metrics' in payload)) return payload;
    const next = { ...payload };
    delete next._metrics;
    let metrics = buildTextMetrics(JSON.stringify(next), { mode: 'semantic' });
    for (let i = 0; i < 8; i++) {
      next._metrics = metrics;
      const text = JSON.stringify(next);
      const candidate = buildTextMetrics(text, { mode: 'semantic' });
      if (candidate.returned_chars === metrics.returned_chars && candidate.estimated_tokens === metrics.estimated_tokens) return next;
      metrics = candidate;
    }
    next._metrics = metrics;
    return next;
  };

  return {
    ...result,
    content: result.content.map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      if (mode === 'semantic') {
        try {
          const parsed = JSON.parse(block.text) as Record<string, unknown>;
          const merged = mergeHeaderJson(header, parsed) as Record<string, unknown>;
          return { ...block, text: JSON.stringify(refreshSemanticMetrics(merged)) };
        } catch {
          return { ...block, text: prependHeaderText(header, block.text) };
        }
      }
      return { ...block, text: prependHeaderText(header, block.text) };
    }),
  };
};

function hasTruncationMarker(text: string): boolean {
  return text.includes('...[truncated]') || text.includes('[Output truncated') || text.includes('Content omitted due to size constraints');
}

export function registerReadPageTool(server: MCPServer): void {
  server.registerTool('read_page', cachedHandler, definition);
}

/**
 * Internal handler exported for in-process reuse (e.g. the
 * `returnAfterState` chaining option on input tools). External callers should
 * register the tool via `registerReadPageTool` and invoke it through the MCP
 * server. This export wraps the sanitized handler so callers get the same
 * post-processing the public tool applies.
 */
export const readPageHandlerForReuse: ToolHandler = sanitizedHandler;
