/**
 * oc_observe Tool — deterministic actionable-element enumeration (#866)
 *
 * Collapses the `read_page → query_dom → inspect → interact` hot path into
 * a single `oc_observe → interact` pair. Returns a numbered, deterministic
 * list of actionable elements with stable refs, AX role/name, bounding box,
 * inViewport flag, and the subset of action verbs each node supports.
 *
 * Pure AX-tree + getBoxModel traversal — no LLM, no outbound network.
 *
 * Boundary: this file is the entire implementation. It reuses the existing
 * AX traversal (`Accessibility.getFullAXTree` — same as `read_page` mode='ax'),
 * the ref-id manager (`src/utils/ref-id-manager.ts`), and `DOM.getBoxModel`.
 * It deliberately does NOT introduce a parallel AX serializer.
 */

import type { Page } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import {
  MCPToolDefinition,
  MCPResult,
  ToolHandler,
  ToolContext,
  throwIfAborted,
} from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withTimeout } from '../utils/with-timeout';
import type { CDPClient } from '../cdp/client';

// ─── Types ───

export type ObserveAction = 'click' | 'fill' | 'select' | 'hover' | 'focus';
export type ObserveScope = 'viewport' | 'document';

export interface ObserveOptions {
  scope?: ObserveScope;
  actions?: ObserveAction[];
  limit?: number;
  includeHidden?: boolean;
  tabId?: string;
}

export interface ObservableNode {
  index: number;
  ref: string;
  role: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  inViewport: boolean;
  actions: ObserveAction[];
  value?: string | boolean;
}

export interface ObserveResponse {
  url: string;
  loaderId: string;
  capturedAt?: number;
  scope?: ObserveScope;
  totalConsidered?: number;
  nodes: ObservableNode[];
}

// ─── AX shape (mirrors src/tools/read-page.ts) ───

interface AXNode {
  nodeId: number;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: unknown };
  childIds?: number[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

// ─── Role → action mapping ───

/**
 * Maps an AX role + property bag to the set of action verbs the node supports.
 *
 * Pure function — caller filters by the user's `actions` request afterwards.
 */
function actionsForRole(
  role: string,
  props: Record<string, unknown>,
): ObserveAction[] {
  const out = new Set<ObserveAction>();
  const r = role.toLowerCase();

  // Disabled nodes offer no actions at all.
  if (props['disabled'] === true) return [];

  // Click — anything an LLM would reasonably click.
  if (
    r === 'button' ||
    r === 'link' ||
    r === 'menuitem' ||
    r === 'menuitemcheckbox' ||
    r === 'menuitemradio' ||
    r === 'tab' ||
    r === 'treeitem' ||
    r === 'option' ||
    r === 'checkbox' ||
    r === 'radio' ||
    r === 'switch'
  ) {
    out.add('click');
  }

  // Fill — text-bearing inputs.
  if (r === 'textbox' || r === 'searchbox' || r === 'combobox' || r === 'spinbutton') {
    out.add('fill');
  }

  // Select — dropdowns / listboxes / native <select> (combobox covers both).
  if (r === 'combobox' || r === 'listbox') {
    out.add('select');
  }

  // Hover / focus — superset of every interactive role.
  if (out.size > 0 || r === 'slider' || r === 'tabpanel') {
    out.add('hover');
    out.add('focus');
  }

  // Sliders can also be "clicked" to focus, but the primary action is hover/focus.
  if (r === 'slider') {
    out.add('focus');
  }

  return Array.from(out);
}

/**
 * Returns true when a role implies the node may carry a meaningful `value`.
 */
function roleHasValue(role: string): boolean {
  const r = role.toLowerCase();
  return (
    r === 'textbox' ||
    r === 'searchbox' ||
    r === 'combobox' ||
    r === 'spinbutton' ||
    r === 'checkbox' ||
    r === 'switch' ||
    r === 'radio' ||
    r === 'slider'
  );
}

// ─── Hidden-node detection ───

/**
 * Decide whether a node should be excluded when `includeHidden=false`.
 *
 * Uses only AX properties — viewport math is handled separately so the
 * `scope='document'` mode can still see off-screen elements.
 */
function isHidden(props: Record<string, unknown>): boolean {
  if (props['hidden'] === true) return true;
  if (props['invisible'] === true) return true;
  // AX exposes aria-hidden as a separate `hidden` boolean; covered above.
  return false;
}

// ─── Stable CSS-selector fallback for `ref` ───
//
// #844 introduces a stable backend-node uid. Until that lands, we use the
// existing ref-id manager (`ref_N` allocated against the current AX snapshot)
// which is the same identifier `read_page(mode='ax')` produces. This satisfies
// the "ref stability survives equal-DOM re-snapshot" invariant within a single
// AX generation; cross-snapshot ref equality is gated behind the #844 test.

/**
 * Resolve a node's bounding box via CDP `DOM.getBoxModel`. Returns null when
 * the element has no layout (e.g. display:none).
 */
async function getBoxModel(
  page: Page,
  cdpClient: CDPClient,
  backendNodeId: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const { model } = await cdpClient.send<{ model: { content: number[] } }>(
      page,
      'DOM.getBoxModel',
      { backendNodeId },
    );
    if (!model?.content || model.content.length < 8) return null;
    const x = model.content[0];
    const y = model.content[1];
    const w = model.content[2] - x;
    const h = model.content[5] - y;
    if (w <= 0 || h <= 0) return null;
    // Round to integer CSS pixels — sub-pixel jitter breaks determinism on
    // pages with fractional layout (transforms, anchor positioning, etc).
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
  } catch {
    return null;
  }
}

