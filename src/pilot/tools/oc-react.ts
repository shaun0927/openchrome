import type { MCPServer } from '../../mcp-server';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../../types/mcp';
import { TOOL_ANNOTATIONS } from '../../types/tool-annotations';
import { getSessionManager } from '../../session-manager';
import { getMetricsCollector } from '../../metrics/collector';
import { registerPreloadScript } from '../../cdp/preload-injector';
import { REACT_DEVTOOLS_SHIM_ID, REACT_DEVTOOLS_SHIM_SOURCE, assertShimBudget } from '../react/devtools-shim';
import { redactSensitive } from '../react/inspect';

const definition: MCPToolDefinition = {
  name: 'oc_react',
  description: 'Pilot read-only React fiber inspection via an opt-in DevTools hook preload. Subcommands: tree, inspect, renders, suspense.',
  capability: 'pilot',
  annotations: TOOL_ANNOTATIONS.oc_react,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Target tab id. Defaults to the session default target when omitted.' },
      subcommand: { type: 'string', enum: ['tree', 'inspect', 'renders', 'suspense'], description: 'REQUIRED React inspection command.' },
      ref: { type: 'string', description: 'Fiber ref returned by tree, e.g. @e3 (inspect only).' },
      rootSelector: { type: 'string', description: 'Optional CSS selector used as a tree context hint.' },
      durationMs: { type: 'number', description: 'Render aggregation window for renders. Default 1000.' },
    },
    required: ['subcommand'],
  },
};

function textResult(payload: Record<string, unknown>, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function metric(name: string, labels: Record<string, string>): void {
  try { getMetricsCollector().inc(name, labels); } catch { /* best-effort */ }
}

const handler: ToolHandler = async (sessionId, args): Promise<MCPResult> => {
  const subcommand = String(args.subcommand || 'tree');
  metric('openchrome_react_query_total', { subcommand });
  const tabId = typeof args.tabId === 'string' ? args.tabId : undefined;
  const sm = getSessionManager();
  const targetId = tabId;
  if (!targetId) return textResult({ available: false, reason: 'missing-tabId' }, true);
  const page = await sm.getPage(sessionId, targetId, undefined, 'oc_react');
  if (!page) return textResult({ available: false, reason: 'target-unavailable', tabId: targetId }, true);

  const hasHook = await page.evaluate(() => Boolean((window as any).__OPENCHROME_REACT_DEVTOOLS_SHIM__ || (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?._openchromeRoots));
  if (!hasHook) {
    metric('openchrome_react_unavailable_total', { reason: 'no-react-hook' });
    return textResult({ available: false, reason: 'no-react-hook', tabId: targetId });
  }

  if (subcommand === 'renders') {
    const durationMs = Math.max(0, Math.min(10_000, Number(args.durationMs ?? 1000)));
    if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs));
    const renders = await page.evaluate(() => ({ ...((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?._openchromeRenderCounts || {}) }));
    const total = Object.values(renders as Record<string, number>).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
    metric('openchrome_react_renders_observed_total', { subcommand: 'renders' });
    return textResult({ available: true, tabId: targetId, durationMs, total, renders: redactSensitive(renders) as Record<string, unknown> });
  }

  const snapshot = await page.evaluate((command: string) => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const roots = hook?._openchromeRoots || [];
    const refs: any[] = [];
    const seen = new Set<any>();
    const includeDetails = command === 'inspect';
    function sanitize(value: any, depth = 0): any {
      if (depth > 4) return '[depth-limit]';
      if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
      if (typeof value === 'string') {
        return value
          .replace(/(password|token|secret|credential|api[_-]?key)\\s*[:=]\\s*[^\\s,;]+/gi, '$1=[REDACTED]')
          .slice(0, 500);
      }
      if (!value || typeof value !== 'object') return value;
      const out: any = {};
      for (const [key, child] of Object.entries(value).slice(0, 80)) {
        if (/password|token|secret|credential|api[_-]?key/i.test(key)) out[key] = '[REDACTED]';
        else out[key] = sanitize(child, depth + 1);
      }
      return out;
    }
    function nameOf(f: any) {
      const t = f && f.type;
      return (typeof t === 'string' ? t : (t && (t.displayName || t.name))) || (f && f.elementType && (f.elementType.displayName || f.elementType.name)) || 'Anonymous';
    }
    function walk(f: any, depth: number) {
      if (!f || seen.has(f) || refs.length >= 200) return;
      seen.add(f);
      let childCount = 0;
      for (let c = f.child; c; c = c.sibling) childCount++;
      const ref = `@e${refs.length + 1}`;
      refs.push({
        ref,
        name: nameOf(f),
        key: f.key ?? null,
        depth,
        childCount,
        tag: f.tag,
        ...(includeDetails ? { props: sanitize(f.memoizedProps), state: sanitize(f.memoizedState) } : {}),
      });
      for (let c = f.child; c; c = c.sibling) walk(c, depth + 1);
    }
    for (const root of roots) walk(root.current || root, 0);
    (window as any).__OPENCHROME_REACT_REFS__ = refs;
    return refs;
  }, subcommand);

  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    metric('openchrome_react_unavailable_total', { reason: 'empty-react-tree' });
    return textResult({ available: false, reason: 'empty-react-tree', tabId: targetId, tree: [] });
  }

  if (subcommand === 'tree') {
    const tree = snapshot.map(({ ref, name, key, depth, childCount }) => ({ ref, name, key, depth, childCount }));
    return textResult({ available: true, tabId: targetId, tree, rootSelector: args.rootSelector });
  }
  if (subcommand === 'inspect') {
    const ref = String(args.ref || '');
    const found = snapshot.find((item) => item.ref === ref);
    if (!found) return textResult({ available: false, reason: 'unknown-ref', ref, tabId: targetId }, true);
    return textResult({ available: true, tabId: targetId, fiber: redactSensitive(found) as Record<string, unknown> });
  }
  if (subcommand === 'suspense') {
    const boundaries = snapshot
      .filter((item) => /Suspense/i.test(String(item.name)) || item.tag === 13)
      .map(({ ref, name, key, depth }) => ({ ref, name, key, depth, state: 'unknown' }));
    return textResult({ available: true, tabId: targetId, boundaries });
  }
  return textResult({ available: false, reason: 'unknown-subcommand', subcommand }, true);
};

export function registerOcReactTool(server: MCPServer): void {
  assertShimBudget();
  registerPreloadScript(REACT_DEVTOOLS_SHIM_ID, REACT_DEVTOOLS_SHIM_SOURCE);
  server.registerTool('oc_react', handler, definition);
}