// ─── MCP definition ───

const definition: MCPToolDefinition = {
  name: 'oc_observe',
  description:
    'Deterministic, numbered list of actionable elements on the page. ' +
    'When to use: replace the read_page → query_dom → inspect → interact pattern ' +
    'when you already know which kind of action you want to take (click / fill / ' +
    'select / hover / focus). Returns refs that plug directly into `interact`. ' +
    'When NOT to use: full-page comprehension (use read_page), structural CSS ' +
    'diagnostics (use read_page mode=css), or natural-language replay (use act). ' +
    'No LLM, no outbound network — pure AX-tree traversal.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID to observe' },
      scope: {
        type: 'string',
        enum: ['viewport', 'document'],
        description: "'viewport' (default) restricts to the current viewport; 'document' returns all actionable nodes",
      },
      actions: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['click', 'fill', 'select', 'hover', 'focus'],
        },
        description: 'Filter to nodes offering at least one of these action verbs',
      },
      limit: {
        type: 'number',
        description: 'Hard cap on returned entries (default 200, max 1000)',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include disabled / aria-hidden / display:none nodes (default false)',
      },
    },
    required: ['tabId'],
  },
};

// ─── Handler ───

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const BOX_MODEL_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  throwIfAborted(context);

  const tabId = args.tabId as string;
  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  const scope: ObserveScope =
    args.scope === 'document' ? 'document' : 'viewport';
  const includeHidden = args.includeHidden === true;
  const requestedLimit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? args.limit
      : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requestedLimit)));

  // Parse + normalise the `actions` filter.
  let actionFilter: Set<ObserveAction> | null = null;
  const rawActions = args.actions;
  if (Array.isArray(rawActions) && rawActions.length > 0) {
    const valid: ObserveAction[] = [
      'click',
      'fill',
      'select',
      'hover',
      'focus',
    ];
    const filtered = rawActions.filter((a): a is ObserveAction =>
      valid.includes(a as ObserveAction),
    );
    if (filtered.length > 0) actionFilter = new Set(filtered);
  }

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // 1. Page stats — needed for viewport math + the response envelope.
    const pageStats = await withTimeout(
      page.evaluate(() => ({
        url: window.location.href,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })),
      15000,
      'oc_observe.page_stats',
      context,
    );

    // 2. Frame loader id — used by callers to gate ref reuse across navigations.
    let loaderId = '';
    try {
      const { frameTree } = await cdpClient.send<{
        frameTree: { frame: { loaderId?: string } };
      }>(page, 'Page.getFrameTree', {});
      loaderId = frameTree?.frame?.loaderId || '';
    } catch {
      // Some test mocks don't implement Page.getFrameTree — fall back to empty.
    }

    // 3. Full AX tree.
    const { nodes: axNodes } = await withTimeout(
      cdpClient.send<{ nodes: AXNode[] }>(page, 'Accessibility.getFullAXTree', {
        depth: -1,
      }),
      15000,
      'Accessibility.getFullAXTree',
      context,
    );

    // 4. Refresh the ref-id table so the `ref` values we hand back match
    //    what a subsequent `read_page(mode='ax')` would produce on the same
    //    AX generation. This is the contract for the #844 cross-validation.
    refIdManager.clearTargetRefs(sessionId, tabId);

    // Map AX role → approximate HTML tag (mirrors read-page.ts so the same
    // backend-node uid gets the same tagName in the ref entry).
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

    // 5. Walk the tree in pre-order so DOM-order tie-breaking is deterministic.
    //    Build child-id set first so root detection is O(n).
    const nodeMap = new Map<number, AXNode>();
    const childIdSet = new Set<number>();
    for (const n of axNodes) {
      nodeMap.set(n.nodeId, n);
      if (n.childIds) for (const c of n.childIds) childIdSet.add(c);
    }
    const roots = axNodes.filter((n) => !childIdSet.has(n.nodeId));

    interface CandidateBase {
      backendDOMNodeId: number;
      role: string;
      name: string;
      value?: string | boolean;
      props: Record<string, unknown>;
      domOrder: number;
      actions: ObserveAction[];
    }

    interface Candidate extends CandidateBase {
      ref: string;
      bbox: { x: number; y: number; w: number; h: number };
      inViewport: boolean;
    }

    const boxCandidates: CandidateBase[] = [];
    const candidates: Candidate[] = [];
    let domOrderCounter = 0;
    let totalConsidered = 0;

    const vpLeft = pageStats.scrollX;
    const vpTop = pageStats.scrollY;
    const vpRight = vpLeft + pageStats.viewportWidth;
    const vpBottom = vpTop + pageStats.viewportHeight;

    const visit = (node: AXNode): void => {
      throwIfAborted(context);

      const role = node.role?.value || '';
      const name = node.name?.value || '';
      const props: Record<string, unknown> = {};
      if (node.properties) {
        for (const p of node.properties) props[p.name] = p.value.value;
      }

      // Only nodes with a backend DOM id can have a bounding box.
      if (node.backendDOMNodeId && role) {
        const acts = actionsForRole(role, props);
        if (acts.length > 0) {
          totalConsidered++;

          const hidden = !includeHidden && isHidden(props);
          if (!hidden) {
            let value: string | boolean | undefined;
            if (roleHasValue(role)) {
              if (typeof node.value?.value === 'string') {
                value = node.value.value;
              } else if (typeof node.value?.value === 'boolean') {
                value = node.value.value;
              } else if (props['checked'] === true) {
                value = true;
              } else if (props['checked'] === false) {
                value = false;
              }
            }

            boxCandidates.push({
              backendDOMNodeId: node.backendDOMNodeId,
              role,
              name,
              value,
              props,
              domOrder: domOrderCounter++,
              actions: acts,
            });
          }
        }
      }

      if (node.childIds) {
        for (const cid of node.childIds) {
          const child = nodeMap.get(cid);
          if (child) visit(child);
        }
      }
    };

    for (const root of roots) visit(root);

    const boxedCandidates = await mapWithConcurrency(
      boxCandidates,
      BOX_MODEL_CONCURRENCY,
      async (candidate) => {
        throwIfAborted(context);
        const box = await getBoxModel(
          page,
          cdpClient,
          candidate.backendDOMNodeId,
        );
        return { candidate, box };
      },
    );

    for (const { candidate, box } of boxedCandidates) {
      if (!box) continue;

      // Viewport math is page-relative (CDP getBoxModel returns coordinates
      // relative to the layout viewport, accounting for scroll).
      const inViewport =
        box.x < vpRight &&
        box.x + box.w > vpLeft &&
        box.y < vpBottom &&
        box.y + box.h > vpTop;

      if (scope === 'viewport' && !inViewport) continue;

      const ref = refIdManager.generateRef(
        sessionId,
        tabId,
        candidate.backendDOMNodeId,
        candidate.role,
        candidate.name,
        AX_ROLE_TO_TAG[candidate.role.toLowerCase()],
      );

      candidates.push({
        ...candidate,
        ref,
        bbox: box,
        inViewport,
      });
    }

    // 6. Apply the user's action filter (intersect, not union — entry must
    //    offer AT LEAST ONE of the requested verbs).
    const filteredByAction = actionFilter
      ? candidates.filter((c) => c.actions.some((a) => actionFilter!.has(a)))
      : candidates;

    // 7. Sort: top-left → bottom-right, tie by DOM order. Y-bucketing makes
    //    the ordering robust to sub-pixel x drift when two nodes share a row.
    filteredByAction.sort((a, b) => {
      if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
      if (a.bbox.x !== b.bbox.x) return a.bbox.x - b.bbox.x;
      return a.domOrder - b.domOrder;
    });

    // 8. Apply hard limit.
    const limited = filteredByAction.slice(0, limit);

    // 9. Materialise the public response. Index is 1-based and stable for
    //    this response — callers reference `nodes[i].ref`, not the index,
    //    for any subsequent action (the index is purely human-readable).
    const nodes: ObservableNode[] = limited.map((c, i) => {
      const publicActions = actionFilter
        ? c.actions.filter((action) => actionFilter.has(action))
        : c.actions;
      const entry: ObservableNode = {
        index: i + 1,
        ref: c.ref,
        role: c.role,
        name: c.name,
        bbox: c.bbox,
        inViewport: c.inViewport,
        actions: publicActions,
      };
      if (c.value !== undefined && c.value !== '') entry.value = c.value;
      return entry;
    });

    const response: ObserveResponse = {
      url: pageStats.url,
      loaderId,
      nodes,
    };
    if (!actionFilter) {
      response.capturedAt = Date.now();
      response.scope = scope;
      response.totalConsidered = totalConsidered;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `oc_observe error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerOcObserveTool(server: MCPServer): void {
  server.registerTool('oc_observe', handler, definition);
}

// Re-exported for tests.
export const __test = {
  actionsForRole,
  roleHasValue,
  isHidden,
};
